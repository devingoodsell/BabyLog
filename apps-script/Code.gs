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
 *
 * Entries go in one tab per kind (Feeds, Pumps, Diapers, Sleep, Growth, Health, Activities).
 * A sheet from before November 2026 keeps everything in one Log tab: run migrateToTabs once.
 */

// If you fork this, change these two lines (see the README).
const APP_URL = 'https://devingoodsell.github.io/BabyLog/';
const OWNER_NAME = 'Devin';
const INVITE_HOURS = 72;     // unused invite links expire after this long
const PAIR_MINUTES = 15;     // setup codes (moving to the Home Screen app) expire after this long
const LIST_DAYS = 30;        // how much history the app downloads (Stats shows up to 30 days)
const FAIL_LIMIT = 30;       // failed redeem attempts allowed per 10 minutes before redeem pauses

const DEVICES = 'Devices';
const INVITES = 'Invites';
const PUSH = 'Push';
const TIMELINE = 'Timeline';
const LEGACY_LOG = 'Log';     // the single tab every entry went into before November 2026 (see migrateToTabs)
const PUSH_HEADERS = ['Device ID', 'Name', 'Status', 'Subscription', 'Feed due after h', 'Long feed alert', 'Medicine alert', 'Updated'];

// Each kind of entry has its own tab, and every tab ends with the same five columns. Each value is
// stored once: amounts in ounces, inches and °F so totals and charts add up, plus "As entered" with
// the mL, kg, cm or °C someone typed. The script finds columns by their header, so a column added
// to a tab by hand (your own notes, say) is left alone.
const SHARED_COLS = ['Notes', 'Logged by', 'Logged at', 'Updated at', 'ID'];
const TABS = {
  feed: { name: 'Feeds', cols: ['Time', 'Type', 'Left min', 'Right min', 'First side', 'Last side', 'End', 'Ounces', 'Milk', 'As entered'] },
  pump: { name: 'Pumps', cols: ['Time', 'Side', 'Minutes', 'Left oz', 'Right oz', 'As entered', 'Label'] },
  diaper: { name: 'Diapers', cols: ['Time', 'Kind'] },
  sleep: { name: 'Sleep', cols: ['Time', 'Woke up'] },
  growth: { name: 'Growth', cols: ['Time', 'Measure', 'Pounds', 'Ounces', 'Inches', 'As entered'] },
  health: { name: 'Health', cols: ['Time', 'Type', 'Detail', 'Dose', 'Remind h', 'Temp °F', 'As entered'] },
  activity: { name: 'Activities', cols: ['Time', 'Activity', 'Minutes'] }
};
const TAB_KEYS = Object.keys(TABS);
const DATE_COLS = ['Time', 'End', 'Woke up', 'Logged at', 'Updated at'];
const DATE_FORMAT = 'ddd m/d/yy h:mm am/pm';
const headersOf_ = key => TABS[key].cols.concat(SHARED_COLS);
const tabOf_ = type => (type === 'breast' || type === 'bottle' ? 'feed' : type === 'weight' || type === 'length' ? 'growth' : type);

const ML_PER_OZ = 29.5735;
const OZ_PER_KG = 35.27396;
const CM_PER_IN = 2.54;
const DEV_HEADERS = ['Name', 'Role', 'Status', 'Created', 'Last used', 'Device ID', 'Invited by', 'Key hash'];
const INV_HEADERS = ['Name', 'Role', 'Kind', 'Status', 'Created', 'Expires', 'Used at', 'Device ID', 'Invite ID', 'Created by', 'Code hash'];

const PUMP_SIDES = { L: 'Left', R: 'Right', B: 'Both' };
const MILK = { breast: 'Breast milk', formula: 'Formula' };
// Devices column positions
const D = { NAME: 0, ROLE: 1, STATUS: 2, CREATED: 3, USED: 4, ID: 5, BY: 6, HASH: 7 };
// Invites column positions
const I = { NAME: 0, ROLE: 1, KIND: 2, STATUS: 3, CREATED: 4, EXPIRES: 5, USED: 6, DEVICE: 7, ID: 8, BY: 9, HASH: 10 };

const DIAPER_KINDS = { wet: 'Wet', dirty: 'Dirty', both: 'Wet + dirty' };
const HEALTH_EVENTS = { med: 'Medicine', temp: 'Temperature', vaccine: 'Vaccine', symptom: 'Symptom', visit: 'Doctor visit' };

/* ================================================================== */
/* Web app entry points                                                */
/* ================================================================== */

function doGet() {
  return ContentService.createTextOutput('Baby Log is running.');
}

function doPost(e) {
  resetRequest_();
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
    case 'delete': return withLock_(() => remove_(req.id, req.type));
    case 'update': return withLock_(() => updateNote_(req.id, req.note, req.type));
    case 'endSleep': return withLock_(() => endSleep_(req.id, req.end, !!req.reopen));
    case 'live': return withLock_(() => setLive_(dev, req.state, req.replace));
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

// A phone's key is checked against the Devices tab, then remembered for a few minutes so most
// requests skip reading that tab. Removing a phone in the app takes effect at once; changing its
// Status by hand in the sheet takes effect within AUTH_CACHE_SEC.
const AUTH_CACHE_SEC = 300;
function auth_(token) {
  if (!token || typeof token !== 'string' || token.length < 40) throw fail_('unauthorized', 'This phone does not have access.');
  const h = hash_(token);
  const cache = CacheService.getScriptCache();
  const hit = cache.get('dev:' + h);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* read the sheet instead */ } }
  const sh = sheet_(DEVICES);
  const rows = data_(sh);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r[D.HASH] !== h) continue;
    if (r[D.STATUS] !== 'Active') break;
    const used = r[D.USED] instanceof Date ? r[D.USED].getTime() : 0;
    if (Date.now() - used > 10 * 60000) sh.getRange(i + 2, D.USED + 1).setValue(new Date());
    const dev = { name: String(r[D.NAME]), role: String(r[D.ROLE]), id: String(r[D.ID]) };
    cache.put('dev:' + h, JSON.stringify(dev), AUTH_CACHE_SEC);
    return dev;
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
  const cache = CacheService.getScriptCache();
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][D.ID]) !== deviceId) continue;
    sh.getRange(i + 2, D.STATUS + 1).setValue(status);
    cache.remove('dev:' + rows[i][D.HASH]);   // takes effect on that phone's next request
  }
  return {};
}

/* ================================================================== */
/* Entries                                                             */
/* ================================================================== */

function add_(dev, e) {
  const entry = validateEntry_(e, 'add');
  entry.note = cleanNote_(e && e.note);
  const t = readTab_(tabOf_(entry.type));
  if (t.rows.some(r => String(r[t.c.ID]) === entry.id)) return { entry: entry, duplicate: true };
  const twin = voiceTwin_(t, entry);
  if (twin) return { entry: twin, duplicate: true };
  const rec = entryRec_(entry);
  rec['Logged by'] = dev.name;
  rec['Logged at'] = new Date();
  appendRec_(t, rec);
  touchTab_(t.key);
  entry.by = dev.name;
  endLiveIf_(entry.id);
  return { entry: entry };
}

