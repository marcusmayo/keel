#!/usr/bin/env python3
"""Deterministic reconcile: compare a normalized source (Jira portfolio by default,
or backlog) against the Keel portfolio items. Exact-ref match first (source keys), then
title fallback. Filters to epic+story for the portfolio. Adds a done_gap bucket:
completed source items with no Keel match (redundancy visibility). Stdlib + PyYAML.
No LLM. Ambiguous bucket held for the semantic pass."""

import json, re, sys, glob
from pathlib import Path
from datetime import datetime
import yaml
from _require import require

# --- source selection: default Jira portfolio; accept an arg for backlog ---
SOURCES = {
    "jira":    Path("state/normalized/jira-portfolio.json"),
    "backlog": Path("state/normalized/backlog.json"),
    "ado":     Path("state/normalized/ado.json"),
}
which = sys.argv[1] if len(sys.argv) > 1 else "jira"
if which not in SOURCES:
    sys.exit(f"ABORT: unknown reconcile lane {which!r}. Valid lanes: {', '.join(sorted(SOURCES))}")
NORM = SOURCES[which]
OUT  = Path("state/normalized/reconcile.json")
STATE_GLOB = "state/*.yaml"

# portfolio scope: only these types reconcile into the portfolio
PORTFOLIO_TYPES = {"epic", "story"}

HIGH = 0.80
LOW  = 0.40

WORD = re.compile(r"[a-z0-9]+")
def toks(s):
    return set(WORD.findall((s or "").lower()))

def overlap(a, b):
    ta, tb = toks(a), toks(b)
    if not ta or not tb:
        return 0.0
    inter = len(ta & tb)
    if inter == 0:
        return 0.0
    # Guard: a 1-token generic title ("Mobile") must not score high off one shared word.
    # Require both sides >=2 tokens for the subset (min) formula; else Jaccard. Exact
    # 1-token matches still score 1.0 (union == inter).
    if min(len(ta), len(tb)) >= 2:
        return inter / min(len(ta), len(tb))
    return inter / len(ta | tb)

RESOLUTIONS = Path("state/resolutions.json")

def load_resolutions():
    """Durable operator decisions on keel-origin items: {keel_key: record}.
    decision MERGE -> confirmed same as jira_ref (treat as ref-linked, never re-judge).
    decision DISTINCT -> confirmed no Jira counterpart (never re-judge).
    Empty dict if the file does not exist yet (safe before first resolution)."""
    if not RESOLUTIONS.exists():
        return {}
    try:
        data = json.loads(RESOLUTIONS.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return {r["keel_key"]: r for r in data.get("resolutions", []) if r.get("keel_key")}

def load_keel():
    items = []
    for f in sorted(glob.glob(STATE_GLOB)):
        if "/_" in f or Path(f).name.startswith("_"):
            continue
        try:
            d = yaml.safe_load(Path(f).read_text(encoding="utf-8"))
        except Exception as e:
            print(f"  WARN: could not parse {f}: {e}", file=sys.stderr)
            continue
        w = (d or {}).get("workitem")
        if not w:
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
            "updated": w.get("updated", ""), "file": f,
        })
    # apply durable resolutions: a confirmed MERGE stamps the jira_ref onto the keel
    # item (so it is treated as ref-linked, not re-judged); DISTINCT is tagged settled.
    res = load_resolutions()
    for it in items:
        r = res.get(it["key"])
        if not r:
            it["resolution"] = ""
            continue
        it["resolution"] = r.get("decision", "")
        if r.get("decision") == "MERGE" and r.get("jira_ref") and not it["ref"]:
            it["ref"] = r["jira_ref"]
    return items

KEEL_DONE = {"done", "released", "complete", "completed"}
SRC_DONE  = {"done"}

