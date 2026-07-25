#!/usr/bin/env python3
"""Standalone fixture test for the ADO ingestion lane (tools/normalize_ado.py).

Run:  python3 tests/test_normalize_ado.py
Exit 0 = all assertions pass, 2 = one or more failed / parser missing.

Deliberately NOT wired into run_e2e.sh or the oracle (verify_e2e.py) per the
build brief section 8 -- inclusion is a later decision after the lane is proven.

House rule (borrowed from verify_e2e): a planted edge case does not exist without
its assertion. Every deliberate case in the fixtures has a matching assertion here.
Assertions key on the ADO ID / title, never on Keel-assigned keys.
"""
import json, os, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "tests" / "fixtures" / "ado"
NORM = ROOT / "tools" / "normalize_ado.py"

FAILS = []
def check(name, got, want):
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {name}: {got!r}" + ("" if ok else f"  (want {want!r})"))
    if not ok:
        FAILS.append(name)

def run(csv_path, template=None, out_path=None, expect_ok=True):
    """Invoke the normalizer as a subprocess. Returns (returncode, combined_output, parsed_json|None)."""
    env = dict(os.environ)
    if out_path:
        env["ADO_OUT"] = str(out_path)
    cmd = [sys.executable, str(NORM), str(csv_path)]
    if template:
        cmd += ["--template", template]
    p = subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True)
    combined = p.stdout + p.stderr
    data = None
    if expect_ok and out_path and Path(out_path).exists():
        data = json.loads(Path(out_path).read_text(encoding="utf-8"))
    return p.returncode, combined, data

def by_ref(data):
    return {r["source"]["ref"]: r for r in data["rows"]}

def main():
    if not NORM.exists():
        print(f"  (parser not present yet: {NORM.relative_to(ROOT)})")
        print("VERIFY: FAIL (parser missing) -- expected during Phase 2 (fixture-before-parser)")
        sys.exit(2)

    with tempfile.TemporaryDirectory() as td:
        td = Path(td)

        # ---- Agile: core mapping + every branch (excluded / unknown / unmapped / missing-optional) ----
        rc, out, d = run(FIX / "ado_agile.csv", "agile", td / "agile.json")
        check("agile exit 0", rc, 0)
        if d:
            check("agile emitted count", d["count"], 7)
            check("agile type_counts", d["type_counts"],
                  {"bug": 1, "epic": 1, "feature": 1, "story": 2, "task": 1, "unknown": 1})
            check("agile status_counts", d["status_counts"],
                  {"done": 1, "in-progress": 4, "not-started": 1, "unmapped:removed": 1})
            check("agile excluded_counts (by type)", d["excluded_counts"], {"Test Case": 1})
            R = by_ref(d)
            check("excluded row 107 absent", "107" in R, False)
            check("unknown-type row 108 type", R.get("108", {}).get("type"), "unknown")
            check("unknown-type row 108 has _flag", "_flag" in R.get("108", {}), True)
            check("unmapped-status row 106 status", R.get("106", {}).get("status"), "unmapped:removed")
            check("unmapped-status row 106 raw_status", R.get("106", {}).get("raw_status"), "Removed")
            check("missing-optional row 104 emitted", "104" in R, True)
            check("missing-optional row 104 status", R.get("104", {}).get("status"), "done")
            check("row 101 canonical shape keys", sorted(R.get("101", {}).keys()),
                  ["name", "parent", "priority", "raw_status", "resolution", "source", "status", "type"])
            check("row 101 source block", R.get("101", {}).get("source"), {"origin": "ado", "ref": "101"})

        # ---- Scrum vocabulary ----
        rc, out, d = run(FIX / "ado_scrum.csv", "scrum", td / "scrum.json")
        check("scrum exit 0", rc, 0)
        if d:
            check("scrum emitted count", d["count"], 6)
            check("scrum status_counts", d["status_counts"],
                  {"done": 1, "in-progress": 2, "not-started": 3})
            check("scrum PBI 203 -> story", by_ref(d).get("203", {}).get("type"), "story")

        # ---- CMMI vocabulary ----
        rc, out, d = run(FIX / "ado_cmmi.csv", "cmmi", td / "cmmi.json")
        check("cmmi exit 0", rc, 0)
        if d:
            check("cmmi emitted count", d["count"], 5)
            check("cmmi status_counts", d["status_counts"],
                  {"done": 1, "in-progress": 3, "not-started": 1})
            check("cmmi Requirement 303 -> story", by_ref(d).get("303", {}).get("type"), "story")

        # ---- Determinism: same input -> byte-identical output across two runs ----
        run(FIX / "ado_agile.csv", "agile", td / "det1.json")
        run(FIX / "ado_agile.csv", "agile", td / "det2.json")
        b1 = (td / "det1.json").read_bytes() if (td / "det1.json").exists() else b"1"
        b2 = (td / "det2.json").read_bytes() if (td / "det2.json").exists() else b"2"
        check("deterministic (byte-identical re-run)", b1 == b2, True)

        # ---- Negative: 1,000-item export cap ----
        cap = td / "over_cap.csv"
        with cap.open("w", encoding="utf-8") as f:
            f.write("ID,Work Item Type,Title,Assigned To,State,Tags\n")
            for i in range(1001):
                f.write(f"{1000+i},User Story,Item {i},Amy,New,\n")
        rc, out, _ = run(cap, "agile", td / "cap.json", expect_ok=False)
        check("over-cap exits non-zero", rc != 0, True)
        check("over-cap names the count (1001)", "1001" in out, True)
        check("over-cap names the remedy (split)", "split" in out.lower(), True)

        # ---- Negative: missing required column ----
        rc, out, _ = run(FIX / "ado_missing_state_col.csv", "agile", td / "mc.json", expect_ok=False)
        check("missing-column exits non-zero", rc != 0, True)
        check("missing-column names 'State'", "State" in out, True)

    print()
    if FAILS:
        print(f"VERIFY: FAIL ({len(FAILS)}): {', '.join(FAILS)}")
        sys.exit(2)
    print("VERIFY: ALL PASS")

if __name__ == "__main__":
    main()
