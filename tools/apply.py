#!/usr/bin/env python3
"""Apply reconcile proposals into state/ as real work items. DRY-RUN by default
(prints what it would create, writes nothing). Pass --commit to write.
Lands: gap (active, unmatched) as new items with source-status; done_gap as status:done.
Holds: ambiguous (semantic pass), duplicate (manual merge). Never overwrites. Logs.
Deterministic. No LLM. git-reversible."""

import json, re, sys, glob
from pathlib import Path
from datetime import datetime

RECON = Path("state/normalized/reconcile.json")
import sys as _sys
_sys.path.insert(0, str(Path(__file__).resolve().parent))
from resolve_parent import Resolver as _Resolver
from _require import require
_NORM_JIRA = Path("state/normalized/jira-portfolio.json")
STATE = Path("state")
LOG   = Path("state/daily-logs")

COMMIT = "--commit" in sys.argv
# --only <bucket> restricts which buckets land (gap | done_gap | all). Default all.
ONLY = "all"
if "--only" in sys.argv:
    i = sys.argv.index("--only")
    if i + 1 < len(sys.argv):
        ONLY = sys.argv[i + 1]

# which buckets land, and the status each maps to
# gap -> active item with source-status; done_gap -> status:done
SRC_STATUS_MAP = {
    "done": "done", "not-started": "backlog", "in-progress": "in-progress",
    "blocked": "blocked", "analysis": "backlog",
}

WORD = re.compile(r"[a-z0-9]+")
def slugify(name):
    toks = WORD.findall((name or "").lower())
    return "-".join(toks)[:60] or "untitled"

def next_key(prefix):
    """Highest existing PREFIX-N across state/, numeric. Returns next N."""
    hi = 0
    for f in glob.glob("state/*.yaml"):
        for m in re.finditer(rf"key:\s*{prefix}-(\d+)", Path(f).read_text(encoding="utf-8")):
            hi = max(hi, int(m.group(1)))
    return hi + 1

def existing_slugs():
    slugs = set()
    for f in glob.glob("state/*.yaml"):
        slugs.add(Path(f).stem)
    return slugs

def existing_refs():
    """Set of source.ref (source keys) already present in state/. Idempotency guard:
    a row whose ref is already landed is skipped, so re-running apply is a no-op."""
    refs = set()
    for f in glob.glob("state/*.yaml"):
        for m in re.finditer(r"^\s*source:.*ref:\s*([A-Z]+-\d+)", Path(f).read_text(encoding="utf-8"), re.M):
            refs.add(m.group(1))
    return refs

def esc(s):
    """Escape for a double-quoted YAML scalar."""
    return (s or "").replace("\\", "\\\\").replace('"', '\\"')

def item_yaml(key, typ, name, slug, status, ref, src_status, parent=""):
    """Render a work-item YAML matching the template. Draft-import flagged."""
    today = datetime.now().strftime("%Y-%m-%d")
    return f"""workitem:
  type: {typ}
  key: {key}
  name: "{esc(name)}"
  slug: {slug}
  summary: "{esc(name)}"   # [draft - review] imported from Jira; refine

  parent: "{parent}"                # [draft - review] link to parent epic if applicable

  description: "[draft - review] Imported from Jira {ref} (status: {src_status}). Original summary: {esc(name)}"

  acceptance_criteria: []   # [draft - review] define after import review

  size: ""                  # [draft - review]

  stage: discovery
  status: {status}
  next_action: ""
  next_action_ref: ""
  source: {{origin: jira, ref: {ref}}}

  prioritization:
    wsjf: {{user_business_value: "", time_criticality: "", risk_reduction_opportunity: "", job_size: "", score: ""}}
    rice: {{reach: "", impact: "", confidence: "", effort: "", score: ""}}
    status: unscored

  priority_override: {{rank: "", reason: "", set_by: "", date: ""}}

  stakeholders: []
  flag: draft-import
  imported: {today}
  updated: {today}
"""