def main():
    nd = json.loads(require(NORM).read_text(encoding="utf-8"))
    all_rows = nd["rows"]
    # portfolio scope filter: epic + story only
    backlog = [r for r in all_rows if r.get("type") in PORTFOLIO_TYPES]
    skipped_types = {}
    for r in all_rows:
        if r.get("type") not in PORTFOLIO_TYPES:
            skipped_types[r.get("type")] = skipped_types.get(r.get("type"), 0) + 1

    keel = load_keel()

    buckets = {"changed": [], "duplicate": [], "completed": [],
               "conflict": [], "gap": [], "done_gap": [], "ambiguous": []}

    seen_titles = {}
    for row in backlog:
        nt = " ".join(sorted(toks(row["name"])))
        rref = (row.get("source") or {}).get("ref", "")
        rstat = row.get("status", "")

        if row.get("status") == "dedup-flag":
            buckets["duplicate"].append({
                "src_name": row["name"], "src_ref": rref,
                "src_status": row.get("raw_status", ""), "keel_key": "", "keel_name": "",
                "verdict": "duplicate", "reason": "source-declared Duplicate",
                "action": "confirm/merge - operator",
                "wsjf": "", "rice": "", "type": row.get("type", "")})
            continue
        _dupkey = (nt, row.get("type", ""))
        if nt and _dupkey in seen_titles:
            buckets["duplicate"].append({
                "src_name": row["name"], "src_ref": rref,
                "src_status": row.get("raw_status", ""),
                "keel_key": "", "keel_name": seen_titles[_dupkey],
                "verdict": "duplicate", "reason": "identical title AND type to another source row",
                "action": "confirm/merge - operator",
                "wsjf": "", "rice": "", "type": row.get("type", "")})
            continue
        seen_titles[_dupkey] = row["name"]

        # exact-ref first, then title fallback
        best = None; best_score = 0.0
        best_same = None; best_same_score = 0.0   # best SAME-TYPE title match
        rtype_l = row.get("type", "")
        for k in keel:
            if rref and rref == k["ref"]:
                best = k; best_score = 1.0; break
            s = overlap(row["name"], k["name"])
            if s > best_score:
                best_score = s; best = k
            if k.get("type") == rtype_l and s > best_same_score:
                best_same_score = s; best_same = k
        # prefer a same-type match over a cross-type one (Jira type is source of record)
        if best_score < 1.0 and best_same is not None and best_same_score >= HIGH:
            best = best_same; best_score = best_same_score

        rowbase = {"src_name": row["name"], "src_ref": rref,
                   "src_status": row.get("raw_status", ""), "type": row.get("type", "")}

        if best and best_score >= HIGH:
            same_type = (row.get("type") == best["type"]) or row.get("type") == "unknown"
            src_done  = rstat in SRC_DONE
            keel_done = best["status"] in KEEL_DONE
            _mode = "ref" if (rref and rref == best.get("ref")) else "title"
            entry = {**rowbase, "keel_key": best["key"], "keel_name": best["name"],
                     "keel_status": best["status"], "wsjf": best["wsjf"],
                     "rice": best["rice"], "score": round(best_score, 2), "match_mode": _mode}
            if not same_type and rref and rref == best.get("ref"):
                # same item (exact ref), types disagree -> align Keel to Jira (source of record)
                entry.update(verdict="conflict",
                             reason=f"same item, type differs: Jira={row.get('type')} vs Keel={best['type']} - align Keel to Jira",
                             action="align to Jira")
                buckets["conflict"].append(entry)
            elif not same_type:
                # title-only cross-type match (e.g. epic vs same-named story) is not the
                # same item; do not manufacture a conflict - hold as ambiguous for review
                entry.update(verdict="ambiguous",
                             reason=f"cross-type title match ({round(best_score,2)}): {row.get('type')} vs {best['type']} - likely parent/child",
                             action="operator decide (or semantic pass)")
                buckets["ambiguous"].append(entry)
            elif src_done and not keel_done:
                entry.update(verdict="completed",
                             reason=f"source DONE, keel status={best['status']}",
                             action="propose mark done")
                buckets["completed"].append(entry)
            else:
                entry.update(verdict="changed",
                             reason=("exact source-key match; review for field diffs" if _mode == "ref" else "title-overlap match, no source key; review for field diffs"),
                             action="review/link")
                buckets["changed"].append(entry)
        elif best and best_score >= LOW:
            buckets["ambiguous"].append({
                **rowbase, "keel_key": best["key"], "keel_name": best["name"],
                "keel_status": best["status"], "wsjf": best["wsjf"], "rice": best["rice"],
                "score": round(best_score, 2), "verdict": "ambiguous",
                "reason": f"partial title overlap ({round(best_score,2)}) - same item?",
                "action": "operator decide (or semantic pass)"})
        else:
            # no match -> gap. Split done_gap (completed, unmatched) for redundancy visibility.
            if rstat in SRC_DONE:
                buckets["done_gap"].append({
                    **rowbase, "keel_key": "", "keel_name": "", "wsjf": "", "rice": "",
                    "verdict": "done-gap",
                    "reason": "DONE in source, no Keel match (already-done reference)",
                    "action": "land as done (reference) or rule out-of-scope"})
            else:
                buckets["gap"].append({
                    **rowbase, "keel_key": "", "keel_name": "", "wsjf": "", "rice": "",
                    "verdict": "gap", "reason": "no Keel match",
                    "action": "create new item or rule out-of-scope"})

    summary = {b: len(v) for b, v in buckets.items()}
    summary["source"] = which
    summary["source_rows_total"] = len(all_rows)
    summary["portfolio_rows_scoped"] = len(backlog)
    summary["skipped_types"] = skipped_types
    summary["keel_items"] = len(keel)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "generated": datetime.now().astimezone().isoformat(),
        "summary": summary, "buckets": buckets,
    }, indent=2), encoding="utf-8")

    print(f"=== reconcile [{which}]: {len(backlog)} epic/story rows vs {len(keel)} keel items ===")
    print(f"    (skipped non-portfolio types: {skipped_types})")
    for b in ["changed", "completed", "conflict", "duplicate", "ambiguous", "gap", "done_gap"]:
        print(f"  {b:10s}: {len(buckets[b])}")
    print()
    if buckets["completed"]:
        print("COMPLETED (source DONE, Keel not done -> already done, propose mark done):")
        for e in buckets["completed"][:10]:
            print(f"   {e['keel_key']} {e['keel_name'][:38]!r} <- {e['src_ref']} {e['src_name'][:32]!r}")
    if buckets["ambiguous"]:
        print(f"AMBIGUOUS ({len(buckets['ambiguous'])}) - held for semantic pass:")
        for e in buckets["ambiguous"][:12]:
            print(f"   {e['score']}  {e['src_name'][:33]!r}  ~  {e['keel_key']} {e['keel_name'][:28]!r}")
        if len(buckets["ambiguous"]) > 12:
            print(f"     ... +{len(buckets['ambiguous'])-12} more")
    print(f"\\n  gap (active, unmatched): {len(buckets['gap'])} -> new-item candidates")
    print(f"  done_gap (completed, unmatched): {len(buckets['done_gap'])} -> already-done reference")
    print(f"wrote {OUT}")

if __name__ == "__main__":
    main()
