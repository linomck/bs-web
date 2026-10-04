/**
 * N2nd - OIDC-Login (Pocket ID) + Sessions (SQLite) + Captcha-Token für die Extension.
 * Ohne OIDC_ISSUER ist die Authentifizierung aus (Entwicklung): Nutzer "local".
 */

const crypto = require('crypto');
const db = require('./db');

const ISSUER = process.env.OIDC_ISSUER || '';
const CLIENT_ID = process.env.OIDC_CLIENT_ID || '';
const CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const REQUIRED_GROUP = process.env.OIDC_REQUIRED_GROUP || '';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const COOKIE = 'n2nd_sid';
const FLOW_COOKIE = 'n2nd_oidc';

const enabled = Boolean(ISSUER && CLIENT_ID && PUBLIC_URL);
if (ISSUER && !enabled) console.warn('[Auth] OIDC_ISSUER gesetzt, aber OIDC_CLIENT_ID/PUBLIC_URL fehlen - Auth bleibt AUS.');
if (enabled && !process.env.SESSION_SECRET) console.warn('[Auth] SESSION_SECRET fehlt - Sessions/Tokens ungültig nach Neustart.');

const LOCAL_USER = { sub: 'local', name: 'Lokal', email: null, groups: [] };

function sign(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, name, value, maxAgeSec) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (PUBLIC_URL.startsWith('https')) parts.push('Secure');
  parts.push(maxAgeSec === 0 ? 'Max-Age=0' : `Max-Age=${maxAgeSec}`);
  const prev = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [].concat(prev, parts.join('; ')));
}

let clientPromise = null;
function getClient() {
  if (!clientPromise) {
    const { Issuer } = require('openid-client');
    clientPromise = Issuer.discover(ISSUER)
      .then(
        (issuer) =>
          new issuer.Client({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET || undefined,
            redirect_uris: [PUBLIC_URL + '/auth/callback'],
            response_types: ['code'],
            token_endpoint_auth_method: CLIENT_SECRET ? 'client_secret_basic' : 'none',
          })
      )
      .catch((e) => {
        clientPromise = null;
        throw e;
      });
  }
  return clientPromise;
}

function safeNext(n) {
  return typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/auth/') ? n : '/';
}

/** Setzt req.user (oder null). */
function attachUser(req, res, next) {
  if (!enabled) {
    req.user = LOCAL_USER;
    return next();
  }
  const sid = parseCookies(req)[COOKIE];
  req.user = sid ? db.getSession(sid) : null;
  next();
}

/** Schützt alles außer /auth/* und token-geschütztem /api/captcha. */
function requireUser(req, res, next) {
  if (req.user) return next();
  if (req.path.startsWith('/auth/') || req.path === '/api/captcha' || req.path === '/theme.css') return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Nicht angemeldet.' });
  return res.redirect('/auth/login?next=' + encodeURIComponent(safeNext(req.originalUrl)));
}

async function login(req, res) {
  try {
    const { generators } = require('openid-client');
    const client = await getClient();
    const state = generators.state();
    const nonce = generators.nonce();
    const verifier = generators.codeVerifier();
    const flow = JSON.stringify({ state, nonce, verifier, next: safeNext(req.query.next) });
    setCookie(res, FLOW_COOKIE, flow + '.' + sign(flow), 600);
    res.redirect(
      client.authorizationUrl({
        scope: 'openid profile email groups',
        state,
        nonce,
        code_challenge: generators.codeChallenge(verifier),
        code_challenge_method: 'S256',
        ...(req.query.prompt === 'login' ? { prompt: 'login' } : {}),
      })
    );
  } catch (err) {
    console.error('[Auth] Login-Fehler:', err.stack);
    res.status(502).send('Login nicht verfügbar: ' + err.message);
  }
}

async function callback(req, res) {
  try {
    const raw = parseCookies(req)[FLOW_COOKIE] || '';
    const i = raw.lastIndexOf('.');
    const flowStr = raw.slice(0, i);
    const sig = raw.slice(i + 1);
    if (!flowStr || sign(flowStr) !== sig) throw new Error('Ungültiger Login-Zustand.');
    const flow = JSON.parse(flowStr);

    const client = await getClient();
    const params = client.callbackParams(req);
    const tokenSet = await client.callback(PUBLIC_URL + '/auth/callback', params, {
      state: flow.state,
      nonce: flow.nonce,
      code_verifier: flow.verifier,
    });
    let claims = tokenSet.claims();
    if (!claims.groups && tokenSet.access_token) {
      try {
        claims = { ...(await client.userinfo(tokenSet.access_token)), ...claims };
      } catch (e) { /* ignorieren */ }
    }
    const groups = Array.isArray(claims.groups) ? claims.groups : [];
    if (REQUIRED_GROUP && !groups.includes(REQUIRED_GROUP)) {
      setCookie(res, FLOW_COOKIE, '', 0);
      return res.status(403).send('Zugriff verweigert: fehlende Gruppe.');
    }

    const sid = crypto.randomBytes(32).toString('base64url');
    db.createSession(
      sid,
      { sub: claims.sub, name: claims.name || claims.preferred_username || null, email: claims.email || null, picture: claims.picture || null, groups },
      Date.now() + SESSION_TTL
    );
    setCookie(res, COOKIE, sid, SESSION_TTL / 1000);
    setCookie(res, FLOW_COOKIE, '', 0);
    res.redirect(safeNext(flow.next));
  } catch (err) {
    console.error('[Auth] Callback-Fehler:', err.stack);
    res.status(400).send('Login fehlgeschlagen: ' + err.message + ' <a href="/auth/login">Erneut versuchen</a>');
  }
}

function logout(req, res) {
  const sid = parseCookies(req)[COOKIE];
  if (sid) db.deleteSession(sid);
  setCookie(res, COOKIE, '', 0);
  res.redirect('/auth/logged-out');
}

function loggedOut(req, res) {
  res.send(`<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><title>N2nd</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/theme.css"></head>
<body style="display:flex;min-height:100vh;align-items:center;justify-content:center;flex-direction:column;gap:18px">
<h1 style="font-size:28px;letter-spacing:-0.03em">Abgemeldet</h1>
<a class="btn" href="/auth/login?prompt=login">Erneut anmelden</a></body></html>`);
}

// --- Kurzlebiges Token für /api/captcha (Extension sendet es als Bearer) ---
function createCaptchaToken(user) {
  const payload = Buffer.from(JSON.stringify({ s: user.sub, e: Date.now() + 15 * 60 * 1000 })).toString('base64url');
  return payload + '.' + sign('cap.' + payload);
}

function verifyCaptchaToken(token) {
  if (!enabled) return true;
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig || sign('cap.' + payload) !== sig) return false;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).e > Date.now();
  } catch (e) {
    return false;
  }
}

setInterval(() => db.purgeSessions(), 60 * 60 * 1000).unref();

module.exports = { loggedOut, enabled, attachUser, requireUser, login, callback, logout, createCaptchaToken, verifyCaptchaToken };
