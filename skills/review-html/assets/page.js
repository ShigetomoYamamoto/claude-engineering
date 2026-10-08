// Browser logic for the review-html page. DOM is built with textContent / createElement only;
// document data is never injected as an HTML string.
(function () {
  'use strict';
  var core = window.ReviewCore;
  var data = JSON.parse(document.getElementById('review-data').textContent);
  var KEY = 'review-html:' + data.docId;
  var HASH = (document.querySelector('meta[name="review-content-hash"]') || { content: '' }).content;
  var CTX = core.CTX, MAXLEN = core.MAXLEN;
  var $ = function (id) { return document.getElementById(id); };
  var main = $('content');
  var state = core.initialState(data);
  var blocks = [];            // addressed elements in document order
  var byAddr = {};            // addr -> element
  var editingId = null, confirmId = null, activeId = null;
  var pending = null;         // { block, start, end, text, range, full }
  var wide = window.matchMedia('(min-width: 1100px)');
  var narrowPop = window.matchMedia('(max-width: 720px)');

  // ---------- helpers ----------
  function mk(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function trunc(s, n) { s = String(s); return s.length > n ? s.slice(0, n) + '…' : s; }
  function uid() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function textNodesOf(root) {
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null), out = [], n;
    while ((n = w.nextNode())) out.push(n);
    return out;
  }

  // ---------- addressed elements ----------
  function initBlocks() {
    var list = main.querySelectorAll('[data-addr]');
    for (var i = 0; i < list.length; i++) {
      blocks.push(list[i]);
      byAddr[list[i].getAttribute('data-addr')] = list[i];
    }
  }
  function blockByAddr(addr) { return Object.prototype.hasOwnProperty.call(byAddr, addr) ? byAddr[addr] : null; }
  function labelOf(c) {
    var b = blockByAddr(c.addr);
    return b ? b.getAttribute('data-label') || c.label : c.label;
  }

  // ---------- text map / selection analysis (scoped to one addressed element) ----------
  function buildTextMap(root) {
    var full = '', map = [], nodes = textNodesOf(root);
    for (var i = 0; i < nodes.length; i++) {
      var s = full.length;
      full += nodes[i].nodeValue;
      map.push({ node: nodes[i], start: s, end: full.length });
    }
    return { full: full, map: map };
  }
  function normalizePoint(c, o) {
    if (c.nodeType === Node.TEXT_NODE) return { node: c, off: o };
    if (c.childNodes.length === 0) return { node: c, off: 0 };
    if (o >= c.childNodes.length) {
      var last = null, w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT, null), n;
      while ((n = w.nextNode())) last = n;
      return last ? { node: last, off: last.nodeValue.length } : { node: c, off: 0 };
    }
    var ch = c.childNodes[o];
    if (ch.nodeType === Node.TEXT_NODE) return { node: ch, off: 0 };
    var f = document.createTreeWalker(ch, NodeFilter.SHOW_TEXT, null).nextNode();
    return f ? { node: f, off: 0 } : { node: c, off: o };
  }
  function pointInfo(c, o) {
    var p = normalizePoint(c, o);
    var el = p.node.nodeType === Node.TEXT_NODE ? p.node.parentElement : p.node;
    var blk = el && el.closest ? el.closest('[data-addr]') : null;
    if (blk && !main.contains(blk)) blk = null;
    return { node: p.node, off: p.off, block: blk };
  }
  function offsetIn(map, node, off) {
    for (var i = 0; i < map.length; i++) if (map[i].node === node) return map[i].start + off;
    return null;
  }
  // returns {kind:'ok', block,start,end,text,range,full} | {kind:'multi'} | null
  function analyze(range) {
    var s = pointInfo(range.startContainer, range.startOffset);
    var e = pointInfo(range.endContainer, range.endOffset);
    if (!s.block && !e.block) return null;
    if (!s.block) return { kind: 'multi' };
    var startId = s.block.getAttribute('data-addr');
    var built = buildTextMap(s.block);
    var a = offsetIn(built.map, s.node, s.off);
    var endId = e.block ? e.block.getAttribute('data-addr') : null, endOff;
    if (e.block === s.block) endOff = offsetIn(built.map, e.node, e.off);
    else if (e.block) {
      var em = buildTextMap(e.block).map;
      endOff = em.length && em[0].node === e.node && e.off === 0 ? 0 : 1;   // 0 = nothing of that block is selected
    } else endOff = e.off === 0 ? 0 : 1;                                     // end in .rec / .optnote etc.
    if (endOff == null || a == null) return null;
    if (core.classifySelection(startId, endId, endOff) === 'multi') return { kind: 'multi' };
    var b = e.block === s.block ? endOff : built.full.length;                // clamp to the start block's end
    var t = core.trimSelection(built.full, a, b);
    if (!t) return null;
    return { kind: 'ok', block: s.block, start: t.start, end: t.end, text: built.full.slice(t.start, t.end), range: range.cloneRange(), full: built.full };
  }
  function clearMarks() {
    var ms = main.querySelectorAll('mark.cm');
    for (var i = 0; i < ms.length; i++) {
      var m = ms[i], p = m.parentNode;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
      p.normalize();
    }
  }
  // one <mark> per text-node segment, so inline elements keep their structure
  function wrapRange(map, a, b, id) {
    var n = 0;
    for (var i = 0; i < map.length; i++) {
      var it = map[i], s = Math.max(it.start, a), e = Math.min(it.end, b);
      if (s >= e) continue;
      var node = it.node;
      if (e - it.start < node.nodeValue.length) node.splitText(e - it.start);
      if (s - it.start > 0) node = node.splitText(s - it.start);
      var m = mk('mark', 'cm');
      m.setAttribute('data-cid', id);
      node.parentNode.insertBefore(m, node);
      m.appendChild(node);
      n++;
    }
    return n > 0;
  }
  function renderMarks() {
    clearMarks();
    state.comments.forEach(function (c) {
      c._found = false; c._pos = 0; c._idx = blocks.length + 1;
      var blk = blockByAddr(c.addr);   // re-anchoring only ever looks inside the element with this addr
      if (!blk) return;
      var t = buildTextMap(blk), an = core.findAnchor(t.full, c);
      if (!an) return;
      if (wrapRange(t.map, an.start, an.end, c.id)) {
        c._found = true; c._pos = an.start; c._idx = blocks.indexOf(blk);
      }
    });
  }

  // ---------- storage ----------
  function warnStorage() { $('storewarn').hidden = false; }
  $('storewarnClose').addEventListener('click', function () { $('storewarn').hidden = true; });
  function save() {
    try {
      window.localStorage.setItem(KEY, JSON.stringify({
        contentHash: HASH,
        comments: state.comments.map(function (c) {
          return { id: c.id, addr: c.addr, label: c.label, quote: c.quote, prefix: c.prefix, suffix: c.suffix, text: c.text };
        }),
        decisions: state.decisions,
        verdict: state.verdict,
        note: state.note,
        sent: state.sent === true
      }));
    } catch (e) { warnStorage(); }
  }
  function loadSaved() {
    var raw;
    try { raw = window.localStorage.getItem(KEY); }
    catch (e) { warnStorage(); return null; }
    if (!raw) return null;
    var saved;
    try { saved = JSON.parse(raw); } catch (e) { return null; } // corrupt: discard silently
    if (!saved || typeof saved !== 'object') return null;
    if (saved.contentHash !== HASH) { $('stalenote').hidden = false; return null; }
    return saved;
  }

  // ---------- decisions ----------
  function refreshChip(ref) {
    var chip = document.querySelector('[data-chip="' + ref + '"]');
    if (!chip) return;
    var done = state.decisions[ref].touched;
    chip.textContent = done ? '確認済み' : '未確認';
    chip.className = 'chip' + (done ? ' done' : '');
  }
  function initDecisions() {
    core.collectDecisions(data).forEach(function (q) {
      var radios = document.querySelectorAll('input[name="d-' + q.ref + '"]');
      Array.prototype.forEach.call(radios, function (r) {
        r.checked = r.value === state.decisions[q.ref].value;
        // State follows the radio's own events. `change` covers selecting another option; `click` also
        // covers re-clicking the already-checked (recommended) option, which counts as confirming it.
        var record = function (wasChecked) {
          if (state.sent || !r.checked) return;
          state = core.applyDecisionClick(state, q.ref, r.value, wasChecked);
          refreshChip(q.ref);
          save();
        };
        r.addEventListener('change', function () { record(false); });
        r.addEventListener('click', function () { record(true); });
        var label = r.closest('label');
        if (label) {
          // Dragging a text selection inside an option must not toggle the radio. Never touch clicks that
          // target the input itself, and only block when the selection actually lies within this label.
          label.addEventListener('click', function (e) {
            if (e.target === r) return;
            var sel = window.getSelection(), inSel = false;
            if (sel && !sel.isCollapsed && sel.rangeCount) {
              try { inSel = sel.containsNode(label, true); } catch (err) { inSel = false; }
            }
            if ((inSel && String(sel).trim() !== '') || (e.target.closest && e.target.closest('mark.cm'))) e.preventDefault();
          });
        }
      });
      refreshChip(q.ref);
    });
  }

  // ---------- panel ----------
  var panelBody = $('panelBody'), panelCount = $('panelCount'), barCount = $('barCount');
  function sorted(list) {
    return list.slice().sort(function (a, b) { return a._idx - b._idx || a._pos - b._pos; });
  }
  function card(c, found) {
    var el = mk('article', 'cm-card' + (c.id === activeId ? ' active' : ''));
    el.setAttribute('data-cid', c.id);
    if (editingId === c.id) {
      el.className += ' cm-edit';
      var ta = mk('textarea'); ta.maxLength = MAXLEN; ta.value = c.text; ta.setAttribute('aria-label', 'コメントを編集');
      el.appendChild(mk('p', 'cm-label', labelOf(c)));
      el.appendChild(ta);
      var act = mk('div', 'cm-actions');
      var cancel = mk('button', 'btn sm', 'キャンセル'); cancel.type = 'button';
      var ok = mk('button', 'btn sm primary', '保存'); ok.type = 'button';
      cancel.addEventListener('click', function (e) { e.stopPropagation(); editingId = null; renderPanel(); });
      ok.addEventListener('click', function (e) {
        e.stopPropagation();
        var v = ta.value.trim(); if (!v || state.sent) return;
        c.text = v; editingId = null; save(); renderPanel();
      });
      el.addEventListener('click', function (e) { e.stopPropagation(); });
      ta.addEventListener('keydown', function (e) {
        if (e.isComposing || e.keyCode === 229) return;
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); ok.click(); }
      });
      act.appendChild(cancel); act.appendChild(ok); el.appendChild(act);
      setTimeout(function () { ta.focus(); }, 0);
      return el;
    }
    el.appendChild(mk('p', 'cm-label', labelOf(c)));
    el.appendChild(mk('p', 'cm-quote', trunc(c.quote, 90)));
    el.appendChild(mk('p', 'cm-text', c.text));
    var row = mk('div', 'cm-actions');
    var ed = mk('button', 'lnk', '編集'); ed.type = 'button'; ed.disabled = state.sent;
    var del = mk('button', 'lnk danger' + (confirmId === c.id ? ' confirm' : ''), confirmId === c.id ? '本当に削除' : '削除'); del.type = 'button'; del.disabled = state.sent;
    ed.addEventListener('click', function (e) { e.stopPropagation(); if (state.sent) return; editingId = c.id; confirmId = null; renderPanel(); });
    del.addEventListener('click', function (e) {
      e.stopPropagation();
      if (state.sent) return;
      if (confirmId === c.id) { removeComment(c.id); return; }
      confirmId = c.id; renderPanel();
      setTimeout(function () { if (confirmId === c.id) { confirmId = null; renderPanel(); } }, 3500);
    });
    row.appendChild(ed); row.appendChild(del); el.appendChild(row);
    if (found) el.addEventListener('click', function () { gotoMark(c.id); });
    return el;
  }
  function renderPanel() {
    var top = panelBody.scrollTop;
    clear(panelBody);
    var all = state.comments, found = sorted(all.filter(function (c) { return c._found; }));
    var lost = all.filter(function (c) { return !c._found; });
    var n = all.length;
    panelCount.textContent = n + ' 件';
    barCount.textContent = 'コメント一覧（' + n + '）';
    if (!n) panelBody.appendChild(mk('p', 'empty', 'まだコメントはありません。本文の文章を選択すると、「コメントを追加」が表示されます。'));
    found.forEach(function (c) { panelBody.appendChild(card(c, true)); });
    if (lost.length) {
      var o = mk('section', 'orph');
      o.appendChild(mk('h3', null, '場所が見つからないコメント（' + lost.length + '）'));
      o.appendChild(mk('p', null, '本文が変わって、元の場所を特定できなかったコメントです。内容は保持され、送信にも含まれます。'));
      lost.forEach(function (c) { o.appendChild(card(c, false)); });
      panelBody.appendChild(o);
    }
    panelBody.scrollTop = top;
    $('sendCount').textContent = 'コメント ' + n + ' 件も一緒に送ります';
  }
  function setActive(id) {
    activeId = id;
    var i, els = document.querySelectorAll('.cm-card.active, mark.cm.active');
    for (i = 0; i < els.length; i++) els[i].classList.remove('active');
    if (!id) return;
    var cs = panelBody.querySelectorAll('.cm-card'), ms = main.querySelectorAll('mark.cm');
    for (i = 0; i < cs.length; i++) if (cs[i].getAttribute('data-cid') === id) cs[i].classList.add('active');
    for (i = 0; i < ms.length; i++) if (ms[i].getAttribute('data-cid') === id) ms[i].classList.add('active');
  }
  function marksOf(id) {
    return Array.prototype.filter.call(main.querySelectorAll('mark.cm'), function (m) { return m.getAttribute('data-cid') === id; });
  }
  function flash(els) {
    els.forEach(function (e) { e.classList.remove('flash'); void e.offsetWidth; e.classList.add('flash'); });
    setTimeout(function () { els.forEach(function (e) { e.classList.remove('flash'); }); }, 1400);
  }
  function gotoMark(id) {
    var ms = marksOf(id); if (!ms.length) return;
    setActive(id);
    if (!wide.matches) setPanel(false);
    var r = ms[0].getBoundingClientRect();
    window.scrollBy({ top: r.top - window.innerHeight * 0.3, behavior: 'smooth' });
    flash(ms);
  }
  function gotoCard(id) {
    setPanel(true);
    setActive(id);
    var cs = panelBody.querySelectorAll('.cm-card');
    for (var i = 0; i < cs.length; i++) {
      if (cs[i].getAttribute('data-cid') === id) { cs[i].scrollIntoView({ block: 'nearest', behavior: 'smooth' }); flash([cs[i]]); }
    }
  }
  function setPanel(open) {
    document.body.classList.toggle('panel-open', !!open);
    $('listBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  main.addEventListener('click', function (e) {
    var m = e.target.closest && e.target.closest('mark.cm');
    if (m && !window.getSelection().toString()) gotoCard(m.getAttribute('data-cid'));
  });
  $('listBtn').addEventListener('click', function () { setPanel(!document.body.classList.contains('panel-open')); });
  $('panelClose').addEventListener('click', function () { setPanel(false); });

  function renderAll() { renderMarks(); renderPanel(); setActive(activeId); }
  function removeComment(id) {
    if (state.sent) return;
    state.comments = state.comments.filter(function (c) { return c.id !== id; });
    confirmId = null; if (activeId === id) activeId = null;
    save(); renderAll();
  }

  // ---------- selection -> add button ----------
  var addBtn = $('addBtn'), selHint = $('selHint'), pop = $('pop'), popTa = $('popTa'), popSave = $('popSave');
  var timer = null, pointerDown = false;
  function rectsOf(range) {
    return Array.prototype.filter.call(range.getClientRects(), function (r) { return r.width > 0 && r.height > 0; });
  }
  function barH() { return $('bar').offsetHeight; }
  function placeFloating(el, range) {
    var rs = rectsOf(range); if (!rs.length) { el.hidden = true; return; }
    el.hidden = false;
    var w = el.offsetWidth, h = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight - barH();
    var touch = narrowPop.matches, r, x, y;
    if (touch) { r = rs[rs.length - 1]; x = r.right - w / 2; y = r.bottom + 14; if (y + h > vh - 6) y = rs[0].top - h - 14; }
    else { r = rs[0]; x = r.left; y = r.top - h - 8; if (y < 8) { r = rs[rs.length - 1]; y = r.bottom + 8; } }
    el.style.left = Math.max(8, Math.min(vw - w - 8, x)) + 'px';
    el.style.top = Math.max(8, Math.min(vh - h - 6, y)) + 'px';
  }
  function hideFloating() { addBtn.hidden = true; selHint.hidden = true; }
  function evaluate() {
    if (!pop.hidden) return;
    if (state.sent) { hideFloating(); pending = null; return; }
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { hideFloating(); pending = null; return; }
    var range = sel.getRangeAt(0);
    var anc = range.commonAncestorContainer;
    var inMain = main.contains(anc.nodeType === 1 ? anc : anc.parentNode);
    if (!inMain || !String(range).trim()) { hideFloating(); pending = null; return; }
    var info = analyze(range);
    if (!info) { hideFloating(); pending = null; return; }
    if (info.kind === 'multi') { addBtn.hidden = true; pending = null; placeFloating(selHint, range); return; }
    selHint.hidden = true; pending = info; placeFloating(addBtn, range);
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(function () { if (!pointerDown) evaluate(); }, 160);
  }
  document.addEventListener('pointerdown', function (e) {
    if (!addBtn.contains(e.target)) pointerDown = true;
  });
  document.addEventListener('pointerup', function () { pointerDown = false; schedule(); });
  document.addEventListener('pointercancel', function () { pointerDown = false; schedule(); });
  document.addEventListener('selectionchange', function () { if (!pointerDown) schedule(); });
  window.addEventListener('scroll', function () {
    if (pending && !addBtn.hidden) placeFloating(addBtn, pending.range);
  }, { passive: true });
  addBtn.addEventListener('mousedown', function (e) { e.preventDefault(); });
  addBtn.addEventListener('click', function () { if (pending) openPop(); });

  function setPendingHighlight(range) {
    try {
      if (window.CSS && CSS.highlights && typeof Highlight !== 'undefined') {
        if (range) CSS.highlights.set('pending', new Highlight(range)); else CSS.highlights.delete('pending');
      }
    } catch (e) { /* unsupported */ }
  }
  function updateKeyboard() {
    var inset = 0;
    if (window.visualViewport) { var v = window.visualViewport; inset = Math.max(0, window.innerHeight - (v.height + v.offsetTop)); }
    document.documentElement.style.setProperty('--keyboard-inset', inset + 'px');
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateKeyboard);
    window.visualViewport.addEventListener('scroll', updateKeyboard);
  }
  function openPop() {
    var info = pending; if (!info) return;
    setPendingHighlight(info.range);
    $('popQuote').textContent = trunc(info.text, 80);
    popTa.value = ''; popSave.disabled = true;
    pop.hidden = false; addBtn.hidden = true; selHint.hidden = true;
    var rs = rectsOf(info.range);
    if (narrowPop.matches) {
      pop.classList.add('is-sheet'); updateKeyboard();
      setTimeout(function () {
        var pr = pop.getBoundingClientRect(), last = rs.length ? info.range.getBoundingClientRect() : null;
        if (last && last.bottom > pr.top - 12) window.scrollBy({ top: last.bottom - (pr.top - 12), behavior: 'smooth' });
      }, 250);
    } else {
      pop.classList.remove('is-sheet');
      var r = rs.length ? rs[rs.length - 1] : { left: 40, bottom: 60, top: 40 };
      var w = pop.offsetWidth, h = pop.offsetHeight, vh = window.innerHeight - barH();
      var y = r.bottom + 10; if (y + h > vh - 8) y = Math.max(8, r.top - h - 10);
      pop.style.left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left)) + 'px';
      pop.style.top = y + 'px';
    }
    popTa.focus({ preventScroll: true });
  }
  function closePop() {
    pop.hidden = true; pending = null; setPendingHighlight(null);
    pop.classList.remove('is-sheet');
    document.documentElement.style.setProperty('--keyboard-inset', '0px');
  }
  popTa.addEventListener('input', function () { popSave.disabled = !popTa.value.trim(); });
  popTa.addEventListener('keydown', function (e) {
    if (e.isComposing || e.keyCode === 229) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); popSave.click(); }
  });
  $('popCancel').addEventListener('click', closePop);
  popSave.addEventListener('click', function () {
    var v = popTa.value.trim(), info = pending;
    if (!v || !info || state.sent) return;
    var rec = core.buildCommentRecord({
      addr: info.block.getAttribute('data-addr'), label: info.block.getAttribute('data-label') || '',
      blockText: info.full, start: info.start, end: info.end
    });
    if (!rec) return;
    var c = { id: uid(), addr: rec.addr, label: rec.label, quote: rec.quote, prefix: rec.prefix, suffix: rec.suffix, text: v };
    state.comments.push(c);
    closePop();
    var sel = window.getSelection(); if (sel) sel.removeAllRanges();
    hideFloating();
    save(); renderAll();
    if (wide.matches) { setPanel(true); gotoCard(c.id); } else { setActive(c.id); }
  });

  // ---------- answer dialog ----------
  var scrim = $('scrim'), noteTa = $('noteTa'), sendBtn = $('sendBtn'), statusEl = $('status');
  var radios = document.querySelectorAll('input[name="verdict"]');
  function syncSend() { sendBtn.disabled = state.sent || !state.verdict; }
  function setStatus(msg, kind) { statusEl.textContent = msg || ''; statusEl.className = 'status' + (kind ? ' ' + kind : ''); }
  function openDialog() { scrim.hidden = false; $('dlgTitle').focus(); }
  function closeDialog() { scrim.hidden = true; }
  $('answerBtn').addEventListener('click', openDialog);
  $('dlgClose').addEventListener('click', closeDialog);
  scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) closeDialog(); });
  Array.prototype.forEach.call(radios, function (r) {
    r.addEventListener('change', function () { state.verdict = r.value; save(); syncSend(); });
  });
  noteTa.addEventListener('input', function () { state.note = noteTa.value; save(); });
  var SENT_MSG = '送信しました。Claude に届きました。チャットに戻ってください。';
  function lockSent() {
    state.sent = true; save();
    hideFloating(); pending = null; if (!pop.hidden) closePop();
    editingId = null; confirmId = null;
    renderPanel();
    Array.prototype.forEach.call(radios, function (r) { r.disabled = true; });
    Array.prototype.forEach.call(document.querySelectorAll('.dcard input'), function (r) { r.disabled = true; });
    noteTa.disabled = true; sendBtn.disabled = true;
  }
  function showFallback(text) {
    $('fallback').hidden = false;
    var ta = $('fallbackTa'); ta.value = text;
    ta.focus(); ta.select();
  }
  var sending = false;
  sendBtn.addEventListener('click', function () {
    if (sending || state.sent) return;
    var payload;
    try { payload = core.buildPayload(data, state); } catch (e) { setStatus('判断を選んでください。', 'warn'); return; }
    var body = JSON.stringify(payload);
    if (!core.checkPayloadSize(body).ok) { setStatus('回答が大きすぎて送れません。コメントを短くするか、件数を減らしてください。', 'warn'); return; }
    sending = true; sendBtn.disabled = true; setStatus('送信しています…');
    $('fallback').hidden = true;
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var to = setTimeout(function () { if (ctl) ctl.abort(); }, 20000);
    var req;
    try {
      req = fetch('submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, signal: ctl ? ctl.signal : undefined });
    } catch (e) { req = Promise.reject(e); }
    req.then(function (res) {
      clearTimeout(to);
      if (res.status !== 200) throw new Error('status ' + res.status);
      lockSent();
      setStatus(SENT_MSG, 'ok');
    }).catch(function () {
      clearTimeout(to);
      sendBtn.disabled = false; syncSend();
      var pretty = JSON.stringify(payload, null, 2);
      var done = function () { setStatus('自動で送れませんでした。回答をコピーしたので、チャットに貼り付けてください。チャットで「確認画面を開き直して」と伝えても再開できます。', 'warn'); };
      var fail = function () {
        setStatus('自動で送れず、コピーもできませんでした。下の回答を手でコピーしてチャットに貼り付けるか、チャットで「確認画面を開き直して」と伝えてください。', 'warn');
        showFallback(pretty);
      };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(pretty).then(done, fail);
        else fail();
      } catch (e) { fail(); }
    }).then(function () { sending = false; });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!scrim.hidden) closeDialog();
    else if (!pop.hidden) closePop();
    else if (document.body.classList.contains('panel-open') && !wide.matches) setPanel(false);
  });

  // ---------- bar height ----------
  function measureBar() { document.documentElement.style.setProperty('--bar-h', barH() + 'px'); }
  window.addEventListener('resize', function () { measureBar(); if (!pop.hidden) return; hideFloating(); });
  if (typeof ResizeObserver === 'function') new ResizeObserver(measureBar).observe($('bar'));

  // ---------- init ----------
  initBlocks();
  state = core.restoreState(data, loadSaved());
  initDecisions();
  noteTa.value = state.note;
  Array.prototype.forEach.call(radios, function (r) { r.checked = r.value === state.verdict; });
  renderAll();
  if (state.sent) { lockSent(); setStatus(SENT_MSG, 'ok'); }
  syncSend();
  measureBar();
})();
