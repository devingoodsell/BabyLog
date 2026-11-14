// Screenshots for the README, using made-up sample data.
const { chromium, devices } = require('playwright');
const fs = require('fs');
const BASE = 'http://localhost:' + process.env.PORT;
const OUT = process.argv[2];
fs.mkdirSync(OUT, { recursive: true });
const MIN = 60000;

(async () => {
  const b = await chromium.launch((process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}));
  const phone = { ...devices['iPhone 13'], deviceScaleFactor: 2, viewport: { width: 390, height: 760 } };
  const code = (await (await fetch(BASE + '/__invite')).text()).match(/#invite=([a-f0-9]+)/)[1];

  const ctx = await b.newContext({ ...phone, colorScheme: 'light', serviceWorkers: 'block' });
  const P = await ctx.newPage();
  await P.goto(BASE + '/#invite=' + code);
  await P.fill('#joinName', 'Sam');
  await P.click('text=Join Baby Log');
  await P.waitForSelector('#screen-home:not([hidden])');
  const token = await P.evaluate(() => JSON.parse(localStorage.getItem('bl.auth')).token);

  // A second caregiver, so the timeline shows two names
  const inv = await (await fetch(BASE + '/exec', { method: 'POST', body: JSON.stringify({ action: 'invite', token, name: 'Jordan', role: 'member' }) })).json();
  const red = await (await fetch(BASE + '/exec', { method: 'POST', body: JSON.stringify({ action: 'redeem', code: inv.code, name: 'Jordan' }) })).json();
  const tokens = [token, red.token];

  let n = 0;
  const add = async (entry, who = 0) => {
    const r = await (await fetch(BASE + '/exec', { method: 'POST', body: JSON.stringify({ action: 'add', token: tokens[who], entry: Object.assign({ id: 'sample' + String(n++).padStart(6, '0') }, entry) }) })).json();
    if (!r.ok) console.log('seed failed', r.message, JSON.stringify(entry));
  };

  // About a week of plausible newborn days, roughly every 2.5 hours
  const now = Date.now();
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const begin = startOfToday.getTime() - 6 * 1440 * MIN + 30 * MIN;
  let rnd = 7;
  const r = () => { rnd = (rnd * 9301 + 49297) % 233280; return rnd / 233280; };
  let side = 'L';
  const feeds = [];
  for (let t = begin; t < now - 40 * MIN; t += (140 + Math.round(r() * 50)) * MIN) feeds.push(t);
  for (let i = 0; i < feeds.length; i++) {
    const t = feeds[i];
    const who = new Date(t).getHours() < 6 ? 1 : 0;
    const roll = r();
    if (roll < 0.62) {
      const a = 6 + Math.round(r() * 8), c = 4 + Math.round(r() * 8);
      const other = side === 'L' ? 'R' : 'L';
      await add({ type: 'breast', t, left: side === 'L' ? a : c, right: side === 'L' ? c : a, first: side, last: other }, who);
      side = other;
    } else {
      const oz = [1.5, 2, 2, 2.5, 3][Math.floor(r() * 5)];
      await add({ type: 'bottle', t, oz, amount: oz, unit: 'oz', source: r() < 0.5 ? 'formula' : 'breast' }, who);
    }
    const d = r();
    await add({ type: 'diaper', t: t + 15 * MIN, kind: d < 0.55 ? 'wet' : d < 0.8 ? 'both' : 'dirty' }, who);
    // A nap after most feeds, ending before the next one
    const nextT = feeds[i + 1] || now;
    const sStart = t + (30 + Math.round(r() * 15)) * MIN;
    const sEnd = Math.min(nextT - 10 * MIN, sStart + (70 + Math.round(r() * 60)) * MIN);
    if (i < feeds.length - 1 && sEnd - sStart > 30 * MIN) await add({ type: 'sleep', t: sStart, end: sEnd }, who);
    if (r() < 0.3 && who === 0) {
      const l = 1 + Math.round(r() * 4) / 2, rr = 1 + Math.round(r() * 4) / 2;
      await add({ type: 'pump', t: t + 40 * MIN, side: 'B', minutes: 15 + Math.round(r() * 10), leftAmt: l, rightAmt: rr, pumpUnit: 'oz', label: r() < 0.5 ? 'Freezer bag ' + (n % 20) : '' });
    }
  }
  // A note on a recent diaper, for the timeline
  await add({ type: 'diaper', t: now - 32 * MIN, kind: 'both', note: 'Rash cream applied' }, 0);
  // Asleep right now, started by Jordan
  await add({ type: 'sleep', t: now - 24 * MIN }, 1);
  // Weigh-ins: birth, the usual early dip, then back up
  const day = n => startOfToday.getTime() - n * 1440 * MIN;
  await add({ type: 'weight', t: day(6) + 10 * 60 * MIN, weightOz: 118, note: 'Birth weight' }, 0);
  await add({ type: 'weight', t: day(4) + 12 * 60 * MIN, weightOz: 112.5, note: 'Pediatrician' }, 0);
  await add({ type: 'weight', t: day(2) + 12 * 60 * MIN, weightOz: 115 }, 0);
  await add({ type: 'weight', t: Math.min(now - 50 * MIN, day(0) + 9 * 60 * MIN), weightOz: 119.5, note: 'Pediatrician' }, 0);
  await add({ type: 'length', t: day(6) + 12 * 60 * MIN, lengthIn: 19.75, lengthUnit: 'in' }, 0);
  await add({ type: 'length', t: Math.min(now - 50 * MIN, day(0) + 9 * 60 * MIN) + 1000, lengthIn: 20.25, lengthUnit: 'in' }, 0);
  // Health and activities
  for (let d = 5; d >= 1; d--) await add({ type: 'health', kind: 'med', t: day(d) + 9 * 60 * MIN, detail: 'Vitamin D', dose: '1 drop', remindHours: 24 }, 0);
  await add({ type: 'health', kind: 'temp', t: day(2) + 15 * 60 * MIN, detail: 'Rectal', tempF: 99.1, tempUnit: 'F' }, 0);
  await add({ type: 'activity', t: now - 150 * MIN, detail: 'Tummy time', minutes: 5 }, 0);
  await add({ type: 'activity', t: day(1) + 19 * 60 * MIN, detail: 'Bath', minutes: 10 }, 1);

  const shoot = async (page, name) => {
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log('saved', name);
  };
  const reset = async page => {
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
    await page.evaluate(() => window.scrollTo(0, 0));
  };

  await P.reload();
  await P.waitForTimeout(1800);
  await P.click('#sheet-install [data-close]').catch(() => {});
  await P.waitForTimeout(400);
  await shoot(P, 'home');

  // Timeline, scrolled
  await P.evaluate(() => document.querySelector('.section-title:nth-of-type(2), #timeline').scrollIntoView({ block: 'start' }));
  await P.evaluate(() => window.scrollBy(0, -70));
  await shoot(P, 'timeline');
  await P.evaluate(() => window.scrollTo(0, 0));

  // Breastfeed timer in progress: 9 min on the left, now 4 min into the right
  const t0 = Date.now();
  await fetch(BASE + '/exec', { method: 'POST', body: JSON.stringify({ action: 'live', token: tokens[0], state: { id: 'samplefeed01', by: 'Sam', start: t0 - 13.4 * MIN, first: 'L', side: 'R', running: true, segStart: t0 - 4.2 * MIN, left: 9.2 * MIN, right: 0 } }) });
  await P.reload(); await P.waitForTimeout(1500);
  await P.click('#sheet-install [data-close]').catch(() => {});
  await P.click('[data-open="feed"]');
  await P.evaluate(() => window.scrollTo(0, 0));
  await shoot(P, 'breastfeed');
  await fetch(BASE + '/exec', { method: 'POST', body: JSON.stringify({ action: 'live', token: tokens[0], state: null }) });
  await P.reload(); await P.waitForTimeout(1500);
  await P.click('#sheet-install [data-close]').catch(() => {});
  await reset(P);

  // Stats
  await P.click('#statsBtn');
  await P.waitForTimeout(600);
  const hits = await P.$$('#chFeeds rect.hit');
  await hits[hits.length - 2].click();
  await shoot(P, 'stats');
  await reset(P);

  // Bottle in mL from a syringe
  await P.click('[data-open="bottle"]');
  await P.click('#unitMl');
  await P.click('#amtChips .chip[data-amt="10"]');
  await P.click('#amtPlus'); await P.click('#amtPlus');
  await P.click('[data-source="breast"]');
  await shoot(P, 'bottle');
  await reset(P);

  // Pump
  await P.click('[data-open="pump"]');
  await P.click('[data-pside="B"]');
  await P.click('[data-pmin="20"]');
  await P.click('#pUnitOz');
  await P.fill('#pAmtL', '2.25'); await P.fill('#pAmtR', '1.75');
  await P.fill('#pumpLabel', 'Freezer bag 14');
  await P.click('#pumpLabel');
  await P.evaluate(() => document.activeElement.blur());
  await P.evaluate(() => { document.querySelector('#sheet-pump').scrollTop = 0; });
  await shoot(P, 'pump');
  await reset(P);

  // Sleep: the shared wake-up screen
  await P.click('#liveSleep');
  await shoot(P, 'sleep');
  await reset(P);

  // Weight: today's weigh-in
  await P.click('[data-open="weight"]');
  await P.click('#wOzPlus'); await P.click('#wOzPlus');
  await P.evaluate(() => window.scrollTo(0, 0));
  await shoot(P, 'weight');
  await reset(P);

  // Stats: sleep and weight charts
  await P.click('#statsBtn');
  await P.waitForTimeout(600);
  await P.evaluate(() => { const s = document.getElementById('sheet-stats'); const c = document.getElementById('chSleep').closest('.st-card'); s.scrollTop += c.getBoundingClientRect().top - s.getBoundingClientRect().top - 14; });
  await shoot(P, 'stats-sleep-weight');
  await reset(P);

  // Health: a medicine with a reminder
  await P.click('[data-open="health"]');
  await P.click('#hChips .chip:has-text("Vitamin D")');
  await P.evaluate(() => window.scrollTo(0, 0));
  await shoot(P, 'health');
  await reset(P);

  // Activity
  await P.click('[data-open="activity"]');
  await P.click('#aChips .chip:has-text("Tummy time")');
  await P.click('#aMinChips .chip[data-m="10"]');
  await P.evaluate(() => window.scrollTo(0, 0));
  await shoot(P, 'activity');
  await reset(P);

  // Editing an entry from the timeline
  await P.click('#timeline .item:has-text("Bottle")');
  await P.click('#timeline .edit-entry');
  await P.waitForTimeout(300);
  await P.evaluate(() => window.scrollTo(0, 0));
  await shoot(P, 'edit');
  await reset(P);

  // People / invites
  await P.click('#meBtn');
  await P.waitForTimeout(900);
  await shoot(P, 'people');
  await reset(P);
  await ctx.storageState({ path: OUT + '/../state.json' });
  await ctx.close();

  // Dark mode home (night feeds)
  const ctxD = await b.newContext({ ...phone, colorScheme: 'dark', serviceWorkers: 'block' });
  const D = await ctxD.newPage();
  await D.goto(BASE + '/');
  const st = JSON.parse(fs.readFileSync(OUT + '/../state.json'));
  await D.evaluate(ls => ls.forEach(x => localStorage.setItem(x.name, x.value)), st.origins[0].localStorage);
  await D.reload(); await D.waitForTimeout(1600);
  await shoot(D, 'home-dark');
  await ctxD.close();

  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
