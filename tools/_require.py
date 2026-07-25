"""Fail-clear guard for pipeline artifacts produced by an upstream step.

Empty corpus is the day-one state: a fresh clone has no state/normalized/*.
A traceback tells the operator nothing; this names the missing file and the
command that creates it, then exits 2 (distinct from a crash).
"""
import sys
from pathlib import Path

_PRODUCER = {
    "state/normalized/jira-portfolio.json": "/normalize-jira  (needs a CSV export in knowledge/import/raw/)",
    "state/normalized/backlog.json":        "/normalize-backlog  (needs a *Backlog*.xlsx in knowledge/import/raw/)",
    "state/normalized/ado.json":            "/normalize-ado  (needs an ADO CSV export in knowledge/import/raw/)",
    "state/normalized/reconcile.json":      "/reconcile-run",
    "state/normalized/semantic.json":       "/reconcile-semantic",
    "state/resolutions.json":               "/merge-accept  (records confirmed merge decisions)",
    "exports/score-proposals.json":         "/score-all  (proposes WSJF/RICE scores)",
}

def require(p):
    """Return Path(p) if it exists; else print guidance and exit 2."""
    path = Path(p)
    if path.exists():
        return path
    key = str(path)
    for k in _PRODUCER:
        if key.endswith(k):
            key = k
            break
    how = _PRODUCER.get(key, "an earlier pipeline step")
    print(f"MISSING: {path}\n  This file is produced by: {how}\n"
          f"  Nothing to do until it exists (empty corpus is normal on a fresh install).",
          file=sys.stderr)
    sys.exit(2)
