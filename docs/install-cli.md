# Installing the bullmoose CLI

One static Go binary, no runtime, no toolchain.

## The one-liner

```sh
curl -fsSL https://dl.bullmoose.cc/cli/install.sh | sh
```

It detects your platform, reads the current version from
`dl.bullmoose.cc/cli/latest.txt`, downloads the matching build, **verifies its
checksum, and installs nothing if that fails** — an unverified binary is not
"probably fine". Then it places `bullmoose` in `~/bin` and prints what to run
next.

It changes nothing else. No service, no config file, no shell profile: if
`~/bin` is not on your PATH it prints the line to add and lets you add it. (A
tool that edits your `~/.zshrc` during an install has done something you did
not ask for. Compare `dl.bullmoose.cc/popcorn/install.sh`, which *does* ask one
y/N — because it writes a service unit and restarts a daemon, and none of that
is implied by piping a URL to a shell.)

Options, after `sh -s --`:

| flag | |
|---|---|
| `--version vX.Y.Z` | install a specific release instead of latest |
| `--bin-dir DIR` | somewhere other than `~/bin` |

```sh
curl -fsSL https://dl.bullmoose.cc/cli/install.sh | sh -s -- --bin-dir ~/.local/bin
```

Confirm what you got — the binary names its own build:

```sh
bullmoose version
# bullmoose v0.3.0 darwin/arm64 go1.26.7 9fa3dc96c31b
```

Then continue at [`install-cloud.md`](install-cloud.md): one Cloudflare API
token and `bullmoose cloud plan --zone your-domain.com`.

## Downloading a release by hand

The installer is a convenience over files you can fetch yourself. Everything
lives under `https://dl.bullmoose.cc/cli/<version>/`, and the same artifacts are
attached to each [GitHub release](https://github.com/ericdmoore/bullmoose.cc/releases).

Pick the artifact for your platform:

| platform | artifact |
|---|---|
| macOS (Apple silicon) | `bullmoose_<version>_darwin_arm64` |
| macOS (Intel) | `bullmoose_<version>_darwin_amd64` |
| Linux (arm64) | `bullmoose_<version>_linux_arm64` |
| Linux (x86-64) | `bullmoose_<version>_linux_amd64` |
| Windows (x86-64) | `bullmoose_<version>_windows_amd64.exe` |

Then verify, rename, and put it on your PATH — for example, macOS on Apple
silicon. Note `V` is read from `latest.txt` rather than pinned here, so these
instructions cannot go stale the way a hardcoded version does:

```sh
V=$(curl -fsSL https://dl.bullmoose.cc/cli/latest.txt)
curl -fsSLO "https://dl.bullmoose.cc/cli/$V/bullmoose_${V}_darwin_arm64"
curl -fsSLO "https://dl.bullmoose.cc/cli/$V/checksums.txt"
shasum -a 256 --check --ignore-missing checksums.txt   # must say OK
chmod +x "bullmoose_${V}_darwin_arm64"
mv "bullmoose_${V}_darwin_arm64" ~/bin/bullmoose
```

From the GitHub releases page instead, the URLs embed the full tag, so the `/`
in `cli-go/v0.3.0` is URL-encoded as `%2F`:
`.../releases/download/cli-go%2F$V/bullmoose_${V}_darwin_arm64`.

On **macOS**, releases are not (yet) notarized. A binary downloaded by a
*browser* is quarantined by Gatekeeper and will refuse to run with "cannot be
opened because the developer cannot be verified" — which reads like a broken
download. Clear it once:

```sh
xattr -d com.apple.quarantine ~/bin/bullmoose
```

(`curl` does not normally set that attribute, and the installer above clears it
regardless — this is for the browser path.)

## Build from source

Any Go ≥ the `toolchain` pin in `cli-go/go.mod` (GOTOOLCHAIN fetches the exact
one automatically):

```sh
git clone https://github.com/ericdmoore/bullmoose.cc
cd bullmoose.cc/cli-go
go build -trimpath -o ~/bin/bullmoose .
```

A source build reports `dev` plus its commit from the VCS stamp — so a support
conversation can still pin it to a tree.

## Nothing needs Node

Since `cli-go/v0.2.0` every help-listed command — login, send, read, sync,
watch, admin, `agent serve` and all — runs from the one static binary. The
Node CLI that this binary strangler-replaced was removed from the repository
on 2026-08-22 (`.plans/s08-go-cli`); there is no delegation, no `node` on the
PATH required, and no second implementation to disagree with this one.
