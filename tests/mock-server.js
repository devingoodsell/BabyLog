// Test server: runs the real apps-script/Code.gs against an in-memory spreadsheet and serves the app.
//   node tests/mock-server.js <repo folder> <port>
// Test-only endpoints: /__state (all tabs, plus "Log": every entry in the columns of the old single
// Log tab, so checks can read any kind of entry the same way), /__invite (the owner invite link),
// /__pushes (notifications the script asked to send), /__checkAlerts (runs the reminder check now),
// /__run?fn=name, /__legacy (POST: start over with an old-style Log tab holding these rows).
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const APP_DIR = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const PORT = Number(process.argv[3] || 8787);
const logs = [];

/* ---------------- fake Sheets ---------------- */
// How many sheet and property calls the script made (each is a slow round trip in real Apps Script)
const calls = { sheet: 0, props: 0, cache: 0 };
let delayMs = 0;   // /__delay?ms=1500 makes the script answer slowly, like real Apps Script
class Range {
  constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr: nr || 1, nc: nc || 1 }); }
  getValue() { return this.getValues()[0][0]; }
  setFormula(f) { return this.setValue(f); }
  sort(spec) {
    const col = (typeof spec === 'object' ? spec.column : spec) - this.c;
    const asc = typeof spec === 'object' ? spec.ascending !== false : true;
    const block = this.getValues();
    const key = v => (v instanceof Date ? v.getTime() : v === '' ? Infinity : v);
    block.sort((a, b) => (key(a[col]) - key(b[col])) * (asc ? 1 : -1));
    this.setValues(block);
    return this;
  }
  getValues() {
    calls.sheet++;
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = [];
      for (let j = 0; j < this.nc; j++) {
        const v = (this.sh.rows[this.r - 1 + i] || [])[this.c - 1 + j];
        row.push(v === undefined ? '' : v);
      }
      out.push(row);
    }
    return out;
  }
  setValues(vals) {
    calls.sheet++;
    vals.forEach((row, i) => row.forEach((v, j) => this.sh.set(this.r + i, this.c + j, v)));
    return this;
  }
  setValue(v) { calls.sheet++; for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sh.set(this.r + i, this.c + j, v); return this; }
  setFontWeight() { return this; } setBackground() { return this; } setFontColor() { return this; }
  setDataValidation() { return this; } setNumberFormat() { return this; } setNumberFormats() { return this; }
  setFontSize() { return this; } setHorizontalAlignment() { return this; }
}
class Sheet {
  constructor(name, cols) { this.name = name; this.rows = []; this.maxCols = cols || 26; this.maxRows = 1000; }
  set(r, c, v) { while (this.rows.length < r) this.rows.push([]); this.rows[r - 1][c - 1] = v; }
  getName() { return this.name; }
  getRange(r, c, nr, nc) {
    if (typeof r === 'string') {   // A1 notation, for example "A34:G34"
      const cell = a => { const m = /^([A-Z]+)(\d*)$/.exec(a); let col = 0; for (const ch of m[1]) col = col * 26 + ch.charCodeAt(0) - 64; return [m[2] ? Number(m[2]) : this.maxRows, col]; };
      const [a, b] = r.split(':'); const [r1, c1] = cell(a); const [r2, c2] = b ? cell(b) : [r1, c1];
      return new Range(this, r1, c1, r2 - r1 + 1, c2 - c1 + 1);
    }
    return new Range(this, r, c, nr, nc);
  }
  getDataRange() { calls.sheet++; return new Range(this, 1, 1, Math.max(1, this._lastRow()), Math.max(1, this._lastCol())); }
  getLastRow() { calls.sheet++; return this._lastRow(); }
  getLastColumn() { calls.sheet++; return this._lastCol(); }
  _lastRow() { for (let i = this.rows.length; i > 0; i--) if ((this.rows[i - 1] || []).some(v => v !== '' && v != null)) return i; return 0; }
  _lastCol() { let m = 0; this.rows.forEach(r => r.forEach((v, j) => { if (v !== '' && v != null) m = Math.max(m, j + 1); })); return m; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { calls.sheet++; return this.maxCols; }
  insertColumnsAfter(after, n) { this.maxCols += n; }
  insertRowsAfter(after, n) { this.maxRows += n; }
  appendRow(row) { calls.sheet++; const at = this._lastRow(); this.rows.splice(at, this.rows.length - at, row.slice()); this.maxRows = Math.max(this.maxRows, at + 1); }
  deleteRow(r) { this.rows.splice(r - 1, 1); }
  setFrozenRows() {}
  setColumnWidths() {} setColumnWidth() {} setName(n) { this.name = n; return this; }
}
const sheets = [new Sheet('Sheet1')];   // a brand-new spreadsheet
const ss = {
  getSheetByName: n => { calls.sheet++; return sheets.find(s => s.name === n) || null; },
  insertSheet: (n, i) => { const s = new Sheet(n); sheets.splice(i == null ? sheets.length : Math.min(i, sheets.length), 0, s); return s; },
  deleteSheet: (sh) => { const i = sheets.indexOf(sh); if (i >= 0) sheets.splice(i, 1); },
  getSheets: () => sheets,
  getNumSheets: () => sheets.length
};
const props = {};
const pushes = [];          // what the script handed to the push service
let pushResult = null;      // tests can make the push service answer "gone"
const triggers = [];
const cache = {};
Object.assign(global, {
  SpreadsheetApp: {
    getActive: () => ss,
    getUi: () => { throw new Error('No UI in tests'); },
    newDataValidation: () => ({ requireValueInList() { return this; }, build() { return {}; } })
  },
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
    computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(s, 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
    base64EncodeWebSafe: bytes => Buffer.from(bytes.map(b => (b + 256) % 256)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    getUuid: () => crypto.randomUUID(),
    formatDate: (d, tz, fmt) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })
  },
  PropertiesService: { getScriptProperties: () => ({
    getProperty: k => { calls.props++; return k in props ? props[k] : null; },
    getProperties: () => { calls.props++; return Object.assign({}, props); },
    setProperty: (k, v) => { calls.props++; props[k] = String(v); },
    deleteProperty: k => { calls.props++; delete props[k]; }
  }) },
  ScriptApp: {
    getProjectTriggers: () => triggers,
    newTrigger: fn => ({ timeBased() { return this; }, everyMinutes(n) { this.n = n; return this; },
      create() { triggers.push({ getHandlerFunction: () => fn, minutes: this.n }); } })
  },
  UrlFetchApp: { fetch: (url, opts) => {
    const body = JSON.parse(opts.payload);
    body.messages.forEach(m => pushes.push({ url, auth: opts.headers.Authorization, ...m }));
    const results = body.messages.map(() => pushResult || { ok: true });
    return { getContentText: () => JSON.stringify({ results }) };
  } },
  Session: { getScriptTimeZone: () => 'America/New_York' },
  CacheService: { getScriptCache: () => ({ get: k => { calls.cache++; return cache[k] || null; }, put: (k, v) => { calls.cache++; cache[k] = v; }, remove: k => { calls.cache++; delete cache[k]; } }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ s, setMimeType() { return this; } }) },
  Logger: { log: m => { logs.push(String(m)); console.log('[Logger]', m); } }
});
const code = fs.readFileSync(path.join(APP_DIR, 'apps-script/Code.gs'), 'utf8');
// (typeof checks let this also run older versions of Code.gs)
const api = new Function(code + '\nconst f = n => { try { return eval(n); } catch (e) { return null; } };' +
  '\nreturn { doPost, setup, createOwnerInvite, checkAlerts: f("checkAlerts"), setupReminders: f("setupReminders"), rebuildSummaries: f("rebuildSummaries"),' +
  ' migrateToTabs: f("migrateToTabs"), readTab_: f("readTab_"), recToEntry_: f("recToEntry_"), TAB_KEYS: f("TAB_KEYS") };')();
