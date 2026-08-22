package cmd

// `bullmoose creds` — the CLI face of the credential vault (Bureau §5). A
// port of packages/cli/src/creds.ts under s42's ONE exception to the idiom
// licence: this command is ported EXACTLY, because the guards are the product.
//
// The invariants, named so a later "cleanup" cannot sand them off:
//
//	1. WRITE-ONLY. Secrets go UP; list/show return names/kinds/metadata only.
//	   There is no reveal button, and this file must never grow one.
//	2. FAIL CLOSED (bureau.md §6, invariant 5): `set` REQUIRES --allow. A
//	   credential with no destination is unusable by design, and the refusal
//	   teaches the shape rather than just refusing.
//	3. The secret reaches this process by --secret (scripting), --secret-env
//	   (a NAME, resolved here), or a HIDDEN prompt — and is never echoed,
//	   logged, or written anywhere but the PUT body.
//	4. The PKCE refresh token is uploaded and DISCARDED. The CLI is a conduit;
//	   nothing OAuth-shaped lands on this machine's disk.
//
// No renames. The first draft moved --scope to --cred-scope against an
// imagined collision with the token verbs' flag — which is --scopes, PLURAL.
// The parser-grammar drift test refused the invented flag as undocumented,
// which is exactly the check working: "port EXACTLY" includes the flag names.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

// kindVerbs is bureau.md §4.1 — kind → the Bureau verbs it may ever be used with.
var kindVerbs = map[string]string{
	"api-key":       "fetch",
	"oauth-refresh": "oauth_token, fetch",
	"aws-sigv4":     "sign_sigv4, fetch",
	"hmac-key":      "hmac_sha256",
}

func kindNames() string {
	names := make([]string, 0, len(kindVerbs))
	for k := range kindVerbs {
		names = append(names, k)
	}
	sort.Strings(names)
	return strings.Join(names, ", ")
}

// credsDeps are the effects a test cannot have: the browser opener and the
// hidden prompt. Production fills them with the real ones.
type credsDeps struct {
	openBrowser  func(url string) error
	promptSecret func(msg string) (string, error)
	// callbackHost overrides 127.0.0.1 binding for tests.
	now func() time.Time
}

func runCreds(s *bmio.Streams, argv []string) int {
	return runCredsWith(s, argv, credsDeps{})
}

