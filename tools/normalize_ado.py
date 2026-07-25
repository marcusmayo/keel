#!/usr/bin/env python3
"""Deterministic Azure DevOps CSV normalizer. Reads an ADO work-item CSV export,
maps type + state (per process template) to canonical values, and writes one
normalized JSON consumed by reconcile. Stdlib only. No LLM. Read-only: writes only
to the normalized-state output; never mutates portfolio state.

Third ingestion lane, matching tools/normalize_jira.py's record shape exactly and
tools/normalize_backlog.py's single-file output. Canonical status vocabulary and the
unmapped/unknown forms are taken from normalize_jira.py -- see that file for the source
of truth. ADO states with no defensible canonical target pass through as unmapped:<state>
(a WARNING, not a failure); unrecognized types are flagged unknown, never guessed.

Usage:  normalize_ado.py [csv_path] [--template agile|scrum|cmmi]
  csv_path         explicit file; default = newest knowledge/import/raw/*ado*.csv (case-insensitive)
  --template       ADO process template (also ADO_PROCESS_TEMPLATE env); default agile
Env overrides (no code edit needed):
  ADO_OUT          output path (default state/normalized/ado.json)
  ADO_FIELD_MAP    JSON: logical->ADO column name, to override the defaults below
  ADO_STATE_MAP    JSON: {state_lower: canonical} for a CUSTOM process template
"""
import csv, glob, json, os, sys
from pathlib import Path

# --- canonical status vocabulary (source of truth: tools/normalize_jira.py STATUS_MAP) ---
CANON = {"done", "not-started", "in-progress", "blocked", "analysis"}

# --- field map: logical -> ADO column (declared, overridable via ADO_FIELD_MAP) ---
FIELD_MAP = {
    "ref":         "ID",
    "type":        "Work Item Type",
    "name":        "Title",
    "assigned_to": "Assigned To",   # expected present; ignored in output, not invented
    "status":      "State",
    "tags":        "Tags",          # expected present; ignored in output, not invented
}
try:
    FIELD_MAP.update(json.loads(os.environ["ADO_FIELD_MAP"]))
except KeyError:
    pass
EMITTED_LOGICALS = ("ref", "type", "name", "status")   # the 4 that map to canonical fields

# --- ADO work item type -> canonical type (unrecognized -> unknown, never guessed) ---
TYPE_MAP = {
    "epic": "epic",
    "feature": "feature",
    "user story": "story",
    "product backlog item": "story",
    "requirement": "story",
    "task": "task",
    "bug": "bug",
}

# --- types that cannot round-trip through CSV: excluded at ingest, counted by type ---
EXCLUDED_TYPES = {
    "test case", "test plan", "test suite",
    "code review request", "code review response",
    "feedback request", "feedback response",
    "shared steps", "shared parameters",
}

# --- state map keyed by process template. States absent here pass through as unmapped. ---
# Vocabularies per ADO's stock process docs (states differ across templates AND across
# work item types within a template -- the union of a template's type states lives here).
STATE_MAP = {
    "agile": {"new": "not-started", "active": "in-progress", "resolved": "in-progress", "closed": "done"},
    "scrum": {"new": "not-started", "approved": "not-started", "committed": "in-progress",
              "done": "done", "to do": "not-started", "in progress": "in-progress"},
    "cmmi":  {"proposed": "not-started", "active": "in-progress", "resolved": "in-progress", "closed": "done"},
}
# self-check: never emit a status token outside the canon
for _t, _m in STATE_MAP.items():
    _bad = {v for v in _m.values() if v not in CANON}
    if _bad:
        sys.exit(f"ABORT: STATE_MAP[{_t}] targets non-canonical tokens {_bad}")

EXPORT_CAP = 1000  # ADO CSV export hard cap on work items per file

RAW_GLOB = "knowledge/import/raw/*.csv"
OUT = Path(os.environ.get("ADO_OUT") or "state/normalized/ado.json")


def parse_args(argv):
    csv_path, template = None, None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--template":
            i += 1
            template = argv[i] if i < len(argv) else None
        elif a.startswith("--template="):
            template = a.split("=", 1)[1]
        elif not a.startswith("-") and csv_path is None:
            csv_path = a
        i += 1
    template = (template or os.environ.get("ADO_PROCESS_TEMPLATE") or "agile").strip().lower()
    return csv_path, template


def resolve_state_map(template):
    if template in STATE_MAP:
        return STATE_MAP[template]
    custom = os.environ.get("ADO_STATE_MAP")
    if custom:
        return {k.strip().lower(): v for k, v in json.loads(custom).items()}
    sys.exit(f"ABORT: unknown process template {template!r}. "
             f"Known: {', '.join(sorted(STATE_MAP))}. "
             f"For a custom process, set ADO_STATE_MAP to a JSON state->canonical map.")


