'use strict';
// fleet-core: multi-turn chat via Claude Code session resume.
//
// One rolling conversation per agent so the agent's OWN webchat AND the Aegis relay
// append to the SAME session (ask in Aegis, follow up in the agent, and back). The
// mechanism lives here in core; agents differ only by values (model, cwd, state dir).
//
// How continuity works:
//   - `claude -p` is stateless by default. We persist a session UUID (state/chat-session.json)
//     and pass `--resume <uuid>` on every turn so history is restored and appended.
//   - On the FIRST turn there is no stored UUID: we run without --resume, capture the
//     session_id Claude Code emits in its stream-json, and store it. Every later turn resumes it.
//   - The transcript itself lives in the Claude Code session store (~/.claude/projects/<cwd>/…),
//     which MUST be on a persistent Docker volume so it survives container recreation. The UUID
//     lives in state/ (already a persistent volume).
//   - If a resume fails (stale/lost transcript but a stored UUID), we clear the UUID so the next
//     turn starts a fresh session instead of erroring forever.
//
// The caller owns the wire protocol: runChatTurn streams parsed stream-json events to onEvent()
// and reports the exit via onDone(); how those become WebSocket messages is the agent's concern.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

// Per-ROUTE session files: gateway (LiteLLM/OpenRouter) and direct (api.anthropic.com)
// transcripts are mutually incompatible (the strict direct validator 400s gateway-era turns),
// so each route keeps its OWN rolling session. Switching web on/off never resumes a foreign
// transcript -- no more cross-route 400 + forced reset; each route's context survives.
// Sessions are partitioned by route AND by model. Route partitioning already existed
// for the obvious reason: resuming a gateway conversation on a direct-Anthropic turn
// carries context from a different runtime. The active model is the same class of
// boundary and was simply missing from the key.
//
// Why this is structural rather than a stronger instruction: with one rolling session,
// switching models leaves the transcript full of confident assistant statements naming
// the OLD model. The next turn's runtime fact is correct, but it competes with a more
// recent, more specific answer -- and recency wins, so the agent reports the previous
// selection until challenged. Telling it harder is a Shouldn't. Partitioning makes a
// session incapable of containing a statement made under a different model, so the
// stale answer cannot be produced at all.
//
// Nothing is destroyed: switching away and back returns to that model's own thread with
// its memory intact. "New conversation" still clears every thread (clearSessionId with
// no route), which is the operator-explicit reset.
function modelKey(model) {
  const k = String(model || 'default').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return k.slice(0, 60) || 'default';
}
function sessionFile(stateDir, route, model) {
  const base = route === 'direct' ? 'chat-session-direct' : 'chat-session';
  return path.join(stateDir, base + '--' + modelKey(model) + '.json');
}

function readSessionId(stateDir, route, model) {
  try { return JSON.parse(fs.readFileSync(sessionFile(stateDir, route, model), 'utf8')).sessionId || null; }
  catch { return null; }
}

function writeSessionId(stateDir, id, route, model) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(sessionFile(stateDir, route, model),
      JSON.stringify({ sessionId: id, model: String(model || ''), route: route || 'gateway', updated: new Date().toISOString() }, null, 2));
    return true;
  } catch { return false; }
}

// With no model (the /session/reset endpoint) this clears EVERY thread -- a real "new
// conversation" across all routes and models, not just the one in play. Legacy
// unpartitioned files are swept too so an upgrade cannot leave an orphan resumable.
function clearSessionId(stateDir, route, model) {
  if (model) { try { fs.unlinkSync(sessionFile(stateDir, route, model)); } catch { /* absent */ } return; }
  try {
    for (const f of fs.readdirSync(stateDir)) {
      if (/^chat-session(-direct)?(--.*)?\.json$/.test(f)) { try { fs.unlinkSync(path.join(stateDir, f)); } catch { /* absent */ } }
    }
  } catch { /* no state dir */ }
}

