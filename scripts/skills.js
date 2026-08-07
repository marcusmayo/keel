// skills.js -- fleet-core shared skill/pipeline invocation.
// MECHANISM lives here (route registration, auth, spawn wrapper, timeout, error shape,
// optional precondition + record-to-state); each agent supplies VALUES in system/skills.yaml
// plus, for bespoke routes, named handler functions passed via opts.handlers (the functions
// stay verbatim in that agent's server.js -- handler-preserving extraction).
//
// system/skills.yaml:
//   skills:
//     - route: /run-reconcile          # required; mounted behind requireAuth
//       bin: python3                   # spawn entry: bin + args (+ timeout ms, default 30000)
//       args: [tools/reconcile.py]
//       timeout: 30000
//       method: get                    # optional, default get
//       requireFile: exports/inbound/pending-edit.xlsx   # optional precondition (cwd-relative)
//       missingMsg: no pending portfolio edit - upload an edited export first
//       record: audit-verify           # optional: persist result to state/compliance/<record>.json
//       label: Reconcile               # optional UI metadata (cheat-sheet), ignored here
//       category: Portfolio
//     - route: /run-merge
//       handler: merge                 # handler entry: resolved from opts.handlers.merge
//
// Response shape is identical to the pre-extraction inline handlers:
//   success  -> { ok: true,  output: <stdout> }                   (+ ranAt when record:)
//   failure  -> { ok: false, output: stdout+stderr+String(e) }    (+ ranAt when record:)
//   missing  -> { ok: false, output: missingMsg }
// Spawns stay execFileSync (same semantics as before; argv, no shell).

'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// One spawn, one shape. record: also persists the result to state/compliance/<record>.json
// and never throws -- a failing tool (exit 1) comes back as ok:false, not a route failure;
// a failed persist is reported on the record as persistError, matching the prior behavior.
function runSkillSpawn({ bin, args, timeout, cwd, record }) {
  let rec;
  try {
    const out = execFileSync(bin, (args || []).map(String),
                             { cwd, encoding: 'utf8', timeout: timeout || 30000 });
    rec = { ok: true, output: out };
  } catch (e) {
    rec = { ok: false, output: (e.stdout || '') + (e.stderr || '') + String(e) };
  }
  if (record) {
    rec.ranAt = new Date().toISOString();
    try {
      const dir = path.join(cwd, 'state', 'compliance');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, record + '.json'), JSON.stringify(rec, null, 2));
    } catch (e) {
      rec.persistError = String(e);
    }
  }
  return rec;
}

function loadSkills(cwd) {
  const yaml = require('js-yaml');
  const doc = yaml.load(fs.readFileSync(path.join(cwd, 'system', 'skills.yaml'), 'utf8'));
  if (!doc || !Array.isArray(doc.skills)) throw new Error('skills.yaml: expected top-level skills: [ ... ]');
  return doc.skills;
}

// Mount every entry. Fails LOUD at boot (throws) on a malformed entry or an unknown
// handler name -- a misconfigured skill set should stop the server, not 500 at request time.
function mountSkills(app, { requireAuth, cwd, skills, handlers }) {
  const list = skills || loadSkills(cwd);
  const fns = handlers || {};
  for (const s of list) {
    if (!s || !s.route) throw new Error('skills.yaml: entry missing route');
    const method = (s.method || 'get').toLowerCase();
    if (s.handler) {
      const fn = fns[s.handler];
      if (typeof fn !== 'function') throw new Error('skills.yaml: no handler function named "' + s.handler + '" for ' + s.route);
      app[method](s.route, requireAuth, fn);
      continue;
    }
    if (!s.bin) throw new Error('skills.yaml: entry ' + s.route + ' needs bin+args or handler');
    app[method](s.route, requireAuth, (req, res) => {
      if (s.requireFile && !fs.existsSync(path.join(cwd, s.requireFile))) {
        return res.json({ ok: false, output: s.missingMsg || ('missing required file: ' + s.requireFile) });
      }
      res.json(runSkillSpawn({ bin: s.bin, args: s.args, timeout: s.timeout, cwd, record: s.record }));
    });
  }
  return list.map(s => s.route);
}

// Run every record: spawn entry in system/skills.yaml (the compliance evidence set).
// Used by the /compliance-report pre-step so refreshing evidence stays declarative:
// adding a writer to the yaml adds it to the report with no server.js change.
function refreshRecords(cwd) {
  const out = [];
  for (const s of loadSkills(cwd)) {
    if (!s || !s.record || !s.bin) continue;
    const r = runSkillSpawn({ bin: s.bin, args: s.args, timeout: s.timeout, cwd, record: s.record });
    out.push({ record: s.record, ok: r.ok });
  }
  return out;
}

// Async twin of refreshRecords: runs every record: entry in PARALLEL via execFile
// so a server can await the refresh WITHOUT blocking its own event loop -- the
// edge-auth writer probes the running server, which must stay free to serve the
// 403. Persists identical {ok, output, ranAt} evidence shapes.
function refreshRecordsAsync(cwd, cb) {
  const { execFile } = require('child_process');
  const entries = loadSkills(cwd).filter(s => s && s.record && s.bin);
  if (!entries.length) return cb([]);
  const out = []; let left = entries.length;
  for (const s of entries) {
    execFile(s.bin, (s.args || []).map(String), { cwd, encoding: 'utf8', timeout: s.timeout || 30000 },
      (err, stdout, stderr) => {
        const rec = err
          ? { ok: false, output: (stdout || '') + (stderr || '') + String(err) }
          : { ok: true, output: stdout };
        rec.ranAt = new Date().toISOString();
        try {
          const dir = path.join(cwd, 'state', 'compliance');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, s.record + '.json'), JSON.stringify(rec, null, 2));
        } catch (e) { rec.persistError = String(e); }
        out.push({ record: s.record, ok: rec.ok });
        if (--left === 0) cb(out);
      });
  }
}

module.exports = { mountSkills, loadSkills, runSkillSpawn, refreshRecords, refreshRecordsAsync };
