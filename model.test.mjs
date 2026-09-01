import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./Model.js', import.meta.url), 'utf8');
const model = {};
vm.createContext(model);
vm.runInContext(source, model, {filename: 'Model.js'});

function metric(label, percent, resetAt = '') {
  return {type: 'metric', label, percent, value: `${percent}%`, detail: '', reset_at: resetAt};
}

function claude(id, active, percent, extra = {}) {
  return {
    id,
    display_name: 'Claude',
    short_name: 'claude',
    status: 'ready',
    error: '',
    stale: false,
    active,
    account_label: id === 'anthropic' ? 'main' : id.slice('anthropic@'.length),
    login_unsaved: false,
    sections: percent === null ? [] : [metric('Session (5h)', percent)],
    ...extra
  };
}

function decision(entries, overrides = {}) {
  return model.autoSwitchDecision(entries, {
    enabled: true,
    threshold: 85,
    nowMs: 2_000_000,
    lastSwitchMs: 0,
    cooldownMs: 600_000,
    marginPts: 10,
    ...overrides
  });
}

test('report parsing normalizes typed sections and sanitizes provider text', () => {
  const hostile = `Claude\u0000\u202e <b>${'x'.repeat(260)}</b>`;
  const parsed = model.parseReport(JSON.stringify({primary: 'anthropic', entries: [{
    id: 'anthropic',
    display_name: hostile,
    short_name: 'cld',
    plan: 'Max',
    status: 'ready',
    sections: [
      metric('Session (5h)', 49, '2026-09-01T12:00:00Z'),
      {type: 'text', label: 'Auth', value: 'ok'},
      {type: 'block', label: 'Notes', body: ['one', 'two']},
      {type: 'spacer'},
      {type: 'unknown', value: 'drop me'}
    ]
  }]}));

  assert.equal(parsed.ok, true);
  assert.equal(parsed.primary, 'anthropic');
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].active, null);
  assert.equal(parsed.entries[0].login_unsaved, false);
  assert.doesNotMatch(parsed.entries[0].display_name, /[\u0000\u202e<>]/u);
  assert.match(parsed.entries[0].display_name, /‹b›/u);
  assert.ok(parsed.entries[0].display_name.length <= 240);
  assert.deepEqual(Array.from(parsed.entries[0].sections, row => row.type),
    ['metric', 'text', 'block', 'spacer']);
  assert.equal(parsed.entries[0].sections[0].severity, 'low');
});

test('old reports do not invent radios or the unsaved-login row', () => {
  const parsed = model.parseReport(JSON.stringify({entries: [{
    id: 'anthropic@desktop', display_name: 'Claude Desktop', status: 'ready', sections: []
  }]}));
  const entry = parsed.entries[0];
  assert.equal(entry.active, null);
  assert.equal(model.isActiveEntry(entry), false);
  assert.equal(model.isSwitchableEntry(entry), false);
  assert.equal(model.isUnsavedLoginEntry(entry), false);
  assert.equal(model.unsavedLoginEntry(parsed.entries), null);
});

test('invalid reports fail without throwing', () => {
  assert.equal(model.parseReport('{').ok, false);
  assert.equal(model.parseReport('{}').ok, false);
  assert.equal(model.parseReport('{"entries":[{"display_name":"missing id"}]}').ok, false);
  assert.equal(model.parseReport('{"entries":[]}').ok, true);
});

test('grouping separates Claude accounts from every other agent', () => {
  const grouped = model.groupEntries([
    {id: 'anthropic'}, {id: 'anthropic@work'}, {id: 'openai'},
    {id: 'grok@x'}, {id: 'supergrok'}
  ]);
  assert.deepEqual(Array.from(grouped.claude, entry => entry.id), ['anthropic', 'anthropic@work']);
  assert.deepEqual(Array.from(grouped.agents, entry => entry.id), ['openai', 'grok@x', 'supergrok']);
});

test('family glyph map covers known providers and falls back without assets', () => {
  assert.deepEqual([
    'anthropic', 'openai', 'kimi', 'grok', 'supergrok', 'openrouter', 'deepseek', 'zai'
  ].map(model.familyGlyph), ['󰛄', '󱢆', '󰚩', '󰬈', '󰬈', '󱙺', '󰧑', '󰚩']);
  assert.equal(model.familyGlyph('unlisted@account'), '󰚩');
  assert.equal(model.familyGlyph({id: 'openai@work'}), '󱢆');
});