// Read the agent's conversational identity. A runtime override in state/persona.txt (editable
// with no rebuild) wins over the baked agent.yaml default. Appended to the system prompt each turn.
function personaFile(stateDir) { return path.join(stateDir, 'persona.txt'); }
// The baked persona text from agent.yaml. js-yaml (present in every agent image) when it is there;
// otherwise the one shape agent.yaml is authored in -- `persona: |` followed by an indented block --
// is read directly, so identity never depends on a parser being installed where this module runs.
function personaFromYaml(cwd) {
  let y;
  try { y = fs.readFileSync(path.join(cwd, 'system', 'agent.yaml'), 'utf8'); } catch { return null; }
  try {
    const yaml = require('js-yaml');
    const doc = yaml.load(y);
    return (doc && typeof doc.persona === 'string' && doc.persona.trim()) ? doc.persona.trim() : null;
  } catch { /* no parser here: fall through */ }
  const lines = y.split(/\r?\n/);
  const start = lines.findIndex((l) => /^persona:\s*\|[-+]?\s*$/.test(l));
  if (start < 0) return null;
  const block = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { block.push(''); continue; }
    if (!/^\s/.test(l)) break;
    block.push(l);
  }
  const indent = Math.min(...block.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
  const text = block.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n').trim();
  return text || null;
}
function readPersona(cwd, stateDir) {
  const id = readIdentity(cwd);
  if (stateDir) { try { const t = fs.readFileSync(personaFile(stateDir), 'utf8'); if (t && t.trim()) return renderPersona(t.trim(), id); } catch { /* no override */ } }
  const p = personaFromYaml(cwd);
  return p ? renderPersona(p, id) : null;
}
function defaultPersona(cwd) {  // the baked agent.yaml persona, ignoring any override
  const p = personaFromYaml(cwd);
  return p ? renderPersona(p, readIdentity(cwd)) : null;
}
function writePersona(stateDir, text) { try { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(personaFile(stateDir), String(text || '')); return true; } catch { return false; } }

