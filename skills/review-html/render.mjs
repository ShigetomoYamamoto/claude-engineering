// review-html renderer: review document JSON -> one self-contained HTML file.
//   node render.mjs --in <file.json> --out <name.html> [--force]
// Input kinds: review-html/doc (generic, profile "consult") and the adapters review-html/requirements,
// review-html/design and review-html/plan (each converted in memory to a generic doc).
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
const DESIGN_KIND = 'review-html/design';
const PLAN_KIND = 'review-html/plan';
const BUNDLE_KIND = 'review-html/bundle';
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
      else if (o.value === core.OTHER_VALUE) err(`${op}.value`, `"${core.OTHER_VALUE}" is reserved (the page adds 「${core.OTHER_LABEL}」 itself)`);
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
    if (/^[bg]\d+$/.test(v)) { err(`${p}.ref`, `"${v}" is reserved for auto addresses (b1, b2, ... and g1, g2, ...); choose another ref`); return; }
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
  str(data, 'purpose', '$', data.profile === 'consult'); // the box under the title says what is being confirmed
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
        known(b, ['type', 'ref', 'text', 'variant'], p); ref(b, p); str(b, 'text', p);
        if (b.variant !== undefined && b.variant !== 'label') err(`${p}.variant`, 'must be "label"');
        break;
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
          let cells = r, cp = rp;
          if (isObj(r)) { // row with its own address: { ref, cells: [...] }
            known(r, ['ref', 'cells'], rp); ref(r, rp, true);
            cells = r.cells; cp = `${rp}.cells`;
          }
          if (!Array.isArray(cells)) { err(cp, 'must be an array'); return; }
          if (cols && cells.length !== cols.length) err(cp, `must have ${cols.length} cells (has ${cells.length})`);
          cells.forEach((c, j) => { if (typeof c !== 'string') err(`${cp}[${j}]`, 'must be a string'); });
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
          else if (o.value === core.OTHER_VALUE) err(`${op}.value`, `"${core.OTHER_VALUE}" is reserved (the page adds 「${core.OTHER_LABEL}」 itself)`);
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
          type: 'card', ref: s.id, title: `${s.id} ${s.action}`,
          blocks: [
            { type: 'list', items: [{ text: `誰が: ${s.role}` }, { text: `ねらい: ${s.outcome}` }] },
            ...(s.criteria.length ? [{ type: 'p', variant: 'label', text: '受け入れ条件' }, { type: 'list', items: s.criteria.map((c) => ({ ref: c.id, text: `前提: ${c.given} / 操作: ${c.when} / 結果: ${c.then}` })) }] : [])
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

// ---------- design / plan input validation (shared helpers) ----------
const OPT_VALUE_RE = /^[a-z0-9_-]{1,32}$/;
function makeCheck() {
  const errors = [];
  const warnings = [];
  const ids = new Map();
  const err = (p, m) => errors.push(`${p}: ${m}`);
  const c = {
    errors, warnings, err,
    obj: (v, p) => { if (!isObj(v)) { err(p, 'must be an object'); return false; } return true; },
    known: (o, allowed, p, strict = true) => {
      for (const k of Object.keys(o)) {
        if (allowed.includes(k)) continue;
        if (strict) err(`${p}.${k}`, `unknown field (allowed: ${allowed.join(', ')})`);
        else warnings.push(`${p}.${k}: unknown field (ignored)`);
      }
    },
    // Composed text (what the page will actually show) must stay within the string limit; report at the input path.
    fits: (text, p, what) => { if (text.length > DOC_MAX_STR) err(p, `${what} is ${text.length} chars when composed; at most ${DOC_MAX_STR}`); },
    str: (o, k, p, required = true) => {
      const v = o[k];
      if (v === undefined) { if (required) err(`${p}.${k}`, 'required'); return; }
      if (typeof v !== 'string' || (required && v.trim() === '')) err(`${p}.${k}`, 'must be a non-empty string');
    },
    arr: (o, k, p, required = true) => {
      const v = o[k];
      if (v === undefined) { if (required) err(`${p}.${k}`, 'required'); return []; }
      if (!Array.isArray(v)) { err(`${p}.${k}`, 'must be an array'); return []; }
      return v;
    },
    id: (o, p, re, what) => {
      const v = o.id;
      if (typeof v !== 'string' || !re.test(v)) { err(`${p}.id`, `must match ${what}`); return false; }
      if (ids.has(v)) { err(`${p}.id`, `duplicate id "${v}" (also at ${ids.get(v)})`); return false; }
      ids.set(v, `${p}.id`);
      return true;
    },
    header(data, kind, allowedKeys) {
      (function walk(v, p) {
        if (typeof v === 'string') { if (v.length > DOC_MAX_STR) err(p, `string longer than ${DOC_MAX_STR} chars`); }
        else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
        else if (isObj(v)) for (const k of Object.keys(v)) walk(v[k], `${p}.${k}`);
      })(data, '$');
      if (!c.obj(data, '$')) return false;
      c.known(data, allowedKeys, '$', false);
      if (data.kind !== kind) err('$.kind', `must be "${kind}"`);
      if (data.version !== 1) err('$.version', 'must be 1');
      if (typeof data.docId !== 'string' || !/^[a-z0-9-]{3,64}$/.test(data.docId)) err('$.docId', 'must match [a-z0-9-]{3,64}');
      c.str(data, 'title', '$');
      c.str(data, 'project', '$', false);
      if (typeof data.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.createdAt)) err('$.createdAt', 'must be YYYY-MM-DD');
      return true;
    },
    // A decision / question: id, text, options (2-5), recommended, reason. `extra` = option fields besides value/label.
    decision(q, p, idRe, idWhat, extra, noteOf) {
      c.known(q, ['id', 'text', 'options', 'recommended', 'reason'], p);
      c.id(q, p, idRe, idWhat);
      c.str(q, 'text', p);
      c.str(q, 'reason', p);
      const opts = c.arr(q, 'options', p);
      if (Array.isArray(q.options) && (opts.length < 2 || opts.length > 5)) err(`${p}.options`, 'must have 2 to 5 options');
      const values = new Set();
      opts.forEach((o, j) => {
        const op = `${p}.options[${j}]`;
        if (!c.obj(o, op)) return;
        c.known(o, ['value', 'label', ...extra], op);
        if (typeof o.value !== 'string' || !OPT_VALUE_RE.test(o.value)) err(`${op}.value`, 'must match ^[a-z0-9_-]{1,32}$');
        else if (o.value === core.OTHER_VALUE) err(`${op}.value`, `"${core.OTHER_VALUE}" is reserved (the page adds 「${core.OTHER_LABEL}」 itself)`);
        else if (values.has(o.value)) err(`${op}.value`, `duplicate option value "${o.value}"`);
        else values.add(o.value);
        c.str(o, 'label', op);
        for (const k of extra) c.str(o, k, op, false);
      });
      if (typeof q.recommended !== 'string' || !values.has(q.recommended)) err(`${p}.recommended`, 'must be one of options[].value');
      opts.forEach((o, j) => {
        if (!isObj(o) || ![...extra, 'label'].every((k) => o[k] === undefined || typeof o[k] === 'string') || typeof q.reason !== 'string') return;
        c.fits(composeNote(o, q, noteOf), `${p}.options[${j}]`, 'option note');
      });
    },
    risks(data) {
      c.arr(data, 'risks', '$').forEach((r, i) => {
        const p = `$.risks[${i}]`;
        if (!c.obj(r, p)) return;
        c.known(r, ['id', 'text', 'mitigation'], p);
        c.id(r, p, /^R[0-9]{1,6}$/, '^R[0-9]{1,6}$');
        c.str(r, 'text', p); c.str(r, 'mitigation', p);
        if (typeof r.text === 'string' && typeof r.mitigation === 'string') c.fits(riskText(r), p, 'risk text');
      });
    }
  };
  return c;
}

