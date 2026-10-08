// gate-html renderer: Requirements Summary JSON -> one self-contained HTML file.
//   node render.mjs --in <file.json> --out <name.html> [--force]
// Exit codes: 0 ok, 1 validation/input error (details on stderr), 2 usage/output error.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const KIND = 'gate-html/requirements';
const OUT_RE = /^[A-Za-z0-9._-]+\.html$/;
const MAX_STR = 2000;

// ---------- validation ----------
export function validate(data) {
  const errors = [];
  const warnings = [];
  const ids = new Map(); // id -> path
  const err = (p, m) => errors.push(`${p}: ${m}`);
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  const str = (o, k, p, required = true) => {
    const v = o[k];
    if (v === undefined) { if (required) err(`${p}.${k}`, 'required'); return; }
    if (typeof v !== 'string' || (required && v.trim() === '')) err(`${p}.${k}`, 'must be a non-empty string');
  };
  const arr = (o, k, p, required = true) => {
    const v = o[k];
    if (v === undefined) { if (required) err(`${p}.${k}`, 'required'); return []; }
    if (!Array.isArray(v)) { err(`${p}.${k}`, 'must be an array'); return []; }
    return v;
  };
  const id = (o, p, re, what) => {
    const v = o.id;
    if (typeof v !== 'string' || !re.test(v)) { err(`${p}.id`, `must match ${what}`); return; }
    if (ids.has(v)) err(`${p}.id`, `duplicate id "${v}" (also at ${ids.get(v)})`);
    else ids.set(v, `${p}.id`);
  };
  const known = (o, allowed, p) => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) warnings.push(`${p}.${k}: unknown field (ignored)`);
  };
  const obj = (v, p) => { if (!isObj(v)) { err(p, 'must be an object'); return false; } return true; };

  // Over-long strings anywhere.
  (function walk(v, p) {
    if (typeof v === 'string') { if (v.length > MAX_STR) err(p, `string longer than ${MAX_STR} chars`); }
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (isObj(v)) for (const k of Object.keys(v)) walk(v[k], `${p}.${k}`);
  })(data, '$');

  if (!obj(data, '$')) return { errors, warnings };
  known(data, ['kind', 'version', 'docId', 'title', 'project', 'createdAt', 'goal', 'stories', 'nfr', 'scope', 'designNeeded', 'risks', 'questions'], '$');
  if (data.kind !== KIND) err('$.kind', `must be "${KIND}"`);
  if (data.version !== 1) err('$.version', 'must be 1');
  if (typeof data.docId !== 'string' || !/^[a-z0-9-]{3,64}$/.test(data.docId)) err('$.docId', 'must match [a-z0-9-]{3,64}');
  str(data, 'title', '$');
  str(data, 'project', '$', false);
  if (typeof data.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.createdAt)) err('$.createdAt', 'must be YYYY-MM-DD');
  str(data, 'goal', '$');

  const stories = arr(data, 'stories', '$');
  if (Array.isArray(data.stories) && stories.length === 0) err('$.stories', 'must not be empty');
  stories.forEach((s, i) => {
    const p = `$.stories[${i}]`;
    if (!obj(s, p)) return;
    known(s, ['id', 'role', 'action', 'outcome', 'criteria'], p);
    id(s, p, /^S[0-9]+$/, '^S[0-9]+$');
    ['role', 'action', 'outcome'].forEach((k) => str(s, k, p));
    arr(s, 'criteria', p).forEach((c, j) => {
      const cp = `${p}.criteria[${j}]`;
      if (!obj(c, cp)) return;
      known(c, ['id', 'given', 'when', 'then'], cp);
      id(c, cp, /^S[0-9]+-AC[0-9]+$/, '^S[0-9]+-AC[0-9]+$');
      ['given', 'when', 'then'].forEach((k) => str(c, k, cp));
    });
  });

  arr(data, 'nfr', '$').forEach((n, i) => {
    const p = `$.nfr[${i}]`;
    if (!obj(n, p)) return;
    known(n, ['id', 'category', 'text'], p);
    id(n, p, /^N[0-9]+$/, '^N[0-9]+$');
    str(n, 'category', p); str(n, 'text', p);
  });

  if (data.scope === undefined) err('$.scope', 'required');
  else if (obj(data.scope, '$.scope')) {
    known(data.scope, ['in', 'out', 'future'], '$.scope');
    const spec = { in: [/^IN[0-9]+$/, '^IN[0-9]+$'], out: [/^OUT[0-9]+$/, '^OUT[0-9]+$'], future: [/^FU[0-9]+$/, '^FU[0-9]+$'] };
    for (const key of Object.keys(spec)) {
      arr(data.scope, key, '$.scope').forEach((x, i) => {
        const p = `$.scope.${key}[${i}]`;
        if (!obj(x, p)) return;
        known(x, key === 'out' ? ['id', 'text', 'reason'] : ['id', 'text'], p);
        id(x, p, spec[key][0], spec[key][1]);
        str(x, 'text', p);
        if (key === 'out') str(x, 'reason', p, false);
      });
    }
  }

  if (data.designNeeded === undefined) err('$.designNeeded', 'required');
  else if (obj(data.designNeeded, '$.designNeeded')) {
    known(data.designNeeded, ['dbSchema', 'api', 'techStack', 'boundary', 'value'], '$.designNeeded');
    for (const k of ['dbSchema', 'api', 'techStack', 'boundary', 'value']) {
      if (typeof data.designNeeded[k] !== 'boolean') err(`$.designNeeded.${k}`, 'must be boolean');
    }
  }

  arr(data, 'risks', '$').forEach((r, i) => {
    const p = `$.risks[${i}]`;
    if (!obj(r, p)) return;
    known(r, ['id', 'text'], p);
    id(r, p, /^R[0-9]+$/, '^R[0-9]+$');
    str(r, 'text', p);
  });

  arr(data, 'questions', '$').forEach((q, i) => {
    const p = `$.questions[${i}]`;
    if (!obj(q, p)) return;
    known(q, ['id', 'text', 'options', 'recommended'], p);
    id(q, p, /^Q[0-9]+$/, '^Q[0-9]+$');
    str(q, 'text', p);
    const opts = arr(q, 'options', p);
    if (Array.isArray(q.options) && (opts.length < 2 || opts.length > 5)) err(`${p}.options`, 'must have 2 to 5 options');
    const values = new Set();
    opts.forEach((o, j) => {
      const op = `${p}.options[${j}]`;
      if (!obj(o, op)) return;
      known(o, ['value', 'label', 'note'], op);
      if (typeof o.value !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(o.value)) err(`${op}.value`, 'must match ^[a-z0-9_-]{1,32}$');
      else if (values.has(o.value)) err(`${op}.value`, `duplicate option value "${o.value}"`);
      else values.add(o.value);
      str(o, 'label', op); str(o, 'note', op, false);
    });
    if (typeof q.recommended !== 'string' || !values.has(q.recommended)) err(`${p}.recommended`, 'must be one of options[].value');
  });

  return { errors, warnings };
}

