"""Name search over a supplied record set.

Ported from tools/find.py. Two changes, both required by the product rules:
items come from the caller instead of an unsorted filesystem glob (FIX A4), and
the tokenizer is the shared one (FIX A9). Parse failures are handled by
`normalize.parse_keel_items`, which reports them instead of swallowing them
(FIX A3).
"""
from ._text import norm_title, overlap

DEFAULT_FLOOR = 0.40
DEFAULT_DONE = frozenset({"done", "released", "complete", "completed"})


def find(query, items, floor=DEFAULT_FLOOR, limit=0):
    """Rank `items` against `query`.

    Returns a list of {score, exact, item}. Sorted by score descending, exact
    matches first within a score, then by key then name -- a total order, so the
    result cannot vary between machines the way the legacy filesystem
    enumeration could.
    """
    qn = norm_title(query)
    scored = []
    for it in items:
        name = it.get("name", "")
        s = overlap(query, name)
        exact = bool(qn) and norm_title(name) == qn
        if s >= floor or exact:
            scored.append({"score": 1.0 if exact else round(s, 4),
                           "exact": exact, "item": it})
    scored.sort(key=lambda x: (-x["score"], not x["exact"],
                               x["item"].get("key", ""), x["item"].get("name", "")))
    return scored[:limit] if limit else scored


def group_by_status(results, done_statuses=DEFAULT_DONE):
    """Split ranked results into active and done, preserving rank order."""
    active, done = [], []
    for r in results:
        status = (r["item"].get("status") or "").lower()
        (done if status in done_statuses else active).append(r)
    return {"active": active, "done": done}
