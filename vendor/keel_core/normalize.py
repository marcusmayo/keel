"""Pure normalizers: raw source rows in, canonical work items out.

Ported from tools/normalize_jira.py and tools/normalize_backlog.py. Everything
those tools read from ambient state -- the newest file in a glob, keel.config
.json, state/backlog-type-overrides.json -- is now an argument. Parsing helpers
accept text or bytes so callers do their own IO.
"""
import csv
import io
import json
import re

from .schema import MissingDependencyError, ParseError, Warning_

# ------------------------------------------------------------------ jira maps
JIRA_COLS = {
    "key": "Issue key", "type": "Issue Type", "status": "Status",
    "name": "Summary", "parent": "Parent", "priority": "Priority",
    "resolution": "Resolution",
}
JIRA_PORTFOLIO_TYPES = {"epic": "epic", "story": "story", "task": "task"}
JIRA_BUG_TYPES = {"bug": "bug"}
JIRA_SUBTASK_TYPES = {"sub-task": "sub-task", "subtask": "sub-task"}
JIRA_STATUS_MAP = {
    "done": "done", "dev verified": "done", "deployed dev": "done",
    "to do": "not-started", "in progress": "in-progress",
    "code review": "in-progress", "dev testing": "in-progress",
    "blocked": "blocked", "analysis": "analysis",
    "requirement gathering": "analysis",
}

# --------------------------------------------------------------- backlog maps
BACKLOG_STATUS_MAP = {
    "DONE": "done", "NYS": "not-started", "IP": "in-progress",
    "DUPLICATE": "dedup-flag", "IN ANALYSIS": "analysis",
    "NEEDS ANALYSIS": "analysis", "BLOCKED": "blocked", "": "unscored",
}
BACKLOG_TYPE_VOCAB = {"epic", "feature", "story"}


def parse_jira_csv(text):
    """Jira CSV export text -> (header, rows). utf-8-sig is stripped by the caller."""
    if isinstance(text, bytes):
        text = text.decode("utf-8-sig")
    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        raise ParseError("Jira CSV is empty", value=None,
                         hint="export at least a header row from Jira")
    return rows[0], rows[1:]


def parse_backlog_xlsx(data, header_marker="Task #"):
    """Backlog workbook bytes -> list of dicts keyed by the header row.

    Sheet selected by the presence of `header_marker` in row 1, ignoring junk
    sheets, exactly as legacy did. Values stringified; None -> ''; integral
    floats -> int string.
    """
    try:
        from openpyxl import load_workbook
    except ModuleNotFoundError as e:  # pragma: no cover - exercised in tests
        raise MissingDependencyError(
            "reading a backlog workbook requires the optional 'xlsx' extra",
            value="openpyxl",
            hint='pip install "keel-core[xlsx]"') from e
    if isinstance(data, str):
        raise ParseError("backlog workbook must be bytes", value="str",
                         hint="read the .xlsx in binary mode and pass the bytes")
    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    ws = None
    for name in wb.sheetnames:
        first = next(wb[name].iter_rows(max_row=1, values_only=True), ())
        if any(str(v).strip() == header_marker for v in first if v is not None):
            ws = wb[name]
            break
    if ws is None:
        raise ParseError("no sheet carrying the header marker", value=header_marker,
                         hint="check the workbook has a sheet with a 'Task #' header cell")
    rows_iter = ws.iter_rows(values_only=True)
    headers = [str(h).strip() if h is not None else "" for h in next(rows_iter)]
    out = []
    for row in rows_iter:
        d = {}
        for h, v in zip(headers, row):
            if not h:
                continue
            if v is None:
                d[h] = ""
            elif isinstance(v, float) and v.is_integer():
                d[h] = str(int(v))
            else:
                d[h] = str(v)
        out.append(d)
    return out


def _index(header):
    idx = {}
    for logical, colname in JIRA_COLS.items():
        found = None
        for i, h in enumerate(header):
            if h.strip().lower() == colname.lower():
                found = i
                break
        idx[logical] = found
    if idx["key"] is None or idx["type"] is None:
        raise ParseError("required Jira columns missing",
                         value={"need": ["Issue key", "Issue Type"],
                                "header_sample": header[:10]},
                         hint="re-export from Jira including key and type columns")
    return idx