func runCredsWith(s *bmio.Streams, argv []string, deps credsDeps) int {
	a := parse(argv)
	sub := a.at(1)
	name := a.at(2)

	db, err := store.Open(store.DBPath(a.DB))
	if err != nil {
		return die(s, err)
	}
	defer db.Close()

	if sub == "init" {
		if a.URL == "" {
			s.Note("usage: bullmoose creds init --url <agent-worker-url>")
			return 2
		}
		if err := store.SetConfig(db, "vaultUrl", strings.TrimRight(a.URL, "/")); err != nil {
			return die(s, err)
		}
		if a.JSON {
			return emitOr(s, s.EmitJSON(map[string]string{"vaultUrl": a.URL}))
		}
		s.Out("vault configured: " + a.URL)
		return 0
	}

	switch sub {
	case "set", "list", "show", "rotate", "rm", "oauth":
	default:
		s.Note("usage: unknown creds subcommand: " + orNoneWord(sub) + " (init|set|list|show|rotate|rm|oauth)")
		return 2
	}

	settings, err := store.RequireSettings(db)
	if err != nil {
		return die(s, err)
	}
	vaultURL := store.GetConfig(db, "vaultUrl")
	if vaultURL == "" {
		s.Note("vault not configured — run: bullmoose creds init --url <agent-worker-url>")
		return 1
	}
	vault := vaultAPI{base: vaultURL, token: settings.Token}
	ctx := context.Background()

	switch sub {
	case "set":
		if name == "" {
			s.Note("usage: bullmoose creds set <name> --kind <kind> --allow <origin> [--header …]")
			return 2
		}
		kind := a.Kind
		if kind == "" {
			kind = "api-key"
		}
		if _, ok := kindVerbs[kind]; !ok {
			s.Note("usage: --kind must be one of " + kindNames())
			return 2
		}
		// Invariant 2, verbatim: no destination → refuse to mint, and teach.
		if a.Allow == "" {
			s.Note(`usage: --allow <origin> is required — a credential with no destination is unusable by design ` +
				`(bureau.md §6). e.g. --allow https://api.stripe.com or --allow "*.amazonaws.com"`)
			return 2
		}
		secret, code := resolveSecret(s, a, deps, "secret for "+name+": ")
		if code != 0 {
			return code
		}
		body := map[string]any{
			"name": name, "kind": kind, "secret": secret,
			"meta": parseMeta(a.Meta), "allow": a.Allow,
		}
		if a.Header != "" {
			body["header"] = a.Header
		}
		if a.CredScope != "" {
			body["scope"] = a.CredScope
		}
		if a.Enforcement != "" {
			body["enforcement"] = a.Enforcement
		}
		res, err := vault.call(ctx, "PUT", "/vault/credentials", body)
		if err != nil {
			return die(s, err)
		}
		if a.JSON {
			return emitOr(s, s.EmitJSON(json.RawMessage(res)))
		}
		var stored struct {
			Allow       *string `json:"allow"`
			Enforcement string  `json:"enforcement"`
		}
		_ = json.Unmarshal(res, &stored)
		allow := "(none)"
		if stored.Allow != nil {
			allow = *stored.Allow
		}
		enf := stored.Enforcement
		if enf == "" {
			enf = "?"
		}
		s.Out(fmt.Sprintf("stored %s (%s → %s) allow=%s enforcement=%s — write-only, never shown again",
			name, kind, kindVerbs[kind], allow, enf))
		return 0

	case "list":
		res, err := vault.call(ctx, "GET", "/vault/credentials", nil)
		if err != nil {
			return die(s, err)
		}
		creds, err := parseCredList(res)
		if err != nil {
			return die(s, err)
		}
		if a.JSON {
			rows := make([]any, 0, len(creds))
			for _, c := range creds {
				rows = append(rows, c.raw)
			}
			return emitOr(s, s.EmitNDJSON(rows))
		}
		for _, c := range creds {
			s.Out(credLine(c))
		}
		if len(creds) == 0 {
			s.Note("(no credentials)")
		}
		return 0

	case "show":
		if name == "" {
			s.Note("usage: bullmoose creds show <name>")
			return 2
		}
		res, err := vault.call(ctx, "GET", "/vault/credentials", nil)
		if err != nil {
			return die(s, err)
		}
		creds, err := parseCredList(res)
		if err != nil {
			return die(s, err)
		}
		for _, c := range creds {
			if c.Name != name {
				continue
			}
			if a.JSON {
				return emitOr(s, s.EmitJSON(c.raw))
			}
			s.Out("name         " + c.Name)
			verb := kindVerbs[c.Kind]
			if verb == "" {
				verb = "?"
			}
			s.Out("kind         " + c.Kind + " → " + verb)
			allow := "(none) — fail-closed, unusable by design"
			if c.Allow != nil {
				allow = *c.Allow
			}
			s.Out("allow        " + allow)
			hdr := "(none)"
			if c.Header != nil {
				hdr = *c.Header
			}
			s.Out("header       " + hdr)
			scope := "actor"
			if c.Scope != nil {
				scope = *c.Scope
			}
			s.Out("scope        " + scope)
			enf := "?"
			if c.Enforcement != nil {
				enf = *c.Enforcement
			}
			line := "enforcement  " + enf
			if enf == "broad" {
				line += "  (only our code enforces, once the proxy exists)"
			}
			s.Out(line)
			if len(c.Meta) > 0 {
				metaJSON, _ := json.Marshal(c.Meta)
				s.Out("meta         " + string(metaJSON))
			}
			s.Note("(the secret is never returned — invariant 1, no reveal button)")
			return 0
		}
		s.Note(name + " not found")
		return 1

	case "rotate":
		if name == "" {
			s.Note("usage: bullmoose creds rotate <name>")
			return 2
		}
		if a.DryRun {
			s.Note("dry run: would re-seal a new secret for " + name + "; nothing was written")
			if a.JSON {
				return emitOr(s, s.EmitJSON(map[string]any{"dryRun": true, "name": name}))
			}
			return 0
		}
		secret, code := resolveSecret(s, a, deps, "new secret for "+name+": ")
		if code != 0 {
			return code
		}
		res, err := vault.call(ctx, "POST", "/vault/credentials/"+url.PathEscape(name)+"/rotate",
			map[string]any{"secret": secret})
		if err != nil {
			return die(s, err)
		}
		if a.JSON {
			return emitOr(s, s.EmitJSON(json.RawMessage(res)))
		}
		s.Out("rotated " + name + " — re-sealed under the same name; downstream refs unchanged")
		return 0

	case "rm":
		if name == "" {
			s.Note("usage: bullmoose creds rm <name>")
			return 2
		}
		if a.DryRun {
			s.Note("dry run: would delete credential " + name + "; nothing was written")
			if a.JSON {
				return emitOr(s, s.EmitJSON(map[string]any{"dryRun": true, "name": name}))
			}
			return 0
		}
		res, err := vault.call(ctx, "DELETE", "/vault/credentials/"+url.PathEscape(name), nil)
		if err != nil {
			return die(s, err)
		}
		var del struct {
			Deleted bool `json:"deleted"`
		}
		_ = json.Unmarshal(res, &del)
		if a.JSON {
			return emitOr(s, s.EmitJSON(json.RawMessage(res)))
		}
		if del.Deleted {
			s.Out("deleted " + name)
		} else {
			s.Note(name + " not found")
		}
		return 0

	default: // oauth — validated into the switch above
		if name == "" || a.AuthorizeURL == "" || a.TokenURL == "" || a.ClientID == "" {
			s.Note("usage: bullmoose creds oauth <name> --authorize-url <url> --token-url <url>\n" +
				`                 --client-id <id> [--client-secret <s>] [--oauth-scopes "a b"] [--port 8976]`)
			return 2
		}
		port := 8976
		if a.Port != "" {
			p, err := strconv.Atoi(a.Port)
			if err != nil || p < 1 || p > 65535 {
				s.Note("usage: --port must be a port number")
				return 2
			}
			port = p
		}
		refresh, err := runPkceFlow(s, deps, pkceFlow{
			AuthorizeURL: a.AuthorizeURL,
			TokenURL:     a.TokenURL,
			ClientID:     a.ClientID,
			ClientSecret: a.ClientSecret,
			Scopes:       a.OAuthScopes,
			Port:         port,
		})
		if err != nil {
			return die(s, err)
		}
		meta := parseMeta(a.Meta)
		meta["token_url"] = a.TokenURL
		meta["client_id"] = a.ClientID
		if a.OAuthScopes != "" {
			meta["scopes"] = a.OAuthScopes
		}
		body := map[string]any{
			"name": name, "kind": "oauth-refresh", "secret": refresh, "meta": meta,
		}
		if a.Allow != "" {
			body["allow"] = a.Allow
		}
		if a.Enforcement != "" {
			body["enforcement"] = a.Enforcement
		}
		res, err := vault.call(ctx, "PUT", "/vault/credentials", body)
		if err != nil {
			return die(s, err)
		}
		if a.JSON {
			return emitOr(s, s.EmitJSON(json.RawMessage(res)))
		}
		s.Out("refresh token for " + name + " uploaded to the vault — not kept locally")
		return 0
	}
}

