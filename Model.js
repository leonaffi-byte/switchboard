// Pure data shaping and decision logic for Switchboard. Keep this file free
// of QML globals so the same contracts are exercised by `node --test`.

var MAX_ENTRIES = 64
var MAX_SECTIONS = 96
var FALLBACK_FAMILY_GLYPH = "󰚩"
var FAMILY_GLYPHS = {
  anthropic: "󰛄",
  openai: "󱢆",
  kimi: "󰚩",
  grok: "󰬈",
  supergrok: "󰬈",
  openrouter: "󱙺",
  deepseek: "󰧑",
  zai: "󰚩"
}

function cleanText(value, maxLength) {
  var text = value === undefined || value === null ? "" : String(value)
  text = text.replace(/[\t\r]/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")

  var limit = Number(maxLength)
  if (!isFinite(limit) || limit < 1) limit = 2048
  limit = Math.floor(limit)
  if (text.length <= limit) return text

  var end = Math.max(0, limit - 1)
  if (end > 0) {
    var finalCodeUnit = text.charCodeAt(end - 1)
    if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) end--
  }
  return text.slice(0, end) + "…"
}

// Even though every provider value is rendered with Text.PlainText, escaping
// angle brackets at the data boundary prevents a future AutoText consumer
// from turning report-controlled strings into rich text.
function autoTextSafe(value, maxLength) {
  return cleanText(value, maxLength || 2048)
    .replace(/[\n\u2028\u2029]/g, " ")
    .replace(/</g, "‹")
    .replace(/>/g, "›")
}

function finitePercent(value) {
  if (value === undefined || value === null || value === "") return null
  var number = Number(value)
  if (!isFinite(number)) return null
  return Math.max(0, Math.min(100, Math.round(number)))
}

function normalizeSection(raw) {
  if (!raw || typeof raw !== "object") return null
  var type = String(raw.type || "")
  if (type === "spacer") return { type: "spacer" }

  if (type === "metric") {
    var percent = finitePercent(raw.percent)
    if (percent === null) return null
    return {
      type: "metric",
      label: autoTextSafe(raw.label, 160),
      percent: percent,
      value: autoTextSafe(raw.value, 240),
      detail: autoTextSafe(raw.detail, 600),
      severity: severityBand(percent),
      reset_at: cleanText(raw.reset_at, 80)
    }
  }

  if (type === "text") {
    return {
      type: "text",
      label: autoTextSafe(raw.label, 160),
      value: autoTextSafe(raw.value, 600)
    }
  }

  if (type === "block") {
    var source = Array.isArray(raw.body) ? raw.body : []
    var body = []
    for (var i = 0; i < source.length && i < 24; i++)
      body.push(autoTextSafe(source[i], 600))
    return { type: "block", label: autoTextSafe(raw.label, 160), body: body }
  }
  return null
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object") return null
  var id = cleanText(raw.id, 180).trim()
  if (id === "") return null

  var sourceSections = Array.isArray(raw.sections) ? raw.sections : []
  var sections = []
  for (var i = 0; i < sourceSections.length && i < MAX_SECTIONS; i++) {
    var section = normalizeSection(sourceSections[i])
    if (section) sections.push(section)
  }

  var error = raw.error === undefined || raw.error === null
    ? "" : autoTextSafe(raw.error, 300).trim()
  var status = cleanText(raw.status, 40).trim().toLowerCase()
  if (error !== "") status = "error"
  else if (status === "") status = "ready"

  return {
    id: id,
    display_name: autoTextSafe(raw.display_name, 240),
    short_name: autoTextSafe(raw.short_name, 24),
    plan: autoTextSafe(raw.plan, 120),
    status: status,
    error: error,
    stale: raw.stale === true,
    fetched_at: cleanText(raw.fetched_at, 80),
    // Missing additive fields remain distinct from explicit false.
    active: raw.active === true ? true : raw.active === false ? false : null,
    account_label: autoTextSafe(raw.account_label, 120).trim(),
    login_unsaved: raw.login_unsaved === true,
    sections: sections
  }
}

