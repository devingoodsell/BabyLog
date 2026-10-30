/* Baby Log app. Talks to the Apps Script attached to the Baby Log Google Sheet. */
(function () {
  'use strict';

  const CFG = window.BABYLOG_CONFIG || {};
  const MIN = 60000;
  const $ = id => document.getElementById(id);
  const K = { AUTH: 'bl.auth', ENTRIES: 'bl.entries', OUTBOX: 'bl.outbox', ACTIVE: 'bl.active', PREFS: 'bl.prefs' };

  /* ================================================================ */
  /* Storage                                                           */
  /* ================================================================ */
  function load(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function drop(k) { try { localStorage.removeItem(k); } catch (e) {} }

  let auth = load(K.AUTH, null);           // { token, name, role, deviceId }
  let entries = load(K.ENTRIES, []);        // newest data we know about, including unsent entries
  let outbox = load(K.OUTBOX, []);          // [{op:'add', entry} | {op:'delete', id}]
  let active = load(K.ACTIVE, null);        // breastfeed timer on this phone
  // This phone's bottle settings: last unit, last amount per unit, last milk
  const prefs = Object.assign({ unit: 'oz', amount: { oz: 2, ml: 5 }, source: null }, load(K.PREFS, {}));

  const saveEntries = () => store(K.ENTRIES, entries);
  const saveOutbox = () => store(K.OUTBOX, outbox);
  const saveActive = () => (active ? store(K.ACTIVE, active) : drop(K.ACTIVE));

  /* ================================================================ */
  /* Platform                                                          */
  /* ================================================================ */
  const ua = navigator.userAgent || '';
  const isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  /* ================================================================ */
  /* API                                                               */
  /* ================================================================ */
  async function api(action, payload) {
    if (!CFG.apiUrl) { const e = new Error('Baby Log is not connected to the sheet yet.'); e.code = 'not_configured'; throw e; }
    let res;
    try {
      res = await fetch(CFG.apiUrl, {
        method: 'POST',
        body: JSON.stringify(Object.assign({ action: action, token: auth ? auth.token : undefined }, payload || {})),
        redirect: 'follow', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer'
      });
    } catch (err) {
      const e = new Error('No connection'); e.code = 'offline'; throw e;
    }
    let j;
    try { j = await res.json(); } catch (err) { const e = new Error('The sheet did not answer. Try again.'); e.code = 'offline'; throw e; }
    if (!j.ok) {
      const e = new Error(j.message || j.error || 'Something went wrong'); e.code = j.error;
      if (j.error === 'unauthorized' && auth) lockedOut();
      throw e;
    }
    return j;
  }

  /* ================================================================ */
  /* Sync                                                              */
  /* ================================================================ */
  let flushing = false, online = true, lastSync = 0, refreshSoon = false;

  function setSync() {
    const el = $('sync');
    if (!el) return;
    let state = 'ok', text = 'Saved';
    if (flushing) { state = 'saving'; text = 'Saving'; }
    else if (!online) { state = 'offline'; text = outbox.length ? 'Offline · ' + outbox.length + ' waiting' : 'Offline'; }
    else if (outbox.length) { state = 'saving'; text = outbox.length + ' waiting'; }
    el.dataset.state = state;
    $('syncText').textContent = text;
  }

  async function flush() {
    if (flushing || !auth) return;
    flushing = true; setSync();
    try {
      while (outbox.length && auth) {
        const op = outbox[0];
        try {
          if (op.op === 'add') {
            const send = Object.assign({}, op.entry); delete send.pending; delete send.by;
            await api('add', { entry: send });
            const e = entries.find(x => x.id === op.entry.id);
            if (e) delete e.pending;
          } else if (op.op === 'note') {
            await api('update', { id: op.id, note: op.note });
          } else {
            await api('delete', { id: op.id });
          }
          outbox.shift(); saveOutbox(); saveEntries();
          online = true;
        } catch (err) {
          if (err.code === 'bad_request' || err.code === 'forbidden') {
            outbox.shift(); saveOutbox();
            if (op.op === 'add') { entries = entries.filter(x => x.id !== op.entry.id); saveEntries(); }
            if (op.op === 'note') { refreshSoon = true; }
            toast("Couldn't save: " + err.message);
            render();
            continue;
          }
          if (err.code !== 'unauthorized') online = false;
          break;
        }
      }
    } finally {
      flushing = false; setSync(); render();
      if (refreshSoon) { refreshSoon = false; setTimeout(refresh, 500); }
    }
  }

  async function refresh() {
    if (!auth) return;
    await flush();
    if (!auth || outbox.length) return;
    try {
      const j = await api('list');
      auth.name = j.me.name; auth.role = j.me.role; store(K.AUTH, auth);
      const server = j.entries || [];
      const pendingAdds = outbox.filter(o => o.op === 'add').map(o => o.entry);
      const pendingDel = new Set(outbox.filter(o => o.op === 'delete').map(o => o.id));
      entries = server.filter(e => !pendingDel.has(e.id)).concat(pendingAdds.filter(p => !server.some(s => s.id === p.id)));
      outbox.filter(o => o.op === 'note').forEach(o => { const e = entries.find(x => x.id === o.id); if (e) e.note = o.note; });
      saveEntries();
      online = true; lastSync = Date.now();
    } catch (err) {
      if (err.code === 'offline') online = false;
    }
    setSync(); render();
  }

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const b = new Uint8Array(16); crypto.getRandomValues(b);
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  }

  function addEntry(e, opts) {
    e.id = e.id || newId();
    e.by = auth ? auth.name : '';
    e.pending = true;
    entries.push(e);
    outbox.push({ op: 'add', entry: e });
    saveEntries(); saveOutbox(); render(); setSync();
    if (!(opts && opts.quiet)) toast(describe(e).t1 + ' saved', () => removeEntry(e.id, { quiet: true }));
    flush();
  }

  function removeEntry(id, opts) {
    const e = entries.find(x => x.id === id);
    entries = entries.filter(x => x.id !== id);
    outbox = outbox.filter((o, n) => !(o.op === 'note' && o.id === id && !(flushing && n === 0)));
    const i = outbox.findIndex(o => o.op === 'add' && o.entry.id === id);
    if (i > 0 || (i === 0 && !flushing)) outbox.splice(i, 1);
    else outbox.push({ op: 'delete', id: id });
    openItem = null;
    saveEntries(); saveOutbox(); render(); setSync();
    if (e && !(opts && opts.quiet)) {
      toast('Entry deleted', () => { const copy = Object.assign({}, e); delete copy.pending; addEntry(copy, { quiet: true }); });
    }
    flush();
  }

  function updateNote(id, note) {
    note = String(note || '').trim().slice(0, 500);
    const e = entries.find(x => x.id === id);
    if (!e) return;
    const before = e.note || '';
    e.note = note;
    const pendingAdd = outbox.findIndex(o => o.op === 'add' && o.entry.id === id);
    if (pendingAdd > 0 || (pendingAdd === 0 && !flushing)) outbox[pendingAdd].entry.note = note;
    else {
      outbox = outbox.filter((o, n) => !(o.op === 'note' && o.id === id && !(flushing && n === 0)));
      outbox.push({ op: 'note', id: id, note: note });
    }
    editingNote = null; openItem = null;
    saveEntries(); saveOutbox(); render(); setSync();
    toast(note ? 'Note saved' : 'Note removed', () => updateNote(id, before));
    flush();
  }

  /* ================================================================ */
  /* Formatting                                                        */
  /* ================================================================ */
  const fmtTime = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const fmtDay = t => new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  function ago(t) {
    const m = Math.max(0, Math.round((Date.now() - t) / MIN));
    if (m < 1) return 'Just now';
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60), r = m % 60;
    if (h >= 48) return Math.floor(h / 24) + 'd ago';
    return h + 'h ' + (r ? r + 'm ' : '') + 'ago';
  }
  function clock(ms) { const s = Math.floor(ms / 1000), m = Math.floor(s / 60); return m + ':' + String(s % 60).padStart(2, '0'); }
  const sideName = s => (s === 'L' ? 'Left' : 'Right');
  const other = s => (s === 'L' ? 'R' : 'L');
  const kindName = { wet: 'Wet', dirty: 'Dirty', both: 'Wet + dirty' };
  const MILK = { breast: 'Breast milk', formula: 'Formula' };
  const PUMP_SIDE = { L: 'Left', R: 'Right', B: 'Both sides' };
  // "L 2 oz, R 1.5 oz" for both sides, "2 oz" for one side, '' when nothing was measured
  function pumpAmtText(e) {
    const u = e.pumpUnit === 'ml' ? 'ml' : 'oz', lab = u === 'ml' ? ' mL' : ' oz';
    const f = v => fmtAmt(v, u) + lab;
    if (e.side === 'B') {
      const parts = [];
      if (e.leftAmt != null) parts.push('L ' + f(e.leftAmt));
      if (e.rightAmt != null) parts.push('R ' + f(e.rightAmt));
      return parts.join(', ');
    }
    const v = e.side === 'L' ? e.leftAmt : e.rightAmt;
    return v != null ? f(v) : '';
  }
  function pumpTotalText(e) {
    if (e.leftAmt == null && e.rightAmt == null) return '';
    const u = e.pumpUnit === 'ml' ? 'ml' : 'oz';
    return fmtAmt((e.leftAmt || 0) + (e.rightAmt || 0), u) + (u === 'ml' ? ' mL' : ' oz');
  }
  const ML_PER_OZ = 29.5735;
  const fmtAmt = (v, unit) => String(unit === 'ml' ? +Number(v).toFixed(1) : +Number(v).toFixed(2));
  function amountText(e) {
    const unit = e.unit === 'ml' ? 'ml' : 'oz';
    const amt = e.amount != null ? e.amount : e.oz;
    return fmtAmt(amt, unit) + (unit === 'ml' ? ' mL' : ' oz');
  }
  const sideMin = (e, s) => (s === 'L' ? (e.left || 0) : (e.right || 0));
  const initial = n => (String(n || '?').trim()[0] || '?').toUpperCase();

  function sideParts(e) {
    return [e.first, other(e.first)].filter(s => sideMin(e, s) > 0)
      .map((s, i) => (i ? sideName(s).toLowerCase() : sideName(s)) + ' ' + sideMin(e, s) + 'm').join(', ') || '0 min';
  }
  function splitBar(e) {
    const bar = document.createElement('div'); bar.className = 'split';
    let n = 0;
    [e.first, other(e.first)].forEach(s => {
      const m = sideMin(e, s); if (!m) return;
      const seg = document.createElement('span');
      seg.className = n++ === 0 ? 's1' : 's2';
      seg.style.flexGrow = m;
      seg.textContent = sideName(s) + ' ' + m + 'm';
      bar.appendChild(seg);
    });
    return bar;
  }
  function describe(e) {
    const by = e.by ? ' · ' + e.by : '';
    if (e.type === 'breast') {
      const total = (e.left || 0) + (e.right || 0);
      const both = e.left > 0 && e.right > 0;
      const t2 = both
        ? 'Started ' + sideName(e.first).toLowerCase() + ', ended ' + sideName(e.last).toLowerCase() + ' · ' + total + ' min'
        : sideName(e.left > 0 ? 'L' : e.right > 0 ? 'R' : e.first) + ' only · ' + total + ' min';
      return { icon: 'feed', cls: 'i-feed', t1: 'Breastfeed', t2: t2 + by };
    }
    if (e.type === 'pump') return { icon: 'pump', cls: 'i-pump', t1: 'Pump', t2: PUMP_SIDE[e.side] + ' · ' + e.minutes + ' min' + (pumpAmtText(e) ? ' · ' + pumpAmtText(e) : '') + (e.label ? ' · ' + e.label : '') + by };
    if (e.type === 'bottle') return { icon: 'bottle', cls: 'i-bottle', t1: 'Bottle', t2: amountText(e) + (e.source ? ' · ' + MILK[e.source] : '') + by };
    return { icon: e.kind, cls: 'i-diaper', t1: kindName[e.kind] + ' diaper', t2: 'Diaper' + by };
  }

  /* ================================================================ */
  /* Home render                                                       */
  /* ================================================================ */
  let openItem = null, editingNote = null;

  function render() {
    if (!auth || $('screen-home').hidden) return;
    $('today').textContent = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    $('meBtn').textContent = initial(auth.name);

    const sorted = entries.slice().sort((a, b) => b.t - a.t);
    const lastFeed = sorted.find(e => e.type === 'breast' || e.type === 'bottle');
    const lastBreast = sorted.find(e => e.type === 'breast');
    const lastDiaper = sorted.find(e => e.type === 'diaper');

    if (lastFeed) {
      $('lastFeedAgo').textContent = ago(lastFeed.t);
      $('lastFeedSub').textContent = lastFeed.type === 'bottle'
        ? 'Bottle ' + amountText(lastFeed) + (lastFeed.source ? ' ' + MILK[lastFeed.source].toLowerCase() : '') + ' at ' + fmtTime(lastFeed.t)
        : sideParts(lastFeed) + ' at ' + fmtTime(lastFeed.t);
    } else { $('lastFeedAgo').textContent = 'None yet'; $('lastFeedSub').textContent = 'Tap Breastfeed or Bottle to log one'; }
    const next = lastBreast ? other(lastBreast.last) : null;
    $('nextSide').hidden = !next;
    if (next) $('nextSide').textContent = 'Next: ' + sideName(next) + ' side';

    if (lastDiaper) {
      $('lastDiaperAgo').textContent = ago(lastDiaper.t);
      $('lastDiaperSub').textContent = kindName[lastDiaper.kind] + ' at ' + fmtTime(lastDiaper.t);
    } else { $('lastDiaperAgo').textContent = 'None yet'; $('lastDiaperSub').textContent = 'Tap Diaper to log one'; }

    const lastEmpty = sorted.find(e => e.type === 'pump' || e.type === 'breast');
    if (lastEmpty) {
      $('lastEmptyAgo').textContent = ago(lastEmpty.t);
      $('lastEmptySub').textContent = lastEmpty.type === 'pump'
        ? 'Pump, ' + PUMP_SIDE[lastEmpty.side].toLowerCase() + ', ' + lastEmpty.minutes + ' min' + (pumpTotalText(lastEmpty) ? ', ' + pumpTotalText(lastEmpty) : '') + ' at ' + fmtTime(lastEmpty.t)
        : 'Breastfeed: ' + sideParts(lastEmpty).toLowerCase() + ' at ' + fmtTime(lastEmpty.t);
    } else { $('lastEmptyAgo').textContent = 'None yet'; $('lastEmptySub').textContent = 'Tap Pump or Breastfeed to log one'; }

    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const today = sorted.filter(e => e.t >= midnight.getTime());
    const breastMin = today.filter(e => e.type === 'breast').reduce((s, e) => s + (e.left || 0) + (e.right || 0), 0);
    const bottles = today.filter(e => e.type === 'bottle');
    $('tFeeds').textContent = today.filter(e => e.type === 'breast' || e.type === 'bottle').length;
    $('tFeedMin').textContent = breastMin + ' min';
    const totalOz = bottles.reduce((s, e) => s + (e.oz || 0), 0);
    $('tOz').textContent = prefs.unit === 'ml' ? Math.round(totalOz * ML_PER_OZ) : +totalOz.toFixed(1);
    $('tOzUnit').textContent = prefs.unit === 'ml' ? 'mL' : 'Oz';
    $('tBottles').textContent = bottles.length + (bottles.length === 1 ? ' bottle' : ' bottles');
    $('tWet').textContent = today.filter(e => e.kind === 'wet' || e.kind === 'both').length;
    $('tDirty').textContent = today.filter(e => e.kind === 'dirty' || e.kind === 'both').length;

    // Don't rebuild the timeline under someone who is typing a note
    if (editingNote && $('edit-note')) { renderLive(); return; }
    const tl = $('timeline');
    tl.textContent = '';
    if (!sorted.length) {
      const d = document.createElement('div'); d.className = 'empty';
      d.textContent = lastSync || !online ? 'Nothing logged yet. Tap Breastfeed, Bottle or Diaper to add the first entry.' : 'Loading the log...';
      tl.appendChild(d);
    }
    let lastDay = new Date().toDateString();
    sorted.slice(0, 60).forEach(e => {
      const dayKey = new Date(e.t).toDateString();
      if (dayKey !== lastDay) {
        const h = document.createElement('div'); h.className = 'day-head';
        h.textContent = new Date(e.t).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
        tl.appendChild(h);
        lastDay = dayKey;
      }
      const d = describe(e);
      const wrap = document.createElement('div'); wrap.className = 'item-wrap';
      const b = document.createElement('button'); b.type = 'button'; b.className = 'item';
      b.innerHTML = '<span class="ico ' + d.cls + '"><svg><use href="#i-' + d.icon + '"/></svg></span><span class="txt"><div class="t1"></div><div class="t2"></div></span><span class="when num"></span>';
      b.querySelector('.t1').textContent = d.t1;
      if (e.pending) { const p = document.createElement('span'); p.className = 'pend'; p.title = 'Not saved to the sheet yet'; b.querySelector('.t1').appendChild(p); }
      b.querySelector('.t2').textContent = d.t2;
      if (e.note) { const n = document.createElement('div'); n.className = 't3'; n.textContent = e.note; b.querySelector('.txt').appendChild(n); }
      const whenEl = b.querySelector('.when');
      whenEl.textContent = fmtTime(e.t);
      if (e.type === 'pump' && e.minutes) { const sm = document.createElement('small'); sm.textContent = 'to ' + fmtTime(e.t + e.minutes * MIN); whenEl.appendChild(sm); }
      if (e.type === 'breast') {
        const tot = (e.left || 0) + (e.right || 0);
        if (tot) { const sm = document.createElement('small'); sm.textContent = 'to ' + fmtTime(e.t + tot * MIN); whenEl.appendChild(sm); }
        b.querySelector('.txt').appendChild(splitBar(e));
      }
      b.addEventListener('click', () => { openItem = openItem === e.id ? null : e.id; editingNote = null; render(); });
      wrap.appendChild(b);
      if (openItem === e.id && editingNote === e.id) {
        const box = document.createElement('div'); box.className = 'item-edit';
        const ta = document.createElement('textarea'); ta.className = 'text'; ta.id = 'edit-note'; ta.rows = 3; ta.maxLength = 500;
        ta.placeholder = 'Add a note'; ta.value = e.note || '';
        const row = document.createElement('div'); row.className = 'item-tools'; row.style.padding = '0';
        const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Save note';
        save.style.color = 'var(--feed)';
        save.addEventListener('click', () => updateNote(e.id, ta.value));
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
        cancel.addEventListener('click', () => { editingNote = null; render(); });
        row.append(save, cancel); box.append(ta, row); wrap.appendChild(box);
        setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
      } else if (openItem === e.id) {
        const tools = document.createElement('div'); tools.className = 'item-tools';
        const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = e.note ? 'Edit note' : 'Add note';
        edit.addEventListener('click', () => { editingNote = e.id; render(); });
        const del = document.createElement('button'); del.type = 'button'; del.className = 'del'; del.textContent = 'Delete';
        del.addEventListener('click', () => removeEntry(e.id));
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
        cancel.addEventListener('click', () => { openItem = null; render(); });
        tools.append(edit, del, cancel); wrap.appendChild(tools);
      }
      tl.appendChild(wrap);
    });
    renderLive();
    if (openSheet === $('sheet-stats')) renderStats();
  }

  /* ================================================================ */
  /* Toast                                                             */
  /* ================================================================ */
  let toastTimer, undoFn;
  function toast(msg, undo) {
    $('toastMsg').textContent = msg; undoFn = undo || null;
    $('toastUndo').hidden = !undo;
    $('toast').classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 4500);
  }
  $('toastUndo').addEventListener('click', () => { const f = undoFn; undoFn = null; $('toast').classList.remove('show'); if (f) f(); });

  /* ================================================================ */
  /* Sheets                                                            */
  /* ================================================================ */
  let openSheet = null;
  function open(name) {
    closeSheet();
    openSheet = $('sheet-' + name);
    if (name === 'diaper') { resetDiaper(); resetNote('diaper'); }
    if (name === 'bottle') resetNote('bottle');
    if (name === 'pump') resetPump();
    if (name === 'stats') setTimeout(renderStats, 30);
    if (name === 'feed') { resetNote('manual'); resetNote('timer', active && active.note); }
    if (name === 'bottle') { setWhen('bottle', 0); setUnit(prefs.unit); setSource(prefs.source); }
    if (name === 'feed') { setWhen('manual', 20); renderTimer(); }
    if (name === 'settings') renderSettings();
    $('scrim').classList.add('open'); openSheet.classList.add('open');
  }
  function closeSheet() {
    if (openSheet) openSheet.classList.remove('open');
    $('scrim').classList.remove('open'); openSheet = null;
  }
  document.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => open(b.dataset.open)));
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeSheet));
  $('scrim').addEventListener('click', closeSheet);
  $('live').addEventListener('click', () => open('feed'));
  $('meBtn').addEventListener('click', () => open('settings'));
  $('statsBtn').addEventListener('click', () => open('stats'));
  $('sync').addEventListener('click', () => { refresh(); toast(online ? 'Checking for new entries' : 'Trying to reconnect'); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

  /* ================================================================ */
  /* "When" picker                                                     */
  /* ================================================================ */
  const whenState = {};
  const WHEN = [[0, 'Now'], [10, '10m ago'], [20, '20m ago'], [30, '30m ago'], [60, '1h ago']];
  document.querySelectorAll('.chips.when').forEach(box => {
    const key = box.dataset.for;
    WHEN.forEach(([m, label]) => {
      const c = document.createElement('button'); c.type = 'button'; c.className = 'chip'; c.textContent = label; c.dataset.m = m;
      c.addEventListener('click', () => setWhen(key, m)); box.appendChild(c);
    });
    const t = document.createElement('input'); t.type = 'time'; t.id = 'time-' + key; t.setAttribute('aria-label', 'Exact time');
    t.addEventListener('change', () => {
      if (!t.value) return;
      const [h, mi] = t.value.split(':').map(Number);
      const d = new Date(); d.setHours(h, mi, 0, 0);
      if (d.getTime() > Date.now() + MIN) d.setDate(d.getDate() - 1); // a time later than now means last night
      whenState[key] = d.getTime();
      box.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
    });
    box.appendChild(t);
  });
  function setWhen(key, minsAgo) {
    const box = document.querySelector('.chips.when[data-for="' + key + '"]');
    box.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', String(Number(c.dataset.m) === minsAgo)));
    const t = box.querySelector('input'); if (t) t.value = '';
    whenState[key] = minsAgo === 0 ? null : Date.now() - minsAgo * MIN; // "Now" resolves at save time
  }
  const whenOf = key => whenState[key] || Date.now();

  /* ================================================================ */
  /* Optional notes on new entries                                     */
  /* ================================================================ */
  document.querySelectorAll('.note-wrap').forEach(w => {
    const btn = w.querySelector('.add-note'), ta = w.querySelector('textarea');
    btn.addEventListener('click', () => { btn.hidden = true; ta.hidden = false; ta.focus(); });
    if (w.dataset.note === 'timer') ta.addEventListener('input', () => { if (active) { active.note = ta.value; saveActive(); } });
  });
  function resetNote(key, value) {
    const w = document.querySelector('.note-wrap[data-note="' + key + '"]');
    const ta = w.querySelector('textarea'), btn = w.querySelector('.add-note');
    ta.value = value || ''; ta.hidden = !value; btn.hidden = !!value;
  }
  const noteOf = key => $('note-' + key).value.trim();

  /* ================================================================ */
  /* Breastfeed timer                                                  */
  /* ================================================================ */
  function sideMs(a, s) {
    let ms = s === 'L' ? a.left : a.right;
    if (a.running && a.side === s) ms += Date.now() - a.segStart;
    return ms;
  }
  function tapSide(s) {
    const now = Date.now();
    const a = active;
    if (!a) {
      active = { start: now, first: s, side: s, running: true, segStart: now, left: 0, right: 0, note: $('note-timer').value };
    } else if (a.side === s && a.running) {
      if (s === 'L') a.left += now - a.segStart; else a.right += now - a.segStart;
      a.running = false;
    } else {
      if (a.running) { if (a.side === 'L') a.left += now - a.segStart; else a.right += now - a.segStart; }
      a.side = s; a.running = true; a.segStart = now;
    }
    saveActive(); renderTimer(); renderLive();
  }
  $('sideL').addEventListener('click', () => tapSide('L'));
  $('sideR').addEventListener('click', () => tapSide('R'));

  function renderTimer() {
    const a = active;
    const lastBreast = entries.filter(e => e.type === 'breast').sort((x, y) => y.t - x.t)[0];
    const next = lastBreast ? other(lastBreast.last) : null;
    ['L', 'R'].forEach(s => {
      const el = $('side' + s);
      const ms = a ? sideMs(a, s) : 0;
      $('clock' + s).textContent = clock(ms);
      const running = a && a.running && a.side === s;
      const paused = a && !a.running && a.side === s;
      el.classList.toggle('running', !!running);
      el.classList.toggle('paused', !!paused);
      $('hint' + s).textContent = running ? 'Tap to pause' : paused ? 'Paused' : a ? 'Tap to switch' : 'Tap to start';
      $('tag' + s).hidden = !!a || next !== s;
    });
    if (a) {
      const total = sideMs(a, 'L') + sideMs(a, 'R');
      $('feedTotal').innerHTML = 'Total <b></b> · started ' + fmtTime(a.start);
      $('feedTotal').querySelector('b').textContent = clock(total);
    } else {
      $('feedTotal').textContent = next ? 'Last feed ended on the ' + sideName(other(next)).toLowerCase() + '. Tap a side to start.' : "Tap the side you're starting on";
    }
    $('feedDone').disabled = !a;
    $('feedDiscard').hidden = !a;
  }
  function renderLive() {
    const a = active;
    $('live').hidden = !a;
    if (!a) return;
    $('liveTitle').textContent = a.running ? 'Feeding · ' + sideName(a.side) + ' side' : 'Feeding paused';
    $('liveSub').textContent = 'Left ' + clock(sideMs(a, 'L')) + ' · Right ' + clock(sideMs(a, 'R'));
  }
  $('feedDone').addEventListener('click', () => {
    const a = active; if (!a) return;
    // A side used for 20 seconds or more counts as at least 1 minute
    const toMin = ms => (ms >= 20000 ? Math.max(1, Math.round(ms / MIN)) : 0);
    const left = toMin(sideMs(a, 'L')), right = toMin(sideMs(a, 'R'));
    if (!left && !right) { toast('That feed was under 20 seconds, so it was not saved'); active = null; saveActive(); renderTimer(); renderLive(); closeSheet(); return; }
    active = null; saveActive();
    const first = left && right ? a.first : (left ? 'L' : 'R');
    const last = left && right ? a.side : first;
    addEntry({ type: 'breast', t: a.start, left: left, right: right, first: first, last: last, note: noteOf('timer') });
    closeSheet();
  });
  $('feedDiscard').addEventListener('click', () => { active = null; saveActive(); resetNote('timer'); renderTimer(); renderLive(); toast('Feed discarded'); });
  setInterval(() => { if (active) { renderLive(); if (openSheet === $('sheet-feed')) renderTimer(); } }, 1000);

  /* Manual feed */
  const manual = { first: 'L', L: 10, R: 10 };
  function setMode(timer) {
    $('modeTimer').setAttribute('aria-pressed', String(timer));
    $('modeManual').setAttribute('aria-pressed', String(!timer));
    $('timerPane').hidden = !timer;
    $('manualPane').hidden = timer;
  }
  $('modeTimer').addEventListener('click', () => setMode(true));
  $('modeManual').addEventListener('click', () => setMode(false));
  document.querySelectorAll('[data-first]').forEach(c => c.addEventListener('click', () => {
    manual.first = c.dataset.first;
    document.querySelectorAll('[data-first]').forEach(x => x.setAttribute('aria-pressed', String(x === c)));
  }));
  document.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => {
    const s = b.dataset.step;
    manual[s] = Math.max(0, Math.min(90, manual[s] + Number(b.dataset.d)));
    $('m' + s).textContent = manual[s] + ' min';
  }));
  $('manualSave').addEventListener('click', () => {
    if (!manual.L && !manual.R) { toast('Add minutes for at least one side'); return; }
    const both = manual.L > 0 && manual.R > 0;
    const only = manual.L ? 'L' : 'R';
    const first = both ? manual.first : only;
    const last = both ? other(manual.first) : only;
    addEntry({ type: 'breast', t: whenOf('manual'), left: manual.L, right: manual.R, first: first, last: last, note: noteOf('manual') });
    closeSheet();
  });

  /* Bottle (or syringe): ounces or mL, plus milk source */
  const UNITS = {
    oz: { step: 0.5, min: 0.25, max: 12, chips: [1, 2, 3, 4], label: 'oz' },
    ml: { step: 0.1, min: 0.1, max: 360, chips: [1, 3, 5, 10, 30, 60], label: 'mL' }
  };
  let unit = 'oz', amount = 2, source = null;
  const savePrefs = () => store(K.PREFS, prefs);
  const clampAmt = v => {
    const u = UNITS[unit];
    const r = unit === 'ml' ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100;
    return Math.max(u.min, Math.min(u.max, r));
  };
  function showAmount() {
    const el = $('amtInput');
    const txt = fmtAmt(amount, unit);
    if (document.activeElement !== el) el.value = txt;
    el.style.width = Math.max(2, el.value.length) + 0.4 + 'ch';
    document.querySelectorAll('#amtChips .chip').forEach(c => c.setAttribute('aria-pressed', String(Number(c.dataset.amt) === amount)));
  }
  function setAmount(v) { if (!isFinite(v)) return; amount = clampAmt(v); showAmount(); }
  function setUnit(u) {
    unit = u === 'ml' ? 'ml' : 'oz';
    prefs.unit = unit; savePrefs();
    $('unitOz').setAttribute('aria-pressed', String(unit === 'oz'));
    $('unitMl').setAttribute('aria-pressed', String(unit === 'ml'));
    $('amtUnit').textContent = UNITS[unit].label;
    const box = $('amtChips'); box.textContent = '';
    UNITS[unit].chips.forEach(v => {
      const c = document.createElement('button'); c.type = 'button'; c.className = 'chip';
      c.dataset.amt = v; c.textContent = v + ' ' + UNITS[unit].label;
      c.addEventListener('click', () => setAmount(v));
      box.appendChild(c);
    });
    amount = clampAmt(Number(prefs.amount && prefs.amount[unit]) || (unit === 'ml' ? 5 : 2));
    showAmount();
    render();
  }
  function setSource(src) {
    source = src === 'breast' || src === 'formula' ? src : null;
    document.querySelectorAll('[data-source]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.source === source)));
    $('bottleSave').disabled = !source;
    $('bottleSave').textContent = source ? 'Save bottle' : 'Choose breast milk or formula';
  }
  $('unitOz').addEventListener('click', () => setUnit('oz'));
  $('unitMl').addEventListener('click', () => setUnit('ml'));
  document.querySelectorAll('[data-source]').forEach(b => b.addEventListener('click', () => setSource(b.dataset.source)));

  // Typing an amount
  $('amtInput').addEventListener('input', e => {
    const el = e.target;
    el.value = el.value.replace(',', '.').replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
    el.style.width = Math.max(2, el.value.length) + 0.4 + 'ch';
    const v = parseFloat(el.value);
    if (isFinite(v) && v > 0) amount = clampAmt(v);
  });
  $('amtInput').addEventListener('focus', e => setTimeout(() => e.target.select(), 0));
  $('amtInput').addEventListener('blur', showAmount);
  $('amtInput').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });

  // + and -: tap for one step, hold to repeat (speeds up the longer you hold)
  function holdRepeat(btn, step) {
    let timer = null, delay = 0;
    const stop = () => { clearTimeout(timer); timer = null; };
    const tick = () => { step(); delay = Math.max(40, delay * 0.85); timer = setTimeout(tick, delay); };
    btn.addEventListener('pointerdown', e => {
      e.preventDefault();
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      step(); delay = 140; timer = setTimeout(tick, 420);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(t => btn.addEventListener(t, stop));
    btn.addEventListener('contextmenu', e => e.preventDefault());
    btn.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); step(); } });
  }
  holdRepeat($('amtMinus'), () => setAmount(amount - UNITS[unit].step));
  holdRepeat($('amtPlus'), () => setAmount(amount + UNITS[unit].step));

  $('bottleSave').addEventListener('click', () => {
    const v = parseFloat($('amtInput').value);
    if (isFinite(v) && v > 0) amount = clampAmt(v);
    if (!source) return;
    prefs.amount = Object.assign({}, prefs.amount, { [unit]: amount });
    prefs.source = source; savePrefs();
    const oz = unit === 'ml' ? Math.round(amount / ML_PER_OZ * 100) / 100 : amount;
    addEntry({ type: 'bottle', t: whenOf('bottle'), amount: amount, unit: unit, oz: oz, source: source, note: noteOf('bottle') });
    closeSheet();
  });

  /* Pump: side, minutes, optional storage label */
  let pumpSide = null, pumpMin = 15;
  function setPumpMin(v) {
    pumpMin = Math.max(1, Math.min(180, Math.round(v)));
    $('pumpVal').textContent = pumpMin;
    document.querySelectorAll('[data-pmin]').forEach(c => c.setAttribute('aria-pressed', String(Number(c.dataset.pmin) === pumpMin)));
  }
  function setPumpSide(sd) {
    pumpSide = sd === 'L' || sd === 'R' || sd === 'B' ? sd : null;
    document.querySelectorAll('[data-pside]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.pside === pumpSide)));
    $('pumpSave').disabled = !pumpSide;
    $('pumpSave').textContent = pumpSide ? 'Save pump' : 'Choose a side';
    ['pAmtTitle', 'pUnitSeg'].forEach(id => { $(id).hidden = !pumpSide; });
    $('pAmtRowL').hidden = !(pumpSide === 'L' || pumpSide === 'B');
    $('pAmtRowR').hidden = !(pumpSide === 'R' || pumpSide === 'B');
    showPumpTotal();
  }
  // Amount pumped per breast (optional). oz steps by 0.25, mL by 1; both can be typed.
  const PUMP_UNITS = { oz: { step: 0.25, max: 20, label: 'oz' }, ml: { step: 1, max: 600, label: 'mL' } };
  let pumpUnit = 'oz', pAmt = { L: null, R: null };
  const roundPU = v => (pumpUnit === 'ml' ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100);
  function showPA(sd) {
    const el = $('pAmt' + sd);
    if (document.activeElement !== el) el.value = pAmt[sd] == null ? '' : fmtAmt(pAmt[sd], pumpUnit);
    el.style.width = Math.max(3, el.value.length + 0.6) + 'ch';
    showPumpTotal();
  }
  function setPA(sd, v) {
    pAmt[sd] = v == null || !isFinite(v) ? null : Math.max(0, Math.min(PUMP_UNITS[pumpUnit].max, roundPU(v)));
    showPA(sd);
  }
  function stepPA(sd, dir) {
    const cur = pAmt[sd] == null ? 0 : pAmt[sd];
    const next = cur + dir * PUMP_UNITS[pumpUnit].step;
    setPA(sd, next <= 0 && dir < 0 ? null : next);
  }
  function showPumpTotal() {
    const box = $('pAmtTotal');
    const both = pumpSide === 'B' && pAmt.L != null && pAmt.R != null;
    box.hidden = !both;
    if (both) box.textContent = 'Total ' + fmtAmt(pAmt.L + pAmt.R, pumpUnit) + ' ' + PUMP_UNITS[pumpUnit].label;
  }
  function setPumpUnit(u) {
    const next = u === 'ml' ? 'ml' : 'oz';
    if (next !== pumpUnit) ['L', 'R'].forEach(sd => {
      if (pAmt[sd] != null) pAmt[sd] = next === 'ml' ? Math.round(pAmt[sd] * ML_PER_OZ) : Math.round(pAmt[sd] / ML_PER_OZ * 4) / 4;
    });
    pumpUnit = next;
    $('pUnitOz').setAttribute('aria-pressed', String(pumpUnit === 'oz'));
    $('pUnitMl').setAttribute('aria-pressed', String(pumpUnit === 'ml'));
    document.querySelectorAll('#sheet-pump .pu').forEach(x => { x.textContent = PUMP_UNITS[pumpUnit].label; });
    showPA('L'); showPA('R');
  }
  function readPumpInputs() {
    ['L', 'R'].forEach(sd => {
      const raw = $('pAmt' + sd).value.trim();
      setPA(sd, raw === '' ? null : parseFloat(raw));
    });
  }
  $('pUnitOz').addEventListener('click', () => setPumpUnit('oz'));
  $('pUnitMl').addEventListener('click', () => setPumpUnit('ml'));
  ['L', 'R'].forEach(sd => {
    const el = $('pAmt' + sd);
    el.addEventListener('input', () => {
      el.value = el.value.replace(',', '.').replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
      el.style.width = Math.max(3, el.value.length + 0.6) + 'ch';
      const v = parseFloat(el.value);
      pAmt[sd] = el.value === '' ? null : isFinite(v) ? Math.min(PUMP_UNITS[pumpUnit].max, roundPU(v)) : pAmt[sd];
      showPumpTotal();
    });
    el.addEventListener('focus', () => setTimeout(() => el.select(), 0));
    el.addEventListener('blur', () => showPA(sd));
    el.addEventListener('keydown', e => { if (e.key === 'Enter') el.blur(); });
    holdRepeat($('pAmt' + sd + 'Minus'), () => stepPA(sd, -1));
    holdRepeat($('pAmt' + sd + 'Plus'), () => stepPA(sd, 1));
  });

  function resetPump() {
    setPumpSide(prefs.pumpSide);
    setPumpMin(prefs.pumpMin || 15);
    setWhen('pump', 0);
    $('pumpLabel').value = '';
    resetNote('pump');
    pAmt = { L: null, R: null };
    setPumpUnit(prefs.pumpUnit || prefs.unit || 'oz');
  }
  document.querySelectorAll('[data-pside]').forEach(b => b.addEventListener('click', () => setPumpSide(b.dataset.pside)));
  document.querySelectorAll('[data-pmin]').forEach(c => c.addEventListener('click', () => setPumpMin(Number(c.dataset.pmin))));
  holdRepeat($('pumpMinus'), () => setPumpMin(pumpMin - 1));
  holdRepeat($('pumpPlus'), () => setPumpMin(pumpMin + 1));
  $('pumpSave').addEventListener('click', () => {
    if (!pumpSide) return;
    prefs.pumpSide = pumpSide; prefs.pumpMin = pumpMin; savePrefs();
    readPumpInputs();
    prefs.pumpUnit = pumpUnit; savePrefs();
    addEntry({ type: 'pump', t: whenOf('pump'), side: pumpSide, minutes: pumpMin, label: $('pumpLabel').value.trim().slice(0, 60), note: noteOf('pump'),
      leftAmt: pumpSide !== 'R' ? pAmt.L : null, rightAmt: pumpSide !== 'L' ? pAmt.R : null, pumpUnit: pumpUnit });
    closeSheet();
  });

  /* Diaper */
  let kind = null;
  function resetDiaper() {
    kind = null; $('diaperSave').disabled = true;
    document.querySelectorAll('[data-kind]').forEach(k => k.setAttribute('aria-pressed', 'false'));
    setWhen('diaper', 0);
  }
  document.querySelectorAll('[data-kind]').forEach(k => k.addEventListener('click', () => {
    kind = k.dataset.kind; $('diaperSave').disabled = false;
    document.querySelectorAll('[data-kind]').forEach(x => x.setAttribute('aria-pressed', String(x === k)));
  }));
  $('diaperSave').addEventListener('click', () => { if (!kind) return; addEntry({ type: 'diaper', t: whenOf('diaper'), kind: kind, note: noteOf('diaper') }); closeSheet(); });

  /* ================================================================ */
  /* Small DOM helper                                                  */
  /* ================================================================ */
  function h(tag, attrs, kids) {
    const el = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === 'text') el.textContent = v;
      else if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(c => c && el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return el;
  }

  /* ================================================================ */
  /* Settings and people                                               */
  /* ================================================================ */
  let settingsView = 'main';
  let lastInvite = null;

  function renderSettings(view) {
    settingsView = view || 'main';
    const body = $('settingsBody');
    body.textContent = '';
    const admin = auth && auth.role === 'admin';

    if (settingsView === 'invite') { $('settingsTitle').textContent = 'Invite someone'; return renderInviteForm(body); }
    if (settingsView === 'invited') { $('settingsTitle').textContent = 'Invite ready'; return renderInviteResult(body); }
    $('settingsTitle').textContent = 'Settings';

    body.appendChild(h('div', { class: 'me' }, [
      h('span', { class: 'avatar', text: initial(auth.name) }),
      h('div', {}, [h('b', { text: auth.name }), h('span', { text: admin ? 'Can invite and remove people' : 'Can log and see entries' })])
    ]));

    if (admin) {
      body.appendChild(h('button', { class: 'primary feed', type: 'button', text: 'Invite someone', onclick: () => renderSettings('invite') }));
      const people = h('div', { class: 'list' }, [h('div', { class: 'empty', text: 'Loading people...' })]);
      body.appendChild(h('div', { class: 'field-label', text: 'People with access' }));
      body.appendChild(people);
      loadPeople(people);
    }

    if (!isStandalone()) {
      body.appendChild(h('button', { class: 'secondary', type: 'button', text: 'Add Baby Log to your Home Screen', onclick: () => openInstall(false) }));
    }

    const out = h('div', { class: 'row-actions' });
    const signout = h('button', { class: 'ghost danger', type: 'button', text: 'Sign out of this phone' });
    signout.addEventListener('click', () => {
      out.textContent = '';
      out.appendChild(h('div', { class: 'notice', text: 'This phone will lose access. You will need a new invite to sign back in.' }));
      out.appendChild(h('div', { class: 'btn-row' }, [
        h('button', { class: 'secondary', type: 'button', text: 'Cancel', onclick: () => renderSettings() }),
        h('button', { class: 'primary', type: 'button', text: 'Sign out', onclick: async () => {
          try { await api('signout'); } catch (e) { /* sign out locally anyway */ }
          lockedOut(true);
        } })
      ]));
    });
    out.appendChild(signout);
    body.appendChild(out);
  }

  async function loadPeople(box) {
    try {
      const j = await api('people');
      box.textContent = '';
      j.devices.sort((a, b) => (b.isMe - a.isMe) || a.name.localeCompare(b.name)).forEach(d => box.appendChild(personRow(d, false)));
      j.invites.forEach(inv => box.appendChild(personRow(inv, true)));
      if (!j.devices.length && !j.invites.length) box.appendChild(h('div', { class: 'empty', text: 'No one yet' }));
    } catch (e) {
      box.textContent = '';
      box.appendChild(h('div', { class: 'empty', text: e.code === 'offline' ? 'Connect to the internet to see who has access.' : e.message }));
    }
  }

  function personRow(p, isInvite) {
    const name = h('b', { text: p.name });
    if (p.isMe) name.appendChild(h('span', { class: 'tagline', text: 'This phone' }));
    if (p.role === 'admin') name.appendChild(h('span', { class: 'tagline', text: 'Manager' }));
    const sub = isInvite
      ? 'Invite not used yet · expires ' + fmtDay(p.expires) + ' ' + fmtTime(p.expires)
      : p.lastUsed ? 'Active ' + ago(p.lastUsed).toLowerCase() : 'Not used yet';
    const row = h('div', { class: 'person' }, [
      h('span', { class: 'avatar', text: initial(p.name) }),
      h('div', { class: 'grow' }, [name, h('span', { text: sub })])
    ]);
    if (!p.isMe) {
      const btn = h('button', { class: 'btn-sm del', type: 'button', text: isInvite ? 'Cancel' : 'Remove' });
      btn.addEventListener('click', () => {
        btn.replaceWith(h('div', { class: 'chips' }, [
          h('button', { class: 'btn-sm del', type: 'button', text: isInvite ? 'Cancel invite' : 'Remove ' + p.name, onclick: async () => {
            try {
              await api('revoke', isInvite ? { inviteId: p.inviteId } : { deviceId: p.deviceId });
              toast(isInvite ? 'Invite cancelled' : p.name + ' no longer has access');
              row.remove();
            } catch (e) { toast(e.message); }
          } }),
          h('button', { class: 'btn-sm', type: 'button', text: 'Keep', onclick: () => renderSettings() })
        ]));
      });
      row.appendChild(btn);
    }
    return row;
  }

  function renderInviteForm(body) {
    const name = h('input', { class: 'text', id: 'inviteName', type: 'text', placeholder: 'Their name, for example Night nurse', autocomplete: 'off', maxlength: '40' });
    const adminBox = h('input', { type: 'checkbox', id: 'inviteAdmin' });
    const err = h('div', { class: 'error', hidden: true });
    const create = h('button', { class: 'primary feed', type: 'button', text: 'Create invite link' });
    create.addEventListener('click', async () => {
      if (!name.value.trim()) { err.textContent = 'Enter a name.'; err.hidden = false; return; }
      create.disabled = true; create.textContent = 'Creating...';
      try {
        lastInvite = await api('invite', { name: name.value.trim(), role: adminBox.checked ? 'admin' : 'member' });
        renderSettings('invited');
      } catch (e) {
        err.textContent = e.code === 'offline' ? 'No connection. Try again when you are online.' : e.message; err.hidden = false;
        create.disabled = false; create.textContent = 'Create invite link';
      }
    });
    body.append(
      h('div', { class: 'field-label', text: 'Name' }), name,
      h('label', { class: 'switch', for: 'inviteAdmin' }, ['Can invite and remove people', adminBox]),
      h('p', { class: 'muted', text: 'The link works once and expires in 3 days if it is not used.' }),
      err, create,
      h('button', { class: 'ghost', type: 'button', text: 'Back', onclick: () => renderSettings() })
    );
    setTimeout(() => name.focus(), 250);
  }

  function renderInviteResult(body) {
    const inv = lastInvite;
    const text = 'You are invited to Baby Log. Open this link on your phone. It works once: ' + inv.link;
    const actions = h('div', { class: 'btn-row' });
    if (navigator.share) {
      actions.appendChild(h('button', { class: 'primary feed', type: 'button', text: 'Share', onclick: () => navigator.share({ title: 'Baby Log invite', text: text }).catch(() => {}) }));
    }
    actions.appendChild(h('button', { class: navigator.share ? 'secondary' : 'primary feed', type: 'button', text: 'Copy link', onclick: () => {
      (navigator.clipboard ? navigator.clipboard.writeText(inv.link) : Promise.reject()).then(() => toast('Link copied'), () => {
        const r = document.createRange(); r.selectNodeContents(box); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        toast('Link selected. Copy it from the menu.');
      });
    } }));
    if (!navigator.share) actions.style.gridTemplateColumns = '1fr';
    const box = h('div', { class: 'linkbox', text: inv.link });
    body.append(
      h('p', { class: 'muted', text: 'Send this to ' + inv.name + '. It works once and expires ' + fmtDay(inv.expires) + ' at ' + fmtTime(inv.expires) + '. A forwarded or reused copy will not work.' }),
      box, actions,
      h('button', { class: 'ghost', type: 'button', text: 'Done', onclick: () => renderSettings() })
    );
  }

  /* ================================================================ */
  /* Install (Home Screen) and setup codes                             */
  /* ================================================================ */
  function openInstall(afterJoin) {
    open('install');
    const body = $('installBody');
    body.textContent = '';
    if (isIOS) {
      body.append(
        h('p', { class: 'muted', text: afterJoin
          ? 'You are in. To open Baby Log like an app, add it to your Home Screen. It takes a few seconds.'
          : 'Open Baby Log like an app, straight from your Home Screen.' }),
        h('ol', { class: 'steps' }, [
          h('li', {}, [h('span', {}, ['Tap ', svgUse('i-share'), ' Share at the bottom of Safari.'])]),
          h('li', {}, [h('span', {}, ['Tap ', svgUse('i-plus'), ' Add to Home Screen, then Add.'])]),
          h('li', {}, [h('span', {}, ['Open Baby Log from your Home Screen and type this setup code:'])])
        ])
      );
      const code = h('div', { class: 'bigcode num', text: '····-····' });
      const note = h('p', { class: 'muted', text: 'Getting a code...' });
      body.append(code, note, h('button', { class: 'ghost', type: 'button', text: 'Not now', onclick: closeSheet }));
      api('pair').then(j => {
        code.textContent = j.code;
        note.textContent = 'The code works once and expires at ' + fmtTime(j.expires) + '. You can keep using Baby Log here in Safari too.';
      }).catch(e => { code.textContent = 'No code'; note.textContent = e.code === 'offline' ? 'No connection. Try again when you are online.' : e.message; });
    } else {
      body.append(h('p', { class: 'muted', text: afterJoin ? 'You are in. Add Baby Log to your Home Screen to open it like an app.' : 'Open Baby Log like an app, straight from your Home Screen.' }));
      if (installPrompt) {
        body.append(h('button', { class: 'primary feed', type: 'button', text: 'Install Baby Log', onclick: async () => {
          installPrompt.prompt();
          try { await installPrompt.userChoice; } catch (e) {}
          installPrompt = null; closeSheet();
        } }));
      } else {
        body.append(h('ol', { class: 'steps' }, [
          h('li', {}, [h('span', {}, ['In Chrome, tap ', svgUse('i-dots'), ' the menu at the top right.'])]),
          h('li', {}, [h('span', {}, ['Tap Add to Home screen or Install app.'])])
        ]));
      }
      body.append(h('button', { class: 'ghost', type: 'button', text: 'Not now', onclick: closeSheet }));
    }
  }
  function svgUse(id) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    u.setAttribute('href', '#' + id); s.appendChild(u); return s;
  }

  /* ================================================================ */
  /* Join screen                                                       */
  /* ================================================================ */
  function showJoin(mode, inviteCode) {
    $('screen-home').hidden = true;
    $('screen-join').hidden = false;
    closeSheet();
    const body = $('joinBody');
    body.textContent = '';

    if (!CFG.apiUrl) {
      body.append(h('h2', { text: 'Baby Log is almost ready' }), h('p', { text: 'It is not connected to the sheet yet. Check back soon.' }));
      return;
    }

    if (mode === 'invite') {
      body.append(h('h2', { text: 'Checking your invite...' }));
      api('peek', { code: inviteCode }).then(j => {
        body.textContent = '';
        const inv = j.invite;
        const name = h('input', { class: 'text', id: 'joinName', type: 'text', value: inv.name, autocomplete: 'name', maxlength: '40' });
        const err = h('div', { class: 'error', hidden: true });
        const btn = h('button', { class: 'primary feed', type: 'button', text: 'Join Baby Log' });
        btn.addEventListener('click', () => redeem(inviteCode, name.value.trim(), btn, err));
        body.append(
          h('h2', { text: inv.from ? inv.from + ' invited you to Baby Log' : 'You are invited to Baby Log' }),
          h('p', { text: 'Log feeds, bottles and diapers. Everyone you share with sees the same timeline.' }),
          h('div', { class: 'field-label', text: 'Your name' }), name, err, btn
        );
      }).catch(e => {
        body.textContent = '';
        body.append(h('h2', { text: e.code === 'offline' ? 'No connection' : 'This invite cannot be used' }),
          h('p', { text: e.code === 'offline' ? 'Connect to the internet, then open the invite link again.' : e.message }));
        if (e.code !== 'offline') body.append(codeEntry());
      });
      return;
    }

    if (mode === 'removed') {
      body.append(h('h2', { text: 'This phone no longer has access' }),
        h('p', { text: 'Ask the person who manages Baby Log to send you a new invite link.' }));
      return;
    }

    body.append(h('h2', { text: 'Welcome to Baby Log' }),
      h('p', { text: isStandalone()
        ? 'Type the setup code shown in Safari, or open your invite link.'
        : 'Open the invite link you were sent. If you were given a setup code, type it below.' }),
      codeEntry());
  }

  function codeEntry() {
    const wrap = h('div', { class: 'pane' });
    const input = h('input', { class: 'text code', id: 'setupCode', type: 'text', placeholder: 'XXXX-XXXX', autocomplete: 'one-time-code', autocapitalize: 'characters', maxlength: '9', inputmode: 'text' });
    const err = h('div', { class: 'error', hidden: true });
    const btn = h('button', { class: 'primary feed', type: 'button', text: 'Continue' });
    btn.addEventListener('click', () => {
      const c = input.value.replace(/[^A-Za-z0-9]/g, '');
      if (c.length !== 8) { err.textContent = 'The setup code has 8 letters and numbers.'; err.hidden = false; return; }
      redeem(c, '', btn, err);
    });
    wrap.append(h('div', { class: 'field-label', text: 'Setup code' }), input, err, btn);
    return wrap;
  }

  async function redeem(code, name, btn, err) {
    btn.disabled = true; const label = btn.textContent; btn.textContent = 'Joining...'; err.hidden = true;
    try {
      const j = await api('redeem', { code: code, name: name });
      auth = { token: j.token, name: j.me.name, role: j.me.role, deviceId: j.me.deviceId };
      store(K.AUTH, auth);
      entries = []; outbox = []; saveEntries(); saveOutbox();
      showHome();
      if (!isStandalone()) setTimeout(() => openInstall(true), 600);
    } catch (e) {
      err.textContent = e.code === 'offline' ? 'No connection. Try again when you are online.' : e.message;
      err.hidden = false; btn.disabled = false; btn.textContent = label;
    }
  }

  function lockedOut(byChoice) {
    auth = null; entries = []; outbox = []; active = null;
    [K.AUTH, K.ENTRIES, K.OUTBOX, K.ACTIVE].forEach(drop);
    showJoin(byChoice ? 'welcome' : 'removed');
  }

  function showHome() {
    $('screen-join').hidden = true;
    $('screen-home').hidden = false;
    setMode(true);
    render(); setSync();
    refresh();
  }

  /* ================================================================ */
  /* Stats: per-day totals and charts                                  */
  /* ================================================================ */
  let statRange = 7, statSel = null;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const DAY = 86400000;
  const dayStart = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); };

  function dailyStats(range) {
    const today = dayStart(Date.now());
    const first = entries.length ? dayStart(Math.min.apply(null, entries.map(e => e.t))) : today;
    const days = [];
    for (let i = range - 1; i >= 0; i--) {
      const start = addDays(today, -i);
      days.push({ start: start, end: addDays(start, 1), isToday: i === 0, before: start < first,
        wet: 0, dirty: 0, breast: 0, bottles: 0, oz: 0, breastMin: 0 });
    }
    entries.forEach(e => {
      const d = days.find(x => e.t >= x.start && e.t < x.end);
      if (!d) return;
      if (e.type === 'diaper') { if (e.kind !== 'dirty') d.wet++; if (e.kind !== 'wet') d.dirty++; }
      else if (e.type === 'breast') { d.breast++; d.breastMin += (e.left || 0) + (e.right || 0); }
      else if (e.type === 'bottle') { d.bottles++; d.oz += e.oz || 0; }
    });
    return days;
  }

  const useMl = () => prefs.unit === 'ml';
  const volOf = oz => (useMl() ? Math.round(oz * ML_PER_OZ) : Math.round(oz * 10) / 10);
  const volUnit = () => (useMl() ? 'mL' : 'oz');
  const shortDay = t => new Date(t).toLocaleDateString([], { weekday: 'short' });
  const mdDay = t => { const d = new Date(t); return (d.getMonth() + 1) + '/' + d.getDate(); };
  const longDay = t => new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

  function niceMax(v) {
    if (v <= 0) return 4;
    const steps = [1, 2, 2.5, 4, 5, 10];
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    for (const st of steps) { const m = st * mag; if (m >= v) return m; }
    return 10 * mag;
  }
  function el(tag, attrs, parent) {
    const n = document.createElementNS(SVGNS, tag);
    Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
    if (parent) parent.appendChild(n);
    return n;
  }
  // Bar with a 4px rounded top and a square base
  function barPath(x, y, w, h, round) {
    if (h <= 0) return '';
    const r = round ? Math.min(4, h, w / 2) : 0;
    return 'M' + x + ',' + (y + h) + 'V' + (y + r) + (r ? 'Q' + x + ',' + y + ' ' + (x + r) + ',' + y : '') +
      'H' + (x + w - r) + (r ? 'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) : '') + 'V' + (y + h) + 'Z';
  }

  // series: [{ color, get(day) }] stacked bottom to top; label(day) gives the selected bar's tip label
  function drawBars(svg, days, series, height, label, showX) {
    const W = Math.max(260, svg.clientWidth || svg.parentNode.clientWidth || 300);
    const padL = 30, padR = 6, padT = 18, padB = showX ? 22 : 6;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + height);
    svg.setAttribute('height', height);
    svg.textContent = '';
    const plotW = W - padL - padR, plotH = height - padT - padB;
    const totals = days.map(d => series.reduce((s, se) => s + se.get(d), 0));
    const max = niceMax(Math.max.apply(null, totals));
    const y = v => padT + plotH - (v / max) * plotH;
    const band = plotW / days.length;
    const bw = Math.min(24, band * 0.62);

    const selIdx = days.findIndex(d => d.start === statSel);
    if (selIdx >= 0) el('rect', { class: 'sel', x: padL + selIdx * band + 1, y: padT - 14, width: band - 2, height: plotH + 14, rx: 6 }, svg);

    [0, max / 2, max].forEach(v => {
      el('line', { class: 'grid', x1: padL, x2: W - padR, y1: y(v), y2: y(v) }, svg);
      const t = el('text', { x: padL - 6, y: y(v) + 4, 'text-anchor': 'end' }, svg);
      t.textContent = +v.toFixed(1);
    });

    days.forEach((d, i) => {
      const x = padL + i * band + (band - bw) / 2;
      if (!d.before) {
        let base = 0;
        const parts = series.map(se => se.get(d));
        const topIdx = parts.reduce((k, v, j) => (v > 0 ? j : k), -1);
        parts.forEach((v, j) => {
          if (v <= 0) return;
          const y0 = y(base), y1 = y(base + v);
          const gap = base > 0 ? 2 : 0;   // 2px surface gap between stacked segments
          const p = el('path', { d: barPath(x, y1, bw, y0 - y1 - gap, j === topIdx), fill: series[j].color }, svg);
          if (d.isToday) p.setAttribute('opacity', '0.55');
          base += v;
        });
        if (i === selIdx) {
          const t = el('text', { class: 'val', x: x + bw / 2, y: y(totals[i]) - 5, 'text-anchor': 'middle' }, svg);
          t.textContent = label(d);
        }
      }
      if (showX) {
        const every = days.length > 14 ? 5 : days.length > 7 ? 2 : 1;
        if ((days.length - 1 - i) % every === 0) {
          const last = i === days.length - 1 && days.length > 7;   // keep 'Today' inside the chart
          const t = el('text', { x: last ? W - padR : x + bw / 2, y: height - 6, 'text-anchor': last ? 'end' : 'middle' }, svg);
          t.textContent = d.isToday ? 'Today' : days.length > 7 ? mdDay(d.start) : shortDay(d.start);
        }
      }
      const hit = el('rect', { class: 'hit', x: padL + i * band, y: 0, width: band, height: height }, svg);
      hit.addEventListener('click', () => { statSel = d.start; renderStats(); });
      const tip = el('title', {}, hit);
      tip.textContent = longDay(d.start);
    });
  }

  function renderStats() {
    const days = dailyStats(statRange);
    if (statSel == null || !days.some(d => d.start === statSel)) statSel = days[days.length - 1].start;
    $('rng7').setAttribute('aria-pressed', String(statRange === 7));
    $('rng14').setAttribute('aria-pressed', String(statRange === 14));
    $('rng30').setAttribute('aria-pressed', String(statRange === 30));

    // Averages over complete days that have data (today is still in progress)
    const full = days.filter(d => !d.isToday && !d.before);
    const avg = f => (full.length ? full.reduce((s, d) => s + f(d), 0) / full.length : null);
    const fmtAvg = v => (v == null ? '–' : String(+v.toFixed(1)));
    const aFeeds = avg(d => d.breast + d.bottles), aWet = avg(d => d.wet), aDirty = avg(d => d.dirty), aOz = avg(d => d.oz);
    const tiles = [[fmtAvg(aFeeds), 'Feeds'], [aOz == null ? '–' : String(volOf(aOz)), volUnit() + ' bottle'], [fmtAvg(aWet), 'Wet'], [fmtAvg(aDirty), 'Dirty']];
    const tbox = $('stTiles'); tbox.textContent = '';
    tiles.forEach(([v, l]) => tbox.appendChild(h('div', { class: 'st-tile' }, [h('b', { class: 'num', text: v }), h('span', { text: l })])));
    $('stNote').textContent = full.length
      ? 'Daily averages over ' + full.length + ' full day' + (full.length === 1 ? '' : 's') + '. Today is shown lighter because it is still going.'
      : 'Averages appear after the first full day. Today is shown lighter because it is still going.';
    $('stIntakeAvg').textContent = aFeeds == null ? '' : 'avg ' + fmtAvg(aFeeds) + ' feeds/day';
    $('stWetAvg').textContent = aWet == null ? '' : 'avg ' + fmtAvg(aWet) + '/day';
    $('stDirtyAvg').textContent = aDirty == null ? '' : 'avg ' + fmtAvg(aDirty) + '/day';
    $('stOzTitle').textContent = 'Bottle ' + volUnit() + ' per day';

    const css = getComputedStyle(document.documentElement);
    const C = k => css.getPropertyValue(k).trim();
    drawBars($('chFeeds'), days, [{ color: C('--c-breast'), get: d => d.breast }, { color: C('--c-bottle'), get: d => d.bottles }], 140, d => String(d.breast + d.bottles), false);
    drawBars($('chOz'), days, [{ color: C('--c-bottle'), get: d => volOf(d.oz) }], 110, d => String(volOf(d.oz)), true);
    drawBars($('chWet'), days, [{ color: C('--c-diaper'), get: d => d.wet }], 120, d => String(d.wet), true);
    drawBars($('chDirty'), days, [{ color: C('--c-diaper'), get: d => d.dirty }], 120, d => String(d.dirty), true);

    const sel = days.find(d => d.start === statSel);
    const when = sel.isToday ? 'Today so far' : longDay(sel.start);
    const setDetail = (id, main, rest) => { const b = $(id); b.textContent = main + ' '; if (rest) b.appendChild(h('span', { text: rest })); };
    const feeds = sel.breast + sel.bottles;
    setDetail('stIntakeDetail', when + ': ' + feeds + ' feed' + (feeds === 1 ? '' : 's'),
      '(' + sel.breast + ' breastfeed' + (sel.breast === 1 ? '' : 's') + ', ' + sel.breastMin + ' min · ' +
      sel.bottles + ' bottle' + (sel.bottles === 1 ? '' : 's') + ', ' + volOf(sel.oz) + ' ' + volUnit() + ')');
    setDetail('stWetDetail', when + ': ' + sel.wet + ' wet', '');
    setDetail('stDirtyDetail', when + ': ' + sel.dirty + ' dirty', '');

    const rows = days.slice().reverse().filter(d => !d.before);
    const table = h('table', {}, [
      h('thead', {}, [h('tr', {}, ['Day', 'Feeds', 'Breast min', 'Bottle ' + volUnit(), 'Wet', 'Dirty'].map(t => h('th', { text: t })))]),
      h('tbody', {}, rows.map(d => h('tr', {}, [d.isToday ? 'Today' : longDay(d.start), d.breast + d.bottles, d.breastMin, volOf(d.oz), d.wet, d.dirty]
        .map(v => h('td', { text: String(v) })))))
    ]);
    $('stTable').textContent = ''; $('stTable').appendChild(table);
  }
  $('rng7').addEventListener('click', () => { statRange = 7; renderStats(); });
  $('rng14').addEventListener('click', () => { statRange = 14; renderStats(); });
  $('rng30').addEventListener('click', () => { statRange = 30; renderStats(); });
  window.addEventListener('resize', () => { if (openSheet === $('sheet-stats')) renderStats(); });

  /* ================================================================ */
  /* Start                                                             */
  /* ================================================================ */
  const params = new URLSearchParams(location.hash.slice(1));
  const inviteCode = params.get('invite');
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);

  if (inviteCode && !auth) showJoin('invite', inviteCode);
  else if (auth) {
    showHome();
    if (inviteCode) toast('This phone is already set up as ' + auth.name);
  } else showJoin('welcome');

  setInterval(() => { if (auth && document.visibilityState === 'visible') refresh(); }, 45000);
  setInterval(render, 30000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  window.addEventListener('online', () => { online = true; refresh(); });
})();