// Replaces an entry's details (time, amounts, sides...) in place. Who logged it and when stay.
function edit_(dev, e) {
  const entry = validateEntry_(e, 'edit');
  entry.note = cleanNote_(e && e.note);
  const key = tabOf_(entry.type);
  const f = findEntry_(entry.id, key);
  if (!f) throw fail_('bad_request', 'That entry no longer exists.');
  const rec = entryRec_(entry);
  const by = f.values[f.c['Logged by']], at = f.values[f.c['Logged at']];
  if (f.key === key) {
    writeRow_(f, f.row, rowFrom_(f, rec, f.values));
    const was = f.values[f.c.Time];
    if (!(was instanceof Date) || was.getTime() !== entry.t) sortTab_(f);
  } else {   // it became a different kind of entry: it moves to that kind's tab
    f.sh.deleteRow(f.row);
    rec['Logged by'] = by;
    rec['Logged at'] = at;
    appendRec_(openTab_(key), rec);
    touchTab_(key);
  }
  touchTab_(f.key);
  entry.by = String(by || '');
  endLiveIf_(entry.id);   // a feed continued on the shared timer and saved
  return { entry: entry };
}

// Two speakers in the house can both hear "Hey Google, log a wet diaper" and each send it. A voice
// entry identical to another voice entry from the same minute is that one command, kept once.
function voiceTwin_(t, entry) {
  if (!/^gh-/.test(entry.id)) return null;
  const sig = sig_(entry);
  for (let i = t.rows.length - 1; i >= 0 && i >= t.rows.length - 20; i--) {
    const r = t.rows[i];
    if (!/^gh-/.test(String(r[t.c.ID])) || !(r[t.c.Time] instanceof Date)) continue;
    if (Math.abs(r[t.c.Time].getTime() - entry.t) > 60000) continue;
    const other = recToEntry_(t, r);
    if (other && sig_(other) === sig) return other;
  }
  return null;
}
const sig_ = e => [e.type, e.kind || '', e.oz || '', e.source || ''].join('|');

// The column values for a validated entry (all but Logged by and Logged at), keyed by header
function entryRec_(e) {
  const rec = { 'Time': new Date(e.t), 'Notes': safeCell_(e.note || ''), 'Updated at': new Date(), 'ID': e.id };
  const r1 = n => Math.round(n * 10) / 10;
  const sideName = s => (s === 'L' ? 'Left' : 'Right');
  if (e.type === 'breast') {
    Object.assign(rec, { 'Type': 'Breastfeed', 'Left min': e.left, 'Right min': e.right,
      'First side': sideName(e.first), 'Last side': sideName(e.last), 'End': new Date(e.end) });
  } else if (e.type === 'bottle') {
    Object.assign(rec, { 'Type': 'Bottle', 'Ounces': e.oz, 'Milk': MILK[e.source] || '', 'As entered': e.unit === 'ml' ? e.amount + ' mL' : '' });
  } else if (e.type === 'pump') {
    const ml = e.pumpUnit === 'ml';
    const oz = v => (v == null ? '' : ml ? Math.round(v / ML_PER_OZ * 100) / 100 : v);
    const typed = [];
    if (ml && e.leftAmt != null) typed.push('L ' + e.leftAmt + ' mL');
    if (ml && e.rightAmt != null) typed.push('R ' + e.rightAmt + ' mL');
    Object.assign(rec, { 'Side': PUMP_SIDES[e.side], 'Minutes': e.minutes, 'Left oz': oz(e.leftAmt), 'Right oz': oz(e.rightAmt),
      'As entered': typed.join(', '), 'Label': safeCell_(e.label || '') });
  } else if (e.type === 'sleep') {
    rec['Woke up'] = e.end ? new Date(e.end) : '';   // empty while still asleep
  } else if (e.type === 'weight') {
    let lb = Math.floor(e.weightOz / 16), oz = r1(e.weightOz - lb * 16);
    if (oz >= 16) { lb += 1; oz = 0; }
    Object.assign(rec, { 'Measure': 'Weight', 'Pounds': lb, 'Ounces': oz,
      'As entered': e.weightUnit === 'kg' ? (e.weightOz / OZ_PER_KG).toFixed(2) + ' kg' : '' });
  } else if (e.type === 'length') {
    Object.assign(rec, { 'Measure': 'Length', 'Inches': e.lengthIn, 'As entered': e.lengthUnit === 'cm' ? r1(e.lengthIn * CM_PER_IN) + ' cm' : '' });
  } else if (e.type === 'health') {
    Object.assign(rec, { 'Type': HEALTH_EVENTS[e.kind], 'Detail': safeCell_(e.detail || '') });
    if (e.kind === 'med') { rec['Dose'] = safeCell_(e.dose || ''); rec['Remind h'] = e.remindHours || ''; }
    if (e.kind === 'temp') { rec['Temp °F'] = e.tempF; rec['As entered'] = e.tempUnit === 'C' ? r1((e.tempF - 32) / 1.8) + ' °C' : ''; }
  } else if (e.type === 'activity') {
    Object.assign(rec, { 'Activity': safeCell_(e.detail), 'Minutes': e.minutes || '' });
  } else {
    rec['Kind'] = DIAPER_KINDS[e.kind];
  }
  return rec;
}

