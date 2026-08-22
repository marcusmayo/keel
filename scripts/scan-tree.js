#!/usr/bin/env node
/**
 * scan-tree.js — recursive PII/secret scan over a directory.
 *
 * The weekly sweep must not drift from the ingest and pre-commit gates, so it
 * reuses the exact PATTERNS exported by redaction-gate.js rather than defining
 * its own. This is the "catches anything that slipped past the gate" backstop.
 *
 * Usage:  node scripts/scan-tree.js <dir> [--quiet]
 * Exit:   0 clean, 1 findings, 2 usage/error. Findings print file:line LABEL
 *         with a truncated sample (never the full match).
 */

const fs = require('fs');
const path = require('path');
const { PATTERNS } = require('./redaction-gate');

// tests/ carries canonical FAKE fixtures on purpose (AWS's documented example key, 123-45-6789,
// 555 numbers) -- the first live weekly scan reported 17 findings on a fresh notebook agent and
// every one was a fixture. A weekly signal that cries seventeen every Sunday trains its reader
// to ignore the week it says eighteen, and the eighteenth is the one that matters.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'archive', 'tests']);
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.xlsx', '.xls',
                          '.zip', '.gz', '.woff', '.woff2', '.ico', '.age', '.msg']);
// Files that legitimately contain example patterns.
const SKIP_FILE = new Set(['never-egress.example.json', 'scan-tree.js', 'redaction-gate.js', 'ado_sample.csv',
                           'compliance-checks.js',     // carries the seeded PII canary the tripwire self-test fires against
                           'run_e2e.sh',               // seeds the same canary end-to-end, by design
                           'pii-scan.log']);           // the scan's OWN report quotes its findings -- without this the
                                                       // second weekly run reads the first one's log and flags itself,
                                                       // and the count ratchets upward forever

// The fleet's one real operational address appears in audit chains as the ACTOR of attested and
// operator actions -- that is the record doing its job, not a leak. It is allowed by exact
// string, not by skipping audit files: audit stays scanned, so a real address or an SSN echoed
// into a detail field still fires, while the expected actor identity does not.
const ALLOWED_LITERALS = ['keel@keel-pm.com'];
const allowed = (sample) => ALLOWED_LITERALS.some((a) => String(sample || '').includes(a));

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      // state/compliance holds derived evidence records that quote finding samples
      // verbatim -- scanning them re-flags the scanner's own output. Never inputs.
      if (e.name === 'compliance' && path.basename(dir) === 'state') continue;
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out); continue;
    }
    if (SKIP_FILE.has(e.name)) continue;
    if (SKIP_EXT.has(path.extname(e.name).toLowerCase())) continue;
    out.push(path.join(dir, e.name));
  }
}

function scan(root) {
  const files = []; walk(root, files);
  const findings = [];
  for (const f of files) {
    let content;
    try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (content.includes('\u0000')) continue; // binary
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const [label, re] of PATTERNS) {
        re.lastIndex = 0;
        const m = re.exec(lines[i]);
        if (m) {
          // RFC 2606 reserved documentation domains are placeholders, not data.
          if (label === 'EMAIL' && /@(example\.(com|org|net)|[^\s@]+\.(invalid|test))$/i.test(m[0])) continue;
          // the fleet's own operational identity, allowed by exact string wherever it appears
          if (allowed(m[0])) continue;
          findings.push({ file: f, line: i + 1, label, sample: m[0].slice(0, 12) + '…' });
        }
      }
    }
  }
  return findings;
}

if (require.main === module) {
  const root = process.argv[2];
  const quiet = process.argv.includes('--quiet');
  if (!root) { console.error('usage: scan-tree.js <dir> [--quiet]'); process.exit(2); }
  const findings = scan(root);
  if (findings.length === 0) {
    if (!quiet) console.log(`PII SCAN: clean (${root})`);
    process.exit(0);
  }
  console.error(`PII SCAN: ${findings.length} finding(s) in ${root}`);
  for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.label}  ${f.sample}`);
  process.exit(1);
}

module.exports = { scan };
