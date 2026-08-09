#!/usr/bin/env python3
"""score_pass.py -- batched WSJF/RICE scoring proposals for unscored items.

Deterministic scan (state/ + support/) -> claude -p judgment in batches ->
scale-validated, Python-computed proposals in exports/score-proposals.json.
NEVER writes item YAML; apply_scores.py (separate, operator-gated) does that.

Usage:
  python3 tools/score_pass.py --limit 10                 # proof batch
  python3 tools/score_pass.py                            # full run (resumes)
  python3 tools/score_pass.py --fresh                    # discard prior proposals
  python3 tools/score_pass.py --context-file PATH        # inject grounding doc(s)
"""
import argparse, glob, json, re, subprocess, tempfile
from datetime import date
from pathlib import Path

FIB = {1, 2, 3, 5, 8, 13, 20}
IMPACT = {3.0, 2.0, 1.0, 0.5, 0.25}
CONF = {1.0, 0.8, 0.5}
DP = re.compile(r"\[\s*draft\s*[\u2014\u2013-]\s*review\s*\]\s*", re.I)
OUT_DEFAULT = "exports/score-proposals.json"

SCALES = """SCORING SCALES (fixed -- use ONLY these values):
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

RULES = """RULES:
- Scores are RELATIVE within this one product portfolio (rank items against each other).
- Judge from item text (and CONTEXT if provided). One short rationale per component.
- grounding: "grounded" if component choices trace to item/context text; "generic" if
  pattern-based estimate. Be honest -- generic is acceptable, mislabeling is not.
- If an item carries too little information to score at all (e.g. a bare import
  placeholder with an uninformative name), return {"key":..., "insufficient": true,
  "reason": "..."} instead of components. Never fabricate scores for empty items.
