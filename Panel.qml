import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui
import "Model.js" as Model

// One-screen dashboard. All processes and decisions remain in Service.qml;
// this file only renders normalized state and forwards deliberate actions.
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

  property string saveDraft: ""
  property string saveDraftEntryId: ""
  property double nowMs: Date.now()

  function switchPanel(direction) {
    if (bar && typeof bar.switchPanelFrom === "function")
      return bar.switchPanelFrom(barIdentity, direction)
    return false
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

  onOpenedChanged: {
    if (opened) {
      nowMs = Date.now()
      if (flick) flick.contentY = 0
      syncSaveDraft()
      Qt.callLater(function() { keyCatcher.forceActiveFocus() })
    }
  }
  onSvcChanged: Qt.callLater(syncSaveDraft)

  Connections {
    target: root.svc
    function onEntriesChanged() {
      root.nowMs = Date.now()
      Qt.callLater(root.syncSaveDraft)
    }
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
    centerOnBar: true
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(640))
    contentHeight: panel.fittedContentHeight(content.implicitHeight, Style.space(720))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(text) {
        if ((text === "r" || text === "R") && root.svc && !root.svc.busy)
          root.svc.manualRefresh()
      }

      Flickable {
        id: flick
        anchors.fill: parent
        contentWidth: width
        contentHeight: content.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: flick.interactive ? ScrollBar.AsNeeded : ScrollBar.AlwaysOff }

        Column {
          id: content
          width: flick.width
          spacing: Style.space(10)

          Column {
            id: dashboard
            width: parent.width
            spacing: Style.space(10)
            visible: !root.svc || !root.svc.binaryMissing

            // ------------------------------------------------------ header
            Item {
              width: parent.width
              height: Math.max(title.implicitHeight, refreshButton.implicitHeight)

              Text {
                id: title
                anchors.left: parent.left
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                text: "Switchboard"
                color: Color.foreground
                font.family: Style.font.family
                font.pixelSize: Style.font.heading
                font.bold: true
              }

              Button {
                id: refreshButton
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                text: "Refresh"
                fontSize: Style.font.caption
                horizontalPadding: Style.space(7)
                verticalPadding: Style.space(4)
                enabled: !!root.svc && !root.svc.busy
                onClicked: root.svc.manualRefresh()
              }

              Text {
                anchors.right: refreshButton.left
                anchors.rightMargin: Style.space(8)
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                text: root.svc ? root.svc.lastRefreshClock : ""
                color: Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
              }
            }

            Text {
              visible: !root.svc || !root.svc.hasReport
              width: parent.width
              topPadding: Style.space(14)
              bottomPadding: Style.space(14)
              horizontalAlignment: Text.AlignHCenter
              textFormat: Text.PlainText
              text: "loading…"
              color: Color.muted
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
            }

            Column {
              width: parent.width
              spacing: Style.space(5)
              visible: !!root.svc && root.svc.hasReport

              // ---------------------------------------------------- Claude
              Text {
                textFormat: Text.PlainText
                text: "CLAUDE"
                color: Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
                font.bold: true
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

              Item {
                visible: !!root.svc && !!root.svc.unsavedEntry
                width: parent.width
                height: visible ? Math.max(saveField.implicitHeight, saveButton.implicitHeight) : 0

                Row {
                  anchors.left: parent.left
                  anchors.verticalCenter: parent.verticalCenter
                  spacing: Style.space(7)

                  Text {
                    width: Style.space(100)
                    anchors.verticalCenter: parent.verticalCenter
                    textFormat: Text.PlainText
                    text: "unsaved login"
                    color: Color.muted
                    font.family: Style.font.family
                    font.pixelSize: Style.font.caption
                  }

                  TextField {
                    id: saveField
                    width: Style.space(190)
                    enabled: !!root.svc && !root.svc.busy
                    maximumLength: 32
                    selectByMouse: true
                    verticalPadding: Style.space(4)
                    onTextEdited: root.saveDraft = text
                  }

                  Button {
                    id: saveButton
                    text: "Save"
                    fontSize: Style.font.caption
                    horizontalPadding: Style.space(7)
                    verticalPadding: Style.space(4)
                    enabled: !!root.svc && !root.svc.busy && Model.validSaveLabel(root.saveDraft)
                    onClicked: root.svc.saveAccount(root.saveDraft)
                  }
                }
              }

              // ----------------------------------------------------- agents
              Text {
                topPadding: Style.space(4)
                textFormat: Text.PlainText
                text: "AGENTS"
                color: Color.muted
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
                font.bold: true
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

            // ------------------------------------------------ auto-switch
            BorderSurface {
              visible: !!root.svc && root.svc.hasReport
              width: parent.width
              height: visible ? autoColumn.implicitHeight + Style.space(14) : 0
              radius: Style.cornerRadius
              color: Style.normalFillFor(Color.foreground, Color.accent)
              borderSpec: Border.controlSpec("normal", Color.foreground, Color.accent)

              Column {
                id: autoColumn
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                anchors.leftMargin: Style.space(8)
                anchors.rightMargin: Style.space(8)
                spacing: Style.space(4)

                Row {
                  width: parent.width
                  spacing: Style.space(7)

                  Text {
                    width: Style.space(145)
                    anchors.verticalCenter: parent.verticalCenter
                    textFormat: Text.PlainText
                    text: "Auto-switch Claude"
                    color: Color.foreground
                    font.family: Style.font.family
                    font.pixelSize: Style.font.bodySmall
                  }

                  ToggleSwitch {
                    anchors.verticalCenter: parent.verticalCenter
                    checked: root.svc ? root.svc.autoSwitch : false
                    trackHeight: Style.space(16)
                    busy: !root.hostWidget
                    onToggled: if (root.hostWidget)
                      root.hostWidget.setAutoSwitch(!(root.svc && root.svc.autoSwitch))
                  }

                  Text {
                    anchors.verticalCenter: parent.verticalCenter
                    textFormat: Text.PlainText
                    text: "when 5h ≥"
                    color: Color.muted
                    font.family: Style.font.family
                    font.pixelSize: Style.font.caption
                  }

                  Button {
                    anchors.verticalCenter: parent.verticalCenter
                    text: "−"
                    fontSize: Style.font.caption
                    horizontalPadding: Style.space(5)
                    verticalPadding: Style.space(3)
                    enabled: !!root.svc && root.svc.autoThreshold > 50
                    onClicked: root.hostWidget.setAutoThreshold(root.svc.autoThreshold - 5)
                  }

                  Text {
                    width: Style.space(24)
                    anchors.verticalCenter: parent.verticalCenter
                    horizontalAlignment: Text.AlignHCenter
                    textFormat: Text.PlainText
                    text: root.svc ? String(root.svc.autoThreshold) : "85"
                    color: Color.foreground
                    font.family: Style.font.family
                    font.pixelSize: Style.font.caption
                  }

                  Button {
                    anchors.verticalCenter: parent.verticalCenter
                    text: "+"
                    fontSize: Style.font.caption
                    horizontalPadding: Style.space(5)
                    verticalPadding: Style.space(3)
                    enabled: !!root.svc && root.svc.autoThreshold < 95
                    onClicked: root.hostWidget.setAutoThreshold(root.svc.autoThreshold + 5)
                  }

                  Text {
                    anchors.verticalCenter: parent.verticalCenter
                    textFormat: Text.PlainText
                    text: "%"
                    color: Color.muted
                    font.family: Style.font.family
                    font.pixelSize: Style.font.caption
                  }
                }

                Text {
                  width: parent.width
                  elide: Text.ElideRight
                  textFormat: Text.PlainText
                  text: root.svc ? root.svc.autoStatusText : "off"
                  color: root.svc && root.svc.autoStatusText.indexOf("failed:") === 0
                    ? Color.urgent : Color.muted
                  font.family: Style.font.family
                  font.pixelSize: Style.font.caption
                }
              }
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
      }
    }
  }

  component PlanTag: BorderSurface {
    id: tag
    property string plan: ""

    width: Style.space(88)
    height: Style.space(20)
    radius: Style.cornerRadius
    color: Style.normalFillFor(Color.foreground, Color.accent)
    borderSpec: Border.controlSpec("normal", Color.foreground, Color.accent)

    Text {
      anchors.fill: parent
      anchors.leftMargin: Style.space(4)
      anchors.rightMargin: Style.space(4)
      verticalAlignment: Text.AlignVCenter
      horizontalAlignment: Text.AlignHCenter
      elide: Text.ElideRight
      textFormat: Text.PlainText
      text: tag.plan || "—"
      color: Color.muted
      font.family: Style.font.family
      font.pixelSize: Style.font.caption
    }
  }

  component PrimaryMeter: Item {
    id: meter
    property var metric: null
    property bool failed: false
    readonly property int percent: metric ? Number(metric.percent) : 0

    height: Style.space(4)

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

    height: Style.space(50)
    opacity: entry.stale === true ? 0.45 : 1

    MouseArea {
      anchors.fill: parent
      enabled: claudeRow.switchable && !!root.svc && !root.svc.busy
      cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
      onClicked: root.svc.switchEntry(claudeRow.entry)
    }

    Column {
      anchors.fill: parent
      spacing: Style.space(3)

      Row {
        id: claudeLine
        width: parent.width
        height: Style.space(20)
        spacing: Style.space(5)

        Item {
          width: Style.space(18)
          height: parent.height

          BorderSurface {
            visible: claudeRow.entry.active === true || claudeRow.entry.active === false
            width: Style.space(12)
            height: width
            anchors.centerIn: parent
            radius: width / 2
            color: claudeRow.active ? Color.accent : "transparent"
            borderSpec: Border.flat(claudeRow.active ? Color.accent : Color.muted, 1)
          }
        }

        Text {
          width: Style.space(18)
          anchors.verticalCenter: parent.verticalCenter
          horizontalAlignment: Text.AlignHCenter
          textFormat: Text.PlainText
          text: Model.familyGlyph(claudeRow.entry)
          color: Model.severityColor(claudeRow.primaryPercent, root.palette, claudeRow.failed)
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
        }

        Text {
          width: Style.space(205)
          anchors.verticalCenter: parent.verticalCenter
          elide: Text.ElideRight
          textFormat: Text.PlainText
          text: Model.claudeEntryName(claudeRow.entry)
          color: Color.foreground
          opacity: claudeRow.active ? 1 : 0.82
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
        }

        PlanTag {
          id: claudePlanTag
          plan: claudeRow.entry.plan
        }

        Item {
          width: Math.max(0, claudeLine.width - Style.space(18) - Style.space(18)
            - Style.space(205) - claudePlanTag.width - Style.space(45) - 5 * claudeLine.spacing)
          height: 1
        }

        Text {
          width: Style.space(45)
          anchors.verticalCenter: parent.verticalCenter
          horizontalAlignment: Text.AlignRight
          textFormat: Text.PlainText
          text: claudeRow.metrics.primary ? claudeRow.primaryPercent + "%" : "—"
          color: claudeRow.metrics.primary
            ? Model.severityColor(claudeRow.primaryPercent, root.palette, claudeRow.failed) : Color.muted
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
        width: parent.width
        elide: Text.ElideRight
        maximumLineCount: 1
        textFormat: Text.PlainText
        text: Model.claudeMeterCaption(claudeRow.entry, root.nowMs)
        color: claudeRow.failed ? Color.urgent : Color.muted
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
    readonly property string rowStatus: failed
      ? (String(entry.error || "") || "error")
      : entry.stale === true ? "cached" : (String(entry.status || "") || "ready")
    readonly property int primaryPercent: metrics.primary ? Number(metrics.primary.percent) : 0
    readonly property string captionText: metrics.primary
      ? Model.agentMeterCaption(agentRow.entry, root.nowMs) + "   ·   " + rowStatus
      : (failed ? rowStatus : (health || "—") + "   ·   " + rowStatus)

    height: Style.space(50)
    opacity: entry.stale === true ? 0.45 : 1

    Column {
      anchors.fill: parent
      spacing: Style.space(3)

      Row {
        id: agentLine
        width: parent.width
        height: Style.space(20)
        spacing: Style.space(5)

        Text {
          width: Style.space(18)
          anchors.verticalCenter: parent.verticalCenter
          horizontalAlignment: Text.AlignHCenter
          textFormat: Text.PlainText
          text: Model.familyGlyph(agentRow.entry)
          color: Model.severityColor(agentRow.primaryPercent, root.palette, agentRow.failed)
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
        }

        Text {
          width: Style.space(225)
          anchors.verticalCenter: parent.verticalCenter
          elide: Text.ElideRight
          textFormat: Text.PlainText
          text: Model.agentEntryName(agentRow.entry)
          color: Color.foreground
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
        }

        PlanTag {
          id: agentPlanTag
          plan: agentRow.entry.plan
        }

        Item {
          width: Math.max(0, agentLine.width - Style.space(18) - Style.space(225)
            - agentPlanTag.width - Style.space(45) - 4 * agentLine.spacing)
          height: 1
        }

        Text {
          width: Style.space(45)
          anchors.verticalCenter: parent.verticalCenter
          horizontalAlignment: Text.AlignRight
          textFormat: Text.PlainText
          text: agentRow.metrics.primary ? agentRow.primaryPercent + "%" : "—"
          color: agentRow.metrics.primary
            ? Model.severityColor(agentRow.primaryPercent, root.palette, agentRow.failed)
            : agentRow.failed ? Color.urgent : Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
        }
      }

      PrimaryMeter {
        width: parent.width
        metric: agentRow.metrics.primary
        failed: agentRow.failed
      }

      Text {
        width: parent.width
        elide: Text.ElideRight
        maximumLineCount: 1
        textFormat: Text.PlainText
        text: agentRow.captionText
        color: agentRow.failed ? Color.urgent : Color.muted
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
      }
    }
  }
}
