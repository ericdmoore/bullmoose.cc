package cloud

// The published stack, read back. infra/stackBundle.mjs writes what this
// file reads; the two are the same contract seen from either end of
// dl.bullmoose.cc. The manifest's own trust is HTTPS; every file it NAMES is
// then verified against the sha256 the manifest carries, so a torn upload or
// a tampered mirror fails loudly at fetch, not silently at apply.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// DefaultStackBase is where releases publish (release-stack.yml).
const DefaultStackBase = "https://dl.bullmoose.cc/stack"

// Manifest mirrors stackBundle.mjs's buildManifest output. Fields the plan
// does not read (files it never fetches) are still listed so a checksum
// exists for everything; `Secrets` arrived with s46 T2a, so a manifest
// published before it simply decodes with empty maps.
type Manifest struct {
	ManifestVersion int      `json:"manifestVersion"`
	Version         string   `json:"version"`
	GitSHA          string   `json:"gitSha"`
	DeployOrder     []string `json:"deployOrder"`
	Workers         []struct {
		Name   string `json:"name"`
		Bundle string `json:"bundle"`
		Config string `json:"config"`
	} `json:"workers"`
	Schema     []string `json:"schema"`
	Migrations struct {
		File  string `json:"file"`
		Count int    `json:"count"`
	} `json:"migrations"`
	Secrets struct {
		Generated map[string]struct {
			Bytes   int      `json:"bytes"`
			Workers []string `json:"workers"`
		} `json:"generated"`
		External map[string]struct {
			Workers  []string `json:"workers"`
			Required bool     `json:"required"`
			Note     string   `json:"note"`
		} `json:"external"`
	} `json:"secrets"`
	Webmail string            `json:"webmail"`
	Files   map[string]string `json:"files"`
}

// Stack is a fetched, verified slice of one published version: the manifest
// plus every worker config, parsed. Bundles and the webmail tarball are NOT
// fetched here — the plan needs shapes, not megabytes; apply (T3) fetches
// the heavy files with the same per-file verification.
type Stack struct {
	Manifest Manifest
	Configs  map[string]*WorkerConfig // by worker name, every deployOrder entry present
}

// Fetcher downloads one published stack version. Zero value is not usable;
// use NewFetcher.
type Fetcher struct {
	Base string
	HTTP *http.Client
}

func NewFetcher(base string, client *http.Client) *Fetcher {
	if base == "" {
		base = DefaultStackBase
	}
	if client == nil {
		client = http.DefaultClient
	}
	return &Fetcher{Base: strings.TrimSuffix(base, "/"), HTTP: client}
}

func (f *Fetcher) get(path string) ([]byte, error) {
	url := f.Base + "/" + path
	res, err := f.HTTP.Get(url)
	if err != nil {
		return nil, fmt.Errorf("fetch %s: %w", url, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch %s: HTTP %d", url, res.StatusCode)
	}
	return io.ReadAll(res.Body)
}

// Latest resolves the version the mirror currently points at.
func (f *Fetcher) Latest() (string, error) {
	b, err := f.get("latest.txt")
	if err != nil {
		return "", err
	}
	v := strings.TrimSpace(string(b))
	if v == "" {
		return "", fmt.Errorf("latest.txt is empty — the mirror has never published")
	}
	return v, nil
}

// Fetch downloads and verifies the manifest and every worker config for
// `version` (empty = whatever latest.txt says).
func (f *Fetcher) Fetch(version string) (*Stack, error) {
	if version == "" {
		v, err := f.Latest()
		if err != nil {
			return nil, err
		}
		version = v
	}
	raw, err := f.get(version + "/manifest.json")
	if err != nil {
		return nil, err
	}
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("manifest.json did not parse: %w", err)
	}
	if len(m.DeployOrder) == 0 {
		return nil, fmt.Errorf("manifest has an empty deployOrder — refusing to plan nothing")
	}

	st := &Stack{Manifest: m, Configs: make(map[string]*WorkerConfig, len(m.DeployOrder))}
	for _, w := range m.Workers {
		body, err := f.get(version + "/" + w.Config)
		if err != nil {
			return nil, err
		}
		want, ok := m.Files[w.Config]
		if !ok {
			return nil, fmt.Errorf("%s: the manifest carries no checksum for it", w.Config)
		}
		got := sha256.Sum256(body)
		if hex.EncodeToString(got[:]) != want {
			return nil, fmt.Errorf("%s: sha256 mismatch against the manifest — torn upload or tampered mirror", w.Config)
		}
		cfg, err := ParseConfig(body)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", w.Config, err)
		}
		st.Configs[w.Name] = cfg
	}
	for _, name := range m.DeployOrder {
		if _, ok := st.Configs[name]; !ok {
			return nil, fmt.Errorf("deployOrder names %q but the manifest ships no config for it", name)
		}
	}
	return st, nil
}
