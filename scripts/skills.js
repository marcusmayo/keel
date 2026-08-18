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

// The agent already keeps an append-only, hash-chained audit log (gate/audit.js via
// audit-log.js) -- but only the redaction gate ever wrote to it, so the DATA PLANE
// (every skill run) was absent from the one surface designed to be tamper-evident.
// A chain that records nothing verifies perfectly, which is the weakest possible
// kind of green. Terminal skill results are now recorded there as metadata only,
// matching the durable job record: no stdout, just its SHA-256.
//
// Logging is fail-OPEN: an unwritable log must not take the fleet down. The gap is
// caught instead by the audit-verify control, which cross-checks job records against
// chain entries -- so a silently broken audit lane surfaces as RED rather than as a
// skill that refuses to run. (Fail-CLOSED -- refuse to act when the action cannot be
// audited -- is the stricter alternative and a deliberate operator decision, not a
// default to slip in.)
let auditRecord = null;
try { auditRecord = require('./audit-log.js').record; } catch (e) { auditRecord = null; }

const JOB_CAP = 200;              // in-memory AND on-disk retention
const OUT_CAP = 256 * 1024;       // persisted output ceiling per job
const JOBS = new Map();           // jobId -> job (newest last)

function jobsDir(cwd) { return path.join(cwd, 'state', 'skill-jobs'); }

// Actor for the audit trail. Cloudflare Access stamps the authenticated identity
// on every edge-authenticated request; service-token callers (Aegis) present the
// client-id instead. Never throws, never blocks -- unknown is a valid actor.
// Cloudflare Access terminates auth at the edge and forwards a signed assertion; the
// origin is reachable only through the tunnel, so the assertion is taken at face value
// (same trust model as fleet-core auth.js). A HUMAN login yields email; a SERVICE TOKEN
// yields common_name -- which is why the control plane shows up as its token name and
// never as the operator.
function jwtClaim(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const pad = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(Buffer.from(pad, 'base64').toString('utf8'));
    return claims.email || claims.common_name || null;
  } catch (e) { return null; }
}

// Friendly names for verified identities, from system/agent.yaml `actor_labels`
// (MECHANISM here, VALUES per agent). Cloudflare forwards a service token as an opaque
// client-id, so a ledger of raw UUIDs is verified but unreadable.
//
// The label NEVER replaces the id. The client-id is what Cloudflare actually verified;
// the label is a local naming convention this repo controls and can be edited freely.
// Keeping them in separate fields means renaming a label cannot rewrite who acted, and
// history stays groupable by the stable identifier -- the same rule that keeps actor
// and onBehalfOf apart. Fails OPEN to no labels: a broken agent.yaml must never stop a
// skill from running, it just costs readability.
let LABELS = { at: 0, map: {} };
function actorLabels(cwd) {
  try {
    const f = path.join(cwd, 'system', 'agent.yaml');
    const mt = fs.statSync(f).mtimeMs;
    if (mt !== LABELS.at) {
      const doc = require('js-yaml').load(fs.readFileSync(f, 'utf8')) || {};
      const raw = doc.actor_labels || {};
      const map = {};
      for (const k of Object.keys(raw)) map[String(k)] = String(raw[k]).slice(0, 120);
      LABELS = { at: mt, map };
    }
  } catch (e) { LABELS = { at: LABELS.at, map: LABELS.map || {} }; }
  return LABELS.map;
}

// WHO called: verified by the edge. Never invented -- an unattributable request is
// recorded as unattributed rather than being given a plausible-looking identity.
function actorOf(req, cwd) {
  try {
    const h = (req && req.headers) || {};
    const cap = (v) => String(v).slice(0, 200);
    const tag = (src, id) => {
      const out = { src, id: cap(id) };
      const label = cwd ? actorLabels(cwd)[out.id] : null;
      if (label) out.label = label;
      return out;
    };
    const claim = jwtClaim(h['cf-access-jwt-assertion']);
    if (claim) return tag('cf-access', claim);
    if (h['cf-access-authenticated-user-email']) return tag('cf-access', h['cf-access-authenticated-user-email']);
    if (h['cf-access-client-id']) return tag('cf-access', h['cf-access-client-id']);
    return { src: 'unknown', id: 'unattributed' };
  } catch (e) { return { src: 'unknown', id: 'unattributed' }; }
}

