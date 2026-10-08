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
const example = JSON.parse(fs.readFileSync(path.join(skill, 'example.consult.json'), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-html-generic-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function run(data) {
  const inFile = path.join(tmp, `in${n}.json`);
  const outFile = path.join(tmp, `out${n++}.html`);
  fs.writeFileSync(inFile, JSON.stringify(data));
  const r = spawnSync('node', [RENDER, '--in', inFile, '--out', outFile], { encoding: 'utf8' });
  return { ...r, outFile };
}
const clone = () => JSON.parse(JSON.stringify(example));
const html = (d) => { const r = run(d); assert.equal(r.status, 0, r.stderr); return fs.readFileSync(r.outFile, 'utf8'); };
const doc = (blocks, extra = {}) => ({ ...clone(), sections: [{ heading: '節', blocks }], ...extra });
const addrs = (h) => [...h.matchAll(/data-addr="([^"]+)"/g)].map((m) => m[1]);

test('consult example renders with every block type and the consult verdicts', () => {
  const h = html(example);
  for (const s of ['<html lang="ja">', '<table', '<ul class="plain"', 'class="card"', 'type="radio" name="d-Q1"', '<pre ', 'tone-warn', 'tone-info',
    'この内容で進めてよい', '直してほしい', '質問・指摘を送る', 'value="proceed"', '推奨', '未確認', '本文の一部を選択するとコメントを付けられます。入力はこのブラウザに自動保存されます。']) {
    assert.ok(h.includes(s), s);
  }
  assert.ok(!h.includes('value="approve"'));
  assert.ok(!/class="cbtn"|コメントを追加<\/button><\/div>/.test(h), 'no per-block comment buttons');
  assert.ok(!/<script[^>]+src=/i.test(h) && !/<link[^>]+href=/i.test(h));
  const scripts = [...h.matchAll(/<script>\n([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 2);
  for (const s of scripts) new vm.Script(s);
});

test('docId appears literally in the embedded JSON', () => {
  assert.ok(html(example).includes('"docId":"example-consult-cache"'));
});

test('block structure: list sub items, ordered list, table, card tag, decision radios', () => {
  const h = html(doc([
    { type: 'list', ordered: true, items: ['a', { text: 'b', sub: ['b1', 'b2'] }] },
    { type: 'table', columns: ['X', 'Y'], rows: [['1', '2']] },
    { type: 'card', title: 'T', tag: 'TG', blocks: [{ type: 'p', text: 'inner' }] },
    { type: 'decision', ref: 'Q9', text: 'q?', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', note: 'nb' }], recommended: 'b' }
  ]));
  assert.ok(h.includes('<ol class="plain">'));
  assert.equal((h.match(/<li><span data-addr="b\d+"/g) || []).length, 4);
  assert.ok(h.includes('<th data-addr') && h.includes('<td data-addr'));
  assert.ok(h.includes('<span class="tag">TG</span>'));
  assert.ok(/name="d-Q9" value="b" checked/.test(h) && !/name="d-Q9" value="a" checked/.test(h), 'recommended pre-checked');
  assert.equal((h.match(/class="rec"/g) || []).length, 1);
  assert.ok(h.includes('data-chip="Q9"'));
});

test('addresses: auto b1..bN sequential and unique; refs are used as addresses', () => {
  const h = html(doc([
    { type: 'p', text: 'one' },
    { type: 'p', ref: 'Intro', text: 'two' },
    { type: 'list', items: ['x', { text: 'y', ref: 'Y1' }] },
    { type: 'code', text: 'c' },
    { type: 'note', tone: 'info', text: 'n', ref: 'N-1' }
  ], {}));
  const a = addrs(h);
  assert.equal(new Set(a).size, a.length, 'unique');
  for (const r of ['Intro', 'Y1', 'N-1']) assert.ok(a.includes(r), r);
  const auto = a.filter((x) => /^b\d+$/.test(x));
  assert.deepEqual(auto, auto.map((_, i) => `b${i + 1}`), 'sequential');
  assert.ok(auto.length >= 4);
  assert.ok(/data-addr="Y1" data-label="節 Y1"/.test(h), 'label = heading + ref');
});

test('section ref becomes the heading address', () => {
  const d = clone(); d.sections[1].ref = 'findings';
  assert.ok(html(d).includes('<h2 data-addr="findings" data-label="調べたこと findings">'));
});

const bad = [
  ['wrong kind', (d) => { d.kind = 'review-html/x'; }, '$.kind'],
  ['wrong version', (d) => { d.version = 2; }, '$.version'],
  ['profile not consult', (d) => { d.profile = 'requirements'; }, '$.profile'],
  ['missing profile', (d) => { delete d.profile; }, '$.profile'],
  ['bad docId', (d) => { d.docId = 'A'; }, '$.docId'],
  ['bad createdAt', (d) => { d.createdAt = 'x'; }, '$.createdAt'],
  ['missing title', (d) => { delete d.title; }, '$.title'],
  ['no sections', (d) => { d.sections = []; }, '$.sections'],
  ['section without heading', (d) => { delete d.sections[0].heading; }, '$.sections[0].heading'],
  ['unknown block type', (d) => { d.sections[0].blocks[0].type = 'video'; }, 'unknown block type'],
  ['p without text', (d) => { delete d.sections[0].blocks[0].text; }, '$.sections[0].blocks[0].text'],
  ['bad ref format', (d) => { d.sections[0].blocks[0].ref = '1abc'; }, '$.sections[0].blocks[0].ref'],
  ['duplicate ref', (d) => { d.sections[0].blocks[0].ref = 'Q1'; }, 'duplicate ref "Q1"'],
  ['duplicate ref (list item vs section)', (d) => { d.sections[1].ref = 'dup'; }, 'duplicate ref "dup"'],
  ['note bad tone', (d) => { d.sections[0].blocks[1].tone = 'red'; }, 'tone'],
  ['table row length', (d) => { d.sections[1].blocks[1].rows[0].pop(); }, 'rows[0]'],
  ['table without columns', (d) => { d.sections[1].blocks[1].columns = []; }, 'columns'],
  ['empty list', (d) => { d.sections[1].blocks[0].items = []; }, 'items'],
  ['card with nested decision', (d) => { d.sections[2].blocks[0].blocks.push({ type: 'decision', ref: 'Q2', text: 'q', options: [{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }], recommended: 'a' }); }, 'not allowed inside a card'],
  ['card with nested card', (d) => { d.sections[2].blocks[0].blocks.push({ type: 'card', title: 't', blocks: [{ type: 'p', text: 'x' }] }); }, 'not allowed inside a card'],
  ['card without title', (d) => { delete d.sections[2].blocks[0].title; }, 'title'],
  ['decision without ref', (d) => { delete d.sections[3].blocks[0].ref; }, '$.sections[3].blocks[0].ref'],
  ['decision 1 option', (d) => { d.sections[3].blocks[0].options.pop(); d.sections[3].blocks[0].recommended = 'cache'; }, 'options'],
  ['decision 6 options', (d) => { d.sections[3].blocks[0].options = 'abcdef'.split('').map((v) => ({ value: v, label: v })); d.sections[3].blocks[0].recommended = 'a'; }, 'options'],
  ['decision bad value', (d) => { d.sections[3].blocks[0].options[0].value = 'A B'; }, 'options[0].value'],
  ['decision duplicate value', (d) => { d.sections[3].blocks[0].options[1].value = 'cache'; }, 'duplicate option value'],
  ['decision recommended not in values', (d) => { d.sections[3].blocks[0].recommended = 'zz'; }, 'recommended'],
  ['code without text', (d) => { delete d.sections[2].blocks[1].blocks[1].text; }, 'text'],
  ['string over 4000 chars', (d) => { d.sections[0].blocks[0].text = 'あ'.repeat(4001); }, 'longer than 4000'],
  ['more than 60 sections', (d) => { d.sections = Array.from({ length: 61 }, (_, i) => ({ heading: `h${i}`, blocks: [{ type: 'p', text: 'x' }] })); }, 'more than 60 sections'],
  ['more than 600 blocks', (d) => { d.sections = Array.from({ length: 7 }, (_, i) => ({ heading: `h${i}`, blocks: Array.from({ length: 100 }, () => ({ type: 'p', text: 'x' })) })); }, 'more than 600 blocks'],
];
for (const [name, mutate, needle] of bad) {
  test(`validation: ${name}`, () => {
    const d = clone(); mutate(d);
    const r = run(d);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(r.stderr.includes(needle), `stderr should contain ${needle}: ${r.stderr}`);
    assert.ok(!fs.existsSync(r.outFile));
  });
}

test('exactly 600 blocks and 60 sections are accepted', () => {
  const d = clone();
  d.sections = Array.from({ length: 60 }, (_, i) => ({ heading: `h${i}`, blocks: Array.from({ length: 10 }, () => ({ type: 'p', text: 'x' })) }));
  assert.equal(run(d).status, 0);
});

test('unknown fields warn but do not fail', () => {
  const d = clone(); d.extra = 1; d.sections[0].blocks[0].foo = 2;
  const r = run(d);
  assert.equal(r.status, 0);
  assert.ok(r.stderr.includes('$.extra') && r.stderr.includes('blocks[0].foo'));
});

const EVIL = '</script><script>alert(1)</script><img src=x onerror=alert(2)>';
test('escaping: hostile strings in every block type never reach the page as markup', () => {
  const d = {
    kind: 'review-html/doc', version: 1, profile: 'consult', docId: 'evil-doc', title: EVIL, project: EVIL, createdAt: '2026-10-08', purpose: EVIL,
    sections: [{
      heading: EVIL, ref: 'sec',
      blocks: [
        { type: 'p', text: EVIL },
        { type: 'list', items: [EVIL, { text: EVIL, sub: [EVIL] }] },
        { type: 'table', columns: [EVIL], rows: [[EVIL]] },
        { type: 'card', title: EVIL, tag: EVIL, blocks: [{ type: 'p', text: EVIL }, { type: 'note', tone: 'warn', text: EVIL }] },
        { type: 'decision', ref: 'Q1', text: EVIL, options: [{ value: 'a', label: EVIL, note: EVIL }, { value: 'b', label: EVIL }], recommended: 'a' },
        { type: 'code', title: EVIL, lang: EVIL, text: EVIL },
        { type: 'note', tone: 'info', text: EVIL }
      ]
    }]
  };
  const h = html(d);
  assert.ok(!h.includes('<img src=x'), 'no raw img');
  assert.ok(!h.includes('<script>alert'), 'no raw script');
  assert.equal((h.match(/<\/script/gi) || []).length, 3);
  const m = h.match(/<script type="application\/json" id="review-data">([\s\S]*?)<\/script>/);
  assert.ok(!m[1].includes('<'));
  assert.equal(JSON.parse(m[1]).sections[0].blocks[0].text, EVIL);
  const body = h.slice(h.indexOf('<main'), h.indexOf('<script type="application/json"'));
  assert.ok(!/<img|<script/i.test(body) && !/data-label="[^"]*</.test(body));
});

test('embedded JSON escapes U+2028 / U+2029 and round-trips', () => {
  const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
  const text = `a${LS}b${PS}c`;
  const h = html(doc([{ type: 'p', text }]));
  const m = h.match(/<script type="application\/json" id="review-data">([\s\S]*?)<\/script>/);
  assert.ok(!m[1].includes(LS) && !m[1].includes(PS), 'no raw separators in the embedded JSON');
  assert.ok(m[1].includes('\\u2028') && m[1].includes('\\u2029'));
  assert.equal(JSON.parse(m[1]).sections[0].blocks[0].text, text);
});

test('content hash: stable for same input, different for different input, matches embedded JSON', async () => {
  const crypto = await import('node:crypto');
  const h1 = html(example), h2 = html(clone());
  const hash = (h) => h.match(/<meta name="review-content-hash" content="([0-9a-f]{64})">/)[1];
  assert.equal(hash(h1), hash(h2));
  const d = clone(); d.sections[0].blocks[0].text += '!';
  assert.notEqual(hash(h1), hash(html(d)));
  const json = h1.match(/<script type="application\/json" id="review-data">([\s\S]*?)<\/script>/)[1];
  assert.equal(hash(h1), crypto.createHash('sha256').update(json).digest('hex'));
});

test('requirements input renders through the same base: ids as addresses, requirements verdicts', () => {
  const req = JSON.parse(fs.readFileSync(path.join(skill, 'example.requirements.json'), 'utf8'));
  const h = html(req);
  assert.ok(h.includes('"profile":"requirements"') && h.includes('"docId":"example-room-precreate"'));
  for (const v of ['approve', 'revise', 'rescope', 'abort']) assert.ok(h.includes(`value="${v}"`), v);
  assert.ok(!h.includes('value="proceed"'));
  const a = addrs(h);
  for (const id of ['S1', 'S1-AC1', 'N1', 'IN1', 'OUT1', 'FU1', 'R1', 'Q1']) assert.ok(a.includes(id), id);
  assert.equal(new Set(a).size, a.length);
  assert.ok(h.includes('前提: ') && h.includes('操作: ') && h.includes('結果: '));
  assert.ok(h.includes('<table') && h.includes('設計が必要'));
});
