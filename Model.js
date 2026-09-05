// Pure data shaping and decision logic for Switchboard. Keep this file free
// of QML globals so the same contracts are exercised by `node --test`.

var MAX_ENTRIES = 64
var MAX_SECTIONS = 96
// 64 entries x a few metric windows x 2 levels stays far below this.
var ALERT_STATE_MAX_KEYS = 1024
var WRAPPER_SCRIPT = "deadline=$1; cap=$2; expected=$3; backend=$4; shift 4\n# Defense in depth: the caller already spawns us with a cleared, allow-listed\n# environment; drop anything that could still influence bash, the tools, or the\n# backend's dynamic loader.\nunset BASH_ENV ENV BASH_FUNC_printf%% LD_PRELOAD LD_AUDIT LD_LIBRARY_PATH GLIBC_TUNABLES\n# Trusted absolute tools only: PATH is never consulted anywhere in this wrapper.\n# Both bash levels run --norc --noprofile: no user or system startup file is ever\n# sourced, whatever stdio the caller provides (bash would otherwise read ~/.bashrc\n# when stdin is a socket).\nTIMEOUT=/usr/bin/timeout; BASH=/usr/bin/bash; STAT=/usr/bin/stat; SHA=/usr/bin/sha256sum; ID=/usr/bin/id\nfail() { /usr/bin/printf 'switchboard: %s\\n' \"$1\" >&2; exit \"$2\"; }\ncase \"$backend\" in /*) ;; *) fail \"backend path must be absolute\" 126;; esac\n[ -L \"$backend\" ] && fail \"backend path is a symlink\" 126\n[ -r \"$backend\" ] || fail \"backend not found or not readable: $backend\" 127\ndir=${backend%/*}\ndmeta=$(\"$STAT\" -L -c '%u:%a' \"$dir\" 2>/dev/null) || fail \"cannot stat backend directory\" 126\nme=$(\"$ID\" -u)\ndowner=${dmeta%%:*}; dmode=${dmeta#*:}\n{ [ \"$downer\" = \"$me\" ] || [ \"$downer\" = 0 ]; } || fail \"backend directory is not owned by you or root\" 126\n[ $(( 8#$dmode & 8#22 )) -eq 0 ] || fail \"backend directory is writable by group or others\" 126\nexec 9< \"$backend\"\n# Every check below runs on the OPEN descriptor, and the same descriptor is what\n# gets executed: there is no reopen-by-name between verification and execution.\nmeta=$(\"$STAT\" -L -c '%F:%u:%a' /dev/fd/9 2>/dev/null) || fail \"cannot stat backend\" 126\nftype=${meta%%:*}; rest=${meta#*:}; owner=${rest%%:*}; mode=${rest#*:}\n[ \"$ftype\" = \"regular file\" ] || fail \"backend is not a regular file\" 126\n{ [ \"$owner\" = \"$me\" ] || [ \"$owner\" = 0 ]; } || fail \"backend is not owned by you or root\" 126\n[ $(( 8#$mode & 8#22 )) -eq 0 ] || fail \"backend is writable by group or others\" 126\n[ $(( 8#$mode & 8#7000 )) -eq 0 ] || fail \"backend is setuid or setgid\" 126\nif [ \"$expected\" != \"-\" ]; then\n  actual=$(\"$SHA\" /dev/fd/9 2>/dev/null); actual=${actual%% *}\n  [ \"$actual\" = \"$expected\" ] || fail \"backend integrity check failed: not the pinned build\" 126\nfi\n# timeout (no --foreground) owns the process group: the deadline and a SIGTERM from\n# component destruction both terminate the whole tree. The cappers run inside the timed\n# command as pipeline members so every byte is flushed before the managed process exits.\nexec \"$TIMEOUT\" --kill-after=5 \"$deadline\" \"$BASH\" --norc --noprofile -c 'cap=$1; shift\n{ \"$@\" 2>&1 1>&3 | /usr/bin/head -c 65536 >&2; exit \"${PIPESTATUS[0]}\"; } 3>&1 | /usr/bin/head -c \"$((cap + 1))\"\nexit \"${PIPESTATUS[0]}\"' _ \"$cap\" /dev/fd/9 \"$@\"\n"
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

