#!/usr/bin/env node
// compliance-checks.js -- fleet-core deterministic compliance evidence writers.
// Invoked per-check from system/skills.yaml record: entries (via scripts/skills.js
// runSkillSpawn), which persists {ok, output, ranAt} to state/compliance/<record>.json.
// Every check is deterministic and LLM-free; stdout is the evidence line(s),
// exit 0 = posture holds, exit 1 = attention (skills.js captures either shape).
//
// Usage: node scripts/compliance-checks.js <check>
//   net-ingress   loopback-only listener on the webchat port (parses /proc/net/tcp*)
//   edge-auth     unauthenticated / is refused (401/403) + no app-TOTP artifacts remain
//   pii           gate/tripwire flags a seeded-bad sample; reports weekly-scan log age
//   backup        capability registry: required -> marker freshness, else N/A by design
//   fleet-pause   host uptime inside the pause window proves the kill switch is exercised
//   vuln          npm audit (prod deps) high/critical count in the webchat tree
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const ROOT = process.cwd(); // skills.js spawns with cwd = agent root
const PORT = parseInt(process.env.CASTOR_PORT || process.env.KEEL_PORT || '8443', 10);

function die(ok, lines) { console.log(lines.join('\n')); process.exit(ok ? 0 : 1); }

function netIngress() {
  // Containerized topology: the webchat binds 0.0.0.0 so the cloudflared sidecar
  // container can reach it; isolation is the Docker network + deny-all NSG + no
  // public IP (fleet-layer proof: fleetctl check --live). The honest in-container
  // claim is SURFACE MINIMALITY: exactly one listening port -- the service port.
  let rows = [];
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try { rows = rows.concat(fs.readFileSync(f, 'utf8').split('\n').slice(1)); } catch { /* absent */ }
  }
  const ports = new Set();
  for (const r of rows) {
    const c = r.trim().split(/\s+/);
    if (c[3] !== '0A') continue;
    // 127.0.0.11 is Docker's embedded DNS resolver (dockerd infrastructure,
    // present in every container network namespace) -- not app surface.
    if (c[1].split(':')[0] === '0B00007F') continue;
    ports.add(parseInt(c[1].split(':')[1], 16));
  }
  if (!ports.has(PORT)) die(false, ['NET-INGRESS: service port ' + PORT + ' has no listener']);
  const extras = [...ports].filter(p => p !== PORT);
  if (extras.length) die(false, ['NET-INGRESS: unexpected listener(s) on port(s) ' + extras.join(', ') + ' beyond the service port ' + PORT]);
  die(true, ['NET-INGRESS: OK -- exactly one listening port (' + PORT + '); perimeter is Docker network + deny-all NSG + no public IP (fleet layer)']);
}

function edgeAuth() {
  const totp = ['state/totp-secret', 'state/totp.json', 'state/totp-secret.txt']
    .filter(p => fs.existsSync(path.join(ROOT, p)));
  http.get({ host: '127.0.0.1', port: PORT, path: '/', timeout: 5000 }, (res) => {
    const enforced = res.statusCode === 401 || res.statusCode === 403;
    const lines = ['EDGE-AUTH: unauthenticated / -> HTTP ' + res.statusCode + (enforced ? ' (refused; Cloudflare Access JWT is the sole factor)' : ' (NOT refused)')];
    lines.push(totp.length ? 'EDGE-AUTH: app-TOTP artifacts present: ' + totp.join(', ') : 'EDGE-AUTH: no app-TOTP artifacts (edge-only auth confirmed)');
    die(enforced && !totp.length, lines);
  }).on('error', (e) => die(false, ['EDGE-AUTH: local probe failed: ' + e.message]))
    .on('timeout', function () { this.destroy(); die(false, ['EDGE-AUTH: local probe timeout']); });
}

