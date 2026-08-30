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
 *   wsUpgradeAllowed(req) -> boolean
 *     The SAME policy for the WebSocket upgrade. requireAuth is the HTTP door and this is
 *     the socket door; they must answer to one predicate or a mode that opens one leaves
 *     the other shut. server.js calls this from its 'upgrade' handler.
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
// Resolution order, and the order is the point:
//   1. state/agent.local.yaml  -- deploy-time name, on a MOUNTED VOLUME
//   2. system/agent.local.yaml -- the same file's old home, kept so an agent built before this
//                                 change still answers to its own name until it is rebuilt
//   3. system/agent.yaml       -- the tracked profile default, and the fallback for a hand-built tree
//
// Why the move: system/ is COPYied into the image, so the overlay was baked in and two agents on
// the same commit produced different images -- castor:latest on one host literally contained the
// other's name. The tag stopped identifying an artifact, the build attestation digest stopped
// being evidence that two agents run the same code, and a shared registry became impossible,
// which is the model the serverless lanes assume. state/ is a named volume (compose says it
// outright: image = code, state = volumes), so the name now arrives at container start and the
// image is identical everywhere.
function readAgentName(rootDir) {
  const fs = require('node:fs');
  const re = /^\s*agent_name:\s*["']?([^"'\n]+?)["']?\s*$/m;
  // 0. $AGENT_NAME -- the deploy-time name delivered at CONTAINER START, from the 0600 env file
  //    bootstrap writes and compose passes. This is the only source that is neither in the image
  //    nor seeded from it: a named volume initialises from the image's content at that path, so
  //    putting the overlay in state/ inside the image would bake it right back in.
  const envName = String(process.env.AGENT_NAME || '').trim();
  if (envName) return envName;
  for (const rel of [['state', 'agent.local.yaml'], ['system', 'agent.local.yaml'], ['system', 'agent.yaml']]) {
    try { const m = fs.readFileSync(path.join(rootDir, rel[0], rel[1]), 'utf8').match(re); if (m && m[1].trim()) return m[1].trim(); } catch { /* next */ }
  }
  return null;
}

// AUTH_MODE=local -- the stranger's front door, and ONLY theirs. The fleet's auth is edge-only
// by design: the webchat trusts Cloudflare Access headers and 403s everything else, which is
// exactly right behind a tunnel and exactly wrong for someone who just ran `docker compose up`
// on a laptop -- their quickstart ends at a locked door with no Cloudflare in front of it.
// This is an EXPLICIT opt-in with three properties, each load-bearing:
//   1. only the literal string 'local' relaxes anything -- unset, empty, or any other value
//      behaves byte-identically to before this existed (pinned by test);
//   2. it is read from the environment at request time, so nothing baked into an image can
//      turn it on -- only the operator running the container can;
//   3. it is LOUD: every page carries a banner saying the edge is absent (webchat-controls
//      reads /auth-mode), and the boot log says so once.
const authMode = () => (process.env.AUTH_MODE || '').trim().toLowerCase();
const isLocalMode = () => authMode() === 'local';
let saidLocal = false;

function requireAuth(req, res, next) {
  if (isLocalMode()) {
    if (!saidLocal) { saidLocal = true; console.warn('[auth] AUTH_MODE=local -- edge auth DISABLED; every request is trusted. Never expose this to a network.'); }
    return next();
  }
  // Aegis service token OR a human session already validated by Cloudflare Access.
  if (req.headers['cf-access-client-id'] || req.headers['cf-access-jwt-assertion']) return next();
  // Kept in sync with the WS upgrade check; never set by a browser now that app-TOTP is gone.
  if (req.session && req.session.authed) return next();
  return res.status(403).type('text').send('Access authentication required');
}

// The socket door, and the reason it exists as a function: the WS upgrade handler used to
// re-implement requireAuth's checks inline. requireAuth then grew its local-mode branch and the
// copy did not, so AUTH_MODE=local opened every page and kept 401ing the upgrade -- a laptop got
// a rendered chat whose Send button did nothing and said nothing. One predicate, called by both
// doors, is the only shape that cannot drift again. -> boolean
function wsUpgradeAllowed(req) {
  if (isLocalMode()) return true;
  const h = (req && req.headers) || {};
  if (h['cf-access-client-id'] || h['cf-access-jwt-assertion']) return true;
  return !!(req && req.session && req.session.authed);
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

module.exports = { requireAuth, wsUpgradeAllowed, mountAuth, serveBranded, readAgentName, ACCESS_LOGOUT, isLocalMode };
