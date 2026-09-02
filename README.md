# Switchboard

Switchboard is a compact Omarchy shell plugin for the `ai-usagebar` fork. Its
native bar item and glanceable dashboard show Claude accounts, other configured
agents, relative resets, and safe account controls. The plugin shares no QML
with AI Usage Bar.

![Switchboard panel](preview.png)

## Requirements

Switchboard is a frontend for a pinned, hash-verified release of the `ai-usagebar`
**fork** (flat Claude account management: save, switch, rename, marker-trusted
resync, and the report fields this plugin renders). The plugin only ever
executes the backend from one trusted location, after verifying it:

```bash
mkdir -p ~/.local/share/switchboard/backend
cd ~/.local/share/switchboard/backend
tag=v1.9.1-whkey.3
curl -fsSLO https://github.com/leonaffi-byte/ai-usagebar/releases/download/$tag/ai-usagebar-x86_64-unknown-linux-gnu
curl -fsSLO https://github.com/leonaffi-byte/ai-usagebar/releases/download/$tag/SHA256SUMS
sha256sum -c SHA256SUMS          # must print: ai-usagebar-x86_64-unknown-linux-gnu: OK
gh attestation verify ai-usagebar-x86_64-unknown-linux-gnu --repo leonaffi-byte/ai-usagebar   # optional: signed provenance
install -m 0755 ai-usagebar-x86_64-unknown-linux-gnu ai-usagebar
```

Expected SHA-256 of the release binary (also embedded in the plugin):
`b2134dc1a9bc8ef899d7da63f880fc05268bc05ca0f1fe306f4a11bae35b61ad`

