/* Baby Log app. Talks to the Apps Script attached to the Baby Log Google Sheet. */
(function () {
  'use strict';

  const CFG = window.BABYLOG_CONFIG || {};
  const MIN = 60000;
  const $ = id => document.getElementById(id);
  const K = { AUTH: 'bl.auth', ENTRIES: 'bl.entries', OUTBOX: 'bl.outbox', ACTIVE: 'bl.active' };

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
  let flushing = false, online = true, lastSync = 0;

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
          } else {
            await api('delete', { id: op.id });
          }
          outbox.shift(); saveOutbox(); saveEntries();
          online = true;
        } catch (err) {
          if (err.code === 'bad_request' || err.code === 'forbidden') {
            outbox.shift(); saveOutbox();
            if (op.op === 'add') { entries = entries.filter(x => x.id !== op.entry.id); saveEntries(); }
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
    if (e.type === 'bottle') return { icon: 'bottle', cls: 'i-bottle', t1: 'Bottle', t2: e.oz + ' oz' + by };
    return { icon: e.kind, cls: 'i-diaper', t1: kindName[e.kind] + ' diaper', t2: 'Diaper' + by };
  }

  /* ================================================================ */
  /* Home render                                                       */
  /* ================================================================ */
  let openItem = null;

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
        ? 'Bottle ' + lastFeed.oz + ' oz at ' + fmtTime(lastFeed.t)
        : sideParts(lastFeed) + ' at ' + fmtTime(lastFeed.t);
    } else { $('lastFeedAgo').textContent = 'None yet'; $('lastFeedSub').textContent = 'Tap Breastfeed or Bottle to log one'; }
    const next = lastBreast ? other(lastBreast.last) : null;
    $('nextSide').hidden = !next;
    if (next) $('nextSide').textContent = 'Next: ' + sideName(next) + ' side';

    if (lastDiaper) {
      $('lastDiaperAgo').textContent = ago(lastDiaper.t);
      $('lastDiaperSub').textContent = kindName[lastDiaper.kind] + ' at ' + fmtTime(lastDiaper.t);
    } else { $('lastDiaperAgo').textContent = 'None yet'; $('lastDiaperSub').textContent = 'Tap Diaper to log one'; }

    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const today = sorted.filter(e => e.t >= midnight.getTime());
    const breastMin = today.filter(e => e.type === 'breast').reduce((s, e) => s + (e.left || 0) + (e.right || 0), 0);
    const bottles = today.filter(e => e.type === 'bottle');
    $('tFeeds').textContent = today.filter(e => e.type !== 'diaper').length;
    $('tFeedMin').textContent = breastMin + ' min';
    $('tOz').textContent = +bottles.reduce((s, e) => s + (e.oz || 0), 0).toFixed(2);
    $('tBottles').textContent = bottles.length + (bottles.length === 1 ? ' bottle' : ' bottles');
    $('tWet').textContent = today.filter(e => e.kind === 'wet' || e.kind === 'both').length;
    $('tDirty').textContent = today.filter(e => e.kind === 'dirty' || e.kind === 'both').length;

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
      const whenEl = b.querySelector('.when');
      whenEl.textContent = fmtTime(e.t);
      if (e.type === 'breast') {
        const tot = (e.left || 0) + (e.right || 0);
        if (tot) { const sm = document.createElement('small'); sm.textContent = 'to ' + fmtTime(e.t + tot * MIN); whenEl.appendChild(sm); }
        b.querySelector('.txt').appendChild(splitBar(e));
      }
      b.addEventListener('click', () => { openItem = openItem === e.id ? null : e.id; render(); });
      wrap.appendChild(b);
      if (openItem === e.id) {
        const tools = document.createElement('div'); tools.className = 'item-tools';
        const del = document.createElement('button'); del.type = 'button'; del.className = 'del'; del.textContent = 'Delete';
        del.addEventListener('click', () => removeEntry(e.id));
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
        cancel.addEventListener('click', () => { openItem = null; render(); });
        tools.append(del, cancel); wrap.appendChild(tools);
      }
      tl.appendChild(wrap);
    });
    renderLive();
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
    if (name === 'diaper') resetDiaper();
    if (name === 'bottle') setWhen('bottle', 0);
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
      active = { start: now, first: s, side: s, running: true, segStart: now, left: 0, right: 0 };
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
    addEntry({ type: 'breast', t: a.start, left: left, right: right, first: first, last: last });
    closeSheet();
  });
  $('feedDiscard').addEventListener('click', () => { active = null; saveActive(); renderTimer(); renderLive(); toast('Feed discarded'); });
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
    addEntry({ type: 'breast', t: whenOf('manual'), left: manual.L, right: manual.R, first: first, last: last });
    closeSheet();
  });

  /* Bottle */
  let oz = 2;
  const setOz = v => { oz = Math.max(0.5, Math.min(10, Math.round(v * 2) / 2)); $('ozVal').textContent = oz; };
  $('ozMinus').addEventListener('click', () => setOz(oz - 0.5));
  $('ozPlus').addEventListener('click', () => setOz(oz + 0.5));
  document.querySelectorAll('[data-oz]').forEach(c => c.addEventListener('click', () => setOz(Number(c.dataset.oz))));
  $('bottleSave').addEventListener('click', () => { addEntry({ type: 'bottle', t: whenOf('bottle'), oz: oz }); closeSheet(); });

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
  $('diaperSave').addEventListener('click', () => { if (!kind) return; addEntry({ type: 'diaper', t: whenOf('diaper'), kind: kind }); closeSheet(); });

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