api.setup();
api.createOwnerInvite();

/* ---------------- The old single Log, as a view ---------------- */
// Every entry laid out in the 34 columns the old Log tab had, oldest logged first, built from what
// the script reads back out of its tabs. Older checks read entries this way.
const LEGACY = ['Time', 'Event', 'Left min', 'Right min', 'Bottle oz', 'First side', 'Last side',
  'End', 'Logged by', 'Logged at', 'Notes', 'ID', 'Amount', 'Unit', 'Milk', 'Pump side', 'Pump min', 'Label', 'Left pumped', 'Right pumped', 'Pump unit', 'Pumped oz',
  'Sleep min', 'Weight lb', 'Weight', 'Detail', 'Dose', 'Temp F', 'Temp', 'Remind h', 'Length in', 'Length', 'Activity min', 'Updated at'];
const L = Object.fromEntries(['TIME', 'EVENT', 'LEFT', 'RIGHT', 'OZ', 'FIRST', 'LAST', 'END', 'BY', 'AT', 'NOTES', 'ID', 'AMOUNT', 'UNIT', 'MILK', 'PSIDE', 'PMIN', 'LABEL',
  'PLEFT', 'PRIGHT', 'PUNIT', 'POZ', 'SLEEPMIN', 'WLB', 'WTXT', 'DETAIL', 'DOSE', 'TEMPF', 'TEMP', 'REMIND', 'LIN', 'LTXT', 'AMIN', 'UPD'].map((k, i) => [k, i]));
