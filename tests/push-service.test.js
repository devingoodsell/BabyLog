// The cloud service's /push endpoint: Web Push encryption a phone can decrypt, VAPID signing,
// the shared secret, and "gone" for phones that unsubscribed.
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ece = require(path.join(__dirname, '..', 'google-home', 'node_modules', 'http_ece'));
let fails = 0; const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = Number(process.env.PORT) + 1500, RECV = PORT + 1;

(async () => {
  // A local "push service" over HTTPS (self-signed) that records what it receives
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'babylog-push-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', dir + '/k.pem', '-out', dir + '/c.pem', '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const got = [];
  const recv = https.createServer({ key: fs.readFileSync(dir + '/k.pem'), cert: fs.readFileSync(dir + '/c.pem') }, (req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => { got.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) }); res.writeHead(req.url.includes('gone') ? 410 : 201); res.end(); });
  }).listen(RECV);

  // The phone's side of a subscription
  const phone = crypto.createECDH('prime256v1'); phone.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = endpoint => ({ endpoint, keys: { p256dh: phone.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } });

  // VAPID keys as deploy.sh makes them
  const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const j = kp.privateKey.export({ format: 'jwk' });
  const vapidPublic = Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]).toString('base64url');
  const secret = crypto.randomBytes(32).toString('hex');
  const env = Object.assign({}, process.env, { PORT: String(PORT), CLIENT_ID: 'c', CLIENT_SECRET: 's', SIGNING_KEY: 'k'.repeat(64), LINK_PASSCODE: 'ABCD-EFGH',
    BABYLOG_API: 'http://localhost:1/exec', BABYLOG_TOKEN: 't', PUSH_SECRET: secret, VAPID_PUBLIC: vapidPublic, VAPID_PRIVATE: j.d, NODE_TLS_REJECT_UNAUTHORIZED: '0' });
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'google-home', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; srv.stdout.on('data', d => { logs += d; }); srv.stderr.on('data', d => { logs += d; });
  await sleep(700);
  const S = 'http://localhost:' + PORT;
  const send = (body, key) => fetch(S + '/push', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  let r = await send({ messages: [] }, 'wrong');
  check(r.status === 401, 'the wrong secret is refused');
  r = await send({ messages: [
    { subscription: sub('https://localhost:' + RECV + '/push/ok'), title: 'Feed due', body: 'No feed for 3h 5m.', tag: 'feed' },
    { subscription: sub('https://localhost:' + RECV + '/push/gone'), title: 'x', body: 'y', tag: 't' }
  ] }, secret);
  const res = await r.json();
  check(r.status === 200 && res.results[0].ok === true, 'a notification is delivered');
  check(res.results[1].ok === false && res.results[1].gone === true, 'a phone that unsubscribed comes back as gone');
  const m = got.find(g => g.url.includes('ok'));
  check(m && m.headers['content-encoding'] === 'aes128gcm' && /^vapid t=.+, k=/.test(m.headers.authorization || ''), 'encrypted (aes128gcm) and signed (VAPID)');
  let plain = null;
  try { plain = JSON.parse(ece.decrypt(m.body, { version: 'aes128gcm', privateKey: phone, authSecret: auth.toString('base64url') }).toString('utf8')); } catch (e) { console.log(e.message); }
  check(plain && plain.title === 'Feed due' && plain.body === 'No feed for 3h 5m.' && plain.tag === 'feed', 'the phone can decrypt it: ' + JSON.stringify(plain));
  // The VAPID signature checks out against the public key phones subscribed with
  const jwt = /t=([^,]+)/.exec(m.headers.authorization)[1].split('.');
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: j.x, y: j.y }, format: 'jwk' });
  const okSig = crypto.verify('sha256', Buffer.from(jwt[0] + '.' + jwt[1]), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(jwt[2], 'base64url'));
  check(okSig && JSON.parse(Buffer.from(jwt[1], 'base64url')).aud === 'https://localhost:' + RECV, 'VAPID signature verifies for the push service');
  srv.kill(); recv.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
