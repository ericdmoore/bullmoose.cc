package delegate

import "strings"

// Native registration and the guard that decides whether an invocation is one
// the native (T6) commands fully own.
//
// The point of the guard: a native command reproduces only its own happy path
// and the error paths the contract exercises. The full flag grammar and the help
// system (packages/cli/src/help.ts) stay in TypeScript for now, so any
// invocation carrying `--help`/`-h` or a flag the native commands do not consume
// is handed to Node — which produces those bytes exactly. That keeps the port
// byte-identical on paths it has not ported, instead of approximating them.

// Register adds one native command handler. main.go calls it (via cmd.Install)
// before Dispatch, so the routing map is populated from cmd's registry rather
// than duplicated here.
func Register(command string, run func(argv []string) int) {
	native[command] = run
}

// nativeOnly names the native commands that have NO TypeScript twin, so Dispatch
// must never delegate them (Node has no such command) and the ownedNatively
// byte-identity guard does not apply to them. Populated by RegisterNativeOnly
// from cmd's registry.
var nativeOnly = map[string]bool{}

// RegisterNativeOnly marks a command as Go-native-only — see Dispatch. `approvals`
// (s08) is the first: a server-backed decision surface the Node CLI never had.
func RegisterNativeOnly(command string) {
	nativeOnly[command] = true
}

// ownedValueFlags: the value-taking flags the wave-1 native commands consume
// (main.ts:64-163). Deliberately a SUBSET of the full parseArgs spec — under-
// inclusion only over-delegates, and Node produces identical bytes for a
// delegated command, whereas over-inclusion would run native on a flag Node
// rejects. Kept in lockstep with cmd.ownedValue.
var ownedValueFlags = map[string]bool{
	"db": true, "account": true, "mailbox": true, "n": true,
}

// ownedBoolFlags: the boolean flags the wave-1 commands consume.
var ownedBoolFlags = map[string]bool{"json": true, "ids": true}

// ownedShortFlags: -n is the only short option these commands read. -h (help) is
// deliberately absent, so a `-h` invocation delegates to Node's help.
var ownedShortFlags = map[string]bool{"n": true}

// ownedNatively reports whether every flag in argv is one the native commands
// understand. A `--` ends option scanning (the rest are positionals); a bare
// positional, including "-", is always fine. Any other long or short flag —
// `--help`, `-h`, an unknown flag, or a known-but-unowned one like `--force` —
// makes this false, so Dispatch delegates and Node owns the outcome.
func ownedNatively(argv []string) bool {
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		switch {
		case arg == "--":
			return true
		case strings.HasPrefix(arg, "--"):
			name, _, inline := strings.Cut(strings.TrimPrefix(arg, "--"), "=")
			switch {
			case ownedValueFlags[name]:
				if !inline {
					i++ // consume the value token so it is not read as a flag
				}
			case ownedBoolFlags[name]:
				// owned boolean, nothing to consume
			default:
				return false
			}
		case len(arg) > 1 && strings.HasPrefix(arg, "-"):
			if ownedShortFlags[strings.TrimPrefix(arg, "-")] {
				i++ // -n VALUE
			} else {
				return false
			}
		default:
			// positional (incl. bare "-")
		}
	}
	return true
}
