// Test server: runs the real apps-script/Code.gs against an in-memory spreadsheet and serves the app.
//   node tests/mock-server.js <repo folder> <port>
// Test-only endpoints: /__state (all tabs), /__invite (the owner invite link), /__pushes (notifications
// the script asked to send), /__checkAlerts (runs the reminder check now), /__run?fn=name.
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const APP_DIR = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const PORT = Number(process.argv[3] || 8787);
const logs = [];

/* ---------------- fake Sheets ---------------- */
class Range {
  constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr: nr || 1, nc: nc || 1 }); }
  getValues() {
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
    vals.forEach((row, i) => row.forEach((v, j) => this.sh.set(this.r + i, this.c + j, v)));
    return this;
  }
  setValue(v) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sh.set(this.r + i, this.c + j, v); return this; }
  setFontWeight() { return this; } setBackground() { return this; } setFontColor() { return this; }
  setDataValidation() { return this; } setNumberFormat() { return this; }
  setFontSize() { return this; } setHorizontalAlignment() { return this; }
}
class Sheet {
  constructor(name, cols) { this.name = name; this.rows = []; this.maxCols = cols || 26; this.maxRows = 1000; }
  set(r, c, v) { while (this.rows.length < r) this.rows.push([]); this.rows[r - 1][c - 1] = v; }
  getName() { return this.name; }
  getRange(r, c, nr, nc) {
    if (typeof r === 'string') {   // A1 notation, for example "A34:G34"
      const cell = a => { const m = /^([A-Z]+)(\d+)$/.exec(a); let col = 0; for (const ch of m[1]) col = col * 26 + ch.charCodeAt(0) - 64; return [Number(m[2]), col]; };
      const [a, b] = r.split(':'); const [r1, c1] = cell(a); const [r2, c2] = b ? cell(b) : [r1, c1];
      return new Range(this, r1, c1, r2 - r1 + 1, c2 - c1 + 1);
    }
    return new Range(this, r, c, nr, nc);
  }
  getLastRow() { for (let i = this.rows.length; i > 0; i--) if ((this.rows[i - 1] || []).some(v => v !== '' && v != null)) return i; return 0; }
  getLastColumn() { let m = 0; this.rows.forEach(r => r.forEach((v, j) => { if (v !== '' && v != null) m = Math.max(m, j + 1); })); return m; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  insertColumnsAfter(after, n) { this.maxCols += n; }
  appendRow(row) { this.rows.splice(this.getLastRow(), 0, row.slice()); }
  deleteRow(r) { this.rows.splice(r - 1, 1); }
  setFrozenRows() {}
  setColumnWidths() {} setColumnWidth() {} setName(n) { this.name = n; return this; }
}
const sheets = [new Sheet('Dashboard'), new Sheet('Log', 12), new Sheet('Daily')];
sheets[1].rows.push(['Time', 'Event', 'Left min', 'Right min', 'Bottle oz', 'First side', 'Last side', 'Feed end', 'Logged via', 'Logged at', 'Notes']);
const ss = {
  getSheetByName: n => sheets.find(s => s.name === n) || null,
  insertSheet: (n) => { const s = new Sheet(n); sheets.push(s); return s; },
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
    getProperty: k => (k in props ? props[k] : null),
    setProperty: (k, v) => { props[k] = String(v); },
    deleteProperty: k => { delete props[k]; }
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
  CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ s, setMimeType() { return this; } }) },
  Logger: { log: m => { logs.push(String(m)); console.log('[Logger]', m); } }
});
const code = fs.readFileSync(path.join(APP_DIR, 'apps-script/Code.gs'), 'utf8');
const api = new Function(code + '\nreturn { doPost, setup, createOwnerInvite, checkAlerts, setupReminders, rebuildSummaries };')();
api.setup();
api.createOwnerInvite();

/* ---------------- HTTP ---------------- */
const types = { '.html': 'text/html', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff2': 'font/woff2' };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/exec' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const out = api.doPost({ postData: { contents: body } });
      try { const q = JSON.parse(body); if (q.action !== 'list' && q.action !== 'people') console.log('REQ', new Date().toISOString().slice(17,23), q.action, JSON.stringify(q.entry ? {id: q.entry.id.slice(0,6), note: q.entry.note} : {id: (q.id||'').slice(0,6), note: q.note}), '->', out.s.slice(0,80)); } catch (e) {}
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(out.s);
    });
    return;
  }
  if (u.pathname === '/__state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(Object.fromEntries(sheets.map(s => [s.name, s.rows])), null, 1));
    return;
  }
  if (u.pathname === '/__invite') { res.end(logs.join('\n')); return; }
  if (u.pathname === '/__pushes') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(pushes)); return; }
  if (u.pathname === '/__pushResult') { pushResult = u.searchParams.get('gone') ? { ok: false, gone: true } : null; res.end('ok'); return; }
  if (u.pathname === '/__checkAlerts') { try { api.checkAlerts(); res.end('ok'); } catch (e) { res.writeHead(500); res.end(String(e.stack)); } return; }
  if (u.pathname === '/__props') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(props)); return; }
  if (u.pathname === '/__run') { const fn = u.searchParams.get('fn'); try { api[fn](); res.end('ok'); } catch (e) { res.writeHead(500); res.end(String(e.stack)); } return; }
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
