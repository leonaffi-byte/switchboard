# Switchboard

Switchboard is a compact Omarchy shell plugin for the `ai-usagebar` fork. Its
bar pill summarizes up to four AI-agent families; its single-screen dashboard
shows every Claude account, the other configured agents, relative resets, and safe
account controls. The plugin shares no QML with AI Usage Bar.

## Install

Install the fork's `ai-usagebar` binary first, then add this repository as an
Omarchy plugin:

```bash
omarchy plugin add https://github.com/leoom/switchboard
```

Switchboard resolves the backend in this order: `AIUSAGEBAR_BIN`,
`$HOME/.local/bin/ai-usagebar`, then `ai-usagebar` on `PATH`. The environment
override is useful when testing a local fork build.

The bar widget defaults to a five-minute refresh, glyph-plus-percent segments,
auto-switch off, an 85% threshold, and threshold alerts off. Its `barShows`
setting has three modes: `icon` shows family glyphs only, `iconpct` adds each
percentage, and `full` adds the provider short name too. Left-click opens the
dashboard; middle-click requests an immediate refresh. Scrolling has no action.

## Dashboard

The dashboard is one screen with these sections:

- `CLAUDE`: one compact row per Claude account. The top line contains its radio,
  family glyph, name, plan tag, and primary 5-hour percentage; a full-width
  hairline meter sits directly below. The dim caption carries the 5-hour reset
  plus the secondary 7-day percentage and reset. An unmanaged default login
  gets an inline validated Save field.
- `AGENTS`: one row per other agent with the same glyph/name/plan/percentage,
  hairline-meter, and caption anatomy. The first reported metric remains
  primary; its own label and relative reset appear in the caption, followed by
  another weekly-labeled metric when present. Health-only agents show their
  text status instead.
- `AUTO-SWITCH`: a persistent toggle and 5-point threshold stepper, followed by
  the current session's `off`, `armed`, last-switch, or failure status.
- A one-line status strip for active work, a missing backend, or the newest
  action error.

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