The release is built by GitHub Actions from the exact tagged commit
(`34a9fd4df62231264ccbb97af116dbdf5edcc9cd`, tag `v1.9.1-whkey.3`) with the toolchain pinned in
`rust-toolchain.toml` (Rust 1.98.0), `cargo build --release --locked`, remapped
paths and no incremental compilation. Two independent runners must produce a
byte-identical binary before anything is published, and a signed GitHub build
provenance attestation ties the asset digest to that commit — see
[Backend provenance and audit guide](#backend-provenance-and-audit-guide).
Building the backend yourself is supported only through the developer override
described under [Trusted execution](#trusted-execution).

The fork auto-enables Kimi and SuperGrok when their CLI logins exist (set
`enabled = false` in `~/.config/ai-usagebar/config.toml` to opt out), and
providers that merely lack an API key are hidden from the dashboard until a key
is added on the settings page.

## Install

```bash
omarchy plugin add https://github.com/leonaffi-byte/switchboard --enable
```

## Remove

```bash
omarchy plugin remove leoom.switchboard
```

Removal deletes the plugin folder and its bar entry. Switchboard stores no data
of its own: usage caches and credentials belong to the `ai-usagebar` backend
(`~/.cache/ai-usagebar`, `~/.claude`, `~/.config/ai-usagebar/config.toml`).

The bar widget defaults to a five-minute refresh, a single Claude
glyph-and-percent segment, auto-switch off, an 85% threshold, and usage alerts
off. Its `barShows` setting has three modes: `claude` shows Claude only, `all`
shows up to four agent families with percentages, and `icon` shows up to four
glyphs only. Existing `iconpct` and `full` values migrate to `all`. Left-click
opens the dashboard; middle-click requests an immediate refresh. Scrolling has
no action. The tooltip retains status for up to six families in every mode.

## Screenshots

Version 2.0 replaces the former oversized pill and panel with the shell's
native bar button and compact panel controls. Screenshots should be captured
with the active Omarchy theme because all spacing, typography, surfaces, and
colors come directly from that theme.

## Dashboard

The dashboard is one screen with these sections:

- `CLAUDE`: one compact line and meter per account. Only the active row adds a
  caption with its 5-hour and 7-day windows and relative reset times. An
  unmanaged default login gets a validated inline Save field. Rows backed by a
  saved account offer an inline rename (pencil, validated, Esc cancels), and a
  one-line hint explains how to add a second account until two exist.
- `AGENTS`: one line and meter per other agent. Metric details move to row
  tooltips; key failures become a compact `needs key →` link into settings.
- `AUTO-SWITCH`: a persistent toggle, a live explanation naming the active
  account, and the most recent switch or failure when one exists. The threshold
  is edited in settings.
- A one-line status strip for active work, a missing backend, or the newest
  action error.

The gear button swaps the dashboard for a settings page. It provides native
controls for bar mode, 60–3600 second refresh cadence in 30-second steps, usage
alerts, auto-switch, and its 50–95% threshold. The Provider Keys section uses
the backend's write-only settings bridge: existing values are never loaded into
the shell, blank fields mean unchanged, and only the explicit clear button
removes an inline key. Environment-only keys identify their environment and
cannot be cleared here. Claude, Codex, Cursor, and Kiro continue to authenticate
through their own CLIs.

## Auto-switch semantics

Auto-switch is evaluated once after each successfully parsed report. It
only acts when the active Claude account has a ready, non-cached 5-hour value at
or above the configured threshold. An unsaved default login prevents automatic
switching.

Eligible destinations must be saved, explicitly switchable accounts with ready,
non-cached data and a 5-hour value at least 10 points below the threshold. The
lowest-usage account wins; equal values are ordered by account label. Every
successful manual or automatic switch starts one shared 10-minute cooldown.
An automatic refusal also starts the cooldown so a backend safety guard is not
hammered. Switchboard never passes `--force`.

Automatic success triggers one desktop notification and a report refresh. The
last automatic success or failure remains in the card for the shell session;
turning auto-switch off only changes the displayed state to `off`.

## Threshold alerts

The optional `alerts` setting watches each ready entry's primary window. It
sends one desktop notification when that window reaches 75% and one when it
reaches 90%. Each level stays quiet while usage remains above its threshold and
re-arms only after that same entry and window drops below the level, such as
after a reset. Alert state lasts for the current shell session and is independent
of auto-switch.

## IPC and keybinding

The service exposes:

```bash
omarchy-shell leoom.switchboard toggle
omarchy-shell leoom.switchboard refresh
omarchy-shell leoom.switchboard toggleAccount
omarchy-shell leoom.switchboard status
omarchy-shell leoom.switchboard settings
```

`toggleAccount` runs the backend's guarded manual account toggle regardless of
the auto-switch setting. Like every shell IPC method, it is reachable by any
process running as your user — the same trust boundary as running the backend
CLI yourself. For a Hyprland shortcut, add:

```ini
bind = CTRL ALT SHIFT, S, exec, omarchy-shell leoom.switchboard toggleAccount
```

Busy `refresh` and `toggleAccount` IPC calls return `busy`; panel toggling and
the last-known compact status line remain available.

## Backend provenance and audit guide

Switchboard's install instructions pin the backend to one immutable commit so
that what a reviewer audits is what users execute.

- **Pinned revision:** `34a9fd4df62231264ccbb97af116dbdf5edcc9cd` (annotated tag `v1.9.1-whkey.3` on
  https://github.com/leonaffi-byte/ai-usagebar).
- **Reproducible build:** `.github/workflows/plugin-backend-release.yml` builds the
  tagged commit on two independent `ubuntu-24.04` runners with the toolchain pinned
  by `rust-toolchain.toml` (Rust 1.98.0), `cargo build --release --locked`,
  `--remap-path-prefix` for the workspace, cargo home and rustup home,
  `CARGO_INCREMENTAL=0`, `SOURCE_DATE_EPOCH=0`; the release is published only if
  both binaries are byte-identical. `BUILD-INFO.txt` in the release records the
  commit, toolchain and flags. To reproduce elsewhere, run the same steps in an
  `ubuntu:24.04` container with the checkout at `/home/runner/work/ai-usagebar/ai-usagebar`.
- **Signed attestation:** `actions/attest-build-provenance` signs the asset digest
  for that commit; verify with
  `gh attestation verify ai-usagebar-x86_64-unknown-linux-gnu --repo leonaffi-byte/ai-usagebar`.
- **Release artifact:** `v1.9.1-whkey.3` ships the binary the plugin executes plus
  `SHA256SUMS` and `BUILD-INFO.txt`; the plugin embeds that SHA-256 and verifies the
  file before every execution.
- **Update policy:** the pin and the embedded hash only change through a new
  Switchboard commit; the plugin never fetches, updates, or executes any other
  source.
- **Verify what you installed:** `sha256sum ~/.local/share/switchboard/backend/ai-usagebar`
  must print the digest above.

All file references below are at the pinned revision.

### Credential-file safety (`src/anthropic/flat_accounts.rs`)

Saved accounts live in `~/.claude/accounts/<label>.credentials.json` with an
`active.txt` marker; the live login is `~/.claude/.credentials.json`.

- Every mutation runs under an exclusive `flock` on `.switch.lock` (line 22)
  and validates the target before touching anything (`preflight_target`,
  line 509; labels must match `[a-z0-9_-]{1,32}` and pass the config validator).
- `switch_under_lock` (line 250) is journaled: it writes `.switch.journal`
  (lines 21, 48 — hashes only, never tokens), re-saves the outgoing login into
  its slot, installs the target, updates the marker, then removes the journal.
- Every write is atomic (temp file + rename) with mode `0600`
  (`atomic_write_private`, line 745); directories are created `0700`
  (`create_private_dir`, line 734).
- Guards refuse to overwrite an unmanaged live login or a slot whose credential
  lineage does not match (`--force` is never passed by the plugin).

### Locking and rollback

- `recover_under_lock` (line 383) resolves an interrupted switch on the next
  mutation: live matches the target → finish; live still matches the outgoing
  slot → discard the journal; anything else → refuse and tell the user.
- `account switch --dry-run` (`validate_switch`, line 453) runs the same
  checks read-only.
- Marker-trusted resync (line 360) rewrites only the marker's own slot from the
  live file, under the same lock, and only when the live credential matches no
  other saved account.

### Stdin-only secrets (`src/tui/settings.rs`)

- `settings apply` reads its JSON patch exclusively from stdin (lines 783–799)
  and prints `{"ok":true}`; keys never appear in argv, logs, or `settings show`.
- The config file is rewritten atomically and set to `0600` (lines 498–499).
- On the plugin side, `Service.qml` writes the patch to the process's stdin on
  start and immediately clears it from QML memory; key fields are
  `password: true` and blank means unchanged.

### Trusted execution

The backend runs only from `~/.local/share/switchboard/backend/ai-usagebar`.
There is no `PATH` search and no environment override. Before every invocation
the wrapper (`backendCommand` in `Model.js`, absolute tool paths only:
`/usr/bin/bash`, `/usr/bin/timeout`, `/usr/bin/head`, `/usr/bin/stat`,
`/usr/bin/sha256sum`, `/usr/bin/id`):

1. rejects a symlink at the path and any non-absolute path;
2. opens the file once (`exec 9<`), then validates **that descriptor**: regular
   file, owned by the current user or root, not writable by group or others;
3. computes SHA-256 of the same descriptor and compares it with the embedded
   release hash;
4. executes the same descriptor (`/dev/fd/9`) under `timeout` — the file is
   never reopened by name between verification and execution, so a swap after
   the check cannot substitute another binary.

Any failure exits 126 with a one-line reason (shown in the panel's status
strip) and nothing is executed; a missing file exits 127. The plugin's own
startup probe runs `--version` through this exact path, so a tampered backend
is refused before the first fetch.

The wrapper is spawned through `/usr/bin/env -i` with a fixed allow-list of
variables (`HOME`, `USER`, locale, XDG dirs, the D-Bus/Wayland addresses,
`PATH=/usr/bin`), so nothing from the shell's environment — `BASH_ENV`, exported
functions, `LD_PRELOAD`/`LD_AUDIT`/`LD_LIBRARY_PATH`, `GLIBC_TUNABLES` — can
influence bash, the tools, or the backend; the wrapper unsets those names again
as defense in depth. The backend's containing directory must also be owned by
you or root and not writable by group or others, and setuid/setgid binaries are
refused. Account labels must start with a letter or digit, so a label can never
be parsed as a command-line option by the backend.

**Developer override.** The plugin setting "Developer backend override" (an
absolute path, empty by default) runs a locally built backend without the hash
check; the regular-file, directory, ownership, permission, and setuid checks
still apply. While it is set, the panel shows a persistent "developer backend
override active — unreviewed build" warning. Treat this setting as granting code
execution as your user: anything able to write the plugin's persisted settings
can point it at an arbitrary binary. Use it only for a backend you built
yourself.

### Bounded network behavior

The backend contacts only the fixed provider hosts compiled into it, and only
for providers that are enabled: `api.anthropic.com`, `chatgpt.com` and
`auth.openai.com`, `api.kimi.com`/`api.kimi.ai` and `auth.kimi.*`,
`api.x.ai`, `cli-chat-proxy.grok.com` and `auth.x.ai`, `api.z.ai`,
`api.deepseek.com`, `api.openai.com`, `api.moonshot.*`, `api.minimax*`,
`api.novita.ai`, `api.kilo.ai`, `api.commandcode.ai`, and
`codewhisperer.us-east-1.amazonaws.com`. Every client uses
`same_origin_redirect_policy` (`src/vendor.rs`, line 54), so a bearer token can
never follow a cross-host redirect. Usage caches are bound to a SHA-256
credential fingerprint (`src/anthropic/fetch.rs`, lines 452–465) so a switch can
never surface another account's data.

### Bounded process behavior

Switchboard spawns exactly two programs: `ai-usagebar` (subcommands
`usage --json`, `account save|switch|toggle|rename`, `settings show|apply`) and
`notify-send`. Every invocation goes through one fixed, positional bash wrapper
(`backendCommand` in `Model.js`; the binary and arguments travel as `"$@"` and are
never spliced into the script). The wrapper `exec`s into coreutils
`timeout --kill-after=5`, which runs the command in its own process group: on the
deadline it signals the whole group and escalates to SIGKILL, and when the shell
destroys the component (`Component.onDestruction` stops every process) the
SIGTERM lands on `timeout` itself, so no grandchild outlives the plugin. stdout
and stderr are capped at the producer boundary (`head -c`, reading one byte past
the cap so overflow is provable by UTF-8 byte length). Deadlines and caps: usage
90 s / 1 MiB, account operations 30 s / 64 KiB, settings show 15 s / 256 KiB,
settings apply 20 s / 64 KiB, binary probe 5 s, notifications 10 s; stderr is
always capped at 64 KiB. A process counts as complete only after it has exited
*and* both capped streams have ended; a deadline exit (124/137) or an overflow
is reported as a failure and never parsed. Account labels are validated before
they reach argv. CLIProxyAPI token files, when that optional source is enabled,
are opened read-only with `O_NOFOLLOW` (`src/cliproxy/mod.rs`, lines 278–283)
and are never refreshed or written. These behaviors are pinned by tests that
execute the real wrapper.

## License

MIT — see [LICENSE](LICENSE). The plugin bundles no third-party assets; glyphs
come from the system's Nerd Font and all styling from the active Omarchy theme.