function parseReport(raw) {
  try {
    var parsed = JSON.parse(String(raw || ""))
    if (!parsed || !Array.isArray(parsed.entries))
      return { ok: false, error: "The usage command returned an unsupported report.", primary: "", entries: [] }

    var entries = []
    for (var i = 0; i < parsed.entries.length && i < MAX_ENTRIES; i++) {
      var entry = normalizeEntry(parsed.entries[i])
      if (entry) entries.push(entry)
    }
    if (parsed.entries.length > 0 && entries.length === 0)
      return { ok: false, error: "The usage report did not contain a valid entry.", primary: "", entries: [] }
    return {
      ok: true,
      error: "",
      primary: cleanText(parsed.primary, 180).trim(),
      entries: entries
    }
  } catch (error) {
    return { ok: false, error: "The usage command returned invalid JSON.", primary: "", entries: [] }
  }
}

function familyId(entryOrId) {
  var id = entryOrId && typeof entryOrId === "object" ? entryOrId.id : entryOrId
  return String(id || "").split("@")[0]
}

function familyGlyph(entryOrFamily) {
  var family = familyId(entryOrFamily)
  return FAMILY_GLYPHS[family] || FALLBACK_FAMILY_GLYPH
}

function isClaudeEntry(entry) {
  return familyId(entry) === "anthropic"
}

function groupEntries(entries) {
  var source = Array.isArray(entries) ? entries : []
  var claude = []
  var agents = []
  for (var i = 0; i < source.length; i++) {
    if (isClaudeEntry(source[i])) claude.push(source[i])
    else agents.push(source[i])
  }
  return { claude: claude, agents: agents }
}

function metricSections(entry) {
  var sections = entry && Array.isArray(entry.sections) ? entry.sections : []
  var metrics = []
  for (var i = 0; i < sections.length; i++)
    if (sections[i] && sections[i].type === "metric" && finitePercent(sections[i].percent) !== null)
      metrics.push(sections[i])
  return metrics
}

// Claude's windows are semantic roles. Their positions vary across report
// versions, so only labels determine which meter occupies each column.
function claudeMetrics(entry) {
  var metrics = metricSections(entry)
  var primary = null
  var secondary = null
  for (var i = 0; i < metrics.length; i++) {
    var label = String(metrics[i].label || "")
    if (!primary && /5h|session/i.test(label)) primary = metrics[i]
    if (!secondary && /7d|week/i.test(label)) secondary = metrics[i]
  }
  return { primary: primary, secondary: secondary }
}

// Other agents retain the backend's own first-metric ordering. A secondary
// slot is only weekly when another metric's label actually says so.
function agentMetrics(entry) {
  var metrics = metricSections(entry)
  var primary = metrics.length > 0 ? metrics[0] : null
  var secondary = null
  for (var i = 1; i < metrics.length; i++) {
    if (/7d|week|wk/i.test(String(metrics[i].label || ""))) {
      secondary = metrics[i]
      break
    }
  }
  return { primary: primary, secondary: secondary }
}

function shortMetricLabel(label) {
  return autoTextSafe(label, 8).trim()
}

function firstHealthText(entry) {
  var sections = entry && Array.isArray(entry.sections) ? entry.sections : []
  for (var i = 0; i < sections.length; i++) {
    var section = sections[i]
    if (!section || section.type !== "text") continue
    var label = autoTextSafe(section.label, 80).trim()
    var value = autoTextSafe(section.value, 120).trim()
    return (label + (label !== "" && value !== "" ? " " : "") + value).trim()
  }
  for (var j = 0; j < sections.length; j++) {
    var block = sections[j]
    if (!block || block.type !== "block") continue
    var blockLabel = autoTextSafe(block.label, 80).trim()
    var first = Array.isArray(block.body) && block.body.length > 0
      ? autoTextSafe(block.body[0], 120).trim() : ""
    return (blockLabel + (blockLabel !== "" && first !== "" ? " " : "") + first).trim()
  }
  return ""
}

function claudeEntryName(entry) {
  if (!entry) return ""
  var id = String(entry.id || "")
  if (id.indexOf("anthropic@") === 0)
    return autoTextSafe(id.slice("anthropic@".length), 120)
  var name = autoTextSafe(entry.account_label, 120).trim()
  if (name === "") name = autoTextSafe(entry.display_name, 240).trim()
  return name === "" ? "Claude" : name
}

function agentEntryName(entry) {
  if (!entry) return ""
  var name = autoTextSafe(entry.display_name, 240).trim()
  return name === "" ? autoTextSafe(familyId(entry), 120) : name
}

