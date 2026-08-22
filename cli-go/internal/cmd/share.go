package cmd

// `bullmoose share` — list and revoke the expiring public links this account
// has minted. The first port under s42's rules (equivalence, not imitation):
// the REST choreography, the refusal costs, the exit codes and the
// --json/--ids/--dry-run semantics are the TypeScript's exactly; the code
// SHAPE is Go's, and the one behavioural divergence is recorded below.
//
// ## What a share IS, and why revoke has a note
//
// A share link is a PUBLIC capability for a full-fidelity blob. Listing them
// answers "what did I leave open"; revoking one closes it. The revoke's
// server note is printed verbatim because it carries an eventual-consistency
// fact (KV, ~60s to every edge) that a human who reloads instantly needs, or
// they will conclude the revoke failed and mash it again.
//
// ## The one divergence (s42)
//
// The TypeScript prints times by string-slicing ISO timestamps
// (`expiresAt.slice(0, 10)`). This port parses and formats them — same
// rendered output for valid timestamps, but a malformed one from the server
// prints as itself rather than as its first ten bytes. Parse-back over
// byte-faith, applied to input as well as output.

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	bmio "github.com/ericdmoore/bullmoose.cc/cli-go/internal/io"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/jmap"
	"github.com/ericdmoore/bullmoose.cc/cli-go/internal/store"
)

func runShare(s *bmio.Streams, argv []string) int {
	a := parse(argv)
	sub := a.at(1)

	// Refusals cost zero requests — validated before any client exists.
	if sub != "list" && sub != "revoke" {
		noneWord := sub
		if noneWord == "" {
			noneWord = "(none)"
		}
		s.Note("usage: unknown share subcommand: " + noneWord + " (list|revoke)")
		return 2
	}
	if sub == "revoke" && a.at(2) == "" {
		s.Note("usage: bullmoose share revoke <shareId> [--account <sel>] [--dry-run]")
		return 2
	}

	db, err := store.Open(store.DBPath(a.DB))
	if err != nil {
		return die(s, err)
	}
	defer db.Close()
	settings, err := store.RequireSettings(db)
	if err != nil {
		return die(s, err)
	}
	acc, err := resolveAccount(settings, a.Account)
	if err != nil {
		return die(s, err)
	}
	accountID := acc.AccountID
	client := jmap.NewSessionClient(settings.Base, settings.Token)
	ctx := context.Background()

	switch sub {
	case "list":
		res, err := client.ListShares(ctx, accountID)
		if err != nil {
			return die(s, err)
		}
		live := 0
		for _, sh := range res.Shares {
			if sh.Live {
				live++
			}
		}
		if a.IDs {
			ids := make([]string, 0, len(res.Shares))
			for _, sh := range res.Shares {
				ids = append(ids, sh.ShareID)
			}
			s.EmitIDs(ids)
			return 0
		}
		if a.JSON {
			rows := make([]any, 0, len(res.Shares))
			for _, sh := range res.Shares {
				rows = append(rows, struct {
					AccountID string `json:"accountId"`
					jmap.ShareEntry
				}{accountID, sh})
			}
			if err := s.EmitNDJSON(rows); err != nil {
				return die(s, err)
			}
			s.Note(fmt.Sprintf("%d live, %d revoked or expired", live, len(res.Shares)-live))
			return 0
		}
		s.Out(renderShares(res.Shares))
		s.Note(fmt.Sprintf("\n  %d live, %d revoked or expired", live, len(res.Shares)-live))
		return 0

	default: // revoke — the subcommand set was validated above
		shareID := a.at(2)
		if a.DryRun {
			s.Note("dry run: would revoke share " + shareID + "; the link still resolves")
			if a.JSON {
				if err := s.EmitJSON(map[string]any{"dryRun": true, "shareId": shareID}); err != nil {
					return die(s, err)
				}
			}
			return 0
		}
		res, err := client.RevokeShare(ctx, accountID, shareID)
		if err != nil {
			return die(s, err)
		}
		if a.JSON {
			if err := s.EmitJSON(res); err != nil {
				return die(s, err)
			}
			return 0
		}
		if res.AlreadyRevoked {
			s.Out(shareID + " was already revoked")
		} else {
			s.Out("revoked " + shareID)
		}
		s.Note("  " + res.Note)
		return 0
	}
}

// renderShares: live links first, the state word BEFORE the id — someone
// running this is looking for what is still open, and the eye scans the left
// column. (blobs.ts:143's reasoning, kept on purpose; s42 licenses divergence,
// it does not require it.)
func renderShares(shares []jmap.ShareEntry) string {
	if len(shares) == 0 {
		return "  (no share links)"
	}
	sorted := append([]jmap.ShareEntry(nil), shares...)
	sort.SliceStable(sorted, func(i, j int) bool {
		ri, rj := rankShare(sorted[i]), rankShare(sorted[j])
		if ri != rj {
			return ri < rj
		}
		return sorted[i].CreatedAt > sorted[j].CreatedAt
	})
	lines := make([]string, 0, len(sorted))
	for _, sh := range sorted {
		state := "expired"
		switch {
		case sh.Live:
			state = "live   "
		case sh.RevokedAt != "":
			state = "revoked"
		}
		lines = append(lines, "  "+state+"  "+sh.ShareID+"  "+sh.Name+"  expires "+dateOnly(sh.ExpiresAt))
	}
	return strings.Join(lines, "\n")
}

func rankShare(s jmap.ShareEntry) int {
	if s.Live {
		return 0
	}
	return 1
}

// dateOnly parses rather than slices — the s42 divergence. A valid RFC 3339
// timestamp renders as its date, exactly as slice(0,10) did; a malformed one
// renders as ITSELF, which is more honest than its first ten bytes.
func dateOnly(iso string) string {
	if t, err := time.Parse(time.RFC3339, iso); err == nil {
		return t.Format("2006-01-02")
	}
	return iso
}
