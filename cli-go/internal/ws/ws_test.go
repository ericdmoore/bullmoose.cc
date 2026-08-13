package ws

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

// The codec is checked against RFC 6455's OWN published examples, not against
// the server half in wstest — a bug shared by two halves written together is
// exactly what a self-consistent test cannot see. Every vector below is quoted
// from the RFC.

// TestAcceptKey_RFC6455_1_3 is the worked example in §1.3.
func TestAcceptKey_RFC6455_1_3(t *testing.T) {
	if got, want := AcceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="; got != want {
		t.Fatalf("AcceptKey = %q, want the RFC 6455 §1.3 value %q", got, want)
	}
}

// TestMask_RFC6455_5_7 pins the masking transform against §5.7's "a single-frame
// masked text message" — key 0x37fa213d over "Hello" yields the bytes shown.
func TestMask_RFC6455_5_7(t *testing.T) {
	key := [4]byte{0x37, 0xfa, 0x21, 0x3d}
	data := []byte("Hello")
	Mask(key, data)
	want := []byte{0x7f, 0x9f, 0x4d, 0x51, 0x58}
	if !bytes.Equal(data, want) {
		t.Fatalf("masked payload = % x, want the RFC 6455 §5.7 bytes % x", data, want)
	}
	Mask(key, data) // the transform is its own inverse
	if string(data) != "Hello" {
		t.Fatalf("unmask did not round-trip: %q", data)
	}
}

// newTestConn wires a Conn to a byte slice as if the server had sent it, and
// captures whatever the client writes back.
func newTestConn(t *testing.T, server []byte) (*Conn, *bytes.Buffer) {
	t.Helper()
	client, srv := net.Pipe()
	sent := &bytes.Buffer{}
	go func() {
		_, _ = srv.Write(server)
		// Drain the client's writes (pongs, closes) so it never blocks.
		buf := make([]byte, 4096)
		for {
			n, err := srv.Read(buf)
			if n > 0 {
				sent.Write(buf[:n])
			}
			if err != nil {
				return
			}
		}
	}()
	t.Cleanup(func() { _ = client.Close(); _ = srv.Close() })
	return &Conn{net: client, br: bufio.NewReader(client), maxMessage: defaultMaxMessage}, sent
}

// TestReadMessage_RFC6455_5_7_Vectors drives the reader with the exact frames
// §5.7 lists.
func TestReadMessage_RFC6455_5_7_Vectors(t *testing.T) {
	cases := []struct {
		name  string
		wire  []byte
		want  string
		op    int
		frame string
	}{
		{
			name: "single-frame unmasked text",
			wire: []byte{0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f},
			want: "Hello", op: OpText,
		},
		{
			// §5.7 "a fragmented unmasked text message": 0x01/0x03 "Hel" then
			// 0x80/0x02 "lo".
			name: "fragmented unmasked text",
			wire: []byte{0x01, 0x03, 0x48, 0x65, 0x6c, 0x80, 0x02, 0x6c, 0x6f},
			want: "Hello", op: OpText,
		},
		{
			// §5.7 "256 bytes binary message in a single unmasked frame".
			name: "binary with a 16-bit length",
			wire: append([]byte{0x82, 0x7e, 0x01, 0x00}, bytes.Repeat([]byte{0xab}, 256)...),
			want: strings.Repeat("\xab", 256), op: OpBinary,
		},
		{
			// §5.7 "64KiB binary message in a single unmasked frame".
			name: "binary with a 64-bit length",
			wire: append([]byte{0x82, 0x7f, 0, 0, 0, 0, 0, 0x01, 0x00, 0x00},
				bytes.Repeat([]byte{0xcd}, 65536)...),
			want: strings.Repeat("\xcd", 65536), op: OpBinary,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			conn, _ := newTestConn(t, c.wire)
			op, payload, err := conn.ReadMessage()
			if err != nil {
				t.Fatalf("ReadMessage: %v", err)
			}
			if op != c.op {
				t.Errorf("opcode = 0x%x, want 0x%x", op, c.op)
			}
			if string(payload) != c.want {
				t.Errorf("payload = %d bytes, want %d", len(payload), len(c.want))
			}
		})
	}
}

