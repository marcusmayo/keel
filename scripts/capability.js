/**
 * capability.js -- capability registry reader and structural guard.
 *
 * The registry (system/capabilities.yaml) is shipped and committed. The
 * operator's choices live in state/capabilities.json, which is gitignored
 * because it is deployment state, not code.
 *
 * Guard contract: a script that needs an optional integration calls
 * requireCapability(id) at the top. If the capability is not enabled the
 * process exits non-zero with a named message telling the operator exactly
 * how to turn it on. It does not run and quietly do nothing -- the same
 * fail-closed principle as the egress tripwire.
 *
 * This module never reads, writes, or logs a secret value.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const AGENT_ROOT = process.env.AGENT_ROOT || path.dirname(__dirname);
const REGISTRY = process.env.CAPABILITY_REGISTRY
  || path.join(AGENT_ROOT, 'system', 'capabilities.yaml');
const STATE = process.env.CAPABILITY_STATE
  || path.join(AGENT_ROOT, 'state', 'capabilities.json');

// Shared optional-integration registry, vendored from fleet-core next to this module.
// Merged with the per-profile registry so every agent inherits the same optional
// capabilities; a per-profile entry with the same id wins. Absent => no shared caps.
const SHARED_REGISTRY = process.env.CAPABILITY_SHARED_REGISTRY
  || path.join(__dirname, 'capabilities-shared.yaml');

function readCaps(file, required) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (required) throw new Error(`capability registry unreadable at ${file}: ${e.message}`);
    return []; // optional shared registry absent -- no shared capabilities
  }
  const doc = yaml.load(raw);
  const caps = (doc && doc.capabilities) || [];
  if (!Array.isArray(caps)) throw new Error(`capability registry at ${file} is malformed (capabilities not a list)`);
  for (const c of caps) {
    if (!c.id) throw new Error(`capability registry at ${file} contains an entry with no id`);
  }
  return caps;
}

function loadRegistry() {
  const own = readCaps(REGISTRY, true);            // per-profile registry (required)
  const shared = readCaps(SHARED_REGISTRY, false); // shared optional registry (may be absent)
  const byId = new Map();
  for (const c of own) byId.set(c.id, c);          // per-profile entries first; win on id collision
  for (const c of shared) if (!byId.has(c.id)) byId.set(c.id, c);
  const caps = Array.from(byId.values());
  if (caps.length === 0) {
    throw new Error(`capability registry at ${REGISTRY} defines no capabilities`);
  }
  return caps;
}

function get(id) {
  const c = loadRegistry().find(c => c.id === id);
  if (!c) throw new Error(`unknown capability: ${id}`);
  return c;
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

// 'enabled' | 'declined' | 'unset'. Required capabilities are never 'unset'
// in effect -- they are reported as configured or not, and callers must treat
// a missing required capability as fatal.
function status(id) {
  const entry = loadState()[id];
  if (!entry) return 'unset';
  return entry.status === 'enabled' ? 'enabled' : 'declined';
}

function setStatus(id, newStatus, note) {
  if (!['enabled', 'declined'].includes(newStatus)) {
    throw new Error(`invalid status: ${newStatus}`);
  }
  get(id); // validates the id exists
  const state = loadState();
  state[id] = {
    status: newStatus,
    decided_at: new Date().toISOString(),
    ...(note ? { note } : {}),
  };
  saveState(state);
  return state[id];
}

// Structural guard. Call at the top of any script gated on a capability.
function requireCapability(id) {
  const cap = get(id);
  const s = status(id);
  if (s === 'enabled') return cap;

  const reason = s === 'declined'
    ? 'was declined during setup'
    : 'has not been configured';

  const lines = [
    '',
    `${cap.name} is not enabled -- this process will not start.`,
    '',
    `Capability "${cap.id}" ${reason}.`,
    '',
    'What is unavailable without it:',
    ...(cap.without || []).map(w => '  - ' + String(w).trim()),
    '',
    'To enable it:',
    `  node scripts/setup-wizard.js --enable ${cap.id}`,
    '',
    'To review all capabilities:',
    '  node scripts/setup-wizard.js --status',
    '',
  ];
  console.error(lines.join('\n'));
  process.exit(78); // EX_CONFIG
}

module.exports = {
  loadRegistry, get, loadState, saveState, status, setStatus, requireCapability,
  REGISTRY, SHARED_REGISTRY, STATE, AGENT_ROOT,
};
