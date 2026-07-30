#!/usr/bin/env node
/**
 * redaction-gate.js — git pre-commit redaction check.
 *
 * Scans STAGED content only and exits non-zero if any PII pattern appears,
 * so the commit is blocked before the data reaches history. This is the
 * fourth layer of the Argus redaction architecture (ingest gate, output
 * sanitization, pre-commit hook, weekly scan).
 *
 * Design decision — regex only, deliberately no NLP:
 *   The egress gate (gate/redact.js) uses `compromise` to catch PERSON and
 *   ORG entities, which is correct when the cost of a miss is data leaving
 *   the machine. Here the cost of a false positive is a blocked commit, and
 *   NLP name detection fires on ordinary prose. So this gate matches only
 *   deterministic, high-confidence patterns. Names are handled by the
 *   ingest gate before anything is written to disk.
 *
 * Install:  node scripts/redaction-gate.js --install
 * Bypass:   not provided by design. Fix the content, or unstage the file.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Deterministic patterns only. Each must be specific enough that a match is
// almost certainly real PII or a secret.
const PATTERNS = [
  ['EMAIL',        /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ['EMAIL_OBFUS',  /\b[A-Za-z0-9._%+-]+\s*(?:\[at\]|\(at\)|\s+at\s+)\s*[A-Za-z0-9.-]+\s*(?:\[dot\]|\(dot\)|\s+dot\s+)\s*[A-Za-z]{2,}\b/gi],
  ['PHONE',        /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g],
  ['SSN',          /\b\d{3}-\d{2}-\d{4}\b/g],
  ['PRIVATE_KEY',  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['AWS_KEY',      /\bAKIA[0-9A-Z]{16}\b/g],
  ['API_KEY_SK',   /\bsk-[A-Za-z0-9]{20,}\b/g],
  ['GITHUB_PAT',   /\bghp_[A-Za-z0-9]{36}\b/g],
  ['SLACK_TOKEN',  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
];

// Files that legitimately contain example patterns. Kept explicit and short.
const ALLOW = new Set([
  'gate/never-egress.example.json',
  'scripts/redaction-gate.js',
]);

// Binary and lockfile extensions are skipped — no PII value, high noise.
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.xlsx', '.xls',
                          '.zip', '.gz', '.woff', '.woff2', '.ico', '.age']);

function stagedFiles() {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'],
                           { encoding: 'utf8' });
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}

function stagedContent(file) {
  // Read from the index, not the worktree — the commit is what matters.
  try {
    return execFileSync('git', ['show', `:${file}`], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  } catch {
    return null;
  }
}

function scan() {
  const findings = [];
  for (const file of stagedFiles()) {
    if (ALLOW.has(file)) continue;
    if (SKIP_EXT.has(path.extname(file).toLowerCase())) continue;

    const content = stagedContent(file);
    if (content === null) continue;
    if (content.includes('\u0000')) continue; // binary

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const [label, re] of PATTERNS) {
        re.lastIndex = 0;
        const m = re.exec(lines[i]);
        if (m) {
          findings.push({ file, line: i + 1, label, sample: m[0].slice(0, 12) + '…' });
        }
      }
    }
  }
  return findings;
}

function install() {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const hookDir = path.join(root, '.git', 'hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  const hook = path.join(hookDir, 'pre-commit');
  const body = '#!/bin/sh\nexec node scripts/redaction-gate.js\n';
  fs.writeFileSync(hook, body, { mode: 0o755 });
  console.log('installed pre-commit hook -> ' + hook);
}

if (require.main === module) {
  if (process.argv.includes('--install')) { install(); process.exit(0); }

  const findings = scan();
  if (findings.length === 0) {
    console.log('REDACTION GATE: clean (' + stagedFiles().length + ' staged files scanned)');
    process.exit(0);
  }

  console.error('REDACTION GATE: COMMIT BLOCKED — ' + findings.length + ' finding(s)');
  console.error('');
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.label}  ${f.sample}`);
  }
  console.error('');
  console.error('Remove or tokenize the content, then re-stage. This gate has no bypass flag.');
  process.exit(1);
}

module.exports = { scan, PATTERNS };
