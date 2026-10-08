// Pure logic shared by page.js (browser) and the node tests. No DOM access.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GateCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var KIND = 'gate-html/requirements';
  var VERSION = 1;
  var VERDICTS = ['approve', 'revise', 'rescope', 'abort'];

  // Map of every commentable address -> human-readable label (Japanese, goes to the AI).
  function addressLabels(data) {
    var m = { goal: '目的', design: '設計が必要か' };
    (data.stories || []).forEach(function (s) {
      m['story:' + s.id] = s.id + ' ストーリー';
      (s.criteria || []).forEach(function (c) { m['criterion:' + c.id] = c.id + ' 受け入れ条件'; });
    });
    (data.nfr || []).forEach(function (n) { m['nfr:' + n.id] = n.id + ' 非機能要件'; });
    var sc = data.scope || {};
    (sc.in || []).forEach(function (x) { m['scope:' + x.id] = x.id + ' 範囲(やる)'; });
    (sc.out || []).forEach(function (x) { m['scope:' + x.id] = x.id + ' 範囲(やらない)'; });
    (sc.future || []).forEach(function (x) { m['scope:' + x.id] = x.id + ' 範囲(将来の検討)'; });
    (data.risks || []).forEach(function (r) { m['risk:' + r.id] = r.id + ' リスク'; });
    (data.questions || []).forEach(function (q) { m['question:' + q.id] = q.id + ' 未決事項'; });
    return m;
  }

  // Fresh state: recommended options pre-selected but untouched; no verdict.
  function initialState(data) {
    var decisions = {};
    (data.questions || []).forEach(function (q) {
      decisions[q.id] = { value: q.recommended, touched: false };
    });
    return { decisions: decisions, comments: {}, verdict: null, note: '' };
  }

  // Merge a saved (untrusted, from localStorage) state onto a fresh one, dropping anything unknown.
  function restoreState(data, saved) {
    var st = initialState(data);
    if (!saved || typeof saved !== 'object') return st;
    var labels = addressLabels(data);
    (data.questions || []).forEach(function (q) {
      var d = saved.decisions && saved.decisions[q.id];
      if (d && typeof d === 'object' && q.options.some(function (o) { return o.value === d.value; })) {
        st.decisions[q.id] = { value: d.value, touched: d.touched === true };
      }
    });
    if (saved.comments && typeof saved.comments === 'object') {
      Object.keys(saved.comments).forEach(function (addr) {
        var t = saved.comments[addr];
        if (Object.prototype.hasOwnProperty.call(labels, addr) && typeof t === 'string' && t.trim() !== '') {
          st.comments[addr] = t;
        }
      });
    }
    if (VERDICTS.indexOf(saved.verdict) >= 0) st.verdict = saved.verdict;
    if (typeof saved.note === 'string') st.note = saved.note;
    return st;
  }

  function buildPayload(data, state, now) {
    if (!state || VERDICTS.indexOf(state.verdict) < 0) throw new Error('verdict is required');
    var decisions = {};
    (data.questions || []).forEach(function (q) {
      var d = (state.decisions && state.decisions[q.id]) || { value: q.recommended, touched: false };
      var opt = q.options.filter(function (o) { return o.value === d.value; })[0];
      decisions[q.id] = {
        value: d.value,
        label: opt ? opt.label : '',
        recommended: q.recommended,
        touched: d.touched === true,
        changed: d.value !== q.recommended
      };
    });
    var labels = addressLabels(data);
    var comments = [];
    Object.keys(state.comments || {}).forEach(function (addr) {
      var text = state.comments[addr];
      if (typeof text === 'string' && text.trim() !== '' && Object.prototype.hasOwnProperty.call(labels, addr)) {
        comments.push({ addr: addr, label: labels[addr], text: text });
      }
    });
    return {
      kind: KIND,
      version: VERSION,
      docId: data.docId,
      verdict: state.verdict,
      decisions: decisions,
      comments: comments,
      note: typeof state.note === 'string' ? state.note : '',
      sentAt: (now || new Date()).toISOString()
    };
  }

  return {
    KIND: KIND, VERSION: VERSION, VERDICTS: VERDICTS,
    addressLabels: addressLabels, initialState: initialState,
    restoreState: restoreState, buildPayload: buildPayload
  };
});