// resolveSecret is invariant 3's funnel: --secret, then the NAMED env var,
// then the hidden prompt. An empty result from any source is a refusal.
func resolveSecret(s *bmio.Streams, a args, deps credsDeps, prompt string) (string, int) {
	secret := a.Secret
	if secret == "" && a.SecretEnv != "" {
		secret = os.Getenv(a.SecretEnv)
	}
	if secret == "" {
		promptFn := deps.promptSecret
		if promptFn == nil {
			promptFn = promptHidden
		}
		v, err := promptFn(prompt)
		if err != nil {
			return "", die(s, err)
		}
		secret = v
	}
	if secret == "" {
		s.Note("usage: no secret provided")
		return "", 2
	}
	return secret, 0
}

// vaultAPI is the write-only REST face on the agent worker.
type vaultAPI struct {
	base  string
	token string
}

func (v vaultAPI) call(ctx context.Context, method, path string, body any) (json.RawMessage, error) {
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = strings.NewReader(string(b))
	}
	req, err := http.NewRequestWithContext(ctx, method, v.base+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+v.token)
	req.Header.Set("content-type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, &bmio.CliError{Msg: "vault " + method + " " + path + " failed: " + err.Error(), Code: bmio.ExitFail}
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, &bmio.ServerError{
			Msg:        fmt.Sprintf("vault %s %s → HTTP %d: %s", method, path, res.StatusCode, string(raw)),
			HTTPStatus: res.StatusCode,
		}
	}
	return raw, nil
}

type credView struct {
	Name        string
	Kind        string
	Allow       *string
	Header      *string
	Scope       *string
	Enforcement *string
	Meta        map[string]any
	raw         json.RawMessage
}

func parseCredList(res json.RawMessage) ([]credView, error) {
	var outer struct {
		Credentials []json.RawMessage `json:"credentials"`
	}
	if err := json.Unmarshal(res, &outer); err != nil {
		return nil, err
	}
	out := make([]credView, 0, len(outer.Credentials))
	for _, raw := range outer.Credentials {
		var c credView
		var wire struct {
			Name        string         `json:"name"`
			Kind        string         `json:"kind"`
			Allow       *string        `json:"allow"`
			Header      *string        `json:"header"`
			Scope       *string        `json:"scope"`
			Enforcement *string        `json:"enforcement"`
			Meta        map[string]any `json:"meta"`
		}
		if err := json.Unmarshal(raw, &wire); err != nil {
			return nil, err
		}
		c.Name, c.Kind, c.Allow, c.Header, c.Scope, c.Enforcement, c.Meta = wire.Name, wire.Kind, wire.Allow, wire.Header, wire.Scope, wire.Enforcement, wire.Meta
		c.raw = raw
		out = append(out, c)
	}
	return out, nil
}

