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
    if (m) { cur = { dir: m[1], label: path.basename(m[1]), list: true }; out.push(cur); continue; }
    m = ln.match(/^\s*label:\s*([^\s#]+)/);
    if (m && cur) { cur.label = m[1]; continue; }
    m = ln.match(/^\s*archive:\s*([^\s#]+)/);
    if (m && cur) { cur.archive = m[1]; continue; }
    m = ln.match(/^\s*list:\s*false\b/);
    if (m && cur) cur.list = false;
  }
  return out;
}

function entryFiles(cwd, q) {
  let names = [];
  try { names = fs.readdirSync(path.join(cwd, q.dir)).filter((f) => !f.startsWith('.') && !f.endsWith('.flags.json')); } catch { return []; }
  const out = [];
  for (const f of names) {
    try { if (!fs.statSync(path.join(cwd, q.dir, f)).isFile()) continue; } catch { continue; }
    out.push(f);
  }
  return out;
}

function listQueue(cwd) {
  const items = [];
  for (const q of readSpec(cwd)) {
    if (q.list === false) continue;
    for (const f of entryFiles(cwd, q)) items.push({ dir: q.dir, label: q.label, name: f });
  }
  return items;
}

// Operator clear: move a queued file (and its .flags.json sidecar, so profile
// counts drop with it) into the entry's per-agent archive dir. Local move only --
// nothing leaves the machine. Entries without an archive: value are not clearable.
function archiveItems(cwd, target) {
  const moved = [];
  const mv = (src, dst) => { fs.copyFileSync(src, dst); fs.unlinkSync(src); };
  for (const q of readSpec(cwd)) {
    if (!q.archive) continue;
    for (const f of entryFiles(cwd, q)) {
      if (target !== '--all' && target !== q.label + '/' + f) continue;
      const destDir = path.join(cwd, q.archive);
      fs.mkdirSync(destDir, { recursive: true });
      let destName = f;
      if (fs.existsSync(path.join(destDir, destName))) destName = Date.now() + '-' + f;
      mv(path.join(cwd, q.dir, f), path.join(destDir, destName));
      const sc = path.join(cwd, q.dir, f + '.flags.json');
      if (fs.existsSync(sc)) mv(sc, path.join(destDir, destName + '.flags.json'));
      moved.push({ label: q.label, name: f, to: q.archive });
    }
  }
  return moved;
}

module.exports = { listQueue, readSpec, archiveItems };

// CLI mode (the /queue skill): print the queue deterministically so the agent's
// conversational layer and the panel read from the same source of truth.
if (require.main === module) {
  const cwd = process.env.AGENT_ROOT || process.env.KEEL_DIR || process.cwd();
  const verb = process.argv[2];
  if (verb === 'archive') {
    const target = process.argv[3];
    if (!target) { console.log('usage: queue.js archive <label>/<name> | --all'); process.exit(2); }
    const moved = archiveItems(cwd, target);
    if (!moved.length) { console.log('(nothing to clear)'); }
    else {
      for (const m of moved) console.log('archived: ' + m.label + '/' + m.name + ' -> ' + m.to);
      console.log(moved.length + ' archived');
    }
  } else {
    const items = listQueue(cwd);
    if (!items.length) { console.log('(queue empty)'); }
    else {
      for (const i of items) console.log(i.label + '/' + i.name);
      console.log(items.length + ' item(s) queued');
    }
  }
}
