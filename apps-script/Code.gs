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
const PUSH = 'Push';
const PUSH_HEADERS = ['Device ID', 'Name', 'Status', 'Subscription', 'Feed due after h', 'Long feed alert', 'Medicine alert', 'Updated'];

const LOG_HEADERS = ['Time', 'Event', 'Left min', 'Right min', 'Bottle oz', 'First side', 'Last side',
  'End', 'Logged by', 'Logged at', 'Notes', 'ID', 'Amount', 'Unit', 'Milk', 'Pump side', 'Pump min', 'Label', 'Left pumped', 'Right pumped', 'Pump unit', 'Pumped oz',
  'Sleep min', 'Weight lb', 'Weight', 'Detail', 'Dose', 'Temp F', 'Temp', 'Remind h', 'Length in', 'Length', 'Activity min', 'Updated at'];
const ML_PER_OZ = 29.5735;
const CM_PER_IN = 2.54;
const DEV_HEADERS = ['Name', 'Role', 'Status', 'Created', 'Last used', 'Device ID', 'Invited by', 'Key hash'];
const INV_HEADERS = ['Name', 'Role', 'Kind', 'Status', 'Created', 'Expires', 'Used at', 'Device ID', 'Invite ID', 'Created by', 'Code hash'];

// Log column positions (0-based)
const L = { TIME: 0, EVENT: 1, LEFT: 2, RIGHT: 3, OZ: 4, FIRST: 5, LAST: 6, END: 7, BY: 8, AT: 9, NOTES: 10, ID: 11, AMOUNT: 12, UNIT: 13, MILK: 14, PSIDE: 15, PMIN: 16, LABEL: 17, PLEFT: 18, PRIGHT: 19, PUNIT: 20, POZ: 21, SLEEPMIN: 22, WLB: 23, WTXT: 24,
  DETAIL: 25, DOSE: 26, TEMPF: 27, TEMP: 28, REMIND: 29, LIN: 30, LTXT: 31, AMIN: 32, UPD: 33 };
const PUMP_SIDES = { L: 'Left', R: 'Right', B: 'Both' };
const MILK = { breast: 'Breast milk', formula: 'Formula' };
// Devices column positions
const D = { NAME: 0, ROLE: 1, STATUS: 2, CREATED: 3, USED: 4, ID: 5, BY: 6, HASH: 7 };
// Invites column positions
const I = { NAME: 0, ROLE: 1, KIND: 2, STATUS: 3, CREATED: 4, EXPIRES: 5, USED: 6, DEVICE: 7, ID: 8, BY: 9, HASH: 10 };

const DIAPER_EVENTS = { wet: 'Wet diaper', dirty: 'Dirty diaper', both: 'Wet + dirty diaper' };
const HEALTH_EVENTS = { med: 'Medicine', temp: 'Temperature', vaccine: 'Vaccine', symptom: 'Symptom', visit: 'Doctor visit' };

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
    case 'list': return Object.assign({ me: publicMe_(dev) }, list_(req.since));
    case 'add': return withLock_(() => add_(dev, req.entry));
    case 'edit': return withLock_(() => edit_(dev, req.entry));
    case 'delete': return withLock_(() => remove_(req.id));
    case 'update': return withLock_(() => updateNote_(req.id, req.note));
    case 'endSleep': return withLock_(() => endSleep_(req.id, req.end, !!req.reopen));
    case 'live': return withLock_(() => setLive_(dev, req.state));
    case 'pushStatus': return pushStatus_(dev);
    case 'pushSubscribe': return withLock_(() => pushSubscribe_(dev, req.subscription, req.prefs));
    case 'pushUnsubscribe': return withLock_(() => pushUnsubscribe_(dev));
    case 'pushTest': return pushTest_(dev);
    case 'linkPush': return withLock_(() => linkPush_(req.url, req.secret, req.publicKey));
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
  const entry = validateEntry_(e, 'add');
  entry.note = cleanNote_(e && e.note);
  const sh = logSheet_();
  const ids = logIds_(sh);
  if (ids.indexOf(entry.id) !== -1) return { entry: entry, duplicate: true };
  const row = buildRow_(entry, new Array(LOG_HEADERS.length).fill(''));
  row[L.BY] = dev.name;
  row[L.AT] = new Date();
  sh.appendRow(row);
  entry.by = dev.name;
  // Saving the feed that the shared timer was running ends the timer for everyone
  const live = getLive_();
  if (live && live.id === entry.id) setProp_('live', null);
  return { entry: entry };
}

