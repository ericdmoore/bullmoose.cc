// Package wstest is a WebSocket SERVER, for tests only.
//
// It exists so the client in internal/ws and the watcher in internal/watch can
// be driven against a socket that really drops mid-stream — the failure the
// reconnect/resume contract is about. Nothing outside _test.go files imports it,
// so it is never linked into the shipped binary.
//
// It implements the server half deliberately independently of the client half:
// it writes UNMASKED frames (RFC 6455 §5.1) and unmasks what it reads, so a
// mistake shared by both sides would still have to be a mistake made twice, in
// opposite directions.
package wstest

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/ws"
)

// Conn is one accepted server-side connection.
type Conn struct {
	net net.Conn
	br  *bufio.Reader
	mu  sync.Mutex
	// Request is the upgrade request, so a test can assert on the query string
	// (accountId / access_token) the watcher sent.
	Request *http.Request
}

// Upgrade completes the RFC 6455 handshake on an ordinary net/http handler by
// hijacking the connection. Returns an error (and writes a status) if the
// request is not a well-formed upgrade.
func Upgrade(w http.ResponseWriter, r *http.Request) (*Conn, error) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		http.Error(w, "not an upgrade", http.StatusBadRequest)
		return nil, errors.New("wstest: not an upgrade request")
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		http.Error(w, "no key", http.StatusBadRequest)
		return nil, errors.New("wstest: missing Sec-WebSocket-Key")
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "no hijack", http.StatusInternalServerError)
		return nil, errors.New("wstest: ResponseWriter is not a Hijacker")
	}
	conn, rw, err := hj.Hijack()
	if err != nil {
		return nil, err
	}
	resp := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + ws.AcceptKey(key) + "\r\n\r\n"
	if _, err := io.WriteString(conn, resp); err != nil {
		_ = conn.Close()
		return nil, err
	}
	if err := rw.Writer.Flush(); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return &Conn{net: conn, br: rw.Reader, Request: r}, nil
}

// WriteText sends one unmasked, unfragmented text frame.
func (c *Conn) WriteText(payload string) error { return c.write(ws.OpText, []byte(payload)) }

// WritePing sends an unmasked ping, so a test can prove the client pongs it.
func (c *Conn) WritePing(payload string) error { return c.write(ws.OpPing, []byte(payload)) }

// WriteRaw puts arbitrary bytes on the wire — for the malformed-frame cases.
func (c *Conn) WriteRaw(b []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, err := c.net.Write(b)
	return err
}

// WriteClose sends a close frame with status 1000.
func (c *Conn) WriteClose() error { return c.write(ws.OpClose, []byte{0x03, 0xe8}) }

// Drop kills the socket WITHOUT a close handshake — the abrupt disconnection a
// reconnecting client has to survive, and the one a graceful close would hide.
func (c *Conn) Drop() error { return c.net.Close() }

// Close is Drop; the name is here for defer readability.
func (c *Conn) Close() error { return c.net.Close() }

// ReadMessage reads one client frame, unmasking it. Control frames are returned
// as-is so a test can assert the client's pong.
func (c *Conn) ReadMessage() (opcode int, payload []byte, err error) {
	var head [2]byte
	if _, err := io.ReadFull(c.br, head[:]); err != nil {
		return 0, nil, err
	}
	opcode = int(head[0] & 0x0f)
	masked := head[1]&0x80 != 0
	length := int64(head[1] & 0x7f)
	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			return 0, nil, err
		}
		length = int64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			return 0, nil, err
		}
		length = int64(binary.BigEndian.Uint64(ext[:]))
	}
	if length > 1<<20 {
		return 0, nil, fmt.Errorf("wstest: oversized client frame (%d bytes)", length)
	}
	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(c.br, mask[:]); err != nil {
			return 0, nil, err
		}
	} else {
		// RFC 6455 §5.1: a client MUST mask. Reported rather than tolerated —
		// this is one of the properties the client is being tested for.
		return 0, nil, errors.New("wstest: client frame was NOT masked")
	}
	payload = make([]byte, length)
	if _, err := io.ReadFull(c.br, payload); err != nil {
		return 0, nil, err
	}
	ws.Mask(mask, payload)
	return opcode, payload, nil
}

func (c *Conn) write(opcode int, payload []byte) error {
	header := []byte{byte(0x80 | opcode)}
	switch n := len(payload); {
	case n <= 125:
		header = append(header, byte(n))
	case n <= 0xffff:
		header = append(header, 126, byte(n>>8), byte(n))
	default:
		header = append(header, 127)
		var ext [8]byte
		binary.BigEndian.PutUint64(ext[:], uint64(n))
		header = append(header, ext[:]...)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	_, err := c.net.Write(append(header, payload...))
	return err
}
