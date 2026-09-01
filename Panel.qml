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
      if (flick) flick.contentY = 0
      syncSaveDraft()
      Qt.callLater(function() { keyCatcher.forceActiveFocus() })
    }
  }
  onSvcChanged: Qt.callLater(syncSaveDraft)

  Connections {
    target: root.svc
    function onEntriesChanged() { Qt.callLater(root.syncSaveDraft) }
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

  component MetricGauge: Item {
    id: gauge
    property var metric: null
    property string label: ""
    readonly property int percent: metric ? Number(metric.percent) : 0

    implicitWidth: Style.space(135)
    implicitHeight: Math.max(labelText.implicitHeight, track.implicitHeight, valueText.implicitHeight)

    Row {
      anchors.fill: parent
      spacing: Style.space(4)

      Text {
        id: labelText
        width: Style.space(34)
        anchors.verticalCenter: parent.verticalCenter
        elide: Text.ElideRight
        textFormat: Text.PlainText
        text: gauge.label
        color: Color.muted
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
      }

      Item {
        id: track
        width: Style.space(58)
        height: Style.space(4)
        implicitHeight: height
        anchors.verticalCenter: parent.verticalCenter

        Rectangle {
          anchors.fill: parent
          radius: Style.cornerRadius > 0 ? height / 2 : 0
          color: Color.muted
          opacity: 0.24
        }

        Rectangle {
          visible: !!gauge.metric
          width: parent.width * Math.max(0, Math.min(100, gauge.percent)) / 100
          height: parent.height
          radius: Style.cornerRadius > 0 ? height / 2 : 0
          color: Model.severityColor(gauge.percent, root.palette, false)
        }
      }

      Text {
        id: valueText
        width: Style.space(30)
        anchors.verticalCenter: parent.verticalCenter
        horizontalAlignment: Text.AlignRight
        textFormat: Text.PlainText
        text: gauge.metric ? gauge.percent + "%" : "—"
        color: gauge.metric
          ? Model.severityColor(gauge.percent, root.palette, false) : Color.muted
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
      }
    }
  }

  component ClaudeAccountRow: Item {
    id: claudeRow
    required property var entry
    readonly property var metrics: Model.claudeMetrics(entry)
    readonly property bool active: Model.isActiveEntry(entry)
    readonly property bool switchable: Model.isSwitchableEntry(entry)

    height: Style.space(31)
    opacity: entry.stale === true ? 0.45 : 1

    MouseArea {
      anchors.fill: parent
      enabled: claudeRow.switchable && !!root.svc && !root.svc.busy
      cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
      onClicked: root.svc.switchEntry(claudeRow.entry)
    }

    Row {
      anchors.fill: parent
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
        width: Style.space(112)
        anchors.verticalCenter: parent.verticalCenter
        elide: Text.ElideRight
        textFormat: Text.PlainText
        text: Model.claudeEntryName(claudeRow.entry)
        color: Color.foreground
        opacity: claudeRow.active ? 1 : 0.82
        font.family: Style.font.family
        font.pixelSize: Style.font.bodySmall
      }

      BorderSurface {
        width: Style.space(72)
        height: Style.space(20)
        anchors.verticalCenter: parent.verticalCenter
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
          text: claudeRow.entry.plan || "—"
          color: Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
        }
      }

      MetricGauge {
        width: Style.space(135)
        height: parent.height
        label: "5h"
        metric: claudeRow.metrics.primary
      }

      MetricGauge {
        width: Style.space(135)
        height: parent.height
        label: "7d"
        metric: claudeRow.metrics.secondary
      }

      Text {
        width: Style.space(48)
        anchors.verticalCenter: parent.verticalCenter
        horizontalAlignment: Text.AlignRight
        textFormat: Text.PlainText
        text: Model.resetClock(claudeRow.metrics.primary)
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
    readonly property string rowStatus: failed
      ? (String(entry.error || "") || "error")
      : entry.stale === true ? "cached" : (String(entry.status || "") || "ready")

    height: Style.space(30)
    opacity: entry.stale === true ? 0.45 : 1

    Row {
      anchors.fill: parent
      spacing: Style.space(6)

      Text {
        width: Style.space(140)
        anchors.verticalCenter: parent.verticalCenter
        elide: Text.ElideRight
        textFormat: Text.PlainText
        text: Model.agentEntryName(agentRow.entry)
        color: Color.foreground
        font.family: Style.font.family
        font.pixelSize: Style.font.bodySmall
      }

      MetricGauge {
        visible: !!agentRow.metrics.primary
        width: visible ? Style.space(165) : 0
        height: parent.height
        label: agentRow.metrics.primary ? Model.shortMetricLabel(agentRow.metrics.primary.label) : ""
        metric: agentRow.metrics.primary
      }

      Text {
        visible: !agentRow.metrics.primary
        width: visible ? Style.space(165) : 0
        anchors.verticalCenter: parent.verticalCenter
        elide: Text.ElideRight
        textFormat: Text.PlainText
        text: agentRow.health || "—"
        color: agentRow.failed ? Color.urgent : Color.muted
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
      }

      Text {
        width: Style.space(105)
        anchors.verticalCenter: parent.verticalCenter
        elide: Text.ElideRight
        textFormat: Text.PlainText
        text: agentRow.metrics.secondary
          ? Model.shortMetricLabel(agentRow.metrics.secondary.label) + " " + agentRow.metrics.secondary.percent + "%"
          : "—"
        color: agentRow.metrics.secondary
          ? Model.severityColor(agentRow.metrics.secondary.percent, root.palette, false) : Color.muted
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
      }

      Text {
        width: parent.width - Style.space(428)
        anchors.verticalCenter: parent.verticalCenter
        elide: Text.ElideRight
        textFormat: Text.PlainText
        text: agentRow.rowStatus
        color: agentRow.failed ? Color.urgent : Color.muted
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
      }
    }
  }
}
