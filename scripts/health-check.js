#!/usr/bin/env node
/**
 * health-check.js — hourly health probe.
 *
 * Checks disk headroom, audit-chain integrity, and tripwire config presence.
 * Silent on success (cron stays quiet); on any failure it prints details, exits
 * non-zero, and — if an operator channel is enabled — sends one alert. The
 * notify step is capability-gated: it never assumes Telegram or Resend exists.
 *
 * Usage:  node scripts/health-check.js [--json]
 * Exit:   0 all healthy, 1 one or more checks failed.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const AGENT_ROOT = process.env.AGENT_ROOT || path.dirname(__dirname);
const DISK_WARN_PCT = Number(process.env.HEALTH_DISK_WARN_PCT || 85);

function checkDisk() {
  try {
    const out = execFileSync('df', ['-P', AGENT_ROOT], { encoding: 'utf8' });
    const line = out.trim().split('\n').pop().split(/\s+/);
    const usedPct = parseInt(line[4], 10);
    return { name: 'disk', ok: usedPct < DISK_WARN_PCT, detail: `${usedPct}% used (warn ${DISK_WARN_PCT}%)` };
  } catch (e) {
    return { name: 'disk', ok: false, detail: 'df failed: ' + (e.message || '').slice(0, 80) };
  }
}

function checkAudit() {
  try {
    const audit = require('../gate/audit');
    const v = audit.verify();
    return { name: 'audit-chain', ok: v.ok, detail: v.ok ? `intact (${v.length} entries)` : `BROKEN at entry ${v.brokenAt}` };
  } catch (e) {
    return { name: 'audit-chain', ok: false, detail: 'verify failed: ' + (e.message || '').slice(0, 80) };
  }
}

function checkTripwireConfig() {
  const cfg = path.join(AGENT_ROOT, 'gate', 'never-egress.json');
  const ok = fs.existsSync(cfg);
  return { name: 'tripwire-config', ok, detail: ok ? 'present' : 'MISSING — gate fails closed, ingest cannot scan' };
}

// Capability-gated alert. Returns a description of what it would send; the
// actual Telegram/Resend send is delegated to the notify helper if present and
// the capability is enabled. Never throws into the caller.
function alert(failed) {
  try {
    const notify = path.join(AGENT_ROOT, 'scripts', 'notify.js');
    if (fs.existsSync(notify)) {
      execFileSync('node', [notify, 'health', 'FAILED: ' + failed.map(f => f.name).join(', ')],
                   { cwd: AGENT_ROOT, encoding: 'utf8', timeout: 20000 });
      return 'alert sent via notify.js';
    }
  } catch (_) { /* alerting must not mask the failure */ }
  return 'notify.js not present — alert not sent (health failure still reported to cron)';
}

function run() {
  const checks = [checkDisk(), checkAudit(), checkTripwireConfig()];
  const failed = checks.filter(c => !c.ok);
  return { healthy: failed.length === 0, checks, failed };
}

if (require.main === module) {
  const r = run();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
  } else if (!r.healthy) {
    console.error('HEALTH: FAILED');
    for (const c of r.checks) console.error(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
    console.error('  ' + alert(r.failed));
  }
  // silent on success
  process.exit(r.healthy ? 0 : 1);
}

module.exports = { run };