test('metric roles are label-driven for Claude and order-preserving for agents', () => {
  const reversedClaude = {sections: [metric('Weekly (7d)', 60), metric('Session (5h)', 20)]};
  assert.equal(model.claudeMetrics(reversedClaude).primary.percent, 20);
  assert.equal(model.claudeMetrics(reversedClaude).secondary.percent, 60);

  const kimiWeeklyFirst = {sections: [
    metric('Weekly limit', 72),
    metric('Session allowance', 14),
    metric('Backup wk pool', 31)
  ]};
  const roles = model.agentMetrics(kimiWeeklyFirst);
  assert.equal(roles.primary.label, 'Weekly limit');
  assert.equal(roles.primary.percent, 72);
  assert.equal(roles.secondary.label, 'Backup wk pool');
  assert.equal(model.shortMetricLabel('Weekly allowance'), 'Weekly …');
  assert.ok(model.shortMetricLabel('Weekly allowance').length <= 8);
  assert.equal(model.agentMeterCaption(kimiWeeklyFirst, Date.now()),
    'Weekly …   ·   Backup … 31%');
});

test('entry names follow the corrected Claude and agent rules', () => {
  assert.equal(model.claudeEntryName({id: 'anthropic', account_label: 'main', display_name: 'Claude'}), 'main');
  assert.equal(model.claudeEntryName({id: 'anthropic', account_label: '', display_name: 'Claude Max'}), 'Claude Max');
  assert.equal(model.claudeEntryName({id: 'anthropic@work', display_name: 'Ignore me'}), 'work');
  assert.equal(model.agentEntryName({id: 'openai', display_name: 'Codex'}), 'Codex');
});

test('needs-key rows are agent errors without a primary percentage', () => {
  const missing = {id: 'grok', status: 'error', error: 'management key missing', sections: []};
  const meteredError = {...missing, id: 'zai', sections: [metric('Session', 20)]};
  assert.equal(model.agentNeedsKey(missing), true);
  assert.equal(model.agentNeedsKey(meteredError), false);
  assert.equal(model.agentNeedsKey(claude('anthropic', true, null, {status: 'error', error: 'login'})), false);
  assert.deepEqual(Array.from(model.needsKeyEntries([missing, meteredError]), row => row.id), ['grok']);
});

test('switchability requires the explicit false field and a valid bounded label', () => {
  assert.equal(model.isSwitchableEntry({id: 'anthropic@work', active: false}), true);
  assert.equal(model.isSwitchableEntry({id: 'anthropic@work', active: true}), false);
  assert.equal(model.isSwitchableEntry({id: 'anthropic@work'}), false);
  assert.equal(model.isSwitchableEntry({id: 'anthropic@Bad!', active: false}), false);
  assert.equal(model.isSwitchableEntry({id: `anthropic@${'a'.repeat(33)}`, active: false}), false);
});

test('severity boundaries map to the five supported theme roles', () => {
  assert.deepEqual([49, 50, 74, 75, 89, 90].map(model.severityBand),
    ['low', 'mid', 'mid', 'high', 'high', 'critical']);
  const palette = {muted: 'muted', foreground: 'foreground', accent: 'accent', urgent: 'urgent'};
  assert.deepEqual([49, 50, 75, 90].map(value => model.severityColor(value, palette, false)),
    ['foreground', 'foreground', 'accent', 'urgent']);
  assert.equal(model.severityColor(2, palette, true), 'urgent');
  assert.equal(model.finitePercent(null), null);
  assert.equal(model.formatClock(0), '');
});

test('relative resets cover absent, past, sub-hour, hourly, and multi-day boundaries', () => {
  const now = Date.UTC(2026, 8, 1, 10, 0, 0);
  const resetAt = deltaMs => new Date(now + deltaMs).toISOString();
  assert.equal(model.relativeReset('', now), '');
  assert.equal(model.relativeReset(null, now), '');
  assert.equal(model.relativeReset('not-a-date', now), '');
  assert.equal(model.relativeReset(resetAt(-1), now), '');
  assert.equal(model.relativeReset(resetAt(0), now), '');
  assert.equal(model.relativeReset(resetAt(59_000), now), 'resets 0m');
  assert.equal(model.relativeReset(resetAt(12 * 60_000 + 59_000), now), 'resets 12m');
  assert.equal(model.relativeReset(resetAt((4 * 60 + 54) * 60_000), now), 'resets 4h 54m');
  assert.equal(model.relativeReset(resetAt((32 * 60 + 27) * 60_000), now), 'resets 1d 8h');

  const entry = claude('anthropic', true, 54, {sections: [
    metric('Session (5h)', 54, resetAt((4 * 60 + 54) * 60_000)),
    metric('Weekly (7d)', 22, resetAt(32 * 60 * 60_000))
  ]});
  assert.equal(model.claudeMeterCaption(entry, now),
    '5h · resets 4h 54m · 7d 22% · resets 1d 8h');
});

