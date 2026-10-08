// review-html renderer: review document JSON -> one self-contained HTML file.
//   node render.mjs --in <file.json> --out <name.html> [--force]
// Input kinds: review-html/doc (generic, profile "consult") and review-html/requirements (adapter -> doc).
// Exit codes: 0 ok, 1 validation/input error (details on stderr), 2 usage/output error.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = createRequire(import.meta.url)('./assets/core.js');
const REQ_KIND = 'review-html/requirements';
const DOC_KIND = 'review-html/doc';
const OUT_RE = /^[A-Za-z0-9._-]+\.html$/;
const MAX_STR = 2000;      // requirements input
const DOC_MAX_STR = 4000;  // generic document
const MAX_SECTIONS = 60;
const MAX_BLOCKS = 600;
const REF_RE = /^[A-Za-z][A-Za-z0-9-]{0,31}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------- requirements input validation ----------
export function validateRequirements(data) {
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
  if (data.kind !== REQ_KIND) err('$.kind', `must be "${REQ_KIND}"`);
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

// ---------- generic document validation ----------
// profiles: which profile values this call accepts (input docs: consult only; adapter output: requirements).
export function validateDoc(data, profiles = ['consult']) {
  const errors = [];
  const warnings = [];
  const refs = new Map();
  let blockCount = 0;
  const err = (p, m) => errors.push(`${p}: ${m}`);
  const known = (o, allowed, p) => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) warnings.push(`${p}.${k}: unknown field (ignored)`);
  };
  const obj = (v, p) => { if (!isObj(v)) { err(p, 'must be an object'); return false; } return true; };
  const str = (o, k, p, required = true) => {
    const v = o[k];
    if (v === undefined) { if (required) err(`${p}.${k}`, 'required'); return; }
    if (typeof v !== 'string' || (required && v.trim() === '')) err(`${p}.${k}`, 'must be a non-empty string');
  };
  const ref = (o, p, required = false) => {
    const v = o.ref;
    if (v === undefined) { if (required) err(`${p}.ref`, 'required'); return; }
    if (typeof v !== 'string' || !REF_RE.test(v)) { err(`${p}.ref`, `must match ${REF_RE}`); return; }
    if (/^b\d+$/.test(v)) { err(`${p}.ref`, `"${v}" is reserved for auto addresses (b1, b2, ...); choose another ref`); return; }
    if (refs.has(v)) err(`${p}.ref`, `duplicate ref "${v}" (also at ${refs.get(v)})`);
    else refs.set(v, `${p}.ref`);
  };

  (function walk(v, p) {
    if (typeof v === 'string') { if (v.length > DOC_MAX_STR) err(p, `string longer than ${DOC_MAX_STR} chars`); }
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (isObj(v)) for (const k of Object.keys(v)) walk(v[k], `${p}.${k}`);
  })(data, '$');

  if (!obj(data, '$')) return { errors, warnings };
  known(data, ['kind', 'version', 'profile', 'docId', 'title', 'project', 'createdAt', 'purpose', 'sections'], '$');
  if (data.kind !== DOC_KIND) err('$.kind', `must be "${DOC_KIND}"`);
  if (data.version !== 1) err('$.version', 'must be 1');
  if (!profiles.includes(data.profile)) err('$.profile', `must be one of ${profiles.map((x) => `"${x}"`).join(', ')}`);
  if (typeof data.docId !== 'string' || !/^[a-z0-9-]{3,64}$/.test(data.docId)) err('$.docId', 'must match [a-z0-9-]{3,64}');
  str(data, 'title', '$');
  str(data, 'project', '$', false);
  str(data, 'purpose', '$', false);
  if (typeof data.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.createdAt)) err('$.createdAt', 'must be YYYY-MM-DD');

  const CONTENT = ['p', 'list', 'table', 'code', 'note'];
  function block(b, p, inCard) {
    blockCount++;
    if (!obj(b, p)) return;
    if (typeof b.type !== 'string') { err(`${p}.type`, 'required'); return; }
    const allowed = inCard ? CONTENT : [...CONTENT, 'card', 'decision'];
    if (!allowed.includes(b.type)) {
      err(`${p}.type`, inCard && ['card', 'decision'].includes(b.type) ? `"${b.type}" is not allowed inside a card` : `unknown block type "${b.type}"`);
      return;
    }
    switch (b.type) {
      case 'p':
        known(b, ['type', 'ref', 'text'], p); ref(b, p); str(b, 'text', p); break;
      case 'note':
        known(b, ['type', 'ref', 'tone', 'text'], p); ref(b, p); str(b, 'text', p);
        if (b.tone !== 'info' && b.tone !== 'warn') err(`${p}.tone`, 'must be "info" or "warn"');
        break;
      case 'code':
        known(b, ['type', 'ref', 'title', 'lang', 'text'], p); ref(b, p); str(b, 'text', p);
        str(b, 'title', p, false); str(b, 'lang', p, false);
        break;
      case 'list': {
        known(b, ['type', 'ref', 'ordered', 'items'], p); ref(b, p);
        if (b.ordered !== undefined && typeof b.ordered !== 'boolean') err(`${p}.ordered`, 'must be boolean');
        if (!Array.isArray(b.items)) { err(`${p}.items`, 'must be an array'); break; }
        if (b.items.length === 0) err(`${p}.items`, 'must not be empty');
        b.items.forEach((it, i) => {
          const ip = `${p}.items[${i}]`;
          if (typeof it === 'string') { if (it.trim() === '') err(ip, 'must be a non-empty string'); return; }
          if (!obj(it, ip)) return;
          known(it, ['text', 'ref', 'sub'], ip); str(it, 'text', ip); ref(it, ip);
          if (it.sub !== undefined) {
            if (!Array.isArray(it.sub)) err(`${ip}.sub`, 'must be an array');
            else it.sub.forEach((x, j) => { if (typeof x !== 'string' || x.trim() === '') err(`${ip}.sub[${j}]`, 'must be a non-empty string'); });
          }
        });
        break;
      }
      case 'table': {
        known(b, ['type', 'ref', 'columns', 'rows'], p); ref(b, p);
        const cols = Array.isArray(b.columns) && b.columns.length > 0 ? b.columns : null;
        if (!cols) err(`${p}.columns`, 'must be a non-empty array');
        else cols.forEach((c, i) => { if (typeof c !== 'string') err(`${p}.columns[${i}]`, 'must be a string'); });
        if (!Array.isArray(b.rows)) { err(`${p}.rows`, 'must be an array'); break; }
        b.rows.forEach((r, i) => {
          const rp = `${p}.rows[${i}]`;
          if (!Array.isArray(r)) { err(rp, 'must be an array'); return; }
          if (cols && r.length !== cols.length) err(rp, `must have ${cols.length} cells (has ${r.length})`);
          r.forEach((c, j) => { if (typeof c !== 'string') err(`${rp}[${j}]`, 'must be a string'); });
        });
        break;
      }
      case 'card':
        known(b, ['type', 'ref', 'title', 'tag', 'blocks'], p); ref(b, p);
        str(b, 'title', p); str(b, 'tag', p, false);
        if (!Array.isArray(b.blocks)) err(`${p}.blocks`, 'must be an array');
        else {
          if (b.blocks.length === 0) err(`${p}.blocks`, 'must not be empty');
          b.blocks.forEach((x, i) => block(x, `${p}.blocks[${i}]`, true));
        }
        break;
      case 'decision': {
        known(b, ['type', 'ref', 'text', 'options', 'recommended'], p); ref(b, p, true); str(b, 'text', p);
        const opts = Array.isArray(b.options) ? b.options : null;
        if (!opts) err(`${p}.options`, 'must be an array');
        else if (opts.length < 2 || opts.length > 5) err(`${p}.options`, 'must have 2 to 5 options');
        const values = new Set();
        (opts || []).forEach((o, j) => {
          const op = `${p}.options[${j}]`;
          if (!obj(o, op)) return;
          known(o, ['value', 'label', 'note'], op);
          if (typeof o.value !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(o.value)) err(`${op}.value`, 'must match ^[a-z0-9_-]{1,32}$');
          else if (values.has(o.value)) err(`${op}.value`, `duplicate option value "${o.value}"`);
          else values.add(o.value);
          str(o, 'label', op); str(o, 'note', op, false);
        });
        if (typeof b.recommended !== 'string' || !values.has(b.recommended)) err(`${p}.recommended`, 'must be one of options[].value');
        break;
      }
    }
  }

  if (!Array.isArray(data.sections)) err('$.sections', 'must be an array');
  else {
    if (data.sections.length === 0) err('$.sections', 'must not be empty');
    if (data.sections.length > MAX_SECTIONS) err('$.sections', `more than ${MAX_SECTIONS} sections`);
    data.sections.forEach((s, i) => {
      const p = `$.sections[${i}]`;
      if (!obj(s, p)) return;
      known(s, ['heading', 'ref', 'blocks'], p);
      str(s, 'heading', p); ref(s, p);
      if (!Array.isArray(s.blocks)) { err(`${p}.blocks`, 'must be an array'); return; }
      if (s.blocks.length === 0) err(`${p}.blocks`, 'must not be empty');
      s.blocks.forEach((b, j) => block(b, `${p}.blocks[${j}]`, false));
    });
  }
  if (blockCount > MAX_BLOCKS) err('$.sections', `more than ${MAX_BLOCKS} blocks in total (has ${blockCount})`);
  return { errors, warnings };
}