// Replaces an entry's details (time, amounts, sides...) in place. Who logged it and when stay.
function edit_(dev, e) {
  const entry = validateEntry_(e, 'edit');
  entry.note = cleanNote_(e && e.note);
  const sh = logSheet_();
  const i = logIds_(sh).indexOf(entry.id);
  if (i === -1) throw fail_('bad_request', 'That entry no longer exists.');
  const old = sh.getRange(i + 2, 1, 1, LOG_HEADERS.length).getValues()[0];
  const row = new Array(LOG_HEADERS.length).fill('');
  row[L.BY] = old[L.BY];
  row[L.AT] = old[L.AT];
  buildRow_(entry, row);
  sh.getRange(i + 2, 1, 1, LOG_HEADERS.length).setValues([row]);
  entry.by = String(old[L.BY] || '');
  return { entry: entry };
}

// Fills a Log row from a validated entry (everything except Logged by / Logged at)
function buildRow_(entry, row) {
  row[L.TIME] = new Date(entry.t);
  row[L.ID] = entry.id;
  row[L.NOTES] = safeCell_(entry.note || '');
  row[L.UPD] = new Date();
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
  } else if (entry.type === 'sleep') {
    row[L.EVENT] = 'Sleep';
    if (entry.end) {           // an open sleep (still asleep) has no end yet
      row[L.END] = new Date(entry.end);
      row[L.SLEEPMIN] = entry.minutes;
    }
  } else if (entry.type === 'weight') {
    row[L.EVENT] = 'Weight';
    row[L.WLB] = Math.round(entry.weightOz / 16 * 1000) / 1000;
    row[L.WTXT] = weightText_(entry.weightOz);
  } else if (entry.type === 'length') {
    row[L.EVENT] = 'Length';
    row[L.LIN] = entry.lengthIn;
    row[L.LTXT] = entry.lengthUnit === 'cm' ? (Math.round(entry.lengthIn * CM_PER_IN * 10) / 10) + ' cm' : entry.lengthIn + ' in';
  } else if (entry.type === 'health') {
    row[L.EVENT] = HEALTH_EVENTS[entry.kind];
    row[L.DETAIL] = safeCell_(entry.detail);
    if (entry.kind === 'med') {
      row[L.DOSE] = safeCell_(entry.dose);
      row[L.REMIND] = entry.remindHours || '';
    }
    if (entry.kind === 'temp') {
      row[L.TEMPF] = entry.tempF;
      row[L.TEMP] = entry.tempUnit === 'C' ? (Math.round((entry.tempF - 32) / 1.8 * 10) / 10) + ' °C' : entry.tempF + ' °F';
    }
  } else if (entry.type === 'activity') {
    row[L.EVENT] = 'Activity';
    row[L.DETAIL] = safeCell_(entry.detail);
    if (entry.minutes) {
      row[L.AMIN] = entry.minutes;
      row[L.END] = new Date(entry.t + entry.minutes * 60000);
    }
  } else {
    row[L.EVENT] = DIAPER_EVENTS[entry.kind];
  }
  return row;
}

function validateEntry_(e, mode) {
  const bad = msg => fail_('bad_request', msg);
  if (!e || typeof e !== 'object') throw bad('Missing entry');
  const id = String(e.id || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw bad('Bad entry id');
  const t = Number(e.t);
  // Weigh-ins and lengths can be backdated up to a year (birth, past checkups). New entries
  // can be up to 7 days old; edits can move anything the app shows (30 days).
  const growth = e.type === 'weight' || e.type === 'length';
  const maxDays = growth ? 366 : mode === 'edit' ? LIST_DAYS + 1 : 7;
  if (!(t > Date.now() - maxDays * 86400000 && t < Date.now() + 10 * 60000)) throw bad('The time must be within the last ' + maxDays + ' days');
  const side = s => (s === 'L' || s === 'R' ? s : null);
  const mins = m => { const n = Math.round(Number(m) || 0); return n >= 0 && n <= 180 ? n : NaN; };
  const text = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);

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
    const label = text(e.label, 60);
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
  if (e.type === 'sleep') {
    const out = { id: id, type: 'sleep', t: t, end: null, minutes: null };
    if (e.end != null && e.end !== '') Object.assign(out, sleepEnd_(t, Number(e.end)));
    return out;
  }
  if (e.type === 'weight') {
    const oz = Math.round(Number(e.weightOz) * 10) / 10;
    if (!(oz >= 16 && oz <= 640)) throw bad('Weight must be between 1 and 40 lb');
    return { id: id, type: 'weight', t: t, weightOz: oz };
  }
  if (e.type === 'length') {
    const lengthIn = Math.round(Number(e.lengthIn) * 100) / 100;
    if (!(lengthIn >= 10 && lengthIn <= 45)) throw bad('Length must be between 10 and 45 inches');
    return { id: id, type: 'length', t: t, lengthIn: lengthIn, lengthUnit: e.lengthUnit === 'cm' ? 'cm' : 'in' };
  }
  if (e.type === 'health') {
    if (!HEALTH_EVENTS[e.kind]) throw bad('Unknown health entry');
    const out = { id: id, type: 'health', t: t, kind: e.kind, detail: text(e.detail, 60) };
    if (e.kind === 'med') {
      if (!out.detail) throw bad('Enter the medicine');
      out.dose = text(e.dose, 40);
      const h = e.remindHours == null || e.remindHours === '' ? 0 : Number(e.remindHours);
      if (!(h >= 0 && h <= 72)) throw bad('Reminder must be between 1 and 72 hours');
      out.remindHours = Math.round(h * 2) / 2;
    }
    if (e.kind === 'temp') {
      const f = Math.round(Number(e.tempF) * 10) / 10;
      if (!(f >= 90 && f <= 110)) throw bad('Temperature must be between 90 and 110 °F (32 and 43 °C)');
      out.tempF = f; out.tempUnit = e.tempUnit === 'C' ? 'C' : 'F';
    }
    if ((e.kind === 'vaccine' || e.kind === 'symptom') && !out.detail) throw bad(e.kind === 'vaccine' ? 'Enter the vaccine' : 'Describe the symptom');
    return out;
  }
  if (e.type === 'activity') {
    const detail = text(e.detail, 40);
    if (!detail) throw bad('Choose or type an activity');
    const minutes = Math.round(Number(e.minutes) || 0);
    if (!(minutes >= 0 && minutes <= 240)) throw bad('Activity minutes must be between 0 and 240');
    return { id: id, type: 'activity', t: t, detail: detail, minutes: minutes };
  }
  if (e.type === 'diaper') {
    if (!DIAPER_EVENTS[e.kind]) throw bad('Unknown diaper type');
    return { id: id, type: 'diaper', t: t, kind: e.kind };
  }
  throw bad('Unknown entry type');
}

