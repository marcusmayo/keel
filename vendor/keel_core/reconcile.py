"""Deterministic reconcile: two record sets in, seven buckets out.

Ported from tools/reconcile.py. The matching semantics are unchanged --
ref-equality first, then title overlap with the short-title guard. What changed
is tie-breaking, collision handling, and error surfacing; every delta is
registered in FIXES.md and suppressed by `ReconcileConfig(legacy_compat=True)`.

Nothing here is portfolio-specific. `source_rows` and `keel_items` are record
sets; "work item" is one costume, a transaction ledger is another.
"""
from .schema import (BUCKETS, ReconcileConfig, Warning_, empty_buckets,
                     new_result, validate_result)
from ._text import overlap, toks


def _norm_key(name):
    return " ".join(sorted(toks(name)))


def _ref_index(keel_items, warnings, compat):
    """Map ref -> item, detecting collisions.

    FIX A5: legacy broke out of the match loop on the first item whose ref
    matched, so when two Keel items carried the same ref -- which load_keel can
    itself create, because a confirmed MERGE stamps jira_ref without checking
    whether another item already holds it -- whichever file sorted first won and
    the second was invisible. Collisions are now detected and surfaced.
    """
    index, collisions = {}, {}
    for it in keel_items:
        ref = it.get("ref") or ""
        if not ref:
            continue
        if ref in index:
            collisions.setdefault(ref, [index[ref]["key"]]).append(it["key"])
        else:
            index[ref] = it
    if collisions and not compat:
        for ref, keys in sorted(collisions.items()):
            warnings.append(Warning_(
                "REF_COLLISION",
                f"source ref {ref!r} is claimed by {len(keys)} Keel items; "
                "rows matching it are routed to conflict instead of picking one",
                ", ".join(sorted(keys))))
    return index, collisions


def _apply_resolutions(keel_items, resolutions):
    """A confirmed MERGE stamps the source ref onto the Keel item so it is
    treated as ref-linked; DISTINCT is tagged settled. Returns new dicts --
    callers' inputs are never mutated."""
    out = []
    for it in keel_items:
        r = resolutions.get(it.get("key"))
        it = dict(it)
        if not r:
            it["resolution"] = ""
        else:
            it["resolution"] = r.get("decision", "")
            if r.get("decision") == "MERGE" and r.get("jira_ref") and not it.get("ref"):
                it["ref"] = r["jira_ref"]
        out.append(it)
    return out


def _best_matches(row, keel_items, ref_index, cfg):
    """Return (best, best_score, best_same, best_same_score, runner_up_score).

    Iterates `keel_items` in the order supplied -- callers pass a stable order,
    which is how determinism is preserved without a filesystem dependency.
    """
    rref = (row.get("source") or {}).get("ref", "")
    if rref and rref in ref_index:
        return ref_index[rref], 1.0, None, 0.0, 0.0

    rtype = row.get("type", "")
    best = best_same = None
    best_score = best_same_score = runner_up = 0.0
    for k in keel_items:
        s = overlap(row.get("name", ""), k.get("name", ""))
        if s > best_score:
            runner_up = best_score
            best_score, best = s, k
        elif s > runner_up:
            runner_up = s
        if k.get("type") == rtype and s > best_same_score:
            best_same_score, best_same = s, k
    return best, best_score, best_same, best_same_score, runner_up


