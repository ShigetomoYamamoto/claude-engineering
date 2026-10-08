import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = createRequire(import.meta.url)('../../skills/gate-html/assets/core.js');
const data = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/valid.json'), 'utf8'));

test('buildPayload: untouched recommended -> touched false, changed false', () => {
  const st = core.initialState(data);
  st.verdict = 'approve';
  const p = core.buildPayload(data, st);
  assert.deepEqual(p.decisions.Q1, { value: 'hidden', label: '見せない', recommended: 'hidden', touched: false, changed: false });
});

test('buildPayload: touched and changed flags', () => {
  const st = core.initialState(data);
  st.verdict = 'revise';
  st.decisions.Q1 = { value: 'visible', touched: true };
  const p = core.buildPayload(data, st);
  assert.equal(p.decisions.Q1.touched, true);
  assert.equal(p.decisions.Q1.changed, true);
  assert.equal(p.decisions.Q1.label, '見せる');
  st.decisions.Q1 = { value: 'hidden', touched: true };
  const p2 = core.buildPayload(data, st);
  assert.equal(p2.decisions.Q1.touched, true);
  assert.equal(p2.decisions.Q1.changed, false);
});

test('buildPayload: comments carry addr/label/text; empty and unknown dropped', () => {
  const st = core.initialState(data);
  st.verdict = 'approve';
  st.comments = { 'criterion:S1-AC1': '結果を変えたい', goal: '   ', 'bogus:X': 'x' };
  const p = core.buildPayload(data, st);
  assert.equal(p.comments.length, 1);
  assert.equal(p.comments[0].addr, 'criterion:S1-AC1');
  assert.ok(p.comments[0].label.includes('S1-AC1'));
  assert.equal(p.comments[0].text, '結果を変えたい');
});

test('buildPayload: verdict is required', () => {
  const st = core.initialState(data);
  assert.throws(() => core.buildPayload(data, st), /verdict/);
  st.verdict = 'nope';
  assert.throws(() => core.buildPayload(data, st), /verdict/);
});

test('buildPayload: header fields and note', () => {
  const st = core.initialState(data);
  st.verdict = 'abort'; st.note = 'メモ';
  const p = core.buildPayload(data, st, new Date('2026-10-08T00:00:00Z'));
  assert.equal(p.kind, 'gate-html/requirements');
  assert.equal(p.version, 1);
  assert.equal(p.docId, data.docId);
  assert.equal(p.note, 'メモ');
  assert.equal(p.sentAt, '2026-10-08T00:00:00.000Z');
});

test('restoreState drops unknown/invalid saved values', () => {
  const st = core.restoreState(data, {
    decisions: { Q1: { value: 'zzz', touched: true }, Q9: { value: 'a', touched: true } },
    comments: { goal: 'ok', 'bogus:1': 'x' }, verdict: 'hack', note: 5
  });
  assert.deepEqual(st.decisions.Q1, { value: 'hidden', touched: false });
  assert.deepEqual(st.comments, { goal: 'ok' });
  assert.equal(st.verdict, null);
  assert.equal(st.note, '');
  const ok = core.restoreState(data, { decisions: { Q1: { value: 'visible', touched: true } }, verdict: 'revise', note: 'n' });
  assert.deepEqual(ok.decisions.Q1, { value: 'visible', touched: true });
  assert.equal(ok.verdict, 'revise');
});
