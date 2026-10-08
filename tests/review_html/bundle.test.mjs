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
const req = readJson('example.requirements.json');
const design = readJson('example.design.json');
const plan = readJson('example.plan.json');
const consult = readJson('example.consult.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-html-bundle-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const clone = (o) => JSON.parse(JSON.stringify(o));
const mkBundle = () => ({
  kind: 'review-html/bundle', version: 1, docId: 'bundle-test-1', title: 'テスト機能', project: 'P', createdAt: '2026-10-08',
  tabs: [
    { key: 'requirements', status: 'approved', approvedAt: '2026-10-08', answers: { Q1: req.questions[0].options[0].value }, input: clone(req) },
    { key: 'design', status: 'approved', approvedAt: '2026-10-08', input: clone(design) },
    { key: 'plan', status: 'current', input: clone(plan) }
  ]
});
let n = 0;
function run(data) {
  const inFile = path.join(tmp, `in${n}.json`);
  const outFile = path.join(tmp, `out${n++}.html`);
  fs.writeFileSync(inFile, JSON.stringify(data));
  const r = spawnSync('node', [RENDER, '--in', inFile, '--out', outFile], { encoding: 'utf8' });
  return { ...r, outFile };
}
const html = (d) => { const r = run(d); assert.equal(r.status, 0, r.stderr); return fs.readFileSync(r.outFile, 'utf8'); };
const addrs = (h) => [...h.matchAll(/data-addr="([^"]+)"/g)].map((m) => m[1]);
const embedded = (h) => JSON.parse(h.match(/<script type="application\/json" id="review-data">([\s\S]*?)<\/script>/)[1]);
function bad(mut, needle) {
  const b = mkBundle(); mut(b);
  const r = run(b);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes(needle), `stderr should contain ${needle}: ${r.stderr}`);
  assert.ok(!fs.existsSync(r.outFile));
}