// Keep all command data in argv. The fixed shell wrapper refers only to its
// positional parameters, so paths, labels, and subcommand arguments are never
// interpreted as shell source.
// The producer cap is in BYTES; QML strings measure UTF-16 units. Count UTF-8
// bytes so a truncated non-ASCII payload can never be mistaken for a complete one.
function utf8ByteLength(text) {
  var value = text === undefined || text === null ? "" : String(text)
  try {
    return unescape(encodeURIComponent(value)).length
  } catch (error) {
    return value.length * 3
  }
}

// The reviewed, pinned backend release (leonaffi-byte/ai-usagebar tag v1.9.1-whkey.4).
var BACKEND_SHA256 = "94573a090d08f5ec460341897ac54652d0d4750687adc120b1185d30c25129a2"
var TRUSTED_BACKEND_SUBPATH = "/.local/share/switchboard/backend/ai-usagebar"
// Release binding: leonaffi-byte/ai-usagebar tag v1.9.1-whkey.4, asset
// ai-usagebar-x86_64-unknown-linux-gnu; SHA256SUMS in that release. Bumping the
// backend means a new release, a new BACKEND_SHA256 here, and the README hash.

// The only environment variables handed to the wrapper (via /usr/bin/env -i).
// Nothing else from the shell's environment can reach bash, the tools, or the
// backend: no BASH_ENV, no exported functions, no LD_* or GLIBC tunables.
var ENVIRONMENT_ALLOWLIST = ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "DBUS_SESSION_BUS_ADDRESS",
  "WAYLAND_DISPLAY", "DISPLAY", "TMPDIR"]

function safeEnvironment(lookup) {
  var pairs = ["PATH=/usr/bin"]
  for (var i = 0; i < ENVIRONMENT_ALLOWLIST.length; i++) {
    var key = ENVIRONMENT_ALLOWLIST[i]
    var value = typeof lookup === "function" ? lookup(key) : (lookup ? lookup[key] : undefined)
    if (value === undefined || value === null) continue
    var text = String(value)
    if (text === "" || /[\u0000\n\r]/.test(text)) continue
    pairs.push(key + "=" + text)
  }
  return pairs
}

function validSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
}

// Where the backend runs from. Normal operation: the trusted path under the
// user's home, bound to the pinned release hash. A developer override (explicit
// plugin setting, absolute path) skips only the hash — ownership, regular-file
// and permission checks still apply — and is surfaced as a persistent warning.
function backendSelection(home, developerBackend) {
  var override = developerBackendSetting(developerBackend)
  if (override !== "") return { path: override, sha256: null, developer: true }
  var base = cleanText(home, 512).trim()
  if (base === "" || base.charAt(0) !== "/" || base.indexOf("\n") >= 0)
    return { path: "", sha256: BACKEND_SHA256, developer: false }
  return { path: base + TRUSTED_BACKEND_SUBPATH, sha256: BACKEND_SHA256, developer: false }
}

function developerBackendSetting(value) {
  var text = cleanText(value, 512).trim()
  if (text === "" || text.charAt(0) !== "/" || text.indexOf("\n") >= 0) return ""
  return text
}

function backendCommand(binary, args, deadlineSec, stdoutCapBytes, expectedSha256, environment) {
  if (typeof deadlineSec !== "number" || !isFinite(deadlineSec)
      || Math.floor(deadlineSec) !== deadlineSec || deadlineSec < 1 || deadlineSec > 600)
    return null
  if (typeof stdoutCapBytes !== "number" || !isFinite(stdoutCapBytes)
      || Math.floor(stdoutCapBytes) !== stdoutCapBytes
      || stdoutCapBytes < 4096 || stdoutCapBytes > 4 * 1024 * 1024)
    return null
  if (typeof binary !== "string" || binary.length === 0 || binary.charAt(0) !== "/"
      || !Array.isArray(args))
    return null
  var expected = "-"
  if (expectedSha256 !== undefined && expectedSha256 !== null) {
    if (!validSha256(expectedSha256)) return null
    expected = expectedSha256
  }

  var env = Array.isArray(environment) ? environment : ["PATH=/usr/bin"]
  for (var e = 0; e < env.length; e++) {
    if (typeof env[e] !== "string" || !/^[A-Z_][A-Z0-9_]*=[^\u0000\n\r]*$/.test(env[e])) return null
  }
  var command = ["/usr/bin/env", "-i"].concat(env).concat(["/usr/bin/bash", "--norc", "--noprofile", "-c", WRAPPER_SCRIPT,
    "switchboard-backend", String(deadlineSec), String(stdoutCapBytes), expected, binary])
  for (var i = 0; i < args.length; i++) {
    if (typeof args[i] !== "string") return null
    command.push(args[i])
  }
  return command
}

