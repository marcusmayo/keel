#!/usr/bin/env python3
"""Keel-origin -> Jira semantic merge pass (type-mapped). For each keel-origin blank-ref
item NOT already resolved, find plausible Jira candidates of the MAPPED type (keel feature
-> jira epic, keel story -> jira story, keel epic -> jira epic), prefilter by overlap, and
ask claude -p which (if any) is the SAME capability. Writes proposals into reconcile.json's
merge_candidate bucket. Propose-only: stamps nothing, resolves nothing. Idempotent - skips
items already in resolutions.json (MERGE or DISTINCT)."""

import json, re, glob, subprocess, sys, tempfile
from pathlib import Path
import yaml

RECON   = Path("state/normalized/reconcile.json")
RESOL   = Path("state/resolutions.json")
JPORT   = Path("state/normalized/jira-portfolio.json")
JBUGS   = Path("state/normalized/jira-bugs.json")
STATE_GLOB   = "state/*.yaml"
SUPPORT_GLOB = "support/*.yaml"

PREFILTER_FLOOR = 0.20
TOP_CANDIDATES  = 5
BATCH_SIZE      = 12          # keel items per claude -p call (bounded prompt)
MODEL_NOTE = "claude -p default model"

# keel type -> jira type it maps to
TYPE_MAP = {"feature": "epic", "story": "story", "epic": "epic", "bug": "bug"}

WORD = re.compile(r"[a-z0-9]+")
def toks(s): return set(WORD.findall((s or "").lower()))
def overlap(a, b):
    ta, tb = toks(a), toks(b)
    if not ta or not tb: return 0.0
    inter = len(ta & tb)
    if inter == 0: return 0.0
    if min(len(ta), len(tb)) >= 2:
        return inter / min(len(ta), len(tb))
    return inter / len(ta | tb)