// The whole recent log, or (with `since`) only rows changed after that time plus deleted ids.
function list_(since) {
  const sh = logSheet_();
  const last = sh.getLastRow();
  const now = Date.now();
  const out = { entries: [], live: getLive_(), syncedAt: now };
  since = Number(since) || 0;
  if (since) {
    out.delta = true;
    const after = since - 5000;   // overlap a little; the app merges by id
    out.deleted = (getProp_('deleted') || []).filter(d => d.at >= after).map(d => d.id);
    if (last < 2) return out;
    const upd = sh.getRange(2, L.UPD + 1, last - 1, 1).getValues();
    let first = -1;
    for (let i = 0; i < upd.length; i++) {
      if (upd[i][0] instanceof Date && upd[i][0].getTime() >= after) { first = i; break; }
    }
    if (first === -1) return out;
    const rows = sh.getRange(first + 2, 1, last - 1 - first, LOG_HEADERS.length).getValues();
    rows.forEach((r, k) => {
      if (!(r[L.UPD] instanceof Date) || r[L.UPD].getTime() < after || !(r[L.TIME] instanceof Date)) return;
      const entry = rowToEntry_(r);
      if (entry && entry.id) out.entries.push(entry);
    });
    return out;
  }
  if (last < 2) return out;
  const cols = Math.min(LOG_HEADERS.length, sh.getMaxColumns());
  const rows = sh.getRange(2, 1, last - 1, cols).getValues();
  const cutoff = now - LIST_DAYS * 86400000;
  rows.forEach((r, i) => {
    if (!(r[L.TIME] instanceof Date)) return;
    // Weigh-ins and lengths are few, so all of them are sent for the growth charts; other entries only recent ones
    const ev = String(r[L.EVENT]).trim();
    if (r[L.TIME].getTime() < cutoff && ev !== 'Weight' && ev !== 'Length') return;
    const entry = rowToEntry_(r);
    if (!entry) return;
    if (!entry.id) { // a row typed in by hand: give it an ID so the app can edit or delete it
      entry.id = randomHex_(16);
      sh.getRange(i + 2, L.ID + 1).setValue(entry.id);
    }
    out.entries.push(entry);
  });
  out.entries.sort((a, b) => b.t - a.t);
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
  if (ev === 'Sleep') {
    const end = r[L.END] instanceof Date ? r[L.END].getTime() : null;
    return Object.assign(base, { type: 'sleep', end: end, minutes: end ? Math.round((end - base.t) / 60000) : null });
  }
  if (ev === 'Weight') {
    const lb = Number(r[L.WLB]);
    if (!(lb > 0)) return null;
    return Object.assign(base, { type: 'weight', weightOz: Math.round(lb * 16 * 10) / 10 });
  }
  if (ev === 'Length') {
    const inches = Number(r[L.LIN]);
    if (!(inches > 0)) return null;
    return Object.assign(base, { type: 'length', lengthIn: inches, lengthUnit: /cm/i.test(String(r[L.LTXT] || '')) ? 'cm' : 'in' });
  }
  if (ev === 'Activity') {
    return Object.assign(base, { type: 'activity', detail: String(r[L.DETAIL] || ''), minutes: Number(r[L.AMIN]) || 0 });
  }
  for (const k in HEALTH_EVENTS) {
    if (HEALTH_EVENTS[k] !== ev) continue;
    const h = Object.assign(base, { type: 'health', kind: k, detail: String(r[L.DETAIL] || '') });
    if (k === 'med') { h.dose = String(r[L.DOSE] || ''); h.remindHours = Number(r[L.REMIND]) || 0; }
    if (k === 'temp') { h.tempF = Number(r[L.TEMPF]) || null; h.tempUnit = /C/.test(String(r[L.TEMP] || '')) ? 'C' : 'F'; }
    return h;
  }
  for (const k in DIAPER_EVENTS) if (DIAPER_EVENTS[k] === ev) return Object.assign(base, { type: 'diaper', kind: k });
  return null;
}