// QML passes JS arrays across context boundaries as sequence wrappers, for
// which Array.isArray can be false while length-indexing still works. Every
// report-data gate goes through this coercion so panel views see the same
// sections the service parsed.
function listOf(value) {
  if (Array.isArray(value)) return value
  if (value && typeof value === "object" && typeof value.length === "number") {
    var out = []
    var count = Math.min(Number(value.length) || 0, 4096)
    for (var i = 0; i < count; i++) out.push(value[i])
    return out
  }
  return []
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
    // Identity fields (backend >= whkey.4). Each is whitelisted or validated
    // here; an absent or malformed value is "" and never invents a state.
    login_state: loginStateValue(raw.login_state),
    login_email: emailValue(raw.login_email),
    login_conflict_label: labelValue(raw.login_conflict_label),
    login_conflict_email: emailValue(raw.login_conflict_email),
    login_matches_label: labelValue(raw.login_matches_label),
    identity_check: identityCheckValue(raw.identity_check),
    account_email: emailValue(raw.account_email),
    plan_changed: raw.plan_changed === true,
    sections: sections
  }
}

var LOGIN_STATES = ["saved", "rotated", "unmanaged", "unsaved", "unverified"]
var IDENTITY_CHECKS = ["deferred", "unavailable"]

function loginStateValue(value) {
  var text = cleanText(value, 40).trim()
  return LOGIN_STATES.indexOf(text) >= 0 ? text : ""
}

function identityCheckValue(value) {
  var text = cleanText(value, 40).trim()
  return IDENTITY_CHECKS.indexOf(text) >= 0 ? text : ""
}

function labelValue(value) {
  var text = cleanText(value, 64).trim()
  return validAccountLabel(text) ? text : ""
}

// One address, no whitespace, at most 120 characters; anything else is "".
function emailValue(value) {
  var text = autoTextSafe(value, 120).trim()
  return /^[^\s@]+@[^\s@]+$/.test(text) ? text : ""
}

// The live login's state. Reports from a backend without `login_state` map
// their `login_unsaved` flag onto the same vocabulary.
function loginState(entry) {
  if (!entry) return "saved"
  var state = loginStateValue(entry.login_state)
  if (state !== "") return state
  return entry.login_unsaved === true ? "unsaved" : "saved"
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
  var source = listOf(entries)
  var claude = []
  var agents = []
  for (var i = 0; i < source.length; i++) {
    if (isClaudeEntry(source[i])) claude.push(source[i])
    else agents.push(source[i])
  }
  return { claude: claude, agents: agents }
}

