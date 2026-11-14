// Sleep and weight: two phones sharing one sleep, entered-after sleeps, offline, weigh-ins, Stats, validation.
const { chromium, devices } = require('playwright');
const BASE = 'http://localhost:' + process.env.PORT;
const OUT = __dirname + '/shots';
require('fs').mkdirSync(OUT, { recursive: true });
const MIN = 60000;
const state = async () => (await fetch(BASE + '/__state')).json();
const logRows = async () => (await state()).Log.slice(1).filter(r => r.some(v => v !== '' && v != null));
const post = async body => (await fetch(BASE + '/exec', { method: 'POST', body: JSON.stringify(body) })).json();
let failures = 0;
const check = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };
const hm = t => { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const sleeps = rows => rows.filter(r => r[1] === 'Sleep');

(async () => {
  const browser = await chromium.launch((process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}));
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
  const sync = async P => { await P.click('#sync'); await P.waitForTimeout(900); await P.keyboard.press('Escape'); await P.waitForTimeout(300); };
  const settle = async P => { await P.waitForFunction(() => JSON.parse(localStorage.getItem('bl.outbox') || '[]').length === 0, null, { timeout: 8000 }).catch(() => {}); await P.waitForTimeout(200); };

  const ctxA = await browser.newContext({ ...phone, colorScheme: 'light', serviceWorkers: 'block' });
  const A = await join(ctxA, code, 'Devin');
  const token = await A.evaluate(() => JSON.parse(localStorage.getItem('bl.auth')).token);
  const inv = await post({ action: 'invite', token, name: 'Tess', role: 'member' });
  const ctxB = await browser.newContext({ ...phone, colorScheme: 'dark', serviceWorkers: 'block' });
  const B = await join(ctxB, inv.code, 'Tess');

  // ---------- Home layout ----------
  check(await A.$$eval('.actions .action', b => b.length) === 8, 'eight log buttons on Home');
  const grid = await A.$$eval('.actions .action', b => b.map(x => Math.round(x.getBoundingClientRect().top)));
  check(new Set(grid).size === 2, 'log buttons sit in two rows of four');
  check((await A.textContent('#sleepAgo')).trim() === 'None yet', 'sleep card starts empty');
  const overflow = await A.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check(!overflow, 'no sideways scrolling on Home');

  // ---------- Devin starts a sleep 20 minutes ago ----------
  await A.click('[data-open="sleep"]');
  check(!(await A.isHidden('#slTimerPane')) && await A.isHidden('#sleepOpen'), 'sleep sheet opens on the timer with no sleep going');
  await A.click('.chips.when[data-for="sleepStart"] .chip[data-m="20"]');
  await A.click('#sleepStartBtn');
  await settle(A);
  let rows = await logRows();
  check(sleeps(rows).length === 1 && sleeps(rows)[0][7] === '' && sleeps(rows)[0][22] === '', 'open sleep row has no End and no Sleep min yet');
  const startT = new Date(sleeps(rows)[0][0]).getTime();
  check(Math.abs(Date.now() - 20 * MIN - startT) < 2 * MIN, 'sleep start is 20 minutes ago');
  check(!(await A.isHidden('#liveSleep')), 'Devin sees the asleep banner');
  check(/Asleep · 20:\d\d/.test(await A.textContent('#liveSleepTitle')), 'banner counts the time asleep (' + (await A.textContent('#liveSleepTitle')) + ')');
  check((await A.textContent('#sleepCard .label')).trim() === 'Asleep for', 'sleep card says Asleep for');
  check((await A.textContent('#timeline')).includes('Asleep now'), 'timeline shows the sleep as going on');

  // ---------- Tess sees it and ends it ----------
  await sync(B);
  check(!(await B.isHidden('#liveSleep')), 'Tess sees the same sleep on her phone');
  check((await B.textContent('#liveSleepSub')).includes('started by Devin'), 'banner says who started it');
  await B.click('#liveSleep');
  await B.waitForTimeout(400);
  check(!(await B.isHidden('#sleepOpen')), 'tapping the banner opens the wake-up screen');
  await B.screenshot({ path: OUT + '/sw-wake.png' });
  // a wake-up before the sleep started is refused
  await B.click('.chips.when[data-for="sleepEnd"] .chip[data-m="30"]');
  await B.click('#sleepEndBtn');
  await B.waitForTimeout(300);
  check((await B.textContent('#toastMsg')).startsWith('Wake-up has to be after'), 'wake-up before the start is refused');
  check(await B.evaluate(() => document.getElementById('sheet-sleep').classList.contains('open')), 'sheet stays open after a refused wake-up');
  await B.click('.chips.when[data-for="sleepEnd"] .chip[data-m="0"]');
  await B.click('#sleepEndBtn');
  await settle(B);
  rows = await logRows();
  let sr = sleeps(rows)[0];
  check(sr[7] !== '' && (sr[22] === 20 || sr[22] === 21), 'Tess ending it fills End and Sleep min (' + sr[22] + ')');
  check(sr[8] === 'Devin', 'the row still credits Devin who started it');
  check(await B.isHidden('#liveSleep'), "banner gone on Tess's phone");
  await sync(A);
  check(await A.isHidden('#liveSleep'), "banner gone on Devin's phone after sync");
  check((await A.textContent('#sleepCard .label')).trim() === 'Awake for', 'sleep card now says Awake for');
  check((await A.textContent('#sleepSub')).startsWith('Slept 2'), 'sleep card shows how long he slept (' + (await A.textContent('#sleepSub')) + ')');

  // ---------- Entered after: 95 minutes ending 2 hours ago ----------
  const to = Date.now() - 120 * MIN, from = to - 95 * MIN;
  await A.click('[data-open="sleep"]');
  await A.click('#slModeManual');
  await A.fill('#slTo', hm(to)); await A.dispatchEvent('#slTo', 'change');
  await A.fill('#slFrom', hm(from)); await A.dispatchEvent('#slFrom', 'change');
  check((await A.textContent('#slTotal')).includes('1h 35m'), 'entered-after shows Slept 1h 35m (' + (await A.textContent('#slTotal')) + ')');
  await A.screenshot({ path: OUT + '/sw-manual.png' });
  await A.click('#sleepManualSave');
  await settle(A);
  rows = await logRows();
  check(sleeps(rows).some(r => r[22] === 95), 'entered-after sleep saved with 95 minutes');

  // a sleep across midnight: 23:30 to 01:15 the night before last is still 1h 45m
  await A.click('[data-open="sleep"]');
  await A.click('#slModeManual');
  await A.fill('#slTo', '01:15'); await A.dispatchEvent('#slTo', 'change');
  await A.fill('#slFrom', '23:30'); await A.dispatchEvent('#slFrom', 'change');
  check((await A.textContent('#slTotal')).includes('1h 45m'), 'a sleep across midnight counts 1h 45m');
  await A.keyboard.press('Escape');

  // ---------- Cancel an open sleep ----------
  await A.click('[data-open="sleep"]');
  await A.click('#sleepStartBtn');
  await settle(A);
  await A.click('#sleepCard');
  await A.waitForTimeout(300);
  check(!(await A.isHidden('#sleepOpen')), 'the sleep card opens the wake-up screen while asleep');
  await A.click('#sleepCancel');
  await settle(A);
  rows = await logRows();
  check(sleeps(rows).length === 2, 'cancelling an open sleep removes its row');

  // ---------- Offline: start and end while offline, and end offline after starting online ----------
  await ctxA.setOffline(true);
  await A.click('[data-open="sleep"]');
  await A.click('.chips.when[data-for="sleepStart"] .chip[data-m="10"]');
  await A.click('#sleepStartBtn');
  await A.waitForTimeout(500);
  await A.click('#liveSleep');
  await A.click('#sleepEndBtn');
  await A.waitForTimeout(500);
  const ob = await A.evaluate(() => JSON.parse(localStorage.getItem('bl.outbox')));
  check(ob.length === 1 && ob[0].op === 'add' && ob[0].entry.end, 'ending an unsent sleep updates the queued entry instead of adding a second step');
  await ctxA.setOffline(false);
  await A.evaluate(() => window.dispatchEvent(new Event('online')));
  await settle(A);
  rows = await logRows();
  check(sleeps(rows).some(r => r[22] === 10), 'offline sleep reaches the sheet with 10 minutes');

  await A.click('[data-open="sleep"]');
  await A.click('.chips.when[data-for="sleepStart"] .chip[data-m="30"]');
  await A.click('#sleepStartBtn');
  await settle(A);
  await ctxA.setOffline(true);
  await A.click('#liveSleep');
  await A.click('#sleepEndBtn');
  await A.waitForTimeout(500);
  const ob2 = await A.evaluate(() => JSON.parse(localStorage.getItem('bl.outbox')));
  check(ob2.length === 1 && ob2[0].op === 'endSleep', 'ending a saved sleep offline queues an endSleep step');
  check(await A.isHidden('#liveSleep'), 'banner clears right away even offline');
  await ctxA.setOffline(false);
  await A.evaluate(() => window.dispatchEvent(new Event('online')));
  await settle(A);
  rows = await logRows();
  check(sleeps(rows).some(r => r[22] === 30 || r[22] === 31), 'queued wake-up reaches the sheet');

  // ---------- Weight ----------
  await A.click('[data-open="weight"]');
  check((await A.inputValue('#wLb')) === '7' && (await A.inputValue('#wOz')) === '8', 'weight starts at 7 lb 8 oz with no history');
  await A.click('#wLbPlus');
  await A.click('#wOzPlus'); await A.click('#wOzPlus'); await A.click('#wOzPlus');
  check((await A.inputValue('#wLb')) === '8' && (await A.inputValue('#wOz')) === '9.5', 'steppers give 8 lb 9.5 oz');
  check((await A.textContent('#wSame')).includes('3.90 kg'), 'shows the same weight in kg (' + (await A.textContent('#wSame')) + ')');
  // ounces past 16 roll into pounds
  await A.fill('#wOz', '17'); await A.press('#wOz', 'Enter');
  check((await A.inputValue('#wLb')) === '9' && (await A.inputValue('#wOz')) === '1', '17 oz rolls over to 9 lb 1 oz');
  await A.fill('#wOz', '9.5'); await A.press('#wOz', 'Enter');
  await A.fill('#wLb', '8'); await A.press('#wLb', 'Enter');
  await A.screenshot({ path: OUT + '/sw-weight.png' });
  await A.click('#weightSave');
  await settle(A);
  rows = await logRows();
  let wr = rows.find(r => r[1] === 'Weight');
  check(wr && wr[23] === 8.594 && wr[24] === '8 lb 9.5 oz', 'weight row: 8.594 lb and "8 lb 9.5 oz" (' + (wr && [wr[23], wr[24]]) + ')');

  // a backdated weigh-in in kg (birth weight, 10 days ago)
  await A.click('[data-open="weight"]');
  check((await A.textContent('#wPrev')).includes('8 lb 9.5 oz'), 'weight sheet shows the last weigh-in');
  await A.click('#wUnitKg');
  await A.fill('#wKg', '3.2');
  const d10 = new Date(Date.now() - 10 * 86400000);
  await A.fill('#wDate', d10.getFullYear() + '-' + String(d10.getMonth() + 1).padStart(2, '0') + '-' + String(d10.getDate()).padStart(2, '0'));
  await A.click('#weightSave');
  await settle(A);
  rows = await logRows();
  wr = rows.filter(r => r[1] === 'Weight').find(r => r[24] !== '8 lb 9.5 oz');
  check(wr && wr[24] === '7 lb 0.9 oz' && new Date(wr[0]).getHours() === 12, 'backdated kg weigh-in saved as 7 lb 0.9 oz at midday (' + (wr && [wr[24], wr[0]]) + ')');
  check((await A.textContent('#timeline')).includes('3.90 kg · +'), 'timeline shows weight in kg with the change since last time');
  check(await A.evaluate(() => JSON.parse(localStorage.getItem('bl.prefs')).weightUnit) === 'kg', 'kg choice is remembered on this phone');

  // weigh-ins older than the 30-day window still load (for the chart)
  await post({ action: 'add', token, entry: { id: 'oldweight1', type: 'weight', t: Date.now() - 60 * 86400000, weightOz: 110 } });
  await sync(A);
  check(await A.evaluate(() => JSON.parse(localStorage.getItem('bl.entries')).some(e => e.id === 'oldweight1')), 'a 60-day-old weigh-in is still sent to the app');
  await A.click('[data-open="weight"]'); await A.click('#wUnitLb'); await A.keyboard.press('Escape'); await A.waitForTimeout(300);

  // ---------- Stats ----------
  await A.click('#statsBtn');
  await A.waitForTimeout(700);
  check(await A.$$eval('#chSleep path', p => p.length) >= 1, 'sleep chart has bars');
  check((await A.textContent('#stSleepDetail')).includes('asleep'), 'sleep detail: ' + (await A.textContent('#stSleepDetail')));
  check(await A.$$eval('#chWeight circle', c => c.length) === 3, 'weight chart shows all three weigh-ins');
  check((await A.textContent('#stWeightDetail')).includes('8 lb 9.5 oz'), 'weight detail shows the latest: ' + (await A.textContent('#stWeightDetail')));
  check((await A.textContent('#stWeightHead')).includes('since'), 'weight header shows change since first: ' + (await A.textContent('#stWeightHead')));
  await A.evaluate(() => document.getElementById('chSleep').scrollIntoView());
  await A.screenshot({ path: OUT + '/sw-stats.png' });
  const wHits = await A.$$('#chWeight rect.hit');
  await wHits[1].click();
  check((await A.textContent('#stWeightDetail')).includes('7 lb 0.9 oz'), 'tapping a point selects that weigh-in');
  await A.evaluate(() => document.getElementById('chWeight').scrollIntoView());
  await A.screenshot({ path: OUT + '/sw-stats-weight.png' });
  await A.keyboard.press('Escape');

  // ---------- Server checks ----------
  const bad = async (entry, why) => { const r = await post({ action: 'add', token, entry: Object.assign({ id: 'bad' + Math.random().toString(16).slice(2, 10) }, entry) }); check(!r.ok, why + ' (' + (r.message || 'accepted') + ')'); };
  await bad({ type: 'weight', t: Date.now(), weightOz: 5 }, 'refuses a 5 oz weight');
  await bad({ type: 'weight', t: Date.now() - 400 * 86400000, weightOz: 120 }, 'refuses a weigh-in over a year old');
  await bad({ type: 'sleep', t: Date.now() - 26 * 60 * MIN, end: Date.now() }, 'refuses a 26 hour sleep');
  await bad({ type: 'sleep', t: Date.now() - 60 * MIN, end: Date.now() - 90 * MIN }, 'refuses a wake-up before the start');
  const diaperId = (await logRows()).find(r => r[1] !== 'Sleep' && r[1] !== 'Weight' && r[11])?.[11];
  await post({ action: 'add', token, entry: { id: 'dz000001', type: 'diaper', t: Date.now(), kind: 'wet' } });
  const r1 = await post({ action: 'endSleep', token, id: 'dz000001', end: Date.now() });
  check(!r1.ok, 'endSleep refuses a non-sleep entry (' + r1.message + ')');

  // ---------- Look ----------
  await A.reload(); await A.waitForTimeout(1200);
  await A.click('#sheet-install [data-close]').catch(() => {});
  await A.screenshot({ path: OUT + '/sw-home.png' });
  await B.click('[data-open="sleep"]'); await B.click('#sleepStartBtn'); await settle(B);
  await B.waitForTimeout(400);
  await B.screenshot({ path: OUT + '/sw-home-dark-asleep.png' });

  await browser.close();
  console.log(failures ? failures + ' FAILED' : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