// Who is at the other end of a WS chat, from the upgrade request, and what the agent writes about
// a turn. The plane relays every console, Telegram, migrate and relay turn to the agent over its
// WS with the plane's service token as the VERIFIED caller and X-Aegis-On-Behalf-Of as its claim
// about who was behind it; the HTTP surfaces already record both (skills, file-stage, a2a) and the
// WS chat recorded neither, so an agent's own chain could not say a turn had happened, let alone
// for whom. Same rule as HTTP (skills.actorOf / skills.onBehalfOf): the label never replaces the id,
// the claim is honoured only from a verified caller and is asserted by that caller. The record
// carries metadata only -- bytes, model, duration, rc -- never the prompt or the reply.
function wsIdentity(req, cwd) {
  try {
    const sk = require('./skills');
    const actor = sk.actorOf(req, cwd);
    return { actor, onBehalfOf: sk.onBehalfOf(req, actor) };
  } catch (e) { return { actor: { src: 'unknown', id: 'unattributed' }, onBehalfOf: null }; }
}
// The chain says what was done, never what was said. But a turn must be traceable to its exact
// prompt for as long as the transcript exists: so the record anchors the content by hash --
// sha256 of the prompt and of the reply -- and names the session (the claude session the turn
// ran in; its transcript lives on the agent's persistent volume and rides in the nightly snapshot)
// and the turn's index within it. A transcript produced later is provable against the chain;
// the chain itself still holds no words. Retention of transcripts is a separate policy from
// retention of the chain (metadata, never deleted).
function turnRecord(identity, t) {
  const id = identity || {};
  const sha = (s) => (typeof s === 'string' && s.length) ? require('node:crypto').createHash('sha256').update(s, 'utf8').digest('hex') : null;
  const rec = {
    event: 'chat-turn', via: (t && t.via) || 'ws',
    actor: id.actor || { src: 'unknown', id: 'unattributed' },
    onBehalfOf: id.onBehalfOf || null,
    model: (t && t.model) || null,
    sessionId: (t && t.sessionId) || null,
    turnIndex: t && typeof t.turnIndex === 'number' ? t.turnIndex : null,
    promptBytes: t && typeof t.promptBytes === 'number' ? t.promptBytes : (t && typeof t.prompt === 'string' ? Buffer.byteLength(t.prompt, 'utf8') : 0),
    replyBytes: t && typeof t.replyBytes === 'number' ? t.replyBytes : (t && typeof t.reply === 'string' ? Buffer.byteLength(t.reply, 'utf8') : 0),
    promptSha256: t ? sha(t.prompt) : null,
    replySha256: t ? sha(t.reply) : null,
    durationMs: t && typeof t.durationMs === 'number' ? Math.round(t.durationMs) : 0,
    exitCode: t && typeof t.rc === 'number' ? t.rc : null,   // the chain's name for it (skills use exitCode; the export reads it)
  };
  if (t && t.error) rec.error = String(t.error).slice(0, 200);
  return rec;
}
// The session a model's turns are running in: whichever of the two session files (gateway route,
// direct route) is newest for that model. Used to name the session on the turn record.
function currentSessionId(stateDir, model) {
  let best = null, bestT = -1;
  for (const route of ['gateway', 'direct']) {
    try {
      const f = sessionFile(stateDir, route, model);
      const st = fs.statSync(f);
      if (st.mtimeMs > bestT) { const id = JSON.parse(fs.readFileSync(f, 'utf8')).sessionId || null; if (id) { best = id; bestT = st.mtimeMs; } }
    } catch { /* not this route */ }
  }
  return best;
}
// The turn's ordinal within its session: a small counter per session id in state/, incremented
// per recorded turn. A new session starts at 1; an unknown session counts under 'none'.
function nextTurnIndex(stateDir, sessionId) {
  const f = path.join(stateDir, 'chat-turn-index.json');
  let m = {};
  try { m = JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch { m = {}; }
  const key = sessionId || 'none';
  m[key] = (typeof m[key] === 'number' ? m[key] : 0) + 1;
  // keep the map small: only the newest 20 sessions
  const keys = Object.keys(m); if (keys.length > 20) for (const k of keys.slice(0, keys.length - 20)) delete m[k];
  try { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(f, JSON.stringify(m)); } catch { /* the chain never blocks on this */ }
  return m[key];
}

// Who this agent IS, from the values that name it. The name comes from the one rule the webchat
// brand uses (auth.readAgentName: system/agent.local.yaml, the untracked overlay cloud-init writes
// at provision, else the tracked agent.yaml's default); `profile_name` in agent.yaml is the profile
// brand (Keel, Castor) -- the role and capabilities, not the name. Regex, no yaml parser, so
// identity never depends on one being installed. Profile falls back to .provision-flags
// (AGENT_PROFILE=keel -> Keel) for a tree whose agent.yaml predates the key.
function readIdentity(cwd) {
  const out = { agentName: null, profileName: null };
  try { out.agentName = require('./auth').readAgentName(cwd); } catch { /* auth not beside us: read directly */ }
  try {
    const y = fs.readFileSync(path.join(cwd, 'system', 'agent.yaml'), 'utf8');
    if (!out.agentName) { const a = y.match(/^agent_name:\s*["']?([^"'\n]+?)["']?\s*$/m); if (a) out.agentName = a[1].trim(); }
    const p = y.match(/^profile_name:\s*["']?([^"'\n]+?)["']?\s*$/m); if (p) out.profileName = p[1].trim();
  } catch { /* no agent.yaml: no identity */ }
  if (!out.profileName) {
    try {
      const f = fs.readFileSync(path.join(cwd, '.provision-flags'), 'utf8');
      const m = f.match(/^AGENT_PROFILE=([a-z][a-z0-9-]*)\s*$/m);
      if (m) out.profileName = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    } catch { /* hand-built tree without flags */ }
  }
  return out;
}

// Persona text carries {{AGENT_NAME}} / {{PROFILE_NAME}} placeholders (the mechanism is here; the
// wording is per profile in agent.yaml). Rendered on every read, override or default alike.
function renderPersona(text, identity) {
  if (!text) return text;
  const id = identity || {};
  return String(text)
    .replace(/\{\{\s*AGENT_NAME\s*\}\}/g, id.agentName || 'this agent')
    .replace(/\{\{\s*PROFILE_NAME\s*\}\}/g, id.profileName || 'this');
}

// The name is a fact, stated on every turn like the model is: a persona that still hardcodes the
// profile brand, a resumed transcript in which the agent introduced itself by another name, or a
// memory the model wrote about its own name are all superseded by this line. An agent asked what it
// is called was answering "Keel" on a VM named probe -- the brand reached the page and the card, not
// the conversation. Supplies the fact; the manners stay with the persona.
function identityFact(identity) {
  const id = identity || {};
  if (!id.agentName) return '';
  const prof = id.profileName ? ` You are an instance of the ${id.profileName} profile -- ${id.profileName} names your role and capabilities, not you.` : '';
  return 'IDENTITY (authoritative, refreshed every turn): your name is "' + id.agentName + '".' + prof +
    ' Introduce yourself as ' + id.agentName + (id.profileName ? ` (a ${id.profileName} agent when the profile is relevant)` : '') +
    '. This supersedes any name given earlier in this conversation, in your memory, or in your persona text.';
}
function clearPersona(stateDir) { try { fs.unlinkSync(personaFile(stateDir)); } catch { /* already default */ } }
function hasPersonaOverride(stateDir) { try { fs.accessSync(personaFile(stateDir)); return true; } catch { return false; } }

// Build the `claude` argv. Resumes the stored session when present, else starts fresh; appends
// the agent persona to the system prompt when supplied; denies web tools unless web is enabled.
function buildArgs({ prompt, model, sessionId, persona, webEnabled }) {
  const modelArgs = model ? ['--model', model] : [];
  const resumeArgs = sessionId ? ['--resume', sessionId] : [];
  const personaArgs = (persona && persona.trim()) ? ['--append-system-prompt', persona.trim()] : [];
  const webArgs = webEnabled ? [] : ['--disallowedTools', 'WebSearch,WebFetch'];
  return ['-p', prompt, ...modelArgs, ...resumeArgs, ...personaArgs, ...webArgs, '--output-format', 'stream-json', '--verbose'];
}

// Web research access is a per-agent runtime toggle (state/web-access.json), DEFAULT OFF —
// a structural boundary: the agent literally can't reach the web unless it's turned on.
function webAccessFile(stateDir) { return path.join(stateDir, 'web-access.json'); }
function readWebAccess(stateDir) {
  try { return JSON.parse(fs.readFileSync(webAccessFile(stateDir), 'utf8')).enabled === true; } catch { return false; }
}
function writeWebAccess(stateDir, enabled) {
  return writeWebState(stateDir, { enabled: enabled === true });
}
// The whole runtime web state, prevModel included. The pre-web model used to live in a browser
// tab (PREV_SLUG in webchat-controls), so web toggled OFF from Telegram, the panel, another tab
// or after a reload restored nothing and the agent quietly stayed on the direct-Anthropic model.
// A restore that only works from the surface that did the enable is not a restore; the state
// lives HERE now, and the toggle endpoint is the one place that captures and restores it.
function readWebState(stateDir) {
  try {
    const o = JSON.parse(fs.readFileSync(webAccessFile(stateDir), 'utf8')) || {};
    return { enabled: o.enabled === true, prevModel: typeof o.prevModel === 'string' && o.prevModel ? o.prevModel : null };
  } catch { return { enabled: false, prevModel: null }; }
}
function writeWebState(stateDir, st) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const o = { enabled: (st && st.enabled) === true, updated: new Date().toISOString() };
    if (st && typeof st.prevModel === 'string' && st.prevModel) o.prevModel = st.prevModel;
    fs.writeFileSync(webAccessFile(stateDir), JSON.stringify(o, null, 2));
    return true;
  } catch { return false; }
}

