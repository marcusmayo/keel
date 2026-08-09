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
// ---------------------------------------------------------------------------
// ASYNC JOB LANE (why the route no longer blocks)
//
// Spawn entries previously ran through execFileSync, which parks the single Node
// event loop for the FULL duration of the tool. A 80s scoring pass therefore made
// the agent unreachable to every other caller for 80s -- including its own /color
// and /pending probes, which is what blanked the agent card in the control plane.
// Declared budgets in skills.yaml run 15s..260s while the control-plane HTTP relay
// caps at 10s, so a blocking route could not be reconciled by raising a timeout:
// a longer ceiling just moves the starvation, it does not remove it.
//
// Spawn entries now start a JOB and return 202 immediately. A long tool CANNOT
// starve the probe regardless of what any budget says -- the guarantee is
// structural, not a tuned value. refreshRecordsAsync already used this exact
// pattern (execFile, non-blocking) for the same stated reason; the route handler
// now matches it.
//
// Response shapes:
//   spawn start   -> 202 { ok: true, status: 'running', jobId, route, startedAt }
//   precondition  -> 200 { ok: false, output: missingMsg }        (no job created)
//   poll          -> 200 { ok, status: 'running'|'done', jobId, output, durationMs, ... }
//   handler entry -> unchanged; bespoke handlers keep their own shape.
//
// Terminal jobs persist to state/skill-jobs/<jobId>.json (state is volume-backed),
// carrying actor + route + exitCode + duration + outcome: a durable data-plane
// event stream for the audit lane. record: entries still ALSO write
// state/compliance/<record>.json in the prior {ok, output, ranAt} shape, so the
// compliance board reads exactly what it read before.
// ---------------------------------------------------------------------------

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, execFile } = require('child_process');

const JOB_CAP = 200;              // in-memory AND on-disk retention
const OUT_CAP = 256 * 1024;       // persisted output ceiling per job
const JOBS = new Map();           // jobId -> job (newest last)

function jobsDir(cwd) { return path.join(cwd, 'state', 'skill-jobs'); }

// Actor for the audit trail. Cloudflare Access stamps the authenticated identity
// on every edge-authenticated request; service-token callers (Aegis) present the
// client-id instead. Never throws, never blocks -- unknown is a valid actor.
function actorOf(req) {
  try {
    const h = (req && req.headers) || {};
    return String(h['cf-access-authenticated-user-email']
      || h['cf-access-client-id']
      || h['x-actor']
      || 'unknown').slice(0, 200);
  } catch (e) { return 'unknown'; }
}

function pruneJobs(dir) {
  try {
    const names = fs.readdirSync(dir).filter(n => n.endsWith('.json'));
    if (names.length <= JOB_CAP) return;
    const stamped = names
      .map(n => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => a.t - b.t);
    for (const x of stamped.slice(0, stamped.length - JOB_CAP)) {
      fs.unlinkSync(path.join(dir, x.n));
    }
  } catch (e) { /* retention is best-effort; never fail a run over it */ }
}

function persistJob(cwd, job) {
  try {
    const dir = jobsDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, job.jobId + '.json'), JSON.stringify(job, null, 2));
    pruneJobs(dir);
  } catch (e) { job.persistError = String(e); }
}

// SYNCHRONOUS spawn -- retained verbatim for refreshRecords() and any per-agent
// caller that legitimately wants to block (CLI entry points, boot-time evidence).
// Route handlers no longer use it.
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