function remove_(id) {
  const sh = logSheet_();
  const ids = logIds_(sh);
  const i = ids.indexOf(String(id));
  if (i !== -1) sh.deleteRow(i + 2);
  // Remember recent deletions so phones that sync only changes hear about them. Phones also
  // download everything at least every 10 minutes, so two days (or the last 100) is plenty, and
  // keeps this under the 9 KB a script property can hold.
  try {
    const cutoff = Date.now() - 2 * 86400000;
    const del = (getProp_('deleted') || []).filter(d => d.at > cutoff).slice(-99);
    del.push({ id: String(id), at: Date.now() });
    setProp_('deleted', del);
  } catch (e) { /* the row is deleted either way */ }
  return {};
}

function updateNote_(id, note) {
  const sh = logSheet_();
  const i = logIds_(sh).indexOf(String(id));
  if (i === -1) throw fail_('bad_request', 'That entry no longer exists.');
  const clean = cleanNote_(note);
  sh.getRange(i + 2, L.NOTES + 1).setValue(safeCell_(clean));
  sh.getRange(i + 2, L.UPD + 1).setValue(new Date());
  return { id: String(id), note: clean };
}

function sleepEnd_(start, end) {
  if (!isFinite(end) || end <= start) throw fail_('bad_request', 'Wake-up time must be after the sleep started.');
  if (end > Date.now() + 10 * 60000) throw fail_('bad_request', 'Wake-up time is in the future.');
  if (end - start > 24 * 3600000) throw fail_('bad_request', 'A sleep can be at most 24 hours.');
  return { end: end, minutes: Math.round((end - start) / 60000) };
}

// Ends an open sleep (one person can start it and another end it). The first wake-up wins: a
// second phone ending the same sleep gets the time already saved. `reopen` undoes an ending.
function endSleep_(id, end, reopen) {
  const sh = logSheet_();
  const i = logIds_(sh).indexOf(String(id));
  if (i === -1) throw fail_('bad_request', 'That sleep no longer exists.');
  const row = sh.getRange(i + 2, 1, 1, L.END + 1).getValues()[0];
  if (String(row[L.EVENT]).trim() !== 'Sleep' || !(row[L.TIME] instanceof Date)) throw fail_('bad_request', 'That entry is not a sleep.');
  const start = row[L.TIME].getTime();
  if (reopen) {
    sh.getRange(i + 2, L.END + 1).setValue('');
    sh.getRange(i + 2, L.SLEEPMIN + 1).setValue('');
    sh.getRange(i + 2, L.UPD + 1).setValue(new Date());
    return { id: String(id), end: null, minutes: null };
  }
  if (row[L.END] instanceof Date) {
    const had = row[L.END].getTime();
    return { id: String(id), end: had, minutes: Math.round((had - start) / 60000), already: true };
  }
  const s = sleepEnd_(start, Number(end));
  sh.getRange(i + 2, L.END + 1).setValue(new Date(s.end));
  sh.getRange(i + 2, L.SLEEPMIN + 1).setValue(s.minutes);
  sh.getRange(i + 2, L.UPD + 1).setValue(new Date());
  return { id: String(id), end: s.end, minutes: s.minutes };
}

function weightText_(oz) {
  let lb = Math.floor(oz / 16);
  let rest = Math.round((oz - lb * 16) * 10) / 10;
  if (rest >= 16) { lb += 1; rest = 0; }
  return lb + ' lb ' + rest + ' oz';
}

function logIds_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, L.ID + 1, last - 1, 1).getValues().map(r => String(r[0]));
}

// The Log tab, widened if an older sheet has fewer columns than the app now writes
function logSheet_() {
  const sh = sheet_(LOG);
  if (sh.getMaxColumns() < LOG_HEADERS.length) sh.insertColumnsAfter(sh.getMaxColumns(), LOG_HEADERS.length - sh.getMaxColumns());
  return sh;
}

/* ================================================================== */
/* Shared breastfeed timer                                             */
/* ================================================================== */