def _cell(row, i):
    if i is None or i >= len(row):
        return ""
    return (row[i] or "").strip()


def normalize_jira(header, rows, config=None):
    """Jira rows -> {'portfolio': [...], 'bugs': [...], 'subtasks': [...],
    'counts': {...}, 'warnings': [...]}. Pure; writes nothing."""
    idx = _index(header)
    portfolio, bugs, subtasks = [], [], []
    type_counts, status_counts = {}, {}
    unmapped = set()

    for row in rows:
        rawtype = _cell(row, idx["type"]).lower()
        rawstat = _cell(row, idx["status"])
        status = JIRA_STATUS_MAP.get(rawstat.strip().lower(),
                                     f"unmapped:{rawstat.strip().lower()}")
        if status.startswith("unmapped:"):
            unmapped.add(rawstat)

        rec = {
            "type": None,
            "name": _cell(row, idx["name"]),
            "status": status,
            "raw_status": rawstat,
            "source": {"origin": "jira", "ref": _cell(row, idx["key"])},
            "parent": _cell(row, idx["parent"]),
            "priority": _cell(row, idx["priority"]),
            "resolution": _cell(row, idx["resolution"]),
        }
        type_counts[rawtype] = type_counts.get(rawtype, 0) + 1
        status_counts[rawstat] = status_counts.get(rawstat, 0) + 1

        if rawtype in JIRA_PORTFOLIO_TYPES:
            rec["type"] = JIRA_PORTFOLIO_TYPES[rawtype]
            portfolio.append(rec)
        elif rawtype in JIRA_BUG_TYPES:
            rec["type"] = "bug"
            bugs.append(rec)
        elif rawtype in JIRA_SUBTASK_TYPES:
            rec["type"] = "sub-task"
            subtasks.append(rec)
        else:
            rec["type"] = "unknown"
            rec["_flag"] = f"unknown Jira type: {rawtype!r}"
            portfolio.append(rec)

    warnings = []
    if unmapped:
        warnings.append(Warning_("UNMAPPED_STATUS",
                                 "source statuses had no mapping and were passed through flagged",
                                 ", ".join(sorted(unmapped))))
    unknown_types = sum(1 for r in portfolio if r["type"] == "unknown")
    if unknown_types:
        warnings.append(Warning_("UNKNOWN_TYPE",
                                 f"{unknown_types} rows had an unrecognised Jira type (flagged, never guessed)",
                                 ""))
    return {"portfolio": portfolio, "bugs": bugs, "subtasks": subtasks,
            "counts": {"type": type_counts, "status": status_counts},
            "warnings": warnings}


def _clean(v):
    if v is None:
        return ""
    v = v.replace("\u00a0", " ").strip()
    return "" if v in ("", "-") else v


