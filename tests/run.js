// Runs every tests/*.test.js against a fresh test server (tests/mock-server.js) and reports.
//   npm test                    all suites
//   npm test -- sleep race      only suites whose file name contains one of these words
// Uses Playwright's Chromium (npx playwright install chromium), or CHROMIUM_PATH if set.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const only = process.argv.slice(2);
const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js'))
  .filter(f => !only.length || only.some(w => f.includes(w))).sort();
const OWN_SERVER = ['offline.test.js'];   // starts its own server

function waitFor(proc, text, ms) {
  return new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error('server did not start: ' + out)), ms);
    proc.stdout.on('data', d => { out += d; if (out.includes(text)) { clearTimeout(t); resolve(); } });
    proc.on('exit', c => { clearTimeout(t); reject(new Error('server exited ' + c + ': ' + out)); });
  });
}

(async () => {
  const results = [];
  let port = 9100 + Math.floor(Math.random() * 400);
  for (const f of files) {
    port += 2;
    let server = null;
    if (!OWN_SERVER.includes(f)) {
      server = spawn(process.execPath, [path.join(__dirname, 'mock-server.js'), ROOT, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
      server.stderr.on('data', d => process.stderr.write('[server] ' + d));
      await waitFor(server, 'mock on', 10000);
    }
    const started = Date.now();
    const code = await new Promise(resolve => {
      const p = spawn(process.execPath, [path.join(__dirname, f), ROOT], { env: Object.assign({}, process.env, { PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      p.stdout.on('data', d => { out += d; });
      p.stderr.on('data', d => { out += d; });
      p.on('exit', c => {
        const lines = out.split('\n');
        const fails = lines.filter(l => /^FAIL|PAGEERROR|Error/.test(l));
        const passes = lines.filter(l => /^PASS/.test(l)).length;
        console.log((c === 0 ? 'ok   ' : 'FAIL ') + f + '  ' + passes + ' checks passed, ' + ((Date.now() - started) / 1000).toFixed(0) + 's');
        if (c !== 0) console.log(fails.slice(0, 20).map(l => '     ' + l).join('\n') || out.slice(-2000));
        resolve(c);
      });
    });
    if (server) server.kill();
    results.push(code);
  }
  const bad = results.filter(c => c !== 0).length;
  console.log(bad ? bad + ' of ' + results.length + ' suites failed' : 'All ' + results.length + ' suites passed');
  process.exit(bad ? 1 : 0);
})();
