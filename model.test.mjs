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
  assert.equal(entry.login_state, '');
  assert.equal(model.loginState(entry), 'saved');
  assert.equal(model.loginRowState(entry), '');
  assert.equal(model.liveLoginCaption(entry), '');
});

test('old reports without login_state still render the legacy unsaved row', () => {
  const parsed = model.parseReport(JSON.stringify({entries: [{
    id: 'anthropic', display_name: 'Claude', plan: 'Max', status: 'ready', active: true,
    login_unsaved: true, sections: []
  }]}));
  const entry = parsed.entries[0];
  assert.equal(entry.login_state, '');
  assert.equal(model.loginState(entry), 'unsaved');
  assert.equal(model.isUnsavedLoginEntry(entry), true);
  assert.equal(model.unsavedLoginEntry(parsed.entries), entry);
  // No conflict label → no held rows, no Replace; the plain Save row as before.
  assert.equal(model.loginConflict(parsed.entries), null);
  assert.equal(model.unverifiedLogin(parsed.entries), null);
  assert.equal(model.loginRowState(entry), 'save');
  assert.equal(model.replaceTargetLabel(entry), '');
  assert.equal(model.liveLoginCaption(entry), '');
  assert.equal(model.claudeEntryEmail(entry), '');
  assert.equal(model.suggestedSaveLabel(entry, []), 'max');
  const saved = model.parseReport(JSON.stringify({entries: [{id: 'anthropic', status: 'ready', account_label: 'main'}]}));
  assert.equal(model.loginState(saved.entries[0]), 'saved');
  assert.equal(model.loginRowState(saved.entries[0]), '');
});

test('report parsing keeps login_state, e-mails, conflict/matches labels and identity_check bounded and validated', () => {
  const longLocal = 'x'.repeat(150);
  const parsed = model.parseReport(JSON.stringify({entries: [{
    id: 'anthropic', status: 'ready', active: true, login_unsaved: true,
    login_state: 'UNSAVED', login_email: ' B@Example.com ', login_conflict_label: 'leoleo',
    login_conflict_email: 'a@example.com', login_matches_label: 'Bad Label', identity_check: 'weird',
    account_email: 'ignored@example.com'
  }, {
    id: 'anthropic@work', status: 'ready', active: false, account_email: 'w @example.com',
    login_state: 'unverified', login_email: 'w@example.com'
  }, {
    id: 'anthropic', status: 'ready', login_state: 'unverified', identity_check: 'deferred',
    login_email: 'two words@example.com', login_conflict_label: '../etc', account_label: 'main'
  }, {
    id: 'anthropic', status: 'ready', login_state: 'saved', login_email: `${longLocal}@example.com`,
    login_conflict_email: 'no-at-sign', identity_check: 'unavailable', account_email: 'e\u0000vil@x.io'
  }]}));
  const [conflict, saved, deferred, bounded] = parsed.entries;
  // login_state is whitelisted (case-sensitive); a bad value is "" and the
  // legacy login_unsaved flag still yields the unsaved vocabulary.
  assert.equal(conflict.login_state, '');
  assert.equal(model.loginState(conflict), 'unsaved');
  assert.equal(conflict.login_email, 'B@Example.com');
  assert.equal(conflict.login_conflict_label, 'leoleo');
  assert.equal(conflict.login_conflict_email, 'a@example.com');
  assert.equal(conflict.login_matches_label, '');
  assert.equal(conflict.identity_check, '');
  assert.equal(conflict.account_email, 'ignored@example.com');
  assert.equal(model.claudeEntryEmail(conflict), 'B@Example.com');
  // Saved rows show their own address; whitespace fails the rule, and angle
  // brackets are escaped at the boundary like every other report string.
  assert.equal(saved.account_email, '');
  assert.equal(model.normalizeEntry({id: 'anthropic@w', account_email: '<w@example.com>'}).account_email,
    '‹w@example.com›');
  assert.doesNotMatch(model.normalizeEntry({id: 'anthropic', login_email: '<b@x.io>'}).login_email, /[<>]/);
  assert.equal(saved.login_state, 'unverified');
  assert.equal(model.claudeEntryEmail(saved), '');
  assert.equal(model.claudeEntryEmail({...saved, account_email: 'w@example.com'}), 'w@example.com');
  assert.equal(model.loginRowState(saved), '');
  assert.equal(model.liveLoginCaption(saved), '');
  // Whitespace inside an address or a path-like label is rejected.
  assert.equal(deferred.login_email, '');
  assert.equal(deferred.login_conflict_label, '');
  assert.equal(deferred.identity_check, 'deferred');
  assert.equal(model.loginRowState(deferred), '');
  assert.equal(model.liveLoginCaption(deferred), 'verifying login… saved copy updates on next check');
  // Over-long addresses are cut at 120 characters and still one token.
  assert.ok(bounded.login_email.length <= 120);
  assert.equal(bounded.login_conflict_email, '');
  // A control character is stripped at the boundary; the remainder is a plain address.
  assert.equal(bounded.account_email, 'evil@x.io');
  assert.equal(bounded.identity_check, 'unavailable');
  assert.equal(model.loginState(bounded), 'saved');
  for (const value of ['saved', 'rotated', 'unmanaged', 'unsaved', 'unverified'])
    assert.equal(model.normalizeEntry({id: 'anthropic', login_state: value}).login_state, value);
  for (const value of ['', null, 'Saved', 'un saved', 'deleted', 42])
    assert.equal(model.normalizeEntry({id: 'anthropic', login_state: value}).login_state, '');
  for (const value of ['deferred', 'unavailable'])
    assert.equal(model.normalizeEntry({id: 'anthropic', identity_check: value}).identity_check, value);
  for (const value of ['', 'Deferred', 'failed', null])
    assert.equal(model.normalizeEntry({id: 'anthropic', identity_check: value}).identity_check, '');
});