def load_resolutions():
    if not RESOL.exists(): return {}
    try:
        d = json.loads(RESOL.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return {r["keel_key"]: r for r in d.get("resolutions", []) if r.get("keel_key")}

def load_keel_origin():
    """keel-origin blank-ref items from both lanes, with descriptions."""
    out = []
    for gp in (STATE_GLOB, SUPPORT_GLOB):
        for f in glob.glob(gp):
            if Path(f).stem.startswith("_"): continue
            try:
                w = (yaml.safe_load(Path(f).read_text(encoding="utf-8")) or {}).get("workitem") or {}
            except Exception:
                continue
            src = w.get("source") or {}
            if src.get("origin") == "keel" and not src.get("ref") and w.get("name"):
                out.append({"key": w.get("key",""), "type": w.get("type",""),
                            "name": w.get("name",""), "desc": w.get("description","")})
    return out

def load_jira_streams():
    streams = {"epic": [], "story": [], "bug": []}
    for pth in (JPORT, JBUGS):
        if not pth.exists(): continue
        for r in json.loads(pth.read_text(encoding="utf-8")).get("rows", []):
            t = r.get("type")
            if t in streams:
                streams[t].append({"ref": (r.get("source") or {}).get("ref",""),
                                   "name": r.get("name",""),
                                   "desc": r.get("description","") or ""})
    return streams

def trunc(s, n=220): return (s or "").replace("\n"," ").strip()[:n]

def build_prompt(batch):
    """batch: list of {keel, candidates}. Ask which candidate (if any) is SAME capability."""
    L = ["For each KEEL item, decide if any of its Jira CANDIDATES is the SAME capability/work.",
         "Keel 'feature' maps to a Jira 'epic'; keel 'story' to a Jira 'story'. Same capability",
         "means they describe the same work, even if titles differ. If none match, say NO_MATCH.",
         "Return ONLY a JSON array, one element per keel item:",
         '{"keel_key": "<key>", "decision": "MERGE"|"NO_MATCH", "jira_ref": "<ref or empty>", "reason": "<one sentence>"}',
         ""]
    for b in batch:
        k = b["keel"]
        L.append(f'KEEL {k["key"]} ({k["type"]}): "{k["name"]}" -- {trunc(k["desc"]) or "(no description)"}')
        if not b["candidates"]:
            L.append("  CANDIDATES: (none) -> NO_MATCH")
        for c in b["candidates"]:
            L.append(f'  CANDIDATE {c["ref"]}: "{c["name"]}" -- {trunc(c["desc"]) or "(no description)"}')
        L.append("")
    return "\n".join(L)

def extract_json(t):
    t = re.sub(r"^```(?:json)?","",t.strip()).strip(); t = re.sub(r"```$","",t).strip()
    i,j = t.find("["), t.rfind("]")
    if i==-1 or j==-1 or j<i: raise ValueError("no JSON array")
    return json.loads(t[i:j+1])

def _judge_model_args():
    """The bare CLI resolves a default model the gateway may not carry (live 400:
    claude-opus-4-8 not in catalog). Pass an explicit, catalog-valid model:
    KEEL_JUDGE_MODEL wins; else the container-baked ANTHROPIC_SMALL_FAST_MODEL
    (right tier for batched judgment); else legacy bare behavior."""
    import os
    m = os.environ.get("KEEL_JUDGE_MODEL") or os.environ.get("ANTHROPIC_SMALL_FAST_MODEL")
    return ["--model", m] if m else []

def judge(batch):
    prompt = build_prompt(batch)
    with tempfile.TemporaryDirectory() as td:
        proc = subprocess.run(["claude","-p",prompt] + _judge_model_args(), cwd=td, capture_output=True, text=True, timeout=300)
    if proc.returncode != 0:
        raise RuntimeError(f"claude -p exit {proc.returncode}: {proc.stderr[:300]}")
    return extract_json(proc.stdout)

def main():
    resolved = load_resolutions()
    keel = load_keel_origin()
    unresolved = [k for k in keel if k["key"] not in resolved]
    skipped = len(keel) - len(unresolved)
    print(f"keel-origin items: {len(keel)} | already resolved (skipped): {skipped} | to judge: {len(unresolved)}", flush=True)
    if not unresolved:
        print("nothing to judge - all keel-origin items already resolved."); return

    streams = load_jira_streams()

    # build shortlists (type-mapped, prefiltered)
    work = []
    auto_nomatch = []
    for k in unresolved:
        jt = TYPE_MAP.get(k["type"])
        pool = streams.get(jt, []) if jt else []
        scored = sorted(((overlap(k["name"], c["name"]), c) for c in pool),
                        key=lambda x: -x[0])
        cands = [c for s,c in scored if s >= PREFILTER_FLOOR][:TOP_CANDIDATES]
        if not cands:
            auto_nomatch.append(k)
        else:
            work.append({"keel": k, "candidates": cands})

    print(f"  auto NO_MATCH (no candidate above floor {PREFILTER_FLOOR}): {len(auto_nomatch)}", flush=True)
    print(f"  sent to judge: {len(work)} items in batches of {BATCH_SIZE}", flush=True)

    verdicts = {}
    for i in range(0, len(work), BATCH_SIZE):
        batch = work[i:i+BATCH_SIZE]
        print(f"  judging batch {i//BATCH_SIZE + 1} ({len(batch)} items)...", flush=True)
        for v in judge(batch):
            if isinstance(v, dict) and v.get("keel_key"):
                verdicts[v["keel_key"]] = v

    # assemble merge_candidate proposals (MERGE verdicts only; NO_MATCH recorded in summary)
    kmap = {k["key"]: k for k in unresolved}
    jname = {c["ref"]: c["name"] for st in streams.values() for c in st}
    proposals, nomatch = [], []
    for k in unresolved:
        v = verdicts.get(k["key"])
        if k in auto_nomatch or not v or v.get("decision") != "MERGE" or not v.get("jira_ref"):
            reason = (v or {}).get("reason", "no candidate above prefilter floor" if k in auto_nomatch else "no verdict")
            nomatch.append({"keel_key": k["key"], "keel_name": k["name"], "reason": reason})
            continue
        proposals.append({
            "keel_key": k["key"], "keel_type": k["type"], "keel_name": k["name"],
            "jira_ref": v["jira_ref"], "jira_name": jname.get(v["jira_ref"], ""),
            "reason": v.get("reason",""),
        })

    data = json.loads(RECON.read_text(encoding="utf-8"))
    data["buckets"]["merge_candidate"] = proposals
    data["summary"]["merge"] = {"judged": len(work), "auto_nomatch": len(auto_nomatch),
                                "proposed": len(proposals), "no_match": len(nomatch),
                                "model": MODEL_NOTE}
    RECON.write_text(json.dumps(data, indent=2), encoding="utf-8")

    print(f"\n=== merge pass: {len(proposals)} MERGE proposals, {len(nomatch)} no-match ===")
    for p in proposals:
        print(f"  MERGE  {p['keel_key']:7s} {p['keel_type']:7s} {p['keel_name'][:32]!r}")
        print(f"         -> {p['jira_ref']} {p['jira_name'][:36]!r}")
        print(f"         {p['reason'][:92]}")
    print(f"\nwrote {len(proposals)} proposals to reconcile.json merge_candidate bucket (propose-only).")
    print("Review the Merge sheet in /export, then /merge-accept (or /merge-reject <keys>).")

if __name__ == "__main__":
    main()
