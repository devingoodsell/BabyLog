// One tab per kind of entry: what each row holds, hand edits, voice doubles, time order, continuing a
// breastfeed, and the one-time migration from the old single Log tab (last, since it starts over).
const { chromium, devices } = require('playwright');
const BASE = 'http://localhost:' + process.env.PORT;
const MIN = 60000;
const state = async () => (await fetch(BASE + '/__state')).json();
const post = async b => (await fetch(BASE + '/exec', { method: 'POST', body: JSON.stringify(b) })).json();
let failures = 0;
const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failures++; };
// A tab's rows as objects keyed by header
const tab = async name => { const t = (await state())[name] || []; const h = t[0] || []; return t.slice(1).filter(r => r.some(v => v !== '' && v != null)).map(r => Object.fromEntries(h.map((k, i) => [k, r[i] === undefined ? '' : r[i]]))); };
const ms = v => new Date(v).getTime();

(async () => {
  const code = (await (await fetch(BASE + '/__invite')).text()).match(/#invite=([a-f0-9]+)/)[1];
  const red = await post({ action: 'redeem', code, name: 'Devin' });
  const token = red.token;
  const gh = await post({ action: 'invite', token, name: 'Google Home', role: 'member' });
  const voice = (await post({ action: 'redeem', code: gh.code, name: 'Google Home' })).token;
  let n = 0;
  const id = p => (p || 'tabtest') + String(++n).padStart(4, '0');
  const add = (e, tok) => post({ action: 'add', token: tok || token, entry: Object.assign({ id: id() }, e) });
  const now = Date.now();

  // ---------- Fresh sheet: the tabs and their columns ----------
  let st = await state();
  check(['Feeds', 'Pumps', 'Diapers', 'Sleep', 'Growth', 'Health', 'Activities', 'Timeline', 'Dashboard', 'Daily'].every(t => st[t]), 'a new sheet gets a tab per kind of entry plus Timeline, Dashboard and Daily');
  check(JSON.stringify(st.Feeds[0]) === JSON.stringify(['Time', 'Type', 'Left min', 'Right min', 'First side', 'Last side', 'End', 'Ounces', 'Milk', 'As entered', 'Notes', 'Logged by', 'Logged at', 'Updated at', 'ID']), 'Feeds columns');
  check(!st['Sheet1'] && !st.Log || (st.Log && st.Feeds), 'the blank first sheet became a tab');

  // ---------- Each value stored once ----------
  await add({ type: 'bottle', t: now - 50 * MIN, amount: 60, unit: 'ml', source: 'breast' });
  await add({ type: 'bottle', t: now - 49 * MIN, amount: 2.25, unit: 'oz', source: 'formula' });
  await add({ type: 'pump', t: now - 48 * MIN, side: 'B', minutes: 15, leftAmt: 30, rightAmt: 25, pumpUnit: 'ml', label: 'Fridge' });
  await add({ type: 'weight', t: now - 47 * MIN, weightOz: 3.45 * 35.27396, weightUnit: 'kg' });
  await add({ type: 'length', t: now - 46 * MIN, lengthIn: 52 / 2.54, lengthUnit: 'cm' });
  await add({ type: 'health', kind: 'temp', t: now - 45 * MIN, tempF: 38.2 * 1.8 + 32, tempUnit: 'C' });
  await add({ type: 'diaper', t: now - 44 * MIN, kind: 'both' });
  await add({ type: 'sleep', t: now - 43 * MIN });
  let feeds = await tab('Feeds');
  const ml = feeds.find(r => r['As entered'] === '60 mL');
  check(ml && ml.Ounces === 2.03 && ml.Type === 'Bottle' && ml.Milk === 'Breast milk', 'a 60 mL bottle: Ounces 2.03, As entered "60 mL", nothing repeated');
  check(feeds.some(r => r.Ounces === 2.25 && r['As entered'] === ''), 'an ounce bottle has no "As entered" (the ounces are what was typed)');
  const pumps = await tab('Pumps');
  check(pumps[0] && pumps[0]['Left oz'] === 1.01 && pumps[0]['Right oz'] === 0.85 && pumps[0]['As entered'] === 'L 30 mL, R 25 mL' && !('Pumped oz' in pumps[0]), 'a pump stores left and right ounces once (no total column), mL as entered');
  const growth = await tab('Growth');
  check(growth.some(r => r.Measure === 'Weight' && r.Pounds === 7 && r.Ounces === 9.7 && r['As entered'] === '3.45 kg'), 'weight: 7 lb 9.7 oz, entered as 3.45 kg');
  check(growth.some(r => r.Measure === 'Length' && r.Inches === 20.47 && r['As entered'] === '52 cm'), 'length: 20.47 in, entered as 52 cm');
  check((await tab('Health')).some(r => r.Type === 'Temperature' && r['Temp °F'] === 100.8 && r['As entered'] === '38.2 °C'), 'temperature: 100.8 °F, entered as 38.2 °C');
  check((await tab('Diapers')).some(r => r.Kind === 'Wet + dirty'), 'diaper kind');
  check((await tab('Sleep')).some(r => r['Woke up'] === ''), 'an open sleep has no wake-up yet');

  // what the app gets back
  let list = await post({ action: 'list', token });
  const back = t => list.entries.find(e => e.type === t);
  check(back('bottle') && list.entries.some(e => e.type === 'bottle' && e.unit === 'ml' && e.amount === 60), 'the app gets the mL bottle back as 60 mL');
  check(back('pump').pumpUnit === 'ml' && back('pump').leftAmt === 30 && back('pump').rightAmt === 25 && back('pump').pumpedOz === 1.86, 'the app gets the pump back in mL with the total');
  check(back('weight').weightUnit === 'kg' && back('length').lengthUnit === 'cm' && back('health').tempUnit === 'C', 'units come back as entered');

  // ---------- A hand edit in the sheet wins ----------
  await fetch(BASE + '/__edit?tab=Feeds&id=' + ml.ID + '&col=Ounces&value=2.5');
  list = await post({ action: 'list', token });
  const edited = list.entries.find(e => e.id === ml.ID);
  check(edited && edited.oz === 2.5 && edited.unit === 'oz' && edited.amount === 2.5, 'changing Ounces by hand: the app shows 2.5 oz, not the stale 60 mL');

  // ---------- Time order ----------
  await add({ type: 'diaper', t: now - 3 * 60 * MIN, kind: 'wet' });
  const diapers = await tab('Diapers');
  check(diapers.length === 2 && ms(diapers[0].Time) < ms(diapers[1].Time), 'an entry logged late is moved into time order');

  // ---------- Voice doubles ----------
  const v1 = await add({ type: 'bottle', t: now - 2 * MIN, oz: 1, amount: 1, unit: 'oz', source: 'breast', id: 'gh-' + 'a'.repeat(32) }, voice);
  const v2 = await add({ type: 'bottle', t: now - 2 * MIN + 9000, oz: 1, amount: 1, unit: 'oz', source: 'breast', id: 'gh-' + 'b'.repeat(32) }, voice);
  const v3 = await add({ type: 'bottle', t: now - 2 * MIN + 12000, oz: 1, amount: 1, unit: 'oz', source: 'formula', id: 'gh-' + 'c'.repeat(32) }, voice);
  feeds = await tab('Feeds');
  check(v1.ok && v2.ok && v2.duplicate && feeds.filter(r => /^gh-/.test(r.ID)).length === 2, 'two speakers logging the same voice command 9 s apart: kept once; formula after breast milk is kept');
  const p1 = await add({ type: 'diaper', t: now - MIN, kind: 'wet' });
  const p2 = await add({ type: 'diaper', t: now - MIN + 5000, kind: 'wet' });
  check(p1.ok && p2.ok && !p2.duplicate, 'the same entry twice from a phone is not treated as a voice double');

  // ---------- Edit, delete, note across tabs ----------
  const sl = (await tab('Sleep'))[0];
  const ended = await post({ action: 'endSleep', token, id: sl.ID, end: now - 10 * MIN });
  check(ended.ok && ended.minutes === 33 && ms((await tab('Sleep'))[0]['Woke up']) === now - 10 * MIN, 'ending a sleep fills Woke up');
  const note = await post({ action: 'update', token, id: back('pump').id, note: 'left was slow' });
  check(note.ok && (await tab('Pumps'))[0].Notes === 'left was slow', 'a note lands on the right tab');
  const before = (await tab('Feeds')).length;
  const del = await post({ action: 'delete', token, id: back('pump').id });
  check(del.ok && (await tab('Pumps')).length === 0 && (await tab('Feeds')).length === before, 'deleting removes only that row');
  const bf = await add({ type: 'breast', t: now - 30 * MIN, left: 10, right: 5, first: 'L', last: 'R' });
  const edit = await post({ action: 'edit', token, entry: { id: bf.entry.id, type: 'breast', t: now - 30 * MIN, left: 12, right: 5, first: 'L', last: 'R', end: now - 5 * MIN } });
  const bRow = (await tab('Feeds')).find(r => r.ID === bf.entry.id);
  check(edit.ok && bRow['Left min'] === 12 && ms(bRow.End) === now - 5 * MIN && bRow['Logged by'] === 'Devin', 'editing a breastfeed keeps who logged it and stores when it ended (pauses included)');

  // ---------- Continuing a breastfeed in the app ----------
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const phone = { ...devices['iPhone 13'] }; delete phone.defaultBrowserType;
  const ctx = await browser.newContext({ ...phone, serviceWorkers: 'block' });
  await ctx.addInitScript(([t]) => { if (!localStorage.getItem('bl.auth')) localStorage.setItem('bl.auth', JSON.stringify(t)); }, [{ token, name: 'Devin', role: 'admin', deviceId: red.me.deviceId }]);
  const P = await ctx.newPage();
  P.on('pageerror', e => { console.log('PAGEERROR', e.message); failures++; });
  await P.goto(BASE + '/'); await P.waitForSelector('#screen-home:not([hidden])'); await P.waitForTimeout(1500);
  await P.click('#sheet-install [data-close]').catch(() => {});
  const settle = () => P.waitForFunction(() => JSON.parse(localStorage.getItem('bl.outbox') || '[]').length === 0, null, { timeout: 10000 }).catch(() => {});
  await P.click('[data-open="feed"]'); await P.waitForTimeout(300);
  check(/ended \d+m ago .*Tapping a side adds to it/.test(await P.textContent('#feedTotal')), 'the timer says a side will add to the feed that ended a few minutes ago');
  await P.click('#sideR'); await P.waitForTimeout(400);
  check(!(await P.isHidden('#contNote')) && /Adding to the/.test(await P.textContent('#contText')) && (await P.textContent('#clockL')).startsWith('12:'), 'the clocks carry on from that feed (left shows 12 minutes)');
  const live = JSON.parse((await (await fetch(BASE + '/__props')).json()).live);
  check(live.continues === true && live.id === bf.entry.id && live.baseLeft === 12 * MIN, 'other phones see a timer that continues that feed');
  await P.waitForTimeout(21000);
  await P.click('#feedDone'); await settle();
  let rows = (await tab('Feeds')).filter(r => r.Type === 'Breastfeed');
  let row = rows.find(r => r.ID === bf.entry.id);
  check(rows.length === 1 && row['Left min'] === 12 && row['Right min'] === 6 && row['Last side'] === 'Right' && Math.abs(ms(row.End) - Date.now()) < 5000, 'saving adds a minute to the same feed instead of logging a second one');
  check(!(await (await fetch(BASE + '/__props')).json()).live, 'saving a continued feed ends the shared timer');
  check((await P.textContent('#toastUndo')) === 'Keep separate', 'the toast offers "Keep separate"');
  await P.click('#toastUndo'); await settle();
  rows = (await tab('Feeds')).filter(r => r.Type === 'Breastfeed');
  row = rows.find(r => r.ID === bf.entry.id);
  check(rows.length === 2 && row['Right min'] === 5 && rows.some(r => r.ID !== bf.entry.id && r['Right min'] === 1 && r['Left min'] === 0), '"Keep separate" restores the earlier feed and saves the new minute as its own feed');

  // Enter after, within 30 minutes of the last feed: added to it
  await P.click('[data-open="feed"]'); await P.waitForTimeout(300);
  await P.click('#modeManual');
  await P.fill('#mL', '4'); await P.fill('#mR', '0'); await P.dispatchEvent('#mR', 'blur');
  await P.click('#manualSave'); await settle();
  rows = (await tab('Feeds')).filter(r => r.Type === 'Breastfeed');
  check(rows.length === 2 && rows.some(r => r['Left min'] === 16 && r['Right min'] === 5) && /Added to the/.test(await P.textContent('#toastMsg')), 'a feed entered after, starting within 30 minutes of the last one, is added to it');

  // Start a new feed instead
  await P.click('[data-open="feed"]'); await P.waitForTimeout(300);
  await P.click('#modeTimer');
  await P.click('#sideL'); await P.waitForTimeout(300);
  await P.click('#feedNew'); await P.waitForTimeout(1500);
  check(await P.isHidden('#contNote') && (await P.textContent('#clockL')).startsWith('0:'), '"Start a new feed instead" resets the clocks to this feed only');
  await P.waitForTimeout(21000);
  await P.click('#feedDone'); await settle();
  rows = (await tab('Feeds')).filter(r => r.Type === 'Breastfeed');
  check(rows.length === 3 && rows.some(r => r['Left min'] === 1 && r['Right min'] === 0), 'it is saved as a new feed');
  await browser.close();

  // ---------- Summary tabs read the entry tabs ----------
  st = await state();
  check(/'Feeds'!A2:A/.test(st.Timeline[1][0]) && /MAP\(A2:A/.test(st.Daily[1][4]) && st.Dashboard.some(r => /'Pumps'!D2:D/.test(String(r[1]))), 'Timeline, Daily and Dashboard formulas point at the new tabs');

  // ---------- A phone that synced before the update downloads everything again ----------
  const synced = (await post({ action: 'list', token })).syncedAt;
  const delta = await post({ action: 'list', token, since: synced });
  check(delta.delta === true, 'normally a phone downloads only changes');

  // ---------- Migration from the old single Log ----------
  const H = ['Time', 'Event', 'Left min', 'Right min', 'Bottle oz', 'First side', 'Last side', 'End', 'Logged by', 'Logged at', 'Notes', 'ID', 'Amount', 'Unit', 'Milk', 'Pump side', 'Pump min', 'Label', 'Left pumped', 'Right pumped', 'Pump unit', 'Pumped oz',
    'Sleep min', 'Weight lb', 'Weight', 'Detail', 'Dose', 'Temp F', 'Temp', 'Remind h', 'Length in', 'Length', 'Activity min', 'Updated at'];
  const T0 = Date.now() - 2 * 86400000;
  const iso = m => new Date(T0 + m * MIN).toISOString();
  const row_ = o => H.map(h => (h in o ? o[h] : ''));
  const bfRow = (m, l, r, f, la, who, extra) => row_(Object.assign({ Time: iso(m), Event: 'Breastfeed', 'Left min': l, 'Right min': r, 'First side': f, 'Last side': la, End: iso(m + l + r), 'Logged by': who, 'Logged at': iso(m + l + r + 1), ID: 'mig' + m }, extra || {}));
  const legacy = [
    bfRow(0, 11, 0, 'Left', 'Left', 'Allison', { Notes: 'latched well' }),   // 0-11
    bfRow(13, 3, 0, 'Left', 'Left', 'Allison'),          // 2 min gap -> same feed
    bfRow(20, 0, 23, 'Right', 'Right', 'Tess', { Notes: 'sleepy' }),   // 4 min gap -> same feed, ends 43
    bfRow(80, 8, 0, 'Left', 'Left', 'Allison'),          // 37 min gap -> new feed
    bfRow(85, 0, 10, 'Right', 'Right', 'Tess'),          // starts 3 min before the previous ended: rounding, same feed
    bfRow(200, 0, 43, 'Right', 'Right', 'Tess'),
    bfRow(201, 5, 5, 'Right', 'Left', 'Allison'),         // overlaps by 42 min: the same feed logged twice
    row_({ Time: iso(300), Event: 'Bottle', 'Bottle oz': 2.25, Amount: 2, Unit: 'oz', Milk: 'Breast milk', 'Logged by': 'Tess', ID: 'migbottle1' }),
    row_({ Time: iso(310), Event: 'Bottle', 'Bottle oz': 2.03, Amount: 60, Unit: 'mL', Milk: 'Formula', 'Logged by': 'Tess', ID: 'migbottle2' }),
    row_({ Time: iso(320), Event: 'Bottle', 'Bottle oz': 1, Amount: 1, Unit: 'oz', Milk: 'Breast milk', 'Logged by': 'Google Home', ID: 'gh-mig1' }),
    row_({ Time: new Date(T0 + 320 * MIN + 9000).toISOString(), Event: 'Bottle', 'Bottle oz': 1, Amount: 1, Unit: 'oz', Milk: 'Breast milk', 'Logged by': 'Google Home', ID: 'gh-mig2' }),
    row_({ Time: new Date(T0 + 320 * MIN + 15000).toISOString(), Event: 'Bottle', 'Bottle oz': 2, Amount: 2, Unit: 'oz', Milk: 'Formula', 'Logged by': 'Google Home', ID: 'gh-mig3' }),
    row_({ Time: iso(330), Event: 'Wet + dirty diaper', 'Logged by': 'Google Home', ID: 'gh-mig4' }),
    row_({ Time: iso(340), Event: 'Pump', 'Pump side': 'Both', 'Pump min': 15, 'Left pumped': 30, 'Right pumped': 25, 'Pump unit': 'mL', 'Pumped oz': 1.86, 'Logged by': 'Allison', ID: 'migpump1' }),
    row_({ Time: iso(350), Event: 'Sleep', End: iso(440), 'Sleep min': 90, 'Logged by': 'Tess', ID: 'migsleep1' }),
    row_({ Time: iso(460), Event: 'Sleep', 'Logged by': 'Tess', ID: 'migsleep2' }),
    row_({ Time: iso(-600), Event: 'Weight', 'Weight lb': 7.594, Weight: '7 lb 9.5 oz', 'Logged by': 'Devin', ID: 'migweight1' }),
    row_({ Time: iso(470), Event: 'Medicine', Detail: 'Vitamin D', Dose: '1 drop', 'Remind h': 24, 'Logged by': 'Allison', ID: 'migmed1' }),
    row_({ Time: iso(480), Event: 'Activity', Detail: 'Bath', 'Activity min': 10, 'Logged by': 'Allison', ID: 'migact1' }),
    row_({ Time: iso(490), Event: 'Mystery', 'Logged by': 'Devin', ID: 'migodd' }),
    row_({ Time: 'yesterday-ish', Event: 'Wet diaper', 'Logged by': 'Devin' })
  ];
  await fetch(BASE + '/__legacy', { method: 'POST', body: JSON.stringify({ rows: legacy }) });
  const notYet = await post({ action: 'list', token });
  check(notYet.ok === false && /migrateToTabs/.test(notYet.message), 'before migrating, the new script says to run migrateToTabs');
  const report = await (await fetch(BASE + '/__run?fn=migrateToTabs')).json();
  const text = report.join('\n');
  st = await state();
  check(st['Log (archive)'] && !st.Log_raw && st['Log (archive)'].length === legacy.length + 1, 'the old tab is kept, renamed "Log (archive)", untouched');
  feeds = await tab('Feeds');
  const bfs = feeds.filter(r => r.Type === 'Breastfeed');
  const f1 = bfs.find(r => r.ID === 'mig0'), f2 = bfs.find(r => r.ID === 'mig80');
  check(bfs.length === 4, '7 breastfeed rows become 4 feeds (got ' + bfs.length + ')');
  check(f1 && f1['Left min'] === 14 && f1['Right min'] === 23 && f1['First side'] === 'Left' && f1['Last side'] === 'Right' && ms(f1.End) === T0 + 43 * MIN && f1.Notes === 'latched well · sleepy' && f1['Logged by'] === 'Allison',
    'pieces 2 and 4 minutes apart join: L 14, R 23, left to right, ended at the last piece, notes kept');
  check(f2 && f2['Left min'] === 8 && f2['Right min'] === 10, 'a piece starting 37 minutes after the last ended starts a new feed; one overlapping by 3 minutes joins it');
  check(bfs.some(r => r.ID === 'mig200') && bfs.some(r => r.ID === 'mig201') && /row 8 \(Allison.*overlaps row 7 \(Tess/.test(text), 'a feed overlapping another by 42 minutes is kept separate and reported as a possible double');
  check(/7 breastfeed rows became 4 feeds/.test(text), 'the report counts the merge');
  const bottles = feeds.filter(r => r.Type === 'Bottle');
  check(bottles.find(r => r.ID === 'migbottle1').Ounces === 2.25 && /bottle amount 2 oz, but 2.25 oz/.test(text), 'a bottle fixed by hand in "Bottle oz" keeps 2.25 oz, and the report says so');
  check(bottles.find(r => r.ID === 'migbottle2')['As entered'] === '60 mL', 'an mL bottle keeps what was typed');
  check(bottles.filter(r => /^gh-/.test(r.ID)).length === 2 && !bottles.some(r => r.ID === 'gh-mig2') && /row 12 \(same as row 11/.test(text), 'a voice double 9 s apart is dropped; the formula one is kept');
  const mp = (await tab('Pumps'))[0];
  check(mp && mp['Left oz'] === 1.01 && mp['Right oz'] === 0.85 && mp['As entered'] === 'L 30 mL, R 25 mL', 'pumps move with ounces once and mL as entered');
  const sleeps = await tab('Sleep');
  check(sleeps.length === 2 && ms(sleeps[0]['Woke up']) === T0 + 440 * MIN && sleeps[1]['Woke up'] === '', 'sleeps keep their wake-up, an open one stays open');
  check((await tab('Growth'))[0].Pounds === 7 && (await tab('Growth'))[0].Ounces === 9.5, 'weight in pounds and ounces');
  check((await tab('Health'))[0]['Remind h'] === 24 && (await tab('Activities'))[0].Minutes === 10 && (await tab('Diapers')).length === 1, 'health, activities and diapers move');
  check(/rows 21, 22/.test(text), 'a row with an unknown event or no time is reported, left in the archive');
  check(st.Timeline && st.Dashboard && st.Daily && /'Feeds'!/.test(st.Timeline[1][0]), 'the summary tabs are rebuilt on the new tabs');
  const again = await (await fetch(BASE + '/__run?fn=migrateToTabs')).json();
  check(again[0] === 'already' && (await tab('Feeds')).length === feeds.length, 'running it again does nothing');
  const after = await post({ action: 'list', token, since: synced });
  check(after.ok && !after.delta && after.entries.length > 10, 'a phone that synced before the update gets everything again');
  const appBf = after.entries.find(e => e.id === 'mig0');
  check(appBf && appBf.left === 14 && appBf.right === 23 && appBf.end === T0 + 43 * MIN, 'the app gets the joined feed');

  console.log(failures ? failures + ' FAILURES' : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