test('live-login states drive the conflict hold, the unverified block and the row captions', () => {
  const rows = [claude('anthropic@leoleo', false, 20, {account_email: 'a@example.com'})];
  const live = extra => ({...claude('anthropic', true, 40), account_label: '', ...extra});

  // unsaved + conflict: switching is held, Save as new + Replace naming both addresses
  const conflict = live({login_unsaved: true, login_state: 'unsaved', login_email: 'b@example.com',
    login_conflict_label: 'leoleo', login_conflict_email: 'a@example.com'});
  assert.equal(model.loginConflict([conflict, ...rows]), conflict);
  assert.equal(model.unverifiedLogin([conflict, ...rows]), null);
  assert.equal(model.loginRowState(conflict), 'conflict');
  assert.equal(model.replaceTargetLabel(conflict), 'leoleo');
  assert.equal(model.conflictCaption(conflict), 'Logged in as b@example.com — not “leoleo” (a@example.com)');
  assert.equal(model.replaceCaption(conflict), 'This forgets “leoleo” (a@example.com).');
  assert.equal(model.replaceCaption({...conflict, login_conflict_email: ''}), 'This forgets “leoleo” (saved login).');
  assert.equal(model.conflictCaption({...conflict, login_email: '', login_conflict_email: ''}),
    'Logged in as a different account — not “leoleo”');
  assert.equal(model.liveLoginCaption(conflict), '');
  assert.equal(model.claudeEntryEmail(conflict), 'b@example.com');
  assert.equal(model.claudeEntryEmail(rows[0]), 'a@example.com');

  // unsaved + matches: plain Save re-syncs the matching saved account
  // The backend always carries the marker as login_conflict_label alongside
  // login_matches_label; "matches" wins for the row state, and rows stay held.
  const matches = live({login_unsaved: true, login_state: 'unsaved', login_email: 'a@example.com',
    login_conflict_label: 'leonaffi', login_matches_label: 'leoleo'});
  assert.equal(model.loginRowState(matches), 'matches');
  assert.notEqual(model.loginConflict([matches, ...rows]), null);
  assert.equal(model.matchesCaption(matches), 'login matches saved account “leoleo”');
  assert.equal(model.suggestedSaveLabel(matches, model.savedLabels([matches, ...rows])), 'leoleo');

  // unmanaged (new backend) → the plain Save row
  const unmanaged = live({login_unsaved: true, login_state: 'unmanaged', login_email: 'c@example.com'});
  assert.equal(model.loginRowState(unmanaged), 'save');
  assert.equal(model.replaceTargetLabel(unmanaged), '');

  // unverified + deferred: no block, a quiet caption under the active row
  const deferred = live({login_state: 'unverified', identity_check: 'deferred', account_label: 'leoleo',
    login_email: 'b@example.com'});
  assert.equal(model.unverifiedLogin([deferred, ...rows]), deferred);
  assert.equal(model.loginConflict([deferred, ...rows]), null);
  assert.equal(model.loginRowState(deferred), '');
  assert.equal(model.liveLoginCaption(deferred), 'verifying login… saved copy updates on next check (b@example.com)');
  assert.equal(model.liveLoginCaption({...deferred, identity_check: ''}), 'verifying login… saved copy updates on next check (b@example.com)');
  assert.equal(model.liveLoginCaption({...deferred, login_email: ''}), 'verifying login… saved copy updates on next check');

  // unverified + unavailable: the explicit block, naming the live login when known
  const unavailable = {...deferred, identity_check: 'unavailable'};
  assert.equal(model.loginRowState(unavailable), 'unverified');
  assert.equal(model.replaceTargetLabel(unavailable), 'leoleo');
  assert.equal(model.liveLoginCaption(unavailable), '');
  assert.equal(model.unverifiedCaption(unavailable), 'Logged in as b@example.com — can\'t verify it\'s still “leoleo”');
  assert.equal(model.unverifiedConfirmCaption(unavailable), 'If b@example.com is not “leoleo”, “leoleo” is lost.');
  assert.equal(model.unverifiedCaption({...unavailable, login_email: ''}), 'can\'t verify the login is still “leoleo”');
  assert.equal(model.unverifiedConfirmCaption({...unavailable, login_email: ''}),
    'If this login is a different account, “leoleo” is lost.');
  // Save as new never proposes the marker itself.
  assert.equal(model.suggestedSaveLabel({...unavailable, login_email: 'leoleo@example.com'},
    model.savedLabels([unavailable, ...rows])), 'leoleo-2');
  // Without a usable marker label nothing destructive is offered.
  assert.equal(model.loginRowState({...unavailable, account_label: ''}), '');
  assert.equal(model.loginRowState({...unavailable, account_label: 'Bad Label'}), '');

  // rotated / saved: no block; rotated gets the one-line note
  assert.equal(model.loginRowState(live({login_state: 'rotated', account_label: 'leoleo'})), '');
  assert.equal(model.liveLoginCaption(live({login_state: 'rotated', account_label: 'leoleo'})),
    'saved copy updates on next check');
  assert.equal(model.liveLoginCaption(live({login_state: 'saved', account_label: 'leoleo'})), '');
  // Only the default entry ever carries a live-login state.
  assert.equal(model.loginRowState({...conflict, id: 'anthropic@x'}), '');
  assert.equal(model.replaceTargetLabel({...unavailable, id: 'anthropic@x'}), '');
  assert.equal(model.loginConflict([{...conflict, id: 'anthropic@x'}]), null);
  assert.equal(model.unverifiedLogin([{...unavailable, id: 'anthropic@x'}]), null);
  assert.deepEqual(Array.from(model.savedLabels([conflict, ...rows, claude('anthropic@Bad!', false, 1)])).sort(),
    ['leoleo']);
  assert.deepEqual(Array.from(model.savedLabels([live({account_label: 'main'}), ...rows])).sort(), ['leoleo', 'main']);
  // The draft key changes with every field that changes the suggestion.
  assert.notEqual(model.saveDraftKey(conflict), model.saveDraftKey(matches));
  assert.notEqual(model.saveDraftKey(unavailable), model.saveDraftKey({...unavailable, login_email: 'z@example.com'}));
  assert.equal(model.saveDraftKey(unavailable), model.saveDraftKey({...unavailable, identity_check: 'deferred'}));
  assert.equal(model.saveDraftKey(null), '');
  // Tooltips carry the address on line 1.
  assert.equal(model.entryTooltip(rows[0], 0).split('\n')[0], 'leoleo · a@example.com');
  assert.equal(model.entryTooltip({...rows[0], plan: 'Max'}, 0).split('\n')[0], 'leoleo · Max · a@example.com');
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
  assert.equal(model.suggestedSaveLabel({plan: '--force'}), 'force');
  assert.equal(model.suggestedSaveLabel(null), 'main');
  for (const label of ['main', 'work-2', 'acct_one', 'a'.repeat(32)])
    assert.equal(model.validSaveLabel(label), true);
  for (const label of ['', 'Work', '../main', 'has space', 'a'.repeat(33)])
    assert.equal(model.validSaveLabel(label), false);
});

