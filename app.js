/* Baby Log app. Talks to the Apps Script attached to the Baby Log Google Sheet. */
(function () {
  'use strict';

  const CFG = window.BABYLOG_CONFIG || {};
  const MIN = 60000;
  const $ = id => document.getElementById(id);
  const K = { AUTH: 'bl.auth', ENTRIES: 'bl.entries', OUTBOX: 'bl.outbox', ACTIVE: 'bl.active', PREFS: 'bl.prefs', SYNC: 'bl.sync', LONG: 'bl.longAck' };

  /* ================================================================ */
  /* Storage                                                           */
  /* ================================================================ */
  function load(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function drop(k) { try { localStorage.removeItem(k); } catch (e) {} }

  let auth = load(K.AUTH, null);           // { token, name, role, deviceId }
  let entries = load(K.ENTRIES, []);        // newest data we know about, including unsent entries
  let outbox = load(K.OUTBOX, []);          // steps waiting to be sent: add, edit, delete, note, endSleep, live
  let active = load(K.ACTIVE, null);        // the household's breastfeed timer, shared through the sheet
  // This phone's bottle settings: last unit, last amount per unit, last milk
  const prefs = Object.assign({ unit: 'oz', amount: { oz: 2, ml: 5 }, source: null, weightUnit: 'lb', tempUnit: 'F', feedHours: null }, load(K.PREFS, {}));

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
  const API_TIMEOUT = 15000;   // a stuck connection gives up and retries later instead of hanging
  async function api(action, payload) {
    if (!CFG.apiUrl) { const e = new Error('Baby Log is not connected to the sheet yet.'); e.code = 'not_configured'; throw e; }
    let res;
    const ctrl = window.AbortController ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), API_TIMEOUT) : null;
    try {
      res = await fetch(CFG.apiUrl, {
        method: 'POST',
        body: JSON.stringify(Object.assign({ action: action, token: auth ? auth.token : undefined }, payload || {})),
        redirect: 'follow', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
        signal: ctrl ? ctrl.signal : undefined
      });
    } catch (err) {
      clearTimeout(timer);
      const e = new Error(err && err.name === 'AbortError' ? 'The sheet took too long to answer' : 'No connection'); e.code = 'offline'; throw e;
    }
    let j;
    try { j = await res.json(); } catch (err) { const e = new Error('The sheet did not answer. Try again.'); e.code = 'offline'; throw e; }
    finally { clearTimeout(timer); }
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
  // Every change is saved on the phone first, then sent in order from the outbox. One that keeps
  // failing waits and retries on its own (5 s, 10 s, 20 s ... up to 5 min) without holding up the rest.
  let flushing = false, online = true, lastSync = 0, refreshSoon = false, inflight = null;
  let localRev = 0;                         // goes up with every change made on this phone
  let syncedAt = load(K.SYNC, 0);           // server time of the last list, for change-only syncs
  let lastFull = 0, polls = 0;
  const touch = () => { localRev++; };
  const opId = o => o.id || (o.entry && o.entry.id) || (o.op === 'live' ? 'live' : '');

  function setSync() {
    const el = $('sync');
    if (!el) return;
    let state = 'ok', text = 'Saved';
    const stuck = outbox.some(o => o.tries);
    if (flushing) { state = 'saving'; text = 'Saving'; }
    else if (!online) { state = 'offline'; text = outbox.length ? 'Offline · ' + outbox.length + ' waiting' : 'Offline'; }
    else if (outbox.length) { state = stuck ? 'offline' : 'saving'; text = outbox.length + ' waiting'; }
    el.dataset.state = state;
    $('syncText').textContent = text;
    if (openSheet === $('sheet-sync')) renderSyncSheet();
  }

  async function sendOp(op) {
    const strip = e => { const c = Object.assign({}, e); delete c.pending; delete c.by; return c; };
    if (op.op === 'add') {
      await api('add', { entry: strip(op.entry) });
      const e = entries.find(x => x.id === op.entry.id);
      if (e && !outbox.some(o => o !== op && opId(o) === e.id)) delete e.pending;
    } else if (op.op === 'edit') {
      await api('edit', { entry: strip(op.entry) });
      const e = entries.find(x => x.id === op.entry.id);
      if (e && !outbox.some(o => o !== op && opId(o) === e.id)) delete e.pending;
    } else if (op.op === 'note') {
      await api('update', { id: op.id, note: op.note });
    } else if (op.op === 'endSleep') {
      const r = await api('endSleep', { id: op.id, end: op.end, reopen: !!op.reopen });
      // Someone else woke him up first: their time stands
      const e = entries.find(x => x.id === op.id);
      if (e && r.already) { e.end = r.end; e.minutes = r.minutes; toast('Already ended on another phone at ' + fmtTime(r.end)); }
    } else if (op.op === 'live') {
      const r = await api('live', { state: op.state, replace: !!op.replace });
      if (r.conflict && !outbox.some(o => o !== op && o.op === 'live')) {
        active = r.live; saveActive(); renderTimer(); renderLive();
        toast((r.live.by || 'Someone') + ' already started a feed. You are now seeing that one.');
      }
    } else {
      await api('delete', { id: op.id });
    }
  }

  // The next step to send: the first one for each entry, skipping any that already failed in this
  // round or are waiting to retry. A later step for the same entry waits behind an earlier one.
  function nextOp(tried) {
    const seen = new Set();
    for (const o of outbox) {
      const k = opId(o);
      if (seen.has(k)) continue;
      seen.add(k);
      if (tried.has(o) || (o.nextTry && o.nextTry > Date.now())) continue;
      return o;
    }
    return null;
  }

  async function flush() {
    if (flushing || !auth) return;
    flushing = true; setSync();
    const tried = new Set();
    try {
      let op;
      while (auth && (op = nextOp(tried))) {
        tried.add(op);
        inflight = op;
        try {
          await sendOp(op);
          const k = outbox.indexOf(op);
          if (k !== -1) outbox.splice(k, 1);
          saveOutbox(); saveEntries();
          online = true;
        } catch (err) {
          if (err.code === 'bad_request' || err.code === 'forbidden') {
            const k = outbox.indexOf(op);
            if (k !== -1) outbox.splice(k, 1);
            saveOutbox();
            if (op.op === 'live') continue;   // an older script without the shared timer: keep it on this phone
            if (op.op === 'add') { entries = entries.filter(x => x.id !== op.entry.id); saveEntries(); }
            else refreshSoon = true;
            toast("Couldn't save: " + err.message);
            continue;
          }
          if (err.code === 'unauthorized') break;
          if (err.code === 'offline' && !/too long/.test(err.message)) { online = false; break; }
          // A server hiccup or a slow answer: try this one again later, carry on with the rest
          op.tries = (op.tries || 0) + 1;
          op.lastError = err.message;
          op.nextTry = Date.now() + Math.min(300000, 5000 * Math.pow(2, op.tries - 1));
          saveOutbox();
        } finally {
          inflight = null;
        }
      }
    } finally {
      flushing = false; setSync(); render();
      if (refreshSoon) { refreshSoon = false; setTimeout(() => refresh(true), 500); }
      const next = outbox.filter(o => o.nextTry).map(o => o.nextTry).sort((x, y) => x - y)[0];
      clearTimeout(flush.retry);
      if (next && online) flush.retry = setTimeout(flush, Math.max(1000, next - Date.now() + 50));
    }
  }

  // Pulls entries from the sheet. Most polls ask only for what changed since the last one.
  let refreshing = null, again = false, againFull = false;
  function refresh(full) {
    if (refreshing) { again = true; againFull = againFull || !!full; return refreshing; }
    refreshing = doRefresh(!!full).finally(() => {
      refreshing = null;
      if (again) { const f = againFull; again = false; againFull = false; setTimeout(() => refresh(f), 300); }
    });
    return refreshing;
  }
  async function doRefresh(full) {
    if (!auth) return;
    await flush();
    if (!auth) return;
    polls++;
    const wantFull = full || !syncedAt || Date.now() - lastFull > 10 * 60000;
    const rev = localRev;
    let j;
    try {
      j = await api('list', wantFull ? {} : { since: syncedAt });
    } catch (err) {
      if (err.code === 'offline') online = false;
      setSync(); render();
      return;
    }
    // Something changed on this phone while the list was loading: that answer may predate the
    // change and would briefly undo it on screen. Ask again instead.
    if (localRev !== rev) { again = true; againFull = againFull || wantFull; return; }
    auth.name = j.me.name; auth.role = j.me.role; store(K.AUTH, auth);
    const pending = new Set(outbox.map(opId));
    if (j.delta) {
      const gone = new Set((j.deleted || []).filter(id => !pending.has(id)));
      entries = entries.filter(e => !gone.has(e.id));
      (j.entries || []).forEach(s => {
        if (pending.has(s.id)) return;
        const k = entries.findIndex(e => e.id === s.id);
        if (k === -1) entries.push(s); else entries[k] = s;
      });
      const cutoff = Date.now() - 31 * 86400000;
      entries = entries.filter(e => e.t >= cutoff || e.type === 'weight' || e.type === 'length' || pending.has(e.id));
    } else {
      // Local entries with unsent changes are the newest version; everything else comes from the sheet
      const mine = entries.filter(e => pending.has(e.id));
      entries = (j.entries || []).filter(s => !pending.has(s.id)).concat(mine);
      const del = new Set(outbox.filter(o => o.op === 'delete').map(o => o.id));
      entries = entries.filter(e => !del.has(e.id));
      lastFull = Date.now();
    }
    // The shared breastfeed timer: the sheet's copy wins unless this phone has a change waiting
    // (An older script that does not share the timer sends no "live"; the timer then stays on this phone.)
    if ('live' in j && !outbox.some(o => o.op === 'live')) {
      const sv = j.live || null;
      // A timer whose feed is already saved is over (unless it is adding to that saved feed)
      if (sv && !sv.continues && entries.some(e => e.id === sv.id)) { active = null; } else active = sv;
      saveActive();
    }
    syncedAt = j.syncedAt || Date.now(); store(K.SYNC, syncedAt);
    saveEntries();
    online = true; lastSync = Date.now();
    setSync(); render(); renderLive();
    if (openSheet === $('sheet-feed')) renderTimer();
  }

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const b = new Uint8Array(16); crypto.getRandomValues(b);
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  }
  // The not-yet-sent step for an entry that can still be changed in place (not the one being sent)
  const pendingOp = (id, kind) => outbox.find(o => o.op === kind && opId(o) === id && o !== inflight);
  const saveAll = () => { saveEntries(); saveOutbox(); render(); setSync(); };

  function addEntry(e, opts) {
    e.id = e.id || newId();
    e.by = auth ? auth.name : '';
    e.pending = true;
    entries.push(e);
    outbox.push({ op: 'add', entry: e });
    touch(); saveAll();
    if (!(opts && opts.quiet)) toast((opts && opts.msg) || describe(e).t1 + ' saved', () => removeEntry(e.id, { quiet: true }));
    flush();
  }

  // Replaces an entry's details. Who logged it stays the same.
  function editEntry(e, opts) {
    const i = entries.findIndex(x => x.id === e.id);
    if (i === -1) return;
    const before = Object.assign({}, entries[i]);
    e.by = before.by;
    if (e.note == null) e.note = before.note || '';
    e.pending = true;
    entries[i] = e;
    const add = pendingOp(e.id, 'add');
    if (add) add.entry = e;
    else {
      outbox = outbox.filter(o => !(opId(o) === e.id && (o.op === 'edit' || o.op === 'note' || o.op === 'endSleep') && o !== inflight));
      outbox.push({ op: 'edit', entry: e });
    }
    touch(); saveAll();
    if (!(opts && opts.quiet)) toast((opts && opts.msg) || 'Changes saved', () => { delete before.pending; editEntry(before, { quiet: true }); });
    flush();
  }

  function removeEntry(id, opts) {
    const e = entries.find(x => x.id === id);
    entries = entries.filter(x => x.id !== id);
    const add = pendingOp(id, 'add');
    outbox = outbox.filter(o => !(opId(o) === id && o !== inflight && o.op !== 'delete'));
    if (!add) outbox.push({ op: 'delete', id: id });
    openItem = null;
    touch(); saveAll();
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
    const add = pendingOp(id, 'add') || pendingOp(id, 'edit');
    if (add) add.entry.note = note;
    else {
      outbox = outbox.filter(o => !(o.op === 'note' && o.id === id && o !== inflight));
      outbox.push({ op: 'note', id: id, note: note });
    }
    editingNote = null; openItem = null;
    touch(); saveAll();
    toast(note ? 'Note saved' : 'Note removed', () => updateNote(id, before));
    flush();
  }

  // Ends an open sleep. Whoever started it, any phone can end it. Undo reopens it.
  function endSleep(id, end, reopen) {
    const e = entries.find(x => x.id === id);
    if (!e) return;
    if (reopen) { e.end = null; e.minutes = null; } else { e.end = end; e.minutes = Math.round((end - e.t) / MIN); }
    const add = pendingOp(id, 'add') || pendingOp(id, 'edit');
    const queued = pendingOp(id, 'endSleep');
    if (add) { add.entry.end = e.end; add.entry.minutes = e.minutes; }
    else if (queued && reopen && !queued.reopen) outbox.splice(outbox.indexOf(queued), 1);   // never sent: just drop it
    else outbox.push(reopen ? { op: 'endSleep', id: id, reopen: true } : { op: 'endSleep', id: id, end: end });
    touch(); saveAll();
    if (reopen) toast('Sleep is going again');
    else toast('Sleep saved · ' + durText(e.minutes), () => endSleep(id, null, true));
    flush();
  }

  // Sends the shared breastfeed timer (or its end) to the sheet. Only the latest state matters.
  function queueLive(replace) {
    outbox = outbox.filter(o => !(o.op === 'live' && o !== inflight));
    outbox.push({ op: 'live', state: active ? Object.assign({}, active) : null, replace: !!replace });
    touch(); saveOutbox(); setSync();
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

  // Sleep: "1h 35m", "45m", "3d"
  function durText(min) {
    min = Math.max(0, Math.round(min));
    const hh = Math.floor(min / 60), mm = min % 60;
    if (hh >= 48) return Math.floor(hh / 24) + 'd';
    return hh ? hh + 'h' + (mm ? ' ' + mm + 'm' : '') : mm + 'm';
  }
  const SLEEP_MAX = 24 * 60 * MIN;
  // The sleep still going on, if any (one left open for over a day is treated as forgotten)
  const openSleep = () => entries.filter(e => e.type === 'sleep' && !e.end && e.t > Date.now() - SLEEP_MAX).sort((a, b) => b.t - a.t)[0] || null;

  // Weight is stored in ounces; shown as "7 lb 9.5 oz" or "3.44 kg"
  const OZ_PER_KG = 35.27396;
  const wUnit = () => (prefs.weightUnit === 'kg' ? 'kg' : 'lb');
  function lbOz(oz) {
    let lb = Math.floor(oz / 16), rest = Math.round((oz - lb * 16) * 10) / 10;
    if (rest >= 16) { lb += 1; rest = 0; }
    return [lb, rest];
  }
  function weightText(oz, unit) {
    if ((unit || wUnit()) === 'kg') return (oz / OZ_PER_KG).toFixed(2) + ' kg';
    const [lb, rest] = lbOz(oz);
    return lb + ' lb ' + rest + ' oz';
  }
  function weightDelta(d) {
    if (Math.abs(d) < 0.05) return 'no change';
    const sign = d > 0 ? '+' : '−', a = Math.abs(d);
    if (wUnit() === 'kg') { const g = Math.round(a / OZ_PER_KG * 1000); return sign + (g >= 1000 ? (g / 1000).toFixed(2) + ' kg' : g + ' g'); }
    const [lb, rest] = lbOz(a);
    return sign + (lb ? lb + ' lb ' + rest + ' oz' : rest + ' oz');
  }
  const weights = () => entries.filter(e => e.type === 'weight').sort((a, b) => a.t - b.t);
  const prevWeight = e => weights().filter(w => w.t < e.t).pop() || null;
  // Length is stored in inches; shown as "20.5 in" or "52.1 cm"
  const CM_PER_IN = 2.54;
  const lengths = () => entries.filter(e => e.type === 'length').sort((a, b) => a.t - b.t);
  const prevLength = e => lengths().filter(w => w.t < e.t).pop() || null;
  const lenUnitPref = () => (prefs.weightUnit === 'kg' ? 'cm' : 'in');
  function lengthText(inches, unit) {
    return (unit || lenUnitPref()) === 'cm' ? (inches * CM_PER_IN).toFixed(1) + ' cm' : +inches.toFixed(2) + ' in';
  }
  function lengthDelta(d) {
    if (Math.abs(d) < 0.005) return 'no change';
    const sign = d > 0 ? '+' : '−', a = Math.abs(d);
    return sign + (lenUnitPref() === 'cm' ? (a * CM_PER_IN).toFixed(1) + ' cm' : +a.toFixed(2) + ' in');
  }
  const HEALTH_ICON = { med: 'med', temp: 'temp', vaccine: 'vaccine', symptom: 'symptom', visit: 'visit' };
  const tempText = e => (e.tempUnit === 'C' ? ((e.tempF - 32) / 1.8).toFixed(1) + ' °C' : (+e.tempF).toFixed(1) + ' °F');
  // Growth entries backdated to a day (no time given) are stored at midday and shown by date only
  const dateOnly = e => (e.type === 'weight' || e.type === 'length') && (() => { const d = new Date(e.t); return d.getHours() === 12 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0; })();

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
    if (e.type === 'sleep') {
      const t2 = e.end ? durText(e.minutes != null ? e.minutes : (e.end - e.t) / MIN)
        : e.t > Date.now() - SLEEP_MAX ? 'Asleep now · ' + durText((Date.now() - e.t) / MIN) : 'No wake-up time';
      return { icon: 'sleep', cls: 'i-sleep', t1: 'Sleep', t2: t2 + by };
    }
    if (e.type === 'weight') {
      const p = prevWeight(e);
      return { icon: 'weight', cls: 'i-weight', t1: 'Weight', t2: weightText(e.weightOz) + (p ? ' · ' + weightDelta(e.weightOz - p.weightOz) : '') + by };
    }
    if (e.type === 'length') {
      const p = prevLength(e);
      return { icon: 'length', cls: 'i-length', t1: 'Length', t2: lengthText(e.lengthIn) + (p ? ' · ' + lengthDelta(e.lengthIn - p.lengthIn) : '') + by };
    }
    if (e.type === 'health') {
      const icon = HEALTH_ICON[e.kind] || 'health';
      if (e.kind === 'med') return { icon: icon, cls: 'i-health', t1: e.detail || 'Medicine', t2: 'Medicine' + (e.dose ? ' · ' + e.dose : '') + (e.remindHours ? ' · next due ' + fmtTime(e.t + e.remindHours * 3600000) : '') + by };
      if (e.kind === 'temp') return { icon: icon, cls: 'i-health', t1: 'Temperature', t2: (e.tempF ? tempText(e) : '') + (e.detail ? ' · ' + e.detail : '') + by };
      const t1 = { vaccine: 'Vaccine', symptom: 'Symptom', visit: 'Doctor visit' }[e.kind] || 'Health';
      return { icon: icon, cls: 'i-health', t1: t1, t2: (e.detail || t1) + by };
    }
    if (e.type === 'activity') return { icon: 'activity', cls: 'i-activity', t1: e.detail || 'Activity', t2: 'Activity' + (e.minutes ? ' · ' + e.minutes + ' min' : '') + by };
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
    // Feed due: no feed for longer than this phone's reminder setting (3 hours unless changed)
    const dueH = prefs.feedHours != null ? prefs.feedHours : 3;
    const due = !!(lastFeed && !active && dueH > 0 && Date.now() - lastFeed.t >= dueH * 3600000);
    $('feedDue').hidden = !due;
    $('lastFeedAgo').closest('.stat').classList.toggle('due', due);
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

    const os = openSleep();
    const lastSlept = sorted.filter(e => e.type === 'sleep' && e.end).sort((a, b) => b.end - a.end)[0];
    const sleepLabel = $('sleepCard').querySelector('.label');
    if (os) {
      sleepLabel.textContent = 'Asleep for';
      $('sleepAgo').textContent = durText((Date.now() - os.t) / MIN);
      $('sleepSub').textContent = 'Since ' + fmtTime(os.t);
    } else if (lastSlept) {
      sleepLabel.textContent = 'Awake for';
      $('sleepAgo').textContent = durText((Date.now() - lastSlept.end) / MIN);
      $('sleepSub').textContent = 'Slept ' + durText(lastSlept.minutes) + ', woke ' + fmtTime(lastSlept.end);
    } else { sleepLabel.textContent = 'Sleep'; $('sleepAgo').textContent = 'None yet'; $('sleepSub').textContent = 'Tap Sleep to log one'; }

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
      whenEl.textContent = dateOnly(e) ? new Date(e.t).toLocaleDateString([], { month: 'short', day: 'numeric' }) : fmtTime(e.t);
      if (e.type === 'activity' && e.minutes) { const sm = document.createElement('small'); sm.textContent = 'to ' + fmtTime(e.t + e.minutes * MIN); whenEl.appendChild(sm); }
      if (e.type === 'sleep') { const sm = document.createElement('small'); sm.textContent = e.end ? 'to ' + fmtTime(e.end) : 'to now'; whenEl.appendChild(sm); }
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
        const change = document.createElement('button'); change.type = 'button'; change.textContent = 'Edit'; change.className = 'edit-entry';
        change.style.color = 'var(--feed)';
        change.addEventListener('click', () => openEdit(Object.assign({}, e)));
        const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = e.note ? 'Edit note' : 'Add note';
        edit.addEventListener('click', () => { editingNote = e.id; render(); });
        const del = document.createElement('button'); del.type = 'button'; del.className = 'del'; del.textContent = 'Delete';
        del.addEventListener('click', () => removeEntry(e.id));
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
        cancel.addEventListener('click', () => { openItem = null; render(); });
        tools.append(change, edit, del, cancel); wrap.appendChild(tools);
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
  function toast(msg, undo, label) {
    $('toastMsg').textContent = msg; undoFn = undo || null;
    $('toastUndo').hidden = !undo;
    $('toastUndo').textContent = label || 'Undo';
    $('toast').classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 4500);
  }
  $('toastUndo').addEventListener('click', () => { const f = undoFn; undoFn = null; $('toast').classList.remove('show'); if (f) f(); });

  /* ================================================================ */
  /* Sheets                                                            */
  /* ================================================================ */
  let openSheet = null;
  let editing = null;   // the entry being changed while its sheet is open (null when adding)
  function open(name) {
    closeSheet();
    openSheet = $('sheet-' + name);
    if (name === 'diaper') { resetDiaper(); resetNote('diaper'); }
    if (name === 'bottle') resetNote('bottle');
    if (name === 'pump') resetPump();
    if (name === 'sleep') resetSleep();
    if (name === 'weight') resetWeight();
    if (name === 'health') resetHealth();
    if (name === 'activity') resetActivity();
    if (name === 'stats') setTimeout(renderStats, 30);
    if (name === 'sync') renderSyncSheet();
    if (name === 'feed') { resetNote('manual'); resetNote('timer', active && active.note); }
    if (name === 'bottle') { setWhen('bottle', 0); setUnit(prefs.unit); setSource(prefs.source); }
    if (name === 'feed') { setWhenAuto('manual', () => Date.now() - (manual.L + manual.R) * MIN); renderTimer(); }
    if (name === 'settings') renderSettings();
    $('scrim').classList.add('open'); openSheet.classList.add('open');
  }
  function closeSheet() {
    if (openSheet) openSheet.classList.remove('open');
    $('scrim').classList.remove('open'); openSheet = null;
    if (editing) endEdit();
  }
  document.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => open(b.dataset.open)));
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeSheet));
  $('scrim').addEventListener('click', closeSheet);
  $('live').addEventListener('click', () => { open('feed'); setMode(true); });
  $('liveSleep').addEventListener('click', () => open('sleep'));
  $('meBtn').addEventListener('click', () => open('settings'));
  $('statsBtn').addEventListener('click', () => open('stats'));
  $('sync').addEventListener('click', () => { open('sync'); refresh(true); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

  /* Editing an entry: its sheet opens filled in, with "Save changes" */
  const EDIT_TITLES = { breast: 'Edit breastfeed', bottle: 'Edit bottle', diaper: 'Edit diaper', pump: 'Edit pump', sleep: 'Edit sleep',
    weight: 'Edit weight', length: 'Edit length', health: 'Edit health entry', activity: 'Edit activity' };
  function markEdit(titleId, saveId, e) {
    const t = $(titleId), b = $(saveId);
    if (t.dataset.orig == null) t.dataset.orig = t.textContent;
    t.textContent = EDIT_TITLES[e.type] || 'Edit';
    if (b) b.textContent = 'Save changes';
  }
  function endEdit() {
    editing = null;
    document.querySelectorAll('[data-orig]').forEach(x => { x.textContent = x.dataset.orig; delete x.dataset.orig; });
    document.querySelectorAll('.edit-hide').forEach(x => { x.hidden = false; x.classList.remove('edit-hide'); });
    $('slFrom').type = 'time'; $('slTo').type = 'time';
  }
  const hideForEdit = el => { if (el && !el.hidden) { el.hidden = true; el.classList.add('edit-hide'); } };
  const saveLabel = text => (editing ? 'Save changes' : text);

  function openEdit(e) {
    openItem = null;
    const name = { breast: 'feed', bottle: 'bottle', diaper: 'diaper', pump: 'pump', sleep: 'sleep', weight: 'weight', length: 'weight', health: 'health', activity: 'activity' }[e.type];
    if (!name) return;
    open(name);
    editing = e;
    if (e.type === 'breast') {
      setMode(false); hideForEdit($('feedModes'));
      manual.first = e.first;
      document.querySelectorAll('[data-first]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.first === e.first)));
      setManual('L', e.left || 0); setManual('R', e.right || 0);
      setWhenExact('manual', e.t); resetNote('manual', e.note);
      markEdit('feedTitle', 'manualSave', e);
    } else if (e.type === 'bottle') {
      setUnit(e.unit); amount = e.amount != null ? e.amount : e.oz; showAmount(); setSource(e.source || null);
      setWhenExact('bottle', e.t); resetNote('bottle', e.note);
      markEdit('bottleTitle', 'bottleSave', e);
    } else if (e.type === 'diaper') {
      setKind(e.kind); setWhenExact('diaper', e.t); resetNote('diaper', e.note);
      markEdit('diaperTitle', 'diaperSave', e);
    } else if (e.type === 'pump') {
      setPumpSide(e.side); setPumpMin(e.minutes); setPumpUnit(e.pumpUnit);
      pAmt = { L: e.leftAmt, R: e.rightAmt }; showPA('L'); showPA('R');
      $('pumpLabel').value = e.label || ''; setWhenExact('pump', e.t); resetNote('pump', e.note);
      markEdit('pumpTitle', 'pumpSave', e);
    } else if (e.type === 'sleep') {
      editSleep(e);
    } else if (e.type === 'weight' || e.type === 'length') {
      editGrowth(e);
    } else if (e.type === 'health') {
      editHealth(e);
    } else if (e.type === 'activity') {
      editActivity(e);
    }
  }

  /* ================================================================ */
  /* "When" picker                                                     */
  /* ================================================================ */
  // Chips for "now" and "N minutes ago", or an exact time. When editing an entry it becomes an
  // exact date and time instead.
  const whenState = {};
  const whenAuto = {};   // a default that follows the entry, e.g. a feed entered after: now minus its minutes
  const WHEN = [[0, 'Now'], [10, '10m ago'], [20, '20m ago'], [30, '30m ago'], [60, '1h ago']];
  const pad2 = n => String(n).padStart(2, '0');
  const timeVal = t => { const d = new Date(t); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
  const dateVal = t => { const d = new Date(t); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };
  const dtVal = t => dateVal(t) + 'T' + timeVal(t);
  const parseDt = v => { const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(v || ''); return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]).getTime() : NaN; };
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
      delete whenAuto[key];
      box.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
    });
    box.appendChild(t);
    const x = document.createElement('input'); x.type = 'datetime-local'; x.className = 'when-exact'; x.id = 'exact-' + key; x.hidden = true;
    x.setAttribute('aria-label', 'Date and time');
    x.addEventListener('change', () => { const v = parseDt(x.value); if (isFinite(v)) whenState[key] = v; });
    box.appendChild(x);
  });
  const whenBox = key => document.querySelector('.chips.when[data-for="' + key + '"]');
  function setWhen(key, minsAgo) {
    const box = whenBox(key);
    box.querySelectorAll('.chip').forEach(c => { c.hidden = false; c.setAttribute('aria-pressed', String(Number(c.dataset.m) === minsAgo)); });
    const t = box.querySelector('input[type="time"]'); t.hidden = false; t.value = '';
    box.querySelector('.when-exact').hidden = true;
    delete whenAuto[key];
    whenState[key] = minsAgo <= 0 ? null : Date.now() - minsAgo * MIN; // "Now" resolves at save time
  }
  function setWhenExact(key, t) {
    const box = whenBox(key);
    box.querySelectorAll('.chip, input[type="time"]').forEach(c => { c.hidden = true; });
    const x = box.querySelector('.when-exact'); x.hidden = false; x.value = dtVal(t); x.max = dtVal(Date.now() + 9 * MIN);
    delete whenAuto[key];
    whenState[key] = t;
  }
  function setWhenAuto(key, fn) {
    setWhen(key, -1);
    whenAuto[key] = fn;
    showAutoTime(key);
  }
  function showAutoTime(key) {
    if (!whenAuto[key]) return;
    whenBox(key).querySelector('input[type="time"]').value = timeVal(whenAuto[key]());
  }
  const whenOf = key => whenState[key] || (whenAuto[key] ? whenAuto[key]() : Date.now());

  /* ================================================================ */
  /* Optional notes on new entries                                     */
  /* ================================================================ */
  document.querySelectorAll('.note-wrap').forEach(w => {
    const btn = w.querySelector('.add-note'), ta = w.querySelector('textarea');
    btn.addEventListener('click', () => { btn.hidden = true; ta.hidden = false; ta.focus(); });
    if (w.dataset.note === 'timer') {
      ta.addEventListener('input', () => { if (active) { active.note = ta.value; saveActive(); } });
      ta.addEventListener('change', () => { if (active) queueLive(); });
    }
  });
  function resetNote(key, value) {
    const w = document.querySelector('.note-wrap[data-note="' + key + '"]');
    const ta = w.querySelector('textarea'), btn = w.querySelector('.add-note');
    ta.value = value || ''; ta.hidden = !value; btn.hidden = !!value;
  }
  const noteOf = key => $('note-' + key).value.trim();

  /* ================================================================ */
  /* Breastfeed timer, shared by every phone                           */
  /* ================================================================ */
  // One timer for the household: start it on one phone, switch sides or save it on another.
  const LONG_MIN = 45;   // a side running this long gets a "still feeding?" check
  function sideMs(a, s) {
    let ms = s === 'L' ? a.left : a.right;
    if (a.running && a.side === s) ms += Date.now() - a.segStart;
    return ms;
  }
  const isLong = a => !!(a && a.running && Date.now() - a.segStart >= LONG_MIN * MIN);
  const longKey = a => a.id + ':' + a.segStart;
  // A breastfeed that stopped under 30 minutes ago is the same feed (a burp, a diaper change, a
  // pause before the other side). Starting the timer then adds to it instead of logging a new one.
  const CONTINUE_MIN = 30;
  const feedEnd = e => Math.max(e.end || 0, e.t + ((e.left || 0) + (e.right || 0)) * MIN);
  function feedToContinue(at) {
    const last = entries.filter(e => e.type === 'breast' && e.t <= at).sort((x, y) => y.t - x.t)[0];
    return last && at - feedEnd(last) <= CONTINUE_MIN * MIN ? last : null;
  }
  // Adds minutes to a saved breastfeed. "Keep separate" turns the added part into its own feed.
  function mergeFeed(prev, add) {
    const before = Object.assign({}, prev); delete before.pending;
    const both = (prev.left || 0) + add.left > 0 && (prev.right || 0) + add.right > 0;
    editEntry(Object.assign({}, prev, {
      left: (prev.left || 0) + add.left, right: (prev.right || 0) + add.right,
      first: both ? prev.first : (prev.left || add.left ? 'L' : 'R'), last: add.last,
      end: Math.max(feedEnd(prev), add.end), note: [prev.note, add.note].filter(Boolean).join(' · ')
    }), { quiet: true });
    toast('Added to the ' + fmtTime(prev.t) + ' feed', () => {
      editEntry(before, { quiet: true });
      addEntry(Object.assign({ type: 'breast' }, add), { quiet: true });
      toast('Saved as a separate feed');
    }, 'Keep separate');
  }
  function tapSide(s) {
    const now = Date.now();
    const a = active;
    if (!a) {
      const prev = feedToContinue(now);
      active = { id: newId(), by: auth ? auth.name : '', start: now, first: s, side: s, running: true, segStart: now, left: 0, right: 0, note: $('note-timer').value };
      if (prev) {   // the clocks carry on from the earlier feed's minutes
        Object.assign(active, { id: prev.id, continues: true, start: prev.t, first: prev.first, left: prev.left * MIN, right: prev.right * MIN,
          baseLeft: prev.left * MIN, baseRight: prev.right * MIN, contStart: now, contFirst: s });
      }
    } else if (a.side === s && a.running) {
      if (s === 'L') a.left += now - a.segStart; else a.right += now - a.segStart;
      a.running = false;
    } else {
      if (a.running) { if (a.side === 'L') a.left += now - a.segStart; else a.right += now - a.segStart; }
      a.side = s; a.running = true; a.segStart = now;
    }
    saveActive(); renderTimer(); renderLive();
    queueLive();
  }
  $('feedNew').addEventListener('click', () => {
    const a = active; if (!a || !a.continues) return;
    Object.assign(a, { id: newId(), start: a.contStart, first: a.contFirst, left: Math.max(0, a.left - a.baseLeft), right: Math.max(0, a.right - a.baseRight) });
    ['continues', 'baseLeft', 'baseRight', 'contStart', 'contFirst'].forEach(k => delete a[k]);
    saveActive(); renderTimer(); renderLive();
    queueLive(true);
  });
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
    const prev = a ? null : feedToContinue(Date.now());
    if (a) {
      const total = sideMs(a, 'L') + sideMs(a, 'R');
      $('feedTotal').innerHTML = 'Total <b></b> · started ' + fmtTime(a.start);
      $('feedTotal').querySelector('b').textContent = clock(total);
    } else if (prev) {
      $('feedTotal').textContent = 'The ' + fmtTime(prev.t) + ' feed ended ' + durText((Date.now() - feedEnd(prev)) / MIN) + ' ago on the ' + sideName(prev.last).toLowerCase() + '. Tapping a side adds to it.';
    } else {
      $('feedTotal').textContent = next ? 'Last feed ended on the ' + sideName(other(next)).toLowerCase() + '. Tap a side to start.' : "Tap the side you're starting on";
    }
    $('contNote').hidden = !(a && a.continues);
    if (a && a.continues) $('contText').textContent = 'Adding to the ' + fmtTime(a.start) + ' feed.';
    const who = a && a.by && auth && a.by !== auth.name;
    $('liveWho').hidden = !who;
    if (who) $('liveWho').textContent = 'Started by ' + a.by + ' on their phone. You can switch sides, pause or save it here.';
    const showLong = isLong(a) && load(K.LONG, '') !== longKey(a);
    $('longNote').hidden = !showLong;
    if (showLong) $('longText').textContent = 'The ' + sideName(a.side).toLowerCase() + ' side has been running ' + durText((Date.now() - a.segStart) / MIN) + '. Still feeding?';
    $('feedDone').disabled = !a;
    $('feedDiscard').hidden = !a;
  }
  function renderLive() {
    const a = active;
    $('live').hidden = !a;
    if (a) {
      const long = isLong(a);
      $('live').classList.toggle('warn', long);
      $('liveTitle').textContent = long ? 'Still feeding? · ' + sideName(a.side) + ' ' + durText((Date.now() - a.segStart) / MIN)
        : a.running ? 'Feeding · ' + sideName(a.side) + ' side' : 'Feeding paused';
      $('liveSub').textContent = 'Left ' + clock(sideMs(a, 'L')) + ' · Right ' + clock(sideMs(a, 'R')) + (a.by && auth && a.by !== auth.name ? ' · ' + a.by : '');
    }
    const os = openSleep();
    $('liveSleep').hidden = !os;
    if (os) {
      $('liveSleepTitle').textContent = 'Asleep · ' + longClock(Date.now() - os.t);
      $('liveSleepSub').textContent = 'Since ' + fmtTime(os.t) + (os.by ? ' · started by ' + os.by : '');
    }
  }
  // Opening the app with a timer left running for a long time asks once whether it is still going
  function maybeLongPrompt() {
    if (!isLong(active) || load(K.LONG, '') === longKey(active) || openSheet) return;
    open('feed'); setMode(true);
  }
  function longClock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000)), hh = Math.floor(s / 3600), mm = Math.floor(s % 3600 / 60);
    return (hh ? hh + ':' + String(mm).padStart(2, '0') : mm) + ':' + String(s % 60).padStart(2, '0');
  }
  $('feedDone').addEventListener('click', () => {
    const a = active; if (!a) return;
    // A side used for 20 seconds or more counts as at least 1 minute
    const toMin = ms => (ms >= 20000 ? Math.max(1, Math.round(ms / MIN)) : 0);
    if (a.continues) {
      active = null; saveActive();
      const addL = toMin(sideMs(a, 'L') - a.baseLeft), addR = toMin(sideMs(a, 'R') - a.baseRight);
      const prev = entries.find(e => e.id === a.id);
      const add = { t: a.contStart, left: addL, right: addR, first: addL && addR ? a.contFirst : (addL ? 'L' : 'R'), last: addL && addR ? a.side : (addL ? 'L' : 'R'), end: Date.now(), note: noteOf('timer') };
      if (!addL && !addR) toast('Nothing was added: under 20 seconds');
      else if (prev) mergeFeed(prev, add);
      else addEntry(Object.assign({ id: a.id, type: 'breast' }, add, { t: a.start, left: Math.round(sideMs(a, 'L') / MIN), right: Math.round(sideMs(a, 'R') / MIN), first: a.first }));   // the earlier feed was deleted meanwhile
      queueLive(); resetNote('timer'); closeSheet();
      return;
    }
    const left = toMin(sideMs(a, 'L')), right = toMin(sideMs(a, 'R'));
    active = null; saveActive();
    if (!left && !right) { toast('That feed was under 20 seconds, so it was not saved'); queueLive(); renderTimer(); renderLive(); closeSheet(); return; }
    const first = left && right ? a.first : (left ? 'L' : 'R');
    const last = left && right ? a.side : first;
    addEntry({ id: a.id, type: 'breast', t: a.start, left: left, right: right, first: first, last: last, end: Date.now(), note: noteOf('timer') });
    queueLive();
    closeSheet();
  });
  $('feedDiscard').addEventListener('click', () => {
    const a = active;
    active = null; saveActive(); queueLive(); resetNote('timer'); renderTimer(); renderLive();
    toast(a && a.continues ? 'Stopped. The ' + fmtTime(a.start) + ' feed is unchanged.' : 'Feed discarded');
  });
  $('longKeep').addEventListener('click', () => { if (active) store(K.LONG, longKey(active)); renderTimer(); });
  $('longSave').addEventListener('click', () => $('feedDone').click());
  $('longDiscard').addEventListener('click', () => $('feedDiscard').click());
  setInterval(() => {
    if (active || !$('liveSleep').hidden || openSleep()) renderLive();
    if (active && openSheet === $('sheet-feed')) renderTimer();
    if (openSheet === $('sheet-sleep')) renderSleepClock();
  }, 1000);

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
  // Minutes per side: tap or hold + and -, or tap the number and type it
  const FEED_MAX = 180;
  function showManual(s) {
    const el = $('m' + s);
    if (document.activeElement !== el) el.value = manual[s];
    el.style.width = Math.max(2, el.value.length) + 1 + 'ch';
    showAutoTime('manual');
  }
  function setManual(s, v) {
    if (!isFinite(v)) { showManual(s); return; }
    manual[s] = Math.max(0, Math.min(FEED_MAX, Math.round(v)));
    showManual(s);
  }
  function readManual(s) {
    const raw = $('m' + s).value.trim();
    setManual(s, raw === '' ? 0 : parseInt(raw, 10));
  }
  document.querySelectorAll('[data-step]').forEach(b => holdRepeat(b, () => setManual(b.dataset.step, manual[b.dataset.step] + Number(b.dataset.d))));
  ['L', 'R'].forEach(s => {
    const el = $('m' + s);
    el.addEventListener('input', () => {
      el.value = el.value.replace(/[^0-9]/g, '').slice(0, 3);
      el.style.width = Math.max(2, el.value.length) + 1 + 'ch';
    });
    el.addEventListener('focus', () => setTimeout(() => el.select(), 0));
    el.addEventListener('blur', () => readManual(s));
    el.addEventListener('keydown', e => { if (e.key === 'Enter') el.blur(); });
    showManual(s);
  });
  $('manualSave').addEventListener('click', () => {
    readManual('L'); readManual('R');   // a number still being typed counts
    if (!manual.L && !manual.R) { toast('Add minutes for at least one side'); return; }
    const both = manual.L > 0 && manual.R > 0;
    const only = manual.L ? 'L' : 'R';
    const first = both ? manual.first : only;
    const last = both ? other(manual.first) : only;
    const e = { type: 'breast', t: whenOf('manual'), left: manual.L, right: manual.R, first: first, last: last, note: noteOf('manual') };
    e.end = e.t + (e.left + e.right) * MIN;
    if (editing) {
      // keep any pause the feed had (its end), moved along with its start
      if (editing.end) e.end = Math.max(e.end, editing.end + (e.t - editing.t));
      editEntry(Object.assign({ id: editing.id }, e));
    } else {
      const prev = feedToContinue(e.t);
      if (prev) mergeFeed(prev, e); else addEntry(e);
    }
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
    $('bottleSave').textContent = source ? saveLabel('Save bottle') : 'Choose breast milk or formula';
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
    const e = { type: 'bottle', t: whenOf('bottle'), amount: amount, unit: unit, oz: oz, source: source, note: noteOf('bottle') };
    if (editing) editEntry(Object.assign({ id: editing.id }, e)); else addEntry(e);
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
    $('pumpSave').textContent = pumpSide ? saveLabel('Save pump') : 'Choose a side';
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
    const e = { type: 'pump', t: whenOf('pump'), side: pumpSide, minutes: pumpMin, label: $('pumpLabel').value.trim().slice(0, 60), note: noteOf('pump'),
      leftAmt: pumpSide !== 'R' ? pAmt.L : null, rightAmt: pumpSide !== 'L' ? pAmt.R : null, pumpUnit: pumpUnit };
    if (editing) editEntry(Object.assign({ id: editing.id }, e)); else addEntry(e);
    closeSheet();
  });

  /* Sleep: a shared timer (start now, anyone ends it) or start and end entered after */
  let sleepOpenId = null, slFrom = 0, slTo = 0;
  const dayLabel = t => {
    const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    if (t >= d0.getTime()) return 'Today';
    if (t >= d0.getTime() - 86400000) return 'Yesterday';
    return fmtDay(t);
  };
  // The latest moment with this clock time that is before ref
  function placeBefore(hm, ref) {
    const [hh, mi] = hm.split(':').map(Number);
    const d = new Date(ref); d.setHours(hh, mi, 0, 0);
    if (d.getTime() >= ref) d.setDate(d.getDate() - 1);
    return d.getTime();
  }
  function setSleepMode(timer) {
    $('slModeTimer').setAttribute('aria-pressed', String(timer));
    $('slModeManual').setAttribute('aria-pressed', String(!timer));
    $('slTimerPane').hidden = !timer;
    $('slManualPane').hidden = timer;
  }
  function resetSleep() {
    const os = openSleep();
    sleepOpenId = os ? os.id : null;
    $('sleepNew').hidden = !!os;
    $('sleepOpen').hidden = !os;
    $('slTo').closest('.timebox').hidden = false;
    if (os) { setWhen('sleepEnd', 0); renderSleepClock(); return; }
    setSleepMode(true);
    setWhen('sleepStart', 0);
    resetNote('sleep'); resetNote('sleepManual');
    const now = new Date(); now.setSeconds(0, 0);
    slTo = now.getTime(); slFrom = slTo - 60 * MIN;
    showManualSleep();
  }
  // Editing a sleep: exact start and end (date and time), or only the start while still asleep
  function editSleep(e) {
    $('sleepNew').hidden = false; $('sleepOpen').hidden = true; sleepOpenId = null;
    setSleepMode(false); hideForEdit($('slModeTimer').parentNode);
    $('slFrom').type = 'datetime-local'; $('slTo').type = 'datetime-local';
    slFrom = e.t; slTo = e.end || null;
    if (!e.end) hideForEdit($('slTo').closest('.timebox'));
    resetNote('sleepManual', e.note);
    markEdit('sleepTitle', 'sleepManualSave', e);
    showManualSleep();
  }
  function renderSleepClock() {
    if (!sleepOpenId) return;
    const os = entries.find(e => e.id === sleepOpenId);
    if (!os || os.end) { resetSleep(); return; }   // someone else ended or removed it
    $('slClock').textContent = longClock(Date.now() - os.t);
    $('slSince').textContent = 'Fell asleep at ' + fmtTime(os.t) + (os.by ? ' · started by ' + os.by : '');
  }
  function showManualSleep() {
    const exact = $('slFrom').type === 'datetime-local';
    $('slFrom').value = exact ? dtVal(slFrom) : timeVal(slFrom);
    $('slFromDay').textContent = exact ? '' : dayLabel(slFrom);
    $('slTotal').textContent = '';
    if (slTo == null) {
      $('slTotal').append('Still asleep · ', h('b', { text: durText((Date.now() - slFrom) / MIN) }));
      $('sleepManualSave').disabled = !(slFrom < Date.now());
      return;
    }
    $('slTo').value = exact ? dtVal(slTo) : timeVal(slTo);
    $('slToDay').textContent = exact ? '' : dayLabel(slTo);
    const m = Math.round((slTo - slFrom) / MIN);
    $('slTotal').append('Slept ', h('b', { text: durText(m) }));
    $('sleepManualSave').disabled = m < 1 || m > 24 * 60;
  }
  $('slModeTimer').addEventListener('click', () => setSleepMode(true));
  $('slModeManual').addEventListener('click', () => setSleepMode(false));
  $('slTo').addEventListener('change', () => {
    if (!$('slTo').value) return;
    if ($('slTo').type === 'datetime-local') { const v = parseDt($('slTo').value); if (isFinite(v)) slTo = v; showManualSleep(); return; }
    slTo = placeBefore($('slTo').value, Date.now() + MIN);
    slFrom = placeBefore(timeVal(slFrom), slTo);
    showManualSleep();
  });
  $('slFrom').addEventListener('change', () => {
    if (!$('slFrom').value) return;
    if ($('slFrom').type === 'datetime-local') { const v = parseDt($('slFrom').value); if (isFinite(v)) slFrom = v; showManualSleep(); return; }
    slFrom = placeBefore($('slFrom').value, slTo);
    showManualSleep();
  });
  $('sleepStartBtn').addEventListener('click', () => {
    addEntry({ type: 'sleep', t: whenOf('sleepStart'), end: null, minutes: null, note: noteOf('sleep') }, { msg: 'Sleep started' });
    closeSheet();
  });
  $('sleepManualSave').addEventListener('click', () => {
    if (editing && slTo == null) {
      editEntry({ id: editing.id, type: 'sleep', t: slFrom, end: null, minutes: null, note: noteOf('sleepManual') });
      closeSheet(); return;
    }
    const m = Math.round((slTo - slFrom) / MIN);
    if (m < 1) return;
    const e = { type: 'sleep', t: slFrom, end: slTo, minutes: m, note: noteOf('sleepManual') };
    if (editing) editEntry(Object.assign({ id: editing.id }, e)); else addEntry(e);
    closeSheet();
  });
  $('sleepEndBtn').addEventListener('click', () => {
    const os = entries.find(e => e.id === sleepOpenId);
    if (!os || os.end) { closeSheet(); return; }
    const end = whenOf('sleepEnd');
    if (end <= os.t) { toast('Wake-up has to be after ' + fmtTime(os.t)); return; }
    endSleep(os.id, Math.min(end, os.t + SLEEP_MAX));
    closeSheet();
  });
  $('sleepCancel').addEventListener('click', () => { if (sleepOpenId) removeEntry(sleepOpenId); closeSheet(); });

  /* Growth: weight (pounds and ounces, or kg; stored as ounces) and length (inches or cm; stored as inches) */
  let wOz = 120, lenIn = 20, gKind = 'W';
  const lenUnit = () => (wUnit() === 'kg' ? 'cm' : 'in');
  const todayVal = () => dateVal(Date.now());
  function setW(oz) {
    if (!isFinite(oz)) return;
    wOz = Math.max(16, Math.min(640, Math.round(oz * 10) / 10));
    showWeight();
  }
  function setLen(inches) {
    if (!isFinite(inches)) return;
    lenIn = Math.max(10, Math.min(45, Math.round(inches * 100) / 100));
    showWeight();
  }
  function showWeight() {
    const isW = gKind === 'W';
    $('wSame').textContent = '';
    if (isW) {
      const [lb, rest] = lbOz(wOz);
      if (document.activeElement !== $('wLb')) $('wLb').value = lb;
      if (document.activeElement !== $('wOz')) $('wOz').value = rest;
      if (document.activeElement !== $('wKg')) $('wKg').value = (wOz / OZ_PER_KG).toFixed(2);
      $('wSame').append('Same as ', h('b', { text: weightText(wOz, wUnit() === 'kg' ? 'lb' : 'kg') }));
    } else {
      if (document.activeElement !== $('lenVal')) $('lenVal').value = lenUnit() === 'cm' ? (lenIn * CM_PER_IN).toFixed(1) : String(+lenIn.toFixed(2));
      $('lenUnit').textContent = lenUnit();
      $('wSame').append('Same as ', h('b', { text: lengthText(lenIn, lenUnit() === 'cm' ? 'in' : 'cm') }));
    }
    const list = isW ? weights() : lengths();
    const last = list.filter(x => !editing || x.id !== editing.id).pop();
    $('wPrev').hidden = !last;
    if (last) $('wPrev').textContent = (isW ? 'Last weigh-in ' + weightText(last.weightOz) : 'Last length ' + lengthText(last.lengthIn)) +
      ' on ' + fmtDay(last.t) + ' · ' + (isW ? weightDelta(wOz - last.weightOz) : lengthDelta(lenIn - last.lengthIn));
  }
  function setGKind(k) {
    gKind = k === 'L' ? 'L' : 'W';
    $('gKindW').setAttribute('aria-pressed', String(gKind === 'W'));
    $('gKindL').setAttribute('aria-pressed', String(gKind === 'L'));
    $('wLbPane').hidden = gKind !== 'W' || wUnit() === 'kg';
    $('wKgPane').hidden = gKind !== 'W' || wUnit() === 'lb';
    $('gLenPane').hidden = gKind !== 'L';
    $('weightSave').textContent = saveLabel(gKind === 'W' ? 'Save weight' : 'Save length');
    showWeight();
  }
  function setWUnit(u) {
    prefs.weightUnit = u === 'kg' ? 'kg' : 'lb'; savePrefs();
    $('wUnitLb').setAttribute('aria-pressed', String(wUnit() === 'lb'));
    $('wUnitKg').setAttribute('aria-pressed', String(wUnit() === 'kg'));
    setGKind(gKind); render();
  }
  function resetWeight() {
    const last = weights().pop(), lastL = lengths().pop();
    wOz = last ? last.weightOz : 120;
    lenIn = lastL ? lastL.lengthIn : 20;
    $('wDate').value = todayVal(); $('wDate').max = todayVal();
    resetNote('weight');
    gKind = 'W';
    setWUnit(prefs.weightUnit);
  }
  function editGrowth(e) {
    hideForEdit($('gKindSeg'));
    if (e.type === 'weight') wOz = e.weightOz; else lenIn = e.lengthIn;
    gKind = e.type === 'weight' ? 'W' : 'L';
    if (e.type === 'length') prefs.weightUnit = e.lengthUnit === 'cm' ? 'kg' : 'lb';   // show it in the unit it was entered in
    $('wDate').value = dateVal(e.t);
    resetNote('weight', e.note);
    markEdit('weightTitle', null, e);
    setWUnit(prefs.weightUnit);
  }
  $('gKindW').addEventListener('click', () => setGKind('W'));
  $('gKindL').addEventListener('click', () => setGKind('L'));
  $('wUnitLb').addEventListener('click', () => setWUnit('lb'));
  $('wUnitKg').addEventListener('click', () => setWUnit('kg'));
  const kgNow = () => Math.round(wOz / OZ_PER_KG * 100) / 100;
  holdRepeat($('wLbMinus'), () => setW(wOz - 16));
  holdRepeat($('wLbPlus'), () => setW(wOz + 16));
  holdRepeat($('wOzMinus'), () => setW(wOz - 0.5));
  holdRepeat($('wOzPlus'), () => setW(wOz + 0.5));
  holdRepeat($('wKgMinus'), () => setW((kgNow() - 0.01) * OZ_PER_KG));
  holdRepeat($('wKgPlus'), () => setW((kgNow() + 0.01) * OZ_PER_KG));
  const lenStep = () => (lenUnit() === 'cm' ? 0.5 / CM_PER_IN : 0.25);
  holdRepeat($('lenMinus'), () => setLen(lenUnit() === 'cm' ? (Math.round(lenIn * CM_PER_IN * 2) / 2 - 0.5) / CM_PER_IN : lenIn - lenStep()));
  holdRepeat($('lenPlus'), () => setLen(lenUnit() === 'cm' ? (Math.round(lenIn * CM_PER_IN * 2) / 2 + 0.5) / CM_PER_IN : lenIn + lenStep()));
  function readWeightInputs(which) {
    const num = id => { const v = parseFloat($(id).value); return isFinite(v) && v >= 0 ? v : null; };
    if (which === 'len') { const v = num('lenVal'); if (v != null && v > 0) setLen(lenUnit() === 'cm' ? v / CM_PER_IN : v); return; }
    if (which === 'kg') { const k = num('wKg'); if (k != null && k > 0) setW(k * OZ_PER_KG); return; }
    const lb = num('wLb'), oz = num('wOz');
    const [curLb, curOz] = lbOz(wOz);
    setW((lb != null ? Math.floor(lb) : curLb) * 16 + (oz != null ? oz : curOz));
  }
  [['wLb', 'lb'], ['wOz', 'lb'], ['wKg', 'kg'], ['lenVal', 'len']].forEach(([id, which]) => {
    const inp = $(id);
    inp.addEventListener('input', () => { inp.value = inp.value.replace(',', '.').replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'); });
    inp.addEventListener('focus', () => setTimeout(() => inp.select(), 0));
    inp.addEventListener('blur', () => { readWeightInputs(which); showWeight(); });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
  });
  $('weightSave').addEventListener('click', () => {
    const f = document.activeElement;
    if (f && /^(w(Lb|Oz|Kg)|lenVal)$/.test(f.id)) readWeightInputs(f.id === 'wKg' ? 'kg' : f.id === 'lenVal' ? 'len' : 'lb');
    const day = $('wDate').value || todayVal();
    let t = Date.now();
    if (editing && day === dateVal(editing.t)) t = editing.t;          // same day: keep its time
    else if (day !== todayVal()) {
      const [y, mo, d] = day.split('-').map(Number);
      t = new Date(y, mo - 1, d, 12, 0, 0, 0).getTime();   // a past day without a time: use midday
      if (t > Date.now()) { toast('That date is in the future'); return; }
      if (t < Date.now() - 365 * 86400000) { toast('Pick a date within the last year'); return; }
    }
    const e = gKind === 'W' ? { type: 'weight', t: t, weightOz: wOz, weightUnit: wUnit(), note: noteOf('weight') }
      : { type: 'length', t: t, lengthIn: lenIn, lengthUnit: lenUnit(), note: noteOf('weight') };
    if (editing) editEntry(Object.assign({ id: editing.id }, e)); else addEntry(e);
    closeSheet();
  });

  /* Health: medicine (with an optional reminder), temperature, vaccine, symptom, doctor visit */
  const H = {
    med: { label: 'Medicine', save: 'Save medicine', placeholder: 'For example: Vitamin D', chips: ['Vitamin D'], need: true },
    temp: { label: '', save: 'Save temperature', placeholder: 'Optional, or pick one above', chips: ['Rectal', 'Armpit', 'Forehead', 'Ear'], need: false },
    vaccine: { label: 'Vaccine', save: 'Save vaccine', placeholder: 'Which vaccine', chips: ['Hepatitis B', 'RSV antibody', 'DTaP', 'Hib', 'Polio (IPV)', 'Pneumococcal (PCV)', 'Rotavirus', 'Flu', 'COVID-19'], need: true },
    symptom: { label: 'Symptom', save: 'Save symptom', placeholder: 'What you noticed', chips: ['Congestion', 'Cough', 'Fever', 'Rash', 'Spit-up', 'Vomiting', 'Diarrhea', 'Fussy', 'Jaundice'], need: true },
    visit: { label: 'Doctor visit (who or why)', save: 'Save visit', placeholder: 'Optional, for example: 2 week checkup', chips: ['Checkup', 'Sick visit', 'Lactation consultant', 'Urgent care'], need: false }
  };
  const REMIND = [0, 4, 6, 8, 12, 24];
  let hKind = 'med', tempF = 98.6, tUnit = 'F', hRemind = 0;
  const cToF = c => c * 1.8 + 32, fToC = f => (f - 32) / 1.8;
  function setHKind(k) {
    hKind = H[k] ? k : 'med';
    const cfg = H[hKind];
    document.querySelectorAll('[data-hkind]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.hkind === hKind)));
    $('hTempPane').hidden = hKind !== 'temp';
    $('hMedPane').hidden = hKind !== 'med';
    $('hDetailLabel').hidden = !cfg.label; $('hDetailLabel').textContent = cfg.label;
    $('hDetail').placeholder = cfg.placeholder;
    // Medicine suggestions: what was given before, most recent first, then Vitamin D
    const used = hKind === 'med' ? entries.filter(e => e.type === 'health' && e.kind === 'med').sort((a, b) => b.t - a.t).map(e => e.detail) : [];
    const chips = Array.from(new Set(used.concat(cfg.chips))).slice(0, 8);
    const box = $('hChips'); box.textContent = '';
    chips.forEach(c => box.appendChild(h('button', { class: 'chip', type: 'button', text: c, 'aria-pressed': 'false', onclick: () => {
      $('hDetail').value = c; showHealth();
      if (hKind === 'med') {   // the same medicine's last reminder setting
        const prev = entries.filter(e => e.type === 'health' && e.kind === 'med' && e.detail.toLowerCase() === c.toLowerCase()).sort((a, b) => b.t - a.t)[0];
        if (prev) { setRemind(prev.remindHours || 0); if (!$('hDose').value) $('hDose').value = prev.dose || ''; }
      }
    } })));
    showHealth();
  }
  function setRemind(hrs) {
    hRemind = hrs;
    document.querySelectorAll('#hRemind .chip').forEach(c => c.setAttribute('aria-pressed', String(Number(c.dataset.h) === hrs)));
  }
  REMIND.forEach(r => $('hRemind').appendChild(h('button', { class: 'chip', type: 'button', 'data-h': String(r), text: r ? 'Every ' + r + 'h' : 'Off', onclick: () => setRemind(r) })));
  function showTemp() {
    const el = $('tVal');
    if (document.activeElement !== el) el.value = (tUnit === 'C' ? fToC(tempF) : tempF).toFixed(1);
    $('tUnitLbl').textContent = '°' + tUnit;
    $('tUnitF').setAttribute('aria-pressed', String(tUnit === 'F'));
    $('tUnitC').setAttribute('aria-pressed', String(tUnit === 'C'));
  }
  function setTempF(f) { if (!isFinite(f)) return; tempF = Math.max(90, Math.min(110, Math.round(f * 10) / 10)); showTemp(); }
  function showHealth() {
    const v = $('hDetail').value.trim();
    document.querySelectorAll('#hChips .chip').forEach(c => c.setAttribute('aria-pressed', String(c.textContent === v)));
    const ok = !H[hKind].need || !!v;
    $('healthSave').disabled = !ok;
    $('healthSave').textContent = editing ? 'Save changes' : ok ? H[hKind].save : 'Enter the ' + H[hKind].label.toLowerCase();
  }
  function resetHealth() {
    tUnit = prefs.tempUnit === 'C' ? 'C' : 'F';
    tempF = 98.6; showTemp();
    $('hDetail').value = ''; $('hDose').value = '';
    setRemind(0);
    setWhen('health', 0); resetNote('health');
    setHKind('med');
  }
  function editHealth(e) {
    $('hDetail').value = e.detail || ''; $('hDose').value = e.dose || '';
    if (e.kind === 'temp' && e.tempF) { tempF = e.tempF; tUnit = e.tempUnit === 'C' ? 'C' : 'F'; showTemp(); }
    setRemind(e.remindHours || 0);
    setWhenExact('health', e.t); resetNote('health', e.note);
    markEdit('healthTitle', null, e);
    setHKind(e.kind);
  }
  document.querySelectorAll('[data-hkind]').forEach(b => b.addEventListener('click', () => { $('hDetail').value = ''; setHKind(b.dataset.hkind); }));
  $('hDetail').addEventListener('input', showHealth);
  $('tUnitF').addEventListener('click', () => { tUnit = 'F'; prefs.tempUnit = 'F'; savePrefs(); showTemp(); });
  $('tUnitC').addEventListener('click', () => { tUnit = 'C'; prefs.tempUnit = 'C'; savePrefs(); showTemp(); });
  holdRepeat($('tMinus'), () => setTempF(tUnit === 'C' ? cToF(Math.round(fToC(tempF) * 10) / 10 - 0.1) : tempF - 0.1));
  holdRepeat($('tPlus'), () => setTempF(tUnit === 'C' ? cToF(Math.round(fToC(tempF) * 10) / 10 + 0.1) : tempF + 0.1));
  const readTemp = () => { const v = parseFloat($('tVal').value); if (isFinite(v)) setTempF(tUnit === 'C' ? cToF(v) : v); else showTemp(); };
  $('tVal').addEventListener('input', () => { $('tVal').value = $('tVal').value.replace(',', '.').replace(/[^0-9.]/g, ''); });
  $('tVal').addEventListener('focus', () => setTimeout(() => $('tVal').select(), 0));
  $('tVal').addEventListener('blur', readTemp);
  $('tVal').addEventListener('keydown', e => { if (e.key === 'Enter') $('tVal').blur(); });
  $('healthSave').addEventListener('click', () => {
    if (document.activeElement === $('tVal')) readTemp();
    const detail = $('hDetail').value.trim().slice(0, 60);
    if (H[hKind].need && !detail) return;
    const e = { type: 'health', kind: hKind, t: whenOf('health'), detail: detail, note: noteOf('health') };
    if (hKind === 'med') { e.dose = $('hDose').value.trim().slice(0, 40); e.remindHours = hRemind; }
    if (hKind === 'temp') { e.tempF = tempF; e.tempUnit = tUnit; }
    if (editing) editEntry(Object.assign({ id: editing.id }, e)); else addEntry(e);
    closeSheet();
  });

  /* Activity: tummy time, bath, walks and anything typed in, with optional minutes */
  const ACTIVITIES = ['Tummy time', 'Bath', 'Walk', 'Skin to skin', 'Reading', 'Play'];
  let aMin = 0;
  function showActivity() {
    const v = $('aDetail').value.trim();
    document.querySelectorAll('#aChips .chip').forEach(c => c.setAttribute('aria-pressed', String(c.textContent === v)));
    const el = $('aMin');
    if (document.activeElement !== el) el.value = aMin;
    el.style.width = Math.max(2, el.value.length) + 0.4 + 'ch';
    document.querySelectorAll('#aMinChips .chip').forEach(c => c.setAttribute('aria-pressed', String(Number(c.dataset.m) === aMin)));
    $('activitySave').disabled = !v;
    $('activitySave').textContent = editing ? 'Save changes' : v ? 'Save ' + v.toLowerCase() : 'Choose an activity';
  }
  function setAMin(v) { if (!isFinite(v)) return; aMin = Math.max(0, Math.min(240, Math.round(v))); showActivity(); }
  function resetActivity() {
    const used = entries.filter(e => e.type === 'activity').sort((a, b) => b.t - a.t).map(e => e.detail);
    const names = Array.from(new Set(ACTIVITIES.concat(used))).slice(0, 10);
    const box = $('aChips'); box.textContent = '';
    names.forEach(n => box.appendChild(h('button', { class: 'chip', type: 'button', text: n, 'aria-pressed': 'false', onclick: () => {
      $('aDetail').value = n;
      if (!aMin) { const prev = entries.filter(e => e.type === 'activity' && e.detail === n && e.minutes).sort((a, b) => b.t - a.t)[0]; if (prev) aMin = prev.minutes; }
      showActivity();
    } })));
    $('aDetail').value = ''; aMin = 0;
    setWhen('activity', 0); resetNote('activity');
    showActivity();
  }
  function editActivity(e) {
    $('aDetail').value = e.detail || ''; aMin = e.minutes || 0;
    setWhenExact('activity', e.t); resetNote('activity', e.note);
    markEdit('activityTitle', null, e);
    showActivity();
  }
  [5, 10, 15, 20, 30].forEach(m => $('aMinChips').appendChild(h('button', { class: 'chip', type: 'button', 'data-m': String(m), text: m + ' min', onclick: () => setAMin(m) })));
  holdRepeat($('aMinus'), () => setAMin(aMin - 1));
  holdRepeat($('aPlus'), () => setAMin(aMin + 1));
  $('aDetail').addEventListener('input', showActivity);
  $('aMin').addEventListener('input', () => { $('aMin').value = $('aMin').value.replace(/[^0-9]/g, '').slice(0, 3); });
  $('aMin').addEventListener('focus', () => setTimeout(() => $('aMin').select(), 0));
  $('aMin').addEventListener('blur', () => setAMin(parseInt($('aMin').value || '0', 10)));
  $('aMin').addEventListener('keydown', e => { if (e.key === 'Enter') $('aMin').blur(); });
  $('activitySave').addEventListener('click', () => {
    if (document.activeElement === $('aMin')) setAMin(parseInt($('aMin').value || '0', 10));
    const detail = $('aDetail').value.trim().slice(0, 40);
    if (!detail) return;
    const e = { type: 'activity', t: whenOf('activity'), detail: detail, minutes: aMin, note: noteOf('activity') };
    if (editing) editEntry(Object.assign({ id: editing.id }, e)); else addEntry(e);
    closeSheet();
  });

  /* Diaper */
  let kind = null;
  function setKind(k) {
    kind = k; $('diaperSave').disabled = !k;
    document.querySelectorAll('[data-kind]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.kind === k)));
  }
  function resetDiaper() { setKind(null); setWhen('diaper', 0); }
  document.querySelectorAll('[data-kind]').forEach(k => k.addEventListener('click', () => setKind(k.dataset.kind)));
  $('diaperSave').addEventListener('click', () => {
    if (!kind) return;
    const e = { type: 'diaper', t: whenOf('diaper'), kind: kind, note: noteOf('diaper') };
    if (editing) editEntry(Object.assign({ id: editing.id }, e)); else addEntry(e);
    closeSheet();
  });

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

    body.appendChild(notifySection());

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
  /* Notifications (reminders)                                         */
  /* ================================================================ */
  // Each phone chooses its own reminders. The sheet checks every 5 minutes and the Baby Log
  // cloud service delivers them, so they arrive even when the app is closed.
  const b64ToBytes = s => {
    const raw = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  };
  function notifySection() {
    const box = h('div', { class: 'pane', style: 'gap:12px' }, [h('div', { class: 'field-label', text: 'Notifications' })]);
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    if (!supported) {
      box.appendChild(h('p', { class: 'muted', style: 'margin:0', text: isIOS && !isStandalone()
        ? 'On iPhone, notifications work in the Home Screen app. Add Baby Log to your Home Screen, open it from there, then turn them on here.'
        : 'This browser cannot show notifications.' }));
      return box;
    }
    const status = h('p', { class: 'muted', style: 'margin:0', text: 'Checking...' });
    box.appendChild(status);
    loadNotify(box, status);
    return box;
  }
  async function loadNotify(box, status) {
    let st;
    try { st = await api('pushStatus'); } catch (e) {
      status.textContent = e.code === 'offline' ? 'Connect to the internet to change notifications.' : e.message; return;
    }
    if (!st.configured) { status.textContent = 'Reminders are not set up for this Baby Log yet. The person who set it up can turn them on (README, Reminders).'; return; }
    // The background helper (service worker) receives notifications; it starts with the app
    const reg = await Promise.race([navigator.serviceWorker.ready, new Promise(r => setTimeout(r, 5000, null))]);
    if (!reg) { status.textContent = "Notifications need the app's background helper, which did not start. Close Baby Log, open it again and try here."; return; }
    status.remove();
    let sub = await reg.pushManager.getSubscription();
    const p = Object.assign({ feedHours: 3, longFeed: true, meds: true }, st.sub || {});
    const sw = h('input', { type: 'checkbox', id: 'notifyOn' });
    sw.checked = !!(st.sub && sub && Notification.permission === 'granted');
    const opts = h('div', { class: 'pane', style: 'gap:10px' });
    opts.hidden = !sw.checked;
    const feedChips = h('div', { class: 'chips pick', role: 'group', 'aria-label': 'Feed due after' });
    const paint = () => feedChips.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', String(Number(c.dataset.v) === p.feedHours)));
    [0, 2, 2.5, 3, 4].forEach(v => feedChips.appendChild(h('button', { class: 'chip', type: 'button', 'data-v': String(v), text: v ? v + 'h' : 'Off',
      onclick: () => { p.feedHours = v; paint(); save(); } })));
    paint();
    const long = h('input', { type: 'checkbox', id: 'nLong' }); long.checked = !!p.longFeed;
    const meds = h('input', { type: 'checkbox', id: 'nMeds' }); meds.checked = !!p.meds;
    long.addEventListener('change', () => { p.longFeed = long.checked; save(); });
    meds.addEventListener('change', () => { p.meds = meds.checked; save(); });
    const test = h('button', { class: 'secondary', type: 'button', text: 'Send a test notification', onclick: async () => {
      try { await api('pushTest'); toast('Sent. It should appear in a few seconds.'); } catch (e) { toast(e.message); }
    } });
    opts.append(h('p', { class: 'muted', style: 'margin:0', text: 'Feed due when there has been no feed for:' }), feedChips,
      h('label', { class: 'switch', for: 'nLong' }, ['Breastfeed timer running over ' + LONG_MIN + ' minutes', long]),
      h('label', { class: 'switch', for: 'nMeds' }, ['Medicine due (set when logging a dose)', meds]), test);
    box.append(h('label', { class: 'switch', for: 'notifyOn' }, ['Notifications on this phone', sw]), opts);

    async function save() {
      prefs.feedHours = p.feedHours; savePrefs(); render();
      if (!sw.checked) return;
      try {
        sub = sub || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(st.publicKey) });
        await api('pushSubscribe', { subscription: sub.toJSON(), prefs: p });
      } catch (e) { toast("Couldn't save: " + e.message); }
    }
    sw.addEventListener('change', async () => {
      if (sw.checked) {
        try {
          const perm = await Notification.requestPermission();
          if (perm !== 'granted') { sw.checked = false; toast('Notifications are blocked. Allow them for Baby Log in this phone\'s settings.'); return; }
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(st.publicKey) });
          await api('pushSubscribe', { subscription: sub.toJSON(), prefs: p });
          opts.hidden = false; prefs.feedHours = p.feedHours; savePrefs(); render();
          toast('Notifications are on');
        } catch (e) { sw.checked = false; toast("Couldn't turn on notifications: " + e.message); }
      } else {
        try { await api('pushUnsubscribe'); } catch (e) { /* turned off on this phone anyway */ }
        try { if (sub) await sub.unsubscribe(); } catch (e) { /* ignore */ }
        sub = null; opts.hidden = true; toast('Notifications are off');
      }
    });
  }

  /* ================================================================ */
  /* Sync details: what is waiting and why                             */
  /* ================================================================ */
  function opLabel(o) {
    const e = o.entry || entries.find(x => x.id === o.id);
    const what = e ? describe(e).t1 + ' at ' + fmtTime(e.t) : 'An entry';
    if (o.op === 'add') return 'New: ' + what;
    if (o.op === 'edit') return 'Changes to ' + what.toLowerCase();
    if (o.op === 'delete') return 'Delete an entry';
    if (o.op === 'note') return 'Note on ' + what.toLowerCase();
    if (o.op === 'endSleep') return o.reopen ? 'Sleep going again' : 'Wake-up time';
    if (o.op === 'live') return o.state ? 'Breastfeed timer' : 'Breastfeed timer ended';
    return 'Change';
  }
  function renderSyncSheet() {
    const body = $('syncBody');
    body.textContent = '';
    const when = lastSync ? 'Last checked with the sheet ' + ago(lastSync).toLowerCase() + '.' : 'Not checked with the sheet yet.';
    body.appendChild(h('p', { class: 'muted', style: 'margin:0', text: (online ? '' : 'Offline. ') + when }));
    if (!outbox.length) {
      body.appendChild(h('div', { class: 'notice', text: 'Everything logged on this phone is saved to the sheet.' }));
    } else {
      const list = h('div', { class: 'list' });
      outbox.forEach(o => {
        const status = o === inflight ? 'Sending now' : o.tries
          ? 'Tried ' + o.tries + (o.tries === 1 ? ' time' : ' times') + ': ' + (o.lastError || 'no answer') + (o.nextTry ? '. Trying again at ' + fmtTime(o.nextTry) + '.' : '')
          : online ? 'Waiting to send' : 'Waiting for a connection';
        const row = h('div', { class: 'q-item' }, [h('b', { text: opLabel(o) }), h('span', { class: o.tries ? 'err' : 'muted', text: status })]);
        if (o !== inflight) {
          row.appendChild(h('div', { class: 'chips' }, [
            h('button', { class: 'btn-sm', type: 'button', text: 'Try now', onclick: () => { o.nextTry = 0; saveOutbox(); flush(); } }),
            h('button', { class: 'btn-sm del', type: 'button', text: 'Discard', onclick: () => discardOp(o) })
          ]));
        }
        list.appendChild(row);
      });
      body.appendChild(list);
      body.appendChild(h('p', { class: 'muted', style: 'margin:0', text: 'Discard removes a change that will not go through. The sheet keeps whatever it already has.' }));
    }
    body.appendChild(h('button', { class: 'secondary', type: 'button', text: 'Check for new entries', onclick: () => { refresh(true); toast('Checking for new entries'); } }));
  }
  function discardOp(o) {
    const k = outbox.indexOf(o);
    if (k === -1 || o === inflight) return;
    outbox.splice(k, 1);
    if (o.op === 'add') entries = entries.filter(x => x.id !== o.entry.id);
    touch(); saveAll();
    refresh(true);   // anything else comes back as the sheet has it
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
    syncedAt = 0;
    [K.AUTH, K.ENTRIES, K.OUTBOX, K.ACTIVE, K.SYNC].forEach(drop);
    showJoin(byChoice ? 'welcome' : 'removed');
  }

  function showHome() {
    $('screen-join').hidden = true;
    $('screen-home').hidden = false;
    setMode(true);
    // A feed timer started on this phone before timers were shared: share it instead of losing it
    if (active && !active.id) { active.id = newId(); active.by = auth.name; saveActive(); queueLive(true); }
    render(); setSync();
    refresh(true).then(maybeLongPrompt);
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
    const logged = entries.filter(e => e.type !== 'weight' && e.type !== 'length');   // growth entries can be backdated to birth
    const first = logged.length ? dayStart(Math.min.apply(null, logged.map(e => e.t))) : today;
    const days = [];
    for (let i = range - 1; i >= 0; i--) {
      const start = addDays(today, -i);
      days.push({ start: start, end: addDays(start, 1), isToday: i === 0, before: start < first,
        wet: 0, dirty: 0, breast: 0, bottles: 0, oz: 0, breastMin: 0, pumps: 0, longestGap: 0, sleepMin: 0, sleeps: 0, longest: 0 });
    }
    const now = Date.now();
    entries.forEach(e => {
      if (e.type === 'sleep') {
        // A sleep that crosses midnight counts toward both days; one still going counts up to now
        const end = e.end || (e.t > now - SLEEP_MAX ? now : null);
        if (!end) return;
        days.forEach(x => { const ov = Math.min(end, x.end) - Math.max(e.t, x.start); if (ov > 0) x.sleepMin += ov / MIN; });
        const sd = days.find(x => e.t >= x.start && e.t < x.end);
        if (sd) { sd.sleeps++; sd.longest = Math.max(sd.longest, (end - e.t) / MIN); }
        return;
      }
      const d = days.find(x => e.t >= x.start && e.t < x.end);
      if (!d) return;
      if (e.type === 'diaper') { if (e.kind !== 'dirty') d.wet++; if (e.kind !== 'wet') d.dirty++; }
      else if (e.type === 'breast') { d.breast++; d.breastMin += (e.left || 0) + (e.right || 0); }
      else if (e.type === 'bottle') { d.bottles++; d.oz += e.oz || 0; }
      else if (e.type === 'pump') d.pumps++;
    });
    // Longest stretch without milk removal (breastfeed or pump), from the end of one to the start of the
    // next, counted on the day the next one starts
    let lastEnd = null;
    entries.filter(e => e.type === 'breast' || e.type === 'pump').sort((a, b) => a.t - b.t).forEach(e => {
      const end = e.t + (e.type === 'pump' ? (e.minutes || 0) : (e.left || 0) + (e.right || 0)) * MIN;
      if (lastEnd != null && e.t > lastEnd) {
        const d = days.find(x => e.t >= x.start && e.t < x.end);
        if (d) d.longestGap = Math.max(d.longestGap, (e.t - lastEnd) / MIN);
      }
      lastEnd = lastEnd == null ? end : Math.max(lastEnd, end);
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

  // Growth: every weigh-in (or length) as a line over real time (not tied to the 7/14/30 day range)
  const growthSel = {};
  function renderGrowthChart(c) {
    const svg = $(c.svg), ws = c.list();
    svg.parentNode.querySelector('.st-sub').textContent = c.sub;
    if (!ws.length) {
      svg.hidden = true; $(c.head).textContent = '';
      $(c.detail).textContent = c.empty;
      return;
    }
    svg.hidden = false;
    let sel = growthSel[c.svg];
    if (!ws.some(w => w.id === sel)) sel = growthSel[c.svg] = ws[ws.length - 1].id;
    const val = w => c.val(c.raw(w));
    const W = Math.max(260, svg.clientWidth || svg.parentNode.clientWidth || 300), H = 150;
    const padL = 34, padR = 14, padT = 22, padB = 22;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('height', H); svg.textContent = '';
    const vs = ws.map(val);
    let lo = Math.min.apply(null, vs), hi = Math.max.apply(null, vs);
    if (hi - lo < c.minSpan) { const mid = (hi + lo) / 2; lo = mid - c.minSpan / 2; hi = mid + c.minSpan / 2; }
    const step = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10].find(st => (Math.ceil(hi / st) - Math.floor(lo / st)) <= 4) || 10;
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    const t0 = ws[0].t, t1 = ws[ws.length - 1].t;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const x = t => (t1 === t0 ? padL + plotW / 2 : padL + (t - t0) / (t1 - t0) * plotW);
    const y = v => padT + plotH - (v - lo) / (hi - lo) * plotH;
    for (let v = lo; v <= hi + step / 2; v += step) {
      el('line', { class: 'grid', x1: padL, x2: W - padR, y1: y(v), y2: y(v) }, svg);
      const t = el('text', { x: padL - 6, y: y(v) + 4, 'text-anchor': 'end' }, svg);
      t.textContent = +v.toFixed(2);
    }
    if (ws.length > 1) el('path', { d: ws.map((w, i) => (i ? 'L' : 'M') + x(w.t) + ',' + y(val(w))).join(''), fill: 'none', stroke: c.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
    const xl = (t, anchor, px) => { const tx = el('text', { x: px, y: H - 6, 'text-anchor': anchor }, svg); tx.textContent = mdDay(t); };
    if (ws.length > 1) { xl(t0, 'start', padL); xl(t1, 'end', W - padR); } else xl(t0, 'middle', x(t0));
    ws.forEach(w => {
      const cx = x(w.t), cy = y(val(w)), selected = w.id === sel;
      el('circle', { cx: cx, cy: cy, r: selected ? 5.5 : 3.5, fill: c.color, stroke: 'var(--surface)', 'stroke-width': selected ? 2 : 1.5 }, svg);
      if (selected) {
        const anchor = cx < padL + 40 ? 'start' : cx > W - padR - 40 ? 'end' : 'middle';
        const t = el('text', { class: 'val halo', x: cx, y: cy - 10, 'text-anchor': anchor }, svg);
        t.textContent = c.text(c.raw(w));
      }
      const hit = el('rect', { class: 'hit', x: cx - 16, y: 0, width: 32, height: H }, svg);
      hit.addEventListener('click', () => { growthSel[c.svg] = w.id; renderGrowthChart(c); });
      const tip = el('title', {}, hit); tip.textContent = longDay(w.t) + ': ' + c.text(c.raw(w));
    });
    const last = ws[ws.length - 1], first = ws[0];
    $(c.head).textContent = ws.length > 1 ? c.delta(c.raw(last) - c.raw(first)) + ' since ' + mdDay(first.t) : '';
    const i = ws.findIndex(w => w.id === sel), w = ws[i], p = ws[i - 1];
    let rest = '';
    if (p) {
      const days = (w.t - p.t) / DAY;
      const perDay = (c.raw(w) - c.raw(p)) / Math.max(days, 1);
      const rate = c.rate && days >= 1 && Math.abs(perDay) >= c.rate ? ', about ' + c.delta(perDay).replace(/^\+/, '') + ' a day' : '';
      rest = '(' + c.delta(c.raw(w) - c.raw(p)) + ' since ' + mdDay(p.t) + rate + ')';
    }
    const b = $(c.detail); b.textContent = longDay(w.t) + ': ' + c.text(c.raw(w)) + ' ';
    if (rest) b.appendChild(h('span', { text: rest }));
  }
  function renderGrowth(color) {
    const kg = wUnit() === 'kg';
    renderGrowthChart({ svg: 'chWeight', head: 'stWeightHead', detail: 'stWeightDetail', list: weights, raw: w => w.weightOz,
      val: oz => (kg ? oz / OZ_PER_KG : oz / 16), text: oz => weightText(oz), delta: weightDelta, rate: 0.05, minSpan: kg ? 0.2 : 0.5,
      color: color, sub: 'Every weigh-in, in ' + (kg ? 'kg' : 'lb'),
      empty: 'No weigh-ins yet. Tap Growth on the home screen to add one, including the birth weight.' });
    const cm = lenUnitPref() === 'cm';
    renderGrowthChart({ svg: 'chLength', head: 'stLengthHead', detail: 'stLengthDetail', list: lengths, raw: w => w.lengthIn,
      val: inches => (cm ? inches * CM_PER_IN : inches), text: inches => lengthText(inches), delta: lengthDelta, rate: 0, minSpan: cm ? 2 : 1,
      color: color, sub: 'Every measurement, in ' + (cm ? 'cm' : 'inches'),
      empty: 'No lengths yet. Tap Growth, then Length, to add one.' });
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
    drawBars($('chRemoval'), days, [{ color: C('--c-breast'), get: d => d.breast }, { color: C('--c-pump'), get: d => d.pumps }], 130, d => String(d.breast + d.pumps), true);
    const aRem = avg(d => d.breast + d.pumps);
    $('stRemAvg').textContent = aRem == null ? '' : 'avg ' + fmtAvg(aRem) + '/day';
    drawBars($('chWet'), days, [{ color: C('--c-diaper'), get: d => d.wet }], 120, d => String(d.wet), true);
    drawBars($('chDirty'), days, [{ color: C('--c-diaper'), get: d => d.dirty }], 120, d => String(d.dirty), true);

    drawBars($('chSleep'), days, [{ color: C('--c-sleep'), get: d => d.sleepMin / 60 }], 120, d => (d.sleepMin / 60).toFixed(1) + 'h', true);
    // Average only over full days with sleep logged, so days before sleep tracking started don't drag it down
    const sleepDays = full.filter(d => d.sleepMin > 0);
    $('stSleepAvg').textContent = sleepDays.length ? 'avg ' + durText(sleepDays.reduce((s, d) => s + d.sleepMin, 0) / sleepDays.length) + '/day' : '';

    const sel = days.find(d => d.start === statSel);
    const when = sel.isToday ? 'Today so far' : longDay(sel.start);
    const setDetail = (id, main, rest) => { const b = $(id); b.textContent = main + ' '; if (rest) b.appendChild(h('span', { text: rest })); };
    const feeds = sel.breast + sel.bottles;
    setDetail('stIntakeDetail', when + ': ' + feeds + ' feed' + (feeds === 1 ? '' : 's'),
      '(' + sel.breast + ' breastfeed' + (sel.breast === 1 ? '' : 's') + ', ' + sel.breastMin + ' min · ' +
      sel.bottles + ' bottle' + (sel.bottles === 1 ? '' : 's') + ', ' + volOf(sel.oz) + ' ' + volUnit() + ')');
    const rem = sel.breast + sel.pumps, plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
    setDetail('stRemDetail', when + ': ' + rem + (rem === 1 ? ' time' : ' times'),
      '(' + plural(sel.breast, 'breastfeed') + ', ' + plural(sel.pumps, 'pump') + (sel.longestGap ? ' · longest stretch between ' + durText(sel.longestGap) : '') + ')');
    setDetail('stWetDetail', when + ': ' + sel.wet + ' wet', '');
    setDetail('stDirtyDetail', when + ': ' + sel.dirty + ' dirty', '');
    if (sel.sleepMin > 0) setDetail('stSleepDetail', when + ': ' + durText(sel.sleepMin) + ' asleep',
      '(' + sel.sleeps + ' sleep' + (sel.sleeps === 1 ? '' : 's') + ' started' + (sel.sleeps ? ', longest ' + durText(sel.longest) : '') + ')');
    else setDetail('stSleepDetail', when + ': no sleep logged', '');
    renderGrowth(C('--c-weight'));

    const rows = days.slice().reverse().filter(d => !d.before);
    const table = h('table', {}, [
      h('thead', {}, [h('tr', {}, ['Day', 'Feeds', 'Breast min', 'Bottle ' + volUnit(), 'Milk removal', 'Wet', 'Dirty', 'Sleep'].map(t => h('th', { text: t })))]),
      h('tbody', {}, rows.map(d => h('tr', {}, [d.isToday ? 'Today' : longDay(d.start), d.breast + d.bottles, d.breastMin, volOf(d.oz), d.breast + d.pumps, d.wet, d.dirty, d.sleepMin ? durText(d.sleepMin) : '–']
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
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && auth) refresh().then(maybeLongPrompt); });
  // Opened from a notification: show what it was about
  if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', ev => {
    if (!auth || !ev.data || ev.data.type !== 'notification') return;
    refresh(true).then(() => { if (ev.data.tag === 'long' && active) { open('feed'); setMode(true); } });
  });
  window.addEventListener('online', () => { online = true; refresh(); });
})();
