#!/usr/bin/env python3
"""Semantic pass over reconcile's ambiguous bucket. Gathers Jira + Keel descriptions,
sends ONE bounded SAME/DISTINCT judgment prompt to claude -p (neutral cwd, no project
context), parses verdicts, annotates reconcile.json. Proposals only - never applied."""

import json, re, glob, subprocess, sys, tempfile
from pathlib import Path
import yaml
from _require import require

RECON = Path("state/normalized/reconcile.json")
SEMANTIC = Path("state/normalized/semantic.json")
STATE_GLOB = "state/*.yaml"
RAW_GLOB = "knowledge/import/raw/*.csv"
MODEL_NOTE = "claude -p default model"

def newest_raw():
    fs = sorted(glob.glob(RAW_GLOB))
    return fs[-1] if fs else None

def load_jira_desc(refs_needed):
    import csv
    out = {}
    f = newest_raw()
    if not f:
        return out
    with open(f, newline='', encoding='utf-8-sig') as fh:
        rows = list(csv.reader(fh))
    header = rows[0]
    def idx(name):
        for i, h in enumerate(header):
            if h.strip().lower() == name.lower():
                return i
        return None
    ik, idsc = idx("Issue key"), idx("Description")
    if ik is None:
        return out
    for r in rows[1:]:
        k = (r[ik].strip() if ik < len(r) else "")
        if k in refs_needed:
            out[k] = (r[idsc].strip() if (idsc is not None and idsc < len(r)) else "")
    return out

def load_keel_desc():
    d = {}
    for f in glob.glob(STATE_GLOB):
        try:
            y = yaml.safe_load(Path(f).read_text(encoding="utf-8"))
        except Exception:
            continue
        w = (y or {}).get("workitem")
        if not w:
            continue
        k = w.get("key", "")
        if k:
            d[k] = {"name": w.get("name", ""), "desc": w.get("description", "")}
    return d

def trunc(s, n=260):
    return (s or "").replace("\n", " ").strip()[:n]

def build_prompt(pairs):
    L = [
      "Judge whether each pair of software work items is the SAME capability/work or DISTINCT.",
      "A parent epic and one of its child stories are DISTINCT. A feature and the story implementing it may be SAME.",
      "Return ONLY a JSON array (no prose, no markdown). Each element:",
      '{"id": <int>, "verdict": "SAME"|"DISTINCT", "reason": "<one sentence>"}',
      "", "Pairs:"]
    for i, p in enumerate(pairs):
        L.append(f'[{i}] A (Jira {p["src_ref"]}): "{p["src_name"]}" -- {p["src_desc"] or "(no description)"}')
        L.append(f'    B (Keel {p["keel_key"]}): "{p["keel_name"]}" -- {p["keel_desc"] or "(no description)"}')
    return "\n".join(L)

def extract_json(t):
    t = t.strip()
    t = re.sub(r"^```(?:json)?", "", t).strip()
    t = re.sub(r"```$", "", t).strip()
    i, j = t.find("["), t.rfind("]")
    if i == -1 or j == -1 or j < i:
        raise ValueError("no JSON array found")
    return json.loads(t[i:j+1])

def _judge_model_args():
    """The bare CLI resolves a default model the gateway may not carry (live 400:
    claude-opus-4-8 not in catalog). Pass an explicit, catalog-valid model:
    KEEL_JUDGE_MODEL wins; else the container-baked ANTHROPIC_SMALL_FAST_MODEL
    (right tier for batched judgment); else legacy bare behavior."""
    import os
    m = os.environ.get("KEEL_JUDGE_MODEL") or os.environ.get("ANTHROPIC_SMALL_FAST_MODEL")
    return ["--model", m] if m else []

def main():
    data = json.loads(require(RECON).read_text(encoding="utf-8"))
    amb = data["buckets"].get("ambiguous", [])
    if not amb:
        print("no ambiguous pairs - nothing to judge"); return

    refs = {e.get("src_ref", "") for e in amb if e.get("src_ref")}
    jdesc = load_jira_desc(refs)
    kdesc = load_keel_desc()

    pairs = []
    for e in amb:
        ref, kk = e.get("src_ref", ""), e.get("keel_key", "")
        pairs.append({
            "src_ref": ref, "src_name": e.get("src_name", ""),
            "src_desc": trunc(jdesc.get(ref, "")),
            "keel_key": kk, "keel_name": e.get("keel_name", ""),
            "keel_desc": trunc((kdesc.get(kk) or {}).get("desc", "")),
        })

    prompt = build_prompt(pairs)
    print(f"judging {len(pairs)} ambiguous pairs via {MODEL_NOTE} (one call, may take ~30-60s)...", flush=True)
    with tempfile.TemporaryDirectory() as td:
        proc = subprocess.run(["claude", "-p", prompt] + _judge_model_args(), cwd=td,
                              capture_output=True, text=True, timeout=240)
    if proc.returncode != 0:
        print(f"claude -p exit {proc.returncode}\nstderr: {proc.stderr[:400]}\nstdout: {proc.stdout[:400]}"); sys.exit(1)
    try:
        verdicts = extract_json(proc.stdout)
    except Exception as ex:
        print(f"parse fail: {ex}\n--- raw (first 800) ---\n{proc.stdout[:800]}"); sys.exit(1)

    vmap = {v["id"]: v for v in verdicts if isinstance(v, dict) and "id" in v}
    same = dist = 0
    for i, e in enumerate(amb):
        v = vmap.get(i)
        if not v:
            e["semantic_verdict"] = ""; e["semantic_reason"] = "(no verdict)"; continue
        e["semantic_verdict"] = v.get("verdict", "")
        e["semantic_reason"] = v.get("reason", "")
        if v.get("verdict") == "SAME": same += 1
        elif v.get("verdict") == "DISTINCT": dist += 1

    data["summary"]["semantic"] = {"judged": len(pairs), "same": same, "distinct": dist, "model": MODEL_NOTE}
    RECON.write_text(json.dumps(data, indent=2), encoding="utf-8")
    # Durable, standalone semantic verdicts -- immune to reconcile.json regeneration
    # (export_multisource run_pass rewrites reconcile.json; this file survives).
    from datetime import date as _date
    _sem_pairs = [
        {"src_ref": _se.get("src_ref", ""), "src_name": _se.get("src_name", ""),
         "keel_key": _se.get("keel_key", ""), "keel_name": _se.get("keel_name", ""),
         "verdict": _se.get("verdict", ""),
         "semantic_verdict": _se.get("semantic_verdict", ""),
         "semantic_reason": _se.get("semantic_reason", "")}
        for _sb, _srows in data.get("buckets", {}).items()
        for _se in _srows if _se.get("semantic_verdict")
    ]
    SEMANTIC.write_text(json.dumps(
        {"generated": _date.today().isoformat(), "pairs": _sem_pairs}, indent=2),
        encoding="utf-8")
    print(f"wrote {len(_sem_pairs)} semantic verdict(s) to {SEMANTIC}")

    print(f"=== semantic pass: {len(pairs)} judged -> {same} SAME, {dist} DISTINCT ===")
    for e in amb:
        print(f"  [{e.get('semantic_verdict','?'):8s}] {e['src_name'][:34]!r} ~ {e['keel_key']} {e['keel_name'][:26]!r}")
        print(f"            {e.get('semantic_reason','')[:96]}")
    print(f"\nwrote verdicts into {RECON} (proposals only - not applied). /export next to see them.")

if __name__ == "__main__":
    main()