function metricSections(entry) {
  var sections = entry ? listOf(entry.sections) : []
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
  var sections = entry ? listOf(entry.sections) : []
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
    var body = listOf(block.body)
    var first = body.length > 0
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

function agentNeedsKey(entry) {
  if (!entry || isClaudeEntry(entry)) return false
  var failed = entry.status === "error" || String(entry.error || "") !== ""
  return failed && agentMetrics(entry).primary === null
}

// Providers that merely lack a key (error, no percentage, nothing to show)
// are hidden everywhere: panel rows, bar segments, tooltip, status line. The
// settings page still lists every provider for adding keys.
function presentableEntries(entries) {
  var source = listOf(entries)
  var result = []
  for (var i = 0; i < source.length; i++)
    if (!agentNeedsKey(source[i])) result.push(source[i])
  return result
}

function needsKeyEntries(entries) {
  var source = listOf(entries)
  var result = []
  for (var i = 0; i < source.length; i++)
    if (agentNeedsKey(source[i])) result.push(source[i])
  return result
}

function agentErrorEntries(entries) {
  var source = listOf(entries)
  var result = []
  for (var i = 0; i < source.length; i++) {
    var entry = source[i]
    if (!entry || isClaudeEntry(entry)) continue
    if (entry.status === "error" || String(entry.error || "") !== "") result.push(entry)
  }
  return result
}

function isActiveEntry(entry) {
  return !!(entry && isClaudeEntry(entry) && entry.active === true)
}

function validAccountLabel(text) {
  return /^[a-z0-9_][a-z0-9_-]{0,31}$/.test(String(text === undefined || text === null ? "" : text))
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
  var source = listOf(entries)
  for (var i = 0; i < source.length; i++)
    if (isUnsavedLoginEntry(source[i])) return source[i]
  return null
}

function defaultClaudeEntry(entries) {
  var source = listOf(entries)
  for (var i = 0; i < source.length; i++)
    if (source[i] && String(source[i].id || "") === "anthropic") return source[i]
  return null
}

// The live login is a different account than the active marker's saved copy.
// Switching is held until the user saves it elsewhere or replaces the marker.
function loginConflict(entries) {
  var entry = defaultClaudeEntry(entries)
  if (!entry || loginState(entry) !== "unsaved") return null
  return labelValue(entry.login_conflict_label) !== "" ? entry : null
}

// The backend could not yet prove that the live login still belongs to the
// active marker; nothing is written until it can, or the user decides.
function unverifiedLogin(entries) {
  var entry = defaultClaudeEntry(entries)
  return entry && loginState(entry) === "unverified" ? entry : null
}

// The marker label a Replace/Update would overwrite: the conflicting saved
// account, or the marker whose login could not be verified. "" otherwise.
function replaceTargetLabel(entry) {
  if (!entry || String(entry.id || "") !== "anthropic") return ""
  var state = loginState(entry)
  if (state === "unsaved") return labelValue(entry.login_conflict_label)
  if (state === "unverified") return labelValue(entry.account_label)
  return ""
}

// Which affordance the panel's live-login block shows:
//   "save"       unmanaged login (or a legacy report): plain Save
//   "matches"    the login is a saved account already: Save re-syncs it
//   "conflict"   a different account than the marker: Save as new / Replace
//   "unverified" the check gave up: It's X – update / Save as new
//   ""           nothing to do (saved, rotated, still verifying)
function loginRowState(entry) {
  if (!entry || String(entry.id || "") !== "anthropic") return ""
  var state = loginState(entry)
  if (state === "unverified")
    return entry.identity_check === "unavailable" && replaceTargetLabel(entry) !== ""
      ? "unverified" : ""
  if (state !== "unsaved" && state !== "unmanaged") return ""
  // A live login that already matches a saved (non-marker) account is a plain
  // update of that account; the backend still carries the marker as the
  // conflict label, so "matches" must win here.
  if (state === "unsaved" && labelValue(entry.login_matches_label) !== "") return "matches"
  if (state === "unsaved" && labelValue(entry.login_conflict_label) !== "") return "conflict"
  return "save"
}

function quoted(label) {
  return "\u201c" + autoTextSafe(label, 64) + "\u201d"
}

// Line 1 of the conflict block: who is live, and which saved account it is not.
function conflictCaption(entry) {
  if (!entry) return ""
  var email = emailValue(entry.login_email)
  var slotEmail = emailValue(entry.login_conflict_email)
  return "Logged in as " + (email !== "" ? email : "a different account")
    + " \u2014 not " + quoted(entry.login_conflict_label)
    + (slotEmail !== "" ? " (" + slotEmail + ")" : "")
}

function matchesCaption(entry) {
  if (!entry) return ""
  return "login matches saved account " + quoted(entry.login_matches_label)
}

// Confirm text under Replace: names what is forgotten.
function replaceCaption(entry) {
  if (!entry) return ""
  var slotEmail = emailValue(entry.login_conflict_email)
  return "This forgets " + quoted(entry.login_conflict_label) + " ("
    + (slotEmail !== "" ? slotEmail : "saved login") + ")."
}

// Unverified and the automatic check gave up: name the live login when it is
// known, so the user confirms "it's X" against a real address, not blindly.
function unverifiedCaption(entry) {
  if (!entry) return ""
  var email = emailValue(entry.login_email)
  var marker = quoted(entry.account_label)
  if (email !== "") return "Logged in as " + email + " \u2014 can't verify it's still " + marker
  return "can't verify the login is still " + marker
}

function unverifiedConfirmCaption(entry) {
  if (!entry) return ""
  var email = emailValue(entry.login_email)
  var marker = quoted(entry.account_label)
  if (email !== "") return "If " + email + " is not " + marker + ", " + marker + " is lost."
  return "If this login is a different account, " + marker + " is lost."
}

// Quiet one-line note under the active row while the backend is still
// verifying, or after it has verified a rotation it could not yet write back.
function liveLoginCaption(entry) {
  if (!entry || String(entry.id || "") !== "anthropic") return ""
  var state = loginState(entry)
  if (state === "rotated") return "saved copy updates on next check"
  if (state === "unverified" && entry.identity_check !== "unavailable") {
    var email = emailValue(entry.login_email)
    return "verifying login\u2026 saved copy updates on next check"
      + (email !== "" ? " (" + email + ")" : "")
  }
  return ""
}

// Labels a suggested save name must not collide with: every saved row, the
// active marker, and the conflicting saved account.
function savedLabels(entries) {
  var source = listOf(entries)
  var labels = []
  function add(label) {
    var text = labelValue(label)
    if (text !== "" && labels.indexOf(text) < 0) labels.push(text)
  }
  for (var i = 0; i < source.length; i++) {
    var entry = source[i]
    if (!entry || !isClaudeEntry(entry)) continue
    add(switchLabel(entry))
    if (isActiveEntry(entry)) add(entry.account_label)
    if (String(entry.id || "") === "anthropic") add(entry.login_conflict_label)
  }
  return labels
}

// Used only by the default row and the live-login block; every value is
// shaped by this file so the same key drives the draft-reset logic in QML.
function saveDraftKey(entry) {
  if (!entry) return ""
  return [String(entry.id || ""), String(entry.plan || ""), loginState(entry),
    emailValue(entry.login_email), labelValue(entry.login_conflict_label),
    labelValue(entry.login_matches_label)].join("|")
}

function labelFromText(text) {
  var label = String(text === undefined || text === null ? "" : text)
    .toLowerCase().replace(/[^a-z0-9_-]/g, "").replace(/^[_-]+/, "")
  return label.length > 20 ? label.slice(0, 20) : label
}

function emailLocalLabel(email) {
  var text = emailValue(email)
  var at = text.indexOf("@")
  return at <= 0 ? "" : labelFromText(text.slice(0, at))
}

function uniqueLabel(label, existingLabels) {
  var taken = listOf(existingLabels)
  if (taken.indexOf(label) < 0) return label
  for (var n = 2; n < 100; n++) {
    var suffix = "-" + n
    var candidate = label.slice(0, 20 - suffix.length) + suffix
    if (taken.indexOf(candidate) < 0) return candidate
  }
  return label
}

// The saved account the live login already matches wins (Save re-syncs it);
// otherwise the e-mail's local part, then the plan, then "main" — suffixed
// -2, -3, … when a different saved account already uses the name.
function suggestedSaveLabel(entry, existingLabels) {
  var matches = entry ? labelValue(entry.login_matches_label) : ""
  if (matches !== "") return matches
  var label = entry ? emailLocalLabel(entry.login_email) : ""
  if (label === "") label = labelFromText(entry ? entry.plan : "")
  if (label === "") label = "main"
  return uniqueLabel(label, existingLabels)
}

function validSaveLabel(text) {
  return validAccountLabel(text)
}

// True when `account save <label>` was refused because the target slot holds a
// different Claude login than the one live now. The backend prints
// "refusing to overwrite existing flat Claude account …; pass `--force` to
// replace it" and exits non-zero; the widget offers an Overwrite button for
// exactly that case rather than silently forcing every save.
function isLineageConflict(stderrText) {
  var s = String(stderrText === undefined || stderrText === null ? "" : stderrText)
  return /refusing to overwrite/.test(s) && /--force/.test(s)
}

function severityBand(percent) {
  var value = finitePercent(percent)
  if (value === null || value < 50) return "low"
  if (value < 75) return "mid"
  if (value < 90) return "high"
  return "critical"
}

// This is the single severity-to-theme mapping used by both bar and panel.
// The resting state is full foreground: low usage is GOOD news and must not
// render dimmed ("muted" reads as disabled in the bar). Muted is reserved for
// stale/absent data, which the callers dim separately.
function severityColor(percent, palette, forceError) {
  var colors = palette || {}
  if (forceError === true || severityBand(percent) === "critical") return colors.urgent
  if (severityBand(percent) === "high") return colors.accent
  return colors.foreground
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
  return primary + " · " + secondary
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
  var source = listOf(entries)
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

// The concrete flat label a row can rename: named rows carry it in the id,
// the live/default row in account_label. Null when no flat slot backs the row.
function renameLabel(entry) {
  if (!entry || !isClaudeEntry(entry)) return null
  var id = String(entry.id || "")
  if (id.indexOf("anthropic@") === 0) {
    var label = id.slice("anthropic@".length)
    return validSaveLabel(label) ? label : null
  }
  var stored = cleanText(entry.account_label, 64).trim()
  return validSaveLabel(stored) ? stored : null
}

// The e-mail the backend learned for a Claude row: saved rows carry their
// slot's address, the live row the live login's. "" when unknown.
function claudeEntryEmail(entry) {
  if (!entry || !isClaudeEntry(entry)) return ""
  var id = String(entry.id || "")
  if (id.indexOf("anthropic@") === 0) return emailValue(entry.account_email)
  return id === "anthropic" ? emailValue(entry.login_email) : ""
}

// Hover detail for a row: every metric with its FULL label on its own line,
// then health/text rows, then a stale/error note. The compact captions
// truncate labels for the one-line footer; a tooltip has room and must not.
function entryTooltip(entry, nowMs) {
  if (!entry) return ""
  var lines = []
  var name = isClaudeEntry(entry) ? claudeEntryName(entry) : agentEntryName(entry)
  var plan = autoTextSafe(entry.plan, 120).trim()
  var email = claudeEntryEmail(entry)
  lines.push((plan !== "" ? name + " · " + plan : name) + (email !== "" ? " · " + email : ""))

  var metrics = metricSections(entry)
  for (var i = 0; i < metrics.length && lines.length < 10; i++) {
    var label = autoTextSafe(metrics[i].label, 80).trim() || "usage"
    var reset = relativeReset(metrics[i].reset_at, nowMs)
    lines.push(label + ": " + metrics[i].percent + "%" + (reset ? " · " + reset : ""))
  }

  var sections = listOf(entry.sections)
  for (var j = 0; j < sections.length && lines.length < 12; j++) {
    var row = sections[j]
    if (!row || row.type !== "text") continue
    var textLabel = autoTextSafe(row.label, 80).trim()
    var value = autoTextSafe(row.value, 120).trim()
    if (textLabel === "" && value === "") continue
    lines.push(textLabel !== "" && value !== "" ? textLabel + ": " + value : (textLabel || value))
  }

  var error = autoTextSafe(entry.error, 240).trim()
  if (error !== "") lines.push("error: " + error)
  else if (entry.stale === true) lines.push("cached — provider did not answer")
  return lines.join("\n")
}

function autoSwitchBlurb(entries, threshold) {
  var name = activeAccountLabel(entries)
  if (name === "") name = "the active account"
  var value = Number(threshold)
  if (!isFinite(value)) value = 85
  value = Math.max(0, Math.min(100, Math.round(value)))
  return "Past " + value + "% (5h), " + name
    + " hands every terminal to your least-used saved account."
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
  var source = listOf(entries)
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
    var activeCount = 0
    var aggregatePercent = null
    var aggregateRepresentative = representative

    if (familyName === "anthropic") {
      for (var a = 0; a < group.entries.length; a++) {
        var claudePercent = entryPrimaryPercent(group.entries[a])
        if (claudePercent !== null
            && (aggregatePercent === null || claudePercent > aggregatePercent)) {
          aggregatePercent = claudePercent
          aggregateRepresentative = group.entries[a]
        }
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
      error: group.error,
      activeCount: activeCount,
      aggregatePercent: aggregatePercent,
      aggregateShortName: familyShortName(aggregateRepresentative, familyName)
    })
  }
  return families
}

function barShowsSetting(value) {
  var mode = String(value === undefined || value === null ? "" : value).trim().toLowerCase()
  if (mode === "icon") return "icon"
  // "iconpct" was v1's DEFAULT — those users never chose a wide bar, so they
  // land on the new default. Only an explicit "full" choice maps to "all".
  if (mode === "all" || mode === "full") return "all"
  return "claude"
}

function barSegmentValue(segment, barShows) {
  var item = segment && typeof segment === "object" ? segment : {}
  var mode = barShowsSetting(barShows)
  var percent = finitePercent(item.percent)
  if (mode === "icon") return ""
  return percent === null ? "" : percent + "%"
}

function barSegmentText(segment, barShows) {
  var item = segment && typeof segment === "object" ? segment : {}
  var glyph = item.glyph || familyGlyph(item.family)
  var value = barSegmentValue(segment, barShows)
  return glyph + (value === "" ? "" : " " + value)
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
  var mode = barShowsSetting(barShows)
  var shown
  if (mode === "claude") {
    var anthropic = null
    for (var familyIndex = 0; familyIndex < families.length; familyIndex++) {
      if (families[familyIndex].family === "anthropic") {
        anthropic = families[familyIndex]
        break
      }
    }
    var selected = anthropic || families[0]
    if (selected && selected.family === "anthropic" && selected.activeCount !== 1) {
      selected = {
        family: selected.family,
        shortName: selected.aggregateShortName,
        percent: selected.aggregatePercent,
        error: selected.error
      }
    }
    shown = families.length === 0 ? [] : [selected]
  } else {
    shown = families.slice(0, 4)
  }
  var initials = {}
  for (var initialIndex = 0; initialIndex < shown.length; initialIndex++) {
    var initial = shown[initialIndex].shortName === ""
      ? "?" : shown[initialIndex].shortName.charAt(0).toUpperCase()
    shown[initialIndex]._initial = initial
    initials[initial] = (initials[initial] || 0) + 1
  }
  var result = []
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
    segment.value = barSegmentValue(segment, mode)
    segment.text = barSegmentText(segment, mode)
    result.push(segment)
  }
  return result
}

