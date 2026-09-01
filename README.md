# Switchboard

Switchboard is a compact Omarchy shell plugin for the `ai-usagebar` fork. Its
native bar item and glanceable dashboard show Claude accounts, other configured
agents, relative resets, and safe account controls. The plugin shares no QML
with AI Usage Bar.

## Install

Install the fork's `ai-usagebar` binary first, then add this repository as an
Omarchy plugin:

```bash
omarchy plugin add https://github.com/leoom/switchboard
```

Switchboard resolves the backend in this order: `AIUSAGEBAR_BIN`,
`$HOME/.local/bin/ai-usagebar`, then `ai-usagebar` on `PATH`. The environment
override is useful when testing a local fork build.

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
  unmanaged default login gets a validated inline Save field.
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
```

`toggleAccount` runs the backend's guarded manual account toggle regardless of
the auto-switch setting. For a Hyprland shortcut, add:

```ini
bind = CTRL ALT SHIFT, S, exec, omarchy-shell leoom.switchboard toggleAccount
```

Busy `refresh` and `toggleAccount` IPC calls return `busy`; panel toggling and
the last-known compact status line remain available.
