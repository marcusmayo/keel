#!/usr/bin/env node
/**
 * audit-log.js — append-only, hash-chained JSONL audit trail.
 *
 * Delegates to gate/audit.js (ported from Keel). Content is never written —
 * only metadata, entity counts, and the hash chain.
 *
 * CLI:
 *   node scripts/audit-log.js verify   # validate the chain, exit 1 if broken
 *   node scripts/audit-log.js path     # print the resolved log path
 */
const fs = require('fs');
const path = require('path');
const { record, verify, LOG } = require('../gate/audit');

// COVERAGE: an intact chain proves nothing was ALTERED; it says nothing about whether
// anything was RECORDED. verify() returns ok on an empty log, so a control that only
// checks integrity reports green on an audit lane that is silently doing nothing --
// the weakest possible pass.
//
// So the control also cross-checks two surfaces that are written independently:
// durable job records under state/skill-jobs/, and skill-run entries in the chain.
// Jobs present with no corresponding entries means the audit lane is broken while
// work continues, which is exactly the condition worth failing on. Both are local to
// this agent -- no agent vouches for another's history.
function coverage() {
  const root = process.env.AGENT_ROOT || path.dirname(__dirname);
  let jobs = 0;
  try { jobs = fs.readdirSync(path.join(root, 'state', 'skill-jobs')).filter(n => n.endsWith('.json')).length; }
  catch (e) { jobs = 0; }
  let runs = 0;
  try {
    for (const line of fs.readFileSync(LOG, 'utf8').trim().split('\n')) {
      if (!line) continue;
      try { if (JSON.parse(line).event === 'skill-run') runs++; } catch (e) { /* skip */ }
    }
  } catch (e) { runs = 0; }
  return { jobs, runs, covered: !(jobs > 0 && runs === 0) };
}

module.exports = { record, verify, LOG, coverage };

if (require.main === module) {
  const cmd = process.argv[2] || 'verify';
  if (cmd === 'path') { console.log(LOG); process.exit(0); }
  if (cmd === 'verify') {
    const r = verify();
    const c = coverage();
    if (!r.ok) {
      console.error(`AUDIT CHAIN: BROKEN at entry ${r.brokenAt} of ${r.length} -- ${LOG}`);
      process.exit(1);
    }
    if (!c.covered) {
      console.error(`AUDIT CHAIN: intact (${r.length} entries) but NOT COVERING the data plane -- ` +
                    `${c.jobs} skill job record(s) present, 0 skill-run entries logged. ` +
                    `The chain verifies because nothing is being written to it.`);
      process.exit(1);
    }
    console.log(`AUDIT CHAIN: OK (${r.length} entries; ${c.runs} skill-run of ${c.jobs} job record(s)) ${LOG}`);
    process.exit(0);
  }
  console.error('Usage: audit-log.js [verify|path]'); process.exit(1);
}