// The app's form of one row of tab t, or null for a row it can't show. Rows typed or fixed by hand
// count: a hand edit of an amount wins over "As entered", which then no longer matches it.
function recToEntry_(t, r) {
  const c = t.c;
  const v = h => (c[h] == null ? '' : r[c[h]]);
  const time = v('Time');
  if (!(time instanceof Date)) return null;
  const base = { id: String(v('ID') || ''), t: time.getTime(), by: String(v('Logged by') || ''), note: String(v('Notes') || '') };
  const num = h => { const x = v(h); return x === '' || x == null || !isFinite(Number(x)) ? null : Number(x); };
  const text = h => String(v(h) == null ? '' : v(h)).trim();
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const typed = unit => { const m = new RegExp('([0-9.]+)\\s*' + unit, 'i').exec(text('As entered')); return m ? Number(m[1]) : null; };
  const sideOf = s => (/^r/i.test(s) ? 'R' : /^l/i.test(s) ? 'L' : '');

  if (t.key === 'feed') {
    const type = text('Type'), oz = num('Ounces');
    if (/bottle/i.test(type) || (!/breast/i.test(type) && oz != null)) {
      if (!(oz > 0)) return null;
      const ml = typed('mL');
      const useMl = ml != null && near(ml / ML_PER_OZ, oz, 0.011);
      const milk = text('Milk');
      return Object.assign(base, { type: 'bottle', oz: oz, amount: useMl ? ml : oz, unit: useMl ? 'ml' : 'oz',
        source: /formula/i.test(milk) ? 'formula' : /breast/i.test(milk) ? 'breast' : '' });
    }
    const left = num('Left min') || 0, right = num('Right min') || 0;
    if (!/breast/i.test(type) && !left && !right) return null;
    const first = sideOf(text('First side')) || (left ? 'L' : 'R');
    const last = sideOf(text('Last side')) || (left && right ? (first === 'L' ? 'R' : 'L') : first);
    const minEnd = base.t + (left + right) * 60000;
    const end = v('End') instanceof Date ? Math.max(v('End').getTime(), minEnd) : minEnd;
    return Object.assign(base, { type: 'breast', left: left, right: right, first: first, last: last, end: end });
  }
  if (t.key === 'pump') {
    const s = text('Side');
    const side = /^b/i.test(s) ? 'B' : /^r/i.test(s) ? 'R' : 'L';
    const lo = num('Left oz'), ro = num('Right oz');
    const mlOf = k => { const m = new RegExp(k + '\\s*([0-9.]+)\\s*mL', 'i').exec(text('As entered')); return m ? Number(m[1]) : null; };
    const lm = mlOf('L'), rm = mlOf('R');
    const fits = (ml, oz) => (ml == null ? oz == null : oz != null && near(ml / ML_PER_OZ, oz, 0.011));
    const useMl = (lm != null || rm != null) && fits(lm, lo) && fits(rm, ro);
    return Object.assign(base, { type: 'pump', side: side, minutes: num('Minutes') || 0, label: text('Label'),
      leftAmt: useMl ? lm : lo, rightAmt: useMl ? rm : ro, pumpUnit: useMl ? 'ml' : 'oz',
      pumpedOz: lo == null && ro == null ? null : Math.round(((lo || 0) + (ro || 0)) * 100) / 100 });
  }
  if (t.key === 'diaper') {
    const k = text('Kind');
    const wet = /wet|pee/i.test(k), dirty = /dirty|poo/i.test(k);
    if (!wet && !dirty) return null;
    return Object.assign(base, { type: 'diaper', kind: wet && dirty ? 'both' : wet ? 'wet' : 'dirty' });
  }
  if (t.key === 'sleep') {
    const w = v('Woke up');
    const end = w instanceof Date && w.getTime() > base.t ? w.getTime() : null;
    return Object.assign(base, { type: 'sleep', end: end, minutes: end ? Math.round((end - base.t) / 60000) : null });
  }
  if (t.key === 'growth') {
    const m = text('Measure'), lb = num('Pounds'), oz = num('Ounces'), inches = num('Inches');
    if (/length|height/i.test(m) || (!/weight/i.test(m) && inches != null && lb == null && oz == null)) {
      if (!(inches > 0)) return null;
      const cm = typed('cm');
      return Object.assign(base, { type: 'length', lengthIn: inches, lengthUnit: cm != null && near(cm / CM_PER_IN, inches, 0.05) ? 'cm' : 'in' });
    }
    const total = Math.round(((lb || 0) * 16 + (oz || 0)) * 10) / 10;
    if (!(total > 0)) return null;
    const kg = typed('kg');
    return Object.assign(base, { type: 'weight', weightOz: total, weightUnit: kg != null && near(kg * OZ_PER_KG, total, 0.5) ? 'kg' : 'lb' });
  }
  if (t.key === 'health') {
    const type = text('Type').toLowerCase();
    const kind = Object.keys(HEALTH_EVENTS).find(k => HEALTH_EVENTS[k].toLowerCase() === type);
    if (!kind) return null;
    const h = Object.assign(base, { type: 'health', kind: kind, detail: text('Detail') });
    if (kind === 'med') { h.dose = text('Dose'); h.remindHours = num('Remind h') || 0; }
    if (kind === 'temp') {
      h.tempF = num('Temp °F');
      const cel = typed('°?\\s*C\\b');
      h.tempUnit = cel != null && h.tempF != null && near(cel * 1.8 + 32, h.tempF, 0.06) ? 'C' : 'F';
    }
    return h;
  }
  if (t.key === 'activity') {
    if (!text('Activity')) return null;
    return Object.assign(base, { type: 'activity', detail: text('Activity'), minutes: num('Minutes') || 0 });
  }
  return null;
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
  const text = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);

  if (e.type === 'breast') {
    // Up to 6 hours a side: a long cluster feed continued several times adds up
    const mins = m => { const n = Math.round(Number(m) || 0); return n >= 0 && n <= 360 ? n : NaN; };
    const left = mins(e.left), right = mins(e.right);
    if (isNaN(left) || isNaN(right)) throw bad('Minutes must be between 0 and 360');
    if (!side(e.first) || !side(e.last)) throw bad('Missing side');
    // When the feed ended. With pauses it is later than the start plus the minutes.
    const minEnd = t + (left + right) * 60000;
    const x = e.end == null || e.end === '' ? NaN : Number(e.end);
    const end = isFinite(x) ? Math.min(Math.max(x, minEnd), t + 12 * 3600000) : minEnd;
    return { id: id, type: 'breast', t: t, left: left, right: right, first: e.first, last: e.last, end: end };
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
    return { id: id, type: 'weight', t: t, weightOz: oz, weightUnit: e.weightUnit === 'kg' ? 'kg' : 'lb' };
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
    if (!DIAPER_KINDS[e.kind]) throw bad('Unknown diaper type');
    return { id: id, type: 'diaper', t: t, kind: e.kind };
  }
  throw bad('Unknown entry type');
}

// Everything recent, or (with `since`) only rows changed after that time plus deleted ids.
function list_(since) {
  const now = Date.now();
  const out = { entries: [], live: getLive_(), syncedAt: now };
  since = Number(since) || 0;
  // A phone that last synced before the sheet was reorganized gets everything again
  if (since && since < (Number(getProp_('migratedAt')) || 0)) since = 0;
  const after = since - 5000;   // overlap a little; the app merges by id
  const cutoff = now - LIST_DAYS * 86400000;
  if (since) {
    out.delta = true;
    out.deleted = (getProp_('deleted') || []).filter(d => d.at >= after).map(d => d.id);
  }
  // A tab the script has not changed since this phone last asked is not read at all, so a poll
  // when nothing happened costs almost nothing. (Hand edits show up on the 10-minute full sync.)
  const revs = getProp_('revs');
  const unchanged = key => !!(since && revs && revs._start && after >= revs._start && (revs[key] || 0) < after);
  TAB_KEYS.forEach(key => {
    if (unchanged(key)) return;
    const t = readTab_(key);
    const T = t.c.Time, U = t.c['Updated at'];
    t.rows.forEach((r, i) => {
      if (!(r[T] instanceof Date)) return;
      if (since) {
        if (!(r[U] instanceof Date) || r[U].getTime() < after) return;
      } else if (key !== 'growth' && r[T].getTime() < cutoff) {
        return;   // measurements are few, so all are sent for the growth charts; other entries only recent ones
      }
      const entry = recToEntry_(t, r);
      if (!entry) return;
      if (!entry.id) {   // a row typed in by hand: give it an ID so the app can edit or delete it
        if (since) return;
        entry.id = randomHex_(16);
        t.sh.getRange(i + 2, t.c.ID + 1).setValue(entry.id);
      }
      out.entries.push(entry);
    });
  });
  out.entries.sort((a, b) => b.t - a.t);
  return out;
}