function isActiveEntry(entry) {
  return !!(entry && isClaudeEntry(entry) && entry.active === true)
}

function validAccountLabel(text) {
  return /^[a-z0-9_-]{1,32}$/.test(String(text === undefined || text === null ? "" : text))
}

function switchLabel(entry) {
  if (!entry || entry.active !== false) return null
  var id = String(entry.id || "")
  var prefix = "anthropic@"
  if (id.indexOf(prefix) !== 0) return null
  var label = id.slice(prefix.length)
  return validAccountLabel(label) ? label : null
}

function isSwitchableEntry(entry) {
  return switchLabel(entry) !== null
}

function isUnsavedLoginEntry(entry) {
  return !!(entry && String(entry.id || "") === "anthropic" && entry.login_unsaved === true)
}

function unsavedLoginEntry(entries) {
  var source = Array.isArray(entries) ? entries : []
  for (var i = 0; i < source.length; i++)
    if (isUnsavedLoginEntry(source[i])) return source[i]
  return null
}

function suggestedSaveLabel(entry) {
  var plan = entry && entry.plan !== undefined && entry.plan !== null ? String(entry.plan) : ""
  var label = plan.toLowerCase().replace(/[^a-z0-9_-]/g, "")
  if (label.length > 20) label = label.slice(0, 20)
  return label === "" ? "main" : label
}

function validSaveLabel(text) {
  return validAccountLabel(text)
}

function severityBand(percent) {
  var value = finitePercent(percent)
  if (value === null || value < 50) return "low"
  if (value < 75) return "mid"
  if (value < 90) return "high"
  return "critical"
}

// This is the single severity-to-theme mapping used by both bar and panel.
function severityColor(percent, palette, forceError) {
  var colors = palette || {}
  if (forceError === true || severityBand(percent) === "critical") return colors.urgent
  if (severityBand(percent) === "high") return colors.accent
  if (severityBand(percent) === "mid") return colors.foreground
  return colors.muted
}

function formatClock(value) {
  if (value === undefined || value === null || value === "" || Number(value) <= 0) return ""
  var date = value instanceof Date ? value : new Date(Number(value))
  if (!isFinite(date.getTime())) return ""
  return ("0" + date.getHours()).slice(-2) + ":" + ("0" + date.getMinutes()).slice(-2)
}

function relativeReset(resetAtIso, nowMs) {
  if (resetAtIso === undefined || resetAtIso === null || String(resetAtIso).trim() === "") return ""
  var resetMs = new Date(String(resetAtIso)).getTime()
  var currentMs = Number(nowMs)
  if (!isFinite(resetMs) || !isFinite(currentMs) || resetMs <= currentMs) return ""

  var remainingMs = resetMs - currentMs
  var totalMinutes = Math.floor(remainingMs / 60000)
  var days = Math.floor(totalMinutes / 1440)
  if (days > 0) {
    var dayHours = Math.floor((totalMinutes % 1440) / 60)
    return "resets " + days + "d" + (dayHours > 0 ? " " + dayHours + "h" : "")
  }

  var hours = Math.floor(totalMinutes / 60)
  var minutes = totalMinutes % 60
  if (hours > 0) return "resets " + hours + "h " + minutes + "m"
  return "resets " + minutes + "m"
}

function claudeMeterCaption(entry, nowMs) {
  var pair = claudeMetrics(entry)
  var primaryReset = pair.primary ? relativeReset(pair.primary.reset_at, nowMs) : ""
  var secondaryReset = pair.secondary ? relativeReset(pair.secondary.reset_at, nowMs) : ""
  var primary = pair.primary ? "5h" + (primaryReset ? " · " + primaryReset : "") : "5h · —"
  var secondary = pair.secondary ? "7d " + pair.secondary.percent + "%"
    + (secondaryReset ? " · " + secondaryReset : "") : "7d —"
  return primary + "   ·   " + secondary
}