// ---------- composed texts (shared by validation and the adapters) ----------
const stripDot = (s) => s.replace(/。+$/, '');
const designNote = (o) => [o.pros ? `良い点: ${o.pros}` : '', o.cons ? `気になる点: ${o.cons}` : ''].filter(Boolean).join(' / ');
const planNote = (o) => o.note || '';
function composeNote(o, q, noteOf) {
  const note = noteOf(o);
  return o.value === q.recommended ? `${note}（推奨の理由: ${q.reason}）` : note;
}
const riskText = (r) => `${r.text}（対策: ${r.mitigation}）`;
const cardTitle = (x) => `${x.id} ${x.name}`;
const RISK_JA = { low: '低', medium: '中', high: '高' };
const stepLine = (s) => `${s.id} ${s.name}（${s.file}）: ${stripDot(s.action)}。理由: ${stripDot(s.why)}。依存: ${s.dependsOn && s.dependsOn.length ? s.dependsOn.join('・') : 'なし'}。リスク: ${RISK_JA[s.risk]}`;

// ---------- design input validation ----------
export function validateDesign(data) {
  const c = makeCheck();
  const { err } = c;
  if (!c.header(data, DESIGN_KIND, ['kind', 'version', 'docId', 'title', 'project', 'createdAt', 'basis', 'components', 'dataModel', 'apis', 'integration', 'decisions', 'risks'])) return { errors: c.errors, warnings: c.warnings };

  const seenBasis = new Set();
  c.arr(data, 'basis', '$').forEach((b, i) => {
    if (typeof b !== 'string' || !/^(S[0-9]{1,6}(-AC[0-9]{1,6})?|N[0-9]{1,6})$/.test(b)) err(`$.basis[${i}]`, 'must match ^(S[0-9]{1,6}(-AC[0-9]{1,6})?|N[0-9]{1,6})$');
    else if (seenBasis.has(b)) err(`$.basis[${i}]`, `duplicate basis "${b}"`);
    else seenBasis.add(b);
  });
  const comps = c.arr(data, 'components', '$');
  if (Array.isArray(data.components) && comps.length === 0) err('$.components', 'must not be empty');
  comps.forEach((x, i) => {
    const p = `$.components[${i}]`;
    if (!c.obj(x, p)) return;
    c.known(x, ['id', 'name', 'responsibility'], p);
    c.id(x, p, /^C[0-9]{1,6}$/, '^C[0-9]{1,6}$'); c.str(x, 'name', p); c.str(x, 'responsibility', p);
    if (typeof x.id === 'string' && typeof x.name === 'string') c.fits(cardTitle(x), `${p}.name`, 'card title');
  });
  const codeObj = (o, k, p) => {
    if (o[k] === undefined) return;
    const cp = `${p}.${k}`;
    if (!c.obj(o[k], cp)) return;
    c.known(o[k], ['lang', 'text'], cp);
    c.str(o[k], 'lang', cp); c.str(o[k], 'text', cp);
  };
  c.arr(data, 'dataModel', '$').forEach((x, i) => {
    const p = `$.dataModel[${i}]`;
    if (!c.obj(x, p)) return;
    c.known(x, ['id', 'name', 'purpose', 'schema'], p);
    c.id(x, p, /^M[0-9]{1,6}$/, '^M[0-9]{1,6}$'); c.str(x, 'name', p); c.str(x, 'purpose', p);
    if (typeof x.id === 'string' && typeof x.name === 'string') c.fits(cardTitle(x), `${p}.name`, 'card title');
    codeObj(x, 'schema', p);
  });
  c.arr(data, 'apis', '$').forEach((x, i) => {
    const p = `$.apis[${i}]`;
    if (!c.obj(x, p)) return;
    c.known(x, ['id', 'name', 'purpose', 'shape'], p);
    c.id(x, p, /^A[0-9]{1,6}$/, '^A[0-9]{1,6}$'); c.str(x, 'name', p); c.str(x, 'purpose', p);
    if (typeof x.id === 'string' && typeof x.name === 'string') c.fits(cardTitle(x), `${p}.name`, 'card title');
    codeObj(x, 'shape', p);
  });
  c.arr(data, 'integration', '$').forEach((x, i) => {
    const p = `$.integration[${i}]`;
    if (!c.obj(x, p)) return;
    c.known(x, ['id', 'text'], p);
    c.id(x, p, /^I[0-9]{1,6}$/, '^I[0-9]{1,6}$'); c.str(x, 'text', p);
  });
  c.arr(data, 'decisions', '$').forEach((q, i) => {
    const p = `$.decisions[${i}]`;
    if (c.obj(q, p)) c.decision(q, p, /^D[0-9]{1,6}$/, '^D[0-9]{1,6}$', ['pros', 'cons'], designNote);
  });
  c.risks(data);
  return { errors: c.errors, warnings: c.warnings };
}

