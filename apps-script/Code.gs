/**
 * @OnlyCurrentDoc
 *
 * Baby Log backend. Paste into Extensions > Apps Script in the Baby Log sheet.
 *
 * The @OnlyCurrentDoc line above limits this script to this one spreadsheet:
 * Google grants it no access to any other file in your Drive.
 *
 * Every request must carry a device key, except redeeming an invite or setup code.
 * Keys and codes are stored only as SHA-256 hashes in the Devices and Invites tabs.
 */

// If you fork this, change these two lines (see the README).
const APP_URL = 'https://devingoodsell.github.io/BabyLog/';
const OWNER_NAME = 'Devin';
const INVITE_HOURS = 72;     // unused invite links expire after this long
const PAIR_MINUTES = 15;     // setup codes (moving to the Home Screen app) expire after this long
const LIST_DAYS = 30;        // how much history the app downloads (Stats shows up to 30 days)
const FAIL_LIMIT = 30;       // failed redeem attempts allowed per 10 minutes before redeem pauses

const LOG = 'Log';
const DEVICES = 'Devices';
const INVITES = 'Invites';

const LOG_HEADERS = ['Time', 'Event', 'Left min', 'Right min', 'Bottle oz', 'First side', 'Last side',
  'Feed end', 'Logged by', 'Logged at', 'Notes', 'ID', 'Amount', 'Unit', 'Milk', 'Pump side', 'Pump min', 'Label', 'Left pumped', 'Right pumped', 'Pump unit', 'Pumped oz'];
const ML_PER_OZ = 29.5735;
const DEV_HEADERS = ['Name', 'Role', 'Status', 'Created', 'Last used', 'Device ID', 'Invited by', 'Key hash'];
const INV_HEADERS = ['Name', 'Role', 'Kind', 'Status', 'Created', 'Expires', 'Used at', 'Device ID', 'Invite ID', 'Created by', 'Code hash'];

// Log column positions (0-based)
const L = { TIME: 0, EVENT: 1, LEFT: 2, RIGHT: 3, OZ: 4, FIRST: 5, LAST: 6, END: 7, BY: 8, AT: 9, NOTES: 10, ID: 11, AMOUNT: 12, UNIT: 13, MILK: 14, PSIDE: 15, PMIN: 16, LABEL: 17, PLEFT: 18, PRIGHT: 19, PUNIT: 20, POZ: 21 };
const PUMP_SIDES = { L: 'Left', R: 'Right', B: 'Both' };
const MILK = { breast: 'Breast milk', formula: 'Formula' };
// Devices column positions
const D = { NAME: 0, ROLE: 1, STATUS: 2, CREATED: 3, USED: 4, ID: 5, BY: 6, HASH: 7 };
// Invites column positions
const I = { NAME: 0, ROLE: 1, KIND: 2, STATUS: 3, CREATED: 4, EXPIRES: 5, USED: 6, DEVICE: 7, ID: 8, BY: 9, HASH: 10 };

const DIAPER_EVENTS = { wet: 'Wet diaper', dirty: 'Dirty diaper', both: 'Wet + dirty diaper' };

/* ================================================================== */
/* Web app entry points                                                */
/* ================================================================== */

function doGet() {
  return ContentService.createTextOutput('Baby Log is running.');
}

function doPost(e) {
  let res;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    res = Object.assign({ ok: true }, handle_(req));
  } catch (err) {
    const code = err && err.code ? err.code : 'error';
    res = { ok: false, error: code, message: code === 'error' ? String(err && err.message || err) : err.message };
  }
  return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
}

function handle_(req) {
  const action = String(req.action || '');
  if (action === 'peek') return peek_(req.code);
  if (action === 'redeem') return withLock_(() => redeem_(req.code, req.name));

  const dev = auth_(req.token);
  switch (action) {
    case 'me': return { me: publicMe_(dev) };
    case 'list': return { me: publicMe_(dev), entries: list_() };
    case 'add': return withLock_(() => add_(dev, req.entry));
    case 'delete': return withLock_(() => remove_(req.id));
    case 'update': return withLock_(() => updateNote_(req.id, req.note));
    case 'pair': return withLock_(() => pair_(dev));
    case 'invite': requireAdmin_(dev); return withLock_(() => invite_(dev, req.name, req.role));
    case 'people': requireAdmin_(dev); return people_(dev);
    case 'revoke': requireAdmin_(dev); return withLock_(() => revoke_(dev, req.deviceId, req.inviteId));
    case 'signout': return withLock_(() => setDeviceStatus_(dev.id, 'Signed out'));
    default: throw fail_('bad_request', 'Unknown action');
  }
}

