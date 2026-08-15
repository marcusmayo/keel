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
function sessionFile(stateDir, route) {
  return path.join(stateDir, route === 'direct' ? 'chat-session-direct.json' : 'chat-session.json');
}

function readSessionId(stateDir, route) {
  try { return JSON.parse(fs.readFileSync(sessionFile(stateDir, route), 'utf8')).sessionId || null; }
  catch { return null; }
}

function writeSessionId(stateDir, id, route) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(sessionFile(stateDir, route), JSON.stringify({ sessionId: id, updated: new Date().toISOString() }, null, 2));
    return true;
  } catch { return false; }
}

function clearSessionId(stateDir, route) {
  // route omitted (e.g. the /session/reset endpoint) -> clear BOTH routes: a "new conversation".
  const routes = route ? [route] : ['gateway', 'direct'];
  for (const r of routes) { try { fs.unlinkSync(sessionFile(stateDir, r)); } catch { /* absent */ } }
}

// Read the agent's conversational identity. A runtime override in state/persona.txt (editable
// with no rebuild) wins over the baked agent.yaml default. Appended to the system prompt each turn.
function personaFile(stateDir) { return path.join(stateDir, 'persona.txt'); }
function readPersona(cwd, stateDir) {
  if (stateDir) { try { const t = fs.readFileSync(personaFile(stateDir), 'utf8'); if (t && t.trim()) return t.trim(); } catch { /* no override */ } }
  try {
    const yaml = require('js-yaml');
    const doc = yaml.load(fs.readFileSync(path.join(cwd, 'system', 'agent.yaml'), 'utf8'));
    return (doc && typeof doc.persona === 'string' && doc.persona.trim()) ? doc.persona.trim() : null;
  } catch { return null; }
}
function defaultPersona(cwd) {  // the baked agent.yaml persona, ignoring any override
  try {
    const yaml = require('js-yaml');
    const doc = yaml.load(fs.readFileSync(path.join(cwd, 'system', 'agent.yaml'), 'utf8'));
    return (doc && typeof doc.persona === 'string' && doc.persona.trim()) ? doc.persona.trim() : null;
  } catch { return null; }
}
function writePersona(stateDir, text) { try { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(personaFile(stateDir), String(text || '')); return true; } catch { return false; } }
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
  try { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(webAccessFile(stateDir), JSON.stringify({ enabled: enabled === true, updated: new Date().toISOString() }, null, 2)); return true; } catch { return false; }
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
  const turnPersona = (persona && persona.trim())
    ? (persona.trim() + '\n\n' + modelFact)
    : modelFact;

  const start = (sessionId, canRetry) => {
    const args = buildArgs({ prompt, model: runModel, sessionId, persona: turnPersona, webEnabled });
    const child = spawn('claude', args, { cwd, env: runEnv });

    let stderr = '', apiErr = '', sawText = false, textBuf = '';
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      let evt;
      try { evt = JSON.parse(line); } catch { return; }
      // Starting fresh (no stored id yet): capture and persist the new session id.
      if (!sessionId) { const sid = eventSessionId(evt); if (sid) writeSessionId(stateDir, sid, route); }
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
      if (sessionId && isMissingSessionError(errAll)) clearSessionId(stateDir, route);
      // Resumed transcript rejected by request validation -> drop it, retry ONCE fresh.
      if (canRetry && sessionId && (!sawText || bareApiError) && isSessionIncompatError(errAll)) {
        clearSessionId(stateDir, route);
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

  return start(readSessionId(stateDir, route), true);
}

module.exports = {
  runChatTurn, buildArgs, readSessionId, writeSessionId, clearSessionId,
  sessionFile, eventSessionId, isMissingSessionError, isSessionIncompatError,
  readPersona, defaultPersona, writePersona, clearPersona, hasPersonaOverride, personaFile,
  readWebAccess, writeWebAccess, webAccessFile, webDirectMap,
};
