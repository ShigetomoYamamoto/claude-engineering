import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const skill = path.join(here, '../../skills/review-html');
const RENDER = path.join(skill, 'render.mjs');
const valid = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/valid.json'), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-html-render-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function run(data, { out, force = false, raw } = {}) {
  const inFile = path.join(tmp, `in${n++}.json`);
  fs.writeFileSync(inFile, raw ?? JSON.stringify(data));
  const outFile = out ?? path.join(tmp, `out${n}.html`);
  const args = [RENDER, '--in', inFile, '--out', outFile];
  if (force) args.push('--force');
  const r = spawnSync('node', args, { encoding: 'utf8' });
  return { ...r, outFile };
}
const consult = JSON.parse(fs.readFileSync(path.join(skill, 'example.consult.json'), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(valid));

test('example input renders with all ids and Japanese headings', () => {
  const r = run(valid);
  assert.equal(r.status, 0, r.stderr);
  const html = fs.readFileSync(r.outFile, 'utf8');
  for (const id of ['S1', 'S1-AC1', 'N1', 'IN1', 'OUT1', 'FU1', 'R1', 'Q1']) assert.ok(html.includes(`data-addr="${id}"`), id);
  for (const s of ['<html lang="ja">', '機能要件', '未決事項', '回答する', 'この内容でよい', '直してほしい', '範囲を変える', '中止する', '推奨', '未確認', 'コメント一覧（0）', '本文を選択するとコメントを付けられます']) {
    assert.ok(html.includes(s), s);
  }
  assert.ok(!/<script[^>]+src=/i.test(html) && !/<link[^>]+href=/i.test(html), 'no external requests');
});

test('inline page script is syntactically valid', () => {
  const html = fs.readFileSync(run(valid).outFile, 'utf8');
  const scripts = [...html.matchAll(/<script>\n([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 2);
  for (const s of scripts) new vm.Script(s);
});

test('HTML-significant input is escaped and embedded JSON has no raw </script', () => {
  const d = clone();
  d.goal = '<script>alert(1)</script> & "q" \'s\' </script>';
  d.stories[0].action = '<img src=x onerror=alert(1)>';
  const r = run(d);
  assert.equal(r.status, 0, r.stderr);
  const html = fs.readFileSync(r.outFile, 'utf8');
  assert.ok(!html.includes('<script>alert(1)'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot; &#39;s&#39;'));
  const m = html.match(/<script type="application\/json" id="review-data">([\s\S]*?)<\/script>/);
  assert.ok(m, 'review-data present');
  assert.ok(!/<\/script/i.test(m[1]) && !m[1].includes('<'));
  assert.equal(JSON.parse(m[1]).sections[0].blocks[0].text, d.goal);
  assert.equal((html.match(/<\/script/gi) || []).length, 3);
});

const bad = [
  ['wrong kind', (d) => { d.kind = 'x'; }, '$.kind'],
  ['wrong version', (d) => { d.version = 2; }, '$.version'],
  ['missing title', (d) => { delete d.title; }, '$.title'],
  ['missing goal', (d) => { delete d.goal; }, '$.goal'],
  ['bad docId', (d) => { d.docId = 'AB'; }, '$.docId'],
  ['bad createdAt', (d) => { d.createdAt = '2026/10/08'; }, '$.createdAt'],
  ['empty stories', (d) => { d.stories = []; }, '$.stories'],
  ['bad story id', (d) => { d.stories[0].id = 'X1'; }, '$.stories[0].id'],
  ['bad criterion id', (d) => { d.stories[0].criteria[0].id = 'AC1'; }, 'criteria[0].id'],
  ['bad nfr id', (d) => { d.nfr[0].id = 'Z1'; }, '$.nfr[0].id'],
  ['bad scope id', (d) => { d.scope.in[0].id = 'OUT1'; }, '$.scope.in[0].id'],
  ['bad risk id', (d) => { d.risks[0].id = 'r1'; }, '$.risks[0].id'],
  ['bad question id', (d) => { d.questions[0].id = 'Q'; }, '$.questions[0].id'],
  ['duplicate ids across document', (d) => { d.risks.push({ id: 'R1', text: 'dup' }); }, 'duplicate id "R1"'],
  ['recommended not in options', (d) => { d.questions[0].recommended = 'zzz'; }, '$.questions[0].recommended'],
  ['too few options', (d) => { d.questions[0].options.pop(); }, '$.questions[0].options'],
  ['too many options', (d) => { d.questions[0].options = ['a', 'b', 'c', 'd', 'e', 'f'].map((v) => ({ value: v, label: v })); d.questions[0].recommended = 'a'; }, '$.questions[0].options'],
  ['duplicate option value', (d) => { d.questions[0].options[1].value = 'hidden'; }, 'duplicate option value'],
  ['designNeeded.value not boolean', (d) => { d.designNeeded.value = 'yes'; }, '$.designNeeded.value'],
  ['string over 2000 chars', (d) => { d.goal = 'あ'.repeat(2001); }, '$.goal'],
];
for (const [name, mutate, needle] of bad) {
  test(`validation: ${name}`, () => {
    const d = clone(); mutate(d);
    const r = run(d);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(r.stderr.includes(needle), `stderr should contain ${needle}: ${r.stderr}`);
    assert.ok(!fs.existsSync(r.outFile), 'no output on validation failure');
  });
}

test('validation: unparseable JSON exits 1', () => {
  assert.equal(run(null, { raw: '{nope' }).status, 1);
});

test('unknown extra fields warn but do not fail', () => {
  const d = clone(); d.extra = 1;
  const r = run(d);
  assert.equal(r.status, 0);
  assert.ok(r.stderr.includes('$.extra'));
});

test('refuses to overwrite without --force', () => {
  const out = path.join(tmp, 'overwrite.html');
  assert.equal(run(valid, { out }).status, 0);
  const again = run(valid, { out });
  assert.notEqual(again.status, 0);
  assert.ok(again.stderr.includes('--force'));
  assert.equal(run(valid, { out, force: true }).status, 0);
});

test('output filename rule enforced', () => {
  for (const name of ['bad name.html', 'x.txt', 'a$b.html', 'x.html.exe']) {
    const r = run(valid, { out: path.join(tmp, name) });
    assert.notEqual(r.status, 0, name);
    assert.ok(!fs.existsSync(path.join(tmp, name)));
  }
});

test('assets never use HTML-injecting APIs', () => {
  for (const f of ['page.js', 'core.js', 'page.css']) {
    const t = fs.readFileSync(path.join(skill, 'assets', f), 'utf8');
    for (const api of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) assert.ok(!t.includes(api), `${f} uses ${api}`);
  }
});

for (const [name, input] of [['requirements', () => valid], ['consult', () => consult]]) {
  test(`every id and data-* selector used by page.js exists in the rendered HTML (${name})`, () => {
    const js = fs.readFileSync(path.join(skill, 'assets/page.js'), 'utf8');
    const html = fs.readFileSync(run(input()).outFile, 'utf8');
    const ids = new Set([...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]));
    for (const m of js.matchAll(/\$\('([^']+)'\)/g)) ids.add(m[1]);
    assert.ok(ids.size > 15);
    for (const id of ids) assert.ok(html.includes(`id="${id}"`), `missing id ${id}`);
    const attrs = new Set([...js.matchAll(/\[(data-[a-z-]+)[=\]]/g)].map((m) => m[1]));
    attrs.delete('data-cid'); // created at runtime on comment marks and panel cards
    assert.ok(attrs.has('data-addr') && attrs.has('data-chip'));
    for (const a of attrs) assert.ok(html.includes(`${a}="`), `missing attribute ${a}`);
    assert.ok(js.includes('data-label') && html.includes('data-label="'));
  });
}

test('contentHash: stable for same input, different for different input', () => {
  const hashOf = (d) => fs.readFileSync(run(d).outFile, 'utf8').match(/<meta name="review-content-hash" content="([0-9a-f]{64})">/)[1];
  const d2 = clone(); d2.goal = d2.goal + ' (revised)';
  assert.equal(hashOf(valid), hashOf(clone()));
  assert.notEqual(hashOf(valid), hashOf(d2));
});

test('creates a not-yet-existing nested output directory', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'review-html-nested-')), 'a', 'b');
  const out = path.join(dir, 'nested.html');
  try {
    const r = run(valid, { out });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(out));
  } finally {
    fs.rmSync(path.resolve(dir, '..', '..'), { recursive: true, force: true });
  }
});

test('user ref matching ^b\\d+$ is rejected (reserved for auto addresses)', () => {
  const d = JSON.parse(JSON.stringify(consult));
  const blk = d.sections[0].blocks.find((b) => b.type === 'p');
  blk.ref = 'b2';
  const r = run(d);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ref.*reserved|reserved.*b2/);
});

test('a large document yields unique data-addr values', () => {
  const d = JSON.parse(JSON.stringify(consult));
  const many = [];
  for (let i = 0; i < 150; i++) many.push({ type: 'p', text: `段落 ${i}` });
  many.push({ type: 'p', ref: 'keep1', text: 'x' });
  many.push({ type: 'table', columns: ['a', 'b'], rows: Array.from({ length: 40 }, (_, i) => [`r${i}`, `s${i}`]) });
  d.sections[0].blocks.push(...many);
  const r = run(d);
  assert.equal(r.status, 0, r.stderr);
  const html = fs.readFileSync(r.outFile, 'utf8');
  const addrs = [...html.matchAll(/data-addr="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(addrs.length > 200);
  assert.equal(new Set(addrs).size, addrs.length);
});