/* ================================================================== */
/* Auth                                                                */
/* ================================================================== */

function auth_(token) {
  if (!token || typeof token !== 'string' || token.length < 40) throw fail_('unauthorized', 'This phone does not have access.');
  const h = hash_(token);
  const sh = sheet_(DEVICES);
  const rows = data_(sh);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r[D.HASH] !== h) continue;
    if (r[D.STATUS] !== 'Active') break;
    const used = r[D.USED] instanceof Date ? r[D.USED].getTime() : 0;
    if (Date.now() - used > 10 * 60000) sh.getRange(i + 2, D.USED + 1).setValue(new Date());
    return { row: i + 2, name: String(r[D.NAME]), role: String(r[D.ROLE]), id: String(r[D.ID]) };
  }
  throw fail_('unauthorized', 'This phone no longer has access.');
}

function requireAdmin_(dev) {
  if (dev.role !== 'admin') throw fail_('forbidden', 'Only people who can manage access can do this.');
}

function publicMe_(dev) {
  return { name: dev.name, role: dev.role, deviceId: dev.id };
}

/* ================================================================== */
/* Invites and setup codes                                             */
/* ================================================================== */

function normalizeCode_(code) {
  const c = String(code || '').replace(/[^A-Za-z0-9]/g, '');
  return c.length === 8 ? c.toUpperCase() : c.toLowerCase();
}

function findInvite_(code) {
  const c = normalizeCode_(code);
  if (c.length !== 8 && c.length !== 32) return null;
  const h = hash_(c);
  const sh = sheet_(INVITES);
  const rows = data_(sh);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][I.HASH] === h) return { sh: sh, row: i + 2, r: rows[i] };
  }
  return null;
}

function checkInvite_(found) {
  if (!found) return 'invalid_invite';
  const r = found.r;
  if (r[I.STATUS] !== 'Pending') return 'used_invite';
  if (!(r[I.EXPIRES] instanceof Date) || r[I.EXPIRES].getTime() < Date.now()) {
    found.sh.getRange(found.row, I.STATUS + 1).setValue('Expired');
    return 'expired_invite';
  }
  return '';
}

function peek_(code) {
  rateLimit_();
  const found = findInvite_(code);
  const problem = checkInvite_(found);
  if (problem) { noteFailure_(); throw fail_(problem, inviteMessage_(problem)); }
  return { invite: { name: String(found.r[I.NAME]), kind: String(found.r[I.KIND]), from: String(found.r[I.BY]) } };
}

function redeem_(code, name) {
  rateLimit_();
  const found = findInvite_(code);
  const problem = checkInvite_(found);
  if (problem) { noteFailure_(); throw fail_(problem, inviteMessage_(problem)); }

  const r = found.r;
  const kind = String(r[I.KIND]);
  const displayName = kind === 'Invite' ? cleanName_(name) || String(r[I.NAME]) : String(r[I.NAME]);
  const role = r[I.ROLE] === 'admin' ? 'admin' : 'member';
  const token = randomHex_(64);
  const deviceId = randomHex_(12);

  sheet_(DEVICES).appendRow([displayName, role, 'Active', new Date(), new Date(), deviceId, String(r[I.BY]), hash_(token)]);
  found.sh.getRange(found.row, I.STATUS + 1, 1, 1).setValue('Used');
  found.sh.getRange(found.row, I.USED + 1, 1, 2).setValues([[new Date(), deviceId]]);

  return { token: token, me: { name: displayName, role: role, deviceId: deviceId } };
}

function invite_(dev, name, role) {
  const n = cleanName_(name);
  if (!n) throw fail_('bad_request', 'Enter a name for the person you are inviting.');
  return createInvite_(n, role === 'admin' ? 'admin' : 'member', dev.name);
}

function createInvite_(name, role, createdBy) {
  const code = randomHex_(32);
  const id = randomHex_(10);
  const expires = new Date(Date.now() + INVITE_HOURS * 3600000);
  sheet_(INVITES).appendRow([name, role, 'Invite', 'Pending', new Date(), expires, '', '', id, createdBy, hash_(code)]);
  return { code: code, inviteId: id, link: APP_URL + '#invite=' + code, expires: expires.getTime(), name: name, role: role };
}

