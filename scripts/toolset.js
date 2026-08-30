'use strict';
// toolset.js -- what tools does this profile actually carry, and what does it actually reach?
//
// Skills are data: skills.yaml names `args: [tools/x.py, ...]` and fleet-core spawns it. The
// TOOL FILES are not data -- they exist because they are checked into the profile's repo. So
// curating a profile means copying files and hoping, and a skill can name a tool the image does
// not contain: the failure surfaces at invocation, to whoever invoked it, not at boot.
//
// This module makes the tool surface enumerable, which is the precondition for declaring it.
// Three reach-paths, because a check that knows only about skills.yaml covers a minority of the
// surface and reports confident nonsense about the rest:
//   1. skills.yaml            -- declared skills (data)
//   2. handler code           -- execFileSync('python3', ['tools/x.py' ...]) in webchat/server.js
//   3. tool-to-tool imports   -- `from _require import ...`, which curation must not break
// Plus external packages a tool imports that are not stdlib and not another tool (openpyxl, and
// the profile's own vendored library), because those travel with the image, not the tool.
const fs = require('node:fs');
const path = require('node:path');

// stdlib names a tool may import without anything needing to travel with it.
const STDLIB = new Set(['pathlib', 'datetime', 'collections', 'json', 'sys', 'os', 're', 'csv',
  'argparse', 'math', 'itertools', 'typing', 'shutil', 'subprocess', 'hashlib', 'time',
  'dataclasses', 'functools', 'textwrap', 'uuid', 'random', 'io', 'unicodedata', 'difflib',
  'glob', 'traceback', 'tempfile', 'copy', 'string', 'statistics', 'decimal', 'warnings',
  'contextlib', 'operator', 'base64', 'zipfile', 'urllib', 'sqlite3', 'logging', 'enum']);

function readIf(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

// Every tools/<name>.py mentioned anywhere in a blob, in the order found.
function refsIn(blob) {
  const out = new Set();
  const re = /tools\/([A-Za-z0-9_]+)\.py/g;
  let m;
  while ((m = re.exec(blob))) out.add(m[1]);
  return out;
}

// Imports declared by a python file, split into: sibling tools, and everything else non-stdlib.
function importsOf(src, toolNames) {
  const sib = new Set(); const ext = new Set();
  const re = /^\s*(?:from\s+([A-Za-z0-9_.]+)\s+import|import\s+([A-Za-z0-9_.]+))/gm;
  let m;
  while ((m = re.exec(src))) {
    const mod = (m[1] || m[2] || '').split('.')[0];
    if (!mod || STDLIB.has(mod)) continue;
    if (toolNames.has(mod)) sib.add(mod); else ext.add(mod);
  }
  return { sib, ext };
}

// -> { present, declared, reachable, closure, undeclared, missing, external, ok }
// `declared` is system/toolset.yaml when it exists; absent means "not yet adopted", which is
// reported as such rather than treated as an empty declaration -- absence of a declaration is
// not a declaration of absence.
function scan(root) {
  const toolsDir = path.join(root, 'tools');
  let present = [];
  try { present = fs.readdirSync(toolsDir).filter((f) => f.endsWith('.py')).map((f) => f.replace(/\.py$/, '')).sort(); } catch { present = []; }
  const names = new Set(present);

  const declPath = path.join(root, 'system', 'toolset.yaml');
  const declRaw = readIf(declPath);
  const declared = declRaw
    ? declRaw.split('\n').map((l) => (l.match(/^\s*-\s*([A-Za-z0-9_]+)(?:\.py)?\s*$/) || [])[1]).filter(Boolean).sort()
    : null;

  // reach-path 1 and 2
  const fromSkills = refsIn(readIf(path.join(root, 'system', 'skills.yaml')));
  const fromHandlers = refsIn(readIf(path.join(root, 'webchat', 'server.js')));
  // A fourth reach-path, kept separate: the e2e harness is not a runtime lane, so a tool only it
  // reaches is not dead -- but it must still ship, or the harness fails when it is most needed.
  const fromHarness = refsIn(readIf(path.join(root, 'run_e2e.sh')));
  for (const h of refsIn(readIf(path.join(root, 'run_e2e.sh')))) fromHarness.add(h);
  const seeds = new Set([...fromSkills, ...fromHandlers, ...fromHarness]);

  // reach-path 3: transitive closure over sibling imports
  const closure = new Set(); const external = new Set(); const queue = [...seeds];
  while (queue.length) {
    const n = queue.shift();
    if (closure.has(n)) continue;
    closure.add(n);
    const src = readIf(path.join(toolsDir, n + '.py'));
    if (!src) continue;
    const { sib, ext } = importsOf(src, names);
    for (const s of sib) if (!closure.has(s)) queue.push(s);
    for (const e of ext) external.add(e);
  }

  const missing = [...closure].filter((n) => !names.has(n)).sort();           // reached, not in the repo
  const undeclared = declared ? [...closure].filter((n) => !declared.includes(n)).sort() : [];
  const unreached = present.filter((n) => !closure.has(n)).sort();            // carried, never reached
  return {
    present, declared, fromSkills: [...fromSkills].sort(), fromHandlers: [...fromHandlers].sort(),
    fromHarness: [...fromHarness].sort(),
    closure: [...closure].sort(), missing, undeclared, unreached, external: [...external].sort(),
    ok: missing.length === 0 && undeclared.length === 0,
  };
}

module.exports = { scan, STDLIB };
