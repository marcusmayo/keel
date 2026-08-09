#!/usr/bin/env python3
"""Backlog XLSX normalizer -- thin CLI shim over keel_core.normalize.

SOURCE_KEY_PREFIX and the type-override store were ambient reads; they are now
config assembled here and passed in.
"""
import json, sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "vendor"))
from keel_core import ReconcileConfig, normalize_backlog, parse_backlog_xlsx

RAW_DIR = ROOT / "knowledge" / "import" / "raw"
OUT = ROOT / "state" / "normalized" / "backlog.json"
OVR_PATH = ROOT / "state" / "backlog-type-overrides.json"
CFG_PATH = Path(__import__("os").environ.get("KEEL_CONFIG", ROOT / "keel.config.json"))


def load_config():
    prefix = ""
    if CFG_PATH.exists():
        prefix = (json.loads(CFG_PATH.read_text(encoding="utf-8"))
                  .get("SOURCE_KEY_PREFIX") or "")
    overrides = {}
    if OVR_PATH.exists():
        overrides = json.loads(OVR_PATH.read_text(encoding="utf-8")).get("overrides", {})
    return ReconcileConfig(source_key_prefix=prefix, type_overrides=overrides)


def latest_backlog_xlsx():
    files = sorted(RAW_DIR.glob("*Backlog*.xlsx"))
    if not files:
        sys.exit(f"ERROR: no *Backlog*.xlsx in {RAW_DIR}")
    return files[-1]


def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else latest_backlog_xlsx()
    cfg = load_config()
    raw_rows = parse_backlog_xlsx(src.read_bytes())
    res = normalize_backlog(raw_rows, config=cfg)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "generated": datetime.now().astimezone().isoformat(),
        "source_file": str(src),
        "row_count": len(res["rows"]),
        "type_counts": res["type_counts"],
        "rows": res["rows"]}, indent=2), encoding="utf-8")

    tc = res["type_counts"]
    print(f"=== normalize_backlog: {len(res['rows'])} rows ===")
    print(f"type counts: epic={tc['epic']}  feature={tc['feature']}  "
          f"story={tc['story']}  unknown={tc['unknown']}")
    for w in res["warnings"]:
        print(f"  [{w.code}] {w.message}")
        if w.context:
            print(f"      {w.context}")
    print(f"embedded source refs (proposed, never auto-linked): {len(res['embedded_refs'])}")
    if not cfg.source_key_prefix:
        print("(embedded source-key scan skipped: no SOURCE_KEY_PREFIX configured)")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
