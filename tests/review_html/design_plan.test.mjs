import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const skill = path.join(here, '../../skills/review-html');
const RENDER = path.join(skill, 'render.mjs');
const core = createRequire(import.meta.url)(path.join(skill, 'assets/core.js'));
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(skill, f), 'utf8'));
const design = readJson('example.design.json');
const plan = readJson('example.plan.json');
const consult = readJson('example.consult.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-html-dp-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function run(data) {
  const inFile = path.join(tmp, `in${n}.json`);
  const outFile = path.join(tmp, `out${n++}.html`);
  fs.writeFileSync(inFile, JSON.stringify(data));
  const r = spawnSync('node', [RENDER, '--in', inFile, '--out', outFile], { encoding: 'utf8' });
  return { ...r, outFile };
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const html = (d) => { const r = run(d); assert.equal(r.status, 0, r.stderr); return fs.readFileSync(r.outFile, 'utf8'); };
const addrs = (h) => [...h.matchAll(/data-addr="([^"]+)"/g)].map((m) => m[1]);
const embedded = (h) => JSON.parse(h.match(/<script type="application\/json" id="review-data">([\s\S]*?)<\/script>/)[1]);
const decodeEntities = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function expectBad(d, needle) {
  const r = run(d);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes(needle), `stderr should contain ${needle}: ${r.stderr}`);
  assert.ok(!fs.existsSync(r.outFile), 'no output on validation failure');
}