function pair_(dev) {
  const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  const hex = randomHex_(16);
  let code = '';
  for (let i = 0; i < 8; i++) code += alphabet[parseInt(hex.substr(i * 2, 2), 16) % alphabet.length];
  const expires = new Date(Date.now() + PAIR_MINUTES * 60000);
  sheet_(INVITES).appendRow([dev.name, dev.role, 'Setup code', 'Pending', new Date(), expires, '', '', randomHex_(10), dev.name, hash_(code)]);
  return { code: code.slice(0, 4) + '-' + code.slice(4), expires: expires.getTime() };
}

function inviteMessage_(problem) {
  if (problem === 'used_invite') return 'This link or code has already been used. Ask for a new one.';
  if (problem === 'expired_invite') return 'This link or code has expired. Ask for a new one.';
  return 'This link or code is not valid. Check it, or ask for a new one.';
}

function rateLimit_() {
  const n = Number(CacheService.getScriptCache().get('fails') || 0);
  if (n >= FAIL_LIMIT) throw fail_('rate_limited', 'Too many attempts. Try again in 10 minutes.');
}

function noteFailure_() {
  const cache = CacheService.getScriptCache();
  cache.put('fails', String(Number(cache.get('fails') || 0) + 1), 600);
}

/* ================================================================== */
/* People                                                              */
/* ================================================================== */

function people_(dev) {
  const devices = data_(sheet_(DEVICES))
    .filter(r => r[D.STATUS] === 'Active')
    .map(r => ({
      deviceId: String(r[D.ID]), name: String(r[D.NAME]), role: String(r[D.ROLE]),
      lastUsed: r[D.USED] instanceof Date ? r[D.USED].getTime() : null,
      isMe: String(r[D.ID]) === dev.id
    }));
  const now = Date.now();
  const invites = data_(sheet_(INVITES))
    .filter(r => r[I.KIND] === 'Invite' && r[I.STATUS] === 'Pending' && r[I.EXPIRES] instanceof Date && r[I.EXPIRES].getTime() > now)
    .map(r => ({ inviteId: String(r[I.ID]), name: String(r[I.NAME]), role: String(r[I.ROLE]), expires: r[I.EXPIRES].getTime() }));
  return { devices: devices, invites: invites };
}

function revoke_(dev, deviceId, inviteId) {
  if (deviceId) {
    if (String(deviceId) === dev.id) throw fail_('bad_request', 'Use Sign out to remove this phone.');
    return setDeviceStatus_(String(deviceId), 'Revoked');
  }
  if (inviteId) {
    const sh = sheet_(INVITES);
    const rows = data_(sh);
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][I.ID]) === String(inviteId) && rows[i][I.STATUS] === 'Pending') {
        sh.getRange(i + 2, I.STATUS + 1).setValue('Cancelled');
      }
    }
    return {};
  }
  throw fail_('bad_request', 'Nothing to remove.');
}

function setDeviceStatus_(deviceId, status) {
  const sh = sheet_(DEVICES);
  const rows = data_(sh);
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][D.ID]) === deviceId) sh.getRange(i + 2, D.STATUS + 1).setValue(status);
  }
  return {};
}

/* ================================================================== */
/* Entries                                                             */
/* ================================================================== */