test('save labels are safely suggested and strictly validated', () => {
  assert.equal(model.suggestedSaveLabel({plan: 'Claude Max 20x'}), 'claudemax20x');
  assert.equal(model.suggestedSaveLabel({plan: '../../TOKEN<script>'}), 'tokenscript');
  assert.equal(model.suggestedSaveLabel({plan: '!!!'}), 'main');
  assert.equal(model.suggestedSaveLabel({plan: 'a'.repeat(80)}).length, 20);
  for (const label of ['main', 'work-2', 'acct_one', 'a'.repeat(32)])
    assert.equal(model.validSaveLabel(label), true);
  for (const label of ['', 'Work', '../main', 'has space', 'a'.repeat(33)])
    assert.equal(model.validSaveLabel(label), false);
});

test('auto-switch decision returns every first-miss reason', () => {
  const active = claude('anthropic', true, 90);
  const target = claude('anthropic@work', false, 30);

  const off = model.autoSwitchDecision([], {enabled: false});
  assert.equal(off.action, 'none');
  assert.equal(off.reason, 'off');
  assert.equal(decision([target]).reason, 'no-fresh-data');
  assert.equal(decision([active, claude('anthropic@other', true, 10), target]).reason, 'no-fresh-data');
  assert.equal(decision([claude('anthropic', true, null), target]).reason, 'no-fresh-data');
  assert.equal(decision([{...active, stale: true}, target]).reason, 'no-fresh-data');
  assert.equal(decision([{...active, status: 'error', error: 'nope'}, target]).reason, 'no-fresh-data');
  assert.equal(decision([{...active, login_unsaved: true}, target]).reason, 'unsaved-login');
  assert.equal(decision([claude('anthropic', true, 84), target]).reason, 'under-threshold');
  assert.equal(decision([active, claude('anthropic@work', false, 76)]).reason, 'no-candidate');
  assert.equal(decision([active, target], {lastSwitchMs: 1_400_001}).reason, 'cooldown');
});

test('auto-switch honors threshold, margin, cooldown, exclusions, and deterministic picks', () => {
  const active = claude('anthropic', true, 85);
  const atMargin = claude('anthropic@zeta', false, 75);
  let result = decision([active, atMargin]);
  assert.equal(result.action, 'switch');
  assert.equal(result.label, 'zeta');
  assert.equal(result.fromPct, 85);
  assert.equal(result.toPct, 75);

  result = decision([active, atMargin], {lastSwitchMs: 1_400_000});
  assert.equal(result.action, 'switch'); // exactly 600000 ms is outside cooldown

  const candidates = [
    claude('anthropic@stale', false, 1, {stale: true}),
    claude('anthropic@error', false, 2, {status: 'error', error: 'refused'}),
    claude('anthropic@zeta', false, 20),
    claude('anthropic@alpha', false, 20),
    claude('anthropic@lowest', false, 10)
  ];
  result = decision([active, ...candidates]);
  assert.equal(result.label, 'lowest');

  result = decision([active,
    claude('anthropic@zeta', false, 20),
    claude('anthropic@alpha', false, 20)
  ]);
  assert.equal(result.label, 'alpha');
});

test('family segments use corrected ordering, aggregation, collisions, glyphs, and error state', () => {
  const entries = [
    {...claude('anthropic', true, 42), short_name: 'claude'},
    {...claude('anthropic@work', false, 95), short_name: 'claude'},
    {id: 'openai', short_name: 'gpt', status: 'ready', error: '', sections: [metric('Session', 80)]},
    {id: 'grok@x', short_name: 'grok', status: 'error', error: 'auth', sections: []},
    {id: 'supergrok', short_name: 'sg', status: 'ready', error: '', sections: [metric('Daily', 60)]},
    {id: 'kimi@cpx-x', short_name: 'kimi', status: 'ready', error: '', sections: [metric('Weekly', 90)]}
  ];

  const segments = model.buildBarSegments(entries, 'all');
  assert.deepEqual(Array.from(segments, row => row.family), ['anthropic', 'kimi', 'openai', 'supergrok']);
  assert.equal(segments[0].percent, 42); // active Claude only, not the 95% inactive account
  assert.deepEqual(Array.from(segments, row => row.tag), ['C', 'K', 'G', 'S']);
  assert.deepEqual(Array.from(segments, row => row.glyph), ['󰛄', '󰚩', '󱢆', '󰬈']);

  const collision = model.buildBarSegments(entries.filter(row => ['openai', 'grok@x'].includes(row.id)), 'all');
  assert.deepEqual(Array.from(collision, row => row.tag), ['gpt', 'grok']);
  assert.equal(collision.find(row => row.family === 'grok').severity, 'critical');
  assert.equal(collision.find(row => row.family === 'grok').percent, null);

  assert.equal(model.familyId({id: 'grok@x'}), 'grok');
  assert.equal(model.familyId({id: 'supergrok'}), 'supergrok');
});