function barTooltip(entries, barShows) {
  // The argument remains part of the public helper contract even though the
  // tooltip intentionally preserves every mode's hidden family information.
  barShowsSetting(barShows)
  var families = familyAggregates(entries)
  families.sort(function(a, b) {
    if (a.family === "anthropic" && b.family !== "anthropic") return -1
    if (b.family === "anthropic" && a.family !== "anthropic") return 1
    var ap = a.percent === null ? -1 : a.percent
    var bp = b.percent === null ? -1 : b.percent
    if (ap !== bp) return bp - ap
    return a.family < b.family ? -1 : a.family > b.family ? 1 : 0
  })
  var parts = []
  for (var i = 0; i < families.length && i < 6; i++) {
    var name = autoTextSafe(families[i].shortName, 24).trim()
    if (name === "") name = autoTextSafe(families[i].family, 24).trim()
    parts.push(name + " " + (families[i].percent === null ? "–" : families[i].percent + "%"))
  }
  return parts.length === 0 ? "Switchboard" : cleanText(parts.join(" · "), 120)
}

function statusLine(entries) {
  var active = activeAccountLabel(entries)
  // IPC is deliberately mode-independent and retains the four-family line.
  var segments = buildBarSegments(entries, "all")
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
  var options = opts && typeof opts === "object" ? opts : {}
  var enabled = options.enabled === undefined ? options.alerts === true : options.enabled === true
  var source = listOf(entries)

  // State lifetime is bound to the CURRENT entry set: only keys whose identity
  // appears in this report survive, so identities that come and go across
  // refreshes cannot grow the map. A hard cap guards the degenerate case.
  var separator = String.fromCharCode(31)
  var liveIdentities = {}
  for (var s = 0; s < source.length; s++) liveIdentities[alertIdentity(source[s])] = true
  var nextState = {}
  var retained = 0
  var stateKey
  for (stateKey in sourceState) {
    if (stateKey === "__proto__" || stateKey === "constructor" || stateKey === "prototype") continue
    var identity = stateKey.split(separator)[0]
    if (!liveIdentities[identity]) continue
    // leave headroom for the keys this refresh adds
    if (retained >= ALERT_STATE_MAX_KEYS - 128) break
    nextState[stateKey] = sourceState[stateKey] === true
    retained++
  }

  if (!enabled) return { notifications: [], armedState: nextState }

  var notifications = []
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
    var identity = alertIdentity(entry)
    var entryName = isClaudeEntry(entry) ? claudeEntryName(entry) : agentEntryName(entry)

    for (var j = 0; j < levels.length; j++) {
      var level = levels[j]
      stateKey = identity + "\u001f" + metricLabel + "\u001f" + level.name
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

// Alert one-shot state must follow the ACCOUNT, not the report slot: the live
// Claude login is always id "anthropic" and the same account reappears as
// "anthropic@<label>" after a switch — keying by id would re-alert usage that
// already notified, and a switch would falsely re-arm the live slot.
function alertIdentity(entry) {
  if (!isClaudeEntry(entry)) return cleanText(entry.id, 180).trim()
  var id = String(entry.id || "")
  if (id.indexOf("anthropic@") === 0)
    return "claude\u001f" + id.slice("anthropic@".length)
  var label = cleanText(entry.account_label, 64).trim()
  return "claude\u001f" + (label !== "" ? label : "default")
}

function autoSwitchDecision(entries, opts) {
  var options = opts && typeof opts === "object" ? opts : {}
  if (options.enabled !== true) return { action: "none", reason: "off" }

  var source = listOf(entries)
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
  if (unverifiedLogin(source)) return { action: "none", reason: "login-unverified" }

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

function autoSwitchEventText(event) {
  if (!event || typeof event !== "object") return ""
  if (event.kind === "last") {
    var from = autoTextSafe(event.from, 120)
    var to = autoTextSafe(event.to, 120)
    var clock = formatClock(event.atMs)
    return "switched " + from + " → " + to + (clock === "" ? "" : " · " + clock)
  }
  if (event.kind === "failed") return "failed: " + stderrLine(event.message)
  return ""
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

function settingsId(value) {
  var id = cleanText(value, 80).trim()
  if (!/^[a-z0-9_-]+$/.test(id)
      || id === "__proto__" || id === "constructor" || id === "prototype") return ""
  return id
}

function emptySettingsSnapshot(error) {
  return {
    ok: false,
    error: error,
    primary: "",
    primary_choices: [],
    keys: []
  }
}

function parseSettingsSnapshot(raw) {
  try {
    var parsed = JSON.parse(String(raw || ""))
    if (!parsed || Number(parsed.schema_version) !== 1
        || !Array.isArray(parsed.primary_choices) || !Array.isArray(parsed.keys))
      return emptySettingsSnapshot("The settings command returned an unsupported response.")

    var choices = []
    for (var i = 0; i < parsed.primary_choices.length && i < 64; i++) {
      var choice = parsed.primary_choices[i]
      var choiceId = settingsId(choice && choice.id)
      if (choiceId === "") continue
      choices.push({
        id: choiceId,
        value: choiceId,
        label: cleanText(choice.label, 120) || choiceId
      })
    }

    var keys = []
    for (var j = 0; j < parsed.keys.length && j < 32; j++) {
      var key = parsed.keys[j]
      var keyId = settingsId(key && key.id)
      if (keyId === "") continue
      keys.push({
        id: keyId,
        label: cleanText(key.label, 120) || keyId,
        environment: cleanText(key.environment, 160),
        note: cleanText(key.note, 240),
        configured: key.configured === true,
        inline_configured: key.inline_configured === true,
        environment_configured: key.environment_configured === true
      })
    }

    var primary = settingsId(parsed.primary)
    var primaryAvailable = false
    for (var k = 0; k < choices.length; k++) {
      if (choices[k].id === primary) {
        primaryAvailable = true
        break
      }
    }
    if (!primaryAvailable) primary = choices.length > 0 ? choices[0].id : ""
    return {
      ok: true,
      error: "",
      primary: primary,
      primary_choices: choices,
      keys: keys
    }
  } catch (error) {
    return emptySettingsSnapshot("The settings command returned invalid JSON.")
  }
}

function buildSettingsPatch(primary, changes) {
  var primaryId = settingsId(primary)
  var rawPrimary = String(primary || "").trim()
  if (rawPrimary !== "" && primaryId === "")
    return { ok: false, error: "Choose a valid primary provider.", payload: "" }

  var keys = {}
  var list = Array.isArray(changes) ? changes : []
  var seen = []
  for (var i = 0; i < list.length; i++) {
    var change = list[i] || {}
    var id = settingsId(change.id)
    if (id === "" || seen.indexOf(id) >= 0)
      return { ok: false, error: "A settings row has an invalid provider id.", payload: "" }
    seen.push(id)
    if (change.action === "clear") {
      keys[id] = { action: "clear" }
    } else if (change.action === "set") {
      var value = String(change.value || "")
      if (value === "")
        return { ok: false, error: "An edited API key is empty.", payload: "" }
      if (value.length > 16384)
        return { ok: false, error: "An API key is too long.", payload: "" }
      keys[id] = { action: "set", value: value }
    } else {
      return { ok: false, error: "A settings row has an invalid action.", payload: "" }
    }
  }

  if (primaryId === "" && seen.length === 0)
    return { ok: false, error: "There are no settings changes to save.", payload: "" }
  var patch = { schema_version: 1, keys: keys }
  if (primaryId !== "") patch.primary = primaryId
  return { ok: true, error: "", payload: JSON.stringify(patch) }
}

function parseSettingsApplyResult(raw) {
  try {
    var parsed = JSON.parse(String(raw || ""))
    return !!(parsed && parsed.ok === true)
  } catch (error) {
    return false
  }
}

function settingsApplySucceeded(exitCode, raw) {
  return Number(exitCode) === 0 && parseSettingsApplyResult(raw)
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