// ---------------- validation ----------------
test('bundle: valid example renders', () => { assert.ok(html(mkBundle()).startsWith('<!doctype html>')); });
test('bundle validation: envelope', () => {
  bad((b) => { b.version = 2; }, '$.version');
  bad((b) => { b.docId = 'A'; }, '$.docId');
  bad((b) => { b.createdAt = '2026/10/08'; }, '$.createdAt');
  bad((b) => { b.tabs = []; }, '$.tabs');
  bad((b) => { b.tabs = b.tabs.concat(Array.from({ length: 4 }, (_, i) => ({ key: `consult-x${i}`, status: 'approved', approvedAt: '2026-10-08', input: clone(consult) }))); }, '$.tabs');
});
test('bundle validation: keys, order, status', () => {
  bad((b) => { b.tabs[0].key = 'foo'; }, '$.tabs[0].key');
  bad((b) => { b.tabs[0].key = 'consult-Bad'; }, '$.tabs[0].key');
  bad((b) => { b.tabs[1].key = 'requirements'; }, 'duplicate tab key');
  bad((b) => { [b.tabs[0], b.tabs[1]] = [b.tabs[1], b.tabs[0]]; }, 'ordered');
  bad((b) => { b.tabs[0].status = 'weird'; }, '$.tabs[0].status');
  bad((b) => { b.tabs[1].status = 'current'; }, 'exactly one');
  bad((b) => { b.tabs[2].status = 'approved'; b.tabs[2].approvedAt = '2026-10-08'; }, 'exactly one');
  bad((b) => { b.tabs[0].approvedAt = undefined; }, '$.tabs[0].approvedAt');
  bad((b) => { b.tabs[2].answers = { D1: 'a' }; }, '$.tabs[2].answers');
  bad((b) => { b.tabs[2].approvedAt = '2026-10-08'; }, '$.tabs[2].approvedAt');
});
test('bundle validation: answers', () => {
  bad((b) => { b.tabs[0].answers = { Q99: 'x' }; }, '$.tabs[0].answers.Q99');
  bad((b) => { b.tabs[0].answers = { Q1: 'nope' }; }, '$.tabs[0].answers.Q1');
  const b = mkBundle(); b.tabs[0].answers = { Q1: 'other' };
  assert.ok(html(b).includes('その他（自由記述）'));
});
test('bundle validation: tab key must match the input kind (error, not warning)', () => {
  bad((b) => { b.tabs[2].input = clone(design); }, '$.tabs[2].input.kind');
  bad((b) => { b.tabs[0].input = clone(plan); }, 'must hold a "review-html/requirements" input');
  bad((b) => { b.tabs[1].input = clone(consult); }, '$.tabs[1].input.kind');
  bad((b) => { b.tabs.push({ key: 'consult-x', status: 'current', input: clone(req) }); b.tabs[2].status = 'approved'; b.tabs[2].approvedAt = '2026-10-08'; }, '$.tabs[3].input.kind');
  const ok = mkBundle(); ok.tabs[2].status = 'approved'; ok.tabs[2].approvedAt = '2026-10-08';
  ok.tabs.push({ key: 'consult-x', status: 'current', input: clone(consult) });
  assert.ok(html(ok).includes('相談（x）'));
});
test('bundle validation: answers recorded as other ({value, text})', () => {
  bad((b) => { b.tabs[0].answers = { Q1: { value: 'a' } }; }, '$.tabs[0].answers.Q1.value');
  bad((b) => { b.tabs[0].answers = { Q1: { value: 'other', text: 5 } }; }, '$.tabs[0].answers.Q1.text');
  bad((b) => { b.tabs[0].answers = { Q1: { value: 'other', text: 'x'.repeat(2001) } }; }, '$.tabs[0].answers.Q1.text');
  bad((b) => { b.tabs[0].answers = { Q1: { value: 'other', extra: 1 } }; }, '$.tabs[0].answers.Q1.extra');
  const b = mkBundle(); b.tabs[0].answers = { Q1: { value: 'other', text: '別案 <b>X</b>' } };
  const h = html(b);
  const card = h.match(/<div class="card dcard dcard-approved" data-decision="requirements:Q1">[\s\S]*?<\/div>/)[0];
  assert.ok(/value="other" checked disabled/.test(card));
  assert.ok(card.includes('class="other-text"') && card.includes('別案 &lt;b&gt;X&lt;/b&gt;') && !card.includes('<b>X'));
  assert.ok(!card.includes('<textarea'));
});
test('bundle validation: inner input errors are prefixed with the tab path', () => {
  bad((b) => { delete b.tabs[1].input.components; }, '$.tabs[1].input.components');
  bad((b) => { b.tabs[2].input.phases = []; }, '$.tabs[2].input.phases');
  bad((b) => { b.tabs[0].input.goal = ''; }, '$.tabs[0].input.goal');
  bad((b) => { b.tabs[2].input = { kind: 'review-html/bundle' }; }, '$.tabs[2].input.kind');
});
test('bundle: inner docId is ignored', () => {
  const b = mkBundle(); b.tabs[0].input.docId = 'something-else';
  const h = html(b);
  assert.equal(embedded(h).docId, 'bundle-test-1');
  assert.ok(embedded(h).tabs.every((t) => t.doc.docId === 'bundle-test-1'));
});