// TestPingIsPongedWithTheSameData is §5.5.2/§5.5.3: the pong carries the ping's
// application data, and — because we are the CLIENT — it must be MASKED.
func TestPingIsPongedWithTheSameData(t *testing.T) {
	// §5.7 "unmasked Ping request": 0x89 0x05 "Hello", then a text frame so
	// ReadMessage has something to return.
	wire := append([]byte{0x89, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f},
		0x81, 0x02, 0x6f, 0x6b)
	conn, sent := newTestConn(t, wire)
	op, payload, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("ReadMessage: %v", err)
	}
	if op != OpText || string(payload) != "ok" {
		t.Fatalf("got op 0x%x %q, want a text frame \"ok\" after the ping", op, payload)
	}
	// Give the drain goroutine a moment to observe the pong.
	deadline := time.Now().Add(2 * time.Second)
	for sent.Len() < 11 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	got := sent.Bytes()
	if len(got) < 11 {
		t.Fatalf("client sent %d bytes, want an 11-byte masked pong: % x", len(got), got)
	}
	if got[0] != 0x8a {
		t.Errorf("first byte = 0x%x, want 0x8a (FIN + pong)", got[0])
	}
	if got[1]&0x80 == 0 {
		t.Errorf("pong is NOT masked (byte 1 = 0x%x) — RFC 6455 §5.1 requires a client to mask", got[1])
	}
	var key [4]byte
	copy(key[:], got[2:6])
	body := append([]byte(nil), got[6:11]...)
	Mask(key, body)
	if string(body) != "Hello" {
		t.Errorf("pong payload = %q, want the ping's own %q", body, "Hello")
	}
}

// TestCloseFrameEndsTheStream: an orderly close is ErrClosed, which the watcher
// treats exactly like a dropped socket.
func TestCloseFrameEndsTheStream(t *testing.T) {
	conn, _ := newTestConn(t, []byte{0x88, 0x02, 0x03, 0xe8})
	if _, _, err := conn.ReadMessage(); !errors.Is(err, ErrClosed) {
		t.Fatalf("ReadMessage err = %v, want ErrClosed", err)
	}
}

// TestMaskedServerFrameIsRefused — §5.1: a server MUST NOT mask. Tolerating it
// would mean happily decoding frames from something that is not the protocol we
// think we are speaking.
func TestMaskedServerFrameIsRefused(t *testing.T) {
	// §5.7's masked "Hello", sent in the server→client direction.
	conn, _ := newTestConn(t, []byte{0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58})
	if _, _, err := conn.ReadMessage(); err == nil {
		t.Fatal("a masked server frame was accepted; RFC 6455 §5.1 forbids it")
	}
}

// TestOversizedFrameIsRefused: a long-lived watcher must not be talked into an
// unbounded allocation by a length header.
func TestOversizedFrameIsRefused(t *testing.T) {
	conn, _ := newTestConn(t, []byte{0x82, 0x7f, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff})
	if _, _, err := conn.ReadMessage(); err == nil {
		t.Fatal("a frame claiming ~8 EiB was accepted")
	}
}

// ---- handshake ------------------------------------------------------------

// TestDialRejectsBadAccept: a wrong Sec-WebSocket-Accept means something on the
// path is answering that is not the WebSocket endpoint.
func TestDialRejectsBadAccept(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hj, _ := w.(http.Hijacker)
		conn, _, err := hj.Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = conn.Write([]byte("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
			"Connection: Upgrade\r\nSec-WebSocket-Accept: wrong\r\n\r\n"))
	}))
	defer srv.Close()
	_, err := Dial(context.Background(), "ws"+strings.TrimPrefix(srv.URL, "http"))
	if err == nil {
		t.Fatal("Dial accepted a bad Sec-WebSocket-Accept")
	}
}

// TestDialSurfacesTheHTTPStatus: a refused upgrade must reach the exit-code
// table as what it is — 401/403 is auth (exit 4), not a nameless failure.
func TestDialSurfacesTheHTTPStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
	}))
	defer srv.Close()
	_, err := Dial(context.Background(), "ws"+strings.TrimPrefix(srv.URL, "http"))
	if err == nil {
		t.Fatal("Dial accepted a 403")
	}
	if got := bmio.ExitCodeFor(err); got != bmio.ExitAuth {
		t.Errorf("exit code for a 403 upgrade = %d, want %d (auth)", got, bmio.ExitAuth)
	}
}
