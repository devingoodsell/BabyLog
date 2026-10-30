/**
 * Baby Log for Google Home.
 *
 * A private Google Home "cloud-to-cloud" integration that shows up in Google Home as
 * scenes (Baby Log wet diaper, Baby Log bottle feed 2 ounces of formula, ...). Turning a
 * scene on, from a household routine such as "Hey Google, Baby Log wet diaper", adds an entry to the Baby Log sheet through
 * the same Apps Script the app uses.
 *
 * Endpoints
 *   GET  /                 health check
 *   GET  /oauth/authorize  account linking page (asks for the link passcode)
 *   POST /oauth/authorize  checks the passcode, redirects back to Google with a code
 *   POST /oauth/token      exchanges codes and refresh tokens for access tokens
 *   POST /fulfillment      SYNC / QUERY / EXECUTE / DISCONNECT from Google
 *
 * No database: codes and tokens are signed with SIGNING_KEY. Changing SIGNING_KEY
 * (or LINK_PASSCODE for new links) unlinks everything.
 */
'use strict';

const http = require('http');
const crypto = require('crypto');

const ENV = process.env;
const CONFIG = {
  port: Number(ENV.PORT || 8080),
  clientId: ENV.CLIENT_ID || '',
  clientSecret: ENV.CLIENT_SECRET || '',
  signingKey: ENV.SIGNING_KEY || '',
  passcode: ENV.LINK_PASSCODE || '',
  api: ENV.BABYLOG_API || '',          // Apps Script web app URL (ends in /exec)
  token: ENV.BABYLOG_TOKEN || ''       // device key for the "Google Home" device in Baby Log
};
for (const [k, v] of Object.entries({ CLIENT_ID: CONFIG.clientId, CLIENT_SECRET: CONFIG.clientSecret, SIGNING_KEY: CONFIG.signingKey, LINK_PASSCODE: CONFIG.passcode, BABYLOG_API: CONFIG.api, BABYLOG_TOKEN: CONFIG.token })) {
  if (!v) { console.error('Missing environment variable ' + k); process.exit(1); }
}

/* What Google Home sees: one scene per voice command. Each scene adds one entry.
   A household routine maps a spoken phrase ("Hey Google, Baby Log wet diaper") to its scene. */
const BOTTLE_OZ = [1, 2, 3, 4, 6, 8];
const MILKS = [{ key: 'breast', words: 'breast milk' }, { key: 'formula', words: 'formula' }];
const SCENES = [
  { id: 'diaper-wet', name: 'Baby Log wet diaper', entry: { type: 'diaper', kind: 'wet' } },
  { id: 'diaper-dirty', name: 'Baby Log dirty diaper', entry: { type: 'diaper', kind: 'dirty' } },
  { id: 'diaper-both', name: 'Baby Log dirty and wet diaper', nicknames: ['Baby Log both diaper'], entry: { type: 'diaper', kind: 'both' } }
].concat(...MILKS.map(m => BOTTLE_OZ.map(oz => ({
  id: 'bottle-' + m.key + '-' + oz + 'oz',
  name: 'Baby Log bottle feed ' + oz + (oz === 1 ? ' ounce' : ' ounces') + ' of ' + m.words,
  entry: { type: 'bottle', oz: oz, amount: oz, unit: 'oz', source: m.key }
}))));

const CODE_TTL = 10 * 60;          // seconds
const ACCESS_TTL = 60 * 60;
const AGENT_USER_ID = 'babylog-household';
// Google sends users back to these hosts after linking
const REDIRECT_HOSTS = ['oauth-redirect.googleusercontent.com', 'oauth-redirect-sandbox.googleusercontent.com'];

