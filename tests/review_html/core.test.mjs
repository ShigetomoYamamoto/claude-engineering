import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const skill = path.join(here, '../../skills/review-html');
const core = createRequire(import.meta.url)('../../skills/review-html/assets/core.js');
const consult = JSON.parse(fs.readFileSync(path.join(skill, 'example.consult.json'), 'utf8'));
// A requirements document in the generic model (what render.mjs embeds): Q1 decision, profile requirements.
const reqDoc = { ...JSON.parse(JSON.stringify(consult)), profile: 'requirements', docId: 'req-doc-1' };

test('verdict sets are fixed by profile', () => {
  assert.deepEqual(core.verdictValues('consult'), ['proceed', 'revise', 'question']);
  assert.deepEqual(core.verdictValues('requirements'), ['approve', 'revise', 'rescope', 'abort']);
  assert.throws(() => core.verdictValues('nope'));
});

test('buildPayload: header fields, consult profile', () => {
  const st = core.initialState(consult);
  st.verdict = 'proceed'; st.note = 'メモ';
  const p = core.buildPayload(consult, st, new Date('2026-10-08T00:00:00Z'));
  assert.equal(p.kind, 'review-html/answer');
  assert.equal(p.version, 2);
  assert.equal(p.profile, 'consult');
  assert.equal(p.docId, consult.docId);
  assert.equal(p.note, 'メモ');
  assert.equal(p.sentAt, '2026-10-08T00:00:00.000Z');
  assert.deepEqual(p.comments, []);
});

test('buildPayload: verdict set enforced per profile', () => {
  const st = core.initialState(consult);
  assert.throws(() => core.buildPayload(consult, st), /verdict/);
  st.verdict = 'approve'; // requirements-only verdict
  assert.throws(() => core.buildPayload(consult, st), /verdict/);
  st.verdict = 'question';
  assert.equal(core.buildPayload(consult, st).verdict, 'question');
  const st2 = core.initialState(reqDoc);
  st2.verdict = 'proceed'; // consult-only verdict
  assert.throws(() => core.buildPayload(reqDoc, st2), /verdict/);
  for (const v of ['approve', 'revise', 'rescope', 'abort']) { st2.verdict = v; assert.equal(core.buildPayload(reqDoc, st2).verdict, v); }
  assert.equal(core.buildPayload(reqDoc, { ...st2, verdict: 'abort' }).profile, 'requirements');
});

test('buildPayload: untouched recommended -> touched false, changed false', () => {
  const st = core.initialState(consult);
  st.verdict = 'proceed';
  assert.deepEqual(core.buildPayload(consult, st).decisions.Q1, { value: 'cache', label: '案 A（一時保存）', recommended: 'cache', touched: false, changed: false });
});

test('buildPayload: touched and changed flags', () => {
  const st = core.initialState(consult);
  st.verdict = 'revise';
  st.decisions.Q1 = { value: 'batch', touched: true };
  const p = core.buildPayload(consult, st);
  assert.equal(p.decisions.Q1.touched, true);
  assert.equal(p.decisions.Q1.changed, true);
  assert.equal(p.decisions.Q1.label, '案 B（まとめて読む）');
  st.decisions.Q1 = { value: 'cache', touched: true };
  const p2 = core.buildPayload(consult, st);
  assert.equal(p2.decisions.Q1.touched, true);
  assert.equal(p2.decisions.Q1.changed, false);
});

test('buildPayload: comments carry addr/label/quote/prefix/suffix/text; unusable ones dropped; context clamped', () => {
  const st = core.initialState(consult);
  st.verdict = 'proceed';
  st.comments = [
    { id: 'c1', addr: 'b3', label: '結論', quote: '一時保存', prefix: 'あ'.repeat(30), suffix: 'い'.repeat(30), text: 'ここを詳しく', extra: 'x' },
    { id: 'c2', addr: 'b4', label: 'x', quote: 'q', prefix: '', suffix: '', text: '   ' },
    { id: 'c3', addr: 'b5', label: 'x', quote: '', text: 'no quote' },
    null
  ];
  const p = core.buildPayload(consult, st);
  assert.equal(p.comments.length, 1);
  assert.deepEqual(p.comments[0], { addr: 'b3', label: '結論', quote: '一時保存', prefix: 'あ'.repeat(20), suffix: 'い'.repeat(20), text: 'ここを詳しく' });
});

test('restoreState drops unknown/invalid saved values', () => {
  const st = core.restoreState(consult, {
    decisions: { Q1: { value: 'zzz', touched: true }, Q9: { value: 'a', touched: true } },
    comments: [{ addr: 'b1', quote: 'q', text: 'ok' }, { addr: 'b1', quote: 'q', text: '' }, 5],
    verdict: 'hack', note: 5
  });
  assert.deepEqual(st.decisions.Q1, { value: 'cache', touched: false, text: '' }); // text field added by the 'other' option
  assert.equal(st.comments.length, 1);
  assert.equal(st.comments[0].text, 'ok');
  assert.equal(st.verdict, null);
  assert.equal(st.note, '');
  const ok = core.restoreState(consult, { decisions: { Q1: { value: 'batch', touched: true } }, verdict: 'revise', note: 'n' });
  assert.deepEqual(ok.decisions.Q1, { value: 'batch', touched: true, text: '' });
  assert.equal(ok.verdict, 'revise');
  assert.equal(core.restoreState(consult, { verdict: 'approve' }).verdict, null, 'verdict from the other profile is dropped');
  assert.deepEqual(core.restoreState(consult, null), core.initialState(consult));
});