function agentMeterCaption(entry, nowMs) {
  var pair = agentMetrics(entry)
  var primary = "—"
  if (pair.primary) {
    var primaryLabel = shortMetricLabel(pair.primary.label) || "usage"
    var primaryReset = relativeReset(pair.primary.reset_at, nowMs)
    primary = primaryLabel + (primaryReset ? " · " + primaryReset : "")
  }

  var secondary = "—"
  if (pair.secondary) {
    var secondaryLabel = shortMetricLabel(pair.secondary.label) || "weekly"
    var secondaryReset = relativeReset(pair.secondary.reset_at, nowMs)
    secondary = secondaryLabel + " " + pair.secondary.percent + "%"
      + (secondaryReset ? " · " + secondaryReset : "")
  }
  return primary + "   ·   " + secondary
}

function activeAccountLabel(entries) {
  var source = Array.isArray(entries) ? entries : []
  var active = null
  var activeCount = 0
  for (var i = 0; i < source.length; i++) {
    var entry = source[i]
    if (!isActiveEntry(entry)) continue
    active = entry
    activeCount++
  }
  if (activeCount !== 1) return ""
  var id = String(active.id || "")
  if (id.indexOf("anthropic@") === 0) return autoTextSafe(id.slice(10), 120)
  var label = autoTextSafe(active.account_label, 120).trim()
  return label !== "" ? label : "default"
}

function entryPrimaryPercent(entry) {
  var pair = isClaudeEntry(entry) ? claudeMetrics(entry) : agentMetrics(entry)
  return pair.primary ? finitePercent(pair.primary.percent) : null
}

function familyShortName(entry, family) {
  var value = entry ? autoTextSafe(entry.short_name, 24).trim() : ""
  return value === "" ? autoTextSafe(family, 24) : value
}

function familyAggregates(entries) {
  var source = Array.isArray(entries) ? entries : []
  var byFamily = {}
  var order = []
  for (var i = 0; i < source.length; i++) {
    var entry = source[i]
    var family = familyId(entry)
    if (family === "") continue
    if (!byFamily[family]) {
      byFamily[family] = { family: family, entries: [], error: false }
      order.push(family)
    }
    byFamily[family].entries.push(entry)
    if (entry.status === "error" || String(entry.error || "") !== "") byFamily[family].error = true
  }

  var families = []
  for (var j = 0; j < order.length; j++) {
    var familyName = order[j]
    var group = byFamily[familyName]
    var representative = group.entries[0]
    var percent = null

    if (familyName === "anthropic") {
      var activeCount = 0
      for (var a = 0; a < group.entries.length; a++) {
        if (!isActiveEntry(group.entries[a])) continue
        representative = group.entries[a]
        activeCount++
      }
      if (activeCount === 1) percent = entryPrimaryPercent(representative)
    } else {
      for (var e = 0; e < group.entries.length; e++) {
        var candidatePercent = entryPrimaryPercent(group.entries[e])
        if (candidatePercent !== null && (percent === null || candidatePercent > percent)) {
          percent = candidatePercent
          representative = group.entries[e]
        }
      }
    }

    families.push({
      family: familyName,
      shortName: familyShortName(representative, familyName),
      percent: percent,
      error: group.error
    })
  }
  return families
}

function barShowsSetting(value) {
  var mode = String(value === undefined || value === null ? "" : value).trim().toLowerCase()
  return mode === "icon" || mode === "iconpct" || mode === "full" ? mode : "iconpct"
}

function barSegmentText(segment, barShows) {
  var item = segment && typeof segment === "object" ? segment : {}
  var mode = barShowsSetting(barShows)
  var glyph = item.glyph || familyGlyph(item.family)
  var percent = finitePercent(item.percent)
  if (mode === "icon") return glyph
  if (mode === "iconpct") return glyph + (percent === null ? "" : " " + percent + "%")
  var shortName = autoTextSafe(item.shortName, 24).trim()
  if (shortName === "") shortName = autoTextSafe(item.family, 24).trim()
  return glyph + (shortName === "" ? "" : " " + shortName)
    + (percent === null ? "" : " " + percent + "%")
}