// ---------------- rendering ----------------
test('bundle render: tab bar roles, one panel per tab, current selected', () => {
  const h = html(mkBundle());
  assert.equal((h.match(/<div [^>]*role="tablist"/g) || []).length, 1);
  assert.equal((h.match(/<button [^>]*role="tab"/g) || []).length, 3);
  assert.equal((h.match(/<div [^>]*role="tabpanel"/g) || []).length, 3);
  assert.ok(/id="tab-plan"[^>]*aria-selected="true"[^>]*tabindex="0"/.test(h));
  assert.ok(/id="tab-requirements"[^>]*aria-selected="false"[^>]*tabindex="-1"/.test(h));
  assert.ok(/id="tp-plan"[^>]*>/.test(h) && !/id="tp-plan"[^>]* hidden/.test(h));
  assert.ok(/id="tp-design"[^>]* hidden/.test(h) && /id="tp-requirements"[^>]* hidden/.test(h));
  for (const l of ['要件', '設計', '計画']) assert.ok(h.includes(`<span class="tab-name">${l}</span>`), l);
  assert.equal((h.match(/class="tab-badge approved">承認済み</g) || []).length, 2);
  assert.equal((h.match(/class="tab-badge current">確認中</g) || []).length, 1);
  assert.ok(h.includes('計画について回答する'));
  assert.ok(h.indexOf('id="tabbar"') > h.indexOf('<h1>') && h.indexOf('id="tabbar"') < h.indexOf('id="tp-requirements"'));
  for (const s of [...h.matchAll(/<script>\n([\s\S]*?)<\/script>/g)].map((m) => m[1])) new vm.Script(s);
});
test('bundle render: consult tab label', () => {
  const b = mkBundle();
  b.tabs.splice(2, 0, { key: 'consult-room-api', status: 'approved', approvedAt: '2026-10-08', input: clone(consult) });
  const h = html(b);
  assert.ok(h.includes('<span class="tab-name">相談（room-api）</span>'));
  assert.ok(addrs(h).some((a) => a.startsWith('consult-room-api:')));
});
test('bundle render: addresses are namespaced and unique across tabs', () => {
  const h = html(mkBundle());
  const a = addrs(h);
  assert.equal(new Set(a).size, a.length);
  for (const x of ['requirements:R1', 'design:R1', 'requirements:S1-AC1', 'design:C1', 'plan:P1-1', 'requirements:Q1', 'design:D1']) assert.ok(a.includes(x), x);
  assert.ok(a.every((x) => /^(requirements|design|plan):/.test(x)));
  assert.ok(/data-addr="requirements:S1-AC1" data-label="要件 › 機能要件 S1-AC1"/.test(h));
  assert.ok(/data-addr="plan:P1-1" data-label="計画 › 実装の手順 P1-1"/.test(h));
});
test('bundle render: approved decisions disabled with recorded answers, current interactive', () => {
  const b = mkBundle();
  const q1 = req.questions[0];
  const rec = q1.recommended;
  const other = q1.options.find((o) => o.value !== rec).value;
  b.tabs[0].answers = { Q1: other };
  const h = html(b);
  const approved = h.match(/<div class="card dcard dcard-approved" data-decision="requirements:Q1">[\s\S]*?<\/div>/)[0];
  assert.ok(approved.includes('承認時の回答'));
  assert.ok(!approved.includes('<textarea'));
  const inputs = [...approved.matchAll(/<input [^>]*>/g)].map((m) => m[0]);
  assert.ok(inputs.length >= 2 && inputs.every((i) => /\bdisabled\b/.test(i)));
  assert.ok(inputs.filter((i) => /\bchecked\b/.test(i)).length === 1 && /value="([^"]+)"[^>]*checked/.test(approved));
  assert.ok(new RegExp(`value="${other}" checked`).test(approved));
  // design has no answers: the recommended option is shown
  const dApproved = h.match(/<div class="card dcard dcard-approved" data-decision="design:D1">[\s\S]*?<\/div>/)[0];
  assert.ok(new RegExp(`value="${design.decisions[0].recommended}" checked`).test(dApproved));
  // current tab: interactive, recommended pre-checked, other + textarea present
  const cur = h.match(/<div class="card dcard" data-decision="plan:D1">[\s\S]*?<\/textarea><\/div>/)[0];
  assert.ok(!/\bdisabled\b/.test(cur));
  assert.ok(cur.includes('data-chip="plan:D1"') && cur.includes('data-other="plan:D1"') && cur.includes('その他（自由記述）'));
  assert.ok(new RegExp(`value="${plan.questions[0].recommended}" checked`).test(cur));
});
test('bundle render: guide boxes per status', () => {
  const h = html(mkBundle());
  const panel = (k) => h.match(new RegExp(`<div class="tabpanel"[^>]*id="tp-${k}"[\\s\\S]*?</aside>`))[0];
  const cur = panel('plan');
  assert.ok(cur.includes('この画面で確認すること') && cur.includes('この計画でよい') && cur.includes('回答の選び方'));
  for (const k of ['requirements', 'design']) {
    const p = panel(k);
    assert.ok(p.includes('承認済み（2026-10-08）'), k);
    assert.ok(!p.includes('回答の選び方') && !p.includes('直してほしい'), k);
  }
  assert.ok(panel('requirements').includes('の要件（何を作るか・何を作らないか）が正しいかを確認します。'));
  assert.ok(h.includes('<span class="vl">この計画でよい</span>') && !h.includes('<span class="vl">この設計でよい</span>'));
});
test('bundle render: escaping across tabs and script safety', () => {
  const b = mkBundle();
  const X = '<img src=x onerror=alert(1)> </script> &';
  b.tabs[0].input.goal = X; b.tabs[1].input.components[0].responsibility = X; b.tabs[2].input.overview = X;
  const h = html(b);
  assert.ok(!h.includes('<img src=x'));
  assert.equal((h.match(/&lt;img src=x onerror=alert\(1\)&gt; &lt;\/script&gt; &amp;/g) || []).length, 3);
  assert.equal((h.match(/<\/script>/g) || []).length, 3);
  assert.equal(embedded(h).tabs[0].doc.sections[0].blocks[0].text, X);
});
test('single-document pages are unchanged by bundle support', () => {
  const r = run(plan);
  assert.equal(r.status, 0, r.stderr);
  const h = fs.readFileSync(r.outFile, 'utf8');
  assert.ok(!h.includes('<div class="tablist"') && !h.includes('class="card dcard dcard-approved"'));
  assert.ok(addrs(h).includes('P1-1') && h.includes('<h2 class="dlg-title" id="dlgTitle" tabindex="-1">回答する</h2>'));
});

