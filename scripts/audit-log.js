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
const { record, verify, LOG } = require('../gate/audit');

module.exports = { record, verify, LOG };

if (require.main === module) {
  const cmd = process.argv[2] || 'verify';
  if (cmd === 'path') { console.log(LOG); process.exit(0); }
  if (cmd === 'verify') {
    const r = verify();
    if (r.ok) { console.log(`AUDIT CHAIN: OK (${r.length} entries) ${LOG}`); process.exit(0); }
    console.error(`AUDIT CHAIN: BROKEN at entry ${r.brokenAt} of ${r.length}`); process.exit(1);
  }
  console.error('Usage: audit-log.js [verify|path]'); process.exit(1);
}
