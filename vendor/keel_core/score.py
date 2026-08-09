"""WSJF and RICE arithmetic and scale validation. Deterministic only.

Legacy tools/score_pass.py mixed two things: a `claude -p` judgment step that
proposes components, and Python that validates them against fixed scales and
computes the scores. Only the second half comes across -- keel_core makes no
model calls (product rule 2). A caller that wants proposed components asks its
own model, then validates them here.
"""
from .schema import ConfigError

# Fixed scales, unchanged from legacy.
FIB = frozenset({1, 2, 3, 5, 8, 13, 20})
IMPACT = frozenset({3.0, 2.0, 1.0, 0.5, 0.25})
CONFIDENCE = frozenset({1.0, 0.8, 0.5})
WSJF_COMPONENTS = ("ubv", "tc", "rro", "js")
RICE_COMPONENTS = ("reach", "impact", "confidence", "effort")

SCALES_DOC = """SCORING SCALES (fixed -- use ONLY these values):
WSJF components (modified Fibonacci): 1, 2, 3, 5, 8, 13, 20
  ubv = user_business_value (value to users/business if delivered)
  tc  = time_criticality (how much value decays with delay / deadline pressure)
  rro = risk_reduction_opportunity (risk removed or future opportunity enabled)
  js  = job_size (relative effort/duration)
RICE components:
  reach = raw count of people/customers affected per quarter (positive number)
  impact = one of 3, 2, 1, 0.5, 0.25
  confidence = one of 1.0, 0.8, 0.5
  effort = total person-weeks (positive number)
Do NOT compute final scores. Components only."""


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def validate_components(wsjf, rice):
    """Check proposed components against the fixed scales.

    Returns (clean, problems). `problems` is a list of human-readable strings;
    a non-empty list means the components are not scoreable. Legacy behaviour,
    preserved: reach and effort round to 1dp.
    """
    problems = []
    clean = {"wsjf": {}, "rice": {}}
    wsjf = wsjf or {}
    rice = rice or {}

    for k in WSJF_COMPONENTS:
        n = _num(wsjf.get(k))
        if n is None or int(n) != n or int(n) not in FIB:
            problems.append(f"wsjf.{k}={wsjf.get(k)!r} not Fibonacci")
        else:
            clean["wsjf"][k] = int(n)

    n = _num(rice.get("reach"))
    if n is None or n <= 0:
        problems.append(f"rice.reach={rice.get('reach')!r} not positive")
    else:
        clean["rice"]["reach"] = round(n, 1)

    n = _num(rice.get("impact"))
    if n is None or n not in IMPACT:
        problems.append(f"rice.impact={rice.get('impact')!r} off-scale")
    else:
        clean["rice"]["impact"] = n

    n = _num(rice.get("confidence"))
    if n is None or n not in CONFIDENCE:
        problems.append(f"rice.confidence={rice.get('confidence')!r} off-scale")
    else:
        clean["rice"]["confidence"] = n

    n = _num(rice.get("effort"))
    if n is None or n <= 0:
        problems.append(f"rice.effort={rice.get('effort')!r} not positive")
    else:
        clean["rice"]["effort"] = round(n, 1)

    return clean, problems


def compute_wsjf(components):
    """(ubv + tc + rro) / js, rounded to 2dp. Cost of delay over job size."""
    for k in WSJF_COMPONENTS:
        if k not in components:
            raise ConfigError("missing WSJF component", value=k,
                              hint=f"supply all of: {', '.join(WSJF_COMPONENTS)}")
    js = components["js"]
    if not js:
        raise ConfigError("WSJF job size must be non-zero", value=js,
                          hint="job size is the divisor; use a Fibonacci value >= 1")
    return round((components["ubv"] + components["tc"] + components["rro"]) / js, 2)


def compute_rice(components):
    """reach * impact * confidence / effort, rounded to 2dp."""
    for k in RICE_COMPONENTS:
        if k not in components:
            raise ConfigError("missing RICE component", value=k,
                              hint=f"supply all of: {', '.join(RICE_COMPONENTS)}")
    effort = components["effort"]
    if not effort:
        raise ConfigError("RICE effort must be non-zero", value=effort,
                          hint="effort is the divisor; use a positive number of person-weeks")
    return round(components["reach"] * components["impact"]
                 * components["confidence"] / effort, 2)


def score_item(wsjf, rice):
    """Validate then compute. Returns (scored, problems); `scored` is None when
    the components do not pass validation -- never a fabricated number."""
    clean, problems = validate_components(wsjf, rice)
    if problems:
        return None, problems
    w = dict(clean["wsjf"])
    r = dict(clean["rice"])
    w["score"] = compute_wsjf(w)
    r["score"] = compute_rice(r)
    return {"wsjf": w, "rice": r}, []


def score_all(proposals):
    """Score a list of {key, name, wsjf, rice, grounding?} proposals.

    Returns (scored, rejected). Ordering follows the input, so the result is
    deterministic without depending on how the caller collected the items.
    """
    scored, rejected = [], []
    for p in proposals:
        result, problems = score_item(p.get("wsjf"), p.get("rice"))
        if problems:
            rejected.append({"key": p.get("key", ""), "name": p.get("name", ""),
                             "problems": problems})
            continue
        scored.append({"key": p.get("key", ""), "name": p.get("name", ""),
                       "grounding": p.get("grounding", "generic"),
                       "why": p.get("why", {}), **result})
    return scored, rejected
