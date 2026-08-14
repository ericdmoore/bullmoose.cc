// Package ws is a minimal RFC 6455 WebSocket CLIENT — exactly the slice
// `bullmoose watch` needs to hold the JMAP push channel open (`/api/ws`, proxied
// to the account's Durable Object: services/jmap/src/index.ts:147).
//
// Why hand-rolled rather than a dependency: cli-go's go.mod justifies every
// dependency one at a time (golang.org/x/term for isatty, modernc.org/sqlite for
// the mirror), and this client needs a strict subset of the protocol — connect,
// read server frames, answer a ping, close politely. It never negotiates
// extensions, never sends application data, and never fragments. That is ~250
// lines of stdlib against a spec with published wire vectors, and ws_test.go
// pins the codec against RFC 6455 §5.7's byte-for-byte examples and §1.3's
// handshake example, so the implementation is checked against the RFC rather
// than against itself.
//
// The Node side gets this for free (undici's global WebSocket, watch.ts:147),
// which is the one place the TypeScript CLI is cheaper. The trade is deliberate:
// a pure-Go client keeps CGO_ENABLED=0 cross-compilation (`arch.md` §1) intact.
package ws

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
)

// Opcodes — RFC 6455 §5.2.
const (
	OpContinuation = 0x0
	OpText         = 0x1
	OpBinary       = 0x2
	OpClose        = 0x8
	OpPing         = 0x9
	OpPong         = 0xA
)

// HandshakeGUID is the RFC 6455 §1.3 magic string the accept key is derived
// with. It is a constant of the protocol, not a choice.
const HandshakeGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// defaultMaxMessage caps one assembled message. A push frame is a few hundred
// bytes of StateChange JSON; anything near this is a server fault or a hostile
// peer, and an unbounded reader is how a long-lived watcher turns into an OOM.
const defaultMaxMessage = 1 << 20 // 1 MiB

// ErrClosed is returned by ReadMessage after the peer sent a Close frame. It is
// an ORDERLY end of stream, which the watcher treats exactly like a dropped
// socket: reconnect and resume from the cursor.
var ErrClosed = errors.New("ws: peer closed the connection")