// The toggle DECISION, pure so it is testable without a webchat: given where we are and where
// the operator wants to be, say what to write and what to select. `tiers` is the routing table
// (the single source of model policy), `webMap` maps gateway model_name -> direct model, and a
// model is web-capable when its tier carries a mapped name. Rules:
//   enable, active not web-capable  -> select the first web-capable tier, CAPTURE the active
//   enable, active already capable  -> no switch, nothing captured
//   disable, prevModel on a tier    -> select it back, CLEAR the capture
//   disable, prevModel off the table-> clear it and say so (the table changed; guessing is worse)
//   same-state toggle               -> keep everything, including a held capture
function webToggleDecision({ enable, state, tiers, webMap, active }) {
  const slugOf = (t) => t && (t.slug || t.openrouter_slug) || null;
  const capable = (t) => !!(t && t.model_name && webMap && webMap[t.model_name]);
  const st = state || { enabled: false, prevModel: null };
  if (enable === st.enabled) return { write: { enabled: st.enabled, prevModel: st.prevModel }, select: null, switched: null, restored: null, note: 'no-op' };
  if (enable) {
    const activeTier = (tiers || []).find((t) => slugOf(t) === active) || null;
    if (capable(activeTier)) return { write: { enabled: true, prevModel: null }, select: null, switched: null, restored: null, note: 'active model already web-capable' };
    const target = (tiers || []).find(capable) || null;
    const tslug = slugOf(target);
    if (!tslug) return { write: { enabled: true, prevModel: null }, select: null, switched: null, restored: null, note: 'no web-capable model on any tier (best-effort gateway web)' };
    return { write: { enabled: true, prevModel: active || null }, select: tslug, switched: { from: active || null, to: tslug }, restored: null, note: null };
  }
  const prev = st.prevModel;
  if (!prev) return { write: { enabled: false, prevModel: null }, select: null, switched: null, restored: null, note: 'nothing captured to restore' };
  const onTier = (tiers || []).some((t) => slugOf(t) === prev);
  if (!onTier) return { write: { enabled: false, prevModel: null }, select: null, switched: null, restored: null, note: 'captured model ' + prev + ' is no longer on a routing tier; kept the current model' };
  return { write: { enabled: false, prevModel: null }, select: prev, switched: null, restored: { to: prev }, note: null };
}

