/**
 * auth.js -- shared webchat auth contract (fleet-core module, vendored into scripts/).
 *
 * Single-sources the Cloudflare-Access-aware auth used by every agent webchat so the
 * post-Access behavior can never diverge between profiles. server.js requires this via
 * '../scripts/auth.js'.
 *
 *   requireAuth(req, res, next)
 *     - Aegis service token (Cf-Access-Client-Id)  -> next()   [machine call, no interactive MFA]
 *     - human session after Cloudflare Access (Cf-Access-Jwt-Assertion) -> next()
 *       (the edge already did email + MFA, so no redundant app-TOTP -> "standardize-on-2")
 *     - else app-TOTP session (req.session.authed)  -> next()
 *     - else                                        -> redirect('/login')
 *
 *   mountAuth(app, { webchatDir, totpSecret, agentName, speakeasy })
 *     Registers, identically for every agent:
 *       GET  /         requireAuth-guarded, serves chat.html (brand-injected)
 *       GET  /login    serves login.html (brand-injected)
 *       POST /verify   TOTP check (rate-limited) -> sets req.session.authed
 *       GET  /logout   clears app session AND 302 -> /cdn-cgi/access/logout  (true logout)
 *       POST /logout   clears app session, returns { ok, redirect } for fetch callers
 *     Returns requireAuth so callers can guard their own per-profile routes with it.
 *
 * Brand: the served HTML has {{AGENT_NAME}} replaced by opts.agentName, so the UI title is
 * profile-driven instead of hardcoded per file.
 *
 * Requires only Node built-ins; the TOTP verifier (speakeasy) is injected by the caller, so
 * this module carries no node_modules dependency of its own and resolves anywhere it is vendored.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ACCESS_LOGOUT = '/cdn-cgi/access/logout';

function requireAuth(req, res, next) {
  // Aegis service token OR a human session already validated by Cloudflare Access.
  if (req.headers['cf-access-client-id'] || req.headers['cf-access-jwt-assertion']) return next();
  if (req.session && req.session.authed) return next();
  return res.redirect('/login');
}

function makeRateLimiter(maxAttempts, windowMs) {
  maxAttempts = maxAttempts || 5;
  windowMs = windowMs || 15 * 60 * 1000;
  const attempts = new Map();
  return {
    limited: function (ip) {
      const rec = attempts.get(ip);
      if (!rec) return false;
      if (Date.now() - rec.first > windowMs) { attempts.delete(ip); return false; }
      return rec.count >= maxAttempts;
    },
    bump: function (ip) {
      const rec = attempts.get(ip) || { count: 0, first: Date.now() };
      rec.count += 1;
      attempts.set(ip, rec);
    },
    clear: function (ip) { attempts.delete(ip); },
  };
}

function serveBranded(file, agentName) {
  return function (req, res) {
    let html;
    try {
      html = fs.readFileSync(file, 'utf8');
    } catch (e) {
      return res.status(500).type('text').send('ui template missing');
    }
    return res.type('html').send(html.replace(/\{\{AGENT_NAME\}\}/g, agentName));
  };
}

function mountAuth(app, opts) {
  opts = opts || {};
  const webchatDir = opts.webchatDir;
  const totpSecret = opts.totpSecret;
  const agentName = opts.agentName || 'Agent';
  const speakeasy = opts.speakeasy;
  if (!webchatDir || !speakeasy) {
    throw new Error('mountAuth requires { webchatDir, speakeasy }');
  }
  const rl = makeRateLimiter();

  app.get('/', requireAuth, serveBranded(path.join(webchatDir, 'chat.html'), agentName));
  app.get('/login', serveBranded(path.join(webchatDir, 'login.html'), agentName));

  app.post('/verify', function (req, res) {
    const ip = req.ip;
    if (rl.limited(ip)) return res.status(429).json({ ok: false, error: 'too many attempts' });
    const token = (((req.body && req.body.token) || '') + '').replace(/\s+/g, '');
    const ok = speakeasy.totp.verify({ secret: totpSecret, encoding: 'base32', token, window: 1 });
    if (ok) {
      req.session.authed = true;
      rl.clear(ip);
      return res.json({ ok: true });
    }
    rl.bump(ip);
    return res.status(401).json({ ok: false, error: 'invalid code' });
  });

  // Real logout: clear the app session AND end the Cloudflare Access session, otherwise the
  // lingering edge session re-authenticates the next request and logout appears to do nothing.
  function doLogout(req, res, isGet) {
    req.session.destroy(function () {
      if (isGet) return res.redirect(ACCESS_LOGOUT);
      return res.json({ ok: true, redirect: ACCESS_LOGOUT });
    });
  }
  app.get('/logout', function (req, res) { doLogout(req, res, true); });
  app.post('/logout', function (req, res) { doLogout(req, res, false); });

  return requireAuth;
}

module.exports = { requireAuth, mountAuth, makeRateLimiter, serveBranded, ACCESS_LOGOUT };