// credLine: name, kind, destination at a glance. UNBOUND is loud on purpose.
func credLine(c credView) string {
	dest := "UNBOUND"
	if c.Allow != nil {
		dest = *c.Allow
	}
	enf := ""
	if c.Enforcement != nil {
		enf = " [" + *c.Enforcement + "]"
	}
	return fmt.Sprintf("%-24s %-14s %s%s", c.Name, c.Kind, dest, enf)
}

func parseMeta(raw string) map[string]string {
	meta := map[string]string{}
	for _, pair := range strings.Split(raw, ",") {
		k, v, ok := strings.Cut(pair, "=")
		if ok && strings.TrimSpace(k) != "" {
			meta[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	return meta
}

func orNoneWord(v string) string {
	if v == "" {
		return "(none)"
	}
	return v
}

// ---- OAuth 2.0 authorization-code + PKCE (RFC 7636) ------------------------

type pkceFlow struct {
	AuthorizeURL string
	TokenURL     string
	ClientID     string
	ClientSecret string
	Scopes       string
	Port         int
}

// runPkceFlow runs the browser + localhost-callback dance. The refresh token
// is RETURNED, uploaded by the caller, and discarded — invariant 4.
func runPkceFlow(s *bmio.Streams, deps credsDeps, flow pkceFlow) (string, error) {
	verifier, err := randB64(48)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	state, err := randB64(16)
	if err != nil {
		return "", err
	}
	redirectURI := fmt.Sprintf("http://127.0.0.1:%d/callback", flow.Port)

	authURL, err := url.Parse(flow.AuthorizeURL)
	if err != nil {
		return "", bmio.Usage("--authorize-url: " + err.Error())
	}
	q := authURL.Query()
	q.Set("response_type", "code")
	q.Set("client_id", flow.ClientID)
	q.Set("redirect_uri", redirectURI)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	q.Set("state", state)
	q.Set("access_type", "offline") // Google: ask for a refresh token
	q.Set("prompt", "consent")
	if flow.Scopes != "" {
		q.Set("scope", flow.Scopes)
	}
	authURL.RawQuery = q.Encode()

	codeCh := make(chan string, 1)
	errCh := make(chan error, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		qs := r.URL.Query()
		w.Header().Set("content-type", "text/html")
		_, _ = w.Write([]byte("<h3>bullmoose: you can close this tab.</h3>"))
		switch {
		case qs.Get("error") != "":
			errCh <- errors.New("authorization failed: " + qs.Get("error"))
		case qs.Get("state") != state:
			// The state is this flow's CSRF token; a mismatch is an attack or a
			// stale tab, and either way the code is not ours to use.
			errCh <- errors.New("state mismatch — aborting")
		case qs.Get("code") == "":
			errCh <- errors.New("no code in callback")
		default:
			codeCh <- qs.Get("code")
		}
	})
	server := &http.Server{Addr: "127.0.0.1:" + strconv.Itoa(flow.Port), Handler: mux}
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()
	defer func() { _ = server.Close() }()

	s.Note("listening on " + redirectURI + " — opening browser…")
	s.Note("if it doesn't open: " + authURL.String())
	opener := deps.openBrowser
	if opener == nil {
		opener = openSystemBrowser
	}
	_ = opener(authURL.String()) // best-effort: the URL was printed either way

	var code string
	select {
	case code = <-codeCh:
	case err := <-errCh:
		return "", err
	case <-time.After(5 * time.Minute):
		return "", errors.New("timed out waiting for the OAuth callback (5 min)")
	}

	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {redirectURI},
		"client_id":     {flow.ClientID},
		"code_verifier": {verifier},
	}
	if flow.ClientSecret != "" {
		form.Set("client_secret", flow.ClientSecret)
	}
	res, err := http.PostForm(flow.TokenURL, form)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "", &bmio.ServerError{
			Msg:        fmt.Sprintf("token exchange failed: HTTP %d: %s", res.StatusCode, string(raw)),
			HTTPStatus: res.StatusCode,
		}
	}
	var tokens struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.Unmarshal(raw, &tokens); err != nil {
		return "", err
	}
	if tokens.RefreshToken == "" {
		return "", errors.New("provider returned no refresh_token (check offline access / consent settings); nothing was stored")
	}
	return tokens.RefreshToken, nil
}

func randB64(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func openSystemBrowser(u string) error {
	var c *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		c = exec.Command("open", u)
	case "windows":
		c = exec.Command("cmd", "/c", "start", u)
	default:
		c = exec.Command("xdg-open", u)
	}
	return c.Start()
}
