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
// than duplicated here. A ported command's owned FLAGS arrive alongside it,
// through RegisterFlags, from the same registry entry.
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

// flagSet is one command's owned flags: the value-taking, the boolean, and the
// short options its NATIVE implementation reads.
type flagSet struct {
	value   map[string]bool
	boolean map[string]bool
	short   map[string]bool
}

// owned maps command → the flags that command's native implementation consumes.
// Populated by RegisterFlags from cmd's registry, so the guard and the
// implementations cannot drift apart.
var owned = map[string]flagSet{}

// RegisterFlags records one command's owned flag set. Called by cmd.Install
// beside Register, from the same registry entry, so a command that grows a flag
// grows its guard in the same edit.
func RegisterFlags(command string, value, boolean, short []string) {
	owned[command] = flagSet{value: set(value), boolean: set(boolean), short: set(short)}
}

func set(names []string) map[string]bool {
	m := make(map[string]bool, len(names))
	for _, n := range names {
		m[n] = true
	}
	return m
}

// defaultOwned is the fallback for a command with no registered set. It is only
// reachable for a command that has no native handler either — where Dispatch
// delegates regardless, so the answer is moot — and for this package's own
// tests. It keeps the wave-1 vocabulary so those cases read as they always did.
var defaultOwned = flagSet{
	value:   map[string]bool{"db": true, "account": true, "mailbox": true, "n": true},
	boolean: map[string]bool{"json": true, "ids": true},
	short:   map[string]bool{"n": true}, // -h is deliberately absent: help delegates
}

// ownedNatively reports whether every flag in argv is one the NAMED command's
// native implementation understands. A `--` ends option scanning (the rest are
// positionals); a bare positional, including "-", is always fine. Any other long
// or short flag — `--help`, `-h`, an unknown flag, or a flag that belongs to
// another command — makes this false, so Dispatch delegates and Node owns the
// outcome.
//
// Under-inclusion is the safe direction: it only over-delegates, and Node
// produces identical bytes for a delegated command. Over-inclusion would run a
// native path that silently ignores a flag the user typed — which on `send` means
// mail leaving under the wrong assumptions.
func ownedNatively(argv []string) bool {
	flags, ok := owned[Command(argv)]
	if !ok {
		flags = defaultOwned
	}
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		switch {
		case arg == "--":
			return true
		case strings.HasPrefix(arg, "--"):
			name, _, inline := strings.Cut(strings.TrimPrefix(arg, "--"), "=")
			switch {
			case flags.value[name]:
				if !inline {
					i++ // consume the value token so it is not read as a flag
				}
			case flags.boolean[name]:
				// owned boolean, nothing to consume
			default:
				return false
			}
		case len(arg) > 1 && strings.HasPrefix(arg, "-"):
			if flags.short[strings.TrimPrefix(arg, "-")] {
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