function remove_(id, type) {
  const f = findEntry_(id, tabHint_(type));
  if (f) { f.sh.deleteRow(f.row); touchTab_(f.key); }
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

function updateNote_(id, note, type) {
  const f = findEntry_(id, tabHint_(type));
  if (!f) throw fail_('bad_request', 'That entry no longer exists.');
  const clean = cleanNote_(note);
  f.sh.getRange(f.row, f.c.Notes + 1).setValue(safeCell_(clean));
  f.sh.getRange(f.row, f.c['Updated at'] + 1).setValue(new Date());
  touchTab_(f.key);
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
  const f = findEntry_(id, 'sleep');
  if (!f) throw fail_('bad_request', 'That sleep no longer exists.');
  const time = f.values[f.c.Time];
  if (f.key !== 'sleep' || !(time instanceof Date)) throw fail_('bad_request', 'That entry is not a sleep.');
  const start = time.getTime();
  const set = (h, v) => f.sh.getRange(f.row, f.c[h] + 1).setValue(v);
  if (reopen) {
    set('Woke up', '');
    set('Updated at', new Date());
    touchTab_('sleep');
    return { id: String(id), end: null, minutes: null };
  }
  const woke = f.values[f.c['Woke up']];
  if (woke instanceof Date) {
    return { id: String(id), end: woke.getTime(), minutes: Math.round((woke.getTime() - start) / 60000), already: true };
  }
  const s = sleepEnd_(start, Number(end));
  set('Woke up', new Date(s.end));
  set('Updated at', new Date());
  touchTab_('sleep');
  return { id: String(id), end: s.end, minutes: s.minutes };
}

/* Tabs: finding columns and rows */

// A tab's sheet and where each of its columns is. A column the script needs but the tab lacks
// (after an update adds one, say) is added at the end.
function openTab_(key) {
  const sh = tabSheet_(key);
  const head = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(h => String(h).trim());
  while (head.length && !head[head.length - 1]) head.pop();
  headersOf_(key).forEach(h => {
    if (head.indexOf(h) !== -1) return;
    if (sh.getMaxColumns() <= head.length) sh.insertColumnsAfter(sh.getMaxColumns(), 1);
    head.push(h);
    sh.getRange(1, head.length).setValue(h);
  });
  const c = {};
  head.forEach((h, i) => { if (h && !(h in c)) c[h] = i; });
  return { key: key, sh: sh, head: head, c: c };
}

// The tab plus all of its rows (without the header), read in one call
function readTab_(key) {
  const sh = tabSheet_(key);
  const all = sh.getDataRange().getValues();
  const head = (all[0] || []).map(h => String(h).trim());
  while (head.length && !head[head.length - 1]) head.pop();
  if (headersOf_(key).some(h => head.indexOf(h) === -1)) {   // a column is missing: add it, then read again
    const t = openTab_(key);
    const last = t.sh.getLastRow();
    t.rows = last < 2 ? [] : t.sh.getRange(2, 1, last - 1, t.head.length).getValues();
    return t;
  }
  const c = {};
  head.forEach((h, i) => { if (h && !(h in c)) c[h] = i; });
  return { key: key, sh: sh, head: head, c: c, rows: all.length > 1 ? all.slice(1) : [] };
}

// When each tab was last changed through the script (see list_)
function touchTab_(key) {
  const r = getProp_('revs') || {};
  r[key] = Date.now();
  if (!r._start) r._start = Date.now();
  setProp_('revs', r);
}

const tabHint_ = type => (type ? tabOf_(String(type)) : null);
let TAB_SHEETS_ = {};   // this request's sheets, looked up once each
function resetRequest_() { PROPS_ = null; TAB_SHEETS_ = {}; }
function tabSheet_(key) {
  const name = TABS[key] ? TABS[key].name : '';
  if (!TAB_SHEETS_[name]) TAB_SHEETS_[name] = SpreadsheetApp.getActive().getSheetByName(name);
  if (!TAB_SHEETS_[name]) throw notSetUp_();
  return TAB_SHEETS_[name];
}

// Finds an entry's row by its ID, looking in tab `first` before the others
function findEntry_(id, first) {
  id = String(id || '');
  if (!id) return null;
  const keys = first && TABS[first] ? [first].concat(TAB_KEYS.filter(k => k !== first)) : TAB_KEYS;
  for (let k = 0; k < keys.length; k++) {
    const t = openTab_(keys[k]);
    const last = t.sh.getLastRow();
    if (last < 2) continue;
    const ids = t.sh.getRange(2, t.c.ID + 1, last - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) !== id) continue;
      t.row = i + 2;
      t.values = t.sh.getRange(t.row, 1, 1, t.head.length).getValues()[0];
      return t;
    }
  }
  return null;
}

// A row for tab t. The columns the script manages come from rec (Logged by and Logged at only when
// rec has them); any other column keeps what `base` had, such as a column added by hand.
function rowFrom_(t, rec, base) {
  const row = base ? base.slice() : [];
  while (row.length < t.head.length) row.push('');
  headersOf_(t.key).forEach(h => {
    if ((h === 'Logged by' || h === 'Logged at') && !(h in rec)) return;
    row[t.c[h]] = h in rec ? rec[h] : '';
  });
  return row;
}

// Adds a row. Rows stay in time order: one logged late or backdated is moved into place.
function appendRec_(t, rec) {
  const last = t.rows ? t.rows.length + 1 : t.sh.getLastRow();
  if (t.sh.getMaxRows() <= last) t.sh.insertRowsAfter(t.sh.getMaxRows(), 100);
  writeRow_(t, last + 1, rowFrom_(t, rec, null));
  if (last >= 2) {
    const prev = t.rows ? t.rows[t.rows.length - 1][t.c.Time] : t.sh.getRange(last, t.c.Time + 1).getValue();
    if (prev instanceof Date && prev.getTime() > rec.Time.getTime()) sortTab_(t);
  }
}

// Writes one row with the tab's date and ID formats (appendRow would drop them)
function writeRow_(t, at, row) {
  const range = t.sh.getRange(at, 1, 1, row.length);
  range.setValues([row]);
  range.setNumberFormats([t.head.map((h, i) => (i >= row.length ? 'General' : DATE_COLS.indexOf(h) !== -1 ? DATE_FORMAT : h === 'ID' ? '@' : 'General'))]);
}

function sortTab_(t) {
  const last = t.sh.getLastRow();
  if (last > 2) t.sh.getRange(2, 1, last - 1, Math.max(t.head.length, t.sh.getLastColumn())).sort({ column: t.c.Time + 1, ascending: true });
}

function notSetUp_() {
  const old = SpreadsheetApp.getActive().getSheetByName(LEGACY_LOG);
  return fail_('not_set_up', old ? 'The sheet needs its one-time update: in Apps Script, run migrateToTabs (see the README).'
    : 'Run setup in the Apps Script editor first.');
}

// Saving the feed the shared timer was running ends the timer for everyone
function endLiveIf_(id) {
  const live = getLive_();
  if (live && live.id === id) setProp_('live', null);
}

/* ================================================================== */
/* Shared breastfeed timer                                             */
/* ================================================================== */

// One timer for the household, so every phone sees a feed in progress and anyone can switch
// sides, pause or save it. Stored in the script's properties, not the sheet, until it is saved.
function getLive_() {
  return getProp_('live') || null;
}

