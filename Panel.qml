import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Compact dashboard and settings page. Service.qml owns all processes and
// mutable backend state; this view only renders and forwards deliberate input.
Panel {
  id: root
  moduleName: "leoom.switchboard"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root
  readonly property var svc: hostWidget && hostWidget.svc
    ? hostWidget.svc : (bar && bar.shell ? bar.shell.serviceFor("leoom.switchboard") : null)
  readonly property var palette: ({
    muted: Color.muted,
    foreground: Color.foreground,
    accent: Color.accent,
    urgent: Color.urgent
  })

  property bool settingsOpen: false
  property string saveDraft: ""
  property string saveDraftEntryId: ""
  property string settingsValidationError: ""
  property double nowMs: Date.now()

  function switchPanel(direction) {
    if (bar && typeof bar.switchPanelFrom === "function")
      return bar.switchPanelFrom(barIdentity, direction)
    return false
  }

  function resetScroll() {
    if (scrollArea.contentItem) scrollArea.contentItem.contentY = 0
  }

  function syncSaveDraft() {
    var entry = svc ? svc.unsavedEntry : null
    if (!entry) {
      saveDraftEntryId = ""
      saveDraft = ""
      if (saveField) saveField.text = ""
      return
    }
    var id = String(entry.id || "") + "|" + String(entry.plan || "")
    if (id === saveDraftEntryId) return
    saveDraftEntryId = id
    saveDraft = Model.suggestedSaveLabel(entry)
    if (saveField) saveField.text = saveDraft
  }

  function scrubProviderDrafts() {
    for (var i = 0; i < providerKeyRepeater.count; i++) {
      var row = providerKeyRepeater.itemAt(i)
      if (row) row.scrub()
    }
    settingsValidationError = ""
  }

  function openSettings() {
    scrubProviderDrafts()
    settingsOpen = true
    resetScroll()
    if (svc) svc.requestSettingsSnapshot()
    Qt.callLater(function() { settingsPage.forceActiveFocus() })
  }

  function toggleSettings() {
    if (settingsOpen) closeSettings()
    else openSettings()
  }

  function closeSettings() {
    scrubProviderDrafts()
    settingsOpen = false
    resetScroll()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  function collectProviderChanges() {
    var changes = []
    for (var i = 0; i < providerKeyRepeater.count; i++) {
      var row = providerKeyRepeater.itemAt(i)
      if (!row || row.pendingAction === "unchanged") continue
      changes.push({
        id: row.vendorId,
        action: row.pendingAction,
        value: row.pendingAction === "set" ? row.secretText : ""
      })
    }
    return changes
  }

  function saveProviderChanges() {
    if (!svc || svc.busy) return
    var built = Model.buildSettingsPatch("", collectProviderChanges())
    if (!built.ok) {
      settingsValidationError = built.error
      return
    }
    settingsValidationError = ""
    if (!svc.applySettingsPatch(built.payload))
      settingsValidationError = "Settings are busy."
  }

  onOpenedChanged: {
    if (opened) {
      nowMs = Date.now()
      resetScroll()
      syncSaveDraft()
      Qt.callLater(function() { keyCatcher.forceActiveFocus() })
    } else {
      scrubProviderDrafts()
      settingsOpen = false
    }
  }
  onSvcChanged: Qt.callLater(syncSaveDraft)

  Connections {
    target: root.svc
    function onEntriesChanged() {
      root.nowMs = Date.now()
      Qt.callLater(root.syncSaveDraft)
    }
    function onSettingsSaved() { root.scrubProviderDrafts() }
  }

  Timer {
    interval: 60000
    repeat: true
    running: root.opened
    onTriggered: root.nowMs = Date.now()
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    // Anchor directly under the widget's bar item, like native panels — a
    // centered panel reads as detached from the icon that opened it.
    centerOnBar: false
    focusTarget: keyCatcher
    padding: Style.spacing.panelPadding
    contentWidth: panel.fittedContentWidth(Style.space(300))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(460))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: root.settingsOpen
      onCloseRequested: root.settingsOpen ? root.closeSettings() : root.close()

      // A blocked PanelKeyCatcher swallows Escape without emitting
      // closeRequested, so the settings page needs its own window-scoped
      // shortcut — it works no matter which control holds focus, including
      // mid-edit in a key field (pending input is deliberately dropped).
      // It must live inside an Item: KeyboardPanel's content list accepts
      // only visual items, and a non-Item child silently breaks the panel.
      Shortcut {
        sequences: ["Escape"]
        context: Qt.WindowShortcut
        enabled: root.opened && root.settingsOpen
        onActivated: root.closeSettings()
      }
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(text) {
        if (!root.settingsOpen && (text === "r" || text === "R")
            && root.svc && !root.svc.busy)
          root.svc.manualRefresh()
      }

      ScrollView {
        id: scrollArea
        anchors.fill: parent
        clip: true
        ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
        ScrollBar.vertical.policy: column.implicitHeight > height
          ? ScrollBar.AsNeeded : ScrollBar.AlwaysOff

        Binding {
          target: scrollArea.contentItem
          property: "interactive"
          value: column.implicitHeight > scrollArea.height
        }

        Column {
          id: column
          width: scrollArea.availableWidth
          spacing: Style.spacing.panelGap

          // ====================================================== MAIN PAGE
          Column {
            id: mainPage
            visible: !root.settingsOpen
            width: parent.width
            spacing: Style.spacing.panelGap

            Item {
              width: parent.width
              implicitHeight: Math.max(title.implicitHeight, headerActions.implicitHeight)

              Text {
                id: title
                anchors.left: parent.left
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                text: "Switchboard"
                color: Color.foreground
                font.family: Style.font.family
                font.pixelSize: Style.font.title
                font.bold: true
              }

              Row {
                id: headerActions
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.spacing.labelGap

                Button {
                  iconText: "󰑐"
                  tooltipText: "Refresh usage"
                  fontSize: Style.font.caption
                  iconSize: Style.font.subtitle
                  horizontalPadding: Style.spacing.controlGap
                  verticalPadding: Style.spacing.labelGap
                  enabled: !!root.svc && !root.svc.busy
                  onClicked: root.svc.manualRefresh()
                }

                Button {
                  iconText: "󰒓"
                  tooltipText: "Settings"
                  fontSize: Style.font.caption
                  iconSize: Style.font.subtitle
                  horizontalPadding: Style.spacing.controlGap
                  verticalPadding: Style.spacing.labelGap
                  onClicked: root.toggleSettings()
                }
              }
            }

            Text {
              visible: !root.svc || (!root.svc.hasReport && !root.svc.binaryMissing)
              width: parent.width
              horizontalAlignment: Text.AlignHCenter
              textFormat: Text.PlainText
              text: "loading…"
              color: Color.muted
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
            }

            Column {
              visible: !!root.svc && root.svc.hasReport && !root.svc.binaryMissing
              width: parent.width
              spacing: Style.spacing.labelGap

              PanelSectionHeader {
                text: "CLAUDE"
                foreground: Color.foreground
              }

              Repeater {
                model: root.svc ? root.svc.claudeEntries : []
                delegate: ClaudeAccountRow {
                  required property var modelData
                  width: parent.width
                  entry: modelData
                }
              }

              Text {
                visible: !!root.svc && root.svc.claudeEntries.length === 0
                  && !root.svc.unsavedEntry
                width: parent.width
                textFormat: Text.PlainText
                text: "no saved accounts"
                color: Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
              }

              // One-line onboarding while there is nothing to switch between.
              Text {
                visible: !!root.svc && root.svc.claudeEntries.length < 2
                width: parent.width
                wrapMode: Text.WordWrap
                maximumLineCount: 2
                elide: Text.ElideRight
                textFormat: Text.PlainText
                text: "add another: /login as it in any Claude terminal, then Save here"
                color: Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
              }

              Item {
                visible: !!root.svc && !!root.svc.unsavedEntry
                width: parent.width
                height: visible ? Style.spacing.controlHeight : 0

                Row {
                  anchors.fill: parent
                  spacing: Style.spacing.controlGap

                  Text {
                    id: unsavedLabel
                    anchors.verticalCenter: parent.verticalCenter
                    textFormat: Text.PlainText
                    text: "unsaved login"
                    color: Color.muted
                    font.family: Style.font.family
                    font.pixelSize: Style.font.caption
                  }

                  TextField {
                    id: saveField
                    width: Math.max(Style.spacing.numberFieldWidth,
                      parent.width - unsavedLabel.implicitWidth
                      - saveButton.implicitWidth - parent.spacing * 2)
                    anchors.verticalCenter: parent.verticalCenter
                    enabled: !!root.svc && !root.svc.busy
                    maximumLength: 32
                    selectByMouse: true
                    verticalPadding: Style.spacing.labelGap
                    onTextEdited: root.saveDraft = text
                  }

                  Button {
                    id: saveButton
                    anchors.verticalCenter: parent.verticalCenter
                    text: "Save"
                    fontSize: Style.font.caption
                    horizontalPadding: Style.spacing.controlGap
                    verticalPadding: Style.spacing.labelGap
                    enabled: !!root.svc && !root.svc.busy
                      && Model.validSaveLabel(root.saveDraft)
                    onClicked: root.svc.saveAccount(root.saveDraft)
                  }
                }
              }
            }

            Column {
              visible: !!root.svc && root.svc.hasReport && !root.svc.binaryMissing
              width: parent.width
              spacing: Style.spacing.labelGap

              PanelSectionHeader {
                text: "AGENTS"
                foreground: Color.foreground
              }

              Repeater {
                model: root.svc ? root.svc.agentEntries : []
                delegate: AgentRow {
                  required property var modelData
                  width: parent.width
                  entry: modelData
                }
              }

              Text {
                visible: !!root.svc && root.svc.agentEntries.length === 0
                width: parent.width
                textFormat: Text.PlainText
                text: "no other agents configured"
                color: Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
              }
            }

            Column {
              visible: !!root.svc && root.svc.hasReport && !root.svc.binaryMissing
              width: parent.width
              spacing: Style.spacing.labelGap

              Row {
                id: autoSwitchRow
                width: parent.width
                height: Style.spacing.controlHeight
                spacing: Style.spacing.controlGap

                ToggleSwitch {
                  id: mainAutoToggle
                  anchors.verticalCenter: parent.verticalCenter
                  cursorRing: false
                  checked: root.svc ? root.svc.autoSwitch : false
                  busy: !root.hostWidget || (root.svc && root.svc.busy)
                  onToggled: if (root.hostWidget)
                    root.hostWidget.setAutoSwitch(!(root.svc && root.svc.autoSwitch))
                }

                Text {
                  width: Math.max(0, parent.width - mainAutoToggle.implicitWidth - parent.spacing)
                  anchors.verticalCenter: parent.verticalCenter
                  elide: Text.ElideRight
                  textFormat: Text.PlainText
                  text: "Auto-switch at ≥ " + (root.svc ? root.svc.autoThreshold : 85) + "%"
                  color: Color.foreground
                  font.family: Style.font.family
                  font.pixelSize: Style.font.bodySmall
                }
              }

              Text {
                width: parent.width
                wrapMode: Text.WordWrap
                maximumLineCount: 2
                textFormat: Text.PlainText
                text: Model.autoSwitchBlurb(root.svc ? root.svc.entries : [],
                  root.svc ? root.svc.autoThreshold : 85)
                color: Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
              }

              Text {
                visible: !!root.svc && !!root.svc.autoEvent
                width: parent.width
                elide: Text.ElideRight
                maximumLineCount: 1
                textFormat: Text.PlainText
                text: root.svc ? Model.autoSwitchEventText(root.svc.autoEvent) : ""
                color: text.indexOf("failed:") === 0 ? Color.urgent : Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
              }
            }

            // --------------------------------------------------- status strip
            Text {
              visible: !!root.svc && root.svc.statusText !== ""
              width: parent.width
              elide: Text.ElideRight
              maximumLineCount: 1
              textFormat: Text.PlainText
              text: root.svc ? root.svc.statusText : ""
              color: root.svc && root.svc.statusError !== "" ? Color.urgent : Color.muted
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
            }
          }

          // ================================================== SETTINGS PAGE
          Column {
            id: settingsPage
            visible: root.settingsOpen
            width: parent.width
            spacing: Style.spacing.panelGap
            focus: visible
            Keys.onEscapePressed: root.closeSettings()

            Button {
              text: "‹ back"
              leftAlign: true
              fontSize: Style.font.caption
              horizontalPadding: Style.spacing.controlGap
              verticalPadding: Style.spacing.labelGap
              onClicked: root.closeSettings()
            }

            Column {
              width: parent.width
              spacing: Style.spacing.rowGap

              PanelSectionHeader {
                text: "SWITCHBOARD"
                foreground: Color.foreground
              }

              Dropdown {
                width: parent.width
                label: "Bar shows"
                value: root.svc ? root.svc.barShows : "claude"
                options: [
                  { value: "claude", label: "Claude only" },
                  { value: "all", label: "All agents" },
                  { value: "icon", label: "Icons only" }
                ]
                enabled: !!root.hostWidget && !!root.svc && !root.svc.busy
                onChanged: function(value) { root.hostWidget.setBarShows(value) }
              }

              NumberField {
                width: parent.width
                label: "Refresh every (seconds)"
                value: root.svc ? root.svc.refreshIntervalSec : 300
                from: 60
                to: 3600
                stepSize: 30
                enabled: !!root.hostWidget && !!root.svc && !root.svc.busy
                onModified: function(value) { root.hostWidget.setRefreshInterval(value) }
              }

              Item {
                width: parent.width
                height: Style.spacing.controlHeight

                Text {
                  anchors.left: parent.left
                  anchors.right: alertsToggle.left
                  anchors.rightMargin: Style.spacing.controlGap
                  anchors.verticalCenter: parent.verticalCenter
                  elide: Text.ElideRight
                  textFormat: Text.PlainText
                  text: "Usage alerts"
                  color: Color.foreground
                  font.family: Style.font.family
                  font.pixelSize: Style.font.bodySmall
                }

                ToggleSwitch {
                  id: alertsToggle
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  cursorRing: false
                  checked: root.svc ? root.svc.alerts : false
                  busy: !root.hostWidget || (root.svc && root.svc.busy)
                  onToggled: if (root.hostWidget)
                    root.hostWidget.setAlerts(!(root.svc && root.svc.alerts))
                }
              }

              Text {
                width: parent.width
                wrapMode: Text.WordWrap
                textFormat: Text.PlainText
                text: "one notification at 75% and at 90%, re-armed when the window resets"
                color: Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
              }
            }

            Column {
              width: parent.width
              spacing: Style.spacing.rowGap

              PanelSectionHeader {
                text: "AUTO-SWITCH"
                foreground: Color.foreground
              }

              Item {
                width: parent.width
                height: Style.spacing.controlHeight

                Text {
                  anchors.left: parent.left
                  anchors.right: settingsAutoToggle.left
                  anchors.rightMargin: Style.spacing.controlGap
                  anchors.verticalCenter: parent.verticalCenter
                  elide: Text.ElideRight
                  textFormat: Text.PlainText
                  text: "Auto-switch"
                  color: Color.foreground
                  font.family: Style.font.family
                  font.pixelSize: Style.font.bodySmall
                }

                ToggleSwitch {
                  id: settingsAutoToggle
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  cursorRing: false
                  checked: root.svc ? root.svc.autoSwitch : false
                  busy: !root.hostWidget || (root.svc && root.svc.busy)
                  onToggled: if (root.hostWidget)
                    root.hostWidget.setAutoSwitch(!(root.svc && root.svc.autoSwitch))
                }
              }

              NumberField {
                width: parent.width
                label: "Switch when 5h ≥"
                value: root.svc ? root.svc.autoThreshold : 85
                from: 50
                to: 95
                stepSize: 5
                enabled: !!root.hostWidget && !!root.svc && !root.svc.busy
                onModified: function(value) { root.hostWidget.setAutoThreshold(value) }
              }

              Text {
                width: parent.width
                wrapMode: Text.WordWrap
                textFormat: Text.PlainText
                text: "Switches every open terminal to the least-used saved account, with a 10-minute cooldown; never switches unsaved logins or stale data."
                color: Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
              }
            }

            Column {
              width: parent.width
              spacing: Style.spacing.rowGap

              PanelSectionHeader {
                text: "PROVIDER KEYS"
                foreground: Color.foreground
              }

              Text {
                visible: !!root.svc && root.svc.settingsLoading
                width: parent.width
                horizontalAlignment: Text.AlignHCenter
                textFormat: Text.PlainText
                text: "Loading provider keys…"
                color: Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
              }

              // Real failures only (validation or a failed apply) — provider
              // "no API key" errors are redundant next to a field that
              // already says "not set", and a wall of red reads as broken.
              Text {
                visible: text !== ""
                width: parent.width
                wrapMode: Text.WordWrap
                maximumLineCount: 2
                elide: Text.ElideRight
                textFormat: Text.PlainText
                text: root.settingsValidationError !== ""
                  ? root.settingsValidationError : (root.svc ? root.svc.settingsError : "")
                color: Color.urgent
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
              }

              Repeater {
                id: providerKeyRepeater
                model: root.svc ? root.svc.settingsSnapshot.keys : []

                delegate: ProviderKeyRow {
                  required property var modelData
                  width: providerKeyRepeater.parent.width
                  keyInfo: modelData
                }
              }

              Text {
                visible: !!root.svc && root.svc.settingsLoaded
                  && !root.svc.settingsLoading && root.svc.settingsSnapshot.keys.length === 0
                width: parent.width
                textFormat: Text.PlainText
                text: "No provider keys are available."
                color: Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
              }

              Text {
                width: parent.width
                wrapMode: Text.WordWrap
                textFormat: Text.PlainText
                text: "Claude, Codex, Cursor, Kiro sign in through their own CLIs — no key needed."
                color: Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
              }

              Text {
                visible: !!root.svc && root.svc.settingsStatus !== ""
                width: parent.width
                wrapMode: Text.WordWrap
                textFormat: Text.PlainText
                text: root.svc ? root.svc.settingsStatus : ""
                color: Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
              }

              Button {
                width: parent.width
                text: "Save"
                bordered: true
                enabled: !!root.svc && root.svc.settingsLoaded
                  && root.svc.settingsSnapshot.ok === true && !root.svc.busy
                onClicked: root.saveProviderChanges()
              }
            }
          }
        }
      }
    }
  }

  component PrimaryMeter: Item {
    id: meter
    property var metric: null
    property bool failed: false
    readonly property int percent: metric ? Number(metric.percent) : 0

    height: Style.spacing.xs

    Rectangle {
      anchors.fill: parent
      radius: Style.cornerRadius > 0 ? height / 2 : 0
      color: Color.muted
      opacity: 0.24
    }

    Rectangle {
      visible: !!meter.metric
      width: parent.width * Math.max(0, Math.min(100, meter.percent)) / 100
      height: parent.height
      radius: Style.cornerRadius > 0 ? height / 2 : 0
      color: Model.severityColor(meter.percent, root.palette, meter.failed)
    }
  }

  component ClaudeAccountRow: Item {
    id: claudeRow
    required property var entry
    readonly property var metrics: Model.claudeMetrics(entry)
    readonly property bool active: Model.isActiveEntry(entry)
    readonly property bool switchable: Model.isSwitchableEntry(entry)
    readonly property bool failed: entry.status === "error" || String(entry.error || "") !== ""
    readonly property int primaryPercent: metrics.primary ? Number(metrics.primary.percent) : 0
    readonly property string detailText: failed
      ? Model.autoTextSafe(entry.error || "error", 300)
      : Model.claudeMeterCaption(entry, root.nowMs)
    readonly property var renameSource: Model.renameLabel(entry)
    property bool renaming: false
    property string renameDraft: ""

    height: claudeBody.implicitHeight
    opacity: entry.stale === true ? 0.45 : 1

    Button {
      anchors.fill: parent
      background: "transparent"
      horizontalPadding: 0
      verticalPadding: 0
      tooltipText: claudeRow.detailText
      enabled: !claudeRow.renaming
        && (!claudeRow.switchable || (!!root.svc && !root.svc.busy))
      onClicked: if (claudeRow.switchable && root.svc) root.svc.switchEntry(claudeRow.entry)
    }

    Column {
      id: claudeBody
      width: parent.width
      spacing: 0

      Row {
        id: claudeLine
        width: parent.width
        height: Style.spacing.controlHeight
        spacing: Style.spacing.labelGap

        Item {
          width: Style.spacing.huge
          height: parent.height

          BorderSurface {
            visible: claudeRow.entry.active === true || claudeRow.entry.active === false
            width: Style.spacing.xl
            height: width
            anchors.centerIn: parent
            radius: width / 2
            color: claudeRow.active ? Color.accent : "transparent"
            borderSpec: Border.flat(claudeRow.active ? Color.accent : Color.muted,
              Math.max(Style.spacing.hairline, Style.normalBorderWidth))
          }
        }

        Text {
          width: Style.spacing.huge
          anchors.verticalCenter: parent.verticalCenter
          horizontalAlignment: Text.AlignHCenter
          textFormat: Text.PlainText
          text: Model.familyGlyph(claudeRow.entry)
          color: Model.severityColor(claudeRow.primaryPercent, root.palette, claudeRow.failed)
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
        }

        Text {
          visible: !claudeRow.renaming
          width: Math.max(0, claudeLine.width - Style.spacing.huge * 2
            - claudePercent.width - renameControls.width - claudeLine.spacing * 4)
          anchors.verticalCenter: parent.verticalCenter
          elide: Text.ElideRight
          textFormat: Text.PlainText
          text: Model.claudeEntryName(claudeRow.entry)
          color: Color.foreground
          opacity: claudeRow.active ? 1 : 0.82
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
        }

        TextField {
          visible: claudeRow.renaming
          width: Math.max(0, claudeLine.width - Style.spacing.huge * 2
            - claudePercent.width - renameControls.width - claudeLine.spacing * 4)
          anchors.verticalCenter: parent.verticalCenter
          maximumLength: 32
          selectByMouse: true
          verticalPadding: Style.spacing.labelGap
          text: claudeRow.renameDraft
          onTextEdited: claudeRow.renameDraft = text
          Keys.onEscapePressed: claudeRow.renaming = false
        }

        Row {
          id: renameControls
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.spacing.xs
          visible: claudeRow.renameSource !== null

          Button {
            visible: !claudeRow.renaming
            text: "\u270e"
            fontSize: Style.font.caption
            horizontalPadding: Style.spacing.xs
            verticalPadding: Style.spacing.hairline
            tooltipText: "rename"
            enabled: !!root.svc && !root.svc.busy
            onClicked: {
              claudeRow.renameDraft = claudeRow.renameSource
              claudeRow.renaming = true
            }
          }

          Button {
            visible: claudeRow.renaming
            text: "\u2713"
            fontSize: Style.font.caption
            horizontalPadding: Style.spacing.xs
            verticalPadding: Style.spacing.hairline
            enabled: !!root.svc && !root.svc.busy
              && Model.validSaveLabel(claudeRow.renameDraft)
              && claudeRow.renameDraft !== claudeRow.renameSource
            onClicked: {
              if (root.svc.renameAccount(claudeRow.renameSource, claudeRow.renameDraft))
                claudeRow.renaming = false
            }
          }

          Button {
            visible: claudeRow.renaming
            text: "\u2715"
            fontSize: Style.font.caption
            horizontalPadding: Style.spacing.xs
            verticalPadding: Style.spacing.hairline
            onClicked: claudeRow.renaming = false
          }
        }

        Text {
          id: claudePercent
          width: Style.space(42)
          anchors.verticalCenter: parent.verticalCenter
          horizontalAlignment: Text.AlignRight
          textFormat: Text.PlainText
          text: claudeRow.metrics.primary ? claudeRow.primaryPercent + "%" : "—"
          color: claudeRow.metrics.primary
            ? Model.severityColor(claudeRow.primaryPercent, root.palette, claudeRow.failed)
            : Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
        }
      }

      PrimaryMeter {
        width: parent.width
        metric: claudeRow.metrics.primary
        failed: claudeRow.failed
      }

      Text {
        visible: claudeRow.active
        width: parent.width
        topPadding: Style.spacing.labelGap
        elide: Text.ElideRight
        maximumLineCount: 1
        textFormat: Text.PlainText
        text: Model.claudeMeterCaption(claudeRow.entry, root.nowMs)
        color: Color.muted
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
      }
    }
  }

  component AgentRow: Item {
    id: agentRow
    required property var entry
    readonly property var metrics: Model.agentMetrics(entry)
    readonly property string health: Model.firstHealthText(entry)
    readonly property bool failed: entry.status === "error" || String(entry.error || "") !== ""
    readonly property bool needsKey: Model.agentNeedsKey(entry)
    readonly property int primaryPercent: metrics.primary ? Number(metrics.primary.percent) : 0
    readonly property string detailText: failed
      ? Model.autoTextSafe(entry.error || "error", 300)
      : (metrics.primary ? Model.agentMeterCaption(agentRow.entry, root.nowMs)
        : (health || String(entry.status || "ready")))

    height: agentBody.implicitHeight
    opacity: entry.stale === true ? 0.45 : 1

    Button {
      anchors.fill: parent
      background: "transparent"
      horizontalPadding: 0
      verticalPadding: 0
      tooltipText: agentRow.detailText
      onClicked: {}
    }

    Column {
      id: agentBody
      width: parent.width
      spacing: 0

      Row {
        id: agentLine
        width: parent.width
        height: Style.spacing.controlHeight
        spacing: Style.spacing.labelGap

        Text {
          width: Style.spacing.huge
          anchors.verticalCenter: parent.verticalCenter
          horizontalAlignment: Text.AlignHCenter
          textFormat: Text.PlainText
          text: Model.familyGlyph(agentRow.entry)
          color: Model.severityColor(agentRow.primaryPercent, root.palette, agentRow.failed)
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
        }

        Text {
          width: Math.max(0, agentLine.width - Style.spacing.huge
            - agentRight.width - agentLine.spacing * 2)
          anchors.verticalCenter: parent.verticalCenter
          elide: Text.ElideRight
          textFormat: Text.PlainText
          text: Model.agentEntryName(agentRow.entry)
          color: Color.foreground
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
        }

        Item {
          id: agentRight
          width: agentRow.needsKey ? needsKeyButton.implicitWidth : Style.space(92)
          height: parent.height

          Button {
            id: needsKeyButton
            visible: agentRow.needsKey
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            text: "needs key →"
            tooltipText: agentRow.detailText
            foreground: Color.accent
            fontSize: Style.font.caption
            horizontalPadding: Style.spacing.sm
            verticalPadding: Style.spacing.labelGap
            onClicked: root.openSettings()
          }

          Text {
            visible: !agentRow.needsKey
            anchors.fill: parent
            verticalAlignment: Text.AlignVCenter
            horizontalAlignment: Text.AlignRight
            elide: Text.ElideRight
            textFormat: Text.PlainText
            text: agentRow.metrics.primary ? agentRow.primaryPercent + "%"
              : (agentRow.health || "—")
            color: agentRow.metrics.primary
              ? Model.severityColor(agentRow.primaryPercent, root.palette, agentRow.failed)
              : agentRow.failed ? Color.urgent : Color.muted
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
          }
        }
      }

      PrimaryMeter {
        visible: !agentRow.needsKey
        width: parent.width
        metric: agentRow.metrics.primary
        failed: agentRow.failed
      }
    }
  }

  component ProviderKeyRow: Column {
    id: keyRow
    required property var keyInfo
    readonly property string vendorId: String(keyInfo.id || "")
    property string pendingAction: "unchanged"
    property alias secretText: keyField.text

    function scrub() {
      keyField.text = ""
      pendingAction = "unchanged"
    }

    spacing: Style.spacing.labelGap

    Text {
      width: parent.width
      elide: Text.ElideRight
      textFormat: Text.PlainText
      text: Model.autoTextSafe(keyRow.keyInfo.label, 120)
      color: Color.foreground
      font.family: Style.font.family
      font.pixelSize: Style.font.bodySmall
    }

    Row {
      width: parent.width
      spacing: Style.spacing.controlGap

      TextField {
        id: keyField
        width: Math.max(0, parent.width - clearButton.implicitWidth - parent.spacing)
        password: true
        placeholderText: keyRow.keyInfo.configured ? "saved" : "not set"
        enabled: !!root.svc && !root.svc.busy && keyRow.pendingAction !== "clear"
        maximumLength: 16384
        onTextEdited: {
          root.settingsValidationError = ""
          keyRow.pendingAction = text.length > 0 ? "set" : "unchanged"
        }
        Keys.onEscapePressed: root.closeSettings()
        onAccepted: root.saveProviderChanges()
      }

      Button {
        id: clearButton
        anchors.verticalCenter: keyField.verticalCenter
        text: "×"
        tooltipText: keyRow.pendingAction === "clear"
          ? "Keep the stored inline key" : "Clear the stored inline key"
        active: keyRow.pendingAction === "clear"
        foreground: keyRow.pendingAction === "clear" ? Color.urgent : Color.foreground
        fontSize: Style.font.bodySmall
        horizontalPadding: Style.spacing.sm
        verticalPadding: Style.spacing.labelGap
        enabled: !!root.svc && !root.svc.busy
          && keyRow.keyInfo.inline_configured === true
        onClicked: {
          root.settingsValidationError = ""
          if (keyRow.pendingAction === "clear") {
            keyRow.pendingAction = "unchanged"
          } else {
            keyField.text = ""
            keyRow.pendingAction = "clear"
          }
        }
      }
    }

    Text {
      visible: keyRow.keyInfo.environment_configured === true
        && keyRow.keyInfo.inline_configured !== true
      width: parent.width
      elide: Text.ElideRight
      textFormat: Text.PlainText
      text: "set by " + Model.autoTextSafe(keyRow.keyInfo.environment, 160)
      color: Color.muted
      font.family: Style.font.family
      font.pixelSize: Style.font.caption
    }
  }
}
