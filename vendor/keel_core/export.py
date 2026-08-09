"""Reconcile result -> workbook bytes.

Ported from tools/export_reconcile.py. Same sheet order, same column order, same
header styling. The only structural change is that this returns bytes instead of
writing exports/reconcile-<date>.xlsx: a library that writes files cannot be
used by three callers with different storage (product rule 1), and the date in
the legacy filename was another clock read (FIX A8).
"""
import io

from .schema import MissingDependencyError, validate_result

COLUMNS = [
    ("src_name", "Backlog Item"),
    ("src_ref", "Source Ref"),
    ("type", "Type"),
    ("src_status", "Backlog Status"),
    ("keel_key", "Keel Key"),
    ("keel_name", "Keel Item"),
    ("keel_status", "Keel Status"),
    ("wsjf", "WSJF"),
    ("rice", "RICE"),
    ("score", "Match"),
    ("verdict", "Verdict"),
    ("semantic_verdict", "Semantic"),
    ("semantic_reason", "Semantic Reason"),
    ("reason", "Reason"),
    ("action", "Proposed Action"),
]

# Duplicate rows gained two fields in the fixed mode (FIXES A6/A7). They are
# appended rather than inserted, so every existing column keeps its position.
EXTRA_COLUMNS = [
    ("dupe_of_src_name", "Duplicate Of"),
    ("dupe_of_src_ref", "Duplicate Of Ref"),
]

SHEET_ORDER = ["completed", "conflict", "ambiguous", "changed",
               "duplicate", "gap", "done_gap"]

WIDTHS = {"src_name": 42, "keel_name": 38, "reason": 40, "action": 26,
          "semantic_reason": 48, "semantic_verdict": 11, "src_status": 16,
          "keel_status": 14, "dupe_of_src_name": 38, "dupe_of_src_ref": 16}

_HEADER_FILL = "1F3B1B"


def _columns_for(rows):
    cols = list(COLUMNS)
    for key, label in EXTRA_COLUMNS:
        if any(key in r for r in rows):
            cols.append((key, label))
    return cols


def to_workbook(result, include_empty=False, warnings_sheet=True):
    """Render a reconcile result as .xlsx bytes.

    One sheet per non-empty bucket, in review order. When the result carries
    warnings, they get their own sheet -- a degraded run must be visible to
    whoever opens the workbook, not only to whoever read the JSON.
    """
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Alignment, Font, PatternFill
        from openpyxl.utils import get_column_letter
    except ModuleNotFoundError as e:  # pragma: no cover - exercised in tests
        raise MissingDependencyError(
            "rendering a workbook requires the optional 'xlsx' extra",
            value="openpyxl",
            hint='pip install "keel-core[xlsx]"') from e

    result = validate_result(result)
    wb = Workbook()
    wb.remove(wb.active)

    header_fill = PatternFill("solid", fgColor=_HEADER_FILL)
    header_font = Font(bold=True, color="FFFFFF")

    for bucket in SHEET_ORDER:
        rows = result["buckets"].get(bucket, [])
        if not rows and not include_empty:
            continue
        cols = _columns_for(rows)
        ws = wb.create_sheet(title=bucket[:31])
        for c, (_, label) in enumerate(cols, 1):
            cell = ws.cell(row=1, column=c, value=label)
            cell.fill = header_fill
            cell.font = header_font
            cell.alignment = Alignment(vertical="top", wrap_text=True)
        for r, row in enumerate(rows, 2):
            for c, (key, _) in enumerate(cols, 1):
                v = row.get(key, "")
                ws.cell(row=r, column=c, value="" if v is None else v)
        for c, (key, _) in enumerate(cols, 1):
            ws.column_dimensions[get_column_letter(c)].width = WIDTHS.get(key, 12)
        ws.freeze_panes = "A2"
        ws.auto_filter.ref = f"A1:{get_column_letter(len(cols))}{len(rows) + 1}"

    warnings = result.get("warnings") or []
    if warnings and warnings_sheet:
        ws = wb.create_sheet(title="warnings")
        for c, label in enumerate(["Code", "Message", "Context"], 1):
            cell = ws.cell(row=1, column=c, value=label)
            cell.fill = header_fill
            cell.font = header_font
        for r, w in enumerate(warnings, 2):
            ws.cell(row=r, column=1, value=w.get("code", ""))
            ws.cell(row=r, column=2, value=w.get("message", ""))
            ws.cell(row=r, column=3, value=w.get("context", ""))
        for c, width in enumerate([26, 72, 40], 1):
            ws.column_dimensions[get_column_letter(c)].width = width
        ws.freeze_panes = "A2"

    if not wb.sheetnames:
        ws = wb.create_sheet(title="empty")
        ws["A1"] = "No rows in any bucket."

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
