// The app keeps opening when the host returns a 5xx error page, and opens from the saved copy
// within a few seconds when the network is very slow.
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const DIR = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const PORT = Number(process.env.PORT || 8931);
let mode = 'ok';   // ok | fail (503 error page) | slow (answers after 20 s)
let nextVersion = false;   // serve a sw.js with a new cache name, as a release does
let failures = 0;
const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failures++; };
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = (req, res) => {
  if (mode === 'fail') { res.writeHead(503, { 'Content-Type': 'text/html' }); res.end('<h1>Unicorn: We\'re having a really bad day.</h1>'); return; }
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(DIR, p);
  if (!f.startsWith(DIR) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  if (nextVersion && p === '/sw.js') { res.end(fs.readFileSync(f, 'utf8').replace(/const CACHE = '[^']+'/, "const CACHE = 'babylog-next'")); return; }
  fs.createReadStream(f).pipe(res);
};
const srv = http.createServer((req, res) => {
  if (mode === 'slow') { setTimeout(() => serve(req, res), 20000); return; }
  serve(req, res);
}).listen(PORT, async () => {
  const b = await chromium.launch((process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}));
  const P = await (await b.newContext()).newPage();
  await P.goto('http://localhost:' + PORT + '/');
  await P.evaluate(() => navigator.serviceWorker.ready);
  await P.reload(); await P.waitForTimeout(800);   // now controlled by the worker, cache filled

  mode = 'fail';
  await P.reload(); await P.waitForTimeout(800);
  const t1 = await P.title(), body1 = await P.textContent('body');
  await P.reload(); await P.waitForTimeout(800);    // and again: the error page must not have replaced the good copy
  const t2 = await P.title(), body2 = await P.textContent('body');
  check(t1 === 'Baby Log' && t2 === 'Baby Log' && !/Unicorn/.test(body1 + body2), 'app still opens during a host outage');

  mode = 'slow';
  const start = Date.now();
  await P.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
  const took = Date.now() - start;
  check((await P.title()) === 'Baby Log' && took < 3000, 'on a very slow network it still opens at once from the saved copy (' + (took / 1000).toFixed(1) + ' s)');

  // A new release: the phone saves it in the background and the app reloads itself onto it
  mode = 'ok'; nextVersion = true;
  await P.reload(); await P.waitForTimeout(800);
  let loads = 0; P.on('load', () => loads++);
  await P.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r.update()));
  for (let i = 0; i < 40 && !loads; i++) await P.waitForTimeout(250);
  const keys = await P.evaluate(() => caches.keys());
  check(loads >= 1 && keys.includes('babylog-next') && keys.length === 1, 'a new version installs, replaces the old saved copy and the app reloads onto it (' + keys.join(', ') + ')');
  await b.close(); srv.close();
  console.log(failures ? failures + ' FAILED' : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
});