test('bar text supports icon, percent, and migrated display modes', () => {
  const entry = {...claude('anthropic', true, 42), short_name: 'claude'};
  assert.equal(model.buildBarSegments([entry], 'icon')[0].text, '󰛄');
  assert.equal(model.buildBarSegments([entry], 'iconpct')[0].text, '󰛄 42%');
  assert.equal(model.buildBarSegments([entry], 'full')[0].text, '󰛄 42%');
  assert.equal(model.buildBarSegments([{id: 'grok', short_name: 'grok', status: 'ready', sections: []}], 'full')[0].text,
    '󰬈');
  assert.equal(model.barShowsSetting('bad-value'), 'claude');
});

test('bar modes migrate old values and keep Claude minimal by default', () => {
  const entries = [
    {...claude('anthropic', true, 42), short_name: 'claude'},
    {id: 'openai', short_name: 'gpt', status: 'ready', sections: [metric('Session', 80)]}
  ];
  assert.deepEqual(Array.from(model.buildBarSegments(entries, 'claude'), row => row.text), ['󰛄 42%']);
  assert.deepEqual(Array.from(model.buildBarSegments(entries, 'all'), row => row.text),
    ['󰛄 42%', '󱢆 80%']);
  assert.deepEqual(Array.from(model.buildBarSegments(entries, 'icon'), row => row.text), ['󰛄', '󱢆']);

  const migration = new Map([
    ['claude', 'claude'], ['all', 'all'], ['icon', 'icon'],
    ['iconpct', 'claude'], ['full', 'all'], ['FULL', 'all'],
    ['', 'claude'], ['bad-value', 'claude'], [undefined, 'claude'], [null, 'claude']
  ]);
  for (const [input, expected] of migration)
    assert.equal(model.barShowsSetting(input), expected);
});

test('Claude bar mode has ordered family and ambiguous-active fallbacks', () => {
  const withoutClaude = [
    {id: 'zai', short_name: 'zai', status: 'ready', sections: [metric('Session', 20)]},
    {id: 'openai', short_name: 'gpt', status: 'ready', sections: [metric('Session', 75)]}
  ];
  assert.equal(model.buildBarSegments(withoutClaude, 'claude')[0].family, 'openai');

  const ambiguous = [
    {...claude('anthropic@home', null, 30), short_name: 'claude'},
    {...claude('anthropic@work', null, 70), short_name: 'claude'}
  ];
  const segment = model.buildBarSegments(ambiguous, 'claude')[0];
  assert.equal(segment.family, 'anthropic');
  assert.equal(segment.percent, 70);
  assert.equal(model.statusLine(ambiguous), 'active=none claude=–');
});

test('bar tooltip preserves hidden family information with bounds', () => {
  const entries = [
    {...claude('anthropic', true, 42), short_name: 'claude'},
    {id: 'openai', short_name: 'gpt', status: 'ready', sections: [metric('Session', 80)]},
    {id: 'grok', short_name: 'grok', status: 'error', error: 'auth', sections: []},
    {id: 'zai', short_name: 'zai', status: 'ready', sections: [metric('Session', 25)]},
    {id: 'kimi', short_name: 'kimi', status: 'ready', sections: [metric('Weekly', 33)]},
    {id: 'deepseek', short_name: 'deepseek', status: 'ready', sections: [metric('Session', 15)]}
  ];
  const tooltip = model.barTooltip(entries, 'claude');
  assert.match(tooltip, /^claude 42% · gpt 80%/u);
  assert.match(tooltip, /grok –/u);
  assert.equal(tooltip.split(' · ').length, 6);
  assert.ok(tooltip.length <= 120);
  assert.equal(model.barTooltip([], 'all'), 'Switchboard');
});

test('IPC status uses the same shown families and active label', () => {
  const entries = [
    {...claude('anthropic@main', true, 44), short_name: 'cld'},
    {id: 'openai', short_name: 'gpt', status: 'ready', error: '', sections: [metric('Session', 80)]},
    {id: 'grok', short_name: 'grk', status: 'ready', error: '', sections: [{type: 'text', label: 'auth', value: 'ok'}]}
  ];
  assert.equal(model.statusLine(entries), 'active=main cld=44% gpt=80% grk=–');
  assert.equal(model.statusLine([{id: 'openai', short_name: 'gpt', status: 'ready', sections: []}]),
    'active=none gpt=–');
});

test('auto-switch card is an off/armed/event state machine and keeps events across off', () => {
  const last = {kind: 'last', from: 'main', to: 'work', atMs: Date.now()};
  const failed = {kind: 'failed', message: 'account switch was refused'};
  assert.equal(model.autoSwitchStatus(false, null), 'off');
  assert.equal(model.autoSwitchStatus(true, null), 'armed');
  assert.match(model.autoSwitchStatus(true, last), /^last: main → work \d\d:\d\d$/u);
  assert.equal(model.autoSwitchStatus(false, last), 'off');
  assert.match(model.autoSwitchStatus(true, last), /^last: main → work/u);
  assert.equal(model.autoSwitchStatus(true, failed), 'failed: account switch was refused');
  assert.equal(model.autoSwitchStatus(true, {kind: 'skip', reason: 'cooldown'}), 'armed');
});

