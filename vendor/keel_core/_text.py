"""Single implementation of the tokenizer and title-overlap metric.

FIX A9: this logic existed twice in the legacy tree (tools/reconcile.py and
tools/find.py). Identical today, free to diverge tomorrow, and a divergence
would mean search and reconcile disagree about whether two names are the same.
It lives here once.
"""
import re

_WORD = re.compile(r"[a-z0-9]+")


def toks(s):
    """Lowercase, split on non-alphanumerics, no stemming. Returns a set."""
    return set(_WORD.findall((s or "").lower()))


def norm_title(s):
    """Canonical comparable form of a title: sorted unique tokens, space-joined."""
    return " ".join(sorted(toks(s)))


def overlap(a, b):
    """Title similarity in [0.0, 1.0].

    Overlap coefficient |A n B| / min(|A|,|B|) when BOTH sides have >= 2 tokens.

    C1 (documented deviation, preserved deliberately): when either side has
    fewer than 2 tokens the metric falls back to Jaccard. Without this guard a
    one-token generic title ("Mobile") scores 1.0 against every title containing
    that word. Exact one-token matches still score 1.0 because union == inter.
    The legacy docstrings and the Meridian brief both state the min() formula
    unconditionally; the code is right and the documentation was wrong.
    """
    ta, tb = toks(a), toks(b)
    if not ta or not tb:
        return 0.0
    inter = len(ta & tb)
    if inter == 0:
        return 0.0
    if min(len(ta), len(tb)) >= 2:
        return inter / min(len(ta), len(tb))
    return inter / len(ta | tb)
