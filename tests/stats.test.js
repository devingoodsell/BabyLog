const { chromium, devices } = require('playwright');
const BASE = 'http://localhost:' + process.env.PORT;
const OUT = __dirname + '/shots';
let fails = 0; const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const b = await chromium.launch((process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}));
  const code = (await (await fetch(BASE + '/__invite')).text()).match(/#invite=([a-f0-9]+)/)[1];
  for (const scheme of ['light', 'dark']) {
    const ctx = await b.newContext({ ...devices['iPhone 13'], colorScheme: scheme, serviceWorkers: 'block' });
    const P = await ctx.newPage();
    P.on('pageerror', e => { console.log('PAGEERROR', e.message); fails++; });
    if (scheme === 'light') {
      await P.goto(BASE + '/#invite=' + code);
      await P.click('text=Join Baby Log');
      await P.waitForSelector('#screen-home:not([hidden])');
      const token = await P.evaluate(() => JSON.parse(localStorage.getItem('bl.auth')).token);
      // 6 past days + today. Day k (k days ago at noon): wet 6+k%3, dirty k%2+2, breast 7+k%2, bottles k%3 of 1.5 oz
      const noon = k => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - k); return Math.min(d.getTime(), Date.now() - 60000); };
      let n = 0;
      const add = async (entry) => {
        const r = await (await fetch(BASE + '/exec', { method: 'POST', body: JSON.stringify({ action: 'add', token, entry: Object.assign({ id: 'seed' + (n++) + 'x'.repeat(6) }, entry) }) })).json();
        if (!r.ok) console.log('seed failed', r);
      };
      for (let k = 0; k <= 6; k++) {
        const t = noon(k);
        for (let i = 0; i < 6 + k % 3; i++) await add({ type: 'diaper', kind: i === 0 ? 'both' : 'wet', t: t - i * 60000 });
        for (let i = 0; i < 1 + k % 2; i++) await add({ type: 'diaper', kind: 'dirty', t: t - 100 * 60000 - i * 60000 });
        for (let i = 0; i < 7 + k % 2; i++) await add({ type: 'breast', left: 10, right: 8, first: 'L', last: 'R', t: t - 200 * 60000 - i * 60000 });
        for (let i = 0; i < k % 3; i++) await add({ type: 'bottle', oz: 1.5, amount: 1.5, unit: 'oz', source: 'formula', t: t - 300 * 60000 - i * 60000 });
      }
      await ctx.storageState({ path: require('os').tmpdir() + '/babylog-state-' + process.env.PORT + '.json' });
      await P.reload();
    } else {
      await P.goto(BASE + '/');
      const st = JSON.parse(require('fs').readFileSync(require('os').tmpdir() + '/babylog-state-' + process.env.PORT + '.json'));
      await P.evaluate(ls => ls.forEach(x => localStorage.setItem(x.name, x.value)), st.origins[0].localStorage);
      await P.reload();
    }
    await P.waitForTimeout(1500);
    await P.click('#statsBtn');
    await P.waitForTimeout(600);
    if (scheme === 'light') {
      // Expected complete-day averages over k=1..6
      const ks = [1, 2, 3, 4, 5, 6];
      const avg = f => +(ks.reduce((s, k) => s + f(k), 0) / 6).toFixed(1);
      const wet = avg(k => 6 + k % 3), dirty = avg(k => 1 + k % 2 + 1), feeds = avg(k => 7 + k % 2 + k % 3), oz = avg(k => 1.5 * (k % 3));
      const tiles = await P.$$eval('#stTiles b', x => x.map(e => e.textContent));
      check(tiles[0] === String(feeds) && tiles[1] === String(Math.round(oz * 10) / 10) && tiles[2] === String(wet) && tiles[3] === String(dirty),
        'averages: got ' + tiles + ' expected ' + [feeds, oz, wet, dirty]);
      check((await P.textContent('#stIntakeDetail')).startsWith('Today so far: 7 feeds'), 'today detail: ' + await P.textContent('#stIntakeDetail'));
      check((await P.$$('#chFeeds path')).length === 7 + 4, 'feeds chart: 7 breast bars + 4 bottle segments (got ' + (await P.$$('#chFeeds path')).length + ')');
      // tap 2 days ago on the wet chart
      const hits = await P.$$('#chWet rect.hit');
      await hits[hits.length - 3].click();
      await P.waitForTimeout(200);
      check((await P.textContent('#stWetDetail')).includes(': ' + (6 + 2 % 3) + ' wet'), 'tapping a day updates details: ' + await P.textContent('#stWetDetail'));
      check((await P.textContent('#stIntakeDetail')).includes('2 bottles, 3 oz'), 'intake detail for that day: ' + await P.textContent('#stIntakeDetail'));
      await P.click('#rng14');
      check((await P.$$('#chWet rect.hit')).length === 14, '14-day range shows 14 days');
      await P.click('#rng30');
      check((await P.$$('#chWet rect.hit')).length === 30, '30-day range shows 30 days');
      const xl = await P.$$eval('#chWet text', t => t.map(x => x.textContent));
      check(xl.includes('Today') && xl.length < 15, '30-day axis labels are spaced out: ' + xl.slice(3).join(' '));
      await P.evaluate(() => document.querySelector('#sheet-stats').scrollTop = 900);
      await P.screenshot({ path: OUT + '/17-stats-30.png' });
      await P.evaluate(() => document.querySelector('#sheet-stats').scrollTop = 0);
      await P.click('#rng7');
      await P.screenshot({ path: OUT + '/14-stats-light.png' });
      await P.evaluate(() => document.querySelector('#sheet-stats').scrollTop = 99999);
      await P.click('summary');
      await P.waitForTimeout(200);
      check((await P.$$('#stTable tbody tr')).length === 7, 'table has 7 rows');
      await P.screenshot({ path: OUT + '/15-stats-bottom.png' });
      const overflow = await P.evaluate(() => document.querySelector('#sheet-stats').scrollWidth > document.querySelector('#sheet-stats').clientWidth);
      check(!overflow, 'no sideways scrolling in the stats sheet');
    } else {
      await P.screenshot({ path: OUT + '/16-stats-dark.png' });
    }
    await ctx.close();
  }
  await b.close();
  console.log(fails ? fails + ' FAILURES' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