function setLive_(dev, state, replace) {
  if (state == null) { setProp_('live', null); return { live: null }; }
  if (typeof state !== 'object') throw fail_('bad_request', 'Bad timer');
  const id = String(state.id || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw fail_('bad_request', 'Bad timer id');
  const n = v => { const x = Number(v); return isFinite(x) ? x : 0; };
  const s = {
    id: id, start: n(state.start), first: state.first === 'R' ? 'R' : 'L', side: state.side === 'R' ? 'R' : 'L',
    running: !!state.running, segStart: n(state.segStart), left: Math.max(0, n(state.left)), right: Math.max(0, n(state.right)),
    note: cleanNote_(state.note), by: String(state.by || dev.name).slice(0, 40), updatedAt: Date.now(),
    continues: !!state.continues   // adding to a feed that ended a few minutes ago (saved as an edit of it)
  };
  if (s.continues) {   // what the earlier feed already had, so any phone can split the new part off again
    Object.assign(s, { baseLeft: Math.max(0, n(state.baseLeft)), baseRight: Math.max(0, n(state.baseRight)),
      contStart: n(state.contStart) || s.start, contFirst: state.contFirst === 'R' ? 'R' : 'L' });
  }
  if (!(s.start > Date.now() - 12 * 3600000 && s.start < Date.now() + 10 * 60000)) throw fail_('bad_request', 'Bad timer start');
  const cur = getLive_();
  // A different feed already running wins over a stale one from another phone
  if (cur && cur.id !== s.id && !(replace || state.replace) && Date.now() - cur.updatedAt < 12 * 3600000) return { live: cur, conflict: true };
  setProp_('live', s);
  return { live: s };
}

/* ================================================================== */
/* Properties (small shared state: the live timer, deletions, push)    */
/* ================================================================== */

// All properties are read once per request (one call instead of one per value)
let PROPS_ = null;
function getProp_(k) {
  if (!PROPS_) PROPS_ = PropertiesService.getScriptProperties().getProperties();
  const v = PROPS_[k];
  if (v == null || v === '') return null;
  try { return JSON.parse(v); } catch (e) { return null; }
}

function setProp_(k, v) {
  const p = PropertiesService.getScriptProperties();
  if (v == null) p.deleteProperty(k); else p.setProperty(k, JSON.stringify(v));
  if (PROPS_) { if (v == null) delete PROPS_[k]; else PROPS_[k] = JSON.stringify(v); }
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
  resetRequest_();
  const cfg = getProp_('push');
  if (!cfg) return;
  const subs = pushRows_().filter(r => r.status === 'On');
  if (!subs.length) return;
  const now = Date.now();
  const tz = Session.getScriptTimeZone();
  const at = t => Utilities.formatDate(new Date(t), tz, 'h:mm a');
  const dur = ms => { const m = Math.round(ms / 60000), h = Math.floor(m / 60); return h ? h + 'h ' + (m % 60) + 'm' : m + 'm'; };
  const entries = recentEntries_(3, ['feed', 'health']);
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

// Entries from the last `days` days in the given tabs, read from the end of each (newest rows)
function recentEntries_(days, keys) {
  const cutoff = Date.now() - days * 86400000;
  const out = [];
  (keys || TAB_KEYS).forEach(key => {
    const t = openTab_(key);
    const last = t.sh.getLastRow();
    if (last < 2) return;
    const from = Math.max(2, last - 799);
    t.sh.getRange(from, 1, last - from + 1, t.head.length).getValues().forEach(r => {
      if (!(r[t.c.Time] instanceof Date) || r[t.c.Time].getTime() < cutoff) return;
      const e = recToEntry_(t, r);
      if (e) out.push(e);
    });
  });
  return out;
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
  if (!ss.getSheetByName(TABS.feed.name)) {
    const old = ss.getSheetByName(LEGACY_LOG);
    if (old && old.getLastRow() >= 2) {
      Logger.log('This sheet still keeps everything in the one Log tab. Run migrateToTabs once to give each kind of entry its own tab.');
    } else {
      createEntryTabs_(ss);
    }
  }
  if (ss.getSheetByName(TABS.feed.name)) {
    createEntryTabs_(ss);   // any tab added by a later update
    if (!ss.getSheetByName('Dashboard')) buildDashboard_(ss.insertSheet('Dashboard', 0));
    if (!ss.getSheetByName('Daily')) buildDaily_(ss.insertSheet('Daily', Math.min(1, ss.getNumSheets())));
    if (!ss.getSheetByName(TIMELINE)) buildTimeline_(ss.insertSheet(TIMELINE, Math.min(2, ss.getNumSheets())));
  }
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
    .addItem('Rebuild Dashboard, Daily and Timeline tabs', 'rebuildSummaries')
    .addItem('Turn on reminders', 'setupReminders')
    .addToUi();
}

/** Replaces the Dashboard, Daily and Timeline tabs with the current version (they hold only formulas). */
function rebuildSummaries() {
  const ss = SpreadsheetApp.getActive();
  let ui = null;
  try { ui = SpreadsheetApp.getUi(); } catch (e) { /* run from the editor: no dialog */ }
  if (!ss.getSheetByName(TABS.feed.name)) {
    const msg = 'Run migrateToTabs first: the summary tabs read the Feeds, Pumps, Diapers and other tabs it creates.';
    if (ui) ui.alert(msg); else Logger.log(msg);
    return;
  }
  if (ui) {
    const ok = ui.alert('Rebuild summary tabs', 'This replaces the Dashboard, Daily and Timeline tabs. Anything you added to those tabs will be lost. Your entries are not touched.', ui.ButtonSet.OK_CANCEL);
    if (ok !== ui.Button.OK) return;
  }
  buildSummaries_(ss);
  if (ui) ui.alert('Done.');
}

function buildSummaries_(ss) {
  ['Dashboard', 'Daily', TIMELINE].forEach(n => { const s = ss.getSheetByName(n); if (s) ss.deleteSheet(s); });
  buildDashboard_(ss.insertSheet('Dashboard', 0));
  buildDaily_(ss.insertSheet('Daily', Math.min(1, ss.getNumSheets())));
  buildTimeline_(ss.insertSheet(TIMELINE, Math.min(2, ss.getNumSheets())));
}

// The entry tabs that are missing, placed after the summary tabs
function createEntryTabs_(ss) {
  TAB_KEYS.forEach((key, i) => {
    if (ss.getSheetByName(TABS[key].name)) return;
    const first = ss.getSheets()[0];
    const blank = ss.getSheets().length === 1 && first.getLastRow() === 0;
    const sh = blank ? first.setName(TABS[key].name) : ss.insertSheet(TABS[key].name, Math.min(3 + i, ss.getNumSheets()));
    const head = headersOf_(key);
    if (sh.getMaxColumns() < head.length) sh.insertColumnsAfter(sh.getMaxColumns(), head.length - sh.getMaxColumns());
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#263238').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
    formatRows_(sh, head, 2, sh.getMaxRows() - 1);
    sh.setColumnWidth(1, 170);
  });
}

function formatRows_(sh, head, from, n) {
  if (n < 1) return;
  head.forEach((h, i) => {
    if (DATE_COLS.indexOf(h) !== -1) sh.getRange(from, i + 1, n, 1).setNumberFormat(DATE_FORMAT);
    if (h === 'ID') sh.getRange(from, i + 1, n, 1).setNumberFormat('@');
  });
}

/* ================================================================== */
/* One-time update: one tab per kind of entry (November 2026)          */
/* ================================================================== */

// The columns of the old single Log tab
const LEGACY_HEADERS = ['Time', 'Event', 'Left min', 'Right min', 'Bottle oz', 'First side', 'Last side',
  'End', 'Logged by', 'Logged at', 'Notes', 'ID', 'Amount', 'Unit', 'Milk', 'Pump side', 'Pump min', 'Label', 'Left pumped', 'Right pumped', 'Pump unit', 'Pumped oz',
  'Sleep min', 'Weight lb', 'Weight', 'Detail', 'Dose', 'Temp F', 'Temp', 'Remind h', 'Length in', 'Length', 'Activity min', 'Updated at'];
const LEGACY_DIAPERS = { 'Wet diaper': 'wet', 'Dirty diaper': 'dirty', 'Wet + dirty diaper': 'both' };
const MERGE_GAP_MIN = 30;    // breastfeed pieces this close together are one feed
const DOUBLE_OVERLAP_MIN = 10;   // a piece starting this long before the previous one ended is the same feed logged twice

/**
 * Run once, from the Apps Script editor, then publish a new version of the web app.
 * Moves every entry from the old Log tab into a tab per kind of entry (Feeds, Pumps, Diapers,
 * Sleep, Growth, Health, Activities), each value stored once. Along the way:
 *  - A breastfeed logged in pieces (one side, a pause, the other side) becomes one feed when each
 *    piece started within 30 minutes of the previous piece ending.
 *  - A voice command that two speakers both logged (identical, within a minute) is kept once.
 *  - Bottle ounces come from the "Bottle oz" column, so a fix made there by hand stands.
 * The old tab is kept as "Log (archive)" and nothing in it changes. The execution log lists
 * everything that was merged, dropped or left out.
 */
function migrateToTabs() {
  resetRequest_();
  return withLock_(() => {
    const ss = SpreadsheetApp.getActive();
    if (ss.getSheetByName(TABS.feed.name)) { Logger.log('Nothing to do: this sheet already has a Feeds tab.'); return ['already']; }
    const log = ss.getSheetByName(LEGACY_LOG);
    const report = [];
    const res = log && log.getLastRow() >= 2
      ? legacyEntries_(log.getRange(1, 1, log.getLastRow(), log.getLastColumn()).getValues(), report)
      : { items: [], skipped: [] };
    const items = mergeLegacy_(res.items, report);

    createEntryTabs_(ss);
    const byTab = {};
    items.forEach(it => { const k = tabOf_(it.entry.type); (byTab[k] = byTab[k] || []).push(it); });
    const now = new Date();
    const counts = [];
    TAB_KEYS.forEach(key => {
      const list = (byTab[key] || []).sort((a, b) => a.entry.t - b.entry.t);
      counts.push(TABS[key].name + ' ' + list.length);
      if (!list.length) return;
      const t = openTab_(key);
      const rows = list.map(it => {
        const rec = entryRec_(it.entry);
        rec['Logged by'] = it.by;
        rec['Logged at'] = it.at;
        rec['Updated at'] = now;
        return rowFrom_(t, rec, null);
      });
      const need = rows.length + 1 - t.sh.getMaxRows();
      if (need > 0) { t.sh.insertRowsAfter(t.sh.getMaxRows(), need + 100); formatRows_(t.sh, t.head, 2, t.sh.getMaxRows() - 1); }
      t.sh.getRange(2, 1, rows.length, t.head.length).setValues(rows);
    });
    if (log) log.setName(LEGACY_LOG + ' (archive)');
    buildSummaries_(ss);
    ensureTab_(DEVICES, DEV_HEADERS);
    ensureTab_(INVITES, INV_HEADERS);
    setProp_('migratedAt', Date.now());   // phones download everything again on their next sync
    setProp_('revs', null);

    if (res.skipped.length) report.push('Left in "Log (archive)" only (no time, or an event the app does not know): rows ' + res.skipped.join(', '));
    report.unshift('Done. The ' + res.items.length + ' rows of the Log are now: ' + counts.join(', ') + '.');
    report.push('Next: publish a new version of the web app (Deploy > Manage deployments > edit > New version).');
    Logger.log(report.join('\n'));
    try { SpreadsheetApp.getUi().alert('Baby Log update', report.join('\n\n'), SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) { /* run from the editor */ }
    return report;
  });
}

// The old Log's rows as entries, plus who logged each and when. Older sheets used a few other
// column names; columns an older sheet never had are read as empty.
function legacyEntries_(all, report) {
  const head = all[0].map(h => String(h).trim());
  const alias = { 'End': 'Feed end', 'Logged by': 'Logged via' };
  const col = {};
  LEGACY_HEADERS.forEach(h => { const i = head.indexOf(h) !== -1 ? head.indexOf(h) : head.indexOf(alias[h] || h); col[h] = i; });
  const items = [], skipped = [];
  for (let i = 1; i < all.length; i++) {
    const r = all[i], row = i + 1;
    const g = h => (col[h] == null || col[h] < 0 ? '' : r[col[h]]);
    const num = h => { const x = g(h); return x === '' || x == null || !isFinite(Number(x)) ? null : Number(x); };
    const str = h => String(g(h) == null ? '' : g(h)).trim();
    const time = g('Time');
    if (!(time instanceof Date)) { if (r.some(v => v !== '' && v != null)) skipped.push(row); continue; }
    const t = time.getTime();
    const ev = str('Event');
    const sideOf = s => (/^r/i.test(s) ? 'R' : /^l/i.test(s) ? 'L' : '');
    let e = null;
    if (ev === 'Breastfeed') {
      const left = Math.round(num('Left min') || 0), right = Math.round(num('Right min') || 0);
      const first = sideOf(str('First side')) || (left ? 'L' : 'R');
      const last = sideOf(str('Last side')) || (left && right ? (first === 'L' ? 'R' : 'L') : first);
      const minEnd = t + (left + right) * 60000;
      e = { type: 'breast', left: left, right: right, first: first, last: last, end: g('End') instanceof Date ? Math.max(g('End').getTime(), minEnd) : minEnd };
    } else if (ev === 'Bottle') {
      const milk = str('Milk');
      const source = /formula/i.test(milk) ? 'formula' : /breast/i.test(milk) ? 'breast' : '';
      const oz = num('Bottle oz'), amt = num('Amount');
      if (/ml/i.test(str('Unit')) && amt != null) {
        const fromMl = Math.round(amt / ML_PER_OZ * 100) / 100;
        if (oz != null && Math.abs(fromMl - oz) > 0.011) {
          report.push('Row ' + row + ': bottle was ' + amt + ' mL but ' + oz + ' oz in "Bottle oz"; kept ' + oz + ' oz.');
          e = { type: 'bottle', oz: oz, amount: oz, unit: 'oz', source: source };
        } else {
          e = { type: 'bottle', oz: fromMl, amount: amt, unit: 'ml', source: source };
        }
      } else {
        const v = oz != null ? oz : amt;
        if (oz != null && amt != null && oz !== amt) report.push('Row ' + row + ': bottle amount ' + amt + ' oz, but ' + oz + ' oz in "Bottle oz"; kept ' + oz + ' oz.');
        if (v > 0) e = { type: 'bottle', oz: v, amount: v, unit: 'oz', source: source };
      }
    } else if (ev === 'Pump') {
      const s = str('Pump side');
      const side = /^b/i.test(s) ? 'B' : /^r/i.test(s) ? 'R' : 'L';
      e = { type: 'pump', side: side, minutes: Math.round(num('Pump min') || 0), label: str('Label'),
        leftAmt: num('Left pumped'), rightAmt: num('Right pumped'), pumpUnit: /ml/i.test(str('Pump unit')) ? 'ml' : 'oz' };
    } else if (ev === 'Sleep') {
      const end = g('End') instanceof Date && g('End').getTime() > t ? g('End').getTime() : null;
      e = { type: 'sleep', end: end, minutes: end ? Math.round((end - t) / 60000) : null };
    } else if (ev === 'Weight') {
      const lb = num('Weight lb');
      if (lb > 0) e = { type: 'weight', weightOz: Math.round(lb * 16 * 10) / 10, weightUnit: /kg/i.test(str('Weight')) ? 'kg' : 'lb' };
    } else if (ev === 'Length') {
      const inches = num('Length in');
      if (inches > 0) e = { type: 'length', lengthIn: inches, lengthUnit: /cm/i.test(str('Length')) ? 'cm' : 'in' };
    } else if (ev === 'Activity') {
      e = { type: 'activity', detail: str('Detail') || 'Activity', minutes: Math.round(num('Activity min') || 0) };
    } else if (LEGACY_DIAPERS[ev]) {
      e = { type: 'diaper', kind: LEGACY_DIAPERS[ev] };
    } else {
      const kind = Object.keys(HEALTH_EVENTS).find(k => HEALTH_EVENTS[k] === ev);
      if (kind) {
        e = { type: 'health', kind: kind, detail: str('Detail') };
        if (kind === 'med') { e.dose = str('Dose'); e.remindHours = num('Remind h') || 0; }
        if (kind === 'temp') { e.tempF = num('Temp F'); e.tempUnit = /C/.test(str('Temp')) ? 'C' : 'F'; }
      }
    }
    if (!e) { skipped.push(row); continue; }
    e.id = str('ID') || randomHex_(16);
    e.t = t;
    e.note = str('Notes');
    items.push({ entry: e, by: str('Logged by'), at: g('Logged at') instanceof Date ? g('Logged at') : '', row: row });
  }
  return { items: items, skipped: skipped };
}

// Drops voice doubles and joins breastfeed pieces (see migrateToTabs). Returns entries in time order.
function mergeLegacy_(items, report) {
  const at = t => Utilities.formatDate(new Date(t), Session.getScriptTimeZone(), 'M/d h:mm a');
  items.sort((a, b) => a.entry.t - b.entry.t || a.row - b.row);
  const voice = it => /^gh-/.test(it.entry.id) || it.by === 'Google Home';
  const kept = [];
  const dropped = [];
  items.forEach(it => {
    if (voice(it)) {
      const twin = kept.slice(-10).find(k => voice(k) && it.entry.t - k.entry.t <= 60000 && sig_(k.entry) === sig_(it.entry));
      if (twin) { dropped.push('row ' + it.row + ' (same as row ' + twin.row + ', ' + at(it.entry.t) + ')'); return; }
    }
    kept.push(it);
  });
  if (dropped.length) report.push('Voice commands logged twice, kept once: ' + dropped.join('; ') + '.');

  const out = [];
  let cur = null, pieces = 0, feeds = 0;
  const doubles = [];
  kept.forEach(it => {
    const e = it.entry;
    if (e.type !== 'breast') { out.push(it); return; }
    pieces++;
    if (cur) {
      const gap = (e.t - cur.entry.end) / 60000;
      if (gap <= MERGE_GAP_MIN && gap >= -DOUBLE_OVERLAP_MIN) {
        const a = cur.entry;
        a.left += e.left;
        a.right += e.right;
        a.last = e.last;
        a.end = Math.max(a.end, e.end);
        a.note = [a.note, e.note].filter(Boolean).join(' · ');
        if (it.at && (!cur.at || it.at < cur.at)) cur.at = it.at;
        cur.rows.push(it.row);
        return;
      }
      if (gap < -DOUBLE_OVERLAP_MIN) {   // most likely the same feed logged by two people: keep both, say so
        doubles.push('row ' + it.row + ' (' + it.by + ', ' + at(e.t) + ') overlaps row ' + cur.row + ' (' + cur.by + ', ' + at(cur.entry.t) + ')');
        out.push(it);
        feeds++;
        return;
      }
    }
    cur = it;
    cur.rows = [it.row];
    out.push(it);
    feeds++;
  });
  if (pieces) report.push(pieces + ' breastfeed rows became ' + feeds + ' feeds (pieces within ' + MERGE_GAP_MIN + ' minutes joined).');
  if (doubles.length) report.push('Possibly the same feed logged twice, kept as two feeds so you can decide (delete one in the app or the Feeds tab): ' + doubles.join('; ') + '.');
  return out;
}

/* ================================================================== */
/* Summary tabs (formulas only)                                        */
/* ================================================================== */

const HEAD_STYLE = r => r.setFontWeight('bold').setBackground('#263238').setFontColor('#FFFFFF');

function colLetter_(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}

// Column references by header, for example R.feed('Ounces') -> 'Feeds'!H2:H
function refs_() {
  const R = {};
  TAB_KEYS.forEach(k => {
    const t = openTab_(k);
    R[k] = h => { const L = colLetter_(t.c[h]); return "'" + TABS[k].name + "'!" + L + '2:' + L; };
  });
  return R;
}

// Every entry, newest first, one line each
function buildTimeline_(sh) {
  const R = refs_();
  const F = R.feed, P = R.pump, S = R.sleep, G = R.growth, H = R.health, A = R.activity;
  const block = (k, event, details) => {
    const T = R[k]('Time');
    const w = x => 'IF(' + T + '="",,' + x + ')';
    return [T, w(event), w(details), R[k]('Logged by'), R[k]('Notes')].join(',');
  };
  const blocks = [
    block('feed', F('Type'), 'IF(' + F('Type') + '="Bottle",' + F('Ounces') + '&" oz"&IF(' + F('Milk') + '="",""," "&LOWER(' + F('Milk') + ')),' +
      '"L "&' + F('Left min') + '&" · R "&' + F('Right min') + '&" min")'),
    block('pump', '"Pump"', P('Minutes') + '&" min, "&LOWER(' + P('Side') + ')&IF(' + P('Left oz') + '+' + P('Right oz') + '>0,", "&ROUND(' + P('Left oz') + '+' + P('Right oz') + ',2)&" oz","")'),
    block('diaper', '"Diaper"', R.diaper('Kind')),
    block('sleep', '"Sleep"', 'IF(' + S('Woke up') + '="","still asleep",TEXT(' + S('Woke up') + '-' + S('Time') + ',"[h]""h ""mm""m"""))'),
    block('growth', G('Measure'), 'IF(' + G('Measure') + '="Length",' + G('Inches') + '&" in",' + G('Pounds') + '&" lb "&' + G('Ounces') + '&" oz")&IF(' + G('As entered') + '="",""," ("&' + G('As entered') + '&")")'),
    block('health', H('Type'), 'TRIM(' + H('Detail') + '&" "&' + H('Dose') + '&IF(' + H('Temp °F') + '="",""," "&' + H('Temp °F') + '&" °F")&IF(' + H('As entered') + '="",""," ("&' + H('As entered') + '&")"))'),
    block('activity', '"Activity"', A('Activity') + '&IF(' + A('Minutes') + '="",""," · "&' + A('Minutes') + '&" min")')
  ];
  HEAD_STYLE(sh.getRange('A1:E1').setValues([['Time', 'Event', 'Details', 'Logged by', 'Notes']]));
  sh.getRange('A2').setFormula('=IFERROR(ARRAYFORMULA(LET(a,{' + blocks.join(';') + '},SORT(FILTER(a,INDEX(a,0,1)<>""),1,FALSE))),"No entries yet")');
  sh.getRange('A2:A').setNumberFormat(DATE_FORMAT);
  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 170); sh.setColumnWidth(2, 120); sh.setColumnWidth(3, 240);
}

function buildDashboard_(sh) {
  const R = refs_();
  const F = R.feed, P = R.pump, Di = R.diaper, S = R.sleep, G = R.growth, H = R.health, A = R.activity;
  const W = 18;   // the "Counting from" row
  const since = (T, col) => T + ',">="&' + col + '$' + W;
  const both = fn => ['B', 'C'].map(fn);
  const cnt = (T, extra) => both(c => '=COUNTIFS(' + (extra ? extra + ',' : '') + since(T, c) + ')');
  const sum = (T, v) => both(c => '=SUMIFS(' + v + ',' + since(T, c) + ')');
  const latest = (T, val, cond) => '=IFERROR(INDEX(SORT(FILTER({' + T + ',' + val + '},' + cond + '),1,FALSE),1,2),"")';
  const loggedAt = TAB_KEYS.map(k => R[k]('Logged at')).join(',');
  const asleep = both(c => '=SUMPRODUCT(IFERROR((' + S('Time') + '>=' + c + '$' + W + ')*(' + S('Woke up') + '<>"")*(' + S('Woke up') + '-' + S('Time') + '),0))*24');
  const rows = [
    ['Baby Log', '', ''],
    ['', '', ''],
    ['Right now', '', ''],
    ['Last entry logged', '=IF(MAX(' + loggedAt + ')=0,"",MAX(' + loggedAt + '))', ''],
    ['Last feed started', '=IF(MAX(' + F('Time') + ')=0,"",MAX(' + F('Time') + '))', ''],
    ['Time since last feed started (h:mm)', '=IF(B5="","",NOW()-B5)', ''],
    ['Last breastfeed started on', latest(F('Time'), F('First side'), F('Type') + '="Breastfeed"'), ''],
    ['Last breastfeed ended on', latest(F('Time'), F('Last side'), F('Type') + '="Breastfeed"'), ''],
    ['Last wet diaper', '=IFERROR(MAX(FILTER(' + Di('Time') + ',REGEXMATCH(' + Di('Kind') + ',"(?i)wet"))),"")', ''],
    ['Last dirty diaper', '=IFERROR(MAX(FILTER(' + Di('Time') + ',REGEXMATCH(' + Di('Kind') + ',"(?i)dirty"))),"")', ''],
    ['Last pump', '=IF(MAX(' + P('Time') + ')=0,"",MAX(' + P('Time') + '))', ''],
    ['Last woke up', '=IF(MAX(' + S('Woke up') + ')=0,"",MAX(' + S('Woke up') + '))', ''],
    ['Latest weight', latest(G('Time'), G('Pounds') + '&" lb "&' + G('Ounces') + '&" oz"', G('Measure') + '="Weight"'), ''],
    ['Latest length', latest(G('Time'), G('Inches') + '&" in"', G('Measure') + '="Length"'), ''],
    ['Last medicine', latest(H('Time'), 'TRIM(' + H('Detail') + '&" "&' + H('Dose') + ')&" at "&TEXT(' + H('Time') + ',"ddd h:mm am/pm")', H('Type') + '="Medicine"'), ''],
    ['', '', ''],
    ['Totals', 'Last 24 hours', 'Since midnight'],
    ['Counting from', '=NOW()-1', '=TODAY()'],
    ['Wet diapers'].concat(cnt(Di('Time'), Di('Kind') + ',"Wet*"')),
    ['Dirty diapers'].concat(cnt(Di('Time'), Di('Kind') + ',"*dirty*"')),
    ['Breastfeeds'].concat(cnt(F('Time'), F('Type') + ',"Breastfeed"')),
    ['Left breast minutes'].concat(sum(F('Time'), F('Left min'))),
    ['Right breast minutes'].concat(sum(F('Time'), F('Right min'))),
    ['Bottles'].concat(cnt(F('Time'), F('Type') + ',"Bottle"')),
    ['Bottle ounces'].concat(sum(F('Time'), F('Ounces'))),
    ['All feeds', '=B21+B24', '=C21+C24'],
    ['Pumps'].concat(cnt(P('Time'))),
    ['Pumped ounces'].concat(both(c => '=SUMIFS(' + P('Left oz') + ',' + since(P('Time'), c) + ')+SUMIFS(' + P('Right oz') + ',' + since(P('Time'), c) + ')')),
    ['Milk removal (breastfeeds + pumps)', '=B21+B27', '=C21+C27'],
    ['Hours asleep (sleeps that started in the window)'].concat(asleep),
    ['Activities'].concat(cnt(A('Time'))),
    ['', '', ''],
    ['Recent entries', '', '']
  ];
  sh.getRange(1, 1, rows.length, 3).setValues(rows);
  HEAD_STYLE(sh.getRange('A34:E34').setValues([['Time', 'Event', 'Details', 'Logged by', 'Notes']]));
  sh.getRange('A35').setValue("=ARRAY_CONSTRAIN('" + TIMELINE + "'!A2:E,15,5)");
  sh.getRange('A1').setFontSize(16).setFontWeight('bold');
  ['A3', 'A17:C17', 'A33'].forEach(a => sh.getRange(a).setFontWeight('bold').setFontSize(12));
  ['B4:B5', 'B9:B12', 'B18:C18', 'A35:A49'].forEach(a => sh.getRange(a).setNumberFormat('ddd m/d h:mm am/pm'));
  sh.getRange('B6').setNumberFormat('[h]:mm');
  sh.getRange('B25:C25').setNumberFormat('0.##');
  sh.getRange('B28:C28').setNumberFormat('0.##');
  sh.getRange('B30:C30').setNumberFormat('0.0');
  sh.getRange('B4:C31').setHorizontalAlignment('right');
  sh.setColumnWidth(1, 300); sh.setColumnWidth(2, 190); sh.setColumnWidth(3, 140);
}

// One row per day, newest first, from the first entry to today (days with nothing show zeros)
function buildDaily_(sh) {
  const R = refs_();
  const F = R.feed, P = R.pump, Di = R.diaper, S = R.sleep;
  // MAP works out each day separately (SUMIFS does not expand inside ARRAYFORMULA)
  const day = T => T + ',">="&d,' + T + ',"<"&d+1';
  const each = x => '=MAP(A2:A,LAMBDA(d,IF(d="",,' + x + ')))';
  const cnt = (T, extra) => each('COUNTIFS(' + (extra ? extra + ',' : '') + day(T) + ')');
  const sum = (T, v) => each('SUMIFS(' + v + ',' + day(T) + ')');
  const firstDay = 'MIN(' + TAB_KEYS.filter(k => k !== 'growth').map(k => R[k]('Time')).join(',') + ')';
  const labels = ['Date', 'Wet', 'Dirty', 'Breastfeeds', 'Left min', 'Right min', 'Bottles', 'Bottle oz', 'Pumps', 'Pumped oz', 'Milk removal', 'Hours asleep'];
  const formulas = [
    '=IF(' + firstDay + '=0,,SEQUENCE(TODAY()-INT(' + firstDay + ')+1,1,TODAY(),-1))',
    cnt(Di('Time'), Di('Kind') + ',"Wet*"'),
    cnt(Di('Time'), Di('Kind') + ',"*dirty*"'),
    cnt(F('Time'), F('Type') + ',"Breastfeed"'),
    sum(F('Time'), F('Left min')),
    sum(F('Time'), F('Right min')),
    cnt(F('Time'), F('Type') + ',"Bottle"'),
    sum(F('Time'), F('Ounces')),
    cnt(P('Time')),
    each('SUMIFS(' + P('Left oz') + ',' + day(P('Time')) + ')+SUMIFS(' + P('Right oz') + ',' + day(P('Time')) + ')'),
    '=ARRAYFORMULA(IF(A2:A="",,D2:D+I2:I))',
    each('SUMPRODUCT(IFERROR((' + S('Time') + '>=d)*(' + S('Time') + '<d+1)*(' + S('Woke up') + '<>"")*(' + S('Woke up') + '-' + S('Time') + '),0))*24')
  ];
  HEAD_STYLE(sh.getRange(1, 1, 1, labels.length).setValues([labels]));
  sh.getRange(2, 1, 1, formulas.length).setValues([formulas]);
  sh.getRange('A2:A').setNumberFormat('ddd mmm d');
  sh.getRange('H2:H').setNumberFormat('0.##');
  sh.getRange('J2:J').setNumberFormat('0.##');
  sh.getRange('L2:L').setNumberFormat('0.0');
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
  PROPS_ = null;   // read them fresh now that no other request can change them
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