function add_(dev, e) {
  const entry = validateEntry_(e);
  entry.note = cleanNote_(e && e.note);
  const sh = sheet_(LOG);
  const ids = logIds_(sh);
  if (ids.indexOf(entry.id) !== -1) return { entry: entry, duplicate: true };

  const row = new Array(LOG_HEADERS.length).fill('');
  row[L.TIME] = new Date(entry.t);
  row[L.BY] = dev.name;
  row[L.AT] = new Date();
  row[L.ID] = entry.id;
  row[L.NOTES] = safeCell_(entry.note);
  if (entry.type === 'breast') {
    row[L.EVENT] = 'Breastfeed';
    row[L.LEFT] = entry.left;
    row[L.RIGHT] = entry.right;
    row[L.FIRST] = entry.first === 'L' ? 'Left' : 'Right';
    row[L.LAST] = entry.last === 'L' ? 'Left' : 'Right';
    row[L.END] = new Date(entry.t + (entry.left + entry.right) * 60000);
  } else if (entry.type === 'bottle') {
    row[L.EVENT] = 'Bottle';
    row[L.OZ] = entry.oz;            // always ounces, so sheet totals add up
    row[L.AMOUNT] = entry.amount;    // exactly as entered
    row[L.UNIT] = entry.unit === 'ml' ? 'mL' : 'oz';
    row[L.MILK] = MILK[entry.source] || '';
  } else if (entry.type === 'pump') {
    row[L.EVENT] = 'Pump';
    row[L.PSIDE] = PUMP_SIDES[entry.side];
    row[L.PMIN] = entry.minutes;
    row[L.LABEL] = safeCell_(entry.label);
    if (entry.leftAmt != null || entry.rightAmt != null) {
      row[L.PLEFT] = entry.leftAmt != null ? entry.leftAmt : '';
      row[L.PRIGHT] = entry.rightAmt != null ? entry.rightAmt : '';
      row[L.PUNIT] = entry.pumpUnit === 'ml' ? 'mL' : 'oz';
      row[L.POZ] = entry.pumpedOz;
    }
    row[L.END] = new Date(entry.t + entry.minutes * 60000);
  } else {
    row[L.EVENT] = DIAPER_EVENTS[entry.kind];
  }
  sh.appendRow(row);
  entry.by = dev.name;
  return { entry: entry };
}