// One timer for the household, so every phone sees a feed in progress and anyone can switch
// sides, pause or save it. Stored in the script's properties, not the Log, until it is saved.
function getLive_() {
  return getProp_('live') || null;
}

function setLive_(dev, state) {
  if (state == null) { setProp_('live', null); return { live: null }; }
  if (typeof state !== 'object') throw fail_('bad_request', 'Bad timer');
  const id = String(state.id || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw fail_('bad_request', 'Bad timer id');
  const n = v => { const x = Number(v); return isFinite(x) ? x : 0; };
  const s = {
    id: id, start: n(state.start), first: state.first === 'R' ? 'R' : 'L', side: state.side === 'R' ? 'R' : 'L',
    running: !!state.running, segStart: n(state.segStart), left: Math.max(0, n(state.left)), right: Math.max(0, n(state.right)),
    note: cleanNote_(state.note), by: String(state.by || dev.name).slice(0, 40), updatedAt: Date.now()
  };
  if (!(s.start > Date.now() - 12 * 3600000 && s.start < Date.now() + 10 * 60000)) throw fail_('bad_request', 'Bad timer start');
  const cur = getLive_();
  // A different feed already running wins over a stale one from another phone
  if (cur && cur.id !== s.id && !state.replace && Date.now() - cur.updatedAt < 12 * 3600000) return { live: cur, conflict: true };
  setProp_('live', s);
  return { live: s };
}

/* ================================================================== */
/* Properties (small shared state: the live timer, deletions, push)    */
/* ================================================================== */

function getProp_(k) {
  const v = PropertiesService.getScriptProperties().getProperty(k);
  if (v == null || v === '') return null;
  try { return JSON.parse(v); } catch (e) { return null; }
}

function setProp_(k, v) {
  const p = PropertiesService.getScriptProperties();
  if (v == null) p.deleteProperty(k); else p.setProperty(k, JSON.stringify(v));
}

/* ================================================================== */
/* Reminders (push notifications)                                      */
/* ================================================================== */
// Phones that turn on notifications are listed in the Push tab. Every 5 minutes a trigger
// (setupReminders) checks for a feed that is overdue, a breastfeed timer left running and
// medicine that is due, and asks the Baby Log cloud service (the Google Home service on
// Cloud Run, see the README) to deliver the notifications.

const LONG_FEED_MIN = 45;          // a breastfeed side running this long gets a "still feeding?" alert

function pushStatus_(dev) {
  const cfg = getProp_('push');
  const row = pushRows_().find(r => r.deviceId === dev.id && r.status === 'On');
  return { configured: !!cfg, publicKey: cfg ? cfg.publicKey : null,
    sub: row ? { feedHours: row.feedHours, longFeed: row.longFeed, meds: row.meds } : null };
}

function pushSubscribe_(dev, sub, prefs) {
  if (!getProp_('push')) throw fail_('bad_request', 'Reminders are not set up yet. See the README.');
  const s = sub && typeof sub === 'object' ? sub : null;
  if (!s || !/^https:\/\/[^\s]{10,800}$/.test(String(s.endpoint || '')) || !s.keys ||
      !/^[A-Za-z0-9_-]{20,200}$/.test(String(s.keys.p256dh || '')) || !/^[A-Za-z0-9_-]{10,100}$/.test(String(s.keys.auth || ''))) {
    throw fail_('bad_request', 'This phone did not give a valid notification address.');
  }
  const p = prefs || {};
  const feedHours = Math.max(0, Math.min(12, Math.round(Number(p.feedHours) * 2) / 2 || 0));
  const values = [dev.id, dev.name, 'On', JSON.stringify({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } }),
    feedHours, p.longFeed ? 'Yes' : 'No', p.meds ? 'Yes' : 'No', new Date()];
  const sh = pushSheet_();
  const rows = data_(sh);
  const i = rows.findIndex(r => String(r[0]) === dev.id);
  if (i === -1) sh.appendRow(values); else sh.getRange(i + 2, 1, 1, values.length).setValues([values]);
  return pushStatus_(dev);
}

function pushUnsubscribe_(dev) {
  const sh = pushSheet_();
  data_(sh).forEach((r, i) => { if (String(r[0]) === dev.id) sh.getRange(i + 2, 3).setValue('Off'); });
  return pushStatus_(dev);
}

// Sends one notification to this phone, to check that everything is connected
function pushTest_(dev) {
  const cfg = getProp_('push');
  const row = pushRows_().find(r => r.deviceId === dev.id && r.status === 'On');
  if (!cfg || !row) throw fail_('bad_request', 'Turn on notifications on this phone first.');
  const res = sendPush_(cfg, [{ row: row, title: 'Baby Log', body: 'Notifications work on this phone.', tag: 'test' }]);
  if (!res[0] || !res[0].ok) throw fail_('bad_request', 'The notification could not be sent' + (res[0] && res[0].error ? ': ' + res[0].error : '.'));
  return {};
}

