"""The semantic lane, without the model.

Legacy tools/reconcile_semantic.py built a bounded SAME/DISTINCT prompt, shelled
out to `claude -p`, parsed the reply, and annotated reconcile.json. keel_core
cannot make model calls (product rule 2) and a hosted server cannot assume a
locally-authenticated CLI, so the lane splits in two:

    make_judgment_prompt(pairs)                -> prompt text; the caller's own
                                                  model answers it
    apply_verdicts(result, verdicts, ...)      -> deterministic re-annotation

The prompt wording is unchanged from legacy. Verdicts are proposals: they
annotate, they never re-bucket, and every one keeps its reason and the caller's
model note so the provenance chain survives (product rules 6 and 7).
"""
from .schema import KeelCoreError, validate_result

VALID_VERDICTS = ("SAME", "DISTINCT")


class VerdictError(KeelCoreError):
    code = "VERDICT_INVALID"


def truncate(s, n=260):
    return (s or "").replace("\n", " ").strip()[:n]


def pairs_from_result(result, source_descriptions=None, keel_descriptions=None):
    """Build judgment pairs from a result's ambiguous bucket.

    Descriptions are optional lookups the caller supplies -- `{src_ref: text}`
    and `{keel_key: text}` -- because keel_core does not read state files.
    """
    result = validate_result(result)
    sdesc = source_descriptions or {}
    kdesc = keel_descriptions or {}
    pairs = []
    for e in result["buckets"].get("ambiguous", []):
        ref, key = e.get("src_ref", ""), e.get("keel_key", "")
        pairs.append({
            "src_ref": ref, "src_name": e.get("src_name", ""),
            "src_desc": truncate(sdesc.get(ref, "")),
            "keel_key": key, "keel_name": e.get("keel_name", ""),
            "keel_desc": truncate(kdesc.get(key, "")),
        })
    return pairs


def make_judgment_prompt(pairs):
    """The bounded SAME/DISTINCT prompt. Wording preserved from legacy."""
    lines = [
        "Judge whether each pair of software work items is the SAME capability/work or DISTINCT.",
        "A parent epic and one of its child stories are DISTINCT. A feature and the story implementing it may be SAME.",
        "Return ONLY a JSON array (no prose, no markdown). Each element:",
        '{"id": <int>, "verdict": "SAME"|"DISTINCT", "reason": "<one sentence>"}',
        "", "Pairs:"]
    for i, p in enumerate(pairs):
        lines.append(f'[{i}] A (Jira {p["src_ref"]}): "{p["src_name"]}" -- '
                     f'{p["src_desc"] or "(no description)"}')
        lines.append(f'    B (Keel {p["keel_key"]}): "{p["keel_name"]}" -- '
                     f'{p["keel_desc"] or "(no description)"}')
    return "\n".join(lines)


def parse_verdicts(payload):
    """Accept a JSON array (already decoded) of verdict objects.

    Raises on a malformed verdict rather than dropping it. Legacy tolerated a
    missing verdict silently; a judgment that vanished between the model and the
    review sheet is the same class of defect as A1 and A2.
    """
    if not isinstance(payload, list):
        raise VerdictError("verdicts must be a JSON array",
                           value=type(payload).__name__,
                           hint='expected [{"id": 0, "verdict": "SAME", "reason": "..."}]')
    out = {}
    for v in payload:
        if not isinstance(v, dict) or "id" not in v:
            raise VerdictError("verdict element has no id", value=v,
                               hint="every element needs an integer id matching the pair index")
        verdict = v.get("verdict", "")
        if verdict not in VALID_VERDICTS:
            raise VerdictError("verdict is not SAME or DISTINCT", value=verdict,
                               hint=f"use one of: {', '.join(VALID_VERDICTS)}")
        out[int(v["id"])] = {"verdict": verdict, "reason": v.get("reason", "")}
    return out


def apply_verdicts(result, verdicts, model_note="caller-supplied model"):
    """Annotate the ambiguous bucket with caller-supplied verdicts.

    Returns a NEW result; the input is not mutated. Entries with no verdict are
    marked explicitly rather than left blank, so an unjudged pair is visible as
    unjudged. Bucketing is untouched -- these are proposals for an operator, not
    decisions (product rule 6).
    """
    result = validate_result(result)
    if isinstance(verdicts, list):
        verdicts = parse_verdicts(verdicts)

    buckets = {k: [dict(e) for e in v] for k, v in result["buckets"].items()}
    amb = buckets.get("ambiguous", [])
    same = distinct = unjudged = 0

    for i, entry in enumerate(amb):
        v = verdicts.get(i)
        if not v:
            entry["semantic_verdict"] = ""
            entry["semantic_reason"] = "(no verdict)"
            unjudged += 1
            continue
        entry["semantic_verdict"] = v["verdict"]
        entry["semantic_reason"] = v.get("reason", "")
        entry["semantic_model"] = model_note
        if v["verdict"] == "SAME":
            same += 1
        else:
            distinct += 1

    summary = dict(result["summary"])
    summary["semantic"] = {"judged": same + distinct, "same": same,
                           "distinct": distinct, "unjudged": unjudged,
                           "model": model_note}

    out = dict(result)
    out["summary"] = summary
    out["buckets"] = buckets
    return validate_result(out)


def semantic_records(result):
    """Flatten judged entries into a durable, standalone record set.

    Legacy wrote state/normalized/semantic.json for exactly this reason: the
    reconcile file gets rewritten by later passes and the verdicts had to
    survive it. Here the caller decides where it lives.
    """
    result = validate_result(result)
    return [
        {"src_ref": e.get("src_ref", ""), "src_name": e.get("src_name", ""),
         "keel_key": e.get("keel_key", ""), "keel_name": e.get("keel_name", ""),
         "verdict": e.get("verdict", ""),
         "semantic_verdict": e.get("semantic_verdict", ""),
         "semantic_reason": e.get("semantic_reason", ""),
         "semantic_model": e.get("semantic_model", "")}
        for rows in result["buckets"].values()
        for e in rows if e.get("semantic_verdict")
    ]