// AcceptKey computes the Sec-WebSocket-Accept value for a client key — RFC 6455
// §4.2.2 step 5. Exported because it is the one part of the handshake with a
// published test vector (§1.3), and ws_test.go asserts against it.
func AcceptKey(clientKey string) string {
	h := sha1.New() //nolint:gosec // SHA-1 is what the protocol specifies here
	_, _ = io.WriteString(h, clientKey+HandshakeGUID)
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

// Conn is one open WebSocket. Reads are single-threaded (the watcher has one
// reader goroutine per channel); writes take a mutex because a pong can race the
// close the watcher sends on shutdown.
type Conn struct {
	net        net.Conn
	br         *bufio.Reader
	wmu        sync.Mutex
	maxMessage int64
	closeOnce  sync.Once
}

// Dialer carries the knobs a caller might reasonably want. The zero value works.
type Dialer struct {
	// HandshakeTimeout bounds connect + TLS + the HTTP upgrade exchange. It does
	// NOT bound reads afterwards: a push channel is idle by design.
	HandshakeTimeout time.Duration
	// MaxMessageBytes caps one assembled message (default 1 MiB).
	MaxMessageBytes int64
	// TLSConfig is used for wss:// (default: the system roots).
	TLSConfig *tls.Config
}

// Dial opens a WebSocket to a ws:// or wss:// URL.
//
// A refused UPGRADE is reported as a *bmio.ServerError carrying the HTTP status,
// so an expired token (401) or a revoked read scope (403) reaches the exit-code
// table as auth rather than as a nameless failure — the same treatment
// internal/jmap gives a refused POST.
func (d Dialer) Dial(ctx context.Context, rawURL string) (*Conn, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("ws: bad url %q: %w", rawURL, err)
	}
	var secure bool
	switch u.Scheme {
	case "ws":
	case "wss":
		secure = true
	default:
		return nil, fmt.Errorf("ws: unsupported scheme %q (want ws or wss)", u.Scheme)
	}

	timeout := d.HandshakeTimeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	dialCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	addr := u.Host
	if u.Port() == "" {
		if secure {
			addr = net.JoinHostPort(u.Hostname(), "443")
		} else {
			addr = net.JoinHostPort(u.Hostname(), "80")
		}
	}

	var dialer net.Dialer
	raw, err := dialer.DialContext(dialCtx, "tcp", addr)
	if err != nil {
		return nil, &bmio.CliError{Msg: "ws: dial " + addr + ": " + err.Error(), Code: bmio.ExitFail}
	}
	conn := raw
	if secure {
		cfg := d.TLSConfig
		if cfg == nil {
			cfg = &tls.Config{MinVersion: tls.VersionTLS12}
		}
		if cfg.ServerName == "" {
			cfg = cfg.Clone()
			cfg.ServerName = u.Hostname()
		}
		tlsConn := tls.Client(raw, cfg)
		if err := tlsConn.HandshakeContext(dialCtx); err != nil {
			_ = raw.Close()
			return nil, &bmio.CliError{Msg: "ws: tls handshake: " + err.Error(), Code: bmio.ExitFail}
		}
		conn = tlsConn
	}

	// One deadline over the whole upgrade exchange; cleared once we own frames.
	if deadline, ok := dialCtx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}

	keyBytes := make([]byte, 16)
	if _, err := rand.Read(keyBytes); err != nil {
		_ = conn.Close()
		return nil, err
	}
	key := base64.StdEncoding.EncodeToString(keyBytes)

	requestURI := u.RequestURI()
	if requestURI == "" {
		requestURI = "/"
	}
	var req strings.Builder
	fmt.Fprintf(&req, "GET %s HTTP/1.1\r\n", requestURI)
	fmt.Fprintf(&req, "Host: %s\r\n", u.Host)
	req.WriteString("Upgrade: websocket\r\n")
	req.WriteString("Connection: Upgrade\r\n")
	fmt.Fprintf(&req, "Sec-WebSocket-Key: %s\r\n", key)
	req.WriteString("Sec-WebSocket-Version: 13\r\n")
	req.WriteString("\r\n")
	if _, err := io.WriteString(conn, req.String()); err != nil {
		_ = conn.Close()
		return nil, &bmio.CliError{Msg: "ws: write handshake: " + err.Error(), Code: bmio.ExitFail}
	}

	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodGet})
	if err != nil {
		_ = conn.Close()
		return nil, &bmio.CliError{Msg: "ws: read handshake: " + err.Error(), Code: bmio.ExitFail}
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		_ = resp.Body.Close()
		_ = conn.Close()
		return nil, &bmio.ServerError{
			Msg: fmt.Sprintf("ws: upgrade refused: HTTP %d %s",
				resp.StatusCode, strings.TrimSpace(string(body))),
			HTTPStatus: resp.StatusCode,
		}
	}
	if !strings.EqualFold(resp.Header.Get("Upgrade"), "websocket") ||
		!headerContainsToken(resp.Header.Get("Connection"), "upgrade") {
		_ = conn.Close()
		return nil, &bmio.CliError{Msg: "ws: server did not upgrade", Code: bmio.ExitFail}
	}
	if got, want := resp.Header.Get("Sec-WebSocket-Accept"), AcceptKey(key); got != want {
		// A wrong accept key means something on the path is answering that is not
		// the WebSocket endpoint. Failing loudly beats reading garbage frames.
		_ = conn.Close()
		return nil, &bmio.CliError{Msg: "ws: bad Sec-WebSocket-Accept", Code: bmio.ExitFail}
	}

	_ = conn.SetDeadline(time.Time{}) // idle is normal from here on
	max := d.MaxMessageBytes
	if max <= 0 {
		max = defaultMaxMessage
	}
	return &Conn{net: conn, br: br, maxMessage: max}, nil
}

// Dial with the zero Dialer.
func Dial(ctx context.Context, rawURL string) (*Conn, error) { return Dialer{}.Dial(ctx, rawURL) }

// headerContainsToken reports whether a comma-separated header value carries a
// token, case-insensitively — `Connection: keep-alive, Upgrade` is legal.
func headerContainsToken(value, token string) bool {
	for _, part := range strings.Split(value, ",") {
		if strings.EqualFold(strings.TrimSpace(part), token) {
			return true
		}
	}
	return false
}

// ReadMessage returns the next COMPLETE application message, reassembling
// continuation frames and answering control frames itself: a ping is ponged, a
// pong is dropped, and a close ends the stream with ErrClosed.
func (c *Conn) ReadMessage() (opcode int, payload []byte, err error) {
	var (
		buf       []byte
		msgOpcode int
		started   bool
	)
	for {
		fin, op, frame, err := c.readFrame()
		if err != nil {
			return 0, nil, err
		}
		switch op {
		case OpPing:
			// A pong echoes the ping's application data (RFC 6455 §5.5.3). A
			// write failure here is the connection dying, which the next read
			// would report anyway — so it is not escalated.
			_ = c.writeFrame(OpPong, frame)
			continue
		case OpPong:
			continue
		case OpClose:
			_ = c.writeFrame(OpClose, closeEcho(frame))
			return 0, nil, ErrClosed
		case OpText, OpBinary:
			if started {
				return 0, nil, errors.New("ws: new data frame inside a fragmented message")
			}
			started = true
			msgOpcode = op
			buf = append(buf, frame...)
		case OpContinuation:
			if !started {
				return 0, nil, errors.New("ws: continuation frame with nothing to continue")
			}
			buf = append(buf, frame...)
		default:
			return 0, nil, fmt.Errorf("ws: unknown opcode 0x%x", op)
		}
		if int64(len(buf)) > c.maxMessage {
			return 0, nil, fmt.Errorf("ws: message exceeds %d bytes", c.maxMessage)
		}
		if fin {
			return msgOpcode, buf, nil
		}
	}
}