test('suggested save label prefers matches_label, then the e-mail local part, then the plan, and avoids collisions', () => {
  assert.equal(model.suggestedSaveLabel({login_email: 'Leo.Naffi+x@example.com', plan: 'Max'}, []), 'leonaffix');
  assert.equal(model.suggestedSaveLabel({login_matches_label: 'work', login_email: 'leo@example.com', plan: 'Max'},
    ['work', 'leo']), 'work');
  assert.equal(model.suggestedSaveLabel({login_matches_label: 'Bad Label', login_email: 'leo@example.com'}, []), 'leo');
  assert.equal(model.suggestedSaveLabel({login_email: 'not-an-email', plan: 'Claude Max 20x'}, []), 'claudemax20x');
  assert.equal(model.suggestedSaveLabel({login_email: '@example.com', plan: ''}, []), 'main');
  assert.equal(model.suggestedSaveLabel({login_email: '_-leo@example.com'}, []), 'leo');
  assert.equal(model.suggestedSaveLabel({login_email: `${'a'.repeat(40)}@example.com`}, []), 'a'.repeat(20));
  // Collisions with a different saved account append -2, -3, … within 20 characters.
  assert.equal(model.suggestedSaveLabel({login_email: 'leo@example.com'}, ['leo']), 'leo-2');
  assert.equal(model.suggestedSaveLabel({login_email: 'leo@example.com'}, ['leo', 'leo-2']), 'leo-3');
  assert.equal(model.suggestedSaveLabel({plan: 'Max'}, ['max', 'max-2', 'max-3']), 'max-4');
  const long = model.suggestedSaveLabel({login_email: `${'b'.repeat(40)}@example.com`}, ['b'.repeat(20)]);
  assert.equal(long, `${'b'.repeat(18)}-2`);
  assert.equal(long.length, 20);
  for (const label of [long, 'leo-2', 'leonaffix', 'max-4']) assert.equal(model.validSaveLabel(label), true);
  // The matching saved account is the one name that is never suffixed.
  assert.equal(model.suggestedSaveLabel({login_matches_label: 'leo'}, ['leo']), 'leo');
  assert.equal(model.suggestedSaveLabel({login_email: 'main@example.com'}, undefined), 'main');
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
  assert.equal(decision([{...active, login_state: 'unverified', identity_check: 'deferred'}, target]).reason,
    'login-unverified');
  assert.equal(decision([claude('anthropic', true, 84), target]).reason, 'under-threshold');
  assert.equal(decision([active, claude('anthropic@work', false, 76)]).reason, 'no-candidate');
  assert.equal(decision([active, target], {lastSwitchMs: 1_400_001}).reason, 'cooldown');
});

