// Pure logic shared by page.js (browser) and render.mjs / node tests. No DOM access.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReviewCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var KIND = 'review-html/answer';
  var VERSION = 2;
  var CTX = 20;      // max chars of prefix/suffix kept with a comment
  var MAXLEN = 4000; // max chars of a comment / note
  var MAX_PAYLOAD_BYTES = 250000; // UTF-8 size cap of the serialized answer
  // Reserved free-text option appended by the renderer to every decision.
  var OTHER_VALUE = 'other';
  var OTHER_LABEL = 'その他（自由記述）';
  var OTHER_MAX = 2000;
  var OTHER_PLACEHOLDER = '選択肢にない考えを書いてください';

  // Verdicts are fixed by profile, never taken from the input document.
  var PROFILES = {
    consult: {
      verdicts: [
        { value: 'proceed', label: 'この内容で進めてよい', explain: '選んだ判断で話を進めます。元に戻せない操作の前には、チャットで確認します。' },
        { value: 'revise', label: '直してほしい', explain: 'コメントをもとに資料を直し、もう一度見せます。' },
        { value: 'question', label: '質問・指摘を送る', explain: 'コメントにチャットで答えます。' }
      ]
    },
    requirements: {
      verdicts: [
        { value: 'approve', label: 'この内容でよい', explain: 'チャットで最後の確認をしてから、次の段階（設計や実装の計画）に進みます。' },
        { value: 'revise', label: '直してほしい', explain: 'コメントをもとに要件を直し、もう一度この画面で見せます。' },
        { value: 'rescope', label: '範囲を変える', explain: 'やること・やらないことを見直し、もう一度見せます。' },
        { value: 'abort', label: '中止する', explain: 'チャットで、中止してよいかを確認します。' }
      ]
    },
    design: {
      verdicts: [
        { value: 'approve', label: 'この設計でよい', explain: 'チャットで最後の確認をしてから、実装の計画に進みます。' },
        { value: 'revise', label: '直してほしい', explain: 'コメントをもとに設計を直し、もう一度この画面で見せます。' },
        { value: 'rescope', label: '要件から見直す', explain: '要件の段階に戻って見直し、もう一度見せます。' },
        { value: 'abort', label: '中止する', explain: 'チャットで、中止してよいかを確認します。' }
      ]
    },
    plan: {
      verdicts: [
        { value: 'approve', label: 'この計画でよい', explain: 'チャットで最後の確認をしてから、実装に進みます。' },
        { value: 'revise', label: '直してほしい', explain: 'コメントをもとに計画を直し、もう一度この画面で見せます。' },
        { value: 'abort', label: '中止する', explain: 'チャットで、中止してよいかを確認します。' }
      ]
    }
  };

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function verdictValues(profile) {
    if (!has(PROFILES, profile)) throw new Error('unknown profile');
    return PROFILES[profile].verdicts.map(function (v) { return v.value; });
  }

  // Decision blocks in document order. Decisions only live at the top level of a section.
  function collectDecisions(data) {
    var out = [];
    (data.sections || []).forEach(function (s) {
      (s.blocks || []).forEach(function (b) {
        if (b && b.type === 'decision') out.push({ ref: b.ref, text: b.text, options: b.options, recommended: b.recommended });
      });
    });
    return out;
  }

  // A decision's options as the page shows them: the document's own options, then the reserved "other".
  function optionsOf(q) { return q.options.concat([{ value: OTHER_VALUE, label: OTHER_LABEL }]); }
  function cleanText(v) { return typeof v === 'string' ? cut(v, OTHER_MAX) : ''; }

  var uidN = 0;
  function uid() { uidN += 1; return 'c' + Date.now().toString(36) + uidN.toString(36) + Math.random().toString(36).slice(2, 5); }
  function cut(s, n) { return s.length > n ? s.slice(0, n) : s; }

  // Fresh state: recommended options pre-selected but untouched; no verdict.
  function initialState(data) {
    var decisions = {};
    collectDecisions(data).forEach(function (d) { decisions[d.ref] = { value: d.recommended, touched: false, text: '' }; });
    return { decisions: decisions, comments: [], verdict: null, note: '', sent: false };
  }

  // Keep only well-formed comments; clamp lengths. Used for restore and for the payload.
  function cleanComments(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (c) {
      if (!c || typeof c !== 'object') return;
      if (typeof c.addr !== 'string' || c.addr === '' || typeof c.quote !== 'string' || c.quote === '') return;
      if (typeof c.text !== 'string' || c.text.trim() === '') return;
      out.push({
        id: typeof c.id === 'string' && c.id ? c.id : uid(),
        addr: cut(c.addr, 64),
        label: typeof c.label === 'string' ? cut(c.label, 200) : '',
        quote: cut(c.quote, MAXLEN),
        prefix: typeof c.prefix === 'string' ? cut(c.prefix, CTX) : '',
        suffix: typeof c.suffix === 'string' ? cut(c.suffix, CTX) : '',
        text: cut(c.text, MAXLEN)
      });
    });
    return out;
  }

  // Merge a saved (untrusted, from localStorage) state onto a fresh one, dropping anything unknown.
  function restoreState(data, saved) {
    var st = initialState(data);
    if (!saved || typeof saved !== 'object') return st;
    collectDecisions(data).forEach(function (q) {
      var d = saved.decisions && typeof saved.decisions === 'object' ? saved.decisions[q.ref] : null;
      if (d && typeof d === 'object' && optionsOf(q).some(function (o) { return o.value === d.value; })) {
        st.decisions[q.ref] = { value: d.value, touched: d.touched === true, text: d.value === OTHER_VALUE ? cleanText(d.text) : '' };
      }
    });
    st.comments = cleanComments(saved.comments);
    if (verdictValues(data.profile).indexOf(saved.verdict) >= 0) st.verdict = saved.verdict;
    if (typeof saved.note === 'string') st.note = cut(saved.note, MAXLEN);
    if (saved.sent === true) st.sent = true; // caller has already matched the content hash
    return st;
  }

  function buildPayload(data, state, now) {
    if (!state || verdictValues(data.profile).indexOf(state.verdict) < 0) throw new Error('verdict is required');
    var decisions = {};
    collectDecisions(data).forEach(function (q) {
      var d = (state.decisions && state.decisions[q.ref]) || { value: q.recommended, touched: false };
      var opt = optionsOf(q).filter(function (o) { return o.value === d.value; })[0];
      decisions[q.ref] = {
        value: d.value,
        label: opt ? opt.label : '',
        recommended: q.recommended,
        touched: d.touched === true,
        changed: d.value !== q.recommended
      };
      if (d.value === OTHER_VALUE) decisions[q.ref].text = cleanText(d.text).trim();
    });
    var comments = cleanComments(state.comments).map(function (c) {
      return { addr: c.addr, label: c.label, quote: c.quote, prefix: c.prefix, suffix: c.suffix, text: c.text };
    });
    return {
      kind: KIND,
      version: VERSION,
      profile: data.profile,
      docId: data.docId,
      verdict: state.verdict,
      decisions: decisions,
      comments: comments,
      note: typeof state.note === 'string' ? cut(state.note, MAXLEN) : '',
      sentAt: (now || new Date()).toISOString()
    };
  }

  // ---- anchoring (pure; operates on the plain text of ONE addressed element) ----
  function commonSuffixLen(a, b) { // length of the common ending of a and b
    var n = 0;
    while (n < a.length && n < b.length && a.charAt(a.length - 1 - n) === b.charAt(b.length - 1 - n)) n++;
    return n;
  }
  function commonPrefixLen(a, b) {
    var n = 0;
    while (n < a.length && n < b.length && a.charAt(n) === b.charAt(n)) n++;
    return n;
  }
  // Returns {start, end} offsets into `full`, or null when the quote is not there.
  // An exact prefix+quote+suffix match wins; otherwise, among several occurrences of the quote,
  // the one whose surrounding text agrees most with the saved prefix/suffix (first one on a tie).
  function findAnchor(full, c) {
    var q = c && typeof c.quote === 'string' ? c.quote : '';
    if (!q || typeof full !== 'string') return null;
    var prefix = typeof c.prefix === 'string' ? c.prefix : '';
    var suffix = typeof c.suffix === 'string' ? c.suffix : '';
    var exact = full.indexOf(prefix + q + suffix);
    if (exact !== -1) { var st = exact + prefix.length; return { start: st, end: st + q.length }; }
    var best = -1, bestScore = -1, from = 0, idx;
    while ((idx = full.indexOf(q, from)) !== -1) {
      var score = commonSuffixLen(full.slice(0, idx), prefix) + commonPrefixLen(full.slice(idx + q.length), suffix);
      if (score > bestScore) { bestScore = score; best = idx; }
      from = idx + 1;
    }
    return best === -1 ? null : { start: best, end: best + q.length };
  }
  function contextAround(full, start, end) {
    return { prefix: full.slice(Math.max(0, start - CTX), start), suffix: full.slice(end, end + CTX) };
  }

  // ---- decisions ----
  // Pure transition for a click/change on a decision radio. Returns a NEW state; the value is always the
  // one the radio now carries, and the decision counts as confirmed (touched), including a re-click on
  // the already-checked (recommended) option. `wasChecked` only documents the re-click case: it never
  // changes the resulting value. "changed" is derived later (buildPayload: value !== recommended).
  function applyDecisionClick(state, ref, value, wasChecked) {
    var decisions = {};
    Object.keys(state.decisions || {}).forEach(function (k) { decisions[k] = state.decisions[k]; });
    var prev = state.decisions && state.decisions[ref];
    // The free text is kept while another option is selected, so switching back does not lose it.
    decisions[ref] = { value: value, touched: true, text: prev ? cleanText(prev.text) : '' };
    var next = {};
    Object.keys(state).forEach(function (k) { next[k] = state[k]; });
    next.decisions = decisions;
    return next;
  }
  // Pure transition for typing into a decision's "other" textarea. Selecting "other" is implied by typing.
  function applyDecisionText(state, ref, text) {
    var decisions = {};
    Object.keys(state.decisions || {}).forEach(function (k) { decisions[k] = state.decisions[k]; });
    decisions[ref] = { value: OTHER_VALUE, touched: true, text: cleanText(text) };
    var next = {};
    Object.keys(state).forEach(function (k) { next[k] = state[k]; });
    next.decisions = decisions;
    return next;
  }

  // ---- selection analysis ----
  // startId: addr of the block holding the selection start (null when none).
  // endId: addr of the block holding the end (null when the end is in a non-addressed element).
  // endOffset: offset of the end inside its block text (or 0 when the end sits at the very edge of a
  // non-addressed element / right after an addressed one). Offset 0 means no text of the end element is
  // selected (triple-click style), so the end is clamped to the start block's end.
  function classifySelection(startId, endId, endOffset) {
    if (!startId) return 'multi';
    if (endId === startId) return 'single';
    if (endOffset === 0) return 'single'; // clamped to the end of the start block
    return 'multi';
  }
  // Trim whitespace at both ends of [a,b) in `full`; null when nothing remains.
  function trimSelection(full, a, b) {
    if (typeof full !== 'string' || a == null || b == null) return null;
    while (a < b && /\s/.test(full.charAt(a))) a++;
    while (b > a && /\s/.test(full.charAt(b - 1))) b--;
    return b > a ? { start: a, end: b } : null;
  }
  // Comment record (without id/text) from one addressed block's text and a selection inside it.
  function buildCommentRecord(sel) {
    var t = trimSelection(sel.blockText, sel.start, sel.end);
    if (!t) return null;
    var ctx = contextAround(sel.blockText, t.start, t.end);
    return {
      addr: sel.addr,
      label: sel.label || '',
      quote: sel.blockText.slice(t.start, t.end),
      prefix: ctx.prefix,
      suffix: ctx.suffix
    };
  }

  // ---- payload size ----
  function utf8Length(s) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(s).length;
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1; else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c < 0xdc00) { n += 4; i++; } else n += 3;
    }
    return n;
  }
  function checkPayloadSize(json, max) {
    var limit = typeof max === 'number' ? max : MAX_PAYLOAD_BYTES;
    var bytes = utf8Length(String(json));
    return { ok: bytes <= limit, bytes: bytes, max: limit };
  }

  return {
    OTHER_VALUE: OTHER_VALUE, OTHER_LABEL: OTHER_LABEL, OTHER_MAX: OTHER_MAX, OTHER_PLACEHOLDER: OTHER_PLACEHOLDER,
    applyDecisionText: applyDecisionText, optionsOf: optionsOf,
    KIND: KIND, VERSION: VERSION, CTX: CTX, MAXLEN: MAXLEN, PROFILES: PROFILES,
    verdictValues: verdictValues, collectDecisions: collectDecisions,
    initialState: initialState, restoreState: restoreState, cleanComments: cleanComments,
    buildPayload: buildPayload, findAnchor: findAnchor, contextAround: contextAround,
    MAX_PAYLOAD_BYTES: MAX_PAYLOAD_BYTES, applyDecisionClick: applyDecisionClick,
    classifySelection: classifySelection, trimSelection: trimSelection,
    buildCommentRecord: buildCommentRecord, checkPayloadSize: checkPayloadSize
  };
});