// ---------- plan input validation ----------
export function validatePlan(data) {
  const c = makeCheck();
  const { err } = c;
  if (!c.header(data, PLAN_KIND, ['kind', 'version', 'docId', 'title', 'project', 'createdAt', 'overview', 'requirements', 'architectureChanges', 'phases', 'testing', 'risks', 'questions', 'criteria'])) return { errors: c.errors, warnings: c.warnings };

  c.str(data, 'overview', '$');
  c.arr(data, 'requirements', '$').forEach((t, i) => {
    if (typeof t !== 'string' || t.trim() === '') err(`$.requirements[${i}]`, 'must be a non-empty string');
  });
  c.arr(data, 'architectureChanges', '$').forEach((x, i) => {
    const p = `$.architectureChanges[${i}]`;
    if (!c.obj(x, p)) return;
    c.known(x, ['file', 'text'], p); c.str(x, 'file', p); c.str(x, 'text', p);
  });

  const phases = c.arr(data, 'phases', '$');
  if (Array.isArray(data.phases) && phases.length === 0) err('$.phases', 'must not be empty');
  const stepIds = new Set();
  const deps = []; // [path, id, selfId]
  const stepPath = new Map();
  const graph = new Map(); // id -> dependsOn ids
  phases.forEach((ph, i) => {
    const p = `$.phases[${i}]`;
    if (!c.obj(ph, p)) return;
    c.known(ph, ['name', 'steps'], p);
    c.str(ph, 'name', p);
    const steps = c.arr(ph, 'steps', p);
    if (Array.isArray(ph.steps) && steps.length === 0) err(`${p}.steps`, 'must not be empty');
    steps.forEach((s, j) => {
      const sp = `${p}.steps[${j}]`;
      if (!c.obj(s, sp)) return;
      c.known(s, ['id', 'name', 'file', 'action', 'why', 'dependsOn', 'risk'], sp);
      if (c.id(s, sp, /^P[0-9]{1,6}-[0-9]{1,6}$/, '^P[0-9]{1,6}-[0-9]{1,6}$')) {
        stepIds.add(s.id);
        stepPath.set(s.id, sp);
        const num = Number(s.id.slice(1, s.id.indexOf('-')));
        if (num !== i + 1) c.warnings.push(`${sp}.id: "${s.id}" is in phase ${i + 1} but its phase number is ${num}`);
      }
      for (const k of ['name', 'file', 'action', 'why']) c.str(s, k, sp);
      if (!['low', 'medium', 'high'].includes(s.risk)) err(`${sp}.risk`, 'must be "low", "medium" or "high"');
      c.arr(s, 'dependsOn', sp, false).forEach((d, k) => {
        if (typeof d !== 'string') err(`${sp}.dependsOn[${k}]`, 'must be a string');
        else deps.push([`${sp}.dependsOn[${k}]`, d, s.id]);
      });
      if (typeof s.id === 'string' && stepIds.has(s.id) && ['name', 'file', 'action', 'why'].every((k) => typeof s[k] === 'string') && RISK_JA[s.risk]
        && (s.dependsOn === undefined || (Array.isArray(s.dependsOn) && s.dependsOn.every((d) => typeof d === 'string')))) {
        c.fits(stepLine(s), sp, 'step line');
      }
    });
  });
  for (const [p, d, self] of deps) {
    if (d === self) err(p, 'a step cannot depend on itself');
    else if (!stepIds.has(d)) err(p, `unknown step id "${d}"`);
    else { if (!graph.has(self)) graph.set(self, []); graph.get(self).push(d); }
  }
  // dependency cycles (DFS; each back edge reports one cycle)
  const state = new Map(); // id -> 1 visiting, 2 done
  const stack = [];
  const visit = (id) => {
    state.set(id, 1); stack.push(id);
    for (const d of graph.get(id) || []) {
      if (state.get(d) === 1) {
        const cyc = [...stack.slice(stack.indexOf(d)), d];
        err(`${stepPath.get(id)}.dependsOn`, `dependency cycle: ${cyc.join(' -> ')}`);
      } else if (!state.has(d)) visit(d);
    }
    stack.pop(); state.set(id, 2);
  };
  for (const id of graph.keys()) if (!state.has(id)) visit(id);

  if (c.obj(data.testing ?? null, '$.testing')) {
    c.known(data.testing, ['unit', 'integration', 'e2e'], '$.testing');
    for (const k of ['unit', 'integration', 'e2e']) {
      c.arr(data.testing, k, '$.testing', false).forEach((t, i) => {
        if (typeof t !== 'string' || t.trim() === '') err(`$.testing.${k}[${i}]`, 'must be a non-empty string');
      });
    }
  }
  c.risks(data);
  c.arr(data, 'questions', '$', false).forEach((q, i) => {
    const p = `$.questions[${i}]`;
    if (c.obj(q, p)) c.decision(q, p, /^D[0-9]{1,6}$/, '^D[0-9]{1,6}$', ['note'], planNote);
  });
  const crit = c.arr(data, 'criteria', '$');
  if (Array.isArray(data.criteria) && crit.length === 0) err('$.criteria', 'must not be empty');
  crit.forEach((x, i) => {
    const p = `$.criteria[${i}]`;
    if (!c.obj(x, p)) return;
    c.known(x, ['id', 'tag', 'axis', 'predicate', 'testApproach', 'source'], p);
    c.id(x, p, /^[NEBSQ][0-9]{1,6}$/, '^[NEBSQ][0-9]{1,6}$');
    if (!['機械', 'AI'].includes(x.tag)) err(`${p}.tag`, 'must be "機械" or "AI"');
    if (typeof x.axis !== 'string' || !/^[NEBSQ]$/.test(x.axis)) err(`${p}.axis`, 'must be one of N, E, B, S, Q');
    else if (typeof x.id === 'string' && /^[NEBSQ][0-9]{1,6}$/.test(x.id) && x.id[0] !== x.axis) err(`${p}.axis`, `must equal the id's letter "${x.id[0]}"`);
    c.str(x, 'predicate', p); c.str(x, 'testApproach', p); c.str(x, 'source', p, false);
    if (x.source !== undefined && (typeof x.source !== 'string' || !/^S[0-9]{1,6}-AC[0-9]{1,6}$/.test(x.source))) err(`${p}.source`, 'must match ^S[0-9]{1,6}-AC[0-9]{1,6}$');
  });
  return { errors: c.errors, warnings: c.warnings };
}

