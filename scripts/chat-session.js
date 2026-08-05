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

function sessionFile(stateDir) { return path.join(stateDir, 'chat-session.json'); }

function readSessionId(stateDir) {
  try { return JSON.parse(fs.readFileSync(sessionFile(stateDir), 'utf8')).sessionId || null; }
  catch { return null; }
}

function writeSessionId(stateDir, id) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(sessionFile(stateDir), JSON.stringify({ sessionId: id, updated: new Date().toISOString() }, null, 2));
    return true;
  } catch { return false; }
}

function clearSessionId(stateDir) {
  try { fs.unlinkSync(sessionFile(stateDir)); } catch { /* already absent */ }
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
// the agent persona to the system prompt when one is supplied.
function buildArgs({ prompt, model, sessionId, persona }) {
  const modelArgs = model ? ['--model', model] : [];
  const resumeArgs = sessionId ? ['--resume', sessionId] : [];
  const personaArgs = (persona && persona.trim()) ? ['--append-system-prompt', persona.trim()] : [];
  return ['-p', prompt, ...modelArgs, ...resumeArgs, ...personaArgs, '--output-format', 'stream-json', '--verbose'];
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

// Run one chat turn. onEvent(parsedStreamJsonObject) per line; onDone(code, stderr) at close.
// Returns the child process (so the caller can kill it on client disconnect).
function runChatTurn({ prompt, model, cwd, stateDir, env }, onEvent, onDone) {
  const resumeId = readSessionId(stateDir);
  const persona = readPersona(cwd, stateDir);
  const args = buildArgs({ prompt, model, sessionId: resumeId, persona });
  const child = spawn('claude', args, { cwd, env: env || process.env });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    let evt;
    try { evt = JSON.parse(line); } catch { return; }
    // Starting fresh (no stored id yet): capture and persist the new session id.
    if (!resumeId) { const sid = eventSessionId(evt); if (sid) writeSessionId(stateDir, sid); }
    try { onEvent(evt); } catch { /* caller error shouldn't kill the stream */ }
  });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  child.on('close', (code) => {
    // Stored id but resume failed -> transcript is gone; forget it so next turn starts fresh.
    if (code !== 0 && resumeId && isMissingSessionError(stderr)) clearSessionId(stateDir);
    try { onDone(code, stderr, { resumed: !!resumeId }); } catch { /* ignore */ }
  });

  return child;
}

module.exports = {
  runChatTurn, buildArgs, readSessionId, writeSessionId, clearSessionId,
  sessionFile, eventSessionId, isMissingSessionError,
  readPersona, defaultPersona, writePersona, clearPersona, hasPersonaOverride, personaFile,
};