function validateEntry_(e) {
  const bad = msg => fail_('bad_request', msg);
  if (!e || typeof e !== 'object') throw bad('Missing entry');
  const id = String(e.id || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw bad('Bad entry id');
  const t = Number(e.t);
  if (!(t > Date.now() - 7 * 86400000 && t < Date.now() + 10 * 60000)) throw bad('The time must be within the last 7 days');
  const side = s => (s === 'L' || s === 'R' ? s : null);
  const mins = m => { const n = Math.round(Number(m) || 0); return n >= 0 && n <= 180 ? n : NaN; };

  if (e.type === 'breast') {
    const left = mins(e.left), right = mins(e.right);
    if (isNaN(left) || isNaN(right)) throw bad('Minutes must be between 0 and 180');
    if (!side(e.first) || !side(e.last)) throw bad('Missing side');
    return { id: id, type: 'breast', t: t, left: left, right: right, first: e.first, last: e.last };
  }
  if (e.type === 'bottle') {
    const unit = e.unit === 'ml' ? 'ml' : 'oz';
    const raw = Number(e.amount != null ? e.amount : e.oz);
    const amount = unit === 'ml' ? Math.round(raw * 10) / 10 : Math.round(raw * 100) / 100;
    if (unit === 'ml' && !(amount >= 0.1 && amount <= 500)) throw bad('mL must be between 0.1 and 500');
    if (unit === 'oz' && !(amount > 0 && amount <= 20)) throw bad('Ounces must be between 0 and 20');
    const oz = unit === 'ml' ? Math.round(amount / ML_PER_OZ * 100) / 100 : amount;
    const source = MILK[e.source] ? e.source : '';
    return { id: id, type: 'bottle', t: t, oz: oz, amount: amount, unit: unit, source: source };
  }
  if (e.type === 'pump') {
    if (!PUMP_SIDES[e.side]) throw bad('Choose left, right or both');
    const minutes = Math.round(Number(e.minutes));
    if (!(minutes >= 1 && minutes <= 180)) throw bad('Pump minutes must be between 1 and 180');
    const label = String(e.label || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60);
    const pumpUnit = e.pumpUnit === 'ml' ? 'ml' : 'oz';
    const amt = (v, used) => {
      if (!used || v === '' || v == null) return null;
      const n = Number(v);
      if (!isFinite(n) || n < 0 || n > (pumpUnit === 'ml' ? 600 : 20)) throw bad('Pumped amount is out of range');
      return pumpUnit === 'ml' ? Math.round(n * 10) / 10 : Math.round(n * 100) / 100;
    };
    const leftAmt = amt(e.leftAmt, e.side !== 'R');
    const rightAmt = amt(e.rightAmt, e.side !== 'L');
    const total = (leftAmt || 0) + (rightAmt || 0);
    const pumpedOz = pumpUnit === 'ml' ? Math.round(total / ML_PER_OZ * 100) / 100 : Math.round(total * 100) / 100;
    return { id: id, type: 'pump', t: t, side: e.side, minutes: minutes, label: label,
      leftAmt: leftAmt, rightAmt: rightAmt, pumpUnit: pumpUnit, pumpedOz: pumpedOz };
  }
  if (e.type === 'diaper') {
    if (!DIAPER_EVENTS[e.kind]) throw bad('Unknown diaper type');
    return { id: id, type: 'diaper', t: t, kind: e.kind };
  }
  throw bad('Unknown entry type');
}

function list_() {
  const sh = sheet_(LOG);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const cols = Math.min(LOG_HEADERS.length, sh.getMaxColumns());
  const rows = sh.getRange(2, 1, last - 1, cols).getValues();
  const since = Date.now() - LIST_DAYS * 86400000;
  const out = [];
  rows.forEach((r, i) => {
    if (!(r[L.TIME] instanceof Date) || r[L.TIME].getTime() < since) return;
    const entry = rowToEntry_(r);
    if (!entry) return;
    if (!entry.id) { // a row typed in by hand: give it an ID so the app can delete it
      entry.id = randomHex_(16);
      sh.getRange(i + 2, L.ID + 1).setValue(entry.id);
    }
    out.push(entry);
  });
  out.sort((a, b) => b.t - a.t);
  return out;
}

function rowToEntry_(r) {
  const base = { id: String(r[L.ID] || ''), t: r[L.TIME].getTime(), by: String(r[L.BY] || ''), note: String(r[L.NOTES] || '') };
  const ev = String(r[L.EVENT]).trim();
  const sideOf = v => (/^r/i.test(String(v)) ? 'R' : /^l/i.test(String(v)) ? 'L' : '');
  if (ev === 'Breastfeed') {
    const left = Number(r[L.LEFT]) || 0, right = Number(r[L.RIGHT]) || 0;
    const first = sideOf(r[L.FIRST]) || (left ? 'L' : 'R');
    const last = sideOf(r[L.LAST]) || (left && right ? (first === 'L' ? 'R' : 'L') : first);
    return Object.assign(base, { type: 'breast', left: left, right: right, first: first, last: last });
  }
  if (ev === 'Bottle') {
    const oz = Number(r[L.OZ]) || 0;
    const unit = /ml/i.test(String(r[L.UNIT] || '')) ? 'ml' : 'oz';
    const amount = Number(r[L.AMOUNT]) || (unit === 'ml' ? Math.round(oz * ML_PER_OZ * 10) / 10 : oz);
    const milk = String(r[L.MILK] || '');
    const source = /formula/i.test(milk) ? 'formula' : /breast/i.test(milk) ? 'breast' : '';
    return Object.assign(base, { type: 'bottle', oz: oz, amount: amount, unit: unit, source: source });
  }
  if (ev === 'Pump') {
    const sideText = String(r[L.PSIDE] || '');
    const side = /^b/i.test(sideText) ? 'B' : /^r/i.test(sideText) ? 'R' : 'L';
    const num = v => (v === '' || v == null || !isFinite(Number(v)) ? null : Number(v));
    return Object.assign(base, { type: 'pump', side: side, minutes: Number(r[L.PMIN]) || 0, label: String(r[L.LABEL] || ''),
      leftAmt: num(r[L.PLEFT]), rightAmt: num(r[L.PRIGHT]), pumpUnit: /ml/i.test(String(r[L.PUNIT] || '')) ? 'ml' : 'oz', pumpedOz: num(r[L.POZ]) });
  }
  for (const k in DIAPER_EVENTS) if (DIAPER_EVENTS[k] === ev) return Object.assign(base, { type: 'diaper', kind: k });
  return null;
}

function remove_(id) {
  const sh = sheet_(LOG);
  const ids = logIds_(sh);
  const i = ids.indexOf(String(id));
  if (i !== -1) sh.deleteRow(i + 2);
  return {};
}

function updateNote_(id, note) {
  const sh = sheet_(LOG);
  const i = logIds_(sh).indexOf(String(id));
  if (i === -1) throw fail_('bad_request', 'That entry no longer exists.');
  const clean = cleanNote_(note);
  sh.getRange(i + 2, L.NOTES + 1).setValue(safeCell_(clean));
  return { id: String(id), note: clean };
}

function logIds_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, L.ID + 1, last - 1, 1).getValues().map(r => String(r[0]));
}

/* ================================================================== */
/* One-time setup (run from the Apps Script editor)                    */
/* ================================================================== */