test('auto-switch stays off for unsaved and unverified logins', () => {
  const target = claude('anthropic@work', false, 30);
  const active = extra => ({...claude('anthropic', true, 95), account_label: 'main', ...extra});
  for (const state of ['unsaved', 'unmanaged'])
    assert.equal(decision([active({login_unsaved: true, login_state: state}), target]).reason, 'unsaved-login');
  for (const check of ['deferred', 'unavailable', ''])
    assert.equal(decision([active({login_state: 'unverified', identity_check: check}), target]).reason,
      'login-unverified');
  // A saved or rotated login switches as before; only the default row's state counts.
  assert.equal(decision([active({login_state: 'saved'}), target]).action, 'switch');
  assert.equal(decision([active({login_state: 'rotated'}), target]).action, 'switch');
  assert.equal(decision([active({}), {...target, login_state: 'unverified'}]).action, 'switch');
  // Parsed reports carry the same outcome end to end.
  const parsed = model.parseReport(JSON.stringify({entries: [
    {...active({login_state: 'unverified', identity_check: 'unavailable'})}, target
  ]}));
  assert.equal(decision(parsed.entries).reason, 'login-unverified');
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
  assert.deepEqual(JSON.parse(JSON.stringify(off.armedState)), {});

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

test('backend commands use one fixed positional wrapper and validate their bounds', () => {
  const args = ['usage', '--profile', 'team name', '${HOME}', '-x'];
  const command = Array.from(model.backendCommand('/opt/switch board/bin', args, 90, 1048576));
  assert.deepEqual(command.slice(0, 2), ['/usr/bin/env', '-i']);
  assert.equal(typeof model.WRAPPER_SCRIPT, 'string');
  assert.equal(command[command.indexOf('-c') + 1], model.WRAPPER_SCRIPT);
  assert.equal(command[command.indexOf('switchboard-backend')], 'switchboard-backend');
  const at = command.indexOf('switchboard-backend');
  assert.deepEqual(command.slice(at + 1, at + 5), ['90', '1048576', '-', '/opt/switch board/bin']);
  assert.deepEqual(command.slice(at + 5), args);

  const script = command[command.indexOf('-c') + 1];
  assert.match(script, /deadline=\$1; cap=\$2; expected=\$3; backend=\$4; shift 4/);
  assert.match(script, /\$TIMEOUT" --kill-after=5/);
  assert.match(script, /head -c 65536/);
  assert.match(script, /head -c "\$\(\(cap \+ 1\)\)"/);
  assert.match(script, /exec "\$TIMEOUT" --kill-after=5/);
  assert.doesNotMatch(script, /\/opt\/switch board|team name|\$\{HOME\}|--profile/);

  for (const deadline of [0, 601, 1.5, NaN, Infinity, '90'])
    assert.equal(model.backendCommand('/bin/tool', [], deadline, 4096), null);
  for (const cap of [4095, 4194305, 4096.5, NaN, Infinity, '4096'])
    assert.equal(model.backendCommand('/bin/tool', [], 1, cap), null);
  for (const binary of ['', null, 42])
    assert.equal(model.backendCommand(binary, [], 1, 4096), null);
  assert.equal(model.backendCommand('/bin/tool', null, 1, 4096), null);
  assert.equal(model.backendCommand('/bin/tool', ['ok', 2], 1, 4096), null);
});

test('manifest and QML retain the required plugin lifecycle contracts', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, 'leoom.switchboard');
  assert.equal(manifest.name, 'Switchboard');
  assert.equal(manifest.version, '2.1.0');
  assert.equal(manifest.license, 'MIT');
  assert.deepEqual(manifest.kinds, ['service', 'bar-widget']);
  assert.equal(manifest.keepLoaded, true);
  assert.deepEqual(manifest.entryPoints, {service: 'Service.qml', barWidget: 'BarWidget.qml'});
  assert.deepEqual(manifest.barWidget.defaults, {
    refreshIntervalSec: 300, barShows: 'claude', autoSwitch: false, autoThreshold: 85, alerts: false, developerBackend: ''
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
  assert.match(service, /Model\.backendCommand\(resolvedBinary, \["usage", "--json"\], 90, 1048576, developerBackendActive \? null : resolvedSha256, backendEnvironment\(\)\)/);
  assert.match(service, /Model\.backendCommand\(resolvedBinary,\s*\["account", "switch", String\(label\), "--cli"\], 30, 65536, developerBackendActive \? null : resolvedSha256, backendEnvironment\(\)\)/);
  assert.match(service, /Model\.backendCommand\(resolvedBinary,\s*\["account", "save", String\(label\)\], 30, 65536, developerBackendActive \? null : resolvedSha256, backendEnvironment\(\)\)/);
  assert.match(service, /Model\.backendCommand\(resolvedBinary,\s*\["account", "toggle"\], 30, 65536, developerBackendActive \? null : resolvedSha256, backendEnvironment\(\)\)/);
  assert.match(service, /Model\.backendCommand\(resolvedBinary,\s*\["settings", "show"\], 15, 262144, developerBackendActive \? null : resolvedSha256, backendEnvironment\(\)\)/);
  assert.match(service, /Model\.backendCommand\(resolvedBinary,\s*\["settings", "apply"\], 20, 65536, developerBackendActive \? null : resolvedSha256, backendEnvironment\(\)\)/);
  assert.match(service, /stdinEnabled:\s*true/);
  assert.match(service, /write\(root\.settingsApplyPayload \+ "\\n"\)[\s\S]*?settingsApplyPayload = ""/);
  assert.match(service, /Model\.settingsApplySucceeded\(exitCode, settingsApplyStdout\)/);
  assert.match(service, /refreshIntervalSec = Model\.integerSetting\([^\n]*, 300, 60, 3600, 30\)/);
  assert.match(service, /\["notify-send", "-a", "Switchboard", "Claude auto-switch"/);
  assert.match(service, /Model\.alertDecisions\(parsed\.entries, alertArmedState,/);
  // Exactly one --force in the service: the deliberate Overwrite/Replace path
  // (saveAccountForce), reached only from the panel behind an explicit
  // confirm; the plain saveAccount never forces, and no comment may carry the
  // token either (the count above is the whole contract).
  assert.equal((service.match(/--force/g) || []).length, 1);
  assert.match(service, /function saveAccountForce\(label\)[\s\S]*?\["account", "save", String\(label\), "--force"\]/);
  for (const line of service.split('\n').filter(row => row.includes('--force')))
    assert.doesNotMatch(line, /^\s*\/\//);
  const plainSave = service.slice(service.indexOf('function saveAccount(label)'),
    service.indexOf('function saveAccountForce'));
  assert.doesNotMatch(plainSave, /--force/);
  // Switch/toggle argv unchanged: no --force, no new subcommand.
  assert.doesNotMatch(service, /\["account", "switch"[^\]]*--force/);
  assert.doesNotMatch(service, /\["account", "toggle"[^\]]*--force/);
  // Identity state lives beside unsavedEntry; the confirm label is cleared by
  // every parsed report and every save result.
  assert.match(service, /readonly property var loginConflict:\s*Model\.loginConflict\(entries\)/);
  assert.match(service, /readonly property var unverifiedLogin:\s*Model\.unverifiedLogin\(entries\)/);
  assert.match(service, /property string replaceConfirmLabel:\s*""/);
  const finishRefreshOk = service.slice(service.indexOf('if (parsed.ok) {'), service.indexOf('Model.autoSwitchDecision('));
  assert.match(finishRefreshOk, /replaceConfirmLabel = ""/);
  const finishSaveBody = service.slice(service.indexOf('function finishSave'), service.indexOf('function renameAccount'));
  assert.ok(finishSaveBody.indexOf('replaceConfirmLabel = ""') < finishSaveBody.indexOf('boundedCompletionError'));
  assert.equal((service.match(/root\.completionsPending\+\+/g) || []).length, 8);
  assert.equal((service.match(/root\.completionsPending--/g) || []).length, 1);

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
  assert.match(panel, /Model\.entryTooltip\(entry, root\.nowMs\)/);
  assert.doesNotMatch(panel, /Model\.agentMeterCaption\(/);
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
  // Overwrite affordance for a save the backend refused (differing login):
  // gated on the exact refused label, forces only that label, clears on edit.
  assert.match(panel, /root\.svc\.saveConflictLabel !== ""[\s\S]{0,80}?saveConflictLabel === root\.saveDraft/);
  assert.match(panel, /onClicked:\s*root\.svc\.saveAccountForce\(root\.saveDraft\)/);
  assert.match(panel, /onTextEdited:\s*\{[\s\S]*?root\.svc\.saveConflictLabel = ""/);
  assert.match(panel, /onTextEdited:\s*\{[\s\S]*?root\.svc\.replaceConfirmLabel = ""/);
  assert.match(panel, /Name uses lowercase letters/);
  // saveAccountForce is reached from exactly two places: the Overwrite row
  // (saveConflictLabel) and the Replace/Update confirm row, whose visibility
  // and argument are both the label the user opened it for.
  assert.equal((panel.match(/saveAccountForce\(/g) || []).length, 2);
  assert.match(panel, /onClicked:\s*root\.svc\.saveAccountForce\(root\.svc\.replaceConfirmLabel\)/);
  assert.match(panel, /readonly property bool confirmShown:[^\n]*\n?[^\n]*svc\.replaceConfirmLabel === replaceTarget/);
  const confirmRow = panel.slice(panel.indexOf('visible: root.confirmShown'),
    panel.indexOf('saveAccountForce(root.svc.replaceConfirmLabel)'));
  assert.match(confirmRow, /textFormat:\s*Text\.PlainText/);
  assert.match(confirmRow, /Model\.replaceCaption\(root\.loginEntry\)/);
  assert.match(confirmRow, /Model\.unverifiedConfirmCaption\(root\.loginEntry\)/);
  assert.match(confirmRow, /color:\s*Color\.urgent/);
  assert.match(confirmRow, /text:\s*root\.loginRow === "conflict" \? "Replace" : "Update"/);
  // Openers only set the confirm label; they never force anything themselves.
  const openers = panel.slice(panel.indexOf('// Quiet second-step openers'), panel.indexOf('visible: root.confirmShown'));
  assert.equal((openers.match(/onClicked:\s*root\.svc\.replaceConfirmLabel = root\.replaceTarget/g) || []).length, 2);
  assert.doesNotMatch(openers, /saveAccountForce|saveAccount\(/);
  assert.match(openers, /"Replace " \+ Model\.quoted\(root\.replaceTarget\)/);
  assert.match(openers, /"Update " \+ Model\.quoted\(root\.replaceTarget\) \+ "\\u2026"/);
  assert.match(openers, /"Save as new\\u2026"/);
  // The live-login block is state-driven; the plain Save row survives for
  // unmanaged/legacy logins, and captions are PlainText, elided, one accent.
  assert.match(panel, /readonly property string loginRow:\s*Model\.loginRowState\(loginEntry\)/);
  assert.match(panel, /readonly property var loginEntry:\s*svc \? \(svc\.unsavedEntry \|\| svc\.unverifiedLogin\) : null/);
  assert.match(panel, /text:\s*"unsaved login"/);
  assert.match(panel, /text:\s*Model\.conflictCaption\(root\.loginEntry\)[\s\S]{0,40}color:\s*Color\.urgent/);
  assert.match(panel, /text:\s*Model\.unverifiedCaption\(root\.loginEntry\)[\s\S]{0,40}color:\s*Color\.muted/);
  assert.match(panel, /text:\s*Model\.matchesCaption\(root\.loginEntry\)[\s\S]{0,40}color:\s*Color\.muted/);
  assert.match(panel, /\? "Save" : "Save as new"/);
  assert.match(panel, /Model\.suggestedSaveLabel\(entry, Model\.savedLabels\(svc\.entries\)\)/);
  assert.match(panel, /Model\.saveDraftKey\(entry\)/);
  // Every Text in the panel is PlainText: report-controlled strings never
  // reach a rich-text parser.
  assert.equal((panel.match(/^\s*Text \{/gm) || []).length,
    (panel.match(/textFormat:\s*Text\.PlainText/g) || []).length);
  assert.doesNotMatch(panel, /Text\.RichText|Text\.AutoText|Text\.StyledText|Text\.MarkdownText/);
  const mainRows = panel.slice(panel.indexOf('component ClaudeAccountRow'),
    panel.indexOf('component ProviderKeyRow'));
  assert.doesNotMatch(mainRows, /wrapMode:\s*Text\.WordWrap/);
  assert.doesNotMatch(mainRows, /maximumLineCount:\s*2/);
  // Rows: the switch button is held during a conflict (with a tooltip that
  // says why), the e-mail subtitle is a muted elided caption, and the
  // verifying/rotated note sits under the row.
  const claudeRow = panel.slice(panel.indexOf('component ClaudeAccountRow'), panel.indexOf('component AgentRow'));
  // Held rows stay enabled so their tooltip is reachable; the click itself is the guard.
  assert.match(claudeRow, /enabled:\s*!claudeRow\.renaming\s*\n?\s*&& \(!claudeRow\.switchable \|\| \(!!root\.svc && !root\.svc\.busy\)\)/);
  assert.match(claudeRow, /onClicked:\s*if \(claudeRow\.switchable && root\.svc && !claudeRow\.held\) root\.svc\.switchEntry\(claudeRow\.entry\)/);
  assert.match(claudeRow, /"Save or replace the current login first"/);
  assert.match(claudeRow, /Model\.claudeEntryEmail\(entry\)/);
  assert.match(claudeRow, /text:\s*claudeRow\.email[\s\S]{0,40}color:\s*Color\.muted[\s\S]{0,80}font\.pixelSize:\s*Style\.font\.caption/);
  assert.match(claudeRow, /Model\.liveLoginCaption\(entry\)/);
  assert.match(claudeRow, /text:\s*claudeRow\.liveCaption[\s\S]{0,40}color:\s*Color\.muted/);
  assert.doesNotMatch(claudeRow, /Color\.urgent/);
  assert.doesNotMatch(panel, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
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

test('every service process is bounded and stopped during destruction', () => {
  const service = fs.readFileSync(new URL('./Service.qml', import.meta.url), 'utf8');
  const commandProperties = service.match(/^\s*command:\s*\[\]\s*$/gm) || [];
  assert.equal(commandProperties.length, 8);
  assert.equal((service.match(/Process\.command\s*=\s*Model\.backendCommand\(/g) || []).length, 1);
  assert.equal((service.match(/startBounded\([a-zA-Z]+Process, "[a-zA-Z]+", Model\.backendCommand\(/g) || []).length, 9);
  assert.doesNotMatch(service, /Process\.command\s*=\s*\[/);
  assert.doesNotMatch(service, /\["\/usr\/bin\/env",\s*resolvedBinary/);
  assert.match(service, /Model\.backendCommand\(selection\.path, \["--version"\], 5, 4096,/);
  assert.equal((service.match(/startBounded\(/g) || []).length >= 8, true);
  assert.match(service, /Model\.backendCommand\("\/usr\/bin\/notify-send", \["--"\]\.concat\(command\.slice\(1\)\), 10, 4096, null, backendEnvironment\(\)\)/);

  const boundedHelper = service.slice(service.indexOf('function boundedCompletionError'),
    service.indexOf('function enqueueNotification'));
  assert.match(boundedHelper, /code === 124 \|\| code === 137/);
  assert.match(boundedHelper, /Model\.utf8ByteLength\(stdoutText\) > capBytes/);
  assert.match(boundedHelper, /timed out after/);
  assert.match(boundedHelper, /output exceeded/);
  // One guard per Process completion path, plus the helper declaration.
  assert.equal((service.match(/boundedCompletionError\(/g) || []).length, 9);

  const finishRefresh = service.slice(service.indexOf('function finishRefresh'),
    service.indexOf('// --------------------------------------------------------------- actions'));
  assert.ok(finishRefresh.indexOf('boundedCompletionError') < finishRefresh.indexOf('Model.parseReport'));
  const finishShow = service.slice(service.indexOf('function finishSettingsShow'),
    service.indexOf('function applySettingsPatch'));
  assert.ok(finishShow.indexOf('boundedCompletionError') < finishShow.indexOf('Model.parseSettingsSnapshot'));
  const finishApply = service.slice(service.indexOf('function finishSettingsApply'),
    service.indexOf('function failureMessage'));
  assert.ok(finishApply.indexOf('boundedCompletionError') < finishApply.indexOf('Model.settingsApplySucceeded'));

  const destruction = service.slice(service.indexOf('Component.onDestruction'));
  for (const id of ['probeProcess', 'usageProcess', 'switchProcess', 'saveProcess',
    'renameProcess', 'notifyProcess', 'settingsShowProcess', 'settingsApplyProcess'])
    assert.match(destruction, new RegExp(`${id}\\.running = false`));
  assert.match(destruction, /completionsPending = 0/);
  assert.match(destruction, /refreshQueued = false/);
  assert.match(destruction, /settingsLoadQueued = false/);
  assert.match(destruction, /notificationQueue = \[\]/);
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

test('renameLabel resolves only concrete valid flat labels', () => {
  assert.equal(model.renameLabel({id: 'anthropic@work'}), 'work');
  assert.equal(model.renameLabel({id: 'anthropic', account_label: 'main'}), 'main');
  assert.equal(model.renameLabel({id: 'anthropic', account_label: ''}), null);
  assert.equal(model.renameLabel({id: 'anthropic@Bad Label'}), null);
  assert.equal(model.renameLabel({id: 'openai'}), null);
  assert.equal(model.renameLabel(null), null);
});

test('providers without a key are hidden from rows, bar, tooltip, and status', () => {
  const keyless = {id: 'zai', display_name: 'Z.AI', short_name: 'zai', status: 'error', error: 'no API key', sections: []};
  const live = {id: 'openai', display_name: 'Codex', short_name: 'gpt', status: 'ready', error: '', sections: [metric('Codex weekly', 45)]};
  const shown = model.presentableEntries([keyless, live, claude('anthropic', true, 51)]);
  assert.deepEqual(Array.from(shown, row => row.id), ['openai', 'anthropic']);
  assert.deepEqual(Array.from(model.groupEntries(shown).agents, row => row.id), ['openai']);
  assert.ok(!model.buildBarSegments(shown, 'all').some(segment => segment.family === 'zai'));
  assert.doesNotMatch(model.statusLine(shown), /zai/);
  assert.doesNotMatch(model.barTooltip(shown, 'claude'), /zai/);
});

test('row tooltips use full metric labels, one per line, plus health and status notes', () => {
  const now = Date.UTC(2026, 8, 2, 10, 0, 0);
  const inTwoDays = new Date(now + 2 * 86400000 + 20 * 3600000).toISOString();
  const kimi = {id: 'kimi', display_name: 'Kimi', short_name: 'kmi', plan: 'Allegretto', status: 'ready', error: '', stale: false,
    sections: [metric('Weekly quota', 28, inTwoDays), metric('Rolling window (5h)', 100)]};
  const tip = model.entryTooltip(kimi, now);
  assert.equal(tip.split('\n')[0], 'Kimi · Allegretto');
  assert.match(tip, /^Weekly quota: 28% · resets 2d 20h$/m);
  assert.match(tip, /^Rolling window \(5h\): 100%$/m);
  assert.doesNotMatch(tip, /…|—/);

  const codex = {id: 'openai', display_name: 'Codex', short_name: 'gpt', plan: '', status: 'ready', error: '', stale: true,
    sections: [metric('Codex weekly', 60), {type: 'text', label: 'Credits balance', value: '0'}]};
  const codexTip = model.entryTooltip(codex, now);
  assert.match(codexTip, /^Codex weekly: 60%$/m);
  assert.match(codexTip, /^Credits balance: 0$/m);
  assert.match(codexTip, /cached/);

  const broken = {id: 'zai', display_name: 'Z.AI', status: 'error', error: 'no API key', sections: []};
  assert.equal(model.entryTooltip(broken, now), 'Z.AI\nerror: no API key');
  assert.equal(model.entryTooltip(null, now), '');
});

test('the wrapper really bounds, times out, and dies as a group (executes bash)', async () => {
  const {spawn, execFileSync} = await import('node:child_process');
  const run = (argv, opts = {}) => new Promise(resolve => {
    const child = spawn(argv[0], argv.slice(1), {stdio: ['pipe', 'pipe', 'pipe']});
    const out = []; const err = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin); else child.stdin.end();
    if (opts.killAfterMs) setTimeout(() => child.kill('SIGTERM'), opts.killAfterMs);
    child.on('close', code => resolve({code, stdout: Buffer.concat(out), stderr: Buffer.concat(err)}));
  });
  const lingering = tag => {
    try { return execFileSync('pgrep', ['-x', '-f', `sleep ${tag}`]).toString().trim().split('\n').filter(Boolean).length; }
    catch (error) { return 0; }
  };
  const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

  // deadline: exit 124, and the grandchild sleep is gone with the group
  const dead = await run(model.backendCommand('/usr/bin/bash', ['-c', 'sleep 71 & sleep 71'], 1, 4096));
  await settle(300);
  assert.equal(dead.code, 124);
  assert.equal(lingering(71), 0);

  // destruction: SIGTERM to the managed process takes the whole group down
  const killed = await run(model.backendCommand('/usr/bin/bash', ['-c', 'sleep 72 & sleep 72'], 30, 4096), {killAfterMs: 300});
  await settle(300);
  assert.notEqual(killed.code, 0);
  assert.equal(lingering(72), 0);

  // cap: producer emits cap+1 bytes at most, so byte length proves overflow
  const over = await run(model.backendCommand('/usr/bin/head', ['-c', '100000', '/dev/zero'], 5, 4096));
  assert.equal(over.stdout.length, 4097);
  assert.ok(model.utf8ByteLength(over.stdout.toString('latin1')) > 4096);

  // stdin passes through bash → timeout → command; stderr is capped separately
  const echoed = await run(model.backendCommand('/usr/bin/cat', [], 5, 4096), {stdin: '{"ok":true}\n'});
  assert.equal(echoed.code, 0);
  assert.equal(echoed.stdout.toString(), '{"ok":true}\n');
  const missing = await run(model.backendCommand('/nonexistent/ai-usagebar', ['usage'], 5, 4096));
  assert.equal(missing.code, 127);
  assert.equal(missing.stdout.length, 0);
});

test('utf8ByteLength counts bytes, not UTF-16 units', () => {
  assert.equal(model.utf8ByteLength('abc'), 3);
  assert.equal(model.utf8ByteLength('€€'), 6);
  assert.equal(model.utf8ByteLength(''), 0);
  assert.equal(model.utf8ByteLength(null), 0);
});

test('backend completion waits for exit and both capped streams', () => {
  const service = fs.readFileSync(new URL('./Service.qml', import.meta.url), 'utf8');
  // every process marks exit + stdout end + stderr end; parsing only runs from the gate
  assert.equal((service.match(/root\.markCompletion\("[A-Za-z]+", "exit", exitCode\)/g) || []).length, 8);
  assert.equal((service.match(/root\.markCompletion\("[A-Za-z]+", "out"\)/g) || []).length, 8);
  assert.equal((service.match(/root\.markCompletion\("[A-Za-z]+", "err"\)/g) || []).length, 8);
  assert.match(service, /if \(state\.exit === null \|\| !state\.out \|\| !state\.err\) return/);
  assert.doesNotMatch(service, /onExited: function\(exitCode\) \{[^}]*Qt\.callLater/);
  assert.ok((service.match(/beginCompletion\(/g) || []).length >= 2);
});

test('execution is bound to a verified descriptor: hash, symlink, ownership, permissions, PATH', async () => {
  const {spawnSync} = await import('node:child_process');
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const crypto = await import('node:crypto');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-trust-'));
  const backend = path.join(dir, 'fake-backend');
  const marker = path.join(dir, 'ran');
  await fsp.writeFile(backend, `#!/usr/bin/bash\nprintf ran > "${marker}"\necho "fake $1"\n`, {mode: 0o755});
  const sha = crypto.createHash('sha256').update(await fsp.readFile(backend)).digest('hex');
  const run = (argv, env) => spawnSync(argv[0], argv.slice(1), {encoding: 'utf8', env: env || process.env, timeout: 20000});
  const exists = async p => !!(await fsp.stat(p).catch(() => null));

  // matching hash → runs; argv reaches the backend; stdout complete
  let r = run(model.backendCommand(backend, ['--version'], 5, 4096, sha));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'fake --version');
  assert.equal(await exists(marker), true);
  await fsp.rm(marker);

  // wrong hash → 126, never executed
  r = run(model.backendCommand(backend, ['--version'], 5, 4096, '0'.repeat(64)));
  assert.equal(r.status, 126);
  assert.match(r.stderr, /integrity check failed/);
  assert.equal(await exists(marker), false);

  // symlink → rejected even with a matching hash
  const link = path.join(dir, 'link');
  await fsp.symlink(backend, link);
  r = run(model.backendCommand(link, ['--version'], 5, 4096, sha));
  assert.equal(r.status, 126);
  assert.match(r.stderr, /symlink/);
  assert.equal(await exists(marker), false);

  // group/world-writable → rejected
  await fsp.chmod(backend, 0o775);
  r = run(model.backendCommand(backend, ['--version'], 5, 4096, sha));
  assert.equal(r.status, 126);
  assert.match(r.stderr, /writable/);
  await fsp.chmod(backend, 0o755);

  // missing → 127, no output
  r = run(model.backendCommand(path.join(dir, 'absent'), ['--version'], 5, 4096, sha));
  assert.equal(r.status, 127);
  assert.equal(r.stdout, '');

  // relative path or bad hash never even builds a command
  assert.equal(model.backendCommand('ai-usagebar', ['x'], 5, 4096, sha), null);
  assert.equal(model.backendCommand(backend, ['x'], 5, 4096, 'nothex'), null);

  // developer override (no hash) still enforces the file checks
  r = run(model.backendCommand(backend, ['--version'], 5, 4096, null));
  assert.equal(r.status, 0);
  await fsp.rm(marker);

  // PATH poisoning: evil bash/timeout/head/sha256sum/stat on PATH are ignored
  const evil = path.join(dir, 'evil');
  await fsp.mkdir(evil);
  for (const tool of ['bash', 'timeout', 'head', 'sha256sum', 'stat', 'id', 'env']) {
    await fsp.writeFile(path.join(evil, tool), `#!/usr/bin/bash\nprintf evil > "${dir}/poisoned"\nexit 99\n`, {mode: 0o755});
  }
  r = run(model.backendCommand(backend, ['--version'], 5, 4096, sha), {...process.env, PATH: evil});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await exists(path.join(dir, 'poisoned')), false);
  assert.equal(await exists(marker), true);
  await fsp.rm(dir, {recursive: true, force: true});
});

test('backend selection prefers the trusted pinned path and only an explicit absolute override', () => {
  const normal = model.backendSelection('/home/u', '');
  assert.equal(normal.path, '/home/u/.local/share/switchboard/backend/ai-usagebar');
  assert.equal(normal.sha256, model.BACKEND_SHA256);
  assert.equal(normal.developer, false);
  assert.match(model.BACKEND_SHA256, /^[0-9a-f]{64}$/);
  const dev = model.backendSelection('/home/u', '/opt/dev/ai-usagebar');
  assert.equal(dev.path, '/opt/dev/ai-usagebar');
  assert.equal(dev.sha256, null);
  assert.equal(dev.developer, true);
  assert.equal(model.backendSelection('/home/u', 'relative/path').developer, false);
  assert.equal(model.backendSelection('', '').path, '');
  assert.equal(model.developerBackendSetting('  /x/y  '), '/x/y');
  assert.equal(model.developerBackendSetting('x'), '');
  const built = model.backendCommand('/usr/bin/true', [], 5, 4096, null);
  const script = built[built.indexOf('-c') + 1];
  assert.doesNotMatch(script, /\benv\b/);
  for (const tool of ['timeout', 'bash', 'head', 'sha256sum', 'stat', 'id'])
    assert.match(script, new RegExp('/usr/bin/' + tool));
  assert.match(script, /exec 9< "\$backend"/);
  assert.match(script, /\/dev\/fd\/9 "\$@"/);
});

test('environment cannot subvert the wrapper: env -i allow-list, BASH_ENV, LD_PRELOAD, hostile labels', async () => {
  const {spawnSync} = await import('node:child_process');
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const crypto = await import('node:crypto');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-env-'));
  const backend = path.join(dir, 'backend');
  await fsp.writeFile(backend, '#!/usr/bin/bash\nprintf "%s|%s|%s" "${BASH_ENV:-none}" "${LD_PRELOAD:-none}" "${PATH}"\n', {mode: 0o755});
  const sha = crypto.createHash('sha256').update(await fsp.readFile(backend)).digest('hex');
  const trap = path.join(dir, 'trap.sh');
  await fsp.writeFile(trap, `printf trapped > "${dir}/trapped"\n`);
  const env = model.safeEnvironment({HOME: '/home/x', USER: 'x', BASH_ENV: trap, LD_PRELOAD: '/evil.so', PATH: '/evil'});
  assert.equal(env.filter(p => /^(BASH_ENV|LD_PRELOAD)=/.test(p)).length, 0);
  assert.ok(env.includes('PATH=/usr/bin') && env.includes('HOME=/home/x'));
  const r = spawnSync('/usr/bin/env', model.backendCommand(backend, [], 5, 4096, sha, env).slice(1),
    {encoding: 'utf8', env: {BASH_ENV: trap, LD_PRELOAD: '/evil.so', PATH: '/evil', HOME: '/home/x'}});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'none|none|/usr/bin');
  assert.equal(!!(await fsp.stat(path.join(dir, 'trapped')).catch(() => null)), false);
  // hostile environment entries never build a command
  assert.equal(model.backendCommand(backend, [], 5, 4096, sha, ['PATH=/usr/bin', 'X=a\nb']), null);
  assert.equal(model.backendCommand(backend, [], 5, 4096, sha, ['not an assignment']), null);
  // setuid backend refused; group-writable directory refused
  await fsp.chmod(backend, 0o4755);
  let rr = spawnSync('/usr/bin/env', model.backendCommand(backend, [], 5, 4096, sha, env).slice(1), {encoding: 'utf8'});
  assert.equal(rr.status, 126); assert.match(rr.stderr, /setuid/);
  await fsp.chmod(backend, 0o755);
  await fsp.chmod(dir, 0o775);
  rr = spawnSync('/usr/bin/env', model.backendCommand(backend, [], 5, 4096, sha, env).slice(1), {encoding: 'utf8'});
  assert.equal(rr.status, 126); assert.match(rr.stderr, /directory is writable/);
  await fsp.chmod(dir, 0o755);
  // labels can never look like options
  for (const bad of ['-h', '--force', '-']) {
    assert.equal(model.validSaveLabel(bad), false);
    assert.equal(model.isSwitchableEntry({id: 'anthropic@' + bad, active: false}), false);
    assert.equal(model.renameLabel({id: 'anthropic@' + bad}), null);
  }
  assert.equal(model.validSaveLabel('a-b'), true);
  await fsp.rm(dir, {recursive: true, force: true});
});

test('isLineageConflict recognises the differing-login save refusal only', () => {
  const refusal = 'ai-usagebar account save: credentials error: refusing to overwrite '
    + 'existing flat Claude account "personal": its credential lineage differs from '
    + 'the live login; pass `--force` to replace it';
  assert.equal(model.isLineageConflict(refusal), true);
  // The identity-aware backend names both logins; the sentinel words survive.
  const identityRefusal = 'ai-usagebar account save: credentials error: refusing to overwrite '
    + 'existing flat Claude account "leoleo": its login differs from the live login '
    + '(saved: a@example.com, live: b@example.com); pass `--force` to replace it, '
    + 'or save under a new name';
  assert.equal(model.isLineageConflict(identityRefusal), true);
  assert.equal(model.isLineageConflict(identityRefusal.replace('a@example.com', 'unknown')), true);
  // A refusal for an unverified or different login on switch is not a save conflict.
  assert.equal(model.isLineageConflict('cannot verify that the live Claude login still belongs to '
    + '"leoleo" (the live login\'s account is not known yet); retry while online, run `account save '
    + '<new-name>`, or pass `--force` to switch and discard the live login'), false);
  // Unrelated failures must not offer Overwrite.
  assert.equal(model.isLineageConflict('ai-usagebar account save: credentials error: '
    + 'invalid flat account label "Bad Label": use [a-z0-9_-]+'), false);
  assert.equal(model.isLineageConflict('ai-usagebar not found'), false);
  assert.equal(model.isLineageConflict(''), false);
  assert.equal(model.isLineageConflict(null), false);
  assert.equal(model.isLineageConflict(undefined), false);
});

test('bash never sources startup files, even when the caller hands it socket stdio', async () => {
  const {spawnSync} = await import('node:child_process');
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const crypto = await import('node:crypto');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-rc-'));
  const backend = path.join(dir, 'backend');
  await fsp.writeFile(backend, '#!/usr/bin/bash\nprintf "%s|%s" "$PATH" "${SB_RC_MARKER:-none}"\n', {mode: 0o755});
  const sha = crypto.createHash('sha256').update(await fsp.readFile(backend)).digest('hex');
  const home = path.join(dir, 'home'); await fsp.mkdir(home);
  await fsp.writeFile(path.join(home, '.bashrc'), 'export SB_RC_MARKER=sourced\nexport PATH="$PATH:/rc-added"\n');
  const argv = model.backendCommand(backend, [], 5, 4096, sha, ['PATH=/usr/bin', 'HOME=' + home]);
  assert.ok(argv.includes('--norc') && argv.includes('--noprofile'));
  // node's spawnSync gives the child socketpair stdio — the case where bash would read ~/.bashrc
  const r = spawnSync(argv[0], argv.slice(1), {encoding: 'utf8', env: {}});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '/usr/bin|none');
  await fsp.rm(dir, {recursive: true, force: true});
});

test('alert armed-state never grows beyond the current entry set', () => {
  let state = {};
  for (let i = 0; i < 500; i++) {
    const entry = {id: 'openai@cpx-' + i, display_name: 'x' + i, short_name: 'gpt', status: 'ready', error: '',
      sections: [metric('Codex weekly', 80)]};
    state = model.alertDecisions([entry], state, {enabled: true}).armedState;
    assert.ok(Object.keys(state).length <= 2, 'state keys: ' + Object.keys(state).length);
  }
  const stable = {id: 'kimi', display_name: 'Kimi', short_name: 'kmi', status: 'ready', error: '',
    sections: [metric('Weekly quota', 80)]};
  const first = model.alertDecisions([stable], {}, {enabled: true});
  assert.equal(first.notifications.length, 1);
  const second = model.alertDecisions([stable], first.armedState, {enabled: true});
  assert.equal(second.notifications.length, 0);
  const huge = {};
  const sep = String.fromCharCode(31);
  for (let i = 0; i < 5000; i++) huge['kimi' + sep + 'window' + i + sep + 'Warn'] = false;
  const capped = model.alertDecisions([stable], huge, {enabled: true}).armedState;
  assert.ok(Object.keys(capped).length <= 1024);
});
