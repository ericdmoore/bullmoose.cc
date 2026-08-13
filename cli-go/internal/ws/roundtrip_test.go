package ws_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/ws"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/ws/wstest"
)

// TestRoundTrip drives the client against the independent server half: the
// handshake completes, a text frame arrives intact, and the client's close
// reaches the server MASKED (which wstest.ReadMessage refuses to tolerate).
//
// It lives in package ws_test rather than ws because wstest imports ws, and an
// internal test file importing it would be an import cycle.
func TestRoundTrip(t *testing.T) {
	accepted := make(chan *wstest.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := wstest.Upgrade(w, r)
		if err != nil {
			return
		}
		accepted <- c
		_ = c.WriteText(`{"@type":"StateChange"}`)
		// Hold the handler open; the hijacked conn outlives it otherwise.
		for {
			if _, _, err := c.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer srv.Close()

	conn, err := ws.Dial(context.Background(), "ws"+strings.TrimPrefix(srv.URL, "http")+"/api/ws?accountId=a1")
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer conn.Close()

	server := <-accepted
	if got := server.Request.URL.Query().Get("accountId"); got != "a1" {
		t.Errorf("server saw accountId=%q, want a1", got)
	}
	op, payload, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("ReadMessage: %v", err)
	}
	if op != ws.OpText || string(payload) != `{"@type":"StateChange"}` {
		t.Errorf("got op 0x%x %q", op, payload)
	}
}