- Return ONLY a JSON array, one element per item. No prose, no code fences."""

def get_desc(lines):
    for i, ln in enumerate(lines):
        m = re.match(r'^  description:\s*"(.*)"\s*$', ln)
        if m:
            return m.group(1)
        if re.match(r"^  description:\s*[>|]", ln):
            buf = []
            for l2 in lines[i + 1:]:
                if l2.strip() == "":
                    continue
                if re.match(r"^    \S|^     ", l2):
                    buf.append(l2.strip())
                else:
                    break
            return " ".join(buf)
        if re.match(r"^  description:\s*$", ln):
            return ""
    return ""

def get_ac(lines):
    for i, ln in enumerate(lines):
        if re.match(r"^\s*acceptance_criteria:\s*\[\]", ln):
            return []
        if re.match(r"^\s*acceptance_criteria:\s*$", ln):
            ac = []
            for l2 in lines[i + 1:]:
                m = re.match(r'^    - "(.*)"\s*$', l2)
                if m:
                    ac.append(m.group(1))
                elif l2.strip() == "":
                    continue
                else:
                    break
            return ac
    return []

def field(txt, name):
    m = re.search(rf'^  {name}:\s*"?(.*?)"?\s*$', txt, re.M)
    return m.group(1).strip() if m else ""

def load_candidates():
    items = []
    for f in sorted(glob.glob("state/*.yaml") + glob.glob("support/*.yaml")):
        if Path(f).stem.startswith("_"):
            continue
        txt = Path(f).read_text(encoding="utf-8")
        if not re.search(r'^    status:\s*"?unscored', txt, re.M):
            continue
        km = re.search(r'^\s*key:\s*"?([A-Z]+-\d+)"?', txt, re.M)
        if not km:
            continue
        lines = txt.splitlines()
        items.append({
            "key": km.group(1), "file": f,
            "type": field(txt, "type"), "name": field(txt, "name"),
            "summary": field(txt, "summary"),
            "desc": DP.sub("", get_desc(lines)).strip()[:600],
            "ac": [DP.sub("", a).strip()[:150] for a in get_ac(lines)][:6],
            "stage": field(txt, "stage"),
            "stakeholders": field(txt, "stakeholders"),
            "jira": bool(re.search(r'^\s*source:.*ref:\s*"?[A-Z]+-\d+', txt, re.M)),
        })
    return items

def build_prompt(batch, ctx):
    L = ["You are scoring product work items for prioritization using WSJF and RICE.",
         SCALES, RULES]
    if ctx:
        L.append(ctx)
    L.append("ITEMS:")
    for it in batch:
        L.append(json.dumps({k: it[k] for k in
            ("key", "type", "name", "summary", "desc", "ac", "stage", "stakeholders")},
            ensure_ascii=False))
    L.append('Element schema: {"key":"...","insufficient":false,'
             '"grounding":"grounded|generic","wsjf":{"ubv":N,"tc":N,"rro":N,"js":N},'
             '"rice":{"reach":N,"impact":N,"confidence":N,"effort":N},'
             '"why":{"ubv":"...","tc":"...","rro":"...","js":"...","reach":"...",'
             '"impact":"...","confidence":"...","effort":"..."}} '
             'or {"key":"...","insufficient":true,"reason":"..."}. JSON array only.')
    return "\n".join(L)

def extract_json(t):
    t = re.sub(r"^```(?:json)?", "", t.strip()).strip()
    t = re.sub(r"```$", "", t).strip()
    i, j = t.find("["), t.rfind("]")
    if i == -1 or j <= i:
        raise ValueError("no JSON array in claude output")
    return json.loads(t[i:j + 1])

def _judge_model_args():
    """The bare CLI resolves a default model the gateway may not carry (live 400:
    claude-opus-4-8 not in catalog). Pass an explicit, catalog-valid model:
    KEEL_JUDGE_MODEL wins; else the container-baked ANTHROPIC_SMALL_FAST_MODEL
    (right tier for batched judgment); else legacy bare behavior."""
    import os
    m = os.environ.get("KEEL_JUDGE_MODEL") or os.environ.get("ANTHROPIC_SMALL_FAST_MODEL")
    return ["--model", m] if m else []

def judge(prompt, timeout):
    with tempfile.TemporaryDirectory() as td:
        proc = subprocess.run(["claude", "-p", prompt] + _judge_model_args(), cwd=td,
                              capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError(f"claude -p exit {proc.returncode}: {proc.stderr[:300]}")
    return extract_json(proc.stdout)

def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None

def validate(v):
    probs, out = [], {"wsjf": {}, "rice": {}}
    w, r = v.get("wsjf") or {}, v.get("rice") or {}
    for k in ("ubv", "tc", "rro", "js"):
        n = num(w.get(k))
        if n is None or int(n) != n or int(n) not in FIB:
            probs.append(f"wsjf.{k}={w.get(k)!r} not Fibonacci")
        else:
            out["wsjf"][k] = int(n)
    n = num(r.get("reach"))
    if n is None or n <= 0:
        probs.append(f"rice.reach={r.get('reach')!r} not positive")
    else:
        out["rice"]["reach"] = round(n, 1)
    n = num(r.get("impact"))
    if n is None or n not in IMPACT:
        probs.append(f"rice.impact={r.get('impact')!r} off-scale")
    else:
        out["rice"]["impact"] = n
    n = num(r.get("confidence"))
    if n is None or n not in CONF:
        probs.append(f"rice.confidence={r.get('confidence')!r} off-scale")
    else:
        out["rice"]["confidence"] = n
    n = num(r.get("effort"))
    if n is None or n <= 0:
        probs.append(f"rice.effort={r.get('effort')!r} not positive")
    else:
        out["rice"]["effort"] = round(n, 1)
    return out, probs

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--batch-size", type=int, default=10)
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--out", default=OUT_DEFAULT)
    ap.add_argument("--fresh", action="store_true")
    ap.add_argument("--context-file", action="append", default=[])
    a = ap.parse_args()

    ctx = ""
    for cf in a.context_file:
        ctx += f"\n--- CONTEXT: {cf} ---\n" + Path(cf).read_text(encoding="utf-8")[:4000] + "\n"

    cands = load_candidates()
    done = {}
    op = Path(a.out)
    if op.exists() and not a.fresh:
        done = {p["key"]: p for p in json.loads(op.read_text())["proposals"]}
    # Level 2: filter proposals to LIVE keys only, so merged/deleted items don't
    # inflate already-proposed counts or block re-scoring of merge survivors.
    _live_keys = set()
    for _f in glob.glob("state/*.yaml"):
        if Path(_f).stem.startswith("_"):
            continue
        _m = re.search(r'^\s*key:\s*"?([A-Z]+-\d+)', Path(_f).read_text(encoding="utf-8"), re.M)
        if _m:
            _live_keys.add(_m.group(1))
    _before = len(done)
    done = {k: v for k, v in done.items() if k in _live_keys}
    _orphaned = _before - len(done)
    if _orphaned:
        print(f"(ignored {_orphaned} proposal(s) for merged/deleted keys)", flush=True)
    todo = [c for c in cands if c["key"] not in done]
    if a.limit:
        todo = todo[:a.limit]
    print(f"unscored: {len(cands)} | already-proposed: {len(done)} | to judge: {len(todo)}",
          flush=True)
    if not todo:
        print("nothing to judge.")
        return

    proposals, needs = list(done.values()), []
    today = date.today().isoformat()
    nb = (len(todo) - 1) // a.batch_size + 1
    for i in range(0, len(todo), a.batch_size):
        batch = todo[i:i + a.batch_size]
        print(f"  batch {i // a.batch_size + 1}/{nb} ({len(batch)} items)...", flush=True)
        try:
            verdicts = {v.get("key"): v for v in judge(build_prompt(batch, ctx), a.timeout)
                        if isinstance(v, dict)}
        except Exception as e:
            print(f"  !! batch failed: {e} -- items stay unproposed; rerun resumes", flush=True)
            continue
        for it in batch:
            v = verdicts.get(it["key"])
            if v is None:
                needs.append({"key": it["key"], "reason": "no verdict returned"})
                continue
            if v.get("insufficient"):
                needs.append({"key": it["key"], "reason": v.get("reason", "insufficient")})
                continue
            clean, probs = validate(v)
            if probs:
                needs.append({"key": it["key"], "reason": "; ".join(probs)})
                continue
            w, r = clean["wsjf"], clean["rice"]
            w["score"] = round((w["ubv"] + w["tc"] + w["rro"]) / w["js"], 2)
            r["score"] = round(r["reach"] * r["impact"] * r["confidence"] / r["effort"], 2)
            proposals.append({"key": it["key"], "file": it["file"], "type": it["type"],
                              "name": it["name"], "jira_origin": it["jira"],
                              "grounding": v.get("grounding", "generic"),
                              "wsjf": w, "rice": r, "why": v.get("why", {}),
                              "proposed": today})
        op.parent.mkdir(parents=True, exist_ok=True)
        op.write_text(json.dumps({"generated": today, "proposals": proposals,
                                  "needs_input": needs}, indent=1))
    g = sum(1 for p in proposals if p["grounding"] == "grounded")
    print(f"\nproposals: {len(proposals)} ({g} grounded, {len(proposals) - g} generic)"
          f" | needs-input: {len(needs)}")
    for n_ in needs[:10]:
        print(f"  needs-input {n_['key']}: {n_['reason'][:90]}")
    print("top 10 by WSJF:")
    for p in sorted(proposals, key=lambda p: -p["wsjf"]["score"])[:10]:
        print(f"  {p['key']:8} WSJF {p['wsjf']['score']:>6}  RICE {p['rice']['score']:>9}"
              f"  [{p['grounding'][:3]}] {p['name'][:48]}")
    print(f"\nwritten: {a.out}")

if __name__ == "__main__":
    main()