// ---------- rendering ----------
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// JSON safe inside <script type="application/json">: no raw "<" and no JS line separators.
export function safeJson(data) {
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

// Wraps content with an always-visible comment button and a slot for saved comments.
const item = (addr, inner, cls = 'item') =>
  `<div class="${cls}" data-addr="${esc(addr)}">${inner}` +
  `<div><button type="button" class="cbtn" data-addr="${esc(addr)}">コメント</button></div>` +
  `<div class="cslot" data-addr="${esc(addr)}"></div></div>`;

function readAsset(name) {
  const t = fs.readFileSync(path.join(here, 'assets', name), 'utf8');
  if (/<\/script/i.test(t) || /<\/style/i.test(t)) throw new Error(`asset ${name} contains a closing tag`);
  return t;
}

export function renderHtml(d) {
  const out = [];
  const o = (s) => out.push(s);

  o(`<header><h1>${esc(d.title)}</h1><p class="meta">${d.project ? esc(d.project) + ' / ' : ''}${esc(d.createdAt)}</p>`);
  o('<p>要件の確認画面です。判断に答え、気になる所にコメントを付けて、最後に答え方を選んで送信してください。</p>');
  o('<p class="warnbar" id="storewarn" hidden>この環境では自動保存が効きません</p>');
  o('<p class="sub" id="stalenote" hidden>内容が更新されたので、前回の入力は引き継いでいません。</p></header>');

  o('<h2>目的</h2>');
  o(`<div class="card">${item('goal', `<p>${esc(d.goal)}</p>`)}</div>`);

  o('<h2>機能要件</h2>');
  for (const s of d.stories) {
    let h = `<h3>${esc(s.id)}</h3>` + item(`story:${s.id}`, `<p>${esc(s.role)} として ${esc(s.action)}。${esc(s.outcome)} のため。</p>`);
    if (s.criteria.length) {
      h += '<ul class="plain">';
      for (const c of s.criteria) {
        h += '<li>' + item(`criterion:${c.id}`,
          `<strong>${esc(c.id)}</strong><div class="ac">前提: ${esc(c.given)}<br>操作: ${esc(c.when)}<br>結果: ${esc(c.then)}</div>`) + '</li>';
      }
      h += '</ul>';
    }
    o(`<div class="card">${h}</div>`);
  }

  o('<h2>非機能要件</h2>');
  const cats = new Map();
  for (const n of d.nfr) { if (!cats.has(n.category)) cats.set(n.category, []); cats.get(n.category).push(n); }
  if (!cats.size) o('<p class="sub">なし</p>');
  for (const [cat, list] of cats) {
    o(`<div class="card"><h3>${esc(cat)}</h3>` + list.map((n) => item(`nfr:${n.id}`, `<p><strong>${esc(n.id)}</strong> ${esc(n.text)}</p>`)).join('') + '</div>');
  }

  o('<h2>範囲</h2><div class="card">');
  const scopeBlock = (title, list, fmt) => {
    o(`<h3>${title}</h3>`);
    if (!list.length) o('<p class="sub">なし</p>');
    for (const x of list) o(item(`scope:${x.id}`, `<p><strong>${esc(x.id)}</strong> ${fmt(x)}</p>`));
  };
  scopeBlock('やる', d.scope.in, (x) => esc(x.text));
  scopeBlock('やらない（理由）', d.scope.out, (x) => esc(x.text) + (x.reason ? `（理由: ${esc(x.reason)}）` : ''));
  scopeBlock('将来の検討', d.scope.future, (x) => esc(x.text));
  o('</div>');

  o('<h2>設計が必要か</h2>');
  const yn = (b) => (b ? 'はい' : 'いいえ');
  const dn = d.designNeeded;
  o('<div class="card">' + item('design',
    '<table class="design">' +
    `<tr><td>DB スキーマの追加・変更</td><td>${yn(dn.dbSchema)}</td></tr>` +
    `<tr><td>API の新規・変更</td><td>${yn(dn.api)}</td></tr>` +
    `<tr><td>技術スタックの選定・変更</td><td>${yn(dn.techStack)}</td></tr>` +
    `<tr><td>システム境界・データの流れの変更</td><td>${yn(dn.boundary)}</td></tr>` +
    `<tr><td><strong>設計が必要</strong></td><td><strong>${dn.value ? '必要' : '不要'}</strong></td></tr></table>`) + '</div>');

  o('<h2>リスク</h2>');
  if (!d.risks.length) o('<p class="sub">なし</p>');
  else o('<div class="card">' + d.risks.map((r) => item(`risk:${r.id}`, `<p><strong>${esc(r.id)}</strong> ${esc(r.text)}</p>`)).join('') + '</div>');

  o('<h2>未決事項</h2>');
  if (!d.questions.length) o('<p class="sub">なし</p>');
  for (const q of d.questions) {
    let h = `<span class="chip" data-chip="${esc(q.id)}">未確認</span><h3>${esc(q.id)}</h3><p>${esc(q.text)}</p>`;
    for (const op of q.options) {
      const rec = op.value === q.recommended;
      h += `<label class="opt"><input type="radio" name="q-${esc(q.id)}" value="${esc(op.value)}"${rec ? ' checked' : ''}>` +
        `<span>${esc(op.label)}${rec ? '<span class="tag">推奨</span>' : ''}` +
        (op.note ? `<span class="note">${esc(op.note)}</span>` : '') + '</span></label>';
    }
    o('<div class="card qcard">' + item(`question:${q.id}`, h) + '</div>');
  }

  o('<h2>答え方</h2><div class="card">');
  for (const [v, t] of [['approve', 'この内容でよい'], ['revise', '直してほしい'], ['rescope', '範囲を変える'], ['abort', '中止する']]) {
    o(`<label class="opt"><input type="radio" name="verdict" value="${v}"><span>${t}</span></label>`);
  }
  o('<label for="note"><strong>全体へのひとこと（任意）</strong></label><textarea id="note" maxlength="4000"></textarea></div>');

  o('<p id="ccount" class="sub">コメント 0 件</p>');
  o('<button type="button" class="primary" id="send" disabled>送信</button>');
  o('<div id="msg" role="status" aria-live="polite"></div>');
  o('<textarea id="manual" readonly hidden aria-label="コピー用の回答"></textarea>');

  const body = out.join('\n');
  // Hash of the exact embedded JSON text: page.js uses it to drop autosave from an older revision.
  const dataJson = safeJson(d);
  const contentHash = crypto.createHash('sha256').update(dataJson).digest('hex');
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="gate-content-hash" content="${contentHash}">
<title>${esc(d.title)}</title>
<style>
${readAsset('page.css')}
</style>
</head>
<body>
<main>
${body}
</main>
<script type="application/json" id="gate-data">${dataJson}</script>
<script>
${readAsset('core.js')}
</script>
<script>
${readAsset('page.js')}
</script>
</body>
</html>
`;
}

// ---------- CLI ----------
function cli(argv) {
  const vals = {};
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--force') force = true;
    else if (argv[i].startsWith('--')) { vals[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  if (!vals.in || !vals.out) { process.stderr.write('usage: render.mjs --in <file.json> --out <name.html> [--force]\n'); return 2; }
  if (!OUT_RE.test(path.basename(vals.out))) {
    process.stderr.write('--out filename must match ^[A-Za-z0-9._-]+\\.html$\n');
    return 2;
  }
  let data;
  try { data = JSON.parse(fs.readFileSync(vals.in, 'utf8')); }
  catch (e) { process.stderr.write(`$: cannot read/parse input JSON (${e.message})\n`); return 1; }
  const { errors, warnings } = validate(data);
  for (const w of warnings) process.stderr.write(`warning ${w}\n`);
  if (errors.length) { for (const e of errors) process.stderr.write(e + '\n'); return 1; }
  try {
    fs.mkdirSync(path.dirname(path.resolve(vals.out)), { recursive: true });
    fs.writeFileSync(vals.out, renderHtml(data), { flag: force ? 'w' : 'wx' });
  }
  catch (e) {
    process.stderr.write(e.code === 'EEXIST' ? `refusing to overwrite ${vals.out} (use --force)\n` : `cannot write ${vals.out}: ${e.message}\n`);
    return 2;
  }
  process.stdout.write(`WROTE ${vals.out}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(cli(process.argv.slice(2)));
}
