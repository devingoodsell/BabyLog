// Editing entries, the shared breastfeed timer, health, length, activities, sync fixes and reminders.
const { chromium, devices } = require('playwright');
const BASE = 'http://localhost:' + process.env.PORT;
const OUT = __dirname + '/shots';
require('fs').mkdirSync(OUT, { recursive: true });
const MIN = 60000;
const state = async () => (await fetch(BASE + '/__state')).json();
const logRows = async () => (await state()).Log.slice(1).filter(r => r.some(v => v !== '' && v != null));
const post = async b => (await fetch(BASE + '/exec', { method: 'POST', body: JSON.stringify(b) })).json();
const byId = (rows, id) => rows.find(r => r[11] === id);
let failures = 0;
const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failures++; };
const dt = t => { const d = new Date(t), p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()); };
const near = (a, b, ms) => Math.abs(a - b) <= ms;

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const phone = { ...devices['iPhone 13'] }; delete phone.defaultBrowserType;
  const code = (await (await fetch(BASE + '/__invite')).text()).match(/#invite=([a-f0-9]+)/)[1];
  const join = async (ctx, link, name) => {
    const P = await ctx.newPage();
    P.on('pageerror', e => { console.log('PAGEERROR ' + name, e.message); failures++; });
    await P.goto(BASE + '/#invite=' + link);
    await P.fill('#joinName', name);
    await P.click('text=Join Baby Log');
    await P.waitForSelector('#screen-home:not([hidden])');
    await P.waitForTimeout(900);
    await P.click('#sheet-install [data-close]').catch(() => {});
    await P.waitForTimeout(300);
    return P;
  };
  const settle = P => P.waitForFunction(() => JSON.parse(localStorage.getItem('bl.outbox') || '[]').length === 0, null, { timeout: 10000 }).catch(() => {});
  const sync = async P => { await P.evaluate(() => document.getElementById('sync').click()); await P.waitForTimeout(1000); await P.keyboard.press('Escape'); await P.waitForTimeout(300); };
  const openItem = async (P, text) => { await P.click('#timeline .item:has-text("' + text + '")'); await P.waitForTimeout(150); };

  const ctxA = await browser.newContext({ ...phone, colorScheme: 'light', serviceWorkers: 'block' });
  const A = await join(ctxA, code, 'Devin');
  const token = await A.evaluate(() => JSON.parse(localStorage.getItem('bl.auth')).token);
  const inv = await post({ action: 'invite', token, name: 'Tess', role: 'member' });
  const ctxB = await browser.newContext({ ...phone, colorScheme: 'dark', serviceWorkers: 'block' });
  const B = await join(ctxB, inv.code, 'Tess');

  // ---------- Feature 1: edit entries ----------
  await A.click('[data-open="bottle"]');
  await A.click('#amtChips .chip[data-amt="2"]'); await A.click('[data-source="formula"]');
  await A.click('#bottleSave'); await settle(A);
  let rows = await logRows();
  const bottleId = rows.find(r => r[1] === 'Bottle')[11];
  const rowCount = rows.length;
  await openItem(A, 'Bottle');
  await A.click('#timeline .edit-entry');
  await A.waitForTimeout(300);
  check((await A.textContent('#bottleTitle')) === 'Edit bottle' && (await A.textContent('#bottleSave')) === 'Save changes', 'edit opens the bottle sheet filled in');
  check(await A.isVisible('#exact-bottle') && !(await A.isVisible('.chips.when[data-for="bottle"] .chip')), 'editing shows an exact date and time instead of quick chips');
  const newT = Date.now() - 95 * MIN;
  await A.fill('#exact-bottle', dt(newT)); await A.dispatchEvent('#exact-bottle', 'change');
  await A.click('#amtPlus'); await A.click('[data-source="breast"]');
  await A.screenshot({ path: OUT + '/ft-edit-bottle.png' });
  await A.click('#bottleSave'); await settle(A);
  rows = await logRows();
  let br = byId(rows, bottleId);
  check(rows.length === rowCount, 'editing changes the row in place, no new row');
  check(br && br[4] === 2.5 && br[14] === 'Breast milk' && near(new Date(br[0]).getTime(), newT, MIN), 'bottle row now 2.5 oz breast milk at the new time (' + (br && [br[4], br[14]]) + ')');
  check(br && br[8] === 'Devin' && br[33] !== '', 'Logged by kept, Updated at set');
  // Undo puts it back
  await A.click('#toastUndo'); await settle(A);
  br = byId(await logRows(), bottleId);
  check(br && br[4] === 2 && br[14] === 'Formula', 'undo restores the bottle as it was');

  // Breastfeed edit: minutes and sides
  await post({ action: 'add', token, entry: { id: 'bf00000001', type: 'breast', t: Date.now() - 200 * MIN, left: 10, right: 5, first: 'L', last: 'R' } });
  await sync(A);
  await openItem(A, 'Started left');
  await A.click('#timeline .edit-entry'); await A.waitForTimeout(300);
  check(await A.isHidden('#feedModes') && (await A.inputValue('#mL')) === '10', 'breastfeed edit opens "enter after" with its minutes, no timer tab');
  await A.fill('#mL', '14'); await A.click('[data-first="R"]');
  await A.click('#manualSave'); await settle(A);
  const bf = byId(await logRows(), 'bf00000001');
  check(bf && bf[2] === 14 && bf[3] === 5 && bf[5] === 'Right' && bf[6] === 'Left', 'breastfeed edited to 14/5, right first (' + (bf && bf.slice(2, 7)) + ')');

  // Editing an entry that has not reached the sheet yet just updates what is queued
  await ctxA.setOffline(true);
  await A.click('[data-open="diaper"]'); await A.click('[data-kind="wet"]'); await A.click('#diaperSave');
  await A.waitForTimeout(400);
  await openItem(A, 'Wet diaper');
  await A.click('#timeline .edit-entry'); await A.waitForTimeout(300);
  await A.click('[data-kind="both"]'); await A.click('#diaperSave');
  await A.waitForTimeout(300);
  const ob = await A.evaluate(() => JSON.parse(localStorage.getItem('bl.outbox')));
  check(ob.length === 1 && ob[0].op === 'add' && ob[0].entry.kind === 'both', 'edit of an unsent entry changes the queued add');
  await ctxA.setOffline(false);
  await A.evaluate(() => window.dispatchEvent(new Event('online')));
  await settle(A);
  check((await logRows()).some(r => r[1] === 'Wet + dirty diaper'), 'it reaches the sheet as edited');

  // ---------- Feature 3: shared breastfeed timer ----------
  await A.click('[data-open="feed"]'); await A.click('#modeTimer'); await A.click('#sideL');
  await A.waitForTimeout(400); await A.keyboard.press('Escape'); await settle(A);
  const props = await (await fetch(BASE + '/__props')).json();
  const live = JSON.parse(props.live || 'null');
  check(live && live.side === 'L' && live.running && live.by === 'Devin', 'starting the timer shares it through the sheet');
  await sync(B);
  check(!(await B.isHidden('#live')) && (await B.textContent('#liveSub')).includes('Devin'), "Tess's phone shows Devin's feed in progress");
  await B.click('#live'); await B.waitForTimeout(300);
  check(!(await B.isHidden('#liveWho')), 'her timer screen says who started it');
  await B.click('#sideR'); await settle(B); await B.keyboard.press('Escape');
  await sync(A);
  check((await A.textContent('#liveTitle')).includes('Right'), "Devin's phone follows when Tess switches to the right side");
  // Give the feed realistic minutes (feeds under 20 seconds are not saved): 6 min left, 4 min into the right
  const cur = JSON.parse((await (await fetch(BASE + '/__props')).json()).live);
  await post({ action: 'live', token, state: Object.assign(cur, { start: Date.now() - 10 * MIN, left: 6 * MIN, right: 0, side: 'R', running: true, segStart: Date.now() - 4 * MIN }) });
  await sync(A);
  await A.click('#live'); await A.waitForTimeout(200);
  await A.click('#feedDone'); await settle(A);
  rows = await logRows();
  const sharedRow = rows.find(r => r[11] === live.id && r[1] === 'Breastfeed');
  check(sharedRow && sharedRow[2] === 6 && sharedRow[3] === 4 && sharedRow[5] === 'Left' && sharedRow[6] === 'Right', 'saving it logs the feed with the shared timer id, 6 min left then 4 min right (' + (sharedRow && sharedRow.slice(2, 7)) + ')');
  check(!(await (await fetch(BASE + '/__props')).json()).live, 'saving ends the shared timer');
  await sync(B);
  check(await B.isHidden('#live'), "the feed banner is gone from Tess's phone");

  // ---------- Improvement: long-running timer check ----------
  await post({ action: 'live', token, state: { id: 'longfeed01', start: Date.now() - 55 * MIN, first: 'L', side: 'L', running: true, segStart: Date.now() - 50 * MIN, left: 0, right: 0, by: 'Tess' } });
  await A.reload(); await A.waitForTimeout(2000);
  await A.click('#sheet-install [data-close]').catch(() => {});
  check(await A.evaluate(() => document.getElementById('sheet-feed').classList.contains('open')) && !(await A.isHidden('#longNote')), 'opening the app with a 50-minute side asks "still feeding?"');
  check((await A.textContent('#liveTitle')).startsWith('Still feeding?') && await A.evaluate(() => document.getElementById('live').classList.contains('warn')), 'banner turns amber and asks');
  await A.screenshot({ path: OUT + '/ft-long.png' });
  await A.click('#longKeep');
  check(await A.isHidden('#longNote'), '"Yes, keep going" hides the question');
  await A.click('#feedDiscard'); await settle(A);
  check(!(await (await fetch(BASE + '/__props')).json()).live, 'Discard ends the shared timer');
  await A.keyboard.press('Escape');

  // ---------- Feature 4: health ----------
  await A.click('[data-open="health"]');
  check(await A.isDisabled('#healthSave'), 'medicine needs a name');
  await A.click('#hChips .chip:has-text("Vitamin D")');
  await A.fill('#hDose', '1 drop');
  await A.click('#hRemind .chip[data-h="24"]');
  await A.screenshot({ path: OUT + '/ft-health.png' });
  await A.click('#healthSave'); await settle(A);
  await A.click('[data-open="health"]'); await A.click('[data-hkind="temp"]');
  await A.click('#tUnitC'); await A.fill('#tVal', '38.2'); await A.press('#tVal', 'Enter');
  await A.click('#hChips .chip:has-text("Rectal")');
  await A.click('#healthSave'); await settle(A);
  await A.click('[data-open="health"]'); await A.click('[data-hkind="vaccine"]');
  await A.click('#hChips .chip:has-text("Hepatitis B")'); await A.click('#healthSave'); await settle(A);
  rows = await logRows();
  const med = rows.find(r => r[1] === 'Medicine'), temp = rows.find(r => r[1] === 'Temperature'), vac = rows.find(r => r[1] === 'Vaccine');
  check(med && med[25] === 'Vitamin D' && med[26] === '1 drop' && med[29] === 24, 'medicine row: Vitamin D, 1 drop, remind every 24 h');
  check(temp && temp[27] === 100.8 && temp[28] === '38.2 °C' && temp[25] === 'Rectal', 'temperature row: 100.8 °F stored, 38.2 °C as entered, rectal (' + (temp && temp.slice(25, 29)) + ')');
  check(vac && vac[25] === 'Hepatitis B', 'vaccine row');
  check((await A.textContent('#timeline')).includes('next due'), 'timeline shows when the next dose is due');

  // ---------- Feature 6 (length) and improvement: date only for backdated growth ----------
  await A.click('[data-open="weight"]'); await A.click('#gKindL');
  await A.fill('#lenVal', '20.5'); await A.press('#lenVal', 'Enter');
  await A.click('#weightSave'); await settle(A);
  await A.click('[data-open="weight"]'); await A.click('#wUnitKg'); await A.click('#gKindL');
  await A.fill('#lenVal', '50'); await A.press('#lenVal', 'Enter');
  const d3 = new Date(Date.now() - 3 * 86400000);
  await A.fill('#wDate', dt(d3.getTime()).slice(0, 10));
  await A.click('#weightSave'); await settle(A);
  await A.click('[data-open="weight"]'); await A.click('#wUnitLb'); await A.keyboard.press('Escape');
  rows = await logRows();
  const lens = rows.filter(r => r[1] === 'Length');
  check(lens.some(r => r[30] === 20.5 && r[31] === '20.5 in') && lens.some(r => r[30] === 19.69 && r[31] === '50 cm'), 'length rows in inches and cm (' + lens.map(r => r[30] + '/' + r[31]) + ')');
  await A.click('#statsBtn'); await A.waitForTimeout(700);
  check(await A.$$eval('#chLength circle', c => c.length) === 2, 'length chart shows both measurements');
  check((await A.textContent('#stLengthDetail')).includes('20.5 in'), 'length detail: ' + (await A.textContent('#stLengthDetail')));
  await A.keyboard.press('Escape');

  // ---------- Feature 11: activity ----------
  await A.click('[data-open="activity"]');
  check(await A.isDisabled('#activitySave'), 'activity needs a name');
  await A.click('#aChips .chip:has-text("Tummy time")');
  await A.click('#aMinChips .chip[data-m="15"]');
  await A.click('#activitySave'); await settle(A);
  const act = (await logRows()).find(r => r[1] === 'Activity');
  check(act && act[25] === 'Tummy time' && act[32] === 15 && act[7] !== '', 'activity row: tummy time, 15 min, with an end time');
  check((await A.textContent('#timeline')).includes('Tummy time'), 'activity in the timeline');

  // ---------- Bug 7: a feed entered after starts at now minus its length ----------
  await A.click('[data-open="feed"]'); await A.click('#modeManual');
  await A.fill('#mL', '20'); await A.press('#mL', 'Enter'); await A.fill('#mR', '15'); await A.press('#mR', 'Enter');
  await A.click('#manualSave'); await settle(A);
  rows = await logRows();
  const lastBf = rows.filter(r => r[1] === 'Breastfeed' && r[2] === 20 && r[3] === 15)[0];
  check(lastBf && near(new Date(lastBf[0]).getTime(), Date.now() - 35 * MIN, 1.5 * MIN), 'a 35-minute feed entered now starts 35 minutes ago');

  // ---------- Bug 2 and improvement: first wake-up wins, and Undo reopens ----------
  const s1 = await post({ action: 'add', token, entry: { id: 'sleep00001', type: 'sleep', t: Date.now() - 60 * MIN } });
  const e1 = await post({ action: 'endSleep', token, id: 'sleep00001', end: Date.now() - 10 * MIN });
  const e2 = await post({ action: 'endSleep', token, id: 'sleep00001', end: Date.now() });
  check(s1.ok && e1.ok && e2.ok && e2.already && e2.end === e1.end, 'a second wake-up keeps the first time');
  await sync(A);
  await A.click('[data-open="sleep"]'); await A.click('#sleepStartBtn'); await settle(A);
  await A.click('#liveSleep'); await A.click('#sleepEndBtn'); await A.waitForTimeout(300);
  check((await A.textContent('#toastMsg')).startsWith('Sleep saved') && await A.isVisible('#toastUndo'), 'ending a sleep offers Undo');
  await settle(A);
  await A.click('#toastUndo'); await settle(A);
  check(!(await A.isHidden('#liveSleep')), 'Undo shows the sleep as going again');
  const reopened = (await logRows()).filter(r => r[1] === 'Sleep').find(r => r[7] === '');
  check(!!reopened, 'the sheet shows it open again');

  // ---------- Bug 4 and improvement 5: one failing entry does not block the rest ----------
  let failId = null;
  await ctxB.route('**/exec', async route => {
    const body = route.request().postData() || '';
    if (failId && body.includes(failId)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'error', message: 'Service Spreadsheets failed' }) });
    return route.continue();
  });
  await B.click('[data-open="diaper"]'); await B.click('[data-kind="dirty"]');
  failId = await B.evaluate(() => { const orig = crypto.randomUUID.bind(crypto); const id = 'stuck-' + orig().slice(0, 8); crypto.randomUUID = () => { crypto.randomUUID = orig; return id; }; return id; });
  await B.click('#diaperSave'); await B.waitForTimeout(1500);
  await B.click('[data-open="bottle"]'); await B.click('#amtChips .chip[data-amt="3"]'); await B.click('[data-source="formula"]'); await B.click('#bottleSave');
  await B.waitForTimeout(2000);
  rows = await logRows();
  check(rows.some(r => r[1] === 'Bottle' && r[4] === 3 && r[8] === 'Tess'), 'a later entry saves while an earlier one keeps failing');
  check(!rows.some(r => r[11] === failId), 'the failing one is still waiting');
  await post({ action: 'add', token, entry: { id: 'fromdevin1', type: 'diaper', t: Date.now(), kind: 'wet' } });
  await B.evaluate(() => document.getElementById('sync').click()); await B.waitForTimeout(1500);
  check(await B.evaluate(() => JSON.parse(localStorage.getItem('bl.entries')).some(e => e.id === 'fromdevin1')), "Tess still gets Devin's new entries while hers waits");
  check((await B.textContent('#syncBody')).includes('Tried') && (await B.textContent('#syncBody')).includes('Service Spreadsheets failed'), 'the sync panel shows what is stuck and why');
  await B.screenshot({ path: OUT + '/ft-sync.png' });
  await B.click('#syncBody .q-item:has-text("Tried") >> text=Discard'); await B.waitForTimeout(800);
  check(await B.evaluate(id => !JSON.parse(localStorage.getItem('bl.outbox')).length && !JSON.parse(localStorage.getItem('bl.entries')).some(e => e.id === id), failId), 'Discard removes it from the phone');
  await B.keyboard.press('Escape');
  await ctxB.unroute('**/exec');

  // ---------- Improvement 4: change-only syncs, deletes included ----------
  const lists = [];
  await ctxB.route('**/exec', async route => { const b = route.request().postData() || ''; if (b.includes('"action":"list"')) lists.push(JSON.parse(b)); return route.continue(); });
  await post({ action: 'add', token, entry: { id: 'delta00001', type: 'diaper', t: Date.now(), kind: 'dirty' } });
  await B.evaluate(() => window.dispatchEvent(new Event('online'))); await B.waitForTimeout(1500);
  check(lists.length && lists[lists.length - 1].since > 0, 'a routine poll asks only for changes since the last one');
  check(await B.evaluate(() => JSON.parse(localStorage.getItem('bl.entries')).some(e => e.id === 'delta00001')), 'the change arrives');
  await post({ action: 'delete', token, id: 'delta00001' });
  await B.evaluate(() => window.dispatchEvent(new Event('online'))); await B.waitForTimeout(1500);
  check(await B.evaluate(() => !JSON.parse(localStorage.getItem('bl.entries')).some(e => e.id === 'delta00001')), 'a delete on another phone arrives in a change-only sync');
  await ctxB.unroute('**/exec');

  // ---------- Bug 3: a request that never answers gives up and retries ----------
  let hang = true;
  await ctxB.route('**/exec', async route => {
    const b = route.request().postData() || '';
    if (hang && b.includes('"action":"add"')) return;   // never answers
    return route.continue();
  });
  await B.click('[data-open="diaper"]'); await B.click('[data-kind="wet"]'); await B.click('#diaperSave');
  await B.waitForTimeout(16500);
  const ob2 = await B.evaluate(() => JSON.parse(localStorage.getItem('bl.outbox')));
  check(ob2.length === 1 && ob2[0].tries === 1 && /too long/.test(ob2[0].lastError), 'a save with no answer stops after 15 seconds and waits to retry');
  check((await B.textContent('#syncText')).includes('waiting'), 'the pill shows it waiting, not stuck on Saving');
  hang = false;
  await B.evaluate(() => window.dispatchEvent(new Event('online')));
  await B.waitForTimeout(7000);
  check(await B.evaluate(() => !JSON.parse(localStorage.getItem('bl.outbox')).length), 'it goes through on retry');
  await ctxB.unroute('**/exec');

  // ---------- Feature 2: reminders ----------
  const pubKey = 'B' + 'A'.repeat(86);
  check(!(await post({ action: 'pushSubscribe', token, subscription: { endpoint: 'https://push.example.com/x/123456789', keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) } } })).ok, 'phones cannot subscribe before reminders are linked');
  const linked = await post({ action: 'linkPush', token, url: 'https://babylog-home-abc.a.run.app', secret: 's'.repeat(64), publicKey: pubKey });
  check(linked.ok && linked.linked, 'deploy.sh can link the cloud service');
  await fetch(BASE + '/__run?fn=setupReminders');
  // Notifications need the service worker, so check Settings in a session that allows it
  const ctxN = await browser.newContext({ ...phone, colorScheme: 'light' });
  const N = await ctxN.newPage();
  N.on('pageerror', e => { console.log('PAGEERROR N', e.message); failures++; });
  await N.goto(BASE + '/');
  await N.evaluate(([t]) => localStorage.setItem('bl.auth', JSON.stringify({ token: t, name: 'Devin', role: 'admin', deviceId: 'x' })), [token]);
  await N.reload(); await N.waitForTimeout(1500);
  await N.click('#sheet-install [data-close]').catch(() => {});
  await N.click('#meBtn'); await N.waitForTimeout(2500);
  check((await N.textContent('#settingsBody')).includes('Notifications on this phone'), 'Settings shows the notifications switch once reminders are linked');
  await N.screenshot({ path: OUT + '/ft-settings.png' });
  await ctxN.close();
  await A.click('#meBtn'); await A.waitForTimeout(6500);
  check((await A.textContent('#settingsBody')).includes('background helper'), 'without a service worker it says so instead of hanging');
  await A.keyboard.press('Escape');
  const sub = await post({ action: 'pushSubscribe', token, subscription: { endpoint: 'https://push.example.com/x/123456789', keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) } }, prefs: { feedHours: 2, longFeed: true, meds: true } });
  check(sub.ok && sub.sub && sub.sub.feedHours === 2, 'a phone subscribes with its own choices');
  // Make every alert due: last feed 3 h ago, a dose due, a 50-minute side
  await post({ action: 'add', token, entry: { id: 'oldfeed001', type: 'bottle', t: Date.now() - 2 * MIN, oz: 2, amount: 2, unit: 'oz', source: 'formula' } });
  await post({ action: 'add', token, entry: { id: 'meddue0001', type: 'health', kind: 'med', t: Date.now() - 5 * 3600000, detail: 'Gas drops', dose: '0.3 mL', remindHours: 4 } });
  await post({ action: 'live', token, state: { id: 'longfeed02', start: Date.now() - 55 * MIN, first: 'R', side: 'R', running: true, segStart: Date.now() - 50 * MIN, left: 0, right: 0, by: 'Tess' } });
  await fetch(BASE + '/__checkAlerts');
  let pushes = await (await fetch(BASE + '/__pushes')).json();
  check(pushes.some(p => p.title === 'Still feeding?' && /right side/.test(p.body)), 'a 50-minute side sends "Still feeding?"');
  check(pushes.some(p => p.title === 'Gas drops is due' && /0.3 mL/.test(p.body)), 'a due dose sends "Gas drops is due"');
  check(pushes.every(p => p.auth === 'Bearer ' + 's'.repeat(64) && p.url === 'https://babylog-home-abc.a.run.app/push'), 'notifications go to the linked service with its secret');
  check(!pushes.some(p => p.title === 'Feed due'), 'no feed-due alert while a feed is in progress or recent');
  await post({ action: 'live', token, state: null });
  // Feed due: make the newest feed 3 hours old by deleting the recent ones
  const feedsNow = (await logRows()).filter(r => r[1] === 'Breastfeed' || r[1] === 'Bottle');
  for (const r of feedsNow) if (new Date(r[0]).getTime() > Date.now() - 150 * MIN) await post({ action: 'delete', token, id: r[11] });
  const before = pushes.length;
  await fetch(BASE + '/__checkAlerts');
  pushes = await (await fetch(BASE + '/__pushes')).json();
  check(pushes.slice(before).some(p => p.title === 'Feed due' && /No feed for/.test(p.body)), 'no feed for over 2 hours sends "Feed due": ' + (pushes.slice(before).find(p => p.title === 'Feed due') || {}).body);
  const n = pushes.length;
  await fetch(BASE + '/__checkAlerts');
  pushes = await (await fetch(BASE + '/__pushes')).json();
  check(pushes.length === n, 'the same alert is not sent twice');
  // A phone that is gone stops getting them
  await fetch(BASE + '/__pushResult?gone=1');
  await post({ action: 'add', token, entry: { id: 'meddue0002', type: 'health', kind: 'med', t: Date.now() - 7 * 3600000, detail: 'Iron drops', remindHours: 6 } });
  await fetch(BASE + '/__checkAlerts');
  const pushTab = (await state()).Push;
  check(pushTab && pushTab.slice(1).some(r => r[2] === 'Expired'), 'a phone that unsubscribed is marked Expired');
  await fetch(BASE + '/__pushResult');

  // ---------- Improvement 2: summary tabs rebuild ----------
  const rb = await fetch(BASE + '/__run?fn=rebuildSummaries');
  const st = await state();
  check(rb.status === 200 && st.Dashboard && st.Dashboard.some(r => r[0] === 'Milk removal (breastfeeds + pumps)') && st.Daily[0][0].includes("'Milk removal'"), 'rebuilding the summary tabs adds pumps, milk removal and sleep');

  // ---------- A timer running on a phone from before timers were shared carries over ----------
  await A.evaluate(() => localStorage.setItem('bl.active', JSON.stringify({ start: Date.now() - 6 * 60000, first: 'L', side: 'L', running: true, segStart: Date.now() - 6 * 60000, left: 0, right: 0 })));
  await A.reload(); await A.waitForTimeout(2500);
  await A.click('#sheet-install [data-close]').catch(() => {});
  const carried = JSON.parse((await (await fetch(BASE + '/__props')).json()).live || 'null');
  check(carried && carried.by === 'Devin' && carried.side === 'L' && !(await A.isHidden('#live')), 'an old single-phone timer becomes the shared timer instead of disappearing');
  await post({ action: 'live', token, state: null });
  await A.evaluate(() => localStorage.removeItem('bl.active'));

  // ---------- Look ----------
  await A.reload(); await A.waitForTimeout(1500);
  await A.click('#sheet-install [data-close]').catch(() => {});
  await A.screenshot({ path: OUT + '/ft-home.png' });
  check(!(await A.isHidden('#feedDue')) && await A.evaluate(() => document.getElementById('lastFeedAgo').closest('.stat').classList.contains('due')), 'Home marks the last feed card "Feed due" after 3 hours');
  const overflow = await A.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check(!overflow, 'no sideways scrolling with eight buttons');

  await browser.close();
  console.log(failures ? failures + ' FAILED' : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
