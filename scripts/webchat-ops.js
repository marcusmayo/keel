'use strict';
// fleet-core: the shared webchat control endpoints — model picker, model select, web-research
// toggle, persona, and new-conversation. Mounted by each agent's server.js so the model-policy
// gate, model labels, and toggle wiring live in ONE place and can't drift between agents (the
// drift that produced the sonnet-4.6 "not in allowed set" bug). Per-agent values arrive via opts:
//   mountChatOps(app, { requireAuth, modelRouting, cwd, audit })
//     requireAuth  express middleware from core/auth.js
//     modelRouting the agent's model-routing module (its tiers are the single source of policy)
//     cwd          the app root (KEEL_DIR / AGENT_ROOT): execFile cwd + persona/agent.yaml root
//     audit        optional audit-record fn (no-op if absent)
// stateDir is derived as <cwd>/state. /color stays per-agent (different default accents), so it
// is intentionally NOT part of this module.

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const chatSession = require('./chat-session.js');

// Friendly labels for known slugs; unknown slugs get a readable title-cased fallback
// ("claude-sonnet-4.7" -> "Claude Sonnet 4.7") so a routing bump never surfaces a raw slug.
const MODEL_LABELS = {
  'openrouter/deepseek/deepseek-v4-pro': 'DeepSeek V4 Pro',
  'openrouter/z-ai/glm-5.2': 'GLM 5.2',
  'openrouter/moonshotai/kimi-k3': 'Kimi K3',
  'openrouter/anthropic/claude-haiku-4.5': 'Claude Haiku 4.5',
  'openrouter/anthropic/claude-sonnet-4.5': 'Claude Sonnet 4.5',
  'openrouter/anthropic/claude-sonnet-4.6': 'Claude Sonnet 4.6',
  'openrouter/anthropic/claude-opus-4.8': 'Claude Opus 4.8',
};
function modelLabel(slug) {
  if (MODEL_LABELS[slug]) return MODEL_LABELS[slug];
  return String(slug).split('/').pop().split('-')
    .map(w => /^[0-9.]+$/.test(w) ? w : (w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

function mountChatOps(app, opts) {
  const { requireAuth, modelRouting, cwd } = opts;
  const stateDir = path.join(cwd, 'state');
  const audit = typeof opts.audit === 'function' ? opts.audit : function () {};

  // Shared CLIENT controls (vendored fleet-core file): the chat page loads this via
  // <script src="/core/webchat-controls.js"> so the picker/toggle JS is single-sourced too.
  app.get('/core/webchat-controls.js', requireAuth, (req, res) => {
    res.type('application/javascript');
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.resolve(cwd, 'scripts', 'webchat-controls.js'), (err) => {
      if (err && !res.headersSent) res.status(404).end('// webchat-controls.js not vendored');
    });
  });

  // Model picker: options + labels from the routing tiers; web/webModel flag which models can
  // run REAL web search (the WEB_DIRECT_MODELS map), and webActive reflects the current toggle.
  app.get('/model', requireAuth, (req, res) => {
    try {
      const tiers = modelRouting.list();
      const webMap = chatSession.webDirectMap(process.env);
      let routineSlug = null; const seen = {}; const options = [];
      for (const t of tiers) {
        const slug = t.slug || t.openrouter_slug;
        if (t.tier === 'routine' || t.name === 'routine' || t.default) routineSlug = routineSlug || slug;
        if (slug && !seen[slug]) {
          seen[slug] = 1;
          const wd = (t.model_name && webMap[t.model_name]) || '';
          options.push({ slug: slug, label: modelLabel(slug), web: !!wd, webModel: wd || undefined });
        }
      }
      const active = modelRouting.getSelected() || routineSlug;
      const webActive = chatSession.readWebAccess(stateDir);
      res.json({ ok: true, tiers: tiers, active: active, options: options, webActive: webActive });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // Allowed = any slug on a routing tier (the single source of model policy), so this gate can
  // never drift from routing the way the old hardcoded label-map gate did.
  app.post('/model/select', requireAuth, (req, res) => {
    try {
      const slug = (req.body && req.body.slug) || '';
      const onTier = modelRouting.list().some(t => (t.slug || t.openrouter_slug) === slug);
      if (!onTier) return res.status(400).json({ ok: false, error: 'model not on a routing tier' });
      execFileSync('node', ['scripts/model-routing.js', 'set-selected', '--slug', slug], { cwd, encoding: 'utf8', timeout: 15000 });
      try { audit({ action: 'MODEL_SELECT', status: 'OK', slug: slug, tier: 'routine' }); } catch (e) {}
      res.json({ ok: true, active: slug });
    } catch (e) { res.status(500).json({ ok: false, error: (e.stdout || '') + (e.stderr || '') + String(e) }); }
  });

  // New conversation: rotate the session so the next turn starts fresh (agent forgets the chat).
  app.post('/session/reset', requireAuth, (req, res) => {
    try { chatSession.clearSessionId(stateDir); res.json({ ok: true, message: 'New conversation started.' }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Persona: view + edit the agent's conversational identity at runtime (no rebuild). Empty body
  // resets to the baked agent.yaml default. Applies from the next message.
  app.get('/persona', requireAuth, (req, res) => {
    res.json({ ok: true, persona: chatSession.readPersona(cwd, stateDir) || '', default: chatSession.defaultPersona(cwd) || '', custom: chatSession.hasPersonaOverride(stateDir) });
  });
  app.post('/persona', requireAuth, (req, res) => {
    const t = (req.body && typeof req.body.persona === 'string') ? req.body.persona : '';
    if (!t.trim()) { chatSession.clearPersona(stateDir); return res.json({ ok: true, message: 'Persona reset to the agent default.', persona: chatSession.readPersona(cwd, stateDir) || '', custom: false }); }
    chatSession.writePersona(stateDir, t);
    res.json({ ok: true, message: 'Persona updated (applies to the next message).', persona: t.trim(), custom: true });
  });

  // Web research access: per-agent runtime toggle (default OFF). When off, the agent's turns deny
  // the web tools structurally (--disallowedTools), so it cannot reach the web.
  app.get('/web-access', requireAuth, (req, res) => {
    res.json({ ok: true, enabled: chatSession.readWebAccess(stateDir) });
  });
  app.post('/web-access', requireAuth, (req, res) => {
    const enabled = !!(req.body && req.body.enabled);
    chatSession.writeWebAccess(stateDir, enabled);
    res.json({ ok: true, enabled, message: 'Web research ' + (enabled ? 'ENABLED' : 'DISABLED') + ' (applies to the next message).' });
  });

  // Fleet protection: MIRROR + REQUEST lane only. The authoritative state is the
  // workstation policy file behind the attested `fleetctl policy set` ceremony;
  // Aegis pushes the mirror here after a successful ceremony, and the webchat may
  // only RECORD a change request for the operator to complete in Aegis
  // (propose-don't-mutate: an agent can never unprotect itself).
  const fs2 = require('node:fs');
  const protFile = path.join(stateDir, 'protection.json');
  const readProt = () => { try { return { protected: false, requested: null, ...JSON.parse(fs2.readFileSync(protFile, 'utf8')) }; } catch { return { protected: false, requested: null }; } };
  const writeProt = (o) => { try { fs2.mkdirSync(stateDir, { recursive: true }); fs2.writeFileSync(protFile, JSON.stringify(o)); } catch { /* best effort */ } };
  app.get('/protection', requireAuth, (req, res) => res.json({ ok: true, ...readProt() }));
  app.post('/protection', requireAuth, (req, res) => {
    const b = req.body || {};
    const cur = readProt();
    if (typeof b.protected === 'boolean') {
      const requested = (cur.requested === (b.protected ? 'protect' : 'unprotect')) ? null : cur.requested;
      const next = { protected: b.protected, requested };
      writeProt(next); audit({ event: 'protection-mirror', protected: b.protected });
      return res.json({ ok: true, ...next });
    }
    if (b.request === 'protect' || b.request === 'unprotect') {
      const next = { protected: cur.protected, requested: b.request };
      writeProt(next); audit({ event: 'protection-request', request: b.request });
      return res.json({ ok: true, ...next, message: 'Protection ' + b.request + ' requested — complete the attested ceremony in Aegis.' });
    }
    return res.status(400).json({ ok: false, error: 'body must be {protected:boolean} (Aegis mirror) or {request:"protect"|"unprotect"}' });
  });
}

module.exports = { mountChatOps, modelLabel, MODEL_LABELS };
