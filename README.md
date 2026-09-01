# Switchboard

Switchboard is a compact Omarchy shell plugin for the `ai-usagebar` fork. Its
bar pill summarizes up to four AI-agent families; its single-screen dashboard
shows every Claude account, the other configured agents, reset times, and safe
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

The bar widget defaults to a five-minute refresh, compact family tags,
auto-switch off, and an 85% threshold. Left-click opens the dashboard;
middle-click requests an immediate refresh. Scrolling has no action.

## Dashboard

The dashboard is one screen with these sections:

- `CLAUDE`: one compact row per Claude account, with active/switchable radio,
  plan, label-selected 5-hour and 7-day meters, and reset clock. An unmanaged
  default login gets an inline validated Save field.
- `AGENTS`: one row per other agent. Its first reported metric remains primary;
  another weekly-labeled metric is shown when present. Health-only agents show
  their text status instead.
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
