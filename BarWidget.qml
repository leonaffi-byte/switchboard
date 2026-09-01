import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Thin bar surface: it bridges per-widget settings into the singleton,
// provides the shell's panel lifecycle, and forwards clicks to the service.
BarWidget {
  id: root
  moduleName: "leoom.switchboard"

  readonly property var svc: bar && bar.shell
    ? bar.shell.serviceFor("leoom.switchboard") : null
  property var attachedService: null
  readonly property var palette: ({
    muted: Color.muted,
    foreground: Color.foreground,
    accent: Color.accent,
    urgent: Color.urgent
  })

  function settingsSnapshot() {
    return {
      refreshIntervalSec: Model.integerSetting(setting("refreshIntervalSec", 300), 300, 60, 3600, 30),
      barShows: Model.barShowsSetting(setting("barShows", "claude")),
      autoSwitch: Model.booleanSetting(setting("autoSwitch", false), false),
      autoThreshold: Model.integerSetting(setting("autoThreshold", 85), 85, 50, 95, 5),
      alerts: Model.booleanSetting(setting("alerts", false), false)
    }
  }

  function connectService() {
    if (attachedService && attachedService !== svc)
      attachedService.unregisterWidget(root)
    attachedService = svc
    if (attachedService) {
      attachedService.registerWidget(root)
      attachedService.configure(settingsSnapshot())
    }
  }

  function pushSettings() {
    if (svc) svc.configure(settingsSnapshot())
  }

  function persistWidgetSettings(values) {
    var entry = Model.settingsWithOverrides(root.settings, root.moduleName, values)
    if (!entry) return false
    root.settings = entry
    if (bar && bar.shell && typeof bar.shell.updateEntryInline === "function")
      bar.shell.updateEntryInline(root.moduleName, entry)
    return true
  }

  function setAutoSwitch(enabled) {
    persistWidgetSettings({ autoSwitch: enabled === true })
  }

  function setBarShows(value) {
    persistWidgetSettings({ barShows: Model.barShowsSetting(value) })
  }

  function setRefreshInterval(value) {
    persistWidgetSettings({
      refreshIntervalSec: Model.integerSetting(value, 300, 60, 3600, 30)
    })
  }

  function setAlerts(enabled) {
    persistWidgetSettings({ alerts: enabled === true })
  }

  function setAutoThreshold(value) {
    persistWidgetSettings({
      autoThreshold: Model.integerSetting(value, 85, 50, 95, 5)
    })
  }

  // ---- Always-loaded panel lifecycle required by bar popout routing.
  readonly property var panelItem: panelLoader.item
  readonly property bool panelOpened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function togglePanel() { if (panelLoader.item) panelLoader.item.toggle() }

  readonly property real openPanelIndicatorWidth: button.implicitWidth
  readonly property real openPanelIndicatorHeight: Math.max(Style.space(10), Math.round(Style.bar.iconSlot * 0.55))
  readonly property bool popoutSwitchClosing: panelLoader.item
    ? panelLoader.item.popoutSwitchClosing === true : false
  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: {
    injectPanel()
    Qt.callLater(connectService)
  }
  onSettingsChanged: {
    injectPanel()
    pushSettings()
  }
  onSvcChanged: connectService()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: ""
    labelVisible: false
    hasVisualContent: true
    fixedWidth: segmentRow.implicitWidth + scaledHorizontalMargin * 2
    fontSize: Style.font.caption
    dimmed: root.svc ? root.svc.anyStale : false
    tooltipText: root.svc
      ? Model.barTooltip(root.svc.entries, root.svc.barShows) : "Switchboard"

    onPressed: function(buttonCode) {
      if (buttonCode === Qt.MiddleButton) {
        if (root.svc) root.svc.manualRefresh()
      } else if (buttonCode === Qt.LeftButton) {
        root.togglePanel()
      }
    }

    Row {
      id: segmentRow
      anchors.centerIn: parent
      spacing: Style.spacing.sm

      Text {
        visible: !root.svc || root.svc.barSegments.length === 0
        textFormat: Text.PlainText
        text: root.svc && root.svc.hasReport ? "—" : "…"
        color: Color.muted
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
      }

      Repeater {
        model: root.svc ? root.svc.barSegments : []

        delegate: Row {
          required property var modelData
          required property int index
          spacing: Style.spacing.sm

          Text {
            visible: index > 0
            textFormat: Text.PlainText
            text: "·"
            color: Color.muted
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
          }

          // Some Nerd glyphs advance zero pixels and would paint under the
          // digits that follow; a fixed-width box guarantees separation.
          Text {
            width: Style.spacing.xxl
            horizontalAlignment: Text.AlignHCenter
            textFormat: Text.PlainText
            text: modelData.glyph
            color: Model.severityColor(modelData.percent, root.palette, modelData.error)
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
          }

          Text {
            visible: String(modelData.value || "") !== ""
            textFormat: Text.PlainText
            text: modelData.value
            color: Model.severityColor(modelData.percent, root.palette, modelData.error)
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
          }
        }
      }
    }
  }

  Component.onCompleted: Qt.callLater(root.connectService)
  Component.onDestruction: if (attachedService) attachedService.unregisterWidget(root)
}
