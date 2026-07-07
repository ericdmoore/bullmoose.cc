// popcorn — POP3 "but way more corny" 🍿
//
// A barely-conforming POP3S front-end that translates onto a JMAP server
// (bullmoose.cc or any RFC 8620/8621 host). One static binary; the only
// platform differences live in deploy/ (systemd vs launchd vs Docker).
//
// Configuration (environment):
//   POPCORN_LISTEN        comma-separated addrs   (default ":995")
//   POPCORN_TLS_CERT      PEM cert path — with KEY enables implicit TLS
//   POPCORN_TLS_KEY       PEM key path
//   POPCORN_JMAP_BASE     override JMAP origin; default: _jmap._tcp SRV
//                         discovery from the login email's domain
//   POPCORN_DELE_MODE     archive (default) | noop — popcorn NEVER destroys
//   POPCORN_MAX_MESSAGES  maildrop window, newest N (default 200)
//   POPCORN_IDLE_TIMEOUT  e.g. 5m (default; RFC minimum is 10m — we're corny)
package main

import (
	"crypto/tls"
	"log"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"bullmoose.cc/popcorn/internal/pop3"
)

func main() {
	cfg := pop3.Config{
		JMAPBase:    os.Getenv("POPCORN_JMAP_BASE"),
		DeleMode:    envOr("POPCORN_DELE_MODE", "archive"),
		MaxMessages: envInt("POPCORN_MAX_MESSAGES", 200),
		IdleTimeout: envDuration("POPCORN_IDLE_TIMEOUT", 5*time.Minute),
	}

	var tlsConfig *tls.Config
	certPath, keyPath := os.Getenv("POPCORN_TLS_CERT"), os.Getenv("POPCORN_TLS_KEY")
	if certPath != "" && keyPath != "" {
		cert, err := tls.LoadX509KeyPair(certPath, keyPath)
		if err != nil {
			log.Fatalf("tls: %v", err)
		}
		tlsConfig = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
	} else {
		log.Printf("WARNING: no POPCORN_TLS_CERT/KEY — serving PLAINTEXT (dev only; tokens travel in the clear)")
	}

	sem := make(chan struct{}, 64) // connection cap

	addrs := strings.Split(envOr("POPCORN_LISTEN", ":995"), ",")
	for _, addr := range addrs {
		addr = strings.TrimSpace(addr)
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			log.Fatalf("listen %s: %v", addr, err)
		}
		if tlsConfig != nil {
			ln = tls.NewListener(ln, tlsConfig)
		}
		log.Printf("popcorn listening on %s (tls=%v, dele=%s, jmap=%s)",
			addr, tlsConfig != nil, cfg.DeleMode, orSRV(cfg.JMAPBase))
		go accept(ln, cfg, sem)
	}
	select {} // serve forever; the service manager owns our lifecycle
}

func accept(ln net.Listener, cfg pop3.Config, sem chan struct{}) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			log.Printf("accept: %v", err)
			time.Sleep(100 * time.Millisecond)
			continue
		}
		sem <- struct{}{}
		go func() {
			defer func() { <-sem }()
			pop3.Serve(conn, cfg)
		}()
	}
}

func orSRV(s string) string {
	if s == "" {
		return "(SRV discovery)"
	}
	return s
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return fallback
}

func envDuration(key string, fallback time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return fallback
}