// readFrame reads one frame off the wire — RFC 6455 §5.2.
func (c *Conn) readFrame() (fin bool, opcode int, payload []byte, err error) {
	var head [2]byte
	if _, err := io.ReadFull(c.br, head[:]); err != nil {
		return false, 0, nil, err
	}
	fin = head[0]&0x80 != 0
	if head[0]&0x70 != 0 {
		// Reserved bits set with no extension negotiated (we never offer one).
		return false, 0, nil, errors.New("ws: reserved bits set")
	}
	opcode = int(head[0] & 0x0f)
	masked := head[1]&0x80 != 0
	length := int64(head[1] & 0x7f)

	control := opcode&0x8 != 0
	if control {
		// §5.5: control frames are never fragmented and carry ≤125 bytes.
		if !fin || length > 125 {
			return false, 0, nil, errors.New("ws: malformed control frame")
		}
	}

	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			return false, 0, nil, err
		}
		length = int64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			return false, 0, nil, err
		}
		length = int64(binary.BigEndian.Uint64(ext[:]) & 0x7fffffffffffffff)
	}
	if length > c.maxMessage {
		return false, 0, nil, fmt.Errorf("ws: frame of %d bytes exceeds %d", length, c.maxMessage)
	}

	var mask [4]byte
	if masked {
		// §5.1: a server MUST NOT mask. A masked frame here means the peer is
		// not speaking the protocol we think it is.
		return false, 0, nil, errors.New("ws: server frame is masked")
	}
	payload = make([]byte, length)
	if _, err := io.ReadFull(c.br, payload); err != nil {
		return false, 0, nil, err
	}
	_ = mask
	return fin, opcode, payload, nil
}

// writeFrame writes one MASKED frame. §5.1: every client→server frame is
// masked, with a fresh cryptographically-random key per frame.
func (c *Conn) writeFrame(opcode int, payload []byte) error {
	if len(payload) > 125 && opcode&0x8 != 0 {
		payload = payload[:125]
	}
	var mask [4]byte
	if _, err := rand.Read(mask[:]); err != nil {
		return err
	}
	header := make([]byte, 0, 14)
	header = append(header, byte(0x80|opcode)) // FIN set: we never fragment
	switch n := len(payload); {
	case n <= 125:
		header = append(header, byte(0x80|n))
	case n <= 0xffff:
		header = append(header, 0x80|126, byte(n>>8), byte(n))
	default:
		header = append(header, 0x80|127)
		var ext [8]byte
		binary.BigEndian.PutUint64(ext[:], uint64(n))
		header = append(header, ext[:]...)
	}
	header = append(header, mask[:]...)
	masked := make([]byte, len(payload))
	copy(masked, payload)
	Mask(mask, masked)

	c.wmu.Lock()
	defer c.wmu.Unlock()
	if _, err := c.net.Write(append(header, masked...)); err != nil {
		return err
	}
	return nil
}

// Mask applies the RFC 6455 §5.3 transform in place. Exported so ws_test.go can
// check it against the spec's worked example — the transform is its own inverse,
// so one vector pins both directions.
func Mask(key [4]byte, data []byte) {
	for i := range data {
		data[i] ^= key[i%4]
	}
}

// closeEcho mirrors a close frame's status code back (RFC 6455 §5.5.1) and drops
// the peer's reason text, which we do not interpret.
func closeEcho(payload []byte) []byte {
	if len(payload) < 2 {
		return nil
	}
	return payload[:2]
}

// Close sends a polite close frame and shuts the socket. Safe to call from a
// goroutine other than the reader — that is exactly how the watcher unblocks a
// read when its context is cancelled.
func (c *Conn) Close() error {
	var err error
	c.closeOnce.Do(func() {
		// 1000 = normal closure (§7.4.1). Best effort: if the peer is already
		// gone the frame fails and the socket close below is what matters.
		_ = c.writeFrame(OpClose, []byte{0x03, 0xe8})
		err = c.net.Close()
	})
	return err
}

// SetReadDeadline bounds the next read — used by tests; the watcher leaves reads
// open because an idle push channel is the normal state.
func (c *Conn) SetReadDeadline(t time.Time) error { return c.net.SetReadDeadline(t) }