// Per-agent web-capable map (WEB_DIRECT_MODELS): comma list of "gatewayName=directModel"
// pairs, e.g. "claude-sonnet-4.5=claude-sonnet-4-6,claude-opus-4.8=claude-opus-4-8".
// Keys are the gateway model_names the picker resolves to; values are the direct Anthropic
// ids that actually run a web turn. Parsed leniently: blank/malformed pairs are skipped.
function webDirectMap(env) {
  const out = {};
  for (const pair of String(((env || {}).WEB_DIRECT_MODELS) || '').split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) { const k = pair.slice(0, i).trim(); const v = pair.slice(i + 1).trim(); if (k && v) out[k] = v; }
  }
  return out;
}

// Extract a session id from a parsed stream-json event, tolerating field-name variants.
function eventSessionId(evt) {
  if (!evt || typeof evt !== 'object') return null;
  return evt.session_id || evt.sessionId || (evt.session && evt.session.id) || null;
}

// Did a failed run fail specifically because the session to resume was gone?
function isMissingSessionError(stderr) {
  return /no\s+(conversation|session)[^.]*found|session[^.]*not\s+found|could not.*resume/i.test(String(stderr || ''));
}

// Did the API reject a RESUMED transcript at request validation? Happens when a session
// authored via the gateway (OpenRouter models / canned tool-failure turns can leave empty
// text blocks in the transcript) is replayed against the strict direct Anthropic API:
// every resumed turn 400s regardless of the new prompt. Recovery = drop the stored
// session and rerun the turn fresh.
function isSessionIncompatError(text) {
  return /content blocks must be non-empty|must have non-empty content/i.test(String(text || ''));
}