// Called by google-home/deploy.sh: where the cloud service is, and the secret it expects
function linkPush_(url, secret, publicKey) {
  if (!/^https:\/\/[A-Za-z0-9.-]+(\/[^\s]*)?$/.test(String(url || ''))) throw fail_('bad_request', 'Bad service URL');
  if (!/^[A-Za-z0-9_-]{32,200}$/.test(String(secret || ''))) throw fail_('bad_request', 'Bad secret');
  if (!/^[A-Za-z0-9_-]{60,120}$/.test(String(publicKey || ''))) throw fail_('bad_request', 'Bad public key');
  setProp_('push', { url: String(url).replace(/\/+$/, ''), secret: String(secret), publicKey: String(publicKey) });
  return { linked: true };
}

function pushSheet_() {
  const ss = SpreadsheetApp.getActive();
  return ss.getSheetByName(PUSH) || ensureTab_(PUSH, PUSH_HEADERS);
}

function pushRows_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(PUSH);
  if (!sh) return [];
  return data_(sh).map((r, i) => {
    let sub = null;
    try { sub = JSON.parse(String(r[3] || '')); } catch (e) { /* ignore */ }
    return { row: i + 2, deviceId: String(r[0]), name: String(r[1]), status: String(r[2]), sub: sub,
      feedHours: Number(r[4]) || 0, longFeed: r[5] === 'Yes', meds: r[6] === 'Yes' };
  }).filter(r => r.sub);
}

/** Run once from the Apps Script editor (or the Baby Log menu) to turn on reminders. */
function setupReminders() {
  setup();
  pushSheet_();
  const has = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'checkAlerts');
  if (!has) ScriptApp.newTrigger('checkAlerts').timeBased().everyMinutes(5).create();
  const cfg = getProp_('push');
  Logger.log(cfg
    ? 'Reminders are on. Each person turns on notifications in the app: tap their initial > Notifications.'
    : 'Reminders are on, but the cloud service is not linked yet. Run google-home/deploy.sh (see the README).');
}

// Runs every 5 minutes (the trigger setupReminders creates)
function checkAlerts() {
  const cfg = getProp_('push');
  if (!cfg) return;
  const subs = pushRows_().filter(r => r.status === 'On');
  if (!subs.length) return;
  const now = Date.now();
  const tz = Session.getScriptTimeZone();
  const at = t => Utilities.formatDate(new Date(t), tz, 'h:mm a');
  const dur = ms => { const m = Math.round(ms / 60000), h = Math.floor(m / 60); return h ? h + 'h ' + (m % 60) + 'm' : m + 'm'; };
  const entries = recentEntries_(3);
  const live = getLive_();
  const sent = getProp_('sent') || {};
  Object.keys(sent).forEach(k => { if (now - sent[k] > 36 * 3600000) delete sent[k]; });   // stays well under 9 KB

  const feeds = entries.filter(e => e.type === 'breast' || e.type === 'bottle').sort((a, b) => b.t - a.t);
  const lastFeed = feeds[0];
  const meds = {};
  entries.filter(e => e.type === 'health' && e.kind === 'med').sort((a, b) => b.t - a.t)
    .forEach(e => { const k = e.detail.toLowerCase(); if (!meds[k]) meds[k] = e; });

  const out = [];
  subs.forEach(sub => {
    const add = (key, title, body) => { key += ':' + sub.deviceId; if (!sent[key]) out.push({ row: sub, key: key, title: title, body: body, tag: key.split(':')[0] }); };
    if (sub.feedHours > 0 && lastFeed && !live && now - lastFeed.t >= sub.feedHours * 3600000) {
      const what = lastFeed.type === 'bottle' ? 'bottle at ' + at(lastFeed.t) : 'breastfeed at ' + at(lastFeed.t);
      add('feed:' + lastFeed.id, 'Feed due', 'No feed for ' + dur(now - lastFeed.t) + '. Last was a ' + what + '.');
    }
    if (sub.longFeed && live && live.running && now - live.segStart >= LONG_FEED_MIN * 60000) {
      add('long:' + live.id + ':' + live.segStart, 'Still feeding?',
        'The breastfeed timer has run ' + dur(now - live.segStart) + ' on the ' + (live.side === 'L' ? 'left' : 'right') + ' side. Open Baby Log to pause or save it.');
    }
    if (sub.meds) {
      Object.keys(meds).forEach(k => {
        const m = meds[k];
        if (!(m.remindHours > 0)) return;
        const due = m.t + m.remindHours * 3600000;
        if (now >= due && now - due < 12 * 3600000) {
          add('med:' + m.id, m.detail + ' is due', 'Last given at ' + at(m.t) + (m.dose ? ' (' + m.dose + ')' : '') + '.');
        }
      });
    }
  });
  if (!out.length) return;
  const res = sendPush_(cfg, out);
  out.forEach((m, i) => { if (res[i] && (res[i].ok || res[i].gone)) sent[m.key] = now; });
  setProp_('sent', sent);
}