// ---------------- core ----------------
const emb = () => embedded(html(mkBundle()));
test('core: address namespacing', () => {
  assert.equal(core.nsAddr('design', 'R1'), 'design:R1');
  assert.equal(core.tabOfAddr('design:R1'), 'design');
  assert.equal(core.tabOfAddr('consult-a-b:b3'), 'consult-a-b');
  assert.equal(core.tabOfAddr('R1'), null);
  assert.equal(core.tabLabel('consult-x'), '相談（x）');
});
const cm = (addr, id = 'c-' + addr) => ({ id, addr, label: 'L', quote: 'q', prefix: '', suffix: '', text: 't' });
test('core: restore keeps unchanged tabs\' comments when another tab changes', () => {
  const b = emb();
  const saved = core.serializeBundleState(b, { ...core.initialBundleState(b), comments: [cm('requirements:R1'), cm('design:R1'), cm('plan:P1-1')] });
  const b2 = clone(b);
  b2.tabs[1].contentHash = 'changed';
  const st = core.restoreBundleState(b2, saved);
  assert.deepEqual(st.comments.map((c) => c.addr).sort(), ['plan:P1-1', 'requirements:R1']);
  assert.equal(st.stale, true);
  const same = core.restoreBundleState(b, saved);
  assert.equal(same.comments.length, 3);
  assert.equal(same.stale, false);
});
test('core: restore drops current state when the current key or hash changes; sent follows', () => {
  const b = emb();
  const q = core.collectDecisions(b.tabs[2].doc)[0];
  const other = q.options.find((o) => o.value !== q.recommended).value;
  const st0 = core.initialBundleState(b);
  st0.decisions[q.ref] = { value: other, touched: true, text: '' };
  st0.verdict = 'revise'; st0.note = 'memo'; st0.sent = true; st0.comments = [cm('plan:P1-1')];
  const saved = core.serializeBundleState(b, st0);
  const ok = core.restoreBundleState(b, saved);
  assert.equal(ok.decisions[q.ref].value, other);
  assert.equal(ok.verdict, 'revise'); assert.equal(ok.note, 'memo'); assert.equal(ok.sent, true);
  // plan becomes approved and a consult tab becomes current
  const b2 = clone(b);
  b2.tabs[2].status = 'approved';
  b2.tabs.push({ key: 'consult-x', status: 'current', contentHash: 'h', doc: clone(consult).kind ? { ...clone(consult), profile: 'consult' } : null });
  const moved = core.restoreBundleState(b2, saved);
  assert.equal(moved.verdict, null); assert.equal(moved.note, ''); assert.equal(moved.sent, false);
  assert.deepEqual(moved.comments.map((c) => c.addr), ['plan:P1-1']);
  // current hash changes: current state and sent dropped, comments of the (changed) tab dropped too
  const b3 = clone(b); b3.tabs[2].contentHash = 'zzz';
  const h3 = core.restoreBundleState(b3, saved);
  assert.equal(h3.verdict, null); assert.equal(h3.sent, false); assert.equal(h3.comments.length, 0);
  // garbage
  assert.equal(core.restoreBundleState(b, 'x').comments.length, 0);
  assert.equal(core.restoreBundleState(b, { tabs: { plan: 5 }, current: 7 }).verdict, null);
});
test('core: comments claiming another tab\'s address are dropped on restore', () => {
  const b = emb();
  const saved = { tabs: { plan: { contentHash: b.tabs[2].contentHash, comments: [cm('design:R1'), cm('plan:P1-1')] } } };
  assert.deepEqual(core.restoreBundleState(b, saved).comments.map((c) => c.addr), ['plan:P1-1']);
});
test('core: bundle payload v3 shape', () => {
  const b = emb();
  const st = core.initialBundleState(b);
  st.verdict = 'approve'; st.note = 'n'; st.comments = [cm('requirements:R1'), cm('plan:P1-1'), cm('ghost:x')];
  const p = core.buildBundlePayload(b, st, new Date('2026-10-08T00:00:00Z'));
  assert.deepEqual(Object.keys(p), ['kind', 'version', 'docId', 'tab', 'profile', 'verdict', 'decisions', 'comments', 'note', 'sentAt']);
  assert.equal(p.kind, 'review-html/answer'); assert.equal(p.version, 3);
  assert.equal(p.docId, 'bundle-test-1'); assert.equal(p.tab, 'plan'); assert.equal(p.profile, 'plan');
  assert.deepEqual(p.comments.map((c) => [c.tab, c.addr]), [['requirements', 'requirements:R1'], ['plan', 'plan:P1-1']]);
  assert.deepEqual(Object.keys(p.comments[0]), ['tab', 'addr', 'label', 'quote', 'prefix', 'suffix', 'text']);
  const q = core.collectDecisions(b.tabs[2].doc);
  assert.deepEqual(Object.keys(p.decisions), q.map((x) => x.ref));
  assert.throws(() => core.buildBundlePayload(b, core.initialBundleState(b)), /verdict/);
  assert.throws(() => core.buildBundlePayload(b, { ...st, verdict: 'abort2' }), /verdict/);
});

