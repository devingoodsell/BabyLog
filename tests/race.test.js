// Bug 1: a slow refresh that started before a save must not undo the save on screen.
const { chromium, devices } = require('playwright');
const BASE = 'http://localhost:' + process.env.PORT;
let failures = 0;
const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failures++; };
(async () => {
  const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const phone = { ...devices['iPhone 13'] }; delete phone.defaultBrowserType;
  const code = (await (await fetch(BASE + '/__invite')).text()).match(/#invite=([a-f0-9]+)/)[1];
  const ctx = await b.newContext({ ...phone, serviceWorkers: 'block' });
  const P = await ctx.newPage();
  P.on('pageerror', e => { console.log('PAGEERROR', e.message); failures++; });
  await P.goto(BASE + '/#invite=' + code); await P.fill('#joinName', 'Devin'); await P.click('text=Join Baby Log');
  await P.waitForSelector('#screen-home:not([hidden])'); await P.waitForTimeout(1200);
  await P.click('#sheet-install [data-close]').catch(() => {}); await P.waitForTimeout(300);
  // Hold "list" answers for 9 seconds, with the sheet as it was when the request arrived
  let slow = false;
  await ctx.route('**/exec', async route => {
    const body = route.request().postData() || '';
    const resp = await route.fetch();
    if (slow && body.includes('"action":"list"')) await new Promise(r => setTimeout(r, 9000));
    await route.fulfill({ response: resp });
  });
  const items = () => P.evaluate(() => document.querySelectorAll('#timeline .item').length);

  // A diaper saved while a refresh is loading
  slow = true;
  await P.click('#sync'); await P.keyboard.press('Escape');      // a refresh starts; its answer is slow
  await P.waitForTimeout(300);
  await P.click('[data-open="diaper"]'); await P.click('[data-kind="wet"]'); await P.click('#diaperSave');
  await P.waitForTimeout(1500);
  check(await items() === 1, 'diaper shows right after saving');
  await P.waitForTimeout(10000);
  check(await items() === 1, 'diaper still shows after the slow, older refresh answer arrives');

  // A sleep ended while a refresh is loading
  slow = false;
  await P.click('[data-open="sleep"]'); await P.click('.chips.when[data-for="sleepStart"] .chip[data-m="20"]'); await P.click('#sleepStartBtn');
  await P.waitForTimeout(1500);
  slow = true;
  await P.click('#sync'); await P.keyboard.press('Escape'); await P.waitForTimeout(300);
  await P.click('#liveSleep'); await P.click('#sleepEndBtn');
  await P.waitForTimeout(1500);
  check(await P.isHidden('#liveSleep'), 'asleep banner gone right after Save sleep');
  await P.waitForTimeout(10000);
  check(await P.isHidden('#liveSleep'), 'asleep banner stays gone after the slow refresh answer arrives');
  slow = false;
  await P.waitForTimeout(1500);
  check(await items() === 2, 'a later refresh shows both entries');
  await b.close();
  console.log(failures ? failures + ' FAILED' : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