// Entries from the last `days` days, read from the end of the Log (newest rows)
function recentEntries_(days) {
  const sh = sheet_(LOG);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const from = Math.max(2, last - 799);
  const cutoff = Date.now() - days * 86400000;
  return sh.getRange(from, 1, last - from + 1, LOG_HEADERS.length).getValues()
    .filter(r => r[L.TIME] instanceof Date && r[L.TIME].getTime() >= cutoff)
    .map(rowToEntry_).filter(e => e);
}

// Hands notifications to the cloud service, which encrypts and delivers them
function sendPush_(cfg, msgs) {
  const payload = { messages: msgs.map(m => ({ subscription: m.row.sub, title: m.title, body: m.body, tag: m.tag })) };
  let res;
  try {
    const r = UrlFetchApp.fetch(cfg.url + '/push', { method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + cfg.secret }, payload: JSON.stringify(payload), muteHttpExceptions: true });
    res = JSON.parse(r.getContentText()).results || [];
  } catch (e) {
    Logger.log('Push service error: ' + e);
    return msgs.map(() => ({ ok: false, error: String(e) }));
  }
  // A phone that uninstalled the app or turned notifications off: stop sending to it
  const sh = pushSheet_();
  res.forEach((r, i) => { if (r && r.gone && msgs[i]) sh.getRange(msgs[i].row.row, 3).setValue('Expired'); });
  return res;
}

/* ================================================================== */
/* One-time setup (run from the Apps Script editor)                    */
/* ================================================================== */

/** Step 1: run once. Creates the tabs. Safe to run again: it only adds what is missing. */
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

/* A Baby Log menu in the sheet */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Baby Log')
    .addItem('Rebuild Dashboard and Daily tabs', 'rebuildSummaries')
    .addItem('Turn on reminders', 'setupReminders')
    .addToUi();
}

/** Replaces the Dashboard and Daily tabs with the current version (they hold only formulas). */
function rebuildSummaries() {
  const ss = SpreadsheetApp.getActive();
  let ui = null;
  try { ui = SpreadsheetApp.getUi(); } catch (e) { /* run from the editor: no dialog */ }
  if (ui) {
    const ok = ui.alert('Rebuild summary tabs', 'This replaces the Dashboard and Daily tabs. Anything you added to those two tabs will be lost. The Log is not touched.', ui.ButtonSet.OK_CANCEL);
    if (ok !== ui.Button.OK) return;
  }
  ['Dashboard', 'Daily'].forEach(n => { const s = ss.getSheetByName(n); if (s) ss.deleteSheet(s); });
  buildDashboard_(ss.insertSheet('Dashboard', 0));
  buildDaily_(ss.insertSheet('Daily', 2));
  if (ui) ui.alert('Done. The Dashboard and Daily tabs now include pumps, milk removal, sleep, growth and medicine.');
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
  [L.TIME, L.END, L.AT, L.UPD].forEach(c => sh.getRange(2, c + 1, rows, 1).setNumberFormat('ddd m/d h:mm am/pm'));
  sh.getRange(2, L.ID + 1, rows, 1).setNumberFormat('@');
  sh.setColumnWidths(1, 2, 150);
  return sh;
}