function buildBarSegments(entries, barShows) {
  var families = familyAggregates(entries)
  families.sort(function(a, b) {
    if (a.family === "anthropic" && b.family !== "anthropic") return -1
    if (b.family === "anthropic" && a.family !== "anthropic") return 1
    var ap = a.percent === null ? -1 : a.percent
    var bp = b.percent === null ? -1 : b.percent
    if (ap !== bp) return bp - ap
    return a.family < b.family ? -1 : a.family > b.family ? 1 : 0
  })
  var shown = families.slice(0, 4)
  var initials = {}
  for (var initialIndex = 0; initialIndex < shown.length; initialIndex++) {
    var initial = shown[initialIndex].shortName === ""
      ? "?" : shown[initialIndex].shortName.charAt(0).toUpperCase()
    shown[initialIndex]._initial = initial
    initials[initial] = (initials[initial] || 0) + 1
  }
  var result = []
  var mode = barShowsSetting(barShows)
  for (var i = 0; i < shown.length; i++) {
    var item = shown[i]
    var segment = {
      family: item.family,
      shortName: item.shortName,
      tag: initials[item._initial] > 1 ? item.shortName : item._initial,
      glyph: familyGlyph(item.family),
      percent: item.percent,
      error: item.error,
      severity: item.error ? "critical" : severityBand(item.percent)
    }
    segment.text = barSegmentText(segment, mode)
    result.push(segment)
  }
  return result
}

function statusLine(entries) {
  var active = activeAccountLabel(entries)
  var segments = buildBarSegments(entries, "full")
  var line = "active=" + (active === "" ? "none" : autoTextSafe(active, 120))
  for (var i = 0; i < segments.length; i++) {
    line += " " + autoTextSafe(segments[i].shortName, 24) + "="
      + (segments[i].percent === null ? "–" : segments[i].percent + "%")
  }
  return line
}

function alertDecisions(entries, armedState, opts) {
  var sourceState = armedState && typeof armedState === "object" && !Array.isArray(armedState)
    ? armedState : {}
  var nextState = {}
  var stateKey
  for (stateKey in sourceState) {
    if (stateKey === "__proto__" || stateKey === "constructor" || stateKey === "prototype") continue
    nextState[stateKey] = sourceState[stateKey] === true
  }

  var options = opts && typeof opts === "object" ? opts : {}
  var enabled = options.enabled === undefined ? options.alerts === true : options.enabled === true
  if (!enabled) return { notifications: [], armedState: nextState }

  var notifications = []
  var source = Array.isArray(entries) ? entries : []
  var levels = [
    { name: "Warn", threshold: 75 },
    { name: "Critical", threshold: 90 }
  ]

  for (var i = 0; i < source.length; i++) {
    var entry = source[i]
    if (!entry || entry.stale === true || entry.status === "error" || String(entry.error || "") !== "")
      continue
    var metric = isClaudeEntry(entry) ? claudeMetrics(entry).primary : agentMetrics(entry).primary
    var percent = metric ? finitePercent(metric.percent) : null
    if (!metric || percent === null) continue

    var metricLabel = autoTextSafe(metric.label, 160).trim() || "usage"
    var windowLabel = isClaudeEntry(entry) && /5h/i.test(metricLabel)
      ? "5h" : shortMetricLabel(metricLabel) || "usage"
    var entryId = cleanText(entry.id, 180).trim()
    var entryName = isClaudeEntry(entry) ? claudeEntryName(entry) : agentEntryName(entry)

    for (var j = 0; j < levels.length; j++) {
      var level = levels[j]
      stateKey = entryId + "\u001f" + metricLabel + "\u001f" + level.name
      var armed = sourceState[stateKey] !== false
      if (percent < level.threshold) {
        nextState[stateKey] = true
      } else {
        nextState[stateKey] = false
        if (armed) {
          notifications.push(["notify-send", "-a", "Switchboard",
            entryName + " " + windowLabel + " at " + percent + "%",
            level.name + " threshold crossed"])
        }
      }
    }
  }

  return { notifications: notifications, armedState: nextState }
}