test('findAnchor: unique quote', () => {
  assert.deepEqual(core.findAnchor('結果を一時保存する方法', { quote: '一時保存', prefix: '', suffix: '' }), { start: 3, end: 7 });
});

test('findAnchor: quote not present -> null', () => {
  assert.equal(core.findAnchor('abc', { quote: 'zzz', prefix: 'a', suffix: 'c' }), null);
  assert.equal(core.findAnchor('abc', { quote: '', prefix: '', suffix: '' }), null);
});

test('findAnchor: duplicate quote resolved by prefix+suffix context', () => {
  const full = 'AAA foo BBB. CCC foo DDD. EEE foo FFF.';
  const at = (k) => { let i = -1; for (let n = 0; n <= k; n++) i = full.indexOf('foo', i + 1); return i; };
  for (const [k, prefix, suffix] of [[0, 'AAA ', ' BBB.'], [1, 'CCC ', ' DDD.'], [2, 'EEE ', ' FFF.']]) {
    assert.deepEqual(core.findAnchor(full, { quote: 'foo', prefix, suffix }), { start: at(k), end: at(k) + 3 }, `occurrence ${k}`);
  }
});

test('findAnchor: when text moved a little, best context wins; exact context is preferred', () => {
  const full = 'x foo y. a foo b.';
  // prefix/suffix of the second occurrence, but the neighbours changed slightly -> partial context still picks it
  assert.deepEqual(core.findAnchor(full, { quote: 'foo', prefix: 'z a ', suffix: ' b!' }), { start: full.lastIndexOf('foo'), end: full.lastIndexOf('foo') + 3 });
  // no usable context -> first occurrence
  assert.deepEqual(core.findAnchor(full, { quote: 'foo', prefix: 'QQ', suffix: 'RR' }), { start: 2, end: 5 });
});

test('contextAround returns up to 20 chars each side from the same text', () => {
  const full = 'a'.repeat(30) + 'QUOTE' + 'b'.repeat(30);
  const c = core.contextAround(full, 30, 35);
  assert.equal(c.prefix, 'a'.repeat(20));
  assert.equal(c.suffix, 'b'.repeat(20));
  assert.deepEqual(core.contextAround('hi QUOTE', 3, 8), { prefix: 'hi ', suffix: '' });
  const a = core.findAnchor(full, { quote: 'QUOTE', ...c });
  assert.deepEqual(a, { start: 30, end: 35 });
});

// ---- decisions ----
test('applyDecisionClick: re-clicking the checked recommended option -> touched, not changed', () => {
  const q = core.collectDecisions(consult)[0];
  const st0 = core.initialState(consult);
  const st = core.applyDecisionClick(st0, q.ref, q.recommended, true);
  assert.equal(st.decisions[q.ref].touched, true);
  assert.equal(st.decisions[q.ref].value, q.recommended);
  assert.equal(st0.decisions[q.ref].touched, false); // input not mutated
  st.verdict = 'proceed';
  assert.equal(core.buildPayload(consult, st).decisions[q.ref].changed, false);
});

test('applyDecisionClick: choosing another option -> touched and changed, state equals checked value', () => {
  const q = core.collectDecisions(consult)[0];
  const other = q.options.find((o) => o.value !== q.recommended).value;
  const st = core.applyDecisionClick(core.initialState(consult), q.ref, other, false);
  assert.deepEqual(st.decisions[q.ref], { value: other, touched: true, text: '' });
  st.verdict = 'proceed';
  const p = core.buildPayload(consult, st).decisions[q.ref];
  assert.equal(p.changed, true);
  assert.equal(p.value, other);
});

// ---- selection ----
test('classifySelection: same block single, clamped end single, different blocks multi', () => {
  assert.equal(core.classifySelection('b1', 'b1', 12), 'single');
  assert.equal(core.classifySelection('b1', null, 0), 'single');   // triple-click ending in .rec / .optnote
  assert.equal(core.classifySelection('b1', 'b2', 0), 'single');   // ends at the very start of the next block
  assert.equal(core.classifySelection('b1', 'b2', 5), 'multi');
  assert.equal(core.classifySelection('b1', null, 3), 'multi');
  assert.equal(core.classifySelection(null, 'b1', 3), 'multi');
});

test('trimSelection', () => {
  assert.deepEqual(core.trimSelection('  ab c  ', 0, 8), { start: 2, end: 6 });
  assert.equal(core.trimSelection('   ', 0, 3), null);
});