// ---------- requirements adapter: requirements input -> generic document ----------
export function requirementsToDoc(d) {
  const none = { type: 'p', text: 'なし' };
  const yn = (b) => (b ? 'はい' : 'いいえ');
  const dn = d.designNeeded;
  const scopeCard = (title, list, fmt) => ({
    type: 'card', title,
    blocks: list.length ? [{ type: 'list', items: list.map((x) => ({ text: fmt(x), ref: x.id })) }] : [none]
  });
  const cats = new Map();
  for (const n of d.nfr) { if (!cats.has(n.category)) cats.set(n.category, []); cats.get(n.category).push(n); }
  const doc = {
    kind: DOC_KIND, version: 1, profile: 'requirements', docId: d.docId, title: d.title,
    createdAt: d.createdAt,
    sections: [
      { heading: '目的', blocks: [{ type: 'p', text: d.goal }] },
      {
        heading: '機能要件',
        blocks: d.stories.map((s) => ({
          type: 'card', ref: s.id, title: `${s.id} ${s.role} として ${s.action}`,
          blocks: [
            { type: 'p', text: `${s.outcome} のため。` },
            ...(s.criteria.length ? [{ type: 'list', items: s.criteria.map((c) => ({ ref: c.id, text: `前提: ${c.given} / 操作: ${c.when} / 結果: ${c.then}` })) }] : [])
          ]
        }))
      },
      {
        heading: '非機能要件',
        blocks: cats.size
          ? [...cats].map(([cat, list]) => ({ type: 'card', title: cat, blocks: [{ type: 'list', items: list.map((n) => ({ ref: n.id, text: n.text })) }] }))
          : [none]
      },
      {
        heading: '範囲',
        blocks: [
          scopeCard('やる', d.scope.in, (x) => x.text),
          scopeCard('やらない（理由）', d.scope.out, (x) => x.text + (x.reason ? `（理由: ${x.reason}）` : '')),
          scopeCard('将来の検討', d.scope.future, (x) => x.text)
        ]
      },
      {
        heading: '設計が必要か',
        blocks: [{
          type: 'table', columns: ['項目', '判定'],
          rows: [
            ['DB スキーマの追加・変更', yn(dn.dbSchema)],
            ['API の新規・変更', yn(dn.api)],
            ['技術スタックの選定・変更', yn(dn.techStack)],
            ['システム境界・データの流れの変更', yn(dn.boundary)],
            ['設計が必要', dn.value ? '必要' : '不要']
          ]
        }]
      },
      { heading: 'リスク', blocks: d.risks.length ? [{ type: 'list', items: d.risks.map((r) => ({ ref: r.id, text: r.text })) }] : [none] },
      {
        heading: '未決事項',
        blocks: d.questions.length
          ? d.questions.map((q) => ({
            type: 'decision', ref: q.id, text: q.text, recommended: q.recommended,
            options: q.options.map((o) => ({ value: o.value, label: o.label, ...(o.note ? { note: o.note } : {}) }))
          }))
          : [none]
      }
    ]
  };
  if (d.project) doc.project = d.project;
  return doc;
}