// Run one chat turn. onEvent(parsedStreamJsonObject) per line; onDone(code, stderr) at close.
// Returns the FIRST child process (so the caller can kill it on client disconnect).
// If a RESUMED turn is rejected by request validation (isSessionIncompatError -- a
// gateway-era transcript replayed against the strict direct API), the stored session is
// dropped and the turn retried ONCE on a fresh session; the retry streams through the
// same onEvent/onDone. (On client disconnect mid-retry the retry child finishes orphaned;
// its events are swallowed by the try/catch around the callbacks -- bounded and harmless.)
function runChatTurn({ prompt, model, cwd, stateDir, env }, onEvent, onDone) {
  const persona = readPersona(cwd, stateDir);
  const webEnabled = readWebAccess(stateDir);
  const baseEnv = env || process.env;

  // Real web research needs Anthropic's server-side web_search, which the LiteLLM/OpenRouter
  // gateway does NOT run (it returns canned/echoed content). So when web is ON *and* this agent
  // is configured with a direct model (WEB_DIRECT_MODEL -- a per-agent VALUE; only agents holding a
  // real Anthropic key set it), route THIS turn straight to api.anthropic.com: drop the gateway
  // base URL and the gateway-only small-fast alias, use the direct model (+ the real key). Agents
  // without WEB_DIRECT_MODEL keep the gateway path unchanged (best-effort). Web-OFF is never touched.
  let runEnv = baseEnv, runModel = model;
  // Selection-aware: the picked gateway model maps to its direct-Anthropic equivalent via
  // WEB_DIRECT_MODELS; anything unmapped falls back to WEB_DIRECT_MODEL (the agent's default
  // direct model). Neither set -> the turn stays on the gateway (best-effort), as before.
  const directModel = (webDirectMap(baseEnv)[String(model || '').trim()] || (baseEnv.WEB_DIRECT_MODEL || '')).trim();
  if (webEnabled && directModel) {
    runEnv = { ...baseEnv };
    delete runEnv.ANTHROPIC_BASE_URL;          // main + aux -> api.anthropic.com (bypass the gateway)
    // The gateway small-fast alias (claude-haiku-4.5) is invalid at Anthropic, and the CLI's default
    // aux model isn't guaranteed reachable; pin a real dated Anthropic haiku so the CLI's aux/background
    // calls resolve on the direct route too. Overridable per-agent via WEB_DIRECT_SMALL_FAST_MODEL.
    runEnv.ANTHROPIC_SMALL_FAST_MODEL = (baseEnv.WEB_DIRECT_SMALL_FAST_MODEL || 'claude-haiku-4-5-20251001').trim();
    const directKey = (baseEnv.WEB_DIRECT_KEY || '').trim();
    if (directKey) runEnv.ANTHROPIC_API_KEY = directKey;
    runModel = directModel;                    // a real Anthropic model id (gateway slugs aren't valid direct)
  }
  const route = (webEnabled && directModel) ? 'direct' : 'gateway';

  // RUNTIME FACT, restated every turn.
  //
  // --model tells the CLI what to call; it tells the AGENT nothing. Asked "what model are
  // you running?", the agent had no authoritative source and answered from its own
  // training-time self-belief or -- worse, with --resume -- from a model named earlier in
  // a conversation that may have run for weeks under a different selection. Both are
  // confident and unfalsifiable, which is the failure mode worth eliminating: a wrong
  // answer that looks exactly like a right one.
  //
  // The line below is rebuilt on EVERY turn from the value actually being spawned, so it
  // cannot go stale, and it explicitly overrides earlier conversation so a resumed session
  // cannot keep asserting a superseded model. It reports runModel rather than the requested
  // model, which matters on web-enabled turns: those really do execute on the direct
  // Anthropic model, and saying otherwise would be the same lie in the other direction.
  // Volunteering stays governed by the persona -- this supplies the fact, not the manners.
  const modelFact =
    'RUNTIME FACT (authoritative for this turn, refreshed every turn): the active underlying model ' +
    'is "' + String(runModel || '(cli default)') + '", reached via ' +
    (route === 'direct' ? 'a direct Anthropic connection' : 'the local LiteLLM gateway to OpenRouter') +
    '. This supersedes any model named earlier in this conversation -- earlier turns may have run on a ' +
    'different model, and any such statement is now out of date. Never infer the active model from your ' +
    'own self-knowledge or from conversation history; use only this line. State it only if the operator ' +
    'explicitly asks which model is running.';
  const idFact = identityFact(readIdentity(cwd));
  const facts = idFact ? (idFact + '\n\n' + modelFact) : modelFact;
  const turnPersona = (persona && persona.trim())
    ? (persona.trim() + '\n\n' + facts)
    : facts;

  const start = (sessionId, canRetry) => {
    const args = buildArgs({ prompt, model: runModel, sessionId, persona: turnPersona, webEnabled });
    const child = spawn('claude', args, { cwd, env: runEnv });

    let stderr = '', apiErr = '', sawText = false, textBuf = '';
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      let evt;
      try { evt = JSON.parse(line); } catch { return; }
      // Starting fresh (no stored id yet): capture and persist the new session id.
      if (!sessionId) { const sid = eventSessionId(evt); if (sid) writeSessionId(stateDir, sid, route, runModel); }
      if (evt.type === 'assistant' && evt.message && Array.isArray(evt.message.content)) {
        for (const b of evt.message.content) {
          if (b && b.type === 'text' && b.text) { sawText = true; if (textBuf.length < 1200) textBuf += b.text; }
        }
      }
      if (evt.type === 'result' && evt.is_error) apiErr += ' ' + String(evt.result || '');
      try { onEvent(evt); } catch { /* caller error shouldn't kill the stream */ }
    });

    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      // The CLI surfaces an API rejection either as a result error event OR streamed as a bare
      // assistant text line ("API Error: 400 ..."), often with exit code 0 -- so the streamed
      // text is part of the error evidence, and a bare API-error line counts as "nothing real
      // streamed" for the retry guard (a genuine answer that merely QUOTES the phrase is long
      // and doesn't start with "API Error:", so it never triggers recovery).
      const errAll = apiErr + ' ' + stderr + ' ' + textBuf;
      const bareApiError = sawText && textBuf.trim().length < 600 && /^API Error:\s*4\d\d/i.test(textBuf.trim());
      // Stored id but the session itself is gone -> forget it so the next turn starts fresh.
      if (sessionId && isMissingSessionError(errAll)) clearSessionId(stateDir, route, runModel);
      // Resumed transcript rejected by request validation -> drop it, retry ONCE fresh.
      if (canRetry && sessionId && (!sawText || bareApiError) && isSessionIncompatError(errAll)) {
        clearSessionId(stateDir, route, runModel);
        try { onEvent({ type: 'system', subtype: 'session_restart', note: 'stored conversation incompatible with this route; starting fresh' }); } catch { /* ignore */ }
        try { onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: '\n[stored conversation was incompatible with this route -- restarting fresh]\n' }] } }); } catch { /* ignore */ }
        const retry = start(null, false);
        retry.on('error', (e) => { try { onDone(1, 'retry spawn failed: ' + e.message, { resumed: false }); } catch { /* ignore */ } });
        return; // the retry owns onDone
      }
      try { onDone(code, stderr, { resumed: !!sessionId }); } catch { /* ignore */ }
    });

    return child;
  };

  return start(readSessionId(stateDir, route, runModel), true);
}

module.exports = {
  runChatTurn, buildArgs, readSessionId, writeSessionId, clearSessionId,
  sessionFile, eventSessionId, isMissingSessionError, isSessionIncompatError,
  readPersona, defaultPersona, writePersona, clearPersona, hasPersonaOverride, personaFile,
  readIdentity, renderPersona, identityFact, personaFromYaml,
  wsIdentity, turnRecord, currentSessionId, nextTurnIndex,
  readWebAccess, writeWebAccess, readWebState, writeWebState, webToggleDecision, webAccessFile, webDirectMap,
};
