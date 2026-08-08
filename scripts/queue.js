'use strict';
// fleet-core: queue visibility -- counts the per-agent queue dirs declared in
// system/agent.yaml under `queue:` (list of {dir, label}). Mechanism in core;
// the VALUES (which dirs mean "queued" for this profile) are per agent.
// Zero-dep yaml read; fails OPEN to an empty list so a broken agent.yaml can
// never 500 the /pending endpoint (visibility must not take the panel down).
const fs = require('fs');
const path = require('path');

function readSpec(cwd) {
  let raw = '';
  try { raw = fs.readFileSync(path.join(cwd, 'system', 'agent.yaml'), 'utf8'); } catch { return []; }
  const out = []; let inQ = false; let cur = null;
  for (const ln of raw.split(/\r?\n/)) {
    if (/^queue:\s*$/.test(ln)) { inQ = true; continue; }
    if (inQ && /^[A-Za-z_]/.test(ln)) inQ = false;
    if (!inQ) continue;
    let m = ln.match(/^\s*-\s*dir:\s*([^\s#]+)/);
    if (m) { cur = { dir: m[1], label: path.basename(m[1]) }; out.push(cur); continue; }
    m = ln.match(/^\s*label:\s*([^\s#]+)/);
    if (m && cur) cur.label = m[1];
  }
  return out;
}

function listQueue(cwd) {
  const items = [];
  for (const q of readSpec(cwd)) {
    let names = [];
    try { names = fs.readdirSync(path.join(cwd, q.dir)).filter((f) => !f.startsWith('.')); } catch { continue; }
    for (const f of names) {
      try { if (!fs.statSync(path.join(cwd, q.dir, f)).isFile()) continue; } catch { continue; }
      items.push({ dir: q.dir, label: q.label, name: f });
    }
  }
  return items;
}

module.exports = { listQueue, readSpec };

// CLI mode (the /queue skill): print the queue deterministically so the agent's
// conversational layer and the panel read from the same source of truth.
if (require.main === module) {
  const cwd = process.env.AGENT_ROOT || process.env.KEEL_DIR || process.cwd();
  const items = listQueue(cwd);
  if (!items.length) { console.log('(queue empty)'); }
  else {
    for (const i of items) console.log(i.label + '/' + i.name);
    console.log(items.length + ' item(s) queued');
  }
}