// WHO it was FOR: asserted by the caller, NOT verifiable here. Kept in its own field so
// the record never implies the agent checked something it cannot check. Two guards make
// the assertion meaningful rather than free-form: it is honored only when the caller
// itself authenticated (so an unattributed request cannot claim to act for anyone), and
// assertedBy is taken from the VERIFIED actor rather than from the header -- so every
// claim is permanently tied to the identity that made it.
function onBehalfOf(req, actor) {
  try {
    if (!actor || actor.src === 'unknown') return null;
    const raw = String(((req && req.headers) || {})['x-aegis-on-behalf-of'] || '').trim();
    if (!raw) return null;
    const i = raw.indexOf(':');
    if (i < 1 || i === raw.length - 1) return null;
    const src = raw.slice(0, i).replace(/[^a-z-]/gi, '').slice(0, 40);
    const id = raw.slice(i + 1).replace(/[^\x20-\x7e]/g, '').slice(0, 200);
    if (!src || !id) return null;
    return { src, id, assertedBy: actor.id };
  } catch (e) { return null; }
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

// The durable record carries NO tool stdout -- structurally, not by policy.
// A scanner's output quotes the very PII it found, so persisting stdout would make
// state/skill-jobs/ a surface that reports itself on the next secrets scan (the
// evidence-eats-output loop state/compliance/ was excluded for). Rather than add a
// second exclusion someone must remember to extend, the surface simply cannot hold
// tool output: metadata plus a SHA-256 of the stdout, which proves what was returned
// without storing it. Live output stays in the in-memory registry for polling.
function persistJob(cwd, job) {
  try {
    const dir = jobsDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    const meta = {};
    for (const k of Object.keys(job)) { if (k !== 'output') meta[k] = job[k]; }
    meta.outputBytes = Buffer.byteLength(job.output || '', 'utf8');
    meta.outputSha256 = crypto.createHash('sha256').update(String(job.output || ''), 'utf8').digest('hex');
    meta.outputPersisted = false;
    fs.writeFileSync(path.join(dir, job.jobId + '.json'), JSON.stringify(meta, null, 2));
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
function startSkillJob({ bin, args, timeout, cwd, record, route, actor, onBehalf }) {
  const jobId = Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
  const job = {
    jobId,
    route: route || null,
    actor: actor || { src: 'unknown', id: 'unattributed' },
    onBehalfOf: onBehalf || null,
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
      job.outputBytes = Buffer.byteLength(out, 'utf8');
      job.outputSha256 = crypto.createHash('sha256').update(out, 'utf8').digest('hex');

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

      // Data-plane event -> the hash-chained log. Metadata only, same posture as the
      // durable record: WHO (verified) and FOR WHOM (asserted), what ran, how it ended,
      // and the digest of what came back -- never the output itself.
      if (auditRecord) {
        try {
          auditRecord({
            event: 'skill-run',
            jobId: job.jobId, route: job.route,
            actor: job.actor, onBehalfOf: job.onBehalfOf,
            ok: job.ok, exitCode: job.exitCode, timedOut: job.timedOut,
            durationMs: job.durationMs,
            outputBytes: job.outputBytes, outputSha256: job.outputSha256,
          });
        } catch (e) { job.auditError = String(e).slice(0, 200); persistJob(cwd, job); }
      }
    });
  return job;
}

// Memory first (in-flight + recent), then disk (survives container recreate).
function getJob(cwd, jobId) {
  if (!/^[a-z0-9-]{4,64}$/.test(String(jobId || ''))) return null;
  const live = JOBS.get(jobId);
  if (live) return live;
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(jobsDir(cwd), jobId + '.json'), 'utf8'));
    // Disk records hold no stdout by design -- say so rather than imply empty output.
    if (rec && rec.output === undefined) { rec.output = ''; rec.outputEvicted = true; }
    return rec;
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
      jobId: j.jobId, route: j.route, actor: j.actor, onBehalfOf: j.onBehalfOf || null,
      status: j.status, ok: j.ok,
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
      const who = actorOf(req, cwd);
      const job = startSkillJob({
        bin: s.bin, args: s.args, timeout: s.timeout, cwd, record: s.record,
        route: s.route, actor: who, onBehalf: onBehalfOf(req, who),
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
      outputEvicted: !!job.outputEvicted,
      outputSha256: job.outputSha256 || null,
    });
  });

  // Durable run history -- the data-plane event stream the audit lane consumes.
  app.get('/skill-jobs', requireAuth, (req, res) =>
    res.json({ ok: true, jobs: listJobs(cwd, req.query && req.query.limit) }));

  // Chain status + tail, for the control plane's Audit view. Each agent reports on
  // its OWN log only; nothing here lets one agent vouch for another's history, and
  // the control plane cannot rewrite what an agent recorded.
  app.get('/audit-verify', requireAuth, (req, res) => {
    try {
      const a = require('./audit-log.js');
      return res.json({ ok: true, chain: a.verify(), log: a.LOG });
    } catch (e) { return res.json({ ok: false, error: 'audit log unavailable: ' + String(e).slice(0, 160) }); }
  });
  app.get('/audit-recent', requireAuth, (req, res) => {
    try {
      const a = require('./audit-log.js');
      const n = Math.min(Math.max(parseInt((req.query && req.query.limit) || '25', 10) || 25, 1), 200);
      let rows = [];
      try {
        rows = fs.readFileSync(a.LOG, 'utf8').trim().split('\n').filter(Boolean).slice(-n)
          .map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean).reverse();
      } catch (e) { rows = []; }
      return res.json({ ok: true, rows });
    } catch (e) { return res.json({ ok: false, error: String(e).slice(0, 160) }); }
  });

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
  // the one identity rule (verified actor, asserted on-behalf-of), shared with the WS chat path
  actorOf, onBehalfOf, actorLabels,
};