// ---------- design / plan adapters: input -> generic document ----------
const NONE = { type: 'p', text: 'なし' };
// Decision block shared by design and plan. noteOf(option) gives the option's own note text.
function decisionBlock(q, noteOf) {
  return {
    type: 'decision', ref: q.id, text: q.text, recommended: q.recommended,
    options: q.options.map((o) => {
      const note = composeNote(o, q, noteOf);
      return { value: o.value, label: o.label, ...(note ? { note } : {}) };
    })
  };
}
const codeBlock = (x) => ({ type: 'code', lang: x.lang, text: x.text });
const riskItems = (list) => list.map((r) => ({ ref: r.id, text: riskText(r) }));

export function designToDoc(d) {
  const doc = {
    kind: DOC_KIND, version: 1, profile: 'design', docId: d.docId, title: d.title, createdAt: d.createdAt,
    sections: [
      { heading: 'もとにした要件', blocks: [{ type: 'p', text: d.basis.length ? `${d.basis.join('・')} を満たすための設計です。` : 'なし' }] },
      { heading: '構成', blocks: d.components.map((x) => ({ type: 'card', ref: x.id, title: cardTitle(x), blocks: [{ type: 'p', text: x.responsibility }] })) },
      {
        heading: 'データ',
        blocks: d.dataModel.length
          ? d.dataModel.map((x) => ({ type: 'card', ref: x.id, title: cardTitle(x), blocks: [{ type: 'p', text: x.purpose }, ...(x.schema ? [codeBlock(x.schema)] : [])] }))
          : [NONE]
      },
      {
        heading: 'API',
        blocks: d.apis.length
          ? d.apis.map((x) => ({ type: 'card', ref: x.id, title: cardTitle(x), blocks: [{ type: 'p', text: x.purpose }, ...(x.shape ? [codeBlock(x.shape)] : [])] }))
          : [NONE]
      },
      { heading: '連携とエラー処理', blocks: d.integration.length ? [{ type: 'list', items: d.integration.map((x) => ({ ref: x.id, text: x.text })) }] : [NONE] },
      {
        heading: '判断',
        blocks: d.decisions.length
          ? d.decisions.map((q) => decisionBlock(q, designNote))
          : [NONE]
      },
      { heading: 'リスク', blocks: d.risks.length ? [{ type: 'list', items: riskItems(d.risks) }] : [NONE] }
    ]
  };
  if (d.project) doc.project = d.project;
  return doc;
}