// ---- comment record / anchoring ----
test('buildCommentRecord: quote with prefix/suffix; duplicate quote in one block resolved by context', () => {
  const blockText = '対象はAです。次に対象はBです。';
  const second = blockText.lastIndexOf('対象');
  const rec = core.buildCommentRecord({ addr: 'b3', label: '見出し', blockText, start: second, end: second + 2 });
  assert.equal(rec.quote, '対象');
  assert.equal(rec.addr, 'b3');
  assert.equal(rec.prefix, blockText.slice(Math.max(0, second - core.CTX), second));
  assert.equal(rec.suffix, 'はBです。');
  const an = core.findAnchor(blockText, rec);
  assert.deepEqual(an, { start: second, end: second + 2 });
  // text changed slightly: still resolves to the second occurrence by suffix similarity
  const changed = '対象はAです。さらに次に対象はBです。';
  assert.equal(core.findAnchor(changed, rec).start, changed.lastIndexOf('対象'));
});

test('buildCommentRecord: trims whitespace, rejects empty', () => {
  const r = core.buildCommentRecord({ addr: 'x', label: '', blockText: 'ab  cd ', start: 2, end: 7 });
  assert.equal(r.quote, 'cd');
  assert.equal(core.buildCommentRecord({ addr: 'x', label: '', blockText: '   ', start: 0, end: 3 }), null);
});

// ---- payload size / sent ----
test('checkPayloadSize counts UTF-8 bytes', () => {
  assert.equal(core.MAX_PAYLOAD_BYTES, 250000);
  assert.equal(core.checkPayloadSize('a'.repeat(250000)).ok, true);
  assert.equal(core.checkPayloadSize('a'.repeat(250001)).ok, false);
  const jp = 'あ'.repeat(83334); // 3 bytes each = 250002 bytes but only 83334 chars
  const r = core.checkPayloadSize(jp);
  assert.equal(r.bytes, 250002);
  assert.equal(r.ok, false);
});

test('restoreState keeps sent only when saved.sent === true', () => {
  assert.equal(core.initialState(consult).sent, false);
  assert.equal(core.restoreState(consult, { sent: true }).sent, true);
  assert.equal(core.restoreState(consult, { sent: 'yes' }).sent, false);
});

// ---- reserved "other" option ----
test('buildPayload: other + text -> value other, label, changed, trimmed text; other options carry no text', () => {
  const q = core.collectDecisions(consult)[0];
  let st = core.applyDecisionClick(core.initialState(consult), q.ref, 'other', false);
  st = core.applyDecisionText(st, q.ref, '  別の案です \n');
  st.verdict = 'proceed';
  const d = core.buildPayload(consult, st).decisions[q.ref];
  assert.deepEqual(d, { value: 'other', label: 'その他（自由記述）', recommended: q.recommended, touched: true, changed: true, text: '別の案です' });
  const empty = core.applyDecisionClick(core.initialState(consult), q.ref, 'other', false);
  empty.verdict = 'proceed';
  assert.equal(core.buildPayload(consult, empty).decisions[q.ref].text, '');
  assert.equal(core.buildPayload(consult, empty).decisions[q.ref].value, 'other');
  const back = core.applyDecisionClick(st, q.ref, q.recommended, false);
  assert.ok(!('text' in core.buildPayload(consult, back).decisions[q.ref]), 'text only when other is selected');
  assert.equal(back.decisions[q.ref].text, '  別の案です \n', 'text kept in state while another option is selected');
});

test('applyDecisionClick to/from other keeps text; applyDecisionText caps length and does not mutate', () => {
  const q = core.collectDecisions(consult)[0];
  const s0 = core.initialState(consult);
  const s1 = core.applyDecisionText(s0, q.ref, 'x'.repeat(2500));
  assert.equal(s1.decisions[q.ref].text.length, 2000);
  assert.equal(s1.decisions[q.ref].value, 'other');
  assert.equal(s0.decisions[q.ref].text, '');
  const s2 = core.applyDecisionClick(s1, q.ref, 'batch', false);
  assert.equal(s2.decisions[q.ref].text.length, 2000);
  assert.equal(core.applyDecisionClick(s2, q.ref, 'other', false).decisions[q.ref].value, 'other');
});

test('restoreState: other is accepted and keeps text; text dropped for any other value', () => {
  const q = core.collectDecisions(consult)[0];
  const a = core.restoreState(consult, { decisions: { [q.ref]: { value: 'other', touched: true, text: '自由記述' } } });
  assert.deepEqual(a.decisions[q.ref], { value: 'other', touched: true, text: '自由記述' });
  const b = core.restoreState(consult, { decisions: { [q.ref]: { value: 'batch', touched: true, text: '消える' } } });
  assert.equal(b.decisions[q.ref].text, '');
  const c = core.restoreState(consult, { decisions: { [q.ref]: { value: 'other', touched: true, text: 5 } } });
  assert.equal(c.decisions[q.ref].text, '');
});

test('every verdict carries a Japanese explanation', () => {
  for (const p of Object.values(core.PROFILES)) for (const v of p.verdicts) assert.ok(typeof v.explain === 'string' && v.explain.length > 5);
});