function autoSwitchDecision(entries, opts) {
  var options = opts && typeof opts === "object" ? opts : {}
  if (options.enabled !== true) return { action: "none", reason: "off" }

  var source = Array.isArray(entries) ? entries : []
  var active = null
  var activeCount = 0
  for (var i = 0; i < source.length; i++) {
    if (isActiveEntry(source[i])) {
      active = source[i]
      activeCount++
    }
  }
  var activeMetric = active ? claudeMetrics(active).primary : null
  var activePct = activeMetric ? finitePercent(activeMetric.percent) : null
  if (activeCount !== 1 || !active || active.stale === true || active.status !== "ready"
      || String(active.error || "") !== "" || activePct === null)
    return { action: "none", reason: "no-fresh-data" }

  if (unsavedLoginEntry(source)) return { action: "none", reason: "unsaved-login" }

  var threshold = Number(options.threshold)
  if (!isFinite(threshold)) threshold = 85
  if (activePct < threshold) return { action: "none", reason: "under-threshold" }

  var margin = Number(options.marginPts)
  if (!isFinite(margin)) margin = 10
  var candidates = []
  for (var j = 0; j < source.length; j++) {
    var candidate = source[j]
    var label = switchLabel(candidate)
    if (label === null || candidate.status !== "ready" || candidate.stale === true
        || String(candidate.error || "") !== "") continue
    var metric = claudeMetrics(candidate).primary
    var percent = metric ? finitePercent(metric.percent) : null
    if (percent !== null && percent <= threshold - margin)
      candidates.push({ label: label, percent: percent })
  }
  if (candidates.length === 0) return { action: "none", reason: "no-candidate" }

  var nowMs = Number(options.nowMs)
  var lastSwitchMs = Number(options.lastSwitchMs)
  var cooldownMs = Number(options.cooldownMs)
  if (!isFinite(cooldownMs)) cooldownMs = 600000
  if (lastSwitchMs > 0 && isFinite(nowMs) && nowMs - lastSwitchMs < cooldownMs)
    return { action: "none", reason: "cooldown" }

  candidates.sort(function(a, b) {
    if (a.percent !== b.percent) return a.percent - b.percent
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0
  })
  return {
    action: "switch",
    label: candidates[0].label,
    fromLabel: activeAccountLabel([active]) || "default",
    fromPct: activePct,
    toPct: candidates[0].percent
  }
}

// The auto card keeps only events. Skip decisions never enter this state.
function autoSwitchStatus(enabled, event) {
  if (enabled !== true) return "off"
  if (!event || typeof event !== "object") return "armed"
  if (event.kind === "last") {
    var from = autoTextSafe(event.from, 120)
    var to = autoTextSafe(event.to, 120)
    var clock = formatClock(event.atMs)
    return "last: " + from + " → " + to + (clock === "" ? "" : " " + clock)
  }
  if (event.kind === "failed") return "failed: " + stderrLine(event.message)
  return "armed"
}

// Redaction must run before any cleanup or truncation. Long token/path-like
// runs disappear while ordinary diagnostic prose remains readable.
function stderrLine(value) {
  var redacted = String(value === undefined || value === null ? "" : value)
    .replace(/[A-Za-z0-9_.-]{20,}/g, "…")
  return autoTextSafe(redacted, 300).trim()
}

function booleanSetting(value, fallback) {
  if (value === true || value === false) return value
  var normalized = String(value === undefined || value === null ? "" : value).trim().toLowerCase()
  if (["true", "1", "yes", "on"].indexOf(normalized) >= 0) return true
  if (["false", "0", "no", "off"].indexOf(normalized) >= 0) return false
  return fallback === true
}

function integerSetting(value, fallback, low, high, step) {
  var number = Number(value)
  if (!isFinite(number)) number = Number(fallback)
  number = Math.round(number)
  number = Math.max(Number(low), Math.min(Number(high), number))
  var quantum = Number(step)
  if (isFinite(quantum) && quantum > 1)
    number = Number(low) + Math.round((number - Number(low)) / quantum) * quantum
  return Math.max(Number(low), Math.min(Number(high), number))
}

function settingsWithOverrides(settings, moduleName, overrides) {
  var moduleId = cleanText(moduleName, 180).trim()
  if (moduleId === "" || !overrides || typeof overrides !== "object" || Array.isArray(overrides))
    return null

  var next = { id: moduleId }
  var current = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {}
  var key
  for (key in current) {
    if (key === "id" || key === "__proto__" || key === "constructor" || key === "prototype") continue
    next[key] = current[key]
  }
  for (key in overrides) {
    if (key === "id" || key === "__proto__" || key === "constructor" || key === "prototype") continue
    next[key] = overrides[key]
  }
  return next
}

function binaryCandidates(env) {
  var source = env && typeof env === "object" ? env : {}
  var result = []
  var override = String(source.AIUSAGEBAR_BIN || "")
  var home = String(source.HOME || "")
  if (override !== "") result.push(override)
  if (home !== "") result.push(home + "/.local/bin/ai-usagebar")
  result.push("ai-usagebar")
  return result
}
