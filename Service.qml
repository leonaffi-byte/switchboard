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
  property string barShows: "iconpct"
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
  property bool reportConsumed: true
  property bool binaryMissing: false
  property string statusError: ""
  property string lastAutoReason: "off"
  property var autoEvent: null
  property var alertArmedState: ({})
  property var notificationQueue: []

  property bool refreshQueued: false
  property int completionsPending: 0

  property string probeStdout: ""
  property string probeStderr: ""
  property string usageStdout: ""
  property string usageStderr: ""
  property string switchStdout: ""
  property string switchStderr: ""
  property string saveStdout: ""
  property string saveStderr: ""
  property string notifyStdout: ""
  property string notifyStderr: ""

  property string switchMode: "manual" // manual | toggle | auto
  property var switchContext: null

  property var registeredWidgets: []
  property var registeredWidget: null

  readonly property var groupedEntries: Model.groupEntries(entries)
  readonly property var claudeEntries: groupedEntries.claude
  readonly property var agentEntries: groupedEntries.agents
  readonly property var unsavedEntry: Model.unsavedLoginEntry(entries)
  readonly property var barSegments: Model.buildBarSegments(entries, barShows)
  readonly property bool hasReport: lastRefreshMs > 0
  readonly property bool refreshing: usageProcess.running
  readonly property bool busy: probeProcess.running || usageProcess.running
    || switchProcess.running || saveProcess.running || notifyProcess.running
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
    refreshIntervalSec = Model.integerSetting(source.refreshIntervalSec, 300, 60, 3600, 1)
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
      probeProcess.command = ["/usr/bin/test", "-x", candidate]
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
    usageProcess.command = ["/usr/bin/env", resolvedBinary, "usage", "--json"]
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
    // Aggregate exit status does not determine success: usage --json can
    // return a complete all-errors report with exit 1.
    var parsed = Model.parseReport(usageStdout)
    if (parsed.ok) {
      primary = parsed.primary
      entries = parsed.entries
      lastRefreshMs = Date.now()
      binaryMissing = false

      // Exactly one synchronous evaluation consumes each successful parse.
      reportConsumed = false
      var decision = Model.autoSwitchDecision(parsed.entries, {
        enabled: autoSwitch,
        threshold: autoThreshold,
        nowMs: lastRefreshMs,
        lastSwitchMs: lastSwitchMs,
        cooldownMs: 600000,
        marginPts: 10
      })
      reportConsumed = true
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
    switchProcess.command = ["/usr/bin/env", resolvedBinary,
      "account", "switch", String(label), "--cli"]
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
    switchProcess.command = ["/usr/bin/env", resolvedBinary, "account", "toggle"]
    switchProcess.running = true
    return true
  }

  function saveAccount(label) {
    if (!Model.validSaveLabel(label) || root.busy || resolvedBinary === "") return false
    statusError = ""
    saveStdout = ""
    saveStderr = ""
    saveProcess.command = ["/usr/bin/env", resolvedBinary, "account", "save", String(label)]
    saveProcess.running = true
    return true
  }

  function failureMessage(exitCode, stderrText, fallback) {
    if (Number(exitCode) === 127) {
      binaryMissing = true
      return "ai-usagebar not found — install the fork binary"
    }
    var detail = Model.stderrLine(stderrText)
    return detail === "" ? fallback : detail
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
    notifyProcess.command = command
    notifyProcess.running = true
  }

  function drainWorkQueues() {
    drainNotificationQueue()
    drainRefreshQueue()
  }

  function finishSwitch(exitCode) {
    var wasAuto = switchMode === "auto"
    var context = switchContext
    switchContext = null

    if (Number(exitCode) === 0) {
      lastSwitchMs = Date.now()
      reportConsumed = true
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

    var message = failureMessage(exitCode, switchStderr, "account switch failed")
    statusError = message
    if (wasAuto) {
      // A guard refusal shares the cooldown base so it cannot be hammered.
      lastSwitchMs = Date.now()
      autoEvent = { kind: "failed", message: message, atMs: lastSwitchMs }
    }
  }

  function finishSave(exitCode) {
    if (Number(exitCode) === 0) {
      refreshQueued = true
      return
    }
    statusError = failureMessage(exitCode, saveStderr, "account save failed")
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
    command: ["/usr/bin/test", "-x", "/"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root.probeStdout = text }
    stderr: StdioCollector { waitForEnd: true; onStreamFinished: root.probeStderr = text }
    onExited: function(exitCode) {
      root.completionsPending++
      Qt.callLater(function() {
        root.completionsPending--
        if (Number(exitCode) === 0) root.acceptBinary(root.probingCandidate)
        else root.probeNextCandidate()
        root.drainWorkQueues()
      })
    }
  }

  Process {
    id: usageProcess
    running: false
    command: ["/usr/bin/env", "ai-usagebar", "usage", "--json"]
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
    command: ["/usr/bin/env", "ai-usagebar", "account", "toggle"]
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
    command: ["/usr/bin/env", "ai-usagebar", "account", "save", "placeholder"]
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
    id: notifyProcess
    running: false
    command: ["notify-send", "-a", "Switchboard", "Claude auto-switch", "complete"]
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root.notifyStdout = text }
    stderr: StdioCollector { waitForEnd: true; onStreamFinished: root.notifyStderr = text }
    onExited: function(exitCode) {
      root.completionsPending++
      Qt.callLater(function() {
        root.completionsPending--
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

    function status(): string { return Model.statusLine(root.entries) }
  }

  Component.onCompleted: Qt.callLater(root.beginBinaryResolution)
}