/** Step 1: run once. Creates the Devices and Invites tabs. */
function setup() {
  const ss = SpreadsheetApp.getActive();
  let log = ss.getSheetByName(LOG);
  if (!log) log = createLogTab_(ss);
  if (!ss.getSheetByName('Dashboard')) buildDashboard_(ss.insertSheet('Dashboard', 0));
  if (!ss.getSheetByName('Daily')) buildDaily_(ss.insertSheet('Daily', 2));
  if (log.getMaxColumns() < LOG_HEADERS.length) log.insertColumnsAfter(log.getMaxColumns(), LOG_HEADERS.length - log.getMaxColumns());
  log.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]);
  ensureTab_(DEVICES, DEV_HEADERS);
  ensureTab_(INVITES, INV_HEADERS);
  Logger.log('Setup done. Next: Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).');
}

/** Step 3: run after deploying. Prints your own single-use invite link. */
function createOwnerInvite() {
  setup();
  const inv = createInvite_(OWNER_NAME, 'admin', OWNER_NAME);
  Logger.log('Open this on your phone within ' + INVITE_HOURS + ' hours. It works once:\n' + inv.link);
}

/* Tabs for a brand-new sheet. setup() only creates the ones that are missing. */

function createLogTab_(ss) {
  const first = ss.getSheets()[0];
  const blank = ss.getSheets().length === 1 && first.getLastRow() === 0;
  const sh = blank ? first.setName(LOG) : ss.insertSheet(LOG);
  if (sh.getMaxColumns() < LOG_HEADERS.length) sh.insertColumnsAfter(sh.getMaxColumns(), LOG_HEADERS.length - sh.getMaxColumns());
  sh.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]).setFontWeight('bold')
    .setBackground('#263238').setFontColor('#FFFFFF');
  sh.setFrozenRows(1);
  const rows = sh.getMaxRows() - 1;
  [L.TIME, L.END, L.AT].forEach(c => sh.getRange(2, c + 1, rows, 1).setNumberFormat('ddd m/d h:mm am/pm'));
  sh.getRange(2, L.ID + 1, rows, 1).setNumberFormat('@');
  sh.setColumnWidths(1, 2, 150);
  return sh;
}

function buildDashboard_(sh) {
  const log24 = c => [`=COUNTIFS(Log!$B$2:$B,${c},Log!$A$2:$A,">="&B$13)`, `=COUNTIFS(Log!$B$2:$B,${c},Log!$A$2:$A,">="&C$13)`];
  const sum24 = col => [`=SUMIFS(Log!$${col}$2:$${col},Log!$A$2:$A,">="&B$13)`, `=SUMIFS(Log!$${col}$2:$${col},Log!$A$2:$A,">="&C$13)`];
  const rows = [
    ['Baby Log', '', ''],
    ['', '', ''],
    ['Right now', '', ''],
    ['Last entry logged', '=IF(COUNT(Log!J2:J)=0,"",MAX(Log!J2:J))', ''],
    ['Last feed started', '=IFERROR(MAX(FILTER(Log!A2:A,(Log!B2:B="Breastfeed")+(Log!B2:B="Bottle"))),"")', ''],
    ['Time since last feed started (h:mm)', '=IF(B5="","",NOW()-B5)', ''],
    ['Last breastfeed started on', '=IFERROR(INDEX(SORT(FILTER(Log!A2:G,Log!B2:B="Breastfeed"),1,FALSE),1,6),"")', ''],
    ['Last breastfeed ended on', '=IFERROR(INDEX(SORT(FILTER(Log!A2:G,Log!B2:B="Breastfeed"),1,FALSE),1,7),"")', ''],
    ['Last wet diaper', '=IFERROR(MAX(FILTER(Log!A2:A,REGEXMATCH(Log!B2:B,"(?i)^wet"))),"")', ''],
    ['Last dirty diaper', '=IFERROR(MAX(FILTER(Log!A2:A,REGEXMATCH(Log!B2:B,"(?i)dirty"))),"")', ''],
    ['', '', ''],
    ['Totals', 'Last 24 hours', 'Since midnight'],
    ['Counting from', '=NOW()-1', '=TODAY()'],
    ['Wet diapers'].concat(log24('"Wet*"')),
    ['Dirty diapers'].concat(log24('"*dirty*"')),
    ['Breastfeeds'].concat(log24('"Breastfeed"')),
    ['Left breast minutes'].concat(sum24('C')),
    ['Right breast minutes'].concat(sum24('D')),
    ['Bottles'].concat(log24('"Bottle"')),
    ['Bottle ounces'].concat(sum24('E')),
    ['All feeds', '=B16+B19', '=C16+C19'],
    ['', '', ''],
    ['Recent entries', '', '']
  ];
  sh.getRange(1, 1, rows.length, 3).setValues(rows);
  sh.getRange('A24:G24').setValues([['Time', 'Event', 'Left min', 'Right min', 'Bottle oz', 'First side', 'Last side']])
    .setFontWeight('bold').setBackground('#263238').setFontColor('#FFFFFF');
  sh.getRange('A25').setValue('=IFERROR(ARRAY_CONSTRAIN(SORT(FILTER(Log!A2:G,Log!A2:A<>""),1,FALSE),12,7),"No entries yet")');
  sh.getRange('A1').setFontSize(16).setFontWeight('bold');
  ['A3', 'A12:C12', 'A23'].forEach(a => sh.getRange(a).setFontWeight('bold').setFontSize(12));
  ['B4:B5', 'B9:B10', 'B13:C13', 'A25:A36'].forEach(a => sh.getRange(a).setNumberFormat('ddd m/d h:mm am/pm'));
  sh.getRange('B6').setNumberFormat('[h]:mm');
  sh.getRange('B4:C21').setHorizontalAlignment('right');
  sh.setColumnWidth(1, 240); sh.setColumnWidth(2, 170); sh.setColumnWidth(3, 140);
}

