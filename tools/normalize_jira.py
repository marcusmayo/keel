#!/usr/bin/env python3
"""Jira CSV normalizer -- thin CLI shim over keel_core.normalize.

Behaviour, inputs, and outputs are unchanged. This file now does only what a
CLI should: pick files off disk, call the library, write files, print a summary.
All matching and mapping logic lives in keel_core.
"""
import glob, json, os, sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "vendor"))
from keel_core import normalize_jira, parse_jira_csv

RAW_GLOB = "knowledge/import/raw/*.csv"
OUT_PORTFOLIO = Path("state/normalized/jira-portfolio.json")
OUT_BUGS = Path("state/normalized/jira-bugs.json")


def newest_csv():
    files = sorted(glob.glob(RAW_GLOB))
    if not files:
        sys.exit(f"ABORT: no CSV in {RAW_GLOB}")
    files.sort(key=lambda f: (os.path.basename(f), os.path.getmtime(f)))
    return files[-1]


def main():
    src = newest_csv()
    header, rows = parse_jira_csv(Path(src).read_text(encoding="utf-8-sig"))
    res = normalize_jira(header, rows)

    meta = {
        "generated": datetime.now().astimezone().isoformat(),
        "source_file": src,
        "jira_type_counts": res["counts"]["type"],
        "jira_status_counts": res["counts"]["status"],
    }
    OUT_PORTFOLIO.parent.mkdir(parents=True, exist_ok=True)
    OUT_PORTFOLIO.write_text(json.dumps({
        **meta, "stream": "portfolio", "count": len(res["portfolio"]),
        "rows": res["portfolio"]}, indent=2), encoding="utf-8")
    OUT_BUGS.write_text(json.dumps({
        **meta, "stream": "bugs", "count": len(res["bugs"]),
        "subtask_count": len(res["subtasks"]), "rows": res["bugs"],
        "subtasks": res["subtasks"]}, indent=2), encoding="utf-8")

    print(f"=== normalize-jira: {src.split('/')[-1]} ===")
    print(f"  total data rows: {len(rows)}")
    print(f"  portfolio (epic/story/task): {len(res['portfolio'])}  -> {OUT_PORTFOLIO}")
    print(f"  bugs: {len(res['bugs'])}  -> {OUT_BUGS}")
    print(f"  sub-tasks (flagged, held): {len(res['subtasks'])}")
    for w in res["warnings"]:
        print(f"  WARNING [{w.code}]: {w.message} {w.context}".rstrip())
    if not res["warnings"]:
        print("  all statuses mapped cleanly")
    refs = sum(1 for r in res["portfolio"] if r["source"]["ref"])
    print(f"  portfolio rows carrying source ref: {refs}/{len(res['portfolio'])} (enables exact-ref match)")


if __name__ == "__main__":
    main()