const HEALTH = { med: 'Medicine', temp: 'Temperature', vaccine: 'Vaccine', symptom: 'Symptom', visit: 'Doctor visit' };
function legacyRow(e, at, upd) {
  const row = new Array(LEGACY.length).fill('');
  Object.assign(row, { [L.TIME]: new Date(e.t), [L.ID]: e.id, [L.NOTES]: e.note || '', [L.BY]: e.by, [L.AT]: at, [L.UPD]: upd });
  if (e.type === 'breast') {
    Object.assign(row, { [L.EVENT]: 'Breastfeed', [L.LEFT]: e.left, [L.RIGHT]: e.right, [L.FIRST]: e.first === 'L' ? 'Left' : 'Right', [L.LAST]: e.last === 'L' ? 'Left' : 'Right', [L.END]: new Date(e.end) });
  } else if (e.type === 'bottle') {
    Object.assign(row, { [L.EVENT]: 'Bottle', [L.OZ]: e.oz, [L.AMOUNT]: e.amount, [L.UNIT]: e.unit === 'ml' ? 'mL' : 'oz', [L.MILK]: { breast: 'Breast milk', formula: 'Formula' }[e.source] || '' });
  } else if (e.type === 'pump') {
    Object.assign(row, { [L.EVENT]: 'Pump', [L.PSIDE]: { L: 'Left', R: 'Right', B: 'Both' }[e.side], [L.PMIN]: e.minutes, [L.LABEL]: e.label, [L.END]: new Date(e.t + e.minutes * 60000) });
    if (e.leftAmt != null || e.rightAmt != null) {
      Object.assign(row, { [L.PLEFT]: e.leftAmt != null ? e.leftAmt : '', [L.PRIGHT]: e.rightAmt != null ? e.rightAmt : '', [L.PUNIT]: e.pumpUnit === 'ml' ? 'mL' : 'oz', [L.POZ]: e.pumpedOz });
    }
  } else if (e.type === 'sleep') {
    row[L.EVENT] = 'Sleep';
    if (e.end) { row[L.END] = new Date(e.end); row[L.SLEEPMIN] = e.minutes; }
  } else if (e.type === 'weight') {
    let lb = Math.floor(e.weightOz / 16), rest = Math.round((e.weightOz - lb * 16) * 10) / 10;
    if (rest >= 16) { lb += 1; rest = 0; }
    Object.assign(row, { [L.EVENT]: 'Weight', [L.WLB]: Math.round(e.weightOz / 16 * 1000) / 1000, [L.WTXT]: lb + ' lb ' + rest + ' oz' });
  } else if (e.type === 'length') {
    Object.assign(row, { [L.EVENT]: 'Length', [L.LIN]: e.lengthIn, [L.LTXT]: e.lengthUnit === 'cm' ? (Math.round(e.lengthIn * 2.54 * 10) / 10) + ' cm' : e.lengthIn + ' in' });
  } else if (e.type === 'health') {
    Object.assign(row, { [L.EVENT]: HEALTH[e.kind], [L.DETAIL]: e.detail });
    if (e.kind === 'med') Object.assign(row, { [L.DOSE]: e.dose, [L.REMIND]: e.remindHours || '' });
    if (e.kind === 'temp') Object.assign(row, { [L.TEMPF]: e.tempF, [L.TEMP]: e.tempUnit === 'C' ? (Math.round((e.tempF - 32) / 1.8 * 10) / 10) + ' °C' : e.tempF + ' °F' });
  } else if (e.type === 'activity') {
    Object.assign(row, { [L.EVENT]: 'Activity', [L.DETAIL]: e.detail });
    if (e.minutes) Object.assign(row, { [L.AMIN]: e.minutes, [L.END]: new Date(e.t + e.minutes * 60000) });
  } else {
    row[L.EVENT] = { wet: 'Wet diaper', dirty: 'Dirty diaper', both: 'Wet + dirty diaper' }[e.kind];
  }
  return row;
}
function legacyView() {
  const items = [];
  (api.TAB_KEYS || []).forEach((k, ki) => {
    let t; try { t = api.readTab_(k); } catch (e) { return; }
    t.rows.forEach((r, i) => {
      const e = api.recToEntry_(t, r);
      const at = r[t.c['Logged at']];
      if (e) items.push({ e, at, upd: r[t.c['Updated at']], key: [at instanceof Date ? at.getTime() : Infinity, ki, i] });
    });
  });
  items.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2]);
  return [LEGACY].concat(items.map(x => legacyRow(x.e, x.at, x.upd)));
}
// Starts over with a sheet from before the tabs: an old-style Log holding these rows (times as ISO text)
function resetLegacy(rows, header) {
  for (let i = sheets.length - 1; i >= 0; i--) if (!['Devices', 'Invites', 'Push'].includes(sheets[i].name)) sheets.splice(i, 1);
  const log = new Sheet('Log', 40);
  const head = header || LEGACY;
  const dateCols = ['Time', 'End', 'Feed end', 'Logged at', 'Updated at'].map(h => head.indexOf(h)).filter(i => i >= 0);
  log.rows.push(head.slice());
  rows.forEach(r => log.rows.push(r.map((v, j) => (dateCols.includes(j) && typeof v === 'string' && v && !isNaN(Date.parse(v)) ? new Date(v) : v))));
  sheets.splice(0, 0, new Sheet('Dashboard'), log, new Sheet('Daily'));
  delete props.migratedAt;
}

