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

const APP_URL = 'https://devingoodsell.github.io/baby-log/';
const OWNER_NAME = 'Devin';
const INVITE_HOURS = 72;     // unused invite links expire after this long
const PAIR_MINUTES = 15;     // setup codes (moving to the Home Screen app) expire after this long
const LIST_DAYS = 14;        // how much history the app downloads
const FAIL_LIMIT = 30;       // failed redeem attempts allowed per 10 minutes before redeem pauses

const LOG = 'Log';
const DEVICES = 'Devices';
const INVITES = 'Invites';

const LOG_HEADERS = ['Time', 'Event', 'Left min', 'Right min', 'Bottle oz', 'First side', 'Last side',
  'Feed end', 'Logged by', 'Logged at', 'Notes', 'ID'];
const DEV_HEADERS = ['Name', 'Role', 'Status', 'Created', 'Last used', 'Device ID', 'Invited by', 'Key hash'];
const INV_HEADERS = ['Name', 'Role', 'Kind', 'Status', 'Created', 'Expires', 'Used at', 'Device ID', 'Invite ID', 'Created by', 'Code hash'];

// Log column positions (0-based)
const L = { TIME: 0, EVENT: 1, LEFT: 2, RIGHT: 3, OZ: 4, FIRST: 5, LAST: 6, END: 7, BY: 8, AT: 9, NOTES: 10, ID: 11 };
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
  const sh = sheet_(LOG);
  const ids = logIds_(sh);
  if (ids.indexOf(entry.id) !== -1) return { entry: entry, duplicate: true };

  const row = new Array(LOG_HEADERS.length).fill('');
  row[L.TIME] = new Date(entry.t);
  row[L.BY] = dev.name;
  row[L.AT] = new Date();
  row[L.ID] = entry.id;
  if (entry.type === 'breast') {
    row[L.EVENT] = 'Breastfeed';
    row[L.LEFT] = entry.left;
    row[L.RIGHT] = entry.right;
    row[L.FIRST] = entry.first === 'L' ? 'Left' : 'Right';
    row[L.LAST] = entry.last === 'L' ? 'Left' : 'Right';
    row[L.END] = new Date(entry.t + (entry.left + entry.right) * 60000);
  } else if (entry.type === 'bottle') {
    row[L.EVENT] = 'Bottle';
    row[L.OZ] = entry.oz;
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
    const oz = Math.round(Number(e.oz) * 100) / 100;
    if (!(oz > 0 && oz <= 20)) throw bad('Ounces must be between 0 and 20');
    return { id: id, type: 'bottle', t: t, oz: oz };
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
  const rows = sh.getRange(2, 1, last - 1, LOG_HEADERS.length).getValues();
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
  const base = { id: String(r[L.ID] || ''), t: r[L.TIME].getTime(), by: String(r[L.BY] || '') };
  const ev = String(r[L.EVENT]).trim();
  const sideOf = v => (/^r/i.test(String(v)) ? 'R' : /^l/i.test(String(v)) ? 'L' : '');
  if (ev === 'Breastfeed') {
    const left = Number(r[L.LEFT]) || 0, right = Number(r[L.RIGHT]) || 0;
    const first = sideOf(r[L.FIRST]) || (left ? 'L' : 'R');
    const last = sideOf(r[L.LAST]) || (left && right ? (first === 'L' ? 'R' : 'L') : first);
    return Object.assign(base, { type: 'breast', left: left, right: right, first: first, last: last });
  }
  if (ev === 'Bottle') return Object.assign(base, { type: 'bottle', oz: Number(r[L.OZ]) || 0 });
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
  const log = ss.getSheetByName(LOG);
  if (!log) throw new Error('Missing a tab named Log');
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
  return String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);
}

function fail_(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}