export function planToDoc(d) {
  const t = d.testing || {};
  const testItems = [['単体', t.unit], ['結合', t.integration], ['E2E', t.e2e]]
    .flatMap(([label, list]) => (list || []).map((x) => `${label}: ${x}`));
  const doc = {
    kind: DOC_KIND, version: 1, profile: 'plan', docId: d.docId, title: d.title, createdAt: d.createdAt,
    sections: [
      { heading: '概要', blocks: [{ type: 'p', text: d.overview }] },
      { heading: 'もとにする要件', blocks: d.requirements.length ? [{ type: 'list', items: d.requirements }] : [NONE] },
      {
        heading: '構成の変更',
        blocks: d.architectureChanges.length
          ? [{ type: 'table', columns: ['ファイル', '変えること'], rows: d.architectureChanges.map((x) => [x.file, x.text]) }]
          : [NONE]
      },
      {
        heading: '実装の手順',
        blocks: d.phases.map((ph) => ({
          type: 'card', title: ph.name,
          blocks: [{
            type: 'list',
            items: ph.steps.map((s) => ({
              ref: s.id,
              text: stepLine(s)
            }))
          }]
        }))
      },
      { heading: 'テストの方針', blocks: testItems.length ? [{ type: 'list', items: testItems }] : [NONE] },
      { heading: 'リスクと対策', blocks: d.risks.length ? [{ type: 'list', items: riskItems(d.risks) }] : [NONE] },
      {
        heading: '判断',
        blocks: (d.questions || []).length ? d.questions.map((q) => decisionBlock(q, planNote)) : [NONE]
      },
      {
        heading: '成功条件',
        blocks: [{
          type: 'table', columns: ['ID', '確かめ方の種別', '軸', '条件', '確かめ方', '元の要件'],
          rows: d.criteria.map((x) => ({ ref: x.id, cells: [x.id, x.tag, x.axis, x.predicate, x.testApproach, x.source || 'なし'] }))
        }]
      }
    ]
  };
  if (d.project) doc.project = d.project;
  return doc;
}

// Dispatch on kind. Returns { errors, warnings, doc } where doc is the generic document to render.
export function prepare(data) {
  if (isObj(data) && data.kind === BUNDLE_KIND) return prepareBundle(data);
  return prepareOne(data);
}