/* ---------------- HTTP ---------------- */
const types = { '.html': 'text/html', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff2': 'font/woff2' };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/exec' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => setTimeout(() => {
      const out = api.doPost({ postData: { contents: body } });
      try { const q = JSON.parse(body); if (q.action !== 'list' && q.action !== 'people') console.log('REQ', new Date().toISOString().slice(17,23), q.action, JSON.stringify(q.entry ? {id: q.entry.id.slice(0,6), note: q.entry.note} : {id: (q.id||'').slice(0,6), note: q.note}), '->', out.s.slice(0,80)); } catch (e) {}
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(out.s);
    }, delayMs));
    return;
  }
  if (u.pathname === '/__state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const st = Object.fromEntries(sheets.map(s => [s.name, s.rows]));
    if (sheets.some(s => s.name === 'Feeds')) st.Log = legacyView();
    res.end(JSON.stringify(st, null, 1));
    return;
  }
  if (u.pathname === '/__edit') {   // a hand edit: set one cell of an entry's row by column name
    const sh = sheets.find(x => x.name === u.searchParams.get('tab'));
    const head = sh.rows[0], r = sh.rows.find(x => x[head.indexOf('ID')] === u.searchParams.get('id'));
    const v = u.searchParams.get('value');
    r[head.indexOf(u.searchParams.get('col'))] = v !== '' && isFinite(Number(v)) ? Number(v) : v;
    res.end('ok');
    return;
  }
  if (u.pathname === '/__legacy' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { const q = JSON.parse(body); resetLegacy(q.rows, q.header); res.end('ok'); });
    return;
  }
  if (u.pathname === '/__delay') { delayMs = Number(u.searchParams.get('ms')) || 0; res.end('ok'); return; }
  if (u.pathname === '/__calls') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(calls)); if (u.searchParams.get('reset')) Object.keys(calls).forEach(k => { calls[k] = 0; }); return; }
  if (u.pathname === '/__invite') { res.end(logs.join('\n')); return; }
  if (u.pathname === '/__pushes') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(pushes)); return; }
  if (u.pathname === '/__pushResult') { pushResult = u.searchParams.get('gone') ? { ok: false, gone: true } : null; res.end('ok'); return; }
  if (u.pathname === '/__checkAlerts') { try { api.checkAlerts(); res.end('ok'); } catch (e) { res.writeHead(500); res.end(String(e.stack)); } return; }
  if (u.pathname === '/__props') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(props)); return; }
  if (u.pathname === '/__run') {
    const fn = u.searchParams.get('fn');
    try { const out = api[fn](); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out === undefined ? 'ok' : out)); }
    catch (e) { res.writeHead(500); res.end(String(e.stack)); }
    return;
  }
  let p = u.pathname === '/' ? '/index.html' : u.pathname;
  if (p === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end("window.BABYLOG_CONFIG = { apiUrl: 'http://localhost:" + PORT + "/exec' };");
    return;
  }
  const f = path.join(APP_DIR, p);
  if (!f.startsWith(APP_DIR) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  let data = fs.readFileSync(f);
  if (p === '/index.html') data = Buffer.from(String(data).replace('connect-src https://script.google.com', 'connect-src http://localhost:' + PORT + ' https://script.google.com'));
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  res.end(data);
}).listen(PORT, () => console.log('mock on', PORT));
