// Package cloud is s46 — the CLI as a CREATOR of a bullmoose deployment,
// not just an operator of one. This file reads the wrangler.jsonc dialect:
// the stack bundle ships each worker's config VERBATIM (one dialect, no
// translation layer to drift), so the planner must read JSONC — JSON plus
// comments plus trailing commas — and nothing more of it than the plan
// needs.
package cloud

import (
	"encoding/json"
	"fmt"
)

// StripJSONC returns src with // and /* */ comments and trailing commas
// removed, string-aware: a "//" inside a string literal (every https:// URL)
// is content, not a comment. Two passes, deliberately — a trailing comma is
// only recognizable AFTER comments are gone (`, // note` then `}` is a
// trailing comma with a comment in the middle, and a single pass reaches
// the comma before it has stripped the comment). Offsets are not preserved;
// the output is for json.Unmarshal, not for error positions.
func StripJSONC(src []byte) []byte {
	return stripTrailingCommas(stripComments(src))
}

func stripComments(src []byte) []byte {
	out := make([]byte, 0, len(src))
	inString := false
	for i := 0; i < len(src); i++ {
		c := src[i]
		switch {
		case inString:
			out = append(out, c)
			if c == '\\' && i+1 < len(src) {
				out = append(out, src[i+1])
				i++
			} else if c == '"' {
				inString = false
			}
		case c == '"':
			inString = true
			out = append(out, c)
		case c == '/' && i+1 < len(src) && src[i+1] == '/':
			for i < len(src) && src[i] != '\n' {
				i++
			}
			if i < len(src) {
				out = append(out, '\n') // keep line structure for saner JSON errors
			}
		case c == '/' && i+1 < len(src) && src[i+1] == '*':
			i += 2
			for i+1 < len(src) && !(src[i] == '*' && src[i+1] == '/') {
				i++
			}
			i++ // past the '/'
		default:
			out = append(out, c)
		}
	}
	return out
}

func stripTrailingCommas(src []byte) []byte {
	out := make([]byte, 0, len(src))
	inString := false
	for i := 0; i < len(src); i++ {
		c := src[i]
		switch {
		case inString:
			out = append(out, c)
			if c == '\\' && i+1 < len(src) {
				out = append(out, src[i+1])
				i++
			} else if c == '"' {
				inString = false
			}
		case c == '"':
			inString = true
			out = append(out, c)
		case c == ',':
			j := i + 1
			for j < len(src) && (src[j] == ' ' || src[j] == '\t' || src[j] == '\n' || src[j] == '\r') {
				j++
			}
			if j < len(src) && (src[j] == ']' || src[j] == '}') {
				continue // trailing — drop it, keep the whitespace that follows
			}
			out = append(out, c)
		default:
			out = append(out, c)
		}
	}
	return out
}

// Route is one entry of a config's `routes`. Wrangler accepts both a bare
// pattern string and the object form; both arrive here as the object.
type Route struct {
	Pattern      string `json:"pattern"`
	ZoneName     string `json:"zone_name"`
	CustomDomain bool   `json:"custom_domain"`
}

func (r *Route) UnmarshalJSON(b []byte) error {
	if len(b) > 0 && b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		*r = Route{Pattern: s}
		return nil
	}
	type plain Route // avoid recursing into this method
	var p plain
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*r = Route(p)
	return nil
}

// WorkerConfig is the subset of a wrangler config the plan reads. Resource
// IDS are deliberately not here (kv `id`, d1 `database_id`): they name
// resources in the account the stack was BUILT against; an install creates
// its own and learns fresh ids at apply. Binding NAMES are the contract.
type WorkerConfig struct {
	Name               string   `json:"name"`
	Main               string   `json:"main"`
	CompatibilityDate  string   `json:"compatibility_date"`
	CompatibilityFlags []string `json:"compatibility_flags"`
	Routes             []Route  `json:"routes"`
	D1                 []struct {
		Binding      string `json:"binding"`
		DatabaseName string `json:"database_name"`
	} `json:"d1_databases"`
	R2 []struct {
		Binding    string `json:"binding"`
		BucketName string `json:"bucket_name"`
	} `json:"r2_buckets"`
	KV []struct {
		Binding string `json:"binding"`
	} `json:"kv_namespaces"`
	Services []struct {
		Binding string `json:"binding"`
		Service string `json:"service"`
	} `json:"services"`
	DurableObjects struct {
		Bindings []struct {
			Name       string `json:"name"`
			ClassName  string `json:"class_name"`
			ScriptName string `json:"script_name"`
		} `json:"bindings"`
	} `json:"durable_objects"`
	Vars map[string]any `json:"vars"`
}

// ParseConfig reads one shipped wrangler.jsonc. A config with no `name` is
// refused: every downstream decision keys on it.
func ParseConfig(src []byte) (*WorkerConfig, error) {
	var c WorkerConfig
	if err := json.Unmarshal(StripJSONC(src), &c); err != nil {
		return nil, fmt.Errorf("wrangler config did not parse as JSONC: %w", err)
	}
	if c.Name == "" {
		return nil, fmt.Errorf("wrangler config has no `name`")
	}
	return &c, nil
}