const TAB_ORDER = ['requirements', 'design', 'plan'];
const TAB_KEY_RE = /^consult-[a-z0-9-]{1,32}$/;
// Bundle: validate the envelope, then every tab's input with its own validator (paths prefixed $.tabs[i].input).
function prepareBundle(data) {
  const errors = [];
  const warnings = [];
  const err = (p, m) => errors.push(`${p}: ${m}`);
  const known = (o, allowed, p) => { for (const k of Object.keys(o)) if (!allowed.includes(k)) warnings.push(`${p}.${k}: unknown field (ignored)`); };
  known(data, ['kind', 'version', 'docId', 'title', 'project', 'createdAt', 'tabs'], '$');
  if (data.version !== 1) err('$.version', 'must be 1');
  if (typeof data.docId !== 'string' || !/^[a-z0-9-]{3,64}$/.test(data.docId)) err('$.docId', 'must match [a-z0-9-]{3,64}');
  if (typeof data.title !== 'string' || data.title.trim() === '') err('$.title', 'must be a non-empty string');
  if (data.project !== undefined && typeof data.project !== 'string') err('$.project', 'must be a string');
  if (typeof data.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.createdAt)) err('$.createdAt', 'must be YYYY-MM-DD');
  if (!Array.isArray(data.tabs)) { err('$.tabs', 'must be an array'); return { errors, warnings, doc: null }; }
  if (data.tabs.length < 1 || data.tabs.length > 6) err('$.tabs', `must have 1 to 6 tabs (has ${data.tabs.length})`);
  const seen = new Set();
  let lastRank = -1;
  let currentCount = 0;
  const outTabs = [];
  data.tabs.forEach((t, i) => {
    const p = `$.tabs[${i}]`;
    if (!isObj(t)) { err(p, 'must be an object'); return; }
    known(t, ['key', 'status', 'approvedAt', 'answers', 'input'], p);
    const keyOk = typeof t.key === 'string' && (TAB_ORDER.includes(t.key) || TAB_KEY_RE.test(t.key));
    if (!keyOk) err(`${p}.key`, 'must be requirements, design, plan or consult-<slug> (^consult-[a-z0-9-]{1,32}$)');
    else if (seen.has(t.key)) err(`${p}.key`, `duplicate tab key "${t.key}"`);
    else {
      seen.add(t.key);
      const rank = TAB_ORDER.indexOf(t.key);
      if (rank >= 0) {
        if (rank < lastRank) err(`${p}.key`, 'tabs must be ordered requirements, design, plan');
        lastRank = Math.max(lastRank, rank);
      }
    }
    if (t.status !== 'approved' && t.status !== 'current') err(`${p}.status`, 'must be "approved" or "current"');
    if (t.status === 'current') {
      currentCount++;
      if (i !== data.tabs.length - 1) err(`${p}.status`, 'the current tab must be the last tab');
    }
    if (t.status === 'approved' && (typeof t.approvedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(t.approvedAt))) err(`${p}.approvedAt`, 'required for an approved tab (YYYY-MM-DD)');
    if (t.status === 'current' && t.approvedAt !== undefined) err(`${p}.approvedAt`, 'only allowed on an approved tab');
    if (t.answers !== undefined) {
      if (t.status !== 'approved') err(`${p}.answers`, 'only allowed on an approved tab');
      else if (!isObj(t.answers)) err(`${p}.answers`, 'must be an object');
    }
    let doc = null;
    if (!isObj(t.input)) err(`${p}.input`, 'required (an input object)');
    else if (t.input.kind === BUNDLE_KIND) err(`${p}.input.kind`, 'a bundle cannot contain a bundle');
    else {
      const inner = { ...t.input, docId: data.docId }; // inner docId is ignored; the bundle's is used
      const r = prepareOne(inner);
      for (const e of r.errors) errors.push(e.replace('$', `${p}.input`));
      for (const w of r.warnings) warnings.push(w.replace('$', `${p}.input`));
      doc = r.doc;
      if (doc && keyOk) {
        const expect = TAB_ORDER.includes(t.key) ? t.key : 'consult';
        if (doc.profile !== expect) err(`${p}.input.kind`, `tab "${t.key}" must hold a "${expect === 'consult' ? DOC_KIND : 'review-html/' + expect}" input (profile is "${doc.profile}")`);
      }
    }
    if (doc && isObj(t.answers) && t.status === 'approved') {
      const byRef = new Map(core.collectDecisions(doc).map((q) => [q.ref, q]));
      for (const [ref, val] of Object.entries(t.answers)) {
        const q = byRef.get(ref);
        const allowed = q ? [...q.options.map((o) => o.value), core.OTHER_VALUE] : [];
        if (!q) err(`${p}.answers.${ref}`, 'not a decision of this tab');
        else if (isObj(val)) {
          // Recorded as "other": { "value": "other", "text": "..." }
          for (const k of Object.keys(val)) if (k !== 'value' && k !== 'text') err(`${p}.answers.${ref}.${k}`, 'unknown field (allowed: value, text)');
          if (val.value !== core.OTHER_VALUE) err(`${p}.answers.${ref}.value`, `an object answer must have value "${core.OTHER_VALUE}"`);
          if (val.text !== undefined && (typeof val.text !== 'string' || val.text.length > core.OTHER_MAX)) err(`${p}.answers.${ref}.text`, `must be a string of at most ${core.OTHER_MAX} chars`);
        } else if (typeof val !== 'string' || !allowed.includes(val)) err(`${p}.answers.${ref}`, `must be one of ${allowed.join(', ')} or { "value": "other", "text": "..." }`);
      }
    }
    if (doc && keyOk && (t.status === 'approved' || t.status === 'current')) {
      outTabs.push({
        key: t.key, status: t.status, ...(t.status === 'approved' ? { approvedAt: t.approvedAt, ...(isObj(t.answers) ? { answers: t.answers } : {}) } : {}),
        contentHash: crypto.createHash('sha256').update(JSON.stringify(doc)).digest('hex'), doc
      });
    }
  });
  if (data.tabs.length && currentCount !== 1) err('$.tabs', `exactly one tab must be "current" (has ${currentCount})`);
  if (errors.length) return { errors, warnings, doc: null };
  const doc = { kind: BUNDLE_KIND, version: 1, docId: data.docId, title: data.title, createdAt: data.createdAt, tabs: outTabs };
  if (data.project) doc.project = data.project;
  return { errors, warnings, doc };
}