def main():
    data = json.loads(require(RECON).read_text(encoding="utf-8"))
    buckets = data["buckets"]
    _ref2pid = {}
    try:
        for _r in json.loads(require(_NORM_JIRA).read_text(encoding="utf-8"))["rows"]:
            _ref = (_r.get("source") or {}).get("ref", "")
            if _ref:
                _ref2pid[_ref] = str(_r.get("parent", "") or "")
        _resolver = _Resolver()
    except (Exception, SystemExit):
        # resolve_parent raises SystemExit (BaseException) when the raw jira CSV is
        # absent; the backlog-only lane must degrade to no-parent-enrichment, not die.
        _ref2pid, _resolver = {}, None

    # collect what lands: gap (active) + done_gap (done-reference)
    to_land = []
    if ONLY in ("all", "gap"):
        for row in buckets.get("gap", []):
            typ = row.get("type", "")
            src_status = (row.get("src_status") or "not-started").strip().lower()
            status = SRC_STATUS_MAP.get(src_status, "backlog")
            to_land.append(("gap", typ, row, status, src_status))
    if ONLY in ("all", "done_gap"):
        for row in buckets.get("done_gap", []):
            typ = row.get("type", "")
            to_land.append(("done_gap", typ, row, "done", "done"))

    # assign keys (numeric, per type), check slug collisions
    slugs = existing_slugs()
    landed_refs = existing_refs()
    ep_n = next_key("EP")
    st_n = next_key("ST")

    plan = []
    skipped = []
    for bucket, typ, row, status, src_status in to_land:
        name = row.get("src_name", "")
        ref  = row.get("src_ref", "") or ""
        if ref and ref in landed_refs:
            skipped.append((typ, name, f"already landed (ref {ref})"))
            continue
        slug = slugify(name)

        if typ == "epic":
            key = f"EP-{ep_n:03d}"; ep_n += 1
        elif typ == "story":
            key = f"ST-{st_n:03d}"; st_n += 1
        else:
            skipped.append((typ, name, "non-epic/story type in landable bucket"))
            continue

        # slug collision -> disambiguate with key suffix, or skip if exact file exists
        base_slug = f"{typ}-{slug}"
        final_slug = base_slug
        if final_slug in slugs:
            final_slug = f"{base_slug}-{key.lower()}"
        if final_slug in slugs:
            skipped.append((typ, name, f"slug exists: {final_slug}"))
            continue
        slugs.add(final_slug)

        _pkeel = ""
        if _resolver and ref:
            _pid = _ref2pid.get(ref, "")
            if _pid:
                _pkeel = _resolver.resolve(_pid)
        plan.append({
            "bucket": bucket, "key": key, "type": typ, "name": name,
            "slug": final_slug, "status": status, "ref": ref, "src_status": src_status,
            "parent": _pkeel,
            "path": f"state/{final_slug}.yaml",
        })

    # --- report ---
    n_gap  = sum(1 for p in plan if p["bucket"] == "gap")
    n_done = sum(1 for p in plan if p["bucket"] == "done_gap")
    n_ep   = sum(1 for p in plan if p["type"] == "epic")
    n_st   = sum(1 for p in plan if p["type"] == "story")

    mode = ("COMMIT" if COMMIT else "DRY-RUN") + f" only={ONLY}"
    print(f"=== apply [{mode}] ===")
    print(f"  would create: {len(plan)} items ({n_gap} active gap, {n_done} done-reference)")
    print(f"    by type: {n_ep} epics, {n_st} stories")
    print(f"    key ranges: EP-{next_key('EP'):03d}..  ST-{next_key('ST'):03d}..")
    if skipped:
        print(f"  skipped: {len(skipped)}")
        for t, n, why in skipped[:10]:
            print(f"    [{t}] {n[:40]!r} - {why}")
    print()
    print("  sample of items to create:")
    for p in plan[:6]:
        print(f"    {p['key']}  {p['status']:12s}  {p['name'][:44]!r}  <- {p['ref']}")
    if len(plan) > 6:
        print(f"    ... +{len(plan)-6} more")

    if not COMMIT:
        print(f"\n  DRY-RUN: nothing written. Re-run with --commit to create {len(plan)} files.")
        return

    # --- commit: write files + log ---
    written = []
    for p in plan:
        content = item_yaml(p["key"], p["type"], p["name"], p["slug"],
                            p["status"], p["ref"], p["src_status"], p.get("parent", ""))
        Path(p["path"]).write_text(content, encoding="utf-8")
        written.append(p)

    # append to today's daily log
    today = datetime.now().strftime("%Y-%m-%d")
    LOG.mkdir(parents=True, exist_ok=True)
    logf = LOG / f"{today}.md"
    lines = [f"\n## Apply (import from Jira) - {datetime.now().strftime('%H:%M')}\n",
             f"Created {len(written)} draft-import work items ({n_gap} active, {n_done} done-reference).\n"]
    for p in written:
        lines.append(f"- {p['key']} ({p['status']}) {p['name'][:50]} [jira {p['ref']}]\n")
    with open(logf, "a", encoding="utf-8") as f:
        f.writelines(lines)

    print(f"\n  COMMITTED: wrote {len(written)} files to state/")
    print(f"  logged to {logf}")
    print(f"  all flagged draft-import. Review, then flip to live. git-reversible: git checkout state/")

if __name__ == "__main__":
    main()
