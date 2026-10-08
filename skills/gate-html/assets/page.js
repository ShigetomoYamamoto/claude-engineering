// Browser logic for the gate-html page. Builds DOM with textContent only; data is never injected as an HTML string.
(function () {
  var core = window.GateCore;
  var data = JSON.parse(document.getElementById('gate-data').textContent);
  var KEY = 'gate-html:' + data.docId;
  var HASH = (document.querySelector('meta[name="gate-content-hash"]') || { content: '' }).content;
  var sent = false;
  var labels = core.addressLabels(data);

  function loadSaved() {
    var raw;
    try { raw = window.localStorage.getItem(KEY); }
    catch (e) { warnStorage(); return null; }
    if (!raw) return null;
    var saved;
    try { saved = JSON.parse(raw); } catch (e) { return null; } // corrupt: discard silently
    if (!saved || typeof saved !== 'object') return null;
    if (saved.contentHash !== HASH) { document.getElementById('stalenote').hidden = false; return null; }
    return saved;
  }
  function warnStorage() { document.getElementById('storewarn').hidden = false; }
  function save() {
    try { window.localStorage.setItem(KEY, JSON.stringify(Object.assign({ contentHash: HASH }, state))); }
    catch (e) { warnStorage(); }
  }

  var state = core.restoreState(data, loadSaved());
  var $ = function (id) { return document.getElementById(id); };
  var msg = $('msg'), sendBtn = $('send'), manual = $('manual');

  function show(text, cls) { msg.textContent = text; msg.className = cls || ''; }

  // ---- decisions ----
  function refreshChip(qid) {
    var chip = document.querySelector('[data-chip="' + qid + '"]');
    var done = state.decisions[qid].touched;
    chip.textContent = done ? '確認済み' : '未確認';
    chip.className = 'chip' + (done ? ' done' : '');
  }
  data.questions.forEach(function (q) {
    var radios = document.querySelectorAll('input[name="q-' + q.id + '"]');
    Array.prototype.forEach.call(radios, function (r) {
      r.checked = r.value === state.decisions[q.id].value;
      // click (not change): clicking the already-checked recommended option also counts as confirming.
      r.addEventListener('click', function () {
        state.decisions[q.id] = { value: r.value, touched: true };
        refreshChip(q.id);
        save();
      });
    });
    refreshChip(q.id);
  });

  // ---- comments ----
  function countComments() {
    var n = Object.keys(state.comments).length;
    $('ccount').textContent = 'コメント ' + n + ' 件';
  }
  function renderSlot(addr, editing) {
    var slot = document.querySelector('.cslot[data-addr="' + addr + '"]');
    if (editing) {
      var open = slot.querySelector('textarea');
      if (open) { open.focus(); return; } // editor already open: keep typed text
    }
    while (slot.firstChild) slot.removeChild(slot.firstChild);
    var text = state.comments[addr];
    if (editing) {
      var ed = document.createElement('div'); ed.className = 'ceditor';
      var ta = document.createElement('textarea');
      ta.maxLength = 4000;
      ta.setAttribute('aria-label', (labels[addr] || addr) + ' へのコメント');
      ta.value = text || '';
      var row = document.createElement('div'); row.className = 'row';
      var ok = document.createElement('button'); ok.type = 'button'; ok.textContent = '保存';
      var del = document.createElement('button'); del.type = 'button'; del.textContent = '削除';
      ok.addEventListener('click', function () {
        if (ta.value.trim() === '') delete state.comments[addr]; else state.comments[addr] = ta.value;
        save(); countComments(); renderSlot(addr, false);
      });
      del.addEventListener('click', function () {
        delete state.comments[addr];
        save(); countComments(); renderSlot(addr, false);
      });
      row.appendChild(ok); row.appendChild(del);
      ed.appendChild(ta); ed.appendChild(row);
      slot.appendChild(ed);
      ta.focus();
    } else if (text) {
      var d = document.createElement('div'); d.className = 'csaved'; d.textContent = text;
      slot.appendChild(d);
    }
  }
  Array.prototype.forEach.call(document.querySelectorAll('.cbtn'), function (b) {
    b.addEventListener('click', function () { renderSlot(b.getAttribute('data-addr'), true); });
  });
  Object.keys(state.comments).forEach(function (addr) { renderSlot(addr, false); });
  countComments();

  // ---- verdict + note ----
  var verdicts = document.querySelectorAll('input[name="verdict"]');
  Array.prototype.forEach.call(verdicts, function (r) {
    r.checked = r.value === state.verdict;
    r.addEventListener('change', function () {
      state.verdict = r.value; if (!sent) sendBtn.disabled = false; save();
    });
  });
  sendBtn.disabled = state.verdict === null;
  var note = $('note');
  note.maxLength = 4000;
  note.value = state.note;
  note.addEventListener('input', function () { state.note = note.value; save(); });

  // ---- submit ----
  sendBtn.addEventListener('click', async function () {
    var payload;
    try { payload = core.buildPayload(data, state); }
    catch (e) { show('答え方を選んでください。', 'warn'); return; }
    var json = JSON.stringify(payload);
    sendBtn.disabled = true;
    try {
      var r = await fetch('submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json });
      if (r.status !== 200) throw new Error('status ' + r.status);
      sent = true;
      manual.hidden = true;
      show('送信しました。Claude に届きました。チャットに戻ってください。', 'ok');
    } catch (e) {
      sendBtn.disabled = false;
      try {
        await navigator.clipboard.writeText(json);
        show('自動で送れませんでした。回答をコピーしたので、チャットに貼り付けてください。チャットで「確認画面を開き直して」と伝えても再開できます。', 'warn');
      } catch (e2) {
        show('自動で送れず、コピーもできませんでした。下の回答を手でコピーしてチャットに貼り付けるか、チャットで「確認画面を開き直して」と伝えてください。', 'warn');
        manual.value = json; manual.hidden = false; manual.select();
      }
    }
  });
})();