// Dispatch on kind. Returns { errors, warnings, doc } where doc is the generic document to render.
export function prepare(data) {
  if (isObj(data) && data.kind === REQ_KIND) {
    const r = validateRequirements(data);
    if (r.errors.length) return { ...r, doc: null };
    const doc = requirementsToDoc(data);
    const g = validateDoc(doc, ['requirements']); // internal consistency check of the adapter output
    if (g.errors.length) return { errors: g.errors.map((e) => `adapter: ${e}`), warnings: r.warnings, doc: null };
    return { errors: [], warnings: r.warnings, doc };
  }
  const g = validateDoc(data, ['consult']);
  return { ...g, doc: g.errors.length ? null : data };
}

// ---------- rendering ----------
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// JSON safe inside <script type="application/json">: no raw "<" and no JS line separators.
export function safeJson(data) {
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function readAsset(name) {
  const t = fs.readFileSync(path.join(here, 'assets', name), 'utf8');
  if (/<\/script/i.test(t) || /<\/style/i.test(t)) throw new Error(`asset ${name} contains a closing tag`);
  return t;
}

export function renderHtml(d) {
  let auto = 0;
  let heading = '';
  // Address attributes for one text-bearing element: the block's ref, else b1, b2, ... in document order.
  const A = (ref) => {
    const addr = ref ?? `b${++auto}`;
    return `data-addr="${esc(addr)}" data-label="${esc(heading + (ref ? ` ${ref}` : ''))}"`;
  };
  const refAttr = (b) => (b.ref ? ` data-ref="${esc(b.ref)}"` : '');

  function list(b) {
    const tag = b.ordered ? 'ol' : 'ul';
    let h = `<${tag} class="plain"${refAttr(b)}>`;
    for (const it of b.items) {
      const o = typeof it === 'string' ? { text: it } : it;
      h += `<li><span ${A(o.ref)}>${esc(o.text)}</span>`;
      if (o.sub && o.sub.length) h += '<ul class="plain">' + o.sub.map((x) => `<li><span ${A()}>${esc(x)}</span></li>`).join('') + '</ul>';
      h += '</li>';
    }
    return h + `</${tag}>`;
  }
  function table(b) {
    let h = `<div class="tablewrap"><table${refAttr(b)}><thead><tr>`;
    h += b.columns.map((c) => `<th ${A()}>${esc(c)}</th>`).join('') + '</tr></thead><tbody>';
    for (const r of b.rows) h += '<tr>' + r.map((c) => `<td ${A()}>${esc(c)}</td>`).join('') + '</tr>';
    return h + '</tbody></table></div>';
  }
  function code(b) {
    return `<figure class="code"${b.lang ? ` data-lang="${esc(b.lang)}"` : ''}>` +
      (b.title ? `<figcaption>${esc(b.title)}</figcaption>` : '') +
      `<pre ${A(b.ref)}>${esc(b.text)}</pre></figure>`;
  }
  function inner(b) {
    switch (b.type) {
      case 'p': return `<p ${A(b.ref)}>${esc(b.text)}</p>`;
      case 'list': return list(b);
      case 'table': return table(b);
      case 'code': return code(b);
      case 'note': return `<p class="note tone-${b.tone}" ${A(b.ref)}>${esc(b.text)}</p>`;
      default: throw new Error(`unknown block ${b.type}`);
    }
  }
  function render(b) {
    if (b.type === 'card') {
      return '<div class="card"><div class="card-head">' +
        `<h3 ${A(b.ref)}>${esc(b.title)}</h3>` + (b.tag ? `<span class="tag">${esc(b.tag)}</span>` : '') + '</div>' +
        b.blocks.map(inner).join('') + '</div>';
    }
    if (b.type === 'decision') {
      let h = `<div class="card dcard" data-decision="${esc(b.ref)}"><span class="chip" data-chip="${esc(b.ref)}">未確認</span>` +
        `<p class="q" ${A(b.ref)}>${esc(b.text)}</p>`;
      for (const op of b.options) {
        const rec = op.value === b.recommended;
        h += `<label class="opt"><input type="radio" name="d-${esc(b.ref)}" value="${esc(op.value)}"${rec ? ' checked' : ''}>` +
          `<span class="optbody"><span ${A()}>${esc(op.label)}</span>` +
          (rec ? '<span class="rec">推奨</span>' : '') +
          (op.note ? `<span class="optnote">${esc(op.note)}</span>` : '') + '</span></label>';
      }
      return h + '</div>';
    }
    return inner(b);
  }

  const body = [];
  for (const s of d.sections) {
    heading = s.heading;
    body.push(`<section><h2 ${A(s.ref)}>${esc(s.heading)}</h2>`);
    for (const b of s.blocks) body.push(render(b));
    body.push('</section>');
  }

  const verdicts = core.PROFILES[d.profile].verdicts
    .map((v) => `<label class="vopt"><input type="radio" name="verdict" value="${esc(v.value)}"><span>${esc(v.label)}</span></label>`).join('\n      ');

  // Hash of the exact embedded JSON text: page.js uses it to drop autosave from an older revision.
  const dataJson = safeJson(d);
  const contentHash = crypto.createHash('sha256').update(dataJson).digest('hex');
  const title = esc(d.title);
  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="review-content-hash" content="${contentHash}">
<title>${title}</title>
<style>
${readAsset('page.css')}
</style>
</head>
<body>
<div class="page">
<div class="layout">
<main id="content">
<header>
<h1>${title}</h1>
<p class="meta">${d.project ? esc(d.project) + ' / ' : ''}${esc(d.createdAt)}</p>
${d.purpose ? `<p class="purpose">${esc(d.purpose)}</p>` : ''}
<p class="staleinfo" id="stalenote" hidden>内容が更新されたので、前回の入力は引き継いでいません。</p>
</header>
${body.join('\n')}
<footer class="page-foot">本文の一部を選択するとコメントを付けられます。入力はこのブラウザに自動保存されます。</footer>
</main>
<aside class="panel" id="panel" aria-label="コメント一覧">
  <div class="panel-head">
    <h2 class="panel-title">コメント<span id="panelCount">0 件</span></h2>
    <button type="button" class="x" id="panelClose" aria-label="一覧を閉じる">×</button>
  </div>
  <div class="panel-body" id="panelBody"></div>
</aside>
</div>
</div>

<div class="warn-pill" id="storewarn" role="status" hidden><span>この環境では自動保存が効きません</span><button type="button" class="x" id="storewarnClose" aria-label="閉じる">×</button></div>

<button type="button" class="add" id="addBtn" hidden><svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5h10a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H8.2L5 13.8V11H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>コメントを追加</button>
<div class="sel-hint" id="selHint" role="status" hidden>1 つの段落の中で選んでください</div>

<div class="pop" id="pop" role="dialog" aria-label="コメントを追加" hidden>
  <p class="pop-quote" id="popQuote"></p>
  <textarea id="popTa" maxlength="4000" rows="3" placeholder="コメントを入力" aria-label="コメント"></textarea>
  <div class="pop-foot">
    <span class="pop-key">Ctrl / ⌘ + Enter で保存</span>
    <div class="pop-btns">
      <button type="button" class="btn sm" id="popCancel">キャンセル</button>
      <button type="button" class="btn sm primary" id="popSave" disabled>保存</button>
    </div>
  </div>
</div>

<div class="scrim" id="scrim" hidden>
  <section class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlgTitle">
    <div class="dlg-head">
      <h2 class="dlg-title" id="dlgTitle" tabindex="-1">回答する</h2>
      <button type="button" class="x" id="dlgClose" aria-label="閉じる">×</button>
    </div>
    <fieldset>
      <legend class="field-label first">この資料への判断</legend>
      ${verdicts}
    </fieldset>
    <label class="field-label" for="noteTa">全体へのひとこと（任意）</label>
    <textarea id="noteTa" maxlength="4000" rows="3"></textarea>
    <p class="dlg-count" id="sendCount">コメント 0 件も一緒に送ります</p>
    <div class="fallback" id="fallback" hidden>
      <textarea id="fallbackTa" readonly aria-label="送信内容"></textarea>
    </div>
    <div class="dlg-foot">
      <p class="status" id="status" role="status" aria-live="polite"></p>
      <button type="button" class="btn primary" id="sendBtn" disabled>送信</button>
    </div>
  </section>
</div>

<div class="bar" id="bar">
  <div class="bar-in">
    <div class="bar-hint">本文を選択するとコメントを付けられます</div>
    <div class="bar-btns">
      <button type="button" class="btn" id="listBtn" aria-expanded="false"><span id="barCount">コメント一覧（0）</span></button>
      <button type="button" class="btn primary" id="answerBtn">回答する</button>
    </div>
  </div>
</div>

<script type="application/json" id="review-data">${dataJson}</script>
<script>
${readAsset('core.js')}
</script>
<script>
${readAsset('page.js')}
</script>
</body>
</html>
`;
  const seen = new Set();
  for (const m of html.matchAll(/data-addr="([^"]*)"/g)) {
    if (seen.has(m[1])) throw new Error(`duplicate data-addr "${m[1]}" in rendered output`);
    seen.add(m[1]);
  }
  return html;
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
  const { errors, warnings, doc } = prepare(data);
  for (const w of warnings) process.stderr.write(`warning ${w}\n`);
  if (errors.length) { for (const e of errors) process.stderr.write(e + '\n'); return 1; }
  let html;
  try { html = renderHtml(doc); }
  catch (e) { process.stderr.write(`render error: ${e.message}\n`); return 1; }
  try {
    fs.mkdirSync(path.dirname(path.resolve(vals.out)), { recursive: true });
    fs.writeFileSync(vals.out, html, { flag: force ? 'w' : 'wx' });
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
