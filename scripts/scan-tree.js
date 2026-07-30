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

const SKIP_DIRS = new Set(['.git', 'node_modules', 'archive']);
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.xlsx', '.xls',
                          '.zip', '.gz', '.woff', '.woff2', '.ico', '.age', '.msg']);
// Files that legitimately contain example patterns.
const SKIP_FILE = new Set(['never-egress.example.json', 'scan-tree.js', 'redaction-gate.js', 'ado_sample.csv']);

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out); continue; }
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
        if (m) findings.push({ file: f, line: i + 1, label, sample: m[0].slice(0, 12) + '…' });
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
