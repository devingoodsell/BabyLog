// Typed breastfeed minutes, and the milk removal chart.
const { chromium, devices } = require('playwright');
const BASE = 'http://localhost:' + process.env.PORT;
const OUT = __dirname + '/shots';
const MIN = 60000;
const logRows = async () => (await (await fetch(BASE + '/__state')).json()).Log.slice(1).filter(r => r.some(v => v !== '' && v != null));
const post = async b => (await fetch(BASE + '/exec', { method: 'POST', body: JSON.stringify(b) })).json();
let failures = 0;
const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failures++; };
(async () => {
  const b = await chromium.launch((process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}));
  const phone = { ...devices['iPhone 13'] }; delete phone.defaultBrowserType;
  const code = (await (await fetch(BASE + '/__invite')).text()).match(/#invite=([a-f0-9]+)/)[1];
  const P = await (await b.newContext({ ...phone, serviceWorkers: 'block' })).newPage();
  P.on('pageerror', e => { console.log('PAGEERROR', e.message); failures++; });
  await P.goto(BASE + '/#invite=' + code); await P.fill('#joinName', 'Devin'); await P.click('text=Join Baby Log');
  await P.waitForSelector('#screen-home:not([hidden])'); await P.waitForTimeout(900);
  await P.click('#sheet-install [data-close]').catch(() => {}); await P.waitForTimeout(300);
  const token = await P.evaluate(() => JSON.parse(localStorage.getItem('bl.auth')).token);
  const settle = () => P.waitForFunction(() => JSON.parse(localStorage.getItem('bl.outbox') || '[]').length === 0, null, { timeout: 8000 }).catch(() => {});

  // ---- Typed minutes ----
  await P.click('[data-open="feed"]'); await P.click('#modeManual');
  check(await P.inputValue('#mL') === '10' && await P.inputValue('#mR') === '10', 'minute boxes start at 10');
  await P.click('#mL'); await P.waitForTimeout(150); await P.keyboard.type('3a5');
  check(await P.inputValue('#mL') === '35', 'typing keeps digits only (35)');
  await P.click('#mR'); await P.waitForTimeout(150); await P.keyboard.type('12');
  await P.click('[data-step="R"][data-d="1"]');            // + after typing builds on the typed number
  check(await P.inputValue('#mR') === '13', 'plus after typing 12 gives 13');
  await P.screenshot({ path: OUT + '/rm-manual.png' });
  await P.click('#mR'); await P.waitForTimeout(150); await P.keyboard.type('8');          // still focused when Save is pressed
  await P.click('#manualSave'); await settle();
  let rows = await logRows();
  const bf = rows.find(r => r[1] === 'Breastfeed');
  check(bf && bf[2] === 35 && bf[3] === 8, 'saved left 35, right 8 (got ' + (bf && [bf[2], bf[3]]) + ')');
  await P.click('[data-open="feed"]'); await P.click('#modeManual');
  await P.fill('#mL', '500'); await P.press('#mL', 'Enter');
  check(await P.inputValue('#mL') === '180', '500 is capped at 180 minutes');
  await P.fill('#mL', ''); await P.press('#mL', 'Enter');
  check(await P.inputValue('#mL') === '0', 'an empty box means 0');
  await P.keyboard.press('Escape');

  // ---- Milk removal ----
  const y0 = new Date(); y0.setHours(0, 0, 0, 0); const Y = y0.getTime() - 1440 * MIN;   // yesterday midnight
  let n = 0; const add = e => post({ action: 'add', token, entry: Object.assign({ id: 'rm' + String(n++).padStart(6, '0') }, e) });
  await add({ type: 'breast', t: Y + 60 * MIN, left: 10, right: 10, first: 'L', last: 'R' });        // 1:00 to 1:20
  await add({ type: 'pump', t: Y + 300 * MIN, side: 'B', minutes: 20 });                             // 5:00 to 5:20 (gap 3h 40m)
  await add({ type: 'breast', t: Y + 420 * MIN, left: 15, right: 0, first: 'L', last: 'L' });        // 7:00
  await add({ type: 'bottle', t: Y + 600 * MIN, oz: 2, amount: 2, unit: 'oz', source: 'formula' }); // not a removal
  await add({ type: 'pump', t: Y + 700 * MIN, side: 'L', minutes: 15 });
  await P.click('#sync'); await P.waitForTimeout(1200); await P.keyboard.press('Escape'); await P.waitForTimeout(300);
  await P.click('#statsBtn'); await P.waitForTimeout(600);
  const hits = await P.$$('#chRemoval rect.hit');
  await hits[hits.length - 2].click();
  const det = await P.textContent('#stRemDetail');
  check(det.includes(': 4 times') && det.includes('2 breastfeeds, 2 pumps'), 'yesterday: 4 times, 2 breastfeeds and 2 pumps (' + det + ')');
  check(det.includes('longest stretch between 4h 25m'), 'longest stretch is from 7:15 to 11:40, 4h 25m');
  check(await P.$$eval('#chRemoval path', p => p.length) >= 3, 'stacked bars drawn');
  check((await P.textContent('#stRemAvg')).startsWith('avg 4'), 'average per day: ' + await P.textContent('#stRemAvg'));
  check((await P.textContent('#stTable')).includes('Milk removal'), 'table has a Milk removal column');
  await P.evaluate(() => { const s = document.getElementById('sheet-stats'); const c = document.getElementById('chRemoval').closest('.st-card'); s.scrollTop += c.getBoundingClientRect().top - s.getBoundingClientRect().top - 14; });
  await P.screenshot({ path: OUT + '/rm-stats.png' });
  await b.close();
  console.log(failures ? failures + ' FAILED' : 'ALL PASSED'); process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
