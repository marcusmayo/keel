#!/usr/bin/env node
'use strict';
// Agent test runner -- fleet-core MECHANISM, vendored flat into each agent's scripts/.
//
// Why this exists: the agent suites had no runner and nothing gated on them. castor's
// package.json had no scripts block, the Dockerfile copied tests/ in with a comment
// saying "run via docker exec", and the rebuild lane ignored them. So three tests had
// been failing on a `System/` vs `system/` path since before anyone noticed, and four
// assertions in test_model_routing pinned model names the config had outgrown. Tests
// that nothing runs are not coverage; they are documentation that decays silently, and
// for a template they hand every derived agent the same decay.
//
// Deliberately not a framework. Each test file is its own program that exits non-zero
// on failure -- which is what they already do. This discovers them, runs each in its
// own process with a bound, and reports one line per file plus the tail of any failure.
// Discovery covers .js and .py because keel's suite is Python and castor's is Node; the
// image has both interpreters.
//
// Exit 0 = every test passed, or there is nothing to run and it said so.
// Exit 1 = at least one test failed. The rebuild lane refuses on that, BEFORE the new
//          image is brought up, so a failing build leaves the previous one serving.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.argv[2] || process.env.AGENT_ROOT || process.cwd();
const DIR = path.join(ROOT, 'tests');
const TIMEOUT_MS = parseInt(process.env.TEST_TIMEOUT_MS || '120000', 10);

const RUNNERS = { '.js': 'node', '.mjs': 'node', '.cjs': 'node', '.py': 'python3' };

function discover(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return null; }   // null = no tests/ at all
  return names
    .filter((n) => {
      const ext = path.extname(n);
      if (!RUNNERS[ext]) return false;
      const base = path.basename(n, ext);
      return base.startsWith('test_') || base.startsWith('test-') || base.endsWith('.test') || base === 'test';
    })
    .sort();
}

const files = discover(DIR);
if (files === null) {
  console.log('agent tests: no tests/ directory at ' + DIR + ' -- nothing to run');
  process.exit(0);
}
if (!files.length) {
  console.log('agent tests: tests/ exists but holds no test files -- nothing to run');
  process.exit(0);
}

console.log('agent tests: ' + files.length + ' file(s) in ' + DIR);
const failed = [];
for (const f of files) {
  const ext = path.extname(f);
  const bin = RUNNERS[ext];
  const started = Date.now();
  const r = spawnSync(bin, [path.join(DIR, f)], {
    cwd: ROOT, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, AGENT_ROOT: ROOT },
  });
  const ms = Date.now() - started;
  const out = ((r.stdout || '') + (r.stderr || '')).trimEnd();
  // A spawn that never ran is a failure, not a pass: r.status is null on timeout or error.
  const ok = r.status === 0;
  const why = r.error ? (' ' + r.error.message) : (r.status === null ? ' (timed out or killed)' : '');
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + f.padEnd(28) + String(ms).padStart(6) + 'ms' + (ok ? '' : why));
  if (!ok) {
    failed.push(f);
    const tail = out.split('\n').slice(-12);
    for (const line of tail) console.log('        | ' + line);
  }
}

console.log('agent tests: ' + (files.length - failed.length) + ' passed, ' + failed.length + ' failed');
if (failed.length) {
  console.log('FATAL: agent tests failed -- ' + failed.join(', '));
  process.exit(1);
}
process.exit(0);
