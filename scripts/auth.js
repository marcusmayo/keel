/**
 * auth.js -- shared webchat auth contract (fleet-core module, vendored into scripts/).
 *
 * EDGE-ONLY AUTH. Cloudflare Access is the sole authenticator. There is no app-level
 * password/TOTP login: the only way to be authenticated is a valid Cf-Access-* header
 * (a human after Access email + MFA, or Aegis's service token). server.js requires this
 * via '../scripts/auth.js'.
 *
 *   requireAuth(req, res, next)
 *     - Aegis service token (Cf-Access-Client-Id) OR human after Cloudflare Access
 *       (Cf-Access-Jwt-Assertion)                 -> next()
 *     - req.session.authed (legacy/parity with the WS upgrade check; a browser can no
 *       longer set this, but the branch is kept so requireAuth and the WS check stay
 *       identical)                                -> next()
 *     - else                                       -> 403 (Access authentication required)
 *
 *   mountAuth(app, { webchatDir, agentName })
 *       GET  /         requireAuth-guarded, serves chat.html (brand-injected)
 *       GET  /logout   ends the Cloudflare Access session (302 -> /cdn-cgi/access/logout)
 *       POST /logout   same, JSON { ok, redirect } for fetch callers
 *     Returns requireAuth so callers can guard their own per-profile routes.
 *     No /login or /verify: the app-TOTP login mechanism is gone; the edge is the factor.
 *
 * Brand: served HTML has {{AGENT_NAME}} replaced by opts.agentName. Requires only Node
 * built-ins and needs no injected TOTP verifier.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ACCESS_LOGOUT = '/cdn-cgi/access/logout';

// The agent's name, by the one rule every surface uses. The deploy-time name lives in
// system/agent.local.yaml -- an untracked overlay cloud-init writes at provision -- so the
// tracked system/agent.yaml is never edited on a VM (an edit there kept every checkout dirty
// and made a pull that touched the file conflict). The tracked file's agent_name is the
// profile's default brand and the fallback for a hand-built tree. Regex, no yaml parser:
// this runs before anything else in server.js. -> string | null
function readAgentName(rootDir) {
  const fs = require('node:fs');
  const re = /^\s*agent_name:\s*["']?([^"'\n]+?)["']?\s*$/m;
  for (const f of ['agent.local.yaml', 'agent.yaml']) {
    try { const m = fs.readFileSync(path.join(rootDir, 'system', f), 'utf8').match(re); if (m && m[1].trim()) return m[1].trim(); } catch { /* next */ }
  }
  return null;
}

function requireAuth(req, res, next) {
  // Aegis service token OR a human session already validated by Cloudflare Access.
  if (req.headers['cf-access-client-id'] || req.headers['cf-access-jwt-assertion']) return next();
  // Kept in sync with the WS upgrade check; never set by a browser now that app-TOTP is gone.
  if (req.session && req.session.authed) return next();
  return res.status(403).type('text').send('Access authentication required');
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
  const agentName = opts.agentName || 'Agent';
  if (!webchatDir) {
    throw new Error('mountAuth requires { webchatDir }');
  }

  app.get('/', requireAuth, serveBranded(path.join(webchatDir, 'chat.html'), agentName));

  // Logout ends the Cloudflare Access session (the only session that authenticates now).
  // req.session.destroy is kept so any legacy app-session cookie is also cleared; harmless
  // when there is nothing to destroy.
  function doLogout(req, res, isGet) {
    const done = function () {
      if (isGet) return res.redirect(ACCESS_LOGOUT);
      return res.json({ ok: true, redirect: ACCESS_LOGOUT });
    };
    if (req.session && typeof req.session.destroy === 'function') return req.session.destroy(done);
    return done();
  }
  app.get('/logout', function (req, res) { doLogout(req, res, true); });
  app.post('/logout', function (req, res) { doLogout(req, res, false); });

  return requireAuth;
}

module.exports = { requireAuth, mountAuth, serveBranded, readAgentName, ACCESS_LOGOUT };
