package cloud

// APPLY — s46 T3, the first mutating verb of the cloud surface. Everything
// here runs strictly AFTER the plan was printed whole and one honest yes
// was given (cmd/cloud.go owns the prompt); this file's own gate re-checks
// anyway, because "the caller surely gated" is how installers ruin DNS.
//
// The order is the binding graph, the same derivation deploy-mail.yml
// carries: storage first (workers bind it by id), then D1 schema (a worker
// that boots against an empty database serves 500s), then workers in
// DEPLOY_ORDER (a service binding to an undeployed worker fails the deploy
// that declares it), then secrets onto each script, then routes and custom
// domains once every script they name exists.
//
// Custody (the section's point): minted secrets are generated HERE, land in
// the user's account as worker secrets, are returned to the caller for the
// hand-off print — and are stored nowhere else. The project sees nothing.
//
// Idempotence: `reuse` resources are bound by the id the ACCOUNT assigned
// (probe carries it); `create` learns the id from the create response. The
// shipped configs' ids never travel (jsonc.go strips them by not parsing
// them). Re-running a half-applied install re-plans, reuses what landed,
// and creates the remainder — resume is the same verb, not a special one.

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"sort"
	"strings"
)

// mintSecret generates one secret exactly the way infra/bootstrap.mjs
// does — randomBytes(bytes).toString("hex") — so a stack installed by this
// path and one bootstrapped from the repo carry the same secret SHAPE and
// every consumer's parsing assumptions hold.
func mintSecret(bytes int) (string, error) {
	b := make([]byte, bytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// Applied is apply's receipt: what happened, and the minted values the
// hand-off needs (printed once by the caller; persisted nowhere).
type Applied struct {
	Steps  []string
	Minted map[string]string
	// MissingExternal is every REQUIRED external secret that was not in the
	// environment: the install is honest about being incomplete rather than
	// silently shipping workers that cannot send mail.
	MissingExternal []string
}

// ApplyOpts carries the non-account inputs.
type ApplyOpts struct {
	Zone string
	// External are operator-supplied secret values (read from the caller's
	// environment); only names listed in the manifest are consulted.
	External map[string]string
	// Log receives one line per step as it HAPPENS — apply narrates in real
	// time, because a silent multi-minute mutation is indistinguishable
	// from a hung one.
	Log func(string)
}

// ApplyCore executes the plan's core-resource half: storage, schema,
// workers, secrets, routes. Pages/webmail and the mail path (MX, Email
// Routing) are T4/T5 and deliberately absent — the receipt says so.
func ApplyCore(cf *CF, st *Stack, probe *ProbeResult, plan *Plan, opts ApplyOpts) (*Applied, error) {
	if len(plan.Refusals) > 0 {
		return nil, fmt.Errorf("the plan contains %d refusal(s) — apply does not run over a refusal, ever", len(plan.Refusals))
	}
	if len(plan.Blocked) > 0 {
		return nil, fmt.Errorf("the plan has %d blocked surface(s) — widen the token first so apply acts on knowledge, not hope", len(plan.Blocked))
	}
	if probe.Zone == nil {
		return nil, fmt.Errorf("no zone in the probe result")
	}
	log := opts.Log
	if log == nil {
		log = func(string) {}
	}
	acct := probe.Zone.AccountID
	applied := &Applied{Minted: map[string]string{}}
	step := func(format string, a ...any) {
		line := fmt.Sprintf(format, a...)
		applied.Steps = append(applied.Steps, line)
		log(line)
	}

	// ---- storage: KV, R2, D1 — ids learned here, used by every worker ----
	kvIDs := map[string]string{} // binding/title → namespace id
	for _, ns := range probe.KV {
		kvIDs[ns.Title] = ns.ID
	}
	d1IDs := map[string]string{} // database name → uuid
	for _, db := range probe.D1 {
		d1IDs[db.Name] = db.UUID
	}
	for _, it := range plan.Items {
		switch {
		case it.Kind == "kv" && it.Action == Create:
			var created KVNamespace
			if err := cf.postJSON("/accounts/"+acct+"/storage/kv/namespaces",
				map[string]string{"title": it.Name}, &created); err != nil {
				return applied, fmt.Errorf("create kv %s: %w", it.Name, err)
			}
			kvIDs[it.Name] = created.ID
			step("kv %s created (id %s)", it.Name, created.ID)
		case it.Kind == "kv" && it.Action == Reuse:
			step("kv %s reused (id %s)", it.Name, kvIDs[it.Name])
		case it.Kind == "r2" && it.Action == Create:
			if err := cf.postJSON("/accounts/"+acct+"/r2/buckets",
				map[string]string{"name": it.Name}, &json.RawMessage{}); err != nil {
				return applied, fmt.Errorf("create r2 %s: %w", it.Name, err)
			}
			step("r2 %s created", it.Name)
		case it.Kind == "d1" && it.Action == Create:
			var created D1Database
			if err := cf.postJSON("/accounts/"+acct+"/d1/database",
				map[string]string{"name": it.Name}, &created); err != nil {
				return applied, fmt.Errorf("create d1 %s: %w", it.Name, err)
			}
			d1IDs[it.Name] = created.UUID
			step("d1 %s created (uuid %s)", it.Name, created.UUID)
		}
	}

	// ---- D1 schema + shipped migrations — before any worker runs against it.
	// The schema files are idempotent CREATEs (fresh DDL); the migrations
	// then run exactly where their check says the schema predates them —
	// which on a fresh database is nowhere.
	for name, uuid := range d1IDs {
		for _, schemaPath := range st.Manifest.Schema {
			sql, err := st.FetchVerified(schemaPath)
			if err != nil {
				return applied, err
			}
			if err := cf.d1Query(acct, uuid, string(sql), nil); err != nil {
				return applied, fmt.Errorf("apply %s to %s: %w", schemaPath, name, err)
			}
			step("d1 %s: %s applied", name, schemaPath)
		}
		ran, err := applyMigrations(cf, st, acct, uuid)
		if err != nil {
			return applied, fmt.Errorf("migrations on %s: %w", name, err)
		}
		step("d1 %s: %d/%d migrations needed running", name, ran, st.Manifest.Migrations.Count)
	}

	// ---- secrets: minted now, installed right after each script upload ----
	//
	// ⚠️ MINT ONLY WHEN EVERY HOLDER IS BEING CREATED. Worker secrets are
	// write-only; an existing install's values cannot be read back. Re-
	// minting onto a reused script would ROTATE it — for a shared secret
	// (INTERNAL_TOKEN) that splits the fleet mid-run, and for
	// VAULT_MASTER_KEY it makes every credential the Bureau ever sealed
	// permanently undecryptable. So: all holders Create → mint and install;
	// any holder reused → the existing install keeps its own values, and a
	// created holder that NEEDS a kept secret is a named gap, not a guess.
	existing := map[string]bool{}
	for _, w := range probe.Workers {
		existing[w] = true
	}
	allHoldersCreate := func(spec []string) bool {
		for _, short := range spec {
			if cfg, ok := st.Configs[short]; ok && existing[cfg.Name] {
				return false
			}
		}
		return true
	}
	minted := map[string]string{}
	kept := []string{}
	for name, spec := range st.Manifest.Secrets.Generated {
		if allHoldersCreate(spec.Workers) {
			v, err := mintSecret(spec.Bytes)
			if err != nil {
				return applied, fmt.Errorf("minting %s: %w", name, err)
			}
			minted[name] = v
		} else {
			kept = append(kept, name)
		}
	}
	sort.Strings(kept)
	for _, name := range kept {
		step("secret %s: an existing install holds it — kept, not rotated", name)
	}
	applied.Minted = minted
	secretsFor := func(short string) map[string]string {
		out := map[string]string{}
		for name, spec := range st.Manifest.Secrets.Generated {
			if !has(spec.Workers, short) {
				continue
			}
			if v, ok := minted[name]; ok {
				out[name] = v
			} else if !existing[st.Configs[short].Name] {
				// A NEW holder of a KEPT secret: the right value is
				// unreadable, a fresh one would split the shared secret.
				step("worker %s: needs %s but the existing install owns it — set it by hand (wrangler secret put)", st.Configs[short].Name, name)
			}
		}
		for name, spec := range st.Manifest.Secrets.External {
			if !has(spec.Workers, short) {
				continue
			}
			if v, ok := opts.External[name]; ok && v != "" {
				out[name] = v
			} else if spec.Required && !has(applied.MissingExternal, name) {
				applied.MissingExternal = append(applied.MissingExternal, name)
			}
		}
		return out
	}

	// ---- workers, in deploy order ----
	for _, short := range st.Manifest.DeployOrder {
		cfg := st.Configs[short]
		bundlePath := "workers/" + short + "/index.js"
		bundle, err := st.FetchVerified(bundlePath)
		if err != nil {
			return applied, err
		}
		meta, err := workerMetadata(cfg, kvIDs, d1IDs, !existing[cfg.Name])
		if err != nil {
			return applied, fmt.Errorf("%s: %w", cfg.Name, err)
		}
		if err := cf.putWorker(acct, cfg.Name, meta, bundle); err != nil {
			return applied, fmt.Errorf("upload %s: %w", cfg.Name, err)
		}
		// workers.dev, wrangler's own semantics: enabled iff no routes are
		// declared. API uploads default to DISABLED, which would leave
		// provision — the `admin init` door, workers.dev-only by design —
		// unreachable, and the hand-off would print a URL that 404s.
		workersDev := len(cfg.Routes) == 0
		if err := cf.postJSON("/accounts/"+acct+"/workers/scripts/"+cfg.Name+"/subdomain",
			map[string]bool{"enabled": workersDev}, nil); err != nil {
			return applied, fmt.Errorf("workers.dev on %s: %w", cfg.Name, err)
		}
		step("worker %s uploaded (%d KiB), workers.dev=%v", cfg.Name, len(bundle)/1024, workersDev)
		for name, value := range secretsFor(short) {
			if err := cf.putSecret(acct, cfg.Name, name, value); err != nil {
				return applied, fmt.Errorf("secret %s on %s: %w", name, cfg.Name, err)
			}
			step("worker %s: secret %s installed", cfg.Name, name)
		}
	}

	// ---- routes + custom domains — every script they name now exists ----
	existingRoutes := map[string]bool{}
	var routeList []struct {
		Pattern string `json:"pattern"`
	}
	if err := cf.getJSON("/zones/"+probe.Zone.ID+"/workers/routes", &routeList); err == nil {
		for _, r := range routeList {
			existingRoutes[r.Pattern] = true
		}
	}
	for _, short := range st.Manifest.DeployOrder {
		cfg := st.Configs[short]
		for _, r := range cfg.Routes {
			if r.Pattern == "" {
				continue
			}
			pattern := planPattern(r.Pattern, opts.Zone)
			if r.CustomDomain {
				if err := cf.putJSON("/accounts/"+acct+"/workers/domains", map[string]string{
					"zone_id": probe.Zone.ID, "hostname": pattern,
					"service": cfg.Name, "environment": "production",
				}, &json.RawMessage{}); err != nil {
					return applied, fmt.Errorf("custom domain %s → %s: %w", pattern, cfg.Name, err)
				}
				step("custom domain %s → %s", pattern, cfg.Name)
				continue
			}
			if existingRoutes[pattern] {
				step("route %s exists — reused", pattern)
				continue
			}
			if err := cf.postJSON("/zones/"+probe.Zone.ID+"/workers/routes", map[string]string{
				"pattern": pattern, "script": cfg.Name,
			}, &json.RawMessage{}); err != nil {
				return applied, fmt.Errorf("route %s → %s: %w", pattern, cfg.Name, err)
			}
			step("route %s → %s", pattern, cfg.Name)
		}
	}

	// ---- the webmail app's home: Pages project + its hostname ----
	// The DEPLOYMENT (asset upload) is deliberately NOT here: Pages direct
	// upload is wrangler's own file-hash protocol, and a reimplementation
	// would be a drifting copy (the mail-path rule again). The receipt hands
	// the operator the one wrangler command; this makes that command work
	// with zero setup — project existing, hostname attached and its DNS
	// record provisioned (the attach is what CREATES app.<zone>, per
	// deploy-app.yml's derivation).
	for _, it := range plan.Items {
		if it.Kind != "pages" {
			continue
		}
		if it.Action == Create {
			if err := cf.postJSON("/accounts/"+acct+"/pages/projects",
				map[string]any{"name": it.Name, "production_branch": "main"}, &json.RawMessage{}); err != nil {
				return applied, fmt.Errorf("create pages project %s: %w", it.Name, err)
			}
			step("pages project %s created", it.Name)
		} else {
			step("pages project %s reused", it.Name)
		}
		host := "app." + opts.Zone
		if err := cf.postJSON("/accounts/"+acct+"/pages/projects/"+it.Name+"/domains",
			map[string]string{"name": host}, &json.RawMessage{}); err != nil {
			// An already-attached domain answers 409 — the state we wanted.
			if !strings.Contains(err.Error(), "409") {
				return applied, fmt.Errorf("pages domain %s: %w", host, err)
			}
			step("pages domain %s already attached", host)
		} else {
			step("pages domain %s attached (DNS record provisioned)", host)
		}
	}

	// ---- verify: every script answers the API; the schema has tables ----
	for _, short := range st.Manifest.DeployOrder {
		cfg := st.Configs[short]
		var raw json.RawMessage
		if err := cf.getJSON("/accounts/"+acct+"/workers/scripts/"+cfg.Name, &raw); err != nil {
			return applied, fmt.Errorf("verify: %s did not read back: %w", cfg.Name, err)
		}
	}
	for name, uuid := range d1IDs {
		var rows []struct {
			N int `json:"n"`
		}
		if err := cf.d1Query(acct, uuid, "SELECT count(*) AS n FROM sqlite_master WHERE type='table'", &rows); err != nil {
			return applied, fmt.Errorf("verify: %s did not answer a query: %w", name, err)
		}
		if len(rows) == 0 || rows[0].N == 0 {
			return applied, fmt.Errorf("verify: %s has no tables after schema apply", name)
		}
		step("verify: %s answers with %d tables; all %d workers read back", name, rows[0].N, len(st.Manifest.DeployOrder))
	}
	return applied, nil
}

// applyMigrations runs each shipped migration whose check says the schema
// predates it. On a fresh database the base schema already carries
// everything and every check passes — zero run, which the caller logs.
func applyMigrations(cf *CF, st *Stack, acct, uuid string) (int, error) {
	raw, err := st.FetchVerified(st.Manifest.Migrations.File)
	if err != nil {
		return 0, err
	}
	var migrations []struct {
		ID    string   `json:"id"`
		Check string   `json:"check"`
		Up    []string `json:"up"`
	}
	if err := json.Unmarshal(raw, &migrations); err != nil {
		return 0, fmt.Errorf("migrations.json did not parse: %w", err)
	}
	ran := 0
	for _, m := range migrations {
		var rows []struct {
			N int `json:"n"`
		}
		if err := cf.d1Query(acct, uuid, m.Check, &rows); err != nil {
			return ran, fmt.Errorf("check %s: %w", m.ID, err)
		}
		if len(rows) > 0 && rows[0].N >= 1 {
			continue // applied already (migrations.mjs: "Applied iff n >= 1")
		}
		for _, up := range m.Up {
			if err := cf.d1Query(acct, uuid, up, nil); err != nil {
				return ran, fmt.Errorf("up %s: %w", m.ID, err)
			}
		}
		ran++
	}
	return ran, nil
}

// workerMetadata builds the script-upload metadata from the shipped config,
// with every storage binding re-pointed at THIS account's ids. DO
// migrations ride only on first upload (sendMigrations): re-sending an
// already-applied tag is an error, and a `reuse` script has its tag.
func workerMetadata(cfg *WorkerConfig, kvIDs, d1IDs map[string]string, sendMigrations bool) ([]byte, error) {
	type binding map[string]any
	bindings := []binding{}
	for _, d := range cfg.D1 {
		id, ok := d1IDs[d.DatabaseName]
		if !ok {
			return nil, fmt.Errorf("no id learned for d1 %s", d.DatabaseName)
		}
		bindings = append(bindings, binding{"type": "d1", "name": d.Binding, "id": id})
	}
	for _, r := range cfg.R2 {
		bindings = append(bindings, binding{"type": "r2_bucket", "name": r.Binding, "bucket_name": r.BucketName})
	}
	for _, k := range cfg.KV {
		id, ok := kvIDs[k.Binding]
		if !ok {
			return nil, fmt.Errorf("no id learned for kv %s", k.Binding)
		}
		bindings = append(bindings, binding{"type": "kv_namespace", "name": k.Binding, "namespace_id": id})
	}
	for _, s := range cfg.Services {
		bindings = append(bindings, binding{"type": "service", "name": s.Binding, "service": s.Service})
	}
	for _, do := range cfg.DurableObjects.Bindings {
		b := binding{"type": "durable_object_namespace", "name": do.Name, "class_name": do.ClassName}
		if do.ScriptName != "" && do.ScriptName != cfg.Name {
			b["script_name"] = do.ScriptName
		}
		bindings = append(bindings, b)
	}
	for name, v := range cfg.Vars {
		if s, ok := v.(string); ok {
			bindings = append(bindings, binding{"type": "plain_text", "name": name, "text": s})
		}
	}
	meta := map[string]any{
		"main_module":        "index.js",
		"compatibility_date": cfg.CompatibilityDate,
		"bindings":           bindings,
	}
	if len(cfg.CompatibilityFlags) > 0 {
		meta["compatibility_flags"] = cfg.CompatibilityFlags
	}
	if sendMigrations && len(cfg.Migrations) > 0 {
		last := cfg.Migrations[len(cfg.Migrations)-1]
		m := map[string]any{"new_tag": last.Tag}
		var steps []map[string]any
		for _, mig := range cfg.Migrations {
			s := map[string]any{}
			if len(mig.NewSqliteClasses) > 0 {
				s["new_sqlite_classes"] = mig.NewSqliteClasses
			}
			if len(mig.NewClasses) > 0 {
				s["new_classes"] = mig.NewClasses
			}
			steps = append(steps, s)
		}
		m["steps"] = steps
		meta["migrations"] = m
	}
	return json.Marshal(meta)
}

// ---- the CF client's write half — Bearer header only, token nowhere else ----

func (c *CF) do(method, path, contentType string, body io.Reader, into any) error {
	req, err := http.NewRequest(method, c.Base+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("%s %s: %w", method, path, err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return err
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		var env cfEnvelope
		if json.Unmarshal(raw, &env) == nil && len(env.Errors) > 0 {
			return fmt.Errorf("%s %s: HTTP %d: %s", method, path, res.StatusCode, env.Errors[0].Message)
		}
		return fmt.Errorf("%s %s: HTTP %d", method, path, res.StatusCode)
	}
	if into == nil {
		return nil
	}
	var env cfEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return fmt.Errorf("%s %s: not a Cloudflare envelope: %w", method, path, err)
	}
	if !env.Success {
		msg := "unknown error"
		if len(env.Errors) > 0 {
			msg = env.Errors[0].Message
		}
		return fmt.Errorf("%s %s: %s", method, path, msg)
	}
	return json.Unmarshal(env.Result, into)
}

func (c *CF) postJSON(path string, body, into any) error {
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	return c.do(http.MethodPost, path, "application/json", bytes.NewReader(b), into)
}

func (c *CF) putJSON(path string, body, into any) error {
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	return c.do(http.MethodPut, path, "application/json", bytes.NewReader(b), into)
}

// d1Query runs sql (multiple ;-separated statements are supported by the
// endpoint) against one database. `into` receives the FIRST result set's
// rows, which is all any caller here reads.
func (c *CF) d1Query(acct, uuid, sql string, into any) error {
	var results []struct {
		Results json.RawMessage `json:"results"`
	}
	if err := c.postJSON("/accounts/"+acct+"/d1/database/"+uuid+"/query",
		map[string]string{"sql": sql}, &results); err != nil {
		return err
	}
	if into == nil || len(results) == 0 {
		return nil
	}
	return json.Unmarshal(results[0].Results, into)
}

// putWorker uploads one module script: multipart metadata + the bundle,
// the same wire shape wrangler uses.
func (c *CF) putWorker(acct, name string, metadata, bundle []byte) error {
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	mh := textproto.MIMEHeader{}
	mh.Set("Content-Disposition", `form-data; name="metadata"; filename="metadata.json"`)
	mh.Set("Content-Type", "application/json")
	part, err := w.CreatePart(mh)
	if err != nil {
		return err
	}
	if _, err := part.Write(metadata); err != nil {
		return err
	}
	bh := textproto.MIMEHeader{}
	bh.Set("Content-Disposition", `form-data; name="index.js"; filename="index.js"`)
	bh.Set("Content-Type", "application/javascript+module")
	part, err = w.CreatePart(bh)
	if err != nil {
		return err
	}
	if _, err := part.Write(bundle); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return c.do(http.MethodPut, "/accounts/"+acct+"/workers/scripts/"+name,
		w.FormDataContentType(), &buf, &json.RawMessage{})
}

func (c *CF) putSecret(acct, script, name, value string) error {
	return c.putJSON("/accounts/"+acct+"/workers/scripts/"+script+"/secrets",
		map[string]string{"name": name, "text": value, "type": "secret_text"}, &json.RawMessage{})
}

// WorkersSubdomain answers the account's workers.dev subdomain, "" when the
// account never claimed one — the hand-off refuses to invent a name (a
// subdomain is account-visible branding; claiming one is the operator's
// choice, made once, in the dashboard).
func (c *CF) WorkersSubdomain(acct string) (string, error) {
	var out struct {
		Subdomain string `json:"subdomain"`
	}
	if err := c.getJSON("/accounts/"+acct+"/workers/subdomain", &out); err != nil {
		return "", err
	}
	return out.Subdomain, nil
}