test('auto-switch blurb substitutes the live account and has a safe fallback', () => {
  assert.equal(model.autoSwitchBlurb([claude('anthropic', true, 44)], 85),
    'Past 85% (5h), main hands every terminal to your least-used saved account.');
  assert.equal(model.autoSwitchBlurb([], 90),
    'Past 90% (5h), the active account hands every terminal to your least-used saved account.');
  assert.equal(model.autoSwitchBlurb([
    claude('anthropic@one', true, 44), claude('anthropic@two', true, 33)
  ], 70),
  'Past 70% (5h), the active account hands every terminal to your least-used saved account.');
});

test('main-panel auto-switch events use the redesigned one-line wording', () => {
  const atMs = new Date(2026, 8, 1, 14, 32).getTime();
  assert.equal(model.autoSwitchEventText({kind: 'last', from: 'work', to: 'home', atMs}),
    'switched work → home · 14:32');
  assert.equal(model.autoSwitchEventText({kind: 'failed', message: 'guard refused'}),
    'failed: guard refused');
  assert.equal(model.autoSwitchEventText(null), '');
});

test('stderr redaction removes long secret-like runs before sanitizing and capping', () => {
  const token = 'A'.repeat(40);
  const output = model.stderrLine(`Authentication failed for token ${token}\nTry logging in again.`);
  assert.doesNotMatch(output, new RegExp(token));
  assert.equal(output, 'Authentication failed for token … Try logging in again.');
  assert.equal(model.stderrLine('The selected account is not saved.'), 'The selected account is not saved.');
  assert.ok(model.stderrLine('x '.repeat(400)).length <= 300);
});

test('threshold alerts cross once, do not repeat, and re-arm after a reset', () => {
  const withPercent = percent => [{...claude('anthropic', true, percent), account_label: 'main'}];

  const first = model.alertDecisions(withPercent(75), {}, {enabled: true});
  assert.deepEqual(Array.from(first.notifications[0]), [
    'notify-send', '-a', 'Switchboard', 'main 5h at 75%', 'Warn threshold crossed'
  ]);
  assert.equal(first.notifications.length, 1);

  const repeated = model.alertDecisions(withPercent(89), first.armedState, {enabled: true});
  assert.equal(repeated.notifications.length, 0);

  const critical = model.alertDecisions(withPercent(90), repeated.armedState, {enabled: true});
  assert.equal(critical.notifications.length, 1);
  assert.equal(critical.notifications[0][4], 'Critical threshold crossed');

  const stillHigh = model.alertDecisions(withPercent(95), critical.armedState, {enabled: true});
  assert.equal(stillHigh.notifications.length, 0);

  const reset = model.alertDecisions(withPercent(20), stillHigh.armedState, {enabled: true});
  assert.equal(reset.notifications.length, 0);
  const crossedAgain = model.alertDecisions(withPercent(91), reset.armedState, {enabled: true});
  assert.deepEqual(Array.from(crossedAgain.notifications, command => command[4]),
    ['Warn threshold crossed', 'Critical threshold crossed']);
});

test('threshold alerts stay inert while disabled and are keyed per entry window', () => {
  const high = {...claude('anthropic@work', false, 95), account_label: 'work'};
  const off = model.alertDecisions([high], {existing: false}, {enabled: false});
  assert.equal(off.notifications.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(off.armedState)), {existing: false});

  const on = model.alertDecisions([high], off.armedState, {enabled: true});
  assert.equal(on.notifications.length, 2);
  assert.match(on.notifications[0][3], /^work 5h at 95%$/u);

  const changedWindow = {...high, sections: [metric('Alternate session', 95)]};
  const changed = model.alertDecisions([changedWindow], on.armedState, {enabled: true});
  assert.equal(changed.notifications.length, 2);
});