/* ------------------------------------------------------------------ */
/* Signed tokens                                                       */
/* ------------------------------------------------------------------ */
const b64 = buf => Buffer.from(buf).toString('base64url');
function sign(payload) {
  const body = b64(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', CONFIG.signingKey).update(body).digest('base64url');
  return body + '.' + mac;
}
function verify(token, typ) {
  if (typeof token !== 'string' || token.length > 2000) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', CONFIG.signingKey).update(body).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (p.typ !== typ) return null;
  if (p.exp && p.exp < Math.floor(Date.now() / 1000)) return null;
  return p;
}
const now = () => Math.floor(Date.now() / 1000);
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function send(res, status, body, headers) {
  const isJson = typeof body !== 'string';
  res.writeHead(status, Object.assign({
    'Content-Type': isJson ? 'application/json' : 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  }, headers || {}));
  res.end(isJson ? JSON.stringify(body) : body);
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ------------------------------------------------------------------ */
/* Account linking                                                     */
/* ------------------------------------------------------------------ */
function checkAuthorizeParams(p) {
  if (p.get('response_type') !== 'code') return 'Unsupported response_type.';
  if (!safeEqual(p.get('client_id') || '', CONFIG.clientId)) return 'Unknown client.';
  let u;
  try { u = new URL(p.get('redirect_uri') || ''); } catch (e) { return 'Bad redirect.'; }
  if (u.protocol !== 'https:' || !REDIRECT_HOSTS.includes(u.hostname)) return 'Redirect not allowed.';
  return '';
}

function linkPage(params, error) {
  const hidden = ['client_id', 'redirect_uri', 'state', 'response_type', 'scope']
    .map(k => '<input type="hidden" name="' + k + '" value="' + esc(params.get(k) || '') + '">').join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link Baby Log</title>
<style>
:root{--bg:#F2F4F8;--s:#fff;--ink:#1B2333;--mut:#667085;--line:#E2E6EE;--acc:#4F74DB;--err:#C2413A;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0D1220;--s:#161C2B;--ink:#E4E8F1;--mut:#8C95A8;--line:#252D3F;--acc:#8DA5F0;--err:#EE7B73;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 ui-rounded,system-ui,-apple-system,Roboto,sans-serif}
main{max-width:420px;margin:0 auto;padding:48px 20px;display:flex;flex-direction:column;gap:16px}
h1{margin:0;font-size:26px}p{margin:0;color:var(--mut);font-weight:600}
input[type=text]{font:inherit;font-size:22px;font-weight:800;letter-spacing:.12em;text-align:center;width:100%;padding:14px;border-radius:14px;border:1px solid var(--line);background:var(--s);color:var(--ink);text-transform:uppercase}
button{font:inherit;font-weight:800;font-size:17px;width:100%;padding:16px;border:0;border-radius:16px;background:var(--acc);color:#fff}
.err{color:var(--err);font-weight:700}
</style></head><body><main>
<h1>Link Baby Log to Google Home</h1>
<p>Enter the link passcode from the Baby Log setup. This only needs to be done once.</p>
${error ? '<div class="err">' + esc(error) + '</div>' : ''}
<form method="post" action="/oauth/authorize">${hidden}
<input type="text" name="passcode" autocomplete="one-time-code" autocapitalize="characters" placeholder="XXXX-XXXX" required autofocus>
<div style="height:12px"></div><button type="submit">Link</button></form>
</main></body></html>`;
}

const failures = new Map(); // ip -> { n, until }
function tooMany(ip) {
  const f = failures.get(ip);
  return f && f.until > Date.now() && f.n >= 10;
}
function noteFail(ip) {
  const f = failures.get(ip) || { n: 0, until: 0 };
  if (f.until < Date.now()) { f.n = 0; f.until = Date.now() + 15 * 60000; }
  f.n++; failures.set(ip, f);
}

async function authorize(req, res, url) {
  if (req.method === 'GET') {
    const problem = checkAuthorizeParams(url.searchParams);
    if (problem) return send(res, 400, linkPage(url.searchParams, problem));
    return send(res, 200, linkPage(url.searchParams, ''));
  }
  const form = new URLSearchParams(await readBody(req));
  const problem = checkAuthorizeParams(form);
  if (problem) return send(res, 400, linkPage(form, problem));
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (tooMany(ip)) return send(res, 429, linkPage(form, 'Too many attempts. Try again in 15 minutes.'));
  const typed = String(form.get('passcode') || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const want = CONFIG.passcode.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (!safeEqual(typed, want)) { noteFail(ip); return send(res, 200, linkPage(form, 'That passcode is not right.')); }
  const code = sign({ typ: 'code', exp: now() + CODE_TTL, redirect: form.get('redirect_uri'), n: crypto.randomBytes(8).toString('hex') });
  const back = new URL(form.get('redirect_uri'));
  back.searchParams.set('code', code);
  if (form.get('state')) back.searchParams.set('state', form.get('state'));
  res.writeHead(302, { Location: back.toString(), 'Cache-Control': 'no-store' });
  res.end();
}

async function token(req, res) {
  const form = new URLSearchParams(await readBody(req));
  let id = form.get('client_id'), secret = form.get('client_secret');
  const basic = /^Basic (.+)$/i.exec(req.headers.authorization || '');
  if (basic) {
    const [u, p] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
    id = decodeURIComponent(u || ''); secret = decodeURIComponent(p || '');
  }
  if (!safeEqual(id || '', CONFIG.clientId) || !safeEqual(secret || '', CONFIG.clientSecret)) {
    return send(res, 401, { error: 'invalid_client' });
  }
  const grant = form.get('grant_type');
  const access = () => sign({ typ: 'access', exp: now() + ACCESS_TTL, n: crypto.randomBytes(6).toString('hex') });
  if (grant === 'authorization_code') {
    const c = verify(form.get('code'), 'code');
    if (!c || (form.get('redirect_uri') && form.get('redirect_uri') !== c.redirect)) return send(res, 400, { error: 'invalid_grant' });
    return send(res, 200, {
      token_type: 'Bearer', access_token: access(), expires_in: ACCESS_TTL,
      refresh_token: sign({ typ: 'refresh', iat: now(), n: crypto.randomBytes(8).toString('hex') })
    });
  }
  if (grant === 'refresh_token') {
    if (!verify(form.get('refresh_token'), 'refresh')) return send(res, 400, { error: 'invalid_grant' });
    return send(res, 200, { token_type: 'Bearer', access_token: access(), expires_in: ACCESS_TTL });
  }
  return send(res, 400, { error: 'unsupported_grant_type' });
}

/* ------------------------------------------------------------------ */
/* Smart home fulfillment                                              */
/* ------------------------------------------------------------------ */
function syncDevices() {
  return SCENES.map(s => ({
    id: s.id,
    type: 'action.devices.types.SCENE',
    traits: ['action.devices.traits.Scene'],
    name: { name: s.name, defaultNames: [s.name], nicknames: s.nicknames || [] },
    willReportState: false,
    attributes: { sceneReversible: false },
    deviceInfo: { manufacturer: 'Baby Log', model: 'voice-log', swVersion: '1' }
  }));
}

// Sends one entry to the Baby Log Apps Script. The entry id is derived from Google's
// request id so a retried request does not log twice (the sheet ignores repeat ids).
async function logEntry(scene, requestId) {
  const id = 'gh-' + crypto.createHash('sha256').update(String(requestId) + ':' + scene.id).digest('hex').slice(0, 32);
  const entry = Object.assign({ id: id, t: Date.now() }, scene.entry);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(CONFIG.api, {
      method: 'POST', redirect: 'follow', signal: ctrl.signal,
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'add', token: CONFIG.token, entry: entry })
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error + ': ' + j.message);
    return true;
  } finally {
    clearTimeout(timer);
  }
}

async function fulfillment(req, res) {
  const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
  if (!bearer || !verify(bearer[1], 'access')) return send(res, 401, { error: 'invalid_token' });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'bad_json' }); }
  const requestId = body.requestId;
  const input = (body.inputs || [])[0] || {};

  switch (input.intent) {
    case 'action.devices.SYNC':
      return send(res, 200, { requestId, payload: { agentUserId: AGENT_USER_ID, devices: syncDevices() } });

    case 'action.devices.QUERY': {
      const devices = {};
      ((input.payload && input.payload.devices) || []).forEach(d => { devices[d.id] = { online: true, status: 'SUCCESS' }; });
      return send(res, 200, { requestId, payload: { devices } });
    }

    case 'action.devices.EXECUTE': {
      const results = [];
      for (const cmd of (input.payload && input.payload.commands) || []) {
        const wants = (cmd.execution || []).some(x => x.command === 'action.devices.commands.ActivateScene' && !(x.params && x.params.deactivate));
        for (const d of cmd.devices || []) {
          const scene = SCENES.find(s => s.id === d.id);
          if (!scene) { results.push({ ids: [d.id], status: 'ERROR', errorCode: 'deviceNotFound' }); continue; }
          if (!wants) { results.push({ ids: [d.id], status: 'ERROR', errorCode: 'functionNotSupported' }); continue; }
          try {
            await logEntry(scene, requestId);
            console.log(JSON.stringify({ msg: 'logged', scene: scene.id }));
            results.push({ ids: [d.id], status: 'SUCCESS', states: { online: true } });
          } catch (e) {
            console.error(JSON.stringify({ msg: 'log failed', scene: scene.id, error: String(e && e.message || e) }));
            results.push({ ids: [d.id], status: 'ERROR', errorCode: 'transientError' });
          }
        }
      }
      return send(res, 200, { requestId, payload: { commands: results } });
    }

    case 'action.devices.DISCONNECT':
      return send(res, 200, {});

    default:
      return send(res, 400, { requestId, payload: { errorCode: 'notSupported' } });
  }
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/' && req.method === 'GET') return send(res, 200, { ok: true, service: 'babylog-home' });
    if (url.pathname === '/oauth/authorize' && (req.method === 'GET' || req.method === 'POST')) return await authorize(req, res, url);
    if (url.pathname === '/oauth/token' && req.method === 'POST') return await token(req, res);
    if (url.pathname === '/fulfillment' && req.method === 'POST') return await fulfillment(req, res);
    send(res, 404, { error: 'not_found' });
  } catch (e) {
    console.error(JSON.stringify({ msg: 'error', path: url.pathname, error: String(e && e.message || e) }));
    if (!res.headersSent) send(res, 500, { error: 'server_error' });
  }
});
server.listen(CONFIG.port, () => console.log('babylog-home listening on ' + CONFIG.port));
