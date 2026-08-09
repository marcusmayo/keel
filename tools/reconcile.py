#!/usr/bin/env python3
"""Deterministic reconcile -- thin CLI shim over keel_core.reconcile.

Reads the same files, writes the same file, prints the same summary. Matching,
bucketing, and collision handling live in keel_core.

KEEL_COMPAT=0 in the environment enables the registered fixes; the default
(compat on) reproduces the original numbers exactly, which is what run_e2e.sh
and tools/verify_e2e.py assert.
"""
import glob, json, os, sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "vendor"))
sys.path.insert(0, str(ROOT / "tools"))
from keel_core import ReconcileConfig, parse_keel_items, parse_resolutions, reconcile
from _require import require

SOURCES = {"jira": Path("state/normalized/jira-portfolio.json"),
           "backlog": Path("state/normalized/backlog.json"),
           "ado": Path("state/normalized/ado.json")}
OUT = Path("state/normalized/reconcile.json")
RESOLUTIONS = Path("state/resolutions.json")
STATE_GLOB = "state/*.yaml"

COMPAT = os.environ.get("KEEL_COMPAT", "1") != "0"


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "jira"
    if which not in SOURCES:
        sys.exit(f"ABORT: unknown reconcile lane {which!r}. Valid lanes: {', '.join(sorted(SOURCES))}")
    norm = SOURCES[which]
    rows = json.loads(require(norm).read_text(encoding="utf-8"))["rows"]

    sources = {}
    for f in sorted(glob.glob(STATE_GLOB)):
        if "/_" in f or Path(f).name.startswith("_"):
            continue
        sources[f] = Path(f).read_text(encoding="utf-8")
    items, parse_warnings = parse_keel_items(sources)

    res_text = RESOLUTIONS.read_text(encoding="utf-8") if RESOLUTIONS.exists() else None
    resolutions = parse_resolutions(res_text)

    result = reconcile(rows, items,
                       config=ReconcileConfig(legacy_compat=COMPAT),
                       resolutions=resolutions,
                       generated=datetime.now().astimezone().isoformat(),
                       source_label=which)
    for w in parse_warnings:
        result["warnings"].append(w.as_dict())

    payload = {"generated": result["generated"], "summary": result["summary"],
               "buckets": result["buckets"]}
    if result["warnings"]:
        payload["warnings"] = result["warnings"]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    s = result["summary"]
    print(f"=== reconcile [{which}]: {s['portfolio_rows_scoped']} epic/story rows "
          f"vs {s['keel_items']} keel items ===")
    print(f"    (skipped non-portfolio types: {s['skipped_types']})")
    for b in ["changed", "completed", "conflict", "duplicate", "ambiguous", "gap", "done_gap"]:
        print(f"  {b:10s}: {len(result['buckets'][b])}")
    print()
    for w in result["warnings"]:
        print(f"  WARNING [{w['code']}]: {w['message']} ({w['context']})")
    amb = result["buckets"]["ambiguous"]
    if amb:
        print(f"AMBIGUOUS ({len(amb)}) - held for semantic pass:")
        for e in amb[:12]:
            print(f"   {e.get('score')}  {e['src_name'][:33]!r}  ~  "
                  f"{e.get('keel_key')} {e.get('keel_name','')[:28]!r}")
    print(f"\n  gap (active, unmatched): {len(result['buckets']['gap'])} -> new-item candidates")
    print(f"  done_gap (completed, unmatched): {len(result['buckets']['done_gap'])} -> already-done reference")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