function prepareOne(data) {
  const adapters = {
    [REQ_KIND]: [validateRequirements, requirementsToDoc, 'requirements'],
    [DESIGN_KIND]: [validateDesign, designToDoc, 'design'],
    [PLAN_KIND]: [validatePlan, planToDoc, 'plan']
  };
  const a = isObj(data) && Object.prototype.hasOwnProperty.call(adapters, data.kind) ? adapters[data.kind] : null;
  if (a) {
    const [validate, toDoc, profile] = a;
    const r = validate(data);
    if (r.errors.length) return { ...r, doc: null };
    const doc = toDoc(data);
    const g = validateDoc(doc, [profile]); // internal consistency check of the adapter output
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

// Renders one document (a whole page, or one tab of a bundle). opt: { ns, tabLabel, status, approvedAt, answers }.
function renderParts(d, opt) {
  const ns = opt.ns || '';
  const approved = opt.status === 'approved';
  const answers = opt.answers || {};
  let auto = 0;
  let gauto = 0;
  let heading = '';
  // Address attributes for one text-bearing element: the block's ref, else b1, b2, ... in document order.
  // In a bundle every address is namespaced by the tab key and every label starts with the tab label.
  // Guide-box elements (G) have their own counter (g1, g2, ...) in a bundle, so the body's b<n> addresses
  // never depend on the tab's status (current guide has a verdict list, approved guide does not).
  const addrAttr = (raw, ref) => {
    const addr = ns ? `${ns}:${raw}` : raw;
    const label = (opt.tabLabel ? `${opt.tabLabel} › ` : '') + heading + (ref ? ` ${ref}` : '');
    return `data-addr="${esc(addr)}" data-label="${esc(label)}"`;
  };
  const A = (ref) => addrAttr(ref ?? `b${++auto}`, ref);
  const G = () => (ns ? addrAttr(`g${++gauto}`) : A());
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
    for (const r of b.rows) {
      const cells = Array.isArray(r) ? r : r.cells;
      const rowRef = Array.isArray(r) ? undefined : r.ref;
      h += '<tr>' + cells.map((c, j) => `<td ${A(j === 0 ? rowRef : undefined)}>${esc(c)}</td>`).join('') + '</tr>';
    }
    return h + '</tbody></table></div>';
  }
  function code(b) {
    return `<figure class="code"${b.lang ? ` data-lang="${esc(b.lang)}"` : ''}>` +
      (b.title ? `<figcaption>${esc(b.title)}</figcaption>` : '') +
      `<pre ${A(b.ref)}>${esc(b.text)}</pre></figure>`;
  }
  function inner(b) {
    switch (b.type) {
      case 'p': return `<p${b.variant === 'label' ? ' class="sublabel"' : ''} ${A(b.ref)}>${esc(b.text)}</p>`;
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
    if (b.type === 'decision' && approved) {
      // Approved tab: the recorded answer (else the recommended option), shown but not editable.
      const dk = `${ns}:${b.ref}`;
      const ans = answers[b.ref];
      const chosen = typeof ans === 'string' ? ans : (isObj(ans) ? ans.value : b.recommended);
      const otherText = isObj(ans) && typeof ans.text === 'string' ? ans.text.trim() : '';
      let h = `<div class="card dcard dcard-approved" data-decision="${esc(dk)}"><span class="chip">承認時の回答</span>` +
        `<p class="q" ${A(b.ref)}>${esc(b.text)}</p>`;
      for (const op of b.options) {
        const rec = op.value === b.recommended;
        h += `<label class="opt"><input type="radio" name="d-${esc(dk)}" value="${esc(op.value)}"${op.value === chosen ? ' checked' : ''} disabled>` +
          `<span class="optbody"><span ${A()}>${esc(op.label)}</span>` +
          (rec ? '<span class="rec">推奨</span>' : '') +
          (op.note ? `<span class="optnote">${esc(op.note)}</span>` : '') + '</span></label>';
      }
      // The "other" label is always emitted (hidden unless it is the recorded answer), so the tab's b<n>
      // addresses are the same as in the current rendering whatever was answered.
      const otherChosen = chosen === core.OTHER_VALUE;
      h += `<label class="opt opt-other"${otherChosen ? '' : ' hidden'}><input type="radio" name="d-${esc(dk)}" value="${core.OTHER_VALUE}"${otherChosen ? ' checked' : ''} disabled>` +
        `<span class="optbody"><span ${A()}>${esc(core.OTHER_LABEL)}</span></span></label>`;
      if (otherChosen) {
        // The recorded free text has its own non-b address ("<tab>:<ref>.other"; refs never contain ".").
        if (otherText) h += `<p class="other-text" ${addrAttr(`${b.ref}.other`, b.ref + ' その他')}>${esc(otherText)}</p>`;
      }
      return h + '</div>';
    }
    if (b.type === 'decision') {
      const dk = ns ? `${ns}:${b.ref}` : b.ref;
      let h = `<div class="card dcard" data-decision="${esc(dk)}"><span class="chip" data-chip="${esc(dk)}">未確認</span>` +
        `<p class="q" ${A(b.ref)}>${esc(b.text)}</p>`;
      for (const op of b.options) {
        const rec = op.value === b.recommended;
        h += `<label class="opt"><input type="radio" name="d-${esc(dk)}" value="${esc(op.value)}"${rec ? ' checked' : ''}>` +
          `<span class="optbody"><span ${A()}>${esc(op.label)}</span>` +
          (rec ? '<span class="rec">推奨</span>' : '') +
          (op.note ? `<span class="optnote">${esc(op.note)}</span>` : '') + '</span></label>';
      }
      h += `<label class="opt opt-other"><input type="radio" name="d-${esc(dk)}" value="${core.OTHER_VALUE}">` +
        `<span class="optbody"><span ${A()}>${esc(core.OTHER_LABEL)}</span></span></label>` +
        `<textarea class="other-ta" data-other="${esc(dk)}" maxlength="${core.OTHER_MAX}" rows="3" ` +
        `placeholder="${esc(core.OTHER_PLACEHOLDER)}" aria-label="${esc(core.OTHER_LABEL)}" hidden></textarea>`;
      return h + '</div>';
    }
    return inner(b);
  }

  const verdictDefs = core.PROFILES[d.profile].verdicts;
  // The box right under the title: what this page is asking, and what each answer leads to.
  const GUIDE = {
    requirements: `${d.title} の要件（何を作るか・何を作らないか）が正しいかを確認します。この内容で設計や実装に進んでよいかを判断してください。`,
    design: `${d.title} の設計（どう作るか）が正しいかを確認します。この設計で実装の計画に進んでよいかを判断してください。`,
    plan: `${d.title} の実装計画（どの順で、どのファイルを、どう変えるか）が正しいかを確認します。この計画で実装に進んでよいかを判断してください。`
  };
  const guideText = d.profile === 'consult' ? (d.purpose || '') : GUIDE[d.profile];
  let guide;
  if (approved) {
    heading = `${d.profile === 'consult' ? '回答済み' : '承認済み'}（${opt.approvedAt}）`;
    const first = guideText.indexOf('。') >= 0 ? guideText.slice(0, guideText.indexOf('。') + 1) : guideText;
    guide = `<aside class="guide guide-approved"><h2 ${G()}>${esc(heading)}</h2><p ${G()}>${esc(first)}</p></aside>`;
  } else {
    heading = d.profile === 'consult' ? 'この資料の目的' : 'この画面で確認すること';
    guide = `<aside class="guide"><h2 ${G()}>${esc(heading)}</h2><p ${G()}>${esc(guideText)}</p>` +
      '<p class="guide-sub">回答の選び方と、そのあとの動き</p><ul class="plain guide-list">' +
      verdictDefs.map((v) => `<li class="gv"><span ${G()}><strong>${esc(v.label)}</strong>: ${esc(v.explain)}</span></li>`).join('') +
      '</ul></aside>';
  }

  const body = [];
  for (const s of d.sections) {
    heading = s.heading;
    body.push(`<section><h2 ${A(s.ref)}>${esc(s.heading)}</h2>`);
    for (const b of s.blocks) body.push(render(b));
    body.push('</section>');
  }
  return { guide, body: body.join('\n'), verdictDefs };
}

export function renderHtml(d) {
  const bundle = d.kind === BUNDLE_KIND;
  let verdictDefs, headExtra, mainBody, dlgTitle, answerLabel;
  if (bundle) {
    const parts = d.tabs.map((t) => ({ t, p: renderParts(t.doc, { ns: t.key, tabLabel: core.tabLabel(t.key), status: t.status, approvedAt: t.approvedAt, answers: t.answers }) }));
    const cur = d.tabs[d.tabs.length - 1];
    verdictDefs = parts[parts.length - 1].p.verdictDefs;
    const sel = (t) => t.status === 'current';
    headExtra = '';
    mainBody = '<nav class="tabbar" id="tabbar"><div class="tablist" role="tablist" aria-label="資料の段階">' +
      d.tabs.map((t) => `<button type="button" role="tab" class="tab${sel(t) ? ' is-current' : ''}" id="tab-${esc(t.key)}" data-tab="${esc(t.key)}" aria-controls="tp-${esc(t.key)}" aria-selected="${sel(t)}" tabindex="${sel(t) ? 0 : -1}">` +
        `<span class="tab-name">${esc(core.tabLabel(t.key))}</span><span class="tab-badge ${t.status}">${t.status === 'approved' ? (t.doc.profile === 'consult' ? '済み' : '承認済み') : '確認中'}</span></button>`).join('') +
      '</div></nav>\n' +
      parts.map(({ t, p }) => `<div class="tabpanel" role="tabpanel" id="tp-${esc(t.key)}" data-panel="${esc(t.key)}" aria-labelledby="tab-${esc(t.key)}" tabindex="0"${sel(t) ? '' : ' hidden'}>\n${p.guide}\n${p.body}\n</div>`).join('\n');
    answerLabel = core.tabLabel(cur.key);
    dlgTitle = `${answerLabel}について回答する`;
  } else {
    const p = renderParts(d, {});
    verdictDefs = p.verdictDefs;
    headExtra = p.guide;
    mainBody = p.body;
    dlgTitle = '回答する';
  }

  const verdicts = verdictDefs
    .map((v) => `<label class="vopt"><input type="radio" name="verdict" value="${esc(v.value)}"><span class="vbody"><span class="vl">${esc(v.label)}</span><span class="vx">${esc(v.explain)}</span></span></label>`).join('\n      ');

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
${headExtra}
<p class="staleinfo" id="stalenote" hidden>内容が更新されたので、前回の入力は引き継いでいません。</p>
</header>
${mainBody}
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
  <p class="pop-hint" id="popHint" role="status" hidden>入力中のコメントがあります。保存するか、キャンセルしてからタブを切り替えてください。</p>
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
      <h2 class="dlg-title" id="dlgTitle" tabindex="-1">${esc(dlgTitle)}</h2>
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