// ---------------- address stability, sent-once comments, consult badge, tab switch ----------------
const EXAMPLES = { requirements: req, design, plan, consult };
const tabAddrs = (h, key) => addrs(h).filter((a) => a.startsWith(`${key}:`));
const nonG = (list) => list.filter((a) => !/^[^:]+:g\d+$/.test(a));
test('addresses: g* guide addresses are separate; bN addresses are identical for current and approved, whatever the answers', () => {
  for (const [name, input] of Object.entries(EXAMPLES)) {
    const key = name === 'consult' ? 'consult-t' : name;
    const filler = { key: 'consult-z', status: 'current', input: clone(consult) };
    const asCurrent = { ...mkBundle(), tabs: [{ key, status: 'current', input: clone(input) }] };
    const hCur = html(asCurrent);
    const cur = tabAddrs(hCur, key);
    assert.ok(cur.some((a) => /:g\d+$/.test(a)), `${name}: guide uses g addresses`);
    const bs = (l) => l.filter((a) => /:b\d+$/.test(a));
    const doc = embedded(hCur).tabs[0].doc;
    const qs = core.collectDecisions(doc);
    const variants = [undefined];
    if (qs.length) {
      variants.push(Object.fromEntries(qs.map((q) => [q.ref, q.options.find((o) => o.value !== q.recommended).value])));
      variants.push(Object.fromEntries(qs.map((q) => [q.ref, { value: 'other', text: '別案' }])));
    }
    variants.forEach((answers, vi) => {
      const b = { ...mkBundle(), tabs: [{ key, status: 'approved', approvedAt: '2026-10-08', ...(answers ? { answers } : {}), input: clone(input) }, filler] };
      const apr = tabAddrs(html(b), key);
      assert.deepEqual(bs(apr), bs(cur), `${name} variant ${vi}: b addresses`);
      if (vi < 2) assert.deepEqual(nonG(apr), nonG(cur), `${name} variant ${vi}: all non-g addresses`);
      else { // "other" with text adds only its own non-b address
        assert.deepEqual(nonG(apr).filter((a) => !a.endsWith('.other')), nonG(cur), `${name}: other-text is the only extra`);
        assert.ok(apr.filter((a) => a.endsWith('.other')).every((a) => !/:b\d+$/.test(a)));
      }
    });
  }
});
test('addresses: refs matching g<n> are reserved like b<n>', () => {
  const g = clone(consult);
  const blk = g.sections[0].blocks.find((x) => x.type === 'p');
  blk.ref = 'g3';
  const r = run({ ...mkBundle(), tabs: [{ key: 'consult-t', status: 'current', input: g }] });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('reserved'));
});
test('core: comments are sent once; later comments go out; sent flags survive restore only for unchanged tabs', () => {
  const b = emb();
  const st = core.initialBundleState(b);
  st.verdict = 'revise';
  st.comments = [cm('requirements:R1', 'a'), cm('plan:P1-1', 'b')];
  const p1 = core.buildBundlePayload(b, st);
  assert.deepEqual(p1.comments.map((c) => c.addr), ['requirements:R1', 'plan:P1-1']);
  const sent = core.markCommentsSent(st);
  assert.ok(sent.comments.every((c) => c.sent === true));
  assert.ok(st.comments.every((c) => c.sent === undefined), 'markCommentsSent does not mutate');
  sent.comments.push(cm('design:R1', 'c'));
  const p2 = core.buildBundlePayload(b, sent);
  assert.deepEqual(p2.comments.map((c) => c.addr), ['design:R1']);
  assert.ok(p2.comments.every((c) => !('sent' in c)));
  assert.deepEqual(core.unsentComments(sent.comments).map((c) => c.id), ['c']);
  // persisted and restored
  const saved = JSON.parse(JSON.stringify(core.serializeBundleState(b, sent)));
  const back = core.restoreBundleState(b, saved);
  assert.deepEqual(back.comments.map((c) => [c.id, c.sent === true]).sort(), [['a', true], ['b', true], ['c', false]]);
  // tab with a changed hash: its comments (and their sent flags) are gone; unchanged tabs keep theirs
  const b2 = clone(b); b2.tabs[0].contentHash = 'new';
  const r2 = core.restoreBundleState(b2, saved);
  assert.deepEqual(r2.comments.map((c) => c.id).sort(), ['b', 'c']);
  assert.ok(r2.comments.filter((c) => c.id === 'b').every((c) => c.sent === true));
});
test('core: stale notice only when something was actually dropped', () => {
  const b = emb();
  const st = core.initialBundleState(b);
  st.comments = [cm('design:R1')];
  const saved = core.serializeBundleState(b, st);
  // an unrelated tab key changed (requirements has no comments, current untouched): nothing lost
  const b2 = clone(b); b2.tabs[0].contentHash = 'new';
  assert.equal(core.restoreBundleState(b2, saved).stale, false);
  // the tab holding a comment changed: lost
  const b3 = clone(b); b3.tabs[1].contentHash = 'new';
  assert.equal(core.restoreBundleState(b3, saved).stale, true);
  // current tab changed with nothing entered: nothing lost; with a verdict entered: lost
  const b4 = clone(b); b4.tabs[2].contentHash = 'new';
  assert.equal(core.restoreBundleState(b4, saved).stale, false);
  const st5 = core.initialBundleState(b); st5.verdict = 'approve';
  assert.equal(core.restoreBundleState(b4, core.serializeBundleState(b, st5)).stale, true);
});
test('core: tab switch with an open comment popup never drops typed text', () => {
  assert.equal(core.tabSwitchPolicy(false, 'x'), 'switch');
  assert.equal(core.tabSwitchPolicy(true, ''), 'close-then-switch');
  assert.equal(core.tabSwitchPolicy(true, '  \n'), 'close-then-switch');
  assert.equal(core.tabSwitchPolicy(true, 'メモ'), 'stay');
});
test('bundle render: consult tabs show 済み / 回答済み instead of 承認済み; popup hint exists', () => {
  const b = mkBundle();
  b.tabs.splice(2, 0, { key: 'consult-room-api', status: 'approved', approvedAt: '2026-10-07', input: clone(consult) });
  const h = html(b);
  assert.ok(h.includes('id="tab-consult-room-api"') && /id="tab-consult-room-api"[\s\S]*?<span class="tab-badge approved">済み<\/span>/.test(h));
  assert.equal((h.match(/class="tab-badge approved">承認済み</g) || []).length, 2);
  const panel = h.match(/<div class="tabpanel"[^>]*id="tp-consult-room-api"[\s\S]*?<\/aside>/)[0];
  assert.ok(panel.includes('回答済み（2026-10-07）') && !panel.includes('承認済み'));
  assert.ok(h.includes('id="popHint"'));
});