// Log columns used below: A Time, B Event, C/D Left/Right min, E Bottle oz, H End, J Logged at,
// V Pumped oz, W Sleep min, Y Weight, Z Detail, AA Dose, AF Length, AG Activity min
function buildDashboard_(sh) {
  const R = 18;   // the "Counting from" row
  const cnt = c => [`=COUNTIFS(Log!$B$2:$B,${c},Log!$A$2:$A,">="&B$${R})`, `=COUNTIFS(Log!$B$2:$B,${c},Log!$A$2:$A,">="&C$${R})`];
  const sum = col => [`=SUMIFS(Log!$${col}$2:$${col},Log!$A$2:$A,">="&B$${R})`, `=SUMIFS(Log!$${col}$2:$${col},Log!$A$2:$A,">="&C$${R})`];
  const latest = (ev, col) => `=IFERROR(INDEX(SORT(FILTER({Log!A2:A,Log!${col}2:${col}},Log!B2:B="${ev}"),1,FALSE),1,2),"")`;
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
    ['Last pump', '=IFERROR(MAX(FILTER(Log!A2:A,Log!B2:B="Pump")),"")', ''],
    ['Last woke up', '=IFERROR(MAX(FILTER(Log!H2:H,Log!B2:B="Sleep")),"")', ''],
    ['Latest weight', latest('Weight', 'Y'), ''],
    ['Latest length', latest('Length', 'AF'), ''],
    ['Last medicine', '=IFERROR(INDEX(SORT(FILTER({Log!A2:A,Log!Z2:Z&" "&Log!AA2:AA&" at "&TEXT(Log!A2:A,"ddd h:mm am/pm")},Log!B2:B="Medicine"),1,FALSE),1,2),"")', ''],
    ['', '', ''],
    ['Totals', 'Last 24 hours', 'Since midnight'],
    ['Counting from', '=NOW()-1', '=TODAY()'],
    ['Wet diapers'].concat(cnt('"Wet*"')),
    ['Dirty diapers'].concat(cnt('"*dirty*"')),
    ['Breastfeeds'].concat(cnt('"Breastfeed"')),
    ['Left breast minutes'].concat(sum('C')),
    ['Right breast minutes'].concat(sum('D')),
    ['Bottles'].concat(cnt('"Bottle"')),
    ['Bottle ounces'].concat(sum('E')),
    ['All feeds', '=B21+B24', '=C21+C24'],
    ['Pumps'].concat(cnt('"Pump"')),
    ['Pumped ounces'].concat(sum('V')),
    ['Milk removal (breastfeeds + pumps)', '=B21+B27', '=C21+C27'],
    ['Hours asleep (sleeps that started in the window)'].concat(sum('W').map(f => '=' + f.slice(1) + '/60')),
    ['Activities'].concat(cnt('"Activity"')),
    ['', '', ''],
    ['Recent entries', '', '']
  ];
  sh.getRange(1, 1, rows.length, 3).setValues(rows);
  sh.getRange('A34:G34').setValues([['Time', 'Event', 'Left min', 'Right min', 'Bottle oz', 'First side', 'Last side']])
    .setFontWeight('bold').setBackground('#263238').setFontColor('#FFFFFF');
  sh.getRange('A35').setValue('=IFERROR(ARRAY_CONSTRAIN(SORT(FILTER(Log!A2:G,Log!A2:A<>""),1,FALSE),15,7),"No entries yet")');
  sh.getRange('A1').setFontSize(16).setFontWeight('bold');
  ['A3', 'A17:C17', 'A33'].forEach(a => sh.getRange(a).setFontWeight('bold').setFontSize(12));
  ['B4:B5', 'B9:B12', 'B18:C18', 'A35:A49'].forEach(a => sh.getRange(a).setNumberFormat('ddd m/d h:mm am/pm'));
  sh.getRange('B6').setNumberFormat('[h]:mm');
  sh.getRange('B30:C30').setNumberFormat('0.0');
  sh.getRange('B4:C31').setHorizontalAlignment('right');
  sh.setColumnWidth(1, 300); sh.setColumnWidth(2, 190); sh.setColumnWidth(3, 140);
}

function buildDaily_(sh) {
  const col = (cond, val) => `ARRAYFORMULA(IF(${cond},${val},0))`;
  const n = c => `ARRAYFORMULA(IF(Log!${c}2:${c}="",0,Log!${c}2:${c}))`;
  const parts = [
    'ARRAYFORMULA(IF(Log!A2:A="",,TO_DATE(INT(Log!A2:A))))',
    col('REGEXMATCH(Log!B2:B,"(?i)^wet")', 1),
    col('REGEXMATCH(Log!B2:B,"(?i)dirty")', 1),
    col('Log!B2:B="Breastfeed"', 1),
    n('C'), n('D'),
    col('Log!B2:B="Bottle"', 1),
    n('E'),
    col('Log!B2:B="Pump"', 1),
    n('V'),
    col('(Log!B2:B="Pump")+(Log!B2:B="Breastfeed")', 1),
    'ARRAYFORMULA(IF(Log!W2:W="",0,Log!W2:W/60))'
  ];
  const labels = ['Wet', 'Dirty', 'Breastfeeds', 'Left min', 'Right min', 'Bottles', 'Bottle oz', 'Pumps', 'Pumped oz', 'Milk removal', 'Hours asleep'];
  const sums = labels.map((l, i) => 'sum(Col' + (i + 2) + ')').join(', ');
  const lab = labels.map((l, i) => 'sum(Col' + (i + 2) + ") '" + l + "'").join(', ');
  sh.getRange('A1').setValue('=QUERY({' + parts.join(',') + '},"select Col1, ' + sums +
    " where Col1 is not null group by Col1 order by Col1 desc label Col1 'Date', " + lab + " format Col1 'ddd mmm d', sum(Col12) '0.0'\",0)");
  sh.getRange('A1:L1').setFontWeight('bold').setBackground('#263238').setFontColor('#FFFFFF');
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
  } else if (name === INVITES) {
    sh.getRange(2, I.CREATED + 1, sh.getMaxRows() - 1, 3).setNumberFormat('ddd m/d h:mm am/pm');
  }
  return sh;
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
