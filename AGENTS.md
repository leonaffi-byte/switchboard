# Notes for coding agents

- Run `node --test .` before finishing any change; all tests must pass.
- Validate the manifest with `omarchy plugin validate .` after editing it.
- Model.js must stay free of QML globals (it is exercised by node), and every
  report-data array gate must go through `listOf()` — QML passes sequence
  wrappers for which `Array.isArray` is false.
- Never run `qml`, `qmlscene`, or `quickshell` from a sandbox — they abort
  without a display and spam desktop crash notifications.
- Do not log, echo, or retain provider key values; the settings bridge is
  write-only over stdin.