test('settings snapshots are strict, sanitized, and bounded', () => {
  const hostile = `Key\u0000\u202e ${'x'.repeat(160)}`;
  const primaryChoices = Array.from({length: 70}, (_, index) => ({
    id: `vendor_${index}`,
    label: index === 0 ? hostile : `Vendor ${index}`
  }));
  const keys = Array.from({length: 40}, (_, index) => ({
    id: `key_${index}`,
    label: index === 0 ? hostile : `Key ${index}`,
    environment: `KEY_${index}`,
    note: 'note',
    configured: index === 0,
    inline_configured: index === 0,
    environment_configured: index === 1
  }));
  primaryChoices.splice(1, 0, {id: '__proto__', label: 'drop'});
  keys.splice(1, 0, {id: 'Bad id', label: 'drop'});

  const parsed = model.parseSettingsSnapshot(JSON.stringify({
    schema_version: 1,
    primary: 'vendor_4',
    primary_choices: primaryChoices,
    keys
  }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.primary, 'vendor_4');
  assert.equal(parsed.primary_choices.length, 63); // one hostile id within the 64-item input bound
  assert.equal(parsed.keys.length, 31); // one invalid id within the 32-item input bound
  assert.ok(parsed.primary_choices[0].label.length <= 120);
  assert.doesNotMatch(parsed.primary_choices[0].label, /[\u0000\u202e]/u);
  assert.ok(parsed.keys[0].label.length <= 120);
  assert.equal(parsed.keys[0].inline_configured, true);
  assert.equal(parsed.keys[1].environment_configured, true);

  assert.equal(model.parseSettingsSnapshot('{').error,
    'The settings command returned invalid JSON.');
  for (const invalid of [
    {schema_version: 2, primary_choices: [], keys: []},
    {schema_version: 1, keys: []},
    {schema_version: 1, primary_choices: []}
  ]) {
    const result = model.parseSettingsSnapshot(JSON.stringify(invalid));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'The settings command returned an unsupported response.');
  }
});

test('settings patches encode only explicit set/clear changes and reject invalid input', () => {
  const built = model.buildSettingsPatch('', [
    {id: 'zai', action: 'set', value: 'secret-value'},
    {id: 'grok', action: 'clear'}
  ]);
  assert.equal(built.ok, true);
  assert.deepEqual(JSON.parse(built.payload), {
    schema_version: 1,
    keys: {
      zai: {action: 'set', value: 'secret-value'},
      grok: {action: 'clear'}
    }
  });

  assert.equal(model.buildSettingsPatch('', []).error,
    'There are no settings changes to save.');
  assert.equal(model.buildSettingsPatch('', [{id: 'zai', action: 'set', value: ''}]).error,
    'An edited API key is empty.');
  assert.equal(model.buildSettingsPatch('', [{id: 'zai', action: 'unchanged'}]).error,
    'A settings row has an invalid action.');
  assert.equal(model.buildSettingsPatch('', [
    {id: 'zai', action: 'clear'}, {id: 'zai', action: 'clear'}
  ]).error, 'A settings row has an invalid provider id.');
});

test('settings apply requires both exit zero and an explicit JSON ok result', () => {
  assert.equal(model.parseSettingsApplyResult('{"ok":true}'), true);
  assert.equal(model.parseSettingsApplyResult('{"ok":false}'), false);
  assert.equal(model.parseSettingsApplyResult('{}'), false);
  assert.equal(model.parseSettingsApplyResult('{'), false);
  assert.equal(model.settingsApplySucceeded(0, '{"ok":true}'), true);
  assert.equal(model.settingsApplySucceeded(0, '{}'), false);
  assert.equal(model.settingsApplySucceeded(1, '{"ok":true}'), false);
});

test('settings helpers preserve unknown keys and clamp manifest values', () => {
  const original = {id: 'old', legacy: true, future: {keep: true}};
  const next = model.settingsWithOverrides(original, 'leoom.switchboard', {autoSwitch: true});
  assert.equal(next.id, 'leoom.switchboard');
  assert.equal(next.legacy, true);
  assert.equal(next.autoSwitch, true);
  assert.deepEqual(JSON.parse(JSON.stringify(next.future)), {keep: true});
  assert.equal(original.autoSwitch, undefined);
  assert.equal(model.booleanSetting('false', true), false);
  assert.equal(model.integerSetting(97, 85, 50, 95, 5), 95);
  assert.equal(model.integerSetting(83, 85, 50, 95, 5), 85);
  assert.equal(model.barShowsSetting('FULL'), 'all');
});

test('binary candidates preserve override, local install, and PATH order', () => {
  assert.deepEqual(Array.from(model.binaryCandidates({AIUSAGEBAR_BIN: '/opt/fork', HOME: '/home/test'})),
    ['/opt/fork', '/home/test/.local/bin/ai-usagebar', 'ai-usagebar']);
});