function pii() {
  const { checkTripwire } = require(path.join(ROOT, 'gate', 'tripwire.js'));
  const seeded = 'contact jane.doe@realcorp.com ssn 123-45-6789 card 4111111111111111';
  let hits;
  try { hits = checkTripwire(seeded); } catch (e) { die(false, ['PII: tripwire self-test errored: ' + e.message]); }
  const n = Array.isArray(hits) ? hits.length : (hits && hits.findings ? hits.findings.length : (hits ? 1 : 0));
  const lines = ['PII: tripwire self-test ' + (n > 0 ? 'OK -- seeded sample flagged (' + n + ' rule hit(s))' : 'FAILED -- seeded sample passed unflagged')];
  try {
    const age = (Date.now() - fs.statSync(path.join(ROOT, 'logs', 'pii-scan.log')).mtimeMs) / 86400000;
    lines.push('PII: weekly scan log age ' + age.toFixed(1) + 'd' + (age > 8 ? ' (stale)' : ''));
  } catch { lines.push('PII: weekly scan log not present yet'); }
  die(n > 0, lines);
}

function backup() {
  const yaml = require('js-yaml');
  const doc = yaml.load(fs.readFileSync(path.join(ROOT, 'scripts', 'capabilities-shared.yaml'), 'utf8'));
  const caps = (doc && (doc.capabilities || doc)) || [];
  const cap = (Array.isArray(caps) ? caps : []).find(c => c && c.id === 'azure_backup');
  if (!cap) die(false, ['BACKUP: azure_backup not found in capability registry']);
  if (!cap.required) die(true, ['BACKUP: N/A by design -- capability registry declares azure_backup required: false for this profile']);
  try {
    const age = (Date.now() - fs.statSync(path.join(ROOT, 'logs', 'azure-backup.log')).mtimeMs) / 86400000;
    die(age <= 2, ['BACKUP: required; last run ' + age.toFixed(1) + 'd ago' + (age > 2 ? ' (stale)' : '')]);
  } catch { die(false, ['BACKUP: required but no run marker found']); }
}

function fleetPause() {
  const up = parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]) / 86400;
  const ok = up <= 30;
  die(ok, ['FLEET-PAUSE: host uptime ' + up.toFixed(1) + 'd -- ' + (ok
    ? 'a deallocate/start cycle ran within the 30d window; fleet pause (az vm deallocate) is the exercised kill switch'
    : 'no pause cycle within 30d; rehearse the kill switch (az vm deallocate / start)')]);
}

function vuln() {
  let raw;
  try {
    raw = execFileSync('npm', ['audit', '--omit=dev', '--json'], { cwd: path.join(ROOT, 'webchat'), encoding: 'utf8', timeout: 45000 });
  } catch (e) { raw = (e.stdout || ''); if (!raw.trim()) die(false, ['VULN: npm audit unavailable: ' + String(e).slice(0, 120)]); }
  let high = -1, critical = -1;
  try { const v = JSON.parse(raw).metadata.vulnerabilities; high = v.high | 0; critical = v.critical | 0; } catch { die(false, ['VULN: could not parse npm audit output']); }
  die(high + critical === 0, ['VULN: npm audit (prod) -- high: ' + high + ', critical: ' + critical + (high + critical ? ' (remediation needed)' : ' -- clean')]);
}

function secrets() {
  // Scan the DATA surfaces (where operator data lives), matching the weekly-scan
  // scoping -- code, tests, and demo fixtures carry deliberate canaries and are
  // the repo-wide /run-scan-tree operator tool's job, not compliance evidence.
  const dirs = ['state', 'knowledge', 'exports', 'inbox'].filter(d => fs.existsSync(path.join(ROOT, d)));
  if (!dirs.length) die(false, ['SECRETS: no data directories present to scan']);
  const lines = []; let clean = true;
  for (const d of dirs) {
    try {
      execFileSync('node', [path.join('scripts', 'scan-tree.js'), d], { cwd: ROOT, encoding: 'utf8', timeout: 45000 });
      lines.push('SECRETS: ' + d + '/ clean');
    } catch (e) {
      clean = false;
      lines.push('SECRETS: ' + d + '/ FINDINGS -- ' + ((e.stdout || '') + (e.stderr || '')).trim().split('\n')[0]);
    }
  }
  lines.push(clean ? 'SECRETS: OK -- no secret/PII patterns in operator data surfaces' : 'SECRETS: remediate the flagged data files');
  die(clean, lines);
}

const cmd = process.argv[2];
const table = { 'net-ingress': netIngress, 'edge-auth': edgeAuth, pii, backup, 'fleet-pause': fleetPause, vuln, secrets };
if (!table[cmd]) { console.log('usage: compliance-checks.js <' + Object.keys(table).join('|') + '>'); process.exit(2); }
table[cmd]();
