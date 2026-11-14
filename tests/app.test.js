const { chromium, devices } = require('playwright');
const BASE = 'http://localhost:' + (process.env.PORT || 8787);
const OUT = __dirname + '/shots';
require('fs').mkdirSync(OUT, { recursive: true });

const state = async () => (await fetch(BASE + '/__state')).json();
const logRows = async () => (await state()).Log.slice(1).filter(r => r.some(v => v !== '' && v != null));
let failures = 0;
const check = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };

(async () => {
  const browser = await chromium.launch((process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}));
  const phone = { ...devices['iPhone 13'], defaultBrowserType: undefined };
  delete phone.defaultBrowserType;

  const ownerLink = (await (await fetch(BASE + '/__invite')).text()).match(/#invite=([a-f0-9]+)/)[1];

  // ---------- Owner joins ----------
  const ctxA = await browser.newContext({ ...phone, colorScheme: 'light', serviceWorkers: 'block' });
  const A = await ctxA.newPage();
  A.on('pageerror', e => { console.log('PAGEERROR A', e.message); failures++; });
  await A.goto(BASE + '/#invite=' + ownerLink);
  await A.waitForSelector('#joinName');
  check(!(await A.url()).includes('invite='), 'invite code removed from the address bar');
  await A.screenshot({ path: OUT + '/1-join.png' });
  await A.click('text=Join Baby Log');
  await A.waitForSelector('#screen-home:not([hidden])');
  await A.waitForTimeout(1200);
  await A.screenshot({ path: OUT + '/2-after-join.png' });
  await A.click('#sheet-install [data-close]').catch(() => {});
  await A.waitForTimeout(400);

  // Diaper
  await A.click('[data-open="diaper"]');
  await A.click('[data-kind="both"]');
  await A.click('#diaperSave');
  // Bottle 3 oz, 30m ago
  await A.click('[data-open="bottle"]');
  check(await A.isDisabled('#bottleSave'), 'bottle cannot be saved until milk is chosen');
  await A.click('#amtChips .chip[data-amt="3"]');
  await A.click('[data-source="breast"]');
  await A.click('#sheet-bottle .chip[data-m="30"]');
  await A.click('#bottleSave');
  // Manual breastfeed: start right, L 8, R 12
  await A.click('[data-open="feed"]');
  await A.click('#modeManual');
  await A.click('[data-first="R"]');
  for (let i = 0; i < 2; i++) await A.click('[data-step="L"][data-d="-1"]');
  for (let i = 0; i < 2; i++) await A.click('[data-step="R"][data-d="1"]');
  await A.click('#manualSave');
  await A.waitForTimeout(2500);

  let rows = await logRows();
  check(rows.length === 3, 'three rows in the Log tab (got ' + rows.length + ')');
  const bf = rows.find(r => r[1] === 'Breastfeed');
  check(bf && bf[2] === 8 && bf[3] === 12 && bf[5] === 'Right' && bf[6] === 'Left', 'breastfeed row has L 8, R 12, started right, ended left');
  check(bf && bf[8] === 'Devin' && /^[0-9a-f-]{36}$/.test(bf[11]), 'row records who logged it and an ID');
  check(rows.some(r => r[1] === 'Bottle' && r[4] === 3 && r[12] === 3 && r[13] === 'oz' && r[14] === 'Breast milk'), 'oz bottle row: 3 oz, breast milk');
  check(rows.some(r => r[1] === 'Wet + dirty diaper'), 'diaper row has the right event name');
  const bottleRow = rows.find(r => r[1] === 'Bottle');
  check(bottleRow && Math.abs((Date.now() - new Date(bottleRow[0]).getTime()) / 60000 - 30) < 2, 'bottle time is about 30 minutes ago');
  check((await A.textContent('#syncText')).trim() === 'Saved', 'sync pill says Saved');

  // Syringe in mL: 5 mL chip, + twice -> 5.2, hold + to speed up, then type 2.4 exactly
  await A.click('[data-open="bottle"]');
  check(await A.isEnabled('#bottleSave'), 'milk choice is remembered on this phone');
  await A.click('#unitMl');
  await A.click('#amtChips .chip[data-amt="5"]');
  await A.click('#amtPlus'); await A.click('#amtPlus');
  check((await A.inputValue('#amtInput')) === '5.2', 'mL steps by 0.1 (got ' + (await A.inputValue('#amtInput')) + ')');
  const box = await A.locator('#amtPlus').boundingBox();
  await A.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await A.mouse.down(); await A.waitForTimeout(1500); await A.mouse.up();
  const held = parseFloat(await A.inputValue('#amtInput'));
  check(held >= 6, 'holding + repeats (reached ' + held + ' mL)');
  await A.fill('#amtInput', '2.4');
  await A.click('[data-source="formula"]');
  await A.click('#sheet-bottle .add-note');
  await A.fill('#note-bottle', 'Took it slowly with the syringe');
  await A.screenshot({ path: OUT + '/10-bottle-ml.png' });
  await A.click('#bottleSave');
  await A.waitForTimeout(1500);
  rows = await logRows();
  const ml = rows.find(r => r[13] === 'mL');
  check(ml && ml[12] === 2.4 && ml[4] === 0.08 && ml[14] === 'Formula', 'mL row: amount 2.4 mL, 0.08 oz, formula (got ' + (ml && [ml[12], ml[4], ml[14]]) + ')');
  check(ml && ml[10] === 'Took it slowly with the syringe', 'note saved with the bottle');
  check((await A.textContent('#tOzUnit')) === 'mL', 'today total switches to mL on this phone');
  check((await A.textContent('.item:has-text("Bottle") >> nth=0')).includes('2.4 mL'), 'timeline shows 2.4 mL');

  // Diaper with a note that looks like a formula
  await A.click('[data-open="diaper"]');
  await A.click('[data-kind="wet"]');
  await A.click('#sheet-diaper .add-note');
  await A.fill('#note-diaper', '=SUM(1,1) rash cream');
  await A.click('#diaperSave');
  await A.waitForTimeout(1500);
  rows = await logRows();
  check(rows.some(r => r[1] === 'Wet diaper' && r[10] === "'=SUM(1,1) rash cream"), 'a note starting with = is stored as plain text');

  // Edit a note on an existing entry
  await A.click('.item:has-text("Wet diaper") >> nth=0');
  await A.click('text=Edit note');
  await A.waitForTimeout(150);
  await A.fill('#edit-note', 'Rash cream applied');
  await A.screenshot({ path: OUT + '/11-edit-note.png' });
  await A.click('text=Save note');
  await A.waitForTimeout(1500);
  rows = await logRows();
  if (!rows.some(r => r[1] === 'Wet diaper' && r[10] === 'Rash cream applied')) console.log('DEBUG', await A.evaluate(() => localStorage.getItem('bl.outbox')), await A.textContent('#syncText'));
  check(rows.some(r => r[1] === 'Wet diaper' && r[10] === 'Rash cream applied'), 'editing a note updates the sheet');
  check((await A.textContent('#timeline')).includes('Rash cream applied'), 'note shows in the timeline');
  // remove those two so the later counts stay the same
  for (const name of ['Wet diaper', 'Bottle']) {
    await A.click('.item:has-text("' + name + '") >> nth=0');
    await A.click('.item-tools .del');
    await A.waitForTimeout(1200);
  }

  // Timer feed: left a moment, switch to right, save
  await A.click('[data-open="feed"]');
  await A.click('#modeTimer');
  await A.click('#sideL');
  // the manual feed ended minutes ago, so the timer adds to it unless told this is a new feed
  check(!(await A.isHidden('#contNote')), 'the timer offers to continue the feed that just ended');
  await A.click('#feedNew');
  await A.waitForTimeout(21000);
  await A.click('#sideR');
  await A.waitForTimeout(800);
  check(await A.isVisible('#live'), 'live feed banner shows while timing');
  await A.screenshot({ path: OUT + '/3-timer.png' });
  await A.click('#feedDone');
  await A.waitForTimeout(1500);
  rows = await logRows();
  check(rows.length === 4, 'timer feed saved (4 rows)');
  const tf = rows.find(r => r[1] === 'Breastfeed' && r[2] === 1);
  check(tf && tf[3] === 0 && tf[5] === 'Left' && tf[6] === 'Left', 'short right side is dropped, left counts as 1 min');

  await A.screenshot({ path: OUT + '/4-home.png', fullPage: true });

  // Delete the diaper entry and undo-safety
  await A.click('.item:has-text("Wet + dirty diaper")');
  await A.click('.item-tools .del');
  await A.waitForTimeout(1500);
  rows = await logRows();
  check(!rows.some(r => r[1] === 'Wet + dirty diaper'), 'delete removes the row from the sheet');
  await A.click('#toastUndo');
  await A.waitForTimeout(1500);
  rows = await logRows();
  check(rows.some(r => r[1] === 'Wet + dirty diaper'), 'undo puts it back');

  // ---------- Invite the night nurse ----------
  await A.click('#meBtn');
  await A.waitForTimeout(800);
  await A.click('text=Invite someone');
  await A.fill('#inviteName', 'Night nurse');
  await A.click('text=Create invite link');
  await A.waitForSelector('.linkbox');
  const link = await A.textContent('.linkbox');
  check(/#invite=[a-f0-9]{32}$/.test(link), 'invite link created');
  await A.screenshot({ path: OUT + '/5-invite.png' });
  const nurseCode = link.split('#invite=')[1];

  const ctxB = await browser.newContext({ ...devices['Pixel 7'], colorScheme: 'dark', serviceWorkers: 'block' });
  const B = await ctxB.newPage();
  B.on('pageerror', e => { console.log('PAGEERROR B', e.message); failures++; });
  await B.goto(BASE + '/#invite=' + nurseCode);
  await B.waitForSelector('#joinName');
  check((await B.inputValue('#joinName')) === 'Night nurse', 'invite name is prefilled');
  await B.fill('#joinName', 'Maria');
  await B.click('text=Join Baby Log');
  await B.waitForSelector('#screen-home:not([hidden])');
  await B.waitForTimeout(1500);
  await B.click('#sheet-install [data-close]').catch(() => {});
  await B.waitForTimeout(400);
  check((await B.locator('.item').count()) === 4, 'nurse sees the same 4 entries');
  await B.click('[data-open="diaper"]');
  await B.click('[data-kind="wet"]');
  await B.click('#diaperSave');
  await B.waitForTimeout(1500);
  rows = await logRows();
  check(rows.some(r => r[1] === 'Wet diaper' && r[8] === 'Maria'), "nurse's entry is stamped with her name");
  await B.screenshot({ path: OUT + '/6-nurse-dark.png', fullPage: true });

  // Reusing the invite fails
  const ctxC = await browser.newContext({ ...phone, serviceWorkers: 'block' });
  const C = await ctxC.newPage();
  await C.goto(BASE + '/#invite=' + nurseCode);
  await C.waitForSelector('text=This invite cannot be used');
  check(true, 'a used invite link is refused');
  await C.screenshot({ path: OUT + '/7-used-invite.png' });

  // Members cannot manage people
  await B.click('#meBtn');
  await B.waitForTimeout(500);
  check(!(await B.isVisible('text=Invite someone')), 'nurse does not see Invite someone');
  await B.click('#sheet-settings [data-close]');

  // ---------- Owner removes the nurse ----------
  await A.click('#sheet-settings >> text=Done');
  await A.waitForTimeout(1200);
  await A.screenshot({ path: OUT + '/8-people.png' });
  await A.click('.person:has-text("Maria") >> text=Remove');
  await A.click('text=Remove Maria');
  await A.waitForTimeout(1200);
  const st = await state();
  check(st.Devices.some(r => r[0] === 'Maria' && r[2] === 'Revoked'), 'Devices tab shows Maria as Revoked');
  check(!JSON.stringify(st).includes(nurseCode), 'the raw invite code is not stored anywhere');

  await B.reload();
  await B.waitForSelector('text=This phone no longer has access');
  check(true, 'removed phone is locked out');
  check(await B.evaluate(() => localStorage.getItem('bl.entries') === null), 'removed phone clears its cached entries');

  // ---------- Offline queue ----------
  await ctxA.setOffline(true);
  await A.click('#sheet-settings [data-close]').catch(() => {});
  await A.click('[data-open="diaper"]');
  await A.click('[data-kind="dirty"]');
  await A.click('#diaperSave');
  await A.waitForTimeout(800);
  check((await A.textContent('#syncText')).includes('waiting'), 'offline entry waits: ' + (await A.textContent('#syncText')));
  await ctxA.setOffline(false);
  await A.evaluate(() => window.dispatchEvent(new Event('online')));
  await A.waitForTimeout(2000);
  rows = await logRows();
  check(rows.some(r => r[1] === 'Dirty diaper'), 'queued entry reaches the sheet once back online');

  // Setup code (iOS Home Screen hand-off)
  const pair = await A.evaluate(async () => {
    const auth = JSON.parse(localStorage.getItem('bl.auth'));
    const r = await fetch(window.BABYLOG_CONFIG.apiUrl, { method: 'POST', body: JSON.stringify({ action: 'pair', token: auth.token }) });
    return r.json();
  });
  check(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(pair.code), 'setup code issued: ' + pair.code);
  const ctxD = await browser.newContext({ ...phone, serviceWorkers: 'block' });
  const D = await ctxD.newPage();
  await D.goto(BASE + '/');
  await D.fill('#setupCode', pair.code.toLowerCase());
  await D.click('#joinBody >> text=Continue');
  await D.waitForSelector('#screen-home:not([hidden])');
  check(true, 'setup code signs in a second app on the same phone');
  await D.screenshot({ path: OUT + '/9-welcome-code.png' });

  // ---------- Pump ----------
  const feedsBefore = await A.textContent('#tFeeds');
  await A.click('#sheet-install [data-close]').catch(() => {});
  await A.click('[data-open="pump"]');
  check(await A.isDisabled('#pumpSave'), 'pump cannot be saved until a side is chosen');
  await A.click('[data-pside="B"]');
  await A.click('[data-pmin="20"]');
  await A.click('#pumpPlus'); await A.click('#pumpPlus');
  check((await A.textContent('#pumpVal')) === '22', 'pump minutes step by 1');
  check(await A.isVisible('#pAmtRowL') && await A.isVisible('#pAmtRowR'), 'both amount rows show for Both');
  await A.click('#pUnitOz');
  for (let i = 0; i < 4; i++) await A.click('#pAmtLPlus');
  check((await A.inputValue('#pAmtL')) === '1', 'left amount steps by 0.25 oz (got ' + (await A.inputValue('#pAmtL')) + ')');
  await A.fill('#pAmtR', '1.5');
  check((await A.textContent('#pAmtTotal')) === 'Total 2.5 oz', 'total shows ' + (await A.textContent('#pAmtTotal')));
  await A.fill('#pumpLabel', 'Bag 3 Oct 25');
  await A.click('#sheet-pump .add-note');
  await A.fill('#note-pump', 'Froze it');
  await A.screenshot({ path: OUT + '/12-pump.png' });
  await A.click('#pumpSave');
  await A.waitForTimeout(1500);
  rows = await logRows();
  const pr = rows.find(r => r[1] === 'Pump');
  check(pr && pr[15] === 'Both' && pr[16] === 22 && pr[17] === 'Bag 3 Oct 25' && pr[10] === 'Froze it', 'pump row: both sides, 22 min, label and note (got ' + (pr && [pr[15], pr[16], pr[17], pr[10]]) + ')');
  check(pr && pr[2] === '' && pr[3] === '', 'pump minutes stay out of the breastfeed minute columns');
  check(pr && pr[18] === 1 && pr[19] === 1.5 && pr[20] === 'oz' && pr[21] === 2.5, 'pump amounts: L 1, R 1.5 oz, total 2.5 (got ' + (pr && pr.slice(18, 22)) + ')');
  check(pr && Math.abs((new Date(pr[7]) - new Date(pr[0])) / 60000 - 22) < 0.1, 'pump end time is start plus 22 min');
  check(pr && Math.abs((Date.now() - new Date(pr[0]).getTime()) / 60000) < 2, 'pump time is now');
  check((await A.textContent('#lastEmptySub')).startsWith('Pump, both sides, 22 min, 2.5 oz'), 'top card shows the last pump: ' + (await A.textContent('#lastEmptySub')));
  check((await A.textContent('#tFeeds')) === feedsBefore, 'pumps are not counted as feeds');
  check((await A.textContent('#timeline')).includes('Both sides · 22 min · L 1 oz, R 1.5 oz · Bag 3 Oct 25'), 'timeline shows the pump with its label');
  // a breastfeed logged now becomes the most recent
  await A.click('[data-open="feed"]');
  await A.click('#modeManual');
  await A.click('#manualPane .chip[data-m="0"]');
  await A.click('#manualSave');
  await A.waitForTimeout(300);
  check((await A.textContent('#toastMsg')).startsWith('Added to the'), 'a feed right after another is added to it');
  await A.click('#toastUndo');   // Keep separate
  await A.waitForTimeout(1200);
  check((await A.textContent('#lastEmptySub')).startsWith('Breastfeed:'), 'top card switches to the newer breastfeed');
  // the pump screen remembers the last side and duration
  await A.click('[data-open="pump"]');
  check((await A.getAttribute('[data-pside="B"]', 'aria-pressed')) === 'true' && (await A.textContent('#pumpVal')) === '22', 'pump remembers side and minutes');
  await A.click('#sheet-pump [data-close]');
  await A.waitForTimeout(400);
  await A.evaluate(() => window.scrollTo(0, 0));
  await A.screenshot({ path: OUT + '/13-home-pump.png' });
  // Left only, typed in mL; then a pump with no amount at all
  await A.click('[data-open="pump"]');
  await A.click('[data-pside="L"]');
  check(await A.isHidden('#pAmtRowR'), 'right amount hides for a left-only pump');
  await A.click('#pUnitMl');
  await A.fill('#pAmtL', '60');
  await A.click('#pumpSave');
  await A.waitForTimeout(1200);
  await A.click('[data-open="pump"]');
  await A.click('[data-pside="R"]');
  check((await A.inputValue('#pAmtR')) === '', 'amounts start blank each time');
  await A.click('#pumpSave');
  await A.waitForTimeout(1500);
  rows = await logRows();
  const pumps = rows.filter(r => r[1] === 'Pump');
  const mlP = pumps.find(r => r[15] === 'Left');
  check(mlP && mlP[18] === 60 && (mlP[19] === '' || mlP[19] == null) && mlP[20] === 'mL' && mlP[21] === 2.03, 'left-only mL pump: 60 mL = 2.03 oz (got ' + (mlP && mlP.slice(18, 22)) + ')');
  const noAmt = pumps.find(r => r[15] === 'Right');
  check(noAmt && !noAmt[18] && !noAmt[19] && !noAmt[20] && !noAmt[21], 'a pump with no amounts leaves the amount columns empty');
  check((await A.textContent('#timeline')).includes('Left · 22 min · 60 mL'), 'timeline shows 60 mL for the left-only pump');

  // a pump row typed by hand in the sheet shows up in the app
  await D.reload(); await D.waitForTimeout(1500);
  check((await D.textContent('#timeline')).includes('Pump'), 'other phones see the pump');

  // Bad token is refused by the API
  const bad = await (await fetch(BASE + '/exec', { method: 'POST', body: JSON.stringify({ action: 'list', token: 'x'.repeat(64) }) })).json();
  check(bad.ok === false && bad.error === 'unauthorized', 'requests without a valid key are refused');

  await browser.close();
  console.log(failures ? failures + ' FAILURES' : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