function buildDaily_(sh) {
  sh.getRange('A1').setValue(`=QUERY({ARRAYFORMULA(IF(Log!A2:A="",,TO_DATE(INT(Log!A2:A)))),ARRAYFORMULA(IF(REGEXMATCH(Log!B2:B,"(?i)^wet"),1,0)),ARRAYFORMULA(IF(REGEXMATCH(Log!B2:B,"(?i)dirty"),1,0)),ARRAYFORMULA(IF(Log!B2:B="Breastfeed",1,0)),ARRAYFORMULA(IF(Log!C2:C="",0,Log!C2:C)),ARRAYFORMULA(IF(Log!D2:D="",0,Log!D2:D)),ARRAYFORMULA(IF(Log!B2:B="Bottle",1,0)),ARRAYFORMULA(IF(Log!E2:E="",0,Log!E2:E))},"select Col1, sum(Col2), sum(Col3), sum(Col4), sum(Col5), sum(Col6), sum(Col7), sum(Col8) where Col1 is not null group by Col1 order by Col1 desc label Col1 'Date', sum(Col2) 'Wet', sum(Col3) 'Dirty', sum(Col4) 'Breastfeeds', sum(Col5) 'Left min', sum(Col6) 'Right min', sum(Col7) 'Bottles', sum(Col8) 'Bottle oz' format Col1 'ddd mmm d'",0)`);
  sh.getRange('A1:H1').setFontWeight('bold').setBackground('#263238').setFontColor('#FFFFFF');
  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 120);
}

function ensureTab_(name, headers) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name, ss.getNumSheets());
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold')
    .setBackground('#263238').setFontColor('#FFFFFF');
  sh.setFrozenRows(1);
  if (name === DEVICES) {
    const rule = SpreadsheetApp.newDataValidation().requireValueInList(['Active', 'Revoked', 'Signed out'], true).build();
    sh.getRange(2, D.STATUS + 1, sh.getMaxRows() - 1, 1).setDataValidation(rule);
    sh.getRange(2, D.CREATED + 1, sh.getMaxRows() - 1, 2).setNumberFormat('ddd m/d h:mm am/pm');
  } else {
    sh.getRange(2, I.CREATED + 1, sh.getMaxRows() - 1, 3).setNumberFormat('ddd m/d h:mm am/pm');
  }
}

/* ================================================================== */
/* Helpers                                                             */
/* ================================================================== */

function sheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw fail_('not_set_up', 'Run setup in the Apps Script editor first.');
  return sh;
}

function data_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function hash_(s) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8));
}

// Random hex built from Utilities.getUuid(), which uses a secure random generator.
function randomHex_(len) {
  let s = '';
  while (s.length < len) s += Utilities.getUuid().replace(/-/g, '');
  return s.slice(0, len);
}

function cleanName_(n) {
  return String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().replace(/^[=+\-@]+/, '').trim().slice(0, 40);
}

function cleanNote_(n) {
  return String(n || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, 500);
}

// Text starting with = + - or @ would become a formula in the sheet; store it as plain text.
function safeCell_(s) {
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function fail_(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}