// ---------------- design ----------------
test('design: example renders; ids are addresses; Japanese sections and verdicts', () => {
  const h = html(design);
  const a = addrs(h);
  for (const id of ['C1', 'C2', 'M1', 'A1', 'I1', 'I2', 'D1', 'R1']) assert.ok(a.includes(id), id);
  for (const s of ['この画面で確認すること', 'もとにした要件', '構成', 'データ', 'API', '連携とエラー処理', '判断', 'リスク',
    'この設計でよい', '直してほしい', '要件から見直す', '中止する', 'S1・S1-AC1・N1 を満たすための設計です。', '推奨', 'その他（自由記述）']) {
    assert.ok(h.includes(s), s);
  }
  const vls = (x) => [...x.matchAll(/<span class="vl">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(vls(h), ['この設計でよい', '直してほしい', '要件から見直す', '中止する']);
  assert.ok(h.includes('設計（どう作るか）が正しいかを確認します。この設計で実装の計画に進んでよいかを判断してください。'));
  assert.equal(embedded(h).profile, 'design');
  assert.ok(h.includes('ALTER TABLE rooms'), 'schema code present');
  assert.ok(/<figure class="code" data-lang="sql">/.test(h));
  assert.ok(!/<script[^>]+src=/i.test(h) && !/<link[^>]+href=/i.test(h));
  for (const s of [...h.matchAll(/<script>\n([\s\S]*?)<\/script>/g)].map((m) => m[1])) new vm.Script(s);
});

test('design: option notes carry pros / cons; the recommended one ends with its reason', () => {
  const d = embedded(html(design));
  const q = d.sections.find((s) => s.heading === '判断').blocks[0];
  assert.equal(q.ref, 'D1');
  assert.equal(q.options[0].note, '良い点: 既存のジョブ基盤で作れる / 気になる点: 切り替えまで最大 1 分遅れる（推奨の理由: 一覧の表示速度を守れるため）');
  assert.equal(q.options[1].note, '良い点: 遅れがなく、ジョブが要らない / 気になる点: 一覧の問い合わせが重くなる');
});

test('design: missing pros or cons are omitted; no pros and cons gives only the reason', () => {
  const d = clone(design);
  delete d.decisions[0].options[0].cons;
  delete d.decisions[0].options[1].pros; delete d.decisions[0].options[1].cons;
  d.decisions[0].recommended = 'query';
  const q = embedded(html(d)).sections.find((s) => s.heading === '判断').blocks[0];
  assert.equal(q.options[0].note, '良い点: 既存のジョブ基盤で作れる');
  assert.equal(q.options[1].note, '（推奨の理由: 一覧の表示速度を守れるため）');
});

test('design: empty optional sections show なし and basis なし', () => {
  const d = clone(design);
  d.basis = []; d.dataModel = []; d.apis = []; d.integration = []; d.decisions = []; d.risks = [];
  const e = embedded(html(d));
  assert.equal(e.sections[0].blocks[0].text, 'なし');
  for (const s of e.sections.slice(2)) assert.deepEqual(s.blocks, [{ type: 'p', text: 'なし' }], s.heading);
});

const designBad = [
  ['wrong kind', (d) => { d.kind = 'review-html/x'; }, '$.kind'],
  ['wrong version', (d) => { d.version = 2; }, '$.version'],
  ['bad docId', (d) => { d.docId = 'AB'; }, '$.docId'],
  ['bad createdAt', (d) => { d.createdAt = '2026/10/08'; }, '$.createdAt'],
  ['missing title', (d) => { delete d.title; }, '$.title'],
  ['bad component id', (d) => { d.components[0].id = 'X1'; }, '$.components[0].id'],
  ['bad model id', (d) => { d.dataModel[0].id = 'C9'; }, '$.dataModel[0].id'],
  ['bad api id', (d) => { d.apis[0].id = 'a1'; }, '$.apis[0].id'],
  ['bad integration id', (d) => { d.integration[0].id = 'I'; }, '$.integration[0].id'],
  ['bad decision id', (d) => { d.decisions[0].id = 'Q1'; }, '$.decisions[0].id'],
  ['bad risk id', (d) => { d.risks[0].id = 'r1'; }, '$.risks[0].id'],
  ['duplicate id', (d) => { d.components[1].id = 'C1'; }, 'duplicate id "C1"'],
  ['bad basis item', (d) => { d.basis.push('IN1'); }, '$.basis[3]'],
  ['basis not an array', (d) => { d.basis = 'S1'; }, '$.basis'],
  ['empty components', (d) => { d.components = []; }, '$.components'],
  ['too few options', (d) => { d.decisions[0].options.pop(); }, '$.decisions[0].options'],
  ['too many options', (d) => { d.decisions[0].options = 'abcdef'.split('').map((v) => ({ value: v, label: v })); d.decisions[0].recommended = 'a'; }, '$.decisions[0].options'],
  ['bad option value', (d) => { d.decisions[0].options[0].value = 'A B'; }, '$.decisions[0].options[0].value'],
  ['option value other is reserved', (d) => { d.decisions[0].options[1].value = 'other'; }, 'reserved'],
  ['duplicate option value', (d) => { d.decisions[0].options[1].value = 'job'; }, 'duplicate option value'],
  ['recommended not in options', (d) => { d.decisions[0].recommended = 'zzz'; }, '$.decisions[0].recommended'],
  ['missing reason', (d) => { delete d.decisions[0].reason; }, '$.decisions[0].reason'],
  ['schema without text', (d) => { delete d.dataModel[0].schema.text; }, '$.dataModel[0].schema.text'],
  ['shape not an object', (d) => { d.apis[0].shape = 'x'; }, '$.apis[0].shape'],
  ['missing mitigation', (d) => { delete d.risks[0].mitigation; }, '$.risks[0].mitigation'],
  ['missing responsibility', (d) => { delete d.components[0].responsibility; }, '$.components[0].responsibility'],
  ['string over 4000 chars', (d) => { d.components[0].responsibility = 'あ'.repeat(4001); }, '$.components[0].responsibility'],
];
for (const [name, mutate, needle] of designBad) {
  test(`design validation: ${name}`, () => { const d = clone(design); mutate(d); expectBad(d, needle); });
}
test('design: a string of exactly 4000 chars is accepted', () => {
  const d = clone(design); d.components[0].responsibility = 'あ'.repeat(4000);
  assert.equal(run(d).status, 0);
});
test('design: unknown fields warn but do not fail', () => {
  const d = clone(design); d.extra = 1;
  const r = run(d);
  assert.equal(r.status, 0);
  assert.ok(r.stderr.includes('$.extra'));
});

const HOSTILE = '<img src=x onerror=alert(1)> & "q" \'s\' </script><script>alert(2)</script>';
function assertEscaped(h, label) {
  assert.ok(!/<img src=x/.test(h) && !h.includes('<script>alert'), `${label}: raw markup leaked`);
  assert.ok(h.includes('&lt;img src=x onerror=alert(1)&gt;'), `${label}: escaped text missing`);
  const m = h.match(/<script type="application\/json" id="review-data">([\s\S]*?)<\/script>/);
  assert.ok(m && !m[1].includes('<'), `${label}: embedded JSON has raw <`);
  assert.equal((h.match(/<\/script/gi) || []).length, 3, `${label}: stray closing script tag`);
}
const designFields = {
  title: (d) => { d.title = HOSTILE; },
  project: (d) => { d.project = HOSTILE; },
  'basis-ish via component name': (d) => { d.components[0].name = HOSTILE; },
  'component responsibility': (d) => { d.components[0].responsibility = HOSTILE; },
  'model name': (d) => { d.dataModel[0].name = HOSTILE; },
  'model purpose': (d) => { d.dataModel[0].purpose = HOSTILE; },
  'schema text': (d) => { d.dataModel[0].schema.text = HOSTILE; },
  'schema lang': (d) => { d.dataModel[0].schema.lang = HOSTILE; },
  'api name': (d) => { d.apis[0].name = HOSTILE; },
  'api purpose': (d) => { d.apis[0].purpose = HOSTILE; },
  'shape text': (d) => { d.apis[0].shape.text = HOSTILE; },
  'integration text': (d) => { d.integration[0].text = HOSTILE; },
  'decision text': (d) => { d.decisions[0].text = HOSTILE; },
  'option label': (d) => { d.decisions[0].options[0].label = HOSTILE; },
  'option pros': (d) => { d.decisions[0].options[0].pros = HOSTILE; },
  'option cons': (d) => { d.decisions[0].options[0].cons = HOSTILE; },
  'decision reason': (d) => { d.decisions[0].reason = HOSTILE; },
  'risk text': (d) => { d.risks[0].text = HOSTILE; },
  'risk mitigation': (d) => { d.risks[0].mitigation = HOSTILE; }
};
for (const [name, mutate] of Object.entries(designFields)) {
  test(`design escaping: ${name}`, () => { const d = clone(design); mutate(d); assertEscaped(html(d), name); });
}

// ---------------- plan ----------------
test('plan: example renders; step / risk / decision ids and criteria row refs are addresses', () => {
  const h = html(plan);
  const a = addrs(h);
  for (const id of ['P1-1', 'P2-1', 'P2-2', 'R1', 'D1', 'N1', 'E1', 'S1']) assert.ok(a.includes(id), id);
  for (const s of ['この画面で確認すること', '概要', 'もとにする要件', '構成の変更', '実装の手順', 'テストの方針', 'リスクと対策', '判断', '成功条件',
    'この計画でよい', '直してほしい', '中止する', '土台（データ）', '単体: ', '結合: ', '確かめ方の種別', '元の要件']) {
    assert.ok(h.includes(s), s);
  }
  assert.deepEqual([...h.matchAll(/<span class="vl">([^<]*)<\/span>/g)].map((m) => m[1]), ['この計画でよい', '直してほしい', '中止する'], 'no rescope in plan');
  assert.ok(h.includes('実装計画（どの順で、どのファイルを、どう変えるか）が正しいかを確認します。この計画で実装に進んでよいかを判断してください。'));
  assert.ok(!h.includes('E2E: '), 'empty e2e skipped');
  assert.equal(embedded(h).profile, 'plan');
  assert.ok(!/<script[^>]+src=/i.test(h) && !/<link[^>]+href=/i.test(h));
  for (const s of [...h.matchAll(/<script>\n([\s\S]*?)<\/script>/g)].map((m) => m[1])) new vm.Script(s);
});

test('plan: step text, dependencies and risk wording', () => {
  const e = embedded(html(plan));
  const steps = e.sections.find((s) => s.heading === '実装の手順').blocks;
  assert.equal(steps.length, 2);
  assert.equal(steps[0].title, '土台（データ）');
  const items = steps.flatMap((c) => c.blocks[0].items);
  assert.equal(items[0].ref, 'P1-1');
  assert.equal(items[0].text, 'P1-1 列の追加（db/migrations/add_room_status.sql）: 開催日と状態の列を足し、既存の行は公開中にする。理由: 後の手順がこの列に依存するため。依存: なし。リスク: 中');
  assert.ok(items[1].text.includes('依存: P1-1。リスク: 低'));
});

test('plan: criteria table rows carry the id as the first cell address; other cells keep auto addresses', () => {
  const h = html(plan);
  assert.ok(/<tr><td data-addr="N1" data-label="成功条件 N1">N1<\/td><td data-addr="b\d+"/.test(h));
  assert.ok(/<tr><td data-addr="E1" [^>]*>E1<\/td>/.test(h));
  const e = embedded(h);
  const t = e.sections.find((s) => s.heading === '成功条件').blocks[0];
  assert.deepEqual(t.columns, ['ID', '確かめ方の種別', '軸', '条件', '確かめ方', '元の要件']);
  assert.equal(t.rows[0].cells[5], 'S1-AC1');
  assert.equal(t.rows[1].cells[5], 'なし');
});

test('plan: decision note gets the recommended reason appended', () => {
  const q = embedded(html(plan)).sections.find((s) => s.heading === '判断').blocks[0];
  assert.equal(q.options[0].note, '今の見え方が変わらない（推奨の理由: 既存の利用者への影響をなくすため）');
  assert.equal(q.options[1].note, undefined);
});

test('plan: questions are optional; empty optional sections show なし', () => {
  const d = clone(plan);
  delete d.questions; d.requirements = []; d.architectureChanges = []; d.risks = []; d.testing = {};
  const e = embedded(html(d));
  for (const h of ['もとにする要件', '構成の変更', 'テストの方針', 'リスクと対策', '判断']) {
    assert.deepEqual(e.sections.find((s) => s.heading === h).blocks, [{ type: 'p', text: 'なし' }], h);
  }
});

const planBad = [
  ['wrong kind', (d) => { d.kind = 'review-html/x'; }, '$.kind'],
  ['bad docId', (d) => { d.docId = 'A'; }, '$.docId'],
  ['bad createdAt', (d) => { d.createdAt = 'today'; }, '$.createdAt'],
  ['missing overview', (d) => { delete d.overview; }, '$.overview'],
  ['empty phases', (d) => { d.phases = []; }, '$.phases'],
  ['phase without steps', (d) => { d.phases[0].steps = []; }, '$.phases[0].steps'],
  ['bad step id', (d) => { d.phases[0].steps[0].id = 'S1'; }, '$.phases[0].steps[0].id'],
  ['duplicate step id', (d) => { d.phases[1].steps[0].id = 'P1-1'; }, 'duplicate id "P1-1"'],
  ['dependsOn unknown id', (d) => { d.phases[1].steps[0].dependsOn = ['P9-9']; }, 'unknown step id "P9-9"'],
  ['dependsOn itself', (d) => { d.phases[1].steps[0].dependsOn = ['P2-1']; }, 'cannot depend on itself'],
  ['dependsOn not strings', (d) => { d.phases[1].steps[0].dependsOn = [1]; }, 'dependsOn[0]'],
  ['bad risk level', (d) => { d.phases[0].steps[0].risk = 'Low'; }, '$.phases[0].steps[0].risk'],
  ['missing why', (d) => { delete d.phases[0].steps[0].why; }, '$.phases[0].steps[0].why'],
  ['bad risk id', (d) => { d.risks[0].id = 'Q1'; }, '$.risks[0].id'],
  ['bad question id', (d) => { d.questions[0].id = 'R1'; }, '$.questions[0].id'],
  ['question recommended not in options', (d) => { d.questions[0].recommended = 'zzz'; }, '$.questions[0].recommended'],
  ['question option other is reserved', (d) => { d.questions[0].options[0].value = 'other'; }, 'reserved'],
  ['question too few options', (d) => { d.questions[0].options.pop(); }, '$.questions[0].options'],
  ['testing missing', (d) => { delete d.testing; }, '$.testing'],
  ['testing item not a string', (d) => { d.testing.unit = [1]; }, '$.testing.unit[0]'],
  ['empty criteria', (d) => { d.criteria = []; }, '$.criteria'],
  ['bad criterion id', (d) => { d.criteria[0].id = 'X1'; }, '$.criteria[0].id'],
  ['duplicate criterion id', (d) => { d.criteria[1].id = 'N1'; d.criteria[1].axis = 'N'; }, 'duplicate id "N1"'],
  ['criterion id / axis mismatch', (d) => { d.criteria[0].axis = 'E'; }, '$.criteria[0].axis'],
  ['bad axis', (d) => { d.criteria[0].axis = 'X'; }, '$.criteria[0].axis'],
  ['bad tag', (d) => { d.criteria[0].tag = 'ai'; }, '$.criteria[0].tag'],
  ['bad source', (d) => { d.criteria[0].source = 'S1'; }, '$.criteria[0].source'],
  ['string over 4000 chars', (d) => { d.overview = 'あ'.repeat(4001); }, '$.overview']
];
for (const [name, mutate, needle] of planBad) {
  test(`plan validation: ${name}`, () => { const d = clone(plan); mutate(d); expectBad(d, needle); });
}
test('plan: tags 機械 and AI are both accepted', () => {
  const d = clone(plan); d.criteria[1].tag = 'AI';
  assert.equal(run(d).status, 0);
});

const planFields = {
  title: (d) => { d.title = HOSTILE; },
  overview: (d) => { d.overview = HOSTILE; },
  requirement: (d) => { d.requirements[0] = HOSTILE; },
  'architecture file': (d) => { d.architectureChanges[0].file = HOSTILE; },
  'architecture text': (d) => { d.architectureChanges[0].text = HOSTILE; },
  'phase name': (d) => { d.phases[0].name = HOSTILE; },
  'step name': (d) => { d.phases[0].steps[0].name = HOSTILE; },
  'step file': (d) => { d.phases[0].steps[0].file = HOSTILE; },
  'step action': (d) => { d.phases[0].steps[0].action = HOSTILE; },
  'step why': (d) => { d.phases[0].steps[0].why = HOSTILE; },
  'testing unit': (d) => { d.testing.unit[0] = HOSTILE; },
  'testing integration': (d) => { d.testing.integration[0] = HOSTILE; },
  'testing e2e': (d) => { d.testing.e2e = [HOSTILE]; },
  'risk text': (d) => { d.risks[0].text = HOSTILE; },
  'risk mitigation': (d) => { d.risks[0].mitigation = HOSTILE; },
  'question text': (d) => { d.questions[0].text = HOSTILE; },
  'question option label': (d) => { d.questions[0].options[0].label = HOSTILE; },
  'question option note': (d) => { d.questions[0].options[0].note = HOSTILE; },
  'question reason': (d) => { d.questions[0].reason = HOSTILE; },
  'criterion predicate': (d) => { d.criteria[0].predicate = HOSTILE; },
  'criterion testApproach': (d) => { d.criteria[0].testApproach = HOSTILE; }
};
for (const [name, mutate] of Object.entries(planFields)) {
  test(`plan escaping: ${name}`, () => { const d = clone(plan); mutate(d); assertEscaped(html(d), name); });
}

// ---------------- core ----------------
test('core: PROFILES has design and plan with explanations; exact verdict sets', () => {
  assert.deepEqual(core.verdictValues('design'), ['approve', 'revise', 'rescope', 'abort']);
  assert.deepEqual(core.verdictValues('plan'), ['approve', 'revise', 'abort']);
  assert.deepEqual(core.PROFILES.design.verdicts.map((v) => v.label), ['この設計でよい', '直してほしい', '要件から見直す', '中止する']);
  assert.deepEqual(core.PROFILES.plan.verdicts.map((v) => v.label), ['この計画でよい', '直してほしい', '中止する']);
  for (const p of ['design', 'plan']) for (const v of core.PROFILES[p].verdicts) assert.ok(typeof v.explain === 'string' && v.explain.length > 0, `${p}/${v.value}`);
  assert.equal(core.PROFILES.design.verdicts[0].explain, 'チャットで最後の確認をしてから、実装の計画に進みます。');
  assert.equal(core.PROFILES.plan.verdicts[0].explain, 'チャットで最後の確認をしてから、実装に進みます。');
});

test('core: buildPayload accepts design / plan verdicts and rejects others', () => {
  const dDoc = embedded(html(design));
  const pDoc = embedded(html(plan));
  const sd = core.initialState(dDoc), sp = core.initialState(pDoc);
  for (const v of ['approve', 'revise', 'rescope', 'abort']) assert.equal(core.buildPayload(dDoc, { ...sd, verdict: v }).verdict, v);
  for (const v of ['approve', 'revise', 'abort']) assert.equal(core.buildPayload(pDoc, { ...sp, verdict: v }).verdict, v);
  assert.throws(() => core.buildPayload(pDoc, { ...sp, verdict: 'rescope' }), /verdict/);
  assert.throws(() => core.buildPayload(dDoc, { ...sd, verdict: 'proceed' }), /verdict/);
  assert.throws(() => core.buildPayload(dDoc, { ...sd, verdict: null }), /verdict/);
  const p = core.buildPayload(dDoc, { ...sd, verdict: 'approve' });
  assert.equal(p.profile, 'design');
  assert.equal(p.decisions.D1.recommended, 'job');
  assert.equal(p.decisions.D1.touched, false);
  assert.equal(core.buildPayload(pDoc, { ...sp, verdict: 'approve' }).profile, 'plan');
  assert.equal(core.restoreState(pDoc, { verdict: 'rescope' }).verdict, null, 'rescope is not a plan verdict');
});

// ---------------- table row refs in the generic doc ----------------
const gdoc = (rows, extra = {}) => ({ ...clone(consult), sections: [{ heading: '節', blocks: [{ type: 'table', columns: ['a', 'b'], rows, ...extra }] }] });

test('table row refs: first cell uses the ref; other cells and plain rows keep auto addresses', () => {
  const h = html(gdoc([{ ref: 'T1', cells: ['x', 'y'] }, ['p', 'q'], { ref: 'T2', cells: ['z', 'w'] }]));
  const a = addrs(h);
  assert.ok(a.includes('T1') && a.includes('T2'));
  assert.ok(/<td data-addr="T1" data-label="節 T1">x<\/td><td data-addr="b\d+" data-label="節">y<\/td>/.test(h));
  assert.equal(new Set(a).size, a.length, 'addresses unique');
});
test('table row refs: duplicate ref (also against other blocks) is rejected', () => {
  expectBad(gdoc([{ ref: 'T1', cells: ['x', 'y'] }, { ref: 'T1', cells: ['p', 'q'] }]), 'duplicate ref "T1"');
  const d = gdoc([{ ref: 'T1', cells: ['x', 'y'] }]);
  d.sections[0].blocks.push({ type: 'p', ref: 'T1', text: 'x' });
  expectBad(d, 'duplicate ref "T1"');
});
test('table row refs: reserved b<n> names, bad format and missing ref are rejected', () => {
  expectBad(gdoc([{ ref: 'b3', cells: ['x', 'y'] }]), 'reserved');
  expectBad(gdoc([{ ref: '1bad', cells: ['x', 'y'] }]), '$.sections[0].blocks[0].rows[0].ref');
  expectBad(gdoc([{ cells: ['x', 'y'] }]), 'rows[0].ref: required');
});
test('table row refs: cells must be an array of strings with the right count', () => {
  expectBad(gdoc([{ ref: 'T1', cells: ['x'] }]), 'rows[0].cells: must have 2 cells');
  expectBad(gdoc([{ ref: 'T1', cells: 'x' }]), 'rows[0].cells: must be an array');
  expectBad(gdoc([{ ref: 'T1', cells: ['x', 2] }]), 'rows[0].cells[1]');
});
test('table row refs: hostile text in a ref row is escaped', () => {
  const h = html(gdoc([{ ref: 'T1', cells: [HOSTILE, HOSTILE] }]));
  assertEscaped(h, 'row ref cells');
});
test('design / plan profiles are not accepted on a generic review-html/doc input', () => {
  for (const profile of ['design', 'plan', 'requirements']) {
    const d = clone(consult); d.profile = profile;
    expectBad(d, '$.profile');
  }
});

// ---------------- review fixes: composed length, dependency cycles, strictness ----------------
const A = (n) => 'あ'.repeat(n);
const composedBad = [
  ['design option note (pros + cons)', design, (d) => { d.decisions[0].options[1].pros = A(3900); d.decisions[0].options[1].cons = A(100); }, '$.decisions[0].options[1]'],
  ['design recommended option note (+ reason)', design, (d) => { d.decisions[0].options[0].pros = A(3980); delete d.decisions[0].options[0].cons; }, '$.decisions[0].options[0]'],
  ['design risk text + mitigation', design, (d) => { d.risks[0].text = A(3990); d.risks[0].mitigation = A(100); }, '$.risks[0]'],
  ['design component card title', design, (d) => { d.components[0].name = A(3999); }, '$.components[0].name'],
  ['design data model card title', design, (d) => { d.dataModel[0].name = A(3999); }, '$.dataModel[0].name'],
  ['design api card title', design, (d) => { d.apis[0].name = A(3999); }, '$.apis[0].name'],
  ['plan option note (+ reason)', plan, (d) => { d.questions[0].options[0].note = A(3990); }, '$.questions[0].options[0]'],
  ['plan risk text + mitigation', plan, (d) => { d.risks[0].text = A(3990); d.risks[0].mitigation = A(100); }, '$.risks[0]'],
  ['plan step composed line', plan, (d) => { d.phases[0].steps[0].action = A(3990); d.phases[0].steps[0].why = A(100); }, '$.phases[0].steps[0]']
];
for (const [name, base, mutate, needle] of composedBad) {
  test(`composed length: ${name}`, () => { const d = clone(base); mutate(d); expectBad(d, needle); expectBad(d, 'when composed'); });
}

test('plan: a 2-step dependency cycle is rejected with the cycle path', () => {
  const d = clone(plan); d.phases[1].steps[0].dependsOn = ['P2-2']; d.phases[1].steps[1].dependsOn = ['P2-1'];
  expectBad(d, 'dependency cycle: P2-1 -> P2-2 -> P2-1');
});
test('plan: a 3-step dependency cycle is rejected', () => {
  const d = clone(plan);
  d.phases[0].steps[0].dependsOn = ['P2-2'];
  d.phases[1].steps[0].dependsOn = ['P1-1'];
  d.phases[1].steps[1].dependsOn = ['P2-1'];
  expectBad(d, 'dependency cycle: P1-1 -> P2-2 -> P2-1 -> P1-1');
});
test('plan: a phase number that differs from the phase index warns but does not fail', () => {
  const d = clone(plan);
  d.phases[1].steps = [{ ...d.phases[1].steps[0], id: 'P3-1' }, { ...d.phases[1].steps[1], id: 'P3-2' }];
  const r = run(d);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stderr.includes('$.phases[1].steps[0].id') && r.stderr.includes('phase number'), r.stderr);
});
test('plan: the example has no phase-number warning', () => {
  assert.ok(!run(plan).stderr.includes('phase number'));
});

const capCases = [
  ['design component C', design, (d, v) => { d.components[0].id = `C${v}`; }, '$.components[0].id'],
  ['design model M', design, (d, v) => { d.dataModel[0].id = `M${v}`; }, '$.dataModel[0].id'],
  ['design api A', design, (d, v) => { d.apis[0].id = `A${v}`; }, '$.apis[0].id'],
  ['design integration I', design, (d, v) => { d.integration[0].id = `I${v}`; }, '$.integration[0].id'],
  ['design decision D', design, (d, v) => { d.decisions[0].id = `D${v}`; }, '$.decisions[0].id'],
  ['design risk R', design, (d, v) => { d.risks[0].id = `R${v}`; }, '$.risks[0].id'],
  ['design basis S', design, (d, v) => { d.basis[0] = `S${v}`; }, '$.basis[0]'],
  ['design basis AC', design, (d, v) => { d.basis[1] = `S1-AC${v}`; }, '$.basis[1]'],
  ['design basis N', design, (d, v) => { d.basis[2] = `N${v}`; }, '$.basis[2]'],
  ['plan risk R', plan, (d, v) => { d.risks[0].id = `R${v}`; }, '$.risks[0].id'],
  ['plan question D', plan, (d, v) => { d.questions[0].id = `D${v}`; }, '$.questions[0].id'],
  ['plan criterion N', plan, (d, v) => { d.criteria[0].id = `N${v}`; }, '$.criteria[0].id'],
  ['plan criterion source', plan, (d, v) => { d.criteria[0].source = `S1-AC${v}`; }, '$.criteria[0].source']
];
for (const [name, base, mutate, needle] of capCases) {
  test(`id digits capped: ${name}`, () => {
    const ok = clone(base); mutate(ok, '123456');
    const r = run(ok);
    assert.equal(r.status, 0, r.stderr);
    const bad = clone(base); mutate(bad, '1234567');
    expectBad(bad, needle);
  });
}
test('id digits capped: plan step id (both parts)', () => {
  const a = clone(plan); a.phases[0].steps[0].id = 'P1-1234567';
  expectBad(a, '$.phases[0].steps[0].id');
  const b = clone(plan); b.phases[0].steps[0].id = 'P1234567-1';
  expectBad(b, '$.phases[0].steps[0].id');
});

test('design: duplicate basis entries are rejected', () => {
  const d = clone(design); d.basis.push(d.basis[0]);
  expectBad(d, `duplicate basis "${d.basis[0]}"`);
});

test('plan: action / why ending in a full stop do not double it', () => {
  const d = clone(plan);
  d.phases[0].steps[0].action = '列を足す。'; d.phases[0].steps[0].why = '後の手順のため。。';
  const h = html(d);
  const sec = embedded(h).sections.find((s) => s.heading === '実装の手順');
  const t = sec.blocks[0].blocks[0].items[0].text;
  assert.ok(t.includes(': 列を足す。理由: 後の手順のため。依存:'), t);
  assert.ok(!t.includes('。。'), t);
});

test('plan: testing is required (may be {}) and every kind is optional', () => {
  const d = clone(plan); d.testing = {};
  assert.equal(run(d).status, 0);
  d.testing = { e2e: ['一覧から見える'] };
  assert.equal(run(d).status, 0);
  delete d.testing;
  expectBad(d, '$.testing');
});

const strictCases = [
  ['design component', design, (d) => { d.components[0].extra = 1; }, '$.components[0].extra'],
  ['design model', design, (d) => { d.dataModel[0].extra = 1; }, '$.dataModel[0].extra'],
  ['design schema', design, (d) => { d.dataModel[0].schema.extra = 1; }, '$.dataModel[0].schema.extra'],
  ['design api', design, (d) => { d.apis[0].extra = 1; }, '$.apis[0].extra'],
  ['design integration', design, (d) => { d.integration[0].extra = 1; }, '$.integration[0].extra'],
  ['design decision', design, (d) => { d.decisions[0].extra = 1; }, '$.decisions[0].extra'],
  ['design option (a misspelt "pro")', design, (d) => { d.decisions[0].options[0].pro = 'x'; }, '$.decisions[0].options[0].pro'],
  ['design risk', design, (d) => { d.risks[0].extra = 1; }, '$.risks[0].extra'],
  ['plan architecture change', plan, (d) => { d.architectureChanges[0].extra = 1; }, '$.architectureChanges[0].extra'],
  ['plan phase', plan, (d) => { d.phases[0].extra = 1; }, '$.phases[0].extra'],
  ['plan step', plan, (d) => { d.phases[0].steps[0].extra = 1; }, '$.phases[0].steps[0].extra'],
  ['plan testing', plan, (d) => { d.testing.extra = []; }, '$.testing.extra'],
  ['plan question option', plan, (d) => { d.questions[0].options[0].pros = 'x'; }, '$.questions[0].options[0].pros'],
  ['plan criterion', plan, (d) => { d.criteria[0].extra = 1; }, '$.criteria[0].extra']
];
for (const [name, base, mutate, needle] of strictCases) {
  test(`unknown field is an error: ${name}`, () => { const d = clone(base); mutate(d); expectBad(d, needle); expectBad(d, 'unknown field'); });
}