def normalize_backlog(raw_rows, config=None):
    """Backlog rows -> {'rows': [...], 'type_counts': {...}, 'warnings': [...]}.

    `source_key_prefix` and `type_overrides` come from config, not from
    keel.config.json and state/backlog-type-overrides.json.
    """
    from .schema import ReconcileConfig
    cfg = config or ReconcileConfig()
    overrides = cfg.type_overrides or {}
    key_re = (re.compile(re.escape(cfg.source_key_prefix) + r"-\d+")
              if cfg.source_key_prefix else None)

    rows = []
    type_counts = {"epic": 0, "feature": 0, "story": 0, "unknown": 0}
    unknown_type, unknown_status, dedup, refs_found = [], [], [], []

    for n, raw in enumerate(raw_rows, start=1):
        name = _clean(raw.get("Feature"))
        rawtype = _clean(raw.get("Type"))
        rawstat = _clean(raw.get("Status"))
        notes = _clean(raw.get("Notes"))
        taskid = _clean(raw.get("Task #"))
        if not name and not rawtype and not rawstat and not notes:
            continue

        t = rawtype.lower()
        ovr = overrides.get(taskid)
        if t in BACKLOG_TYPE_VOCAB:
            wtype = t
        elif ovr and ovr.get("name", "").strip().lower() == name.strip().lower():
            wtype = ovr["type"]
        else:
            wtype = "unknown"
            unknown_type.append(f"row {n} {taskid!r}: type={rawtype or 'EMPTY'!r} name={name!r}")
        type_counts[wtype] = type_counts.get(wtype, 0) + 1

        skey = rawstat.upper()
        if skey in BACKLOG_STATUS_MAP:
            wstat = BACKLOG_STATUS_MAP[skey]
        else:
            wstat = "unknown"
            unknown_status.append(f"row {n} {taskid!r}: status={rawstat!r}")
        if wstat == "dedup-flag":
            dedup.append(f"row {n} {taskid!r}: {name!r}")

        found = key_re.findall(notes) if key_re else []
        if found:
            refs_found.append(f"row {n} {taskid!r}: {found}")

        rows.append({
            "type": wtype,
            "name": name,
            "status": wstat,
            "raw_status": rawstat,
            "effort_weeks": _clean(raw.get("Weeks")),
            "priority": _clean(raw.get("Priority")),
            "description": ("[draft - review] " + notes) if notes else "",
            "task_id": taskid,
            "parent": "",
            "source": {"origin": "backlog-xlsx", "ref": found[0] if found else ""},
        })

    warnings = []
    if unknown_type:
        warnings.append(Warning_("UNKNOWN_TYPE",
                                 f"{len(unknown_type)} rows had no recognised type (never guessed)",
                                 "; ".join(unknown_type[:8])))
    if unknown_status:
        warnings.append(Warning_("UNKNOWN_STATUS",
                                 f"{len(unknown_status)} rows had an unrecognised status",
                                 "; ".join(unknown_status[:8])))
    if dedup:
        warnings.append(Warning_("SOURCE_DECLARED_DUPLICATE",
                                 f"{len(dedup)} rows are flagged Duplicate at source",
                                 "; ".join(dedup[:8])))
    return {"rows": rows, "type_counts": type_counts,
            "embedded_refs": refs_found, "warnings": warnings}


# ----------------------------------------------------- keel state + resolutions
def parse_keel_items(sources):
    """`{identifier: yaml_text}` -> (items, warnings).

    FIX A2/A3: a YAML parse failure is recorded as a warning naming the file and
    the reason, and the item is reported as excluded. Legacy printed to stderr
    (reconcile) or said nothing at all (find), so the missing item resurfaced
    downstream as a business finding.
    """
    import yaml
    items, warnings = [], []
    for ident in sorted(sources):
        text = sources[ident]
        try:
            d = yaml.safe_load(text)
        except Exception as e:
            warnings.append(Warning_("STATE_ITEM_UNPARSEABLE",
                                     f"could not parse item; it is EXCLUDED from this run: {e}",
                                     ident))
            continue
        w = (d or {}).get("workitem")
        if not w:
            warnings.append(Warning_("STATE_ITEM_EMPTY",
                                     "file carries no 'workitem' block; excluded", ident))
            continue
        pr = w.get("prioritization") or {}
        items.append({
            "key": w.get("key", ""), "type": w.get("type", ""),
            "name": w.get("name", ""), "status": w.get("status", ""),
            "stage": w.get("stage", ""),
            "wsjf": ((pr.get("wsjf") or {}).get("score", "")),
            "rice": ((pr.get("rice") or {}).get("score", "")),
            "pstat": pr.get("status", ""),
            "ref": ((w.get("source") or {}).get("ref", "")),
            "updated": w.get("updated", ""), "file": ident,
        })
    return items, warnings


def parse_resolutions(text):
    """Durable operator decisions -> {keel_key: record}. `None` means 'no
    resolutions supplied' and yields {}.

    FIX A1: legacy caught bare Exception and returned {} on a malformed file,
    silently discarding every confirmed MERGE link and re-judging every settled
    DISTINCT. In a system whose promise is that operator decisions are durable,
    that erased the record of human judgment without a word. A parse failure now
    raises; a caller who genuinely has no resolutions passes None.
    """
    if text is None:
        return {}
    try:
        data = json.loads(text)
    except Exception as e:
        raise ParseError("resolutions file is not valid JSON -- refusing to "
                         "silently discard durable operator decisions",
                         value=str(e),
                         hint="repair the file, or pass resolutions=None to run without it")
    out = {}
    for r in data.get("resolutions", []):
        if r.get("keel_key"):
            out[r["keel_key"]] = r
    return out