// NON-BLOCKING spawn. Returns the job record synchronously (status 'running');
// the child runs on its own and the job is completed + persisted on exit.
function startSkillJob({ bin, args, timeout, cwd, record, route, actor }) {
  const jobId = Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
  const job = {
    jobId,
    route: route || null,
    actor: actor || 'unknown',
    bin,
    args: (args || []).map(String),
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
    durationMs: null,
    ok: null,
    exitCode: null,
    timedOut: false,
    output: '',
    record: record || null,
  };
  JOBS.set(jobId, job);
  while (JOBS.size > JOB_CAP) JOBS.delete(JOBS.keys().next().value);

  const t0 = Date.now();
  execFile(bin, job.args,
    { cwd, encoding: 'utf8', timeout: timeout || 30000, maxBuffer: 32 * 1024 * 1024 },
    (err, stdout, stderr) => {
      job.endedAt = new Date().toISOString();
      job.durationMs = Date.now() - t0;
      job.status = 'done';
      job.ok = !err;
      job.timedOut = !!(err && err.killed);
      job.exitCode = err ? (typeof err.code === 'number' ? err.code : null) : 0;
      let out = err ? ((stdout || '') + (stderr || '') + String(err)) : (stdout || '');
      if (out.length > OUT_CAP) { out = out.slice(0, OUT_CAP); job.outputTruncated = true; }
      job.output = out;

      // Prior evidence contract, byte-identical shape: the compliance board is unchanged.
      if (record) {
        try {
          const dir = path.join(cwd, 'state', 'compliance');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, record + '.json'),
                           JSON.stringify({ ok: job.ok, output: job.output, ranAt: job.endedAt }, null, 2));
        } catch (e) { job.persistError = String(e); }
      }
      persistJob(cwd, job);
    });
  return job;
}

// Memory first (in-flight + recent), then disk (survives container recreate).
function getJob(cwd, jobId) {
  if (!/^[a-z0-9-]{4,64}$/.test(String(jobId || ''))) return null;
  const live = JOBS.get(jobId);
  if (live) return live;
  try {
    return JSON.parse(fs.readFileSync(path.join(jobsDir(cwd), jobId + '.json'), 'utf8'));
  } catch (e) { return null; }
}

function listJobs(cwd, limit) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 25, 1), JOB_CAP);
  const seen = new Map();
  try {
    for (const name of fs.readdirSync(jobsDir(cwd))) {
      if (!name.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(jobsDir(cwd), name), 'utf8'));
        if (j && j.jobId) seen.set(j.jobId, j);
      } catch (e) { /* skip unreadable record */ }
    }
  } catch (e) { /* no jobs yet */ }
  for (const [id, j] of JOBS) seen.set(id, j);   // live entries win over disk
  return [...seen.values()]
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, n)
    .map(j => ({
      jobId: j.jobId, route: j.route, actor: j.actor, status: j.status, ok: j.ok,
      exitCode: j.exitCode, timedOut: j.timedOut, startedAt: j.startedAt,
      endedAt: j.endedAt, durationMs: j.durationMs,
    }));
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
      const job = startSkillJob({
        bin: s.bin, args: s.args, timeout: s.timeout, cwd, record: s.record,
        route: s.route, actor: actorOf(req),
      });
      return res.status(202).json({
        ok: true, status: 'running', jobId: job.jobId, route: s.route, startedAt: job.startedAt,
      });
    });
  }

  // Poll target for the 202 above. 404 on an unknown id -- a client that lost its
  // jobId gets an honest miss, never a fabricated 'done'.
  app.get('/skill-status/:id', requireAuth, (req, res) => {
    const job = getJob(cwd, req.params.id);
    if (!job) return res.status(404).json({ ok: false, status: 'unknown', output: 'no such job' });
    return res.json({
      ok: job.ok, status: job.status, jobId: job.jobId, route: job.route,
      output: job.output, exitCode: job.exitCode, timedOut: job.timedOut,
      startedAt: job.startedAt, endedAt: job.endedAt, durationMs: job.durationMs,
      outputTruncated: !!job.outputTruncated,
    });
  });

  // Durable run history -- the data-plane event stream the audit lane consumes.
  app.get('/skill-jobs', requireAuth, (req, res) =>
    res.json({ ok: true, jobs: listJobs(cwd, req.query && req.query.limit) }));

  // Panel-facing catalogue: the same declarative list, minus spawn internals.
  app.get('/skills', requireAuth, (req, res) => res.json({ ok: true, skills: list.map(x => ({
    route: x.route, method: (x.method || 'get').toUpperCase(), name: x.name || x.route, summary: x.summary || x.desc || '',
  })) }));
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

module.exports = {
  mountSkills, loadSkills, runSkillSpawn, refreshRecords, refreshRecordsAsync,
  startSkillJob, getJob, listJobs,
};