def reconcile(source_rows, keel_items, config=None, resolutions=None,
              generated="", source_label="source"):
    """Reconcile a normalized source against a portfolio.

    source_rows  -- normalized records: name, type, status, raw_status, source.ref
    keel_items   -- portfolio records: key, type, name, status, ref, wsjf, rice
    config       -- ReconcileConfig; defaults reproduce legacy values
    resolutions  -- {keel_key: record} from normalize.parse_resolutions
    generated    -- caller-supplied timestamp (FIX A8: no clock reads in here)
    """
    cfg = config or ReconcileConfig()
    compat = cfg.legacy_compat
    warnings = []

    keel = _apply_resolutions(keel_items, resolutions or {})
    ref_index, collisions = _ref_index(keel, warnings, compat)

    scoped, skipped_types = [], {}
    for r in source_rows:
        if r.get("type") in cfg.portfolio_types:
            scoped.append(r)
        else:
            t = r.get("type")
            skipped_types[t] = skipped_types.get(t, 0) + 1

    buckets = empty_buckets()
    seen = {}

    for row in scoped:
        name = row.get("name", "")
        nt = _norm_key(name)
        rref = (row.get("source") or {}).get("ref", "")
        rstat = row.get("status", "")
        rtype = row.get("type", "")
        base = {"src_name": name, "src_ref": rref,
                "src_status": row.get("raw_status", ""), "type": rtype}

        # ---- source-declared duplicate
        if rstat == "dedup-flag":
            entry = {**base, "keel_key": "", "keel_name": "",
                     "verdict": "duplicate", "reason": "source-declared Duplicate",
                     "action": "confirm/merge - operator", "wsjf": "", "rice": ""}
            buckets["duplicate"].append(entry)
            continue

        # ---- repeated title+type within the source
        dupkey = (nt, rtype)
        if nt and dupkey in seen:
            first = seen[dupkey]
            if compat:
                # legacy wrote the previous SOURCE row's name into keel_name
                entry = {**base, "keel_key": "", "keel_name": first["name"],
                         "verdict": "duplicate",
                         "reason": "identical title AND type to another source row",
                         "action": "confirm/merge - operator", "wsjf": "", "rice": ""}
            else:
                # FIX A6: a keel_* field must only ever carry Keel data.
                # FIX A7: record which row this duplicates, by ref, both ways.
                entry = {**base, "keel_key": "", "keel_name": "",
                         "dupe_of_src_name": first["name"],
                         "dupe_of_src_ref": first["ref"],
                         "verdict": "duplicate",
                         "reason": "identical title AND type to another source row",
                         "action": "confirm/merge - operator", "wsjf": "", "rice": ""}
            buckets["duplicate"].append(entry)
            continue
        if nt:
            seen[dupkey] = {"name": name, "ref": rref}
        elif not compat:
            # B3 candidate (awaiting decision): legacy lets untitled rows fall
            # through to gap as new-item candidates. Surfaced, not re-bucketed.
            warnings.append(Warning_(
                "SOURCE_ROW_UNTITLED",
                "source row has no parseable title; it cannot be deduplicated "
                "or matched and will land in gap",
                f"ref={rref or '(none)'} type={rtype or '(none)'}"))

        # ---- ref collision routes to conflict rather than an arbitrary pick
        if not compat and rref and rref in collisions:
            buckets["conflict"].append({
                **base, "keel_key": "", "keel_name": "", "keel_status": "",
                "wsjf": "", "rice": "", "score": 1.0, "match_mode": "ref",
                "verdict": "conflict",
                "reason": ("source ref is claimed by multiple Keel items: "
                           + ", ".join(sorted(collisions[rref]))),
                "action": "operator: resolve the duplicate ref claim"})
            continue

        best, score, best_same, same_score, runner_up = _best_matches(
            row, keel, ref_index, cfg)

        # prefer a same-type title match over a cross-type one
        pref_applied = False
        if score < 1.0 and best_same is not None and same_score >= cfg.high and best_same is not best:
            best, score = best_same, same_score
            pref_applied = True

        if best and score >= cfg.high:
            is_ref = bool(rref and rref == best.get("ref"))
            entry = {**base, "keel_key": best.get("key", ""),
                     "keel_name": best.get("name", ""),
                     "keel_status": best.get("status", ""),
                     "wsjf": best.get("wsjf", ""), "rice": best.get("rice", ""),
                     "score": round(score, 2),
                     "match_mode": "ref" if is_ref else "title"}

            # FIX B2 (approved): a near-tie above HIGH is exactly the ambiguity
            # this tool exists to surface, not something to settle by file order.
            # A near-tie is only ambiguous when nothing else already resolved
            # it: a ref match is decisive, and the same-type preference is a
            # deliberate disambiguation rule, not a coin toss.
            tied = (not compat and not is_ref and not pref_applied
                    and runner_up >= cfg.high
                    and abs(score - runner_up) <= cfg.tie_epsilon)
            same_type = (rtype == best.get("type"))
            unknown_type = (rtype == "unknown")

            if tied:
                entry.update(verdict="ambiguous",
                             reason=(f"two candidates tie at {round(score, 2)} - "
                                     "operator picks, rather than filename order"),
                             action="operator decide (or semantic pass)")
                buckets["ambiguous"].append(entry)
            elif compat and unknown_type:
                # legacy: unknown type counted as same-type against anything
                same = True
                if rstat in cfg.src_done and best.get("status") not in cfg.keel_done:
                    entry.update(verdict="completed",
                                 reason=f"source DONE, keel status={best.get('status')}",
                                 action="propose mark done")
                    buckets["completed"].append(entry)
                else:
                    entry.update(verdict="changed",
                                 reason=("exact source-key match; review for field diffs"
                                         if is_ref else
                                         "title-overlap match, no source key; review for field diffs"),
                                 action="review/link")
                    buckets["changed"].append(entry)
            elif not compat and unknown_type and not same_type:
                # FIX B1 (approved): an unparseable source type is precisely the
                # row a human should confirm, not one to auto-accept against any
                # Keel type.
                entry.update(verdict="ambiguous",
                             reason=(f"source type unknown, Keel type={best.get('type')!r} "
                                     "- confirm this is the same item"),
                             action="operator decide (or semantic pass)")
                buckets["ambiguous"].append(entry)
            elif not same_type and is_ref:
                entry.update(verdict="conflict",
                             reason=(f"same item, type differs: source={rtype} vs "
                                     f"Keel={best.get('type')} - align Keel to source"),
                             action="align to source")
                buckets["conflict"].append(entry)
            elif not same_type:
                entry.update(verdict="ambiguous",
                             reason=(f"cross-type title match ({round(score, 2)}): {rtype} vs "
                                     f"{best.get('type')} - likely parent/child"),
                             action="operator decide (or semantic pass)")
                buckets["ambiguous"].append(entry)
            elif rstat in cfg.src_done and best.get("status") not in cfg.keel_done:
                entry.update(verdict="completed",
                             reason=f"source DONE, keel status={best.get('status')}",
                             action="propose mark done")
                buckets["completed"].append(entry)
            else:
                entry.update(verdict="changed",
                             reason=("exact source-key match; review for field diffs"
                                     if is_ref else
                                     "title-overlap match, no source key; review for field diffs"),
                             action="review/link")
                buckets["changed"].append(entry)

        elif best and score >= cfg.low:
            buckets["ambiguous"].append({
                **base, "keel_key": best.get("key", ""),
                "keel_name": best.get("name", ""),
                "keel_status": best.get("status", ""),
                "wsjf": best.get("wsjf", ""), "rice": best.get("rice", ""),
                "score": round(score, 2), "verdict": "ambiguous",
                "reason": f"partial title overlap ({round(score, 2)}) - same item?",
                "action": "operator decide (or semantic pass)"})
        else:
            target = "done_gap" if rstat in cfg.src_done else "gap"
            buckets[target].append({
                **base, "keel_key": "", "keel_name": "", "wsjf": "", "rice": "",
                "verdict": "done-gap" if target == "done_gap" else "gap",
                "reason": ("DONE in source, no Keel match (already-done reference)"
                           if target == "done_gap" else "no Keel match"),
                "action": ("land as done (reference) or rule out-of-scope"
                           if target == "done_gap" else
                           "create new item or rule out-of-scope")})

    summary = {b: len(buckets[b]) for b in BUCKETS}
    summary.update(source=source_label,
                   source_rows_total=len(source_rows),
                   portfolio_rows_scoped=len(scoped),
                   skipped_types=skipped_types,
                   keel_items=len(keel))
    if not compat:
        summary["warning_count"] = len(warnings)

    return validate_result(new_result(summary=summary, buckets=buckets,
                                      warnings=warnings, generated=generated))