def newest_ado_csv():
    files = [f for f in glob.glob(RAW_GLOB) if "ado" in os.path.basename(f).lower()]
    if not files:
        sys.exit(f"ABORT: no ADO CSV in {RAW_GLOB} (filename must contain 'ado'). "
                 f"Pass an explicit path as the first argument.")
    files.sort(key=lambda f: (os.path.basename(f), os.path.getmtime(f)))
    return files[-1]


def build_index(header):
    norm = [h.strip().lower() for h in header]
    idx = {}
    for logical, col in FIELD_MAP.items():
        try:
            idx[logical] = norm.index(col.strip().lower())
        except ValueError:
            sys.exit(f"ABORT: required ADO column missing: {col!r}. "
                     f"Expected columns: {[FIELD_MAP[l] for l in FIELD_MAP]}. Header had: {header}")
    return idx


def cell(row, i):
    return (row[i] or "").strip() if i < len(row) else ""


def main():
    csv_path, template = parse_args(sys.argv[1:])
    state_map = resolve_state_map(template)
    src = Path(csv_path) if csv_path else Path(newest_ado_csv())

    with open(src, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))
    if not rows:
        sys.exit(f"ABORT: empty CSV: {src}")
    header, raw_data = rows[0], rows[1:]
    idx = build_index(header)

    # drop genuinely empty trailing rows before counting/capping
    data = [r for r in raw_data if any((c or "").strip() for c in r)]

    # boundary: 1,000-item export cap (loud, names the count + remedy)
    if len(data) > EXPORT_CAP:
        sys.exit(f"ABORT: ADO CSV has {len(data)} work items; the export cap is {EXPORT_CAP} per file. "
                 f"Remedy: split the query (e.g. by area path or iteration) and normalize each file.")

    out_rows = []
    type_counts, status_counts, excluded_counts = {}, {}, {}
    unmapped_status, unknown_types = set(), 0

    for row in data:
        rawtype = cell(row, idx["type"])
        tkey = rawtype.lower()

        # boundary: excluded types are dropped at ingest, counted by raw type
        if tkey in EXCLUDED_TYPES:
            excluded_counts[rawtype] = excluded_counts.get(rawtype, 0) + 1
            continue

        rawstat = cell(row, idx["status"])
        skey = rawstat.lower()
        if skey in state_map:
            status = state_map[skey]
        else:
            status = f"unmapped:{skey}"
            unmapped_status.add(skey)

        if tkey in TYPE_MAP:
            wtype = TYPE_MAP[tkey]
        else:
            wtype = "unknown"
            unknown_types += 1

        rec = {
            "type": wtype,
            "name": cell(row, idx["name"]),
            "status": status,
            "raw_status": rawstat,
            "source": {"origin": "ado", "ref": cell(row, idx["ref"])},
            "parent": "",       # no Parent in the ADO expected column set -> shape preserved, value empty
            "priority": "",     # no Priority column -> empty
            "resolution": "",   # no Resolution column -> empty
        }
        if wtype == "unknown":
            rec["_flag"] = f"unknown ADO type: {rawtype!r}"

        out_rows.append(rec)
        type_counts[wtype] = type_counts.get(wtype, 0) + 1
        status_counts[status] = status_counts.get(status, 0) + 1

    payload = {
        "source_file": os.path.basename(str(src)),
        "process_template": template,
        "count": len(out_rows),
        "rows_read": len(data),
        "type_counts": dict(sorted(type_counts.items())),
        "status_counts": dict(sorted(status_counts.items())),
        "excluded_counts": dict(sorted(excluded_counts.items())),
        "rows": out_rows,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    # deterministic: no timestamp, input row order, sorted count dicts
    OUT.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    # --- counts summary (invariant 6): read, emitted, excluded-by-rule, unmapped, unknown ---
    print(f"=== normalize-ado [template={template}]: {os.path.basename(str(src))} ===")
    print(f"  rows read:    {len(data)}")
    print(f"  rows emitted: {len(out_rows)}  -> {OUT}")
    if excluded_counts:
        print(f"  excluded (cannot round-trip through CSV): {sum(excluded_counts.values())}")
        for t, c in sorted(excluded_counts.items()):
            print(f"     {c:4d}  {t}")
    print(f"  type counts:  {dict(sorted(type_counts.items()))}")
    print(f"  status counts:{dict(sorted(status_counts.items()))}")
    if unknown_types:
        print(f"  WARNING: {unknown_types} rows had unknown ADO type (flagged, not guessed)")
    if unmapped_status:
        print(f"  WARNING: unmapped statuses (passed through flagged): {sorted(unmapped_status)}")
    else:
        print("  all statuses mapped cleanly")


if __name__ == "__main__":
    main()
