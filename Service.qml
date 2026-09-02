import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// The keep-loaded singleton owns every process and every mutable datum. Bar
// and panel instances only bridge settings, issue actions, and render state.
Item {
  id: root

  property var shell: null
  property string omarchyPath: ""
  property var manifest: null

  // Safe defaults apply before the first bar instance pushes its settings.
  property int refreshIntervalSec: 300
  property string barShows: "claude"
  property bool autoSwitch: false
  property int autoThreshold: 85
  property bool alerts: false

  property string resolvedBinary: ""
  property var probeCandidates: []
  property int probeIndex: 0
  property string probingCandidate: ""

  property string primary: ""
  property var entries: []
  property double lastRefreshMs: 0
  property double lastSwitchMs: 0
  property bool binaryMissing: false
  property string statusError: ""
  property string lastAutoReason: "off"
  property var autoEvent: null
  property var alertArmedState: ({})
  property var notificationQueue: []

  property var settingsSnapshot: ({
    ok: true, error: "", primary: "", primary_choices: [], keys: []
  })
  property bool settingsLoaded: false
  property bool settingsLoadQueued: false
  property string settingsError: ""
  property string settingsStatus: ""

  property bool refreshQueued: false
  property int completionsPending: 0

  property string probeStdout: ""
  property string probeStderr: ""
  property string usageStdout: ""
  property string usageStderr: ""
  property string switchStdout: ""
  property string switchStderr: ""
  property string saveStdout: ""
  property string renameStdout: ""
  property string renameStderr: ""
  property string saveStderr: ""
  property string notifyStdout: ""
  property string notifyStderr: ""
  property string settingsShowStdout: ""
  property string settingsShowStderr: ""
  property string settingsApplyStdout: ""
  property string settingsApplyStderr: ""
  property string settingsApplyPayload: ""

  property string switchMode: "manual" // manual | toggle | auto
  property var switchContext: null

  property var registeredWidgets: []
  property var registeredWidget: null

  signal settingsSaved()

  readonly property var presentableEntries: Model.presentableEntries(entries)
  readonly property var groupedEntries: Model.groupEntries(presentableEntries)
  readonly property var claudeEntries: groupedEntries.claude
  readonly property var agentEntries: groupedEntries.agents
  readonly property var unsavedEntry: Model.unsavedLoginEntry(entries)
  readonly property var barSegments: Model.buildBarSegments(presentableEntries, barShows)
  readonly property bool hasReport: lastRefreshMs > 0
  readonly property bool refreshing: usageProcess.running
  readonly property bool settingsLoading: settingsLoadQueued || settingsShowProcess.running
  readonly property bool busy: probeProcess.running || usageProcess.running
    || switchProcess.running || saveProcess.running || renameProcess.running
    || notifyProcess.running
    || settingsShowProcess.running || settingsApplyProcess.running
    || completionsPending > 0
  readonly property bool anyStale: {
    for (var i = 0; i < entries.length; i++) if (entries[i].stale === true) return true
    return false
  }
  readonly property string lastRefreshClock: Model.formatClock(lastRefreshMs)
  readonly property string autoStatusText: Model.autoSwitchStatus(autoSwitch, autoEvent)
  readonly property string statusText: {
    if (binaryMissing) return "ai-usagebar not found — install the fork binary"
    if (statusError !== "") return statusError
    if (refreshing) return "refreshing…"
    return ""
  }

  function configure(values) {
    var source = values && typeof values === "object" ? values : {}
    refreshIntervalSec = Model.integerSetting(source.refreshIntervalSec, 300, 60, 3600, 30)
    barShows = Model.barShowsSetting(source.barShows)
    autoSwitch = Model.booleanSetting(source.autoSwitch, false)
    autoThreshold = Model.integerSetting(source.autoThreshold, 85, 50, 95, 5)
    alerts = Model.booleanSetting(source.alerts, false)
  }

  function registerWidget(widget) {
    if (!widget) return
    var next = []
    for (var i = 0; i < registeredWidgets.length; i++)
      if (registeredWidgets[i] && registeredWidgets[i] !== widget) next.push(registeredWidgets[i])
    next.push(widget)
    registeredWidgets = next
    registeredWidget = widget
  }

  function unregisterWidget(widget) {
    var next = []
    for (var i = 0; i < registeredWidgets.length; i++)
      if (registeredWidgets[i] && registeredWidgets[i] !== widget) next.push(registeredWidgets[i])
    registeredWidgets = next
    registeredWidget = next.length > 0 ? next[next.length - 1] : null
  }

  // ---------------------------------------------------------- binary probe
  function beginBinaryResolution() {
    probeCandidates = Model.binaryCandidates({
      AIUSAGEBAR_BIN: Quickshell.env("AIUSAGEBAR_BIN") || "",
      HOME: Quickshell.env("HOME") || ""
    })
    probeIndex = 0
    probeNextCandidate()
  }

  function probeNextCandidate() {
    if (root.busy) return
    while (probeIndex < probeCandidates.length) {
      var candidate = String(probeCandidates[probeIndex] || "")
      probeIndex++
      if (candidate === "") continue
      // Only absolute candidates are meaningful inputs to test -x. A PATH
      // override and the final bare fallback are intentionally unprobed.
      if (candidate.charAt(0) !== "/") {
        acceptBinary(candidate)
        return
      }
      probingCandidate = candidate
      probeStdout = ""
      probeStderr = ""
      probeProcess.command = Model.backendCommand("/usr/bin/test", ["-x", candidate], 5, 4096)
      probeProcess.running = true
      return
    }
    acceptBinary("ai-usagebar")
  }

  function acceptBinary(binary) {
    resolvedBinary = String(binary || "ai-usagebar")
    requestAutomaticRefresh()
  }

  // --------------------------------------------------------------- refresh
  function startRefresh(manual) {
    if (root.busy || resolvedBinary === "") return false
    if (manual === true) {
      statusError = ""
      binaryMissing = false
    }
    refreshQueued = false
    usageStdout = ""
    usageStderr = ""
    usageProcess.command = Model.backendCommand(resolvedBinary, ["usage", "--json"], 90, 1048576)
    usageProcess.running = true
    return true
  }

  function manualRefresh() {
    if (root.busy) return false
    return startRefresh(true)
  }

  function requestAutomaticRefresh() {
    if (root.busy || resolvedBinary === "") {
      refreshQueued = true
      return false
    }
    return startRefresh(false)
  }

  function drainRefreshQueue() {
    if (!refreshQueued || root.busy || resolvedBinary === "") return
    refreshQueued = false
    startRefresh(false)
  }

  function finishRefresh(exitCode) {
    var boundedError = boundedCompletionError(exitCode, usageStdout,
      "usage", 90, 1048576)
    if (boundedError !== "") {
      statusError = boundedError
      return
    }

    // Aggregate exit status does not determine success: usage --json can
    // return a complete all-errors report with exit 1.
    var parsed = Model.parseReport(usageStdout)
    if (parsed.ok) {
      primary = parsed.primary
      entries = parsed.entries
      lastRefreshMs = Date.now()
      binaryMissing = false

      // Exactly one synchronous evaluation consumes each successful parse —
      // this handler is the only evaluation site, so that holds by structure.
      var decision = Model.autoSwitchDecision(parsed.entries, {
        enabled: autoSwitch,
        threshold: autoThreshold,
        nowMs: lastRefreshMs,
        lastSwitchMs: lastSwitchMs,
        cooldownMs: 600000,
        marginPts: 10
      })
      lastAutoReason = decision.action === "none" ? decision.reason : "switch"
      if (decision.action === "switch") startAccountSwitch(decision.label, true, decision)

      var alertResult = Model.alertDecisions(parsed.entries, alertArmedState, {
        enabled: alerts
      })
      alertArmedState = alertResult.armedState
      enqueueNotifications(alertResult.notifications, false)
      return
    }

    if (Number(exitCode) === 127 && String(usageStdout || "").trim() === "") {
      binaryMissing = true
      return
    }
    var detail = Model.stderrLine(usageStderr)
    statusError = detail !== "" ? detail : parsed.error
  }

  // --------------------------------------------------------------- actions
  function startAccountSwitch(label, automatic, context) {
    if (!Model.validAccountLabel(label) || root.busy || resolvedBinary === "") return false
    statusError = ""
    switchStdout = ""
    switchStderr = ""
    switchMode = automatic === true ? "auto" : "manual"
    switchContext = context || null
    switchProcess.command = Model.backendCommand(resolvedBinary,
      ["account", "switch", String(label), "--cli"], 30, 65536)
    switchProcess.running = true
    return true
  }

  function switchEntry(entry) {
    var label = Model.switchLabel(entry)
    if (label === null) return false
    return startAccountSwitch(label, false, null)
  }

  function toggleAccount() {
    if (root.busy || resolvedBinary === "") return false
    statusError = ""
    switchStdout = ""
    switchStderr = ""
    switchMode = "toggle"
    switchContext = null
    switchProcess.command = Model.backendCommand(resolvedBinary,
      ["account", "toggle"], 30, 65536)
    switchProcess.running = true
    return true
  }

  function saveAccount(label) {
    if (!Model.validSaveLabel(label) || root.busy || resolvedBinary === "") return false
    statusError = ""
    saveStdout = ""
    saveStderr = ""
    saveProcess.command = Model.backendCommand(resolvedBinary,
      ["account", "save", String(label)], 30, 65536)
    saveProcess.running = true
    return true
  }

  // ------------------------------------------------------- backend settings
  function requestSettingsSnapshot() {
    settingsLoaded = false
    settingsError = ""
    settingsStatus = ""
    settingsSnapshot = ({
      ok: true, error: "", primary: "", primary_choices: [], keys: []
    })
    settingsLoadQueued = true
    return drainSettingsLoadQueue()
  }

  function drainSettingsLoadQueue() {
    if (!settingsLoadQueued || root.busy || resolvedBinary === "") return false
    settingsLoadQueued = false
    settingsShowStdout = ""
    settingsShowStderr = ""
    settingsShowProcess.command = Model.backendCommand(resolvedBinary,
      ["settings", "show"], 15, 262144)
    settingsShowProcess.running = true
    return true
  }

  function finishSettingsShow(exitCode) {
    settingsLoaded = true
    var boundedError = boundedCompletionError(exitCode, settingsShowStdout,
      "settings show", 15, 262144)
    if (boundedError !== "") {
      settingsSnapshot = ({
        ok: false, error: "", primary: "", primary_choices: [], keys: []
      })
      settingsError = boundedError
      return
    }
    if (Number(exitCode) !== 0) {
      settingsSnapshot = ({
        ok: false, error: "", primary: "", primary_choices: [], keys: []
      })
      settingsError = failureMessage(exitCode, settingsShowStderr,
        "settings could not be loaded")
      return
    }

    var parsed = Model.parseSettingsSnapshot(settingsShowStdout)
    if (!parsed.ok) {
      settingsSnapshot = parsed
      settingsError = parsed.error
      return
    }
    settingsSnapshot = parsed
    settingsError = ""
  }

  function applySettingsPatch(payload) {
    if (root.busy || resolvedBinary === "" || String(payload || "") === "") return false
    settingsError = ""
    settingsStatus = ""
    settingsApplyStdout = ""
    settingsApplyStderr = ""
    settingsApplyPayload = String(payload)
    settingsApplyProcess.command = Model.backendCommand(resolvedBinary,
      ["settings", "apply"], 20, 65536)
    settingsApplyProcess.running = true
    return true
  }

  function finishSettingsApply(exitCode) {
    var boundedError = boundedCompletionError(exitCode, settingsApplyStdout,
      "settings apply", 20, 65536)
    if (boundedError !== "") {
      settingsError = boundedError
      return
    }
    if (!Model.settingsApplySucceeded(exitCode, settingsApplyStdout)) {
      settingsError = failureMessage(exitCode, settingsApplyStderr,
        "The settings command did not confirm the save.")
      return
    }

    settingsError = ""
    settingsSaved()
    requestSettingsSnapshot()
    requestAutomaticRefresh()
    settingsStatus = "Settings saved. Usage is refreshing."
  }

  function failureMessage(exitCode, stderrText, fallback) {
    if (Number(exitCode) === 127) {
      binaryMissing = true
      return "ai-usagebar not found — install the fork binary"
    }
    var detail = Model.stderrLine(stderrText)
    return detail === "" ? fallback : detail
  }

  function boundedCompletionError(exitCode, stdoutText, what, deadlineSec, capBytes) {
    var code = Number(exitCode)
    if (code === 124 || code === 137)
      return what + " timed out after " + deadlineSec + "s"
    if (Model.utf8ByteLength(stdoutText) > capBytes)
      return what + " output exceeded " + capBytes
    return ""
  }

  function enqueueNotification(command, priority) {
    enqueueNotifications([command], priority)
  }

  function enqueueNotifications(commands, priority) {
    var source = Array.isArray(commands) ? commands : []
    if (source.length === 0) return
    var next = notificationQueue.slice()
    for (var i = 0; i < source.length; i++) {
      if (!Array.isArray(source[i]) || source[i].length < 5) continue
      if (priority === true) next.unshift(source[i].slice())
      else next.push(source[i].slice())
    }
    notificationQueue = next
    drainNotificationQueue()
  }

  function drainNotificationQueue() {
    if (root.busy || notificationQueue.length === 0) return
    var next = notificationQueue.slice()
    var command = next.shift()
    notificationQueue = next
    notifyStdout = ""
    notifyStderr = ""
    notifyProcess.command = Model.backendCommand(command[0], command.slice(1), 10, 4096)
    notifyProcess.running = true
  }

  function drainWorkQueues() {
    drainSettingsLoadQueue()
    drainNotificationQueue()
    drainRefreshQueue()
  }

  function finishSwitch(exitCode) {
    var wasAuto = switchMode === "auto"
    var context = switchContext
    switchContext = null

    var boundedError = boundedCompletionError(exitCode, switchStdout,
      "account switch", 30, 65536)
    if (boundedError === "" && Number(exitCode) === 0) {
      lastSwitchMs = Date.now()
      refreshQueued = true
      if (wasAuto && context) {
        autoEvent = {
          kind: "last",
          from: context.fromLabel,
          to: context.label,
          atMs: lastSwitchMs
        }
        enqueueNotification(["notify-send", "-a", "Switchboard", "Claude auto-switch",
          context.fromLabel + " " + context.fromPct + "% → " + context.label + " " + context.toPct + "%"], true)
      }
      return
    }

    var message = boundedError !== "" ? boundedError
      : failureMessage(exitCode, switchStderr, "account switch failed")
    statusError = message
    // Every failed switch — manual, IPC, or auto — shares the cooldown base,
    // so a refresh queued behind it cannot immediately auto-switch against a
    // target the binary just refused.
    lastSwitchMs = Date.now()
    if (wasAuto) {
      autoEvent = { kind: "failed", message: message, atMs: lastSwitchMs }
    }
  }

  function finishSave(exitCode) {
    var boundedError = boundedCompletionError(exitCode, saveStdout,
      "account save", 30, 65536)
    if (boundedError === "" && Number(exitCode) === 0) {
      refreshQueued = true
      return
    }
    statusError = boundedError !== "" ? boundedError
      : failureMessage(exitCode, saveStderr, "account save failed")
  }

  function renameAccount(oldLabel, newLabel) {
    if (!Model.validSaveLabel(oldLabel) || !Model.validSaveLabel(newLabel)) return false
    if (String(oldLabel) === String(newLabel) || root.busy || resolvedBinary === "") return false
    statusError = ""
    renameStdout = ""
    renameStderr = ""
    renameProcess.command = Model.backendCommand(resolvedBinary,
      ["account", "rename", String(oldLabel), String(newLabel)], 30, 65536)
    renameProcess.running = true
    return true
  }

  function finishRename(exitCode) {
    var boundedError = boundedCompletionError(exitCode, renameStdout,
      "account rename", 30, 65536)
    if (boundedError === "" && Number(exitCode) === 0) {
      refreshQueued = true
      return
    }
    statusError = boundedError !== "" ? boundedError
      : failureMessage(exitCode, renameStderr, "account rename failed")
  }

  // --------------------------------------------------------------- cadence
  Timer {
    interval: Math.max(60, root.refreshIntervalSec) * 1000
    repeat: true
    running: root.resolvedBinary !== ""
    onTriggered: root.requestAutomaticRefresh()
  }

  // -------------------------------------------------------------- processes
  Process {
    id: probeProcess
    running: false
    command: []
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root.probeStdout = text }
    stderr: StdioCollector { waitForEnd: true; onStreamFinished: root.probeStderr = text }
    onExited: function(exitCode) {
      root.completionsPending++
      Qt.callLater(function() {
        root.completionsPending--
        var boundedError = root.boundedCompletionError(exitCode, root.probeStdout,
          "binary probe", 5, 4096)
        if (boundedError !== "") root.statusError = boundedError
        if (boundedError === "" && Number(exitCode) === 0)
          root.acceptBinary(root.probingCandidate)
        else root.probeNextCandidate()
        root.drainWorkQueues()
      })
    }
  }

  Process {
    id: usageProcess
    running: false
    command: []
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root.usageStdout = text }
    stderr: StdioCollector { waitForEnd: true; onStreamFinished: root.usageStderr = text }
    onExited: function(exitCode) {
      root.completionsPending++
      Qt.callLater(function() {
        root.completionsPending--
        root.finishRefresh(exitCode)
        root.drainWorkQueues()
      })
    }
  }

  Process {
    id: switchProcess
    running: false
    command: []
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root.switchStdout = text }
    stderr: StdioCollector { waitForEnd: true; onStreamFinished: root.switchStderr = text }
    onExited: function(exitCode) {
      root.completionsPending++
      Qt.callLater(function() {
        root.completionsPending--
        root.finishSwitch(exitCode)
        root.drainWorkQueues()
      })
    }
  }

  Process {
    id: saveProcess
    running: false
    command: []
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root.saveStdout = text }
    stderr: StdioCollector { waitForEnd: true; onStreamFinished: root.saveStderr = text }
    onExited: function(exitCode) {
      root.completionsPending++
      Qt.callLater(function() {
        root.completionsPending--
        root.finishSave(exitCode)
        root.drainWorkQueues()
      })
    }
  }

  Process {
    id: renameProcess
    running: false
    command: []
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root.renameStdout = text }
    stderr: StdioCollector { waitForEnd: true; onStreamFinished: root.renameStderr = text }
    onExited: function(exitCode) {
      root.completionsPending++
      Qt.callLater(function() {
        root.completionsPending--
        root.finishRename(exitCode)
        root.drainWorkQueues()
      })
    }
  }

  Process {
    id: notifyProcess
    running: false
    command: []
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root.notifyStdout = text }
    stderr: StdioCollector { waitForEnd: true; onStreamFinished: root.notifyStderr = text }
    onExited: function(exitCode) {
      root.completionsPending++
      Qt.callLater(function() {
        root.completionsPending--
        var boundedError = root.boundedCompletionError(exitCode, root.notifyStdout,
          "notification", 10, 4096)
        if (boundedError !== "") root.statusError = boundedError
        root.drainWorkQueues()
      })
    }
  }

  Process {
    id: settingsShowProcess
    running: false
    command: []
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root.settingsShowStdout = text }
    stderr: StdioCollector { waitForEnd: true; onStreamFinished: root.settingsShowStderr = text }
    onExited: function(exitCode) {
      root.completionsPending++
      Qt.callLater(function() {
        root.completionsPending--
        root.finishSettingsShow(exitCode)
        root.drainWorkQueues()
      })
    }
  }

  Process {
    id: settingsApplyProcess
    running: false
    command: []
    stdinEnabled: true
    onStarted: {
      write(root.settingsApplyPayload + "\n")
      root.settingsApplyPayload = ""
    }
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root.settingsApplyStdout = text }
    stderr: StdioCollector { waitForEnd: true; onStreamFinished: root.settingsApplyStderr = text }
    onExited: function(exitCode) {
      root.completionsPending++
      Qt.callLater(function() {
        root.completionsPending--
        root.finishSettingsApply(exitCode)
        root.drainWorkQueues()
      })
    }
  }

  // ------------------------------------------------------------------- IPC
  IpcHandler {
    target: "leoom.switchboard"

    function toggle(): string {
      if (root.registeredWidget && typeof root.registeredWidget.togglePanel === "function") {
        root.registeredWidget.togglePanel()
        return "ok"
      }
      return "unavailable"
    }

    function refresh(): string {
      if (root.busy) return "busy"
      return root.manualRefresh() ? "ok" : "unavailable"
    }

    function toggleAccount(): string {
      if (root.busy) return "busy"
      return root.toggleAccount() ? "ok" : "unavailable"
    }

    function status(): string { return Model.statusLine(root.presentableEntries) }

    // Opens the panel directly on the settings page (also used by review
    // tooling — the page is otherwise reachable only by clicking the gear).
    function settings(): string {
      if (!root.registeredWidget || typeof root.registeredWidget.togglePanel !== "function")
        return "unavailable"
      var panelItem = root.registeredWidget.panelItem
      if (!panelItem || typeof panelItem.openSettings !== "function") return "unavailable"
      if (!root.registeredWidget.panelOpened) root.registeredWidget.togglePanel()
      panelItem.openSettings()
      return "ok"
    }
  }

  Component.onCompleted: Qt.callLater(root.beginBinaryResolution)
  Component.onDestruction: {
    probeProcess.running = false
    usageProcess.running = false
    switchProcess.running = false
    saveProcess.running = false
    renameProcess.running = false
    notifyProcess.running = false
    settingsShowProcess.running = false
    settingsApplyProcess.running = false
    completionsPending = 0
    refreshQueued = false
    settingsLoadQueued = false
    notificationQueue = []
    settingsApplyPayload = ""
  }
}