test('manifest and QML retain the required plugin lifecycle contracts', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, 'leoom.switchboard');
  assert.equal(manifest.name, 'Switchboard');
  assert.equal(manifest.version, '2.0.0');
  assert.equal(manifest.license, 'MIT');
  assert.deepEqual(manifest.kinds, ['service', 'bar-widget']);
  assert.equal(manifest.keepLoaded, true);
  assert.deepEqual(manifest.entryPoints, {service: 'Service.qml', barWidget: 'BarWidget.qml'});
  assert.deepEqual(manifest.barWidget.defaults, {
    refreshIntervalSec: 300, barShows: 'claude', autoSwitch: false, autoThreshold: 85, alerts: false
  });
  const refreshSchema = manifest.barWidget.schema.find(row => row.key === 'refreshIntervalSec');
  assert.equal(refreshSchema.step, 30);
  const barShowsSchema = manifest.barWidget.schema.find(row => row.key === 'barShows');
  assert.equal(barShowsSchema.type, 'enum');
  assert.deepEqual(barShowsSchema.options, ['claude', 'all', 'icon']);
  assert.equal(barShowsSchema.defaultValue, 'claude');
  const alertsSchema = manifest.barWidget.schema.find(row => row.key === 'alerts');
  assert.equal(alertsSchema.type, 'boolean');
  assert.equal(alertsSchema.defaultValue, false);

  const bar = fs.readFileSync(new URL('./BarWidget.qml', import.meta.url), 'utf8');
  assert.match(bar, /readonly property bool opened:/);
  assert.match(bar, /function open\(\)/);
  assert.match(bar, /function close\(\)/);
  assert.match(bar, /Loader\s*\{[\s\S]*?active:\s*true[\s\S]*?source:\s*Qt\.resolvedUrl\("Panel\.qml"\)/);
  assert.match(bar, /registerWidget\(root\)/);
  assert.match(bar, /Model\.settingsWithOverrides\(root\.settings, root\.moduleName, values\)/);
  assert.match(bar, /bar\.shell\.updateEntryInline\(root\.moduleName, entry\)/);
  assert.match(bar, /setting\("barShows", "claude"\)/);
  assert.doesNotMatch(bar, /setting\("compactBar"/);
  assert.match(bar, /WidgetButton\s*\{/);
  assert.doesNotMatch(bar, /BorderSurface\s*\{/);
  assert.match(bar, /fontSize:\s*Style\.font\.caption/);
  assert.match(bar, /tooltipText:\s*root\.svc[\s\S]*?Model\.barTooltip/);
  assert.match(bar, /refreshIntervalSec:\s*Model\.integerSetting\([^\n]*, 300, 60, 3600, 30\)/);
  // The glyph renders in its own fixed-width box (zero-advance Nerd glyphs
  // must never paint under the digits), with the value as a separate Text.
  assert.match(bar, /text:\s*modelData\.glyph/);
  assert.match(bar, /text:\s*modelData\.value/);
  assert.doesNotMatch(bar, /text:\s*modelData\.text/);
  assert.doesNotMatch(bar, /onWheelMoved/);

  const service = fs.readFileSync(new URL('./Service.qml', import.meta.url), 'utf8');
  assert.match(service, /target:\s*"leoom\.switchboard"/);
  assert.match(service, /\["\/usr\/bin\/env", resolvedBinary, "usage", "--json"\]/);
  assert.match(service, /"account", "switch", String\(label\), "--cli"/);
  assert.match(service, /"account", "save", String\(label\)/);
  assert.match(service, /"account", "toggle"/);
  assert.match(service, /\["\/usr\/bin\/env", resolvedBinary, "settings", "show"\]/);
  assert.match(service, /\["\/usr\/bin\/env", resolvedBinary, "settings", "apply"\]/);
  assert.match(service, /stdinEnabled:\s*true/);
  assert.match(service, /write\(root\.settingsApplyPayload \+ "\\n"\)[\s\S]*?settingsApplyPayload = ""/);
  assert.match(service, /Model\.settingsApplySucceeded\(exitCode, settingsApplyStdout\)/);
  assert.match(service, /refreshIntervalSec = Model\.integerSetting\([^\n]*, 300, 60, 3600, 30\)/);
  assert.match(service, /\["notify-send", "-a", "Switchboard", "Claude auto-switch"/);
  assert.match(service, /Model\.alertDecisions\(parsed\.entries, alertArmedState,/);
  assert.doesNotMatch(service, /--force/);
  assert.equal((service.match(/root\.completionsPending\+\+/g) || []).length, 7);
  assert.equal((service.match(/root\.completionsPending--/g) || []).length, 7);

  const panel = fs.readFileSync(new URL('./Panel.qml', import.meta.url), 'utf8');
  const claudeAt = panel.indexOf('text: "CLAUDE"');
  const agentsAt = panel.indexOf('text: "AGENTS"');
  const autoAt = panel.indexOf('text: "Auto-switch at ≥ "');
  const statusAt = panel.indexOf('// --------------------------------------------------- status strip');
  assert.ok(claudeAt > 0 && claudeAt < agentsAt && agentsAt < autoAt && autoAt < statusAt);
  assert.match(panel, /contentWidth:\s*panel\.fittedContentWidth\(Style\.space\(300\)\)/);
  assert.match(panel, /contentHeight:\s*panel\.fittedContentHeight\(column\.implicitHeight, Style\.space\(460\)\)/);
  assert.match(panel, /padding:\s*Style\.spacing\.panelPadding/);
  assert.match(panel, /spacing:\s*Style\.spacing\.panelGap/);
  assert.match(panel, /interval:\s*60000/);
  assert.match(panel, /Model\.claudeMeterCaption\(claudeRow\.entry, root\.nowMs\)/);
  assert.match(panel, /Model\.agentMeterCaption\(agentRow\.entry, root\.nowMs\)/);
  assert.match(panel, /Model\.familyGlyph\(/);
  assert.doesNotMatch(panel, /Model\.resetClock\(/);
  assert.doesNotMatch(panel, /Color\.(?:warning|critical|error)/);
  assert.doesNotMatch(panel, /\bIpcHandler\s*\{/);
  assert.match(panel, /ToggleSwitch\s*\{/);
  assert.match(panel, /NumberField\s*\{/);
  assert.match(panel, /Dropdown\s*\{/);
  assert.match(panel, /TextField\s*\{[\s\S]*?password:\s*true/);
  assert.match(panel, /property bool settingsOpen:\s*false/);
  assert.match(panel, /text:\s*"‹ back"/);
  assert.match(panel, /stepSize:\s*30/);
  const mainRows = panel.slice(panel.indexOf('component ClaudeAccountRow'),
    panel.indexOf('component ProviderKeyRow'));
  assert.doesNotMatch(mainRows, /wrapMode:\s*Text\.WordWrap/);
  assert.doesNotMatch(mainRows, /maximumLineCount:\s*2/);
});

test('alert state follows the account across a slot move, not the entry id', () => {
  // "work" is live: alerts fire on the default slot under its account identity.
  const live = claude('anthropic', true, 91, {account_label: 'work'});
  const first = model.alertDecisions([live], {}, {enabled: true});
  assert.equal(first.notifications.length, 2);

  // After switching away, the same account reappears as anthropic@work at the
  // same usage — no re-alert, the armed state moved with the account.
  const parked = claude('anthropic@work', false, 91);
  const after = model.alertDecisions([parked], first.armedState, {enabled: true});
  assert.equal(after.notifications.length, 0);

  // A different account at the same usage still alerts.
  const other = claude('anthropic@home', false, 91);
  const fresh = model.alertDecisions([parked, other], after.armedState, {enabled: true});
  assert.deepEqual(Array.from(fresh.notifications, command => command[3]),
    ['home 5h at 91%', 'home 5h at 91%']);

  // Re-arm also follows the account: work resets below Warn, then re-crosses.
  const dropped = model.alertDecisions([claude('anthropic@work', false, 10)],
    fresh.armedState, {enabled: true});
  const recrossed = model.alertDecisions([claude('anthropic', true, 91, {account_label: 'work'})],
    dropped.armedState, {enabled: true});
  assert.equal(recrossed.notifications.length, 2);
});

test('service contracts: cooldown base on every failed switch, no dead consumed flag, busy IPC', () => {
  const service = fs.readFileSync(new URL('./Service.qml', import.meta.url), 'utf8');
  // Both finishSwitch arms set the cooldown base (success + failure).
  const finishSwitch = service.slice(service.indexOf('function finishSwitch'),
    service.indexOf('function finishSave'));
  assert.equal((finishSwitch.match(/lastSwitchMs = Date\.now\(\)/g) || []).length, 2);
  // The failure-arm assignment is unconditional (before the wasAuto guard).
  assert.match(finishSwitch, /lastSwitchMs = Date\.now\(\)\s*\n\s*if \(wasAuto\)/);
  assert.doesNotMatch(service, /reportConsumed/);
  // IPC refresh/toggleAccount refuse with "busy" instead of queueing.
  assert.equal((service.match(/return "busy"/g) || []).length, 2);
  // Parse decides success; the exit code is consulted only afterwards (C4).
  const finishRefresh = service.slice(service.indexOf('function finishRefresh'),
    service.indexOf('function finishSwitch'));
  assert.ok(finishRefresh.indexOf('Model.parseReport') < finishRefresh.indexOf('=== 127'));
});

test('settings page contracts stay pinned in QML', () => {
  const panel = fs.readFileSync(new URL('./Panel.qml', import.meta.url), 'utf8');
  // Esc must work from any focus state on the settings page: a window-scoped
  // shortcut guarded by settingsOpen, closing settings rather than the panel.
  assert.match(panel, /Shortcut\s*\{[^}]*sequences:\s*\["Escape"\][^}]*enabled:\s*root\.opened && root\.settingsOpen[^}]*onActivated:\s*root\.closeSettings\(\)/s);
  // Blank key input means "unchanged", driven by user edits only — a
  // programmatic text reset must not flip the pending action.
  assert.match(panel, /onTextEdited/);
  assert.doesNotMatch(panel, /onTextChanged:[^\n]*pendingAction/);
  // Clear is only offered when an inline key actually exists.
  assert.match(panel, /inline_configured\s*===\s*true/);
  // Leaving the panel always lands back on the main page with drafts dropped.
  assert.match(panel, /scrubProviderDrafts\(\)\s*\n\s*settingsOpen = false/);
});
