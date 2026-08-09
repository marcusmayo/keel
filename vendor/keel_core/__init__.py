"""keel_core -- deterministic record-set reconciliation.

Pure functions: values in, values out. No disk, no network, no LLM, no clock.
"""
from ._text import overlap, toks, norm_title
from .schema import (BUCKETS, ReconcileConfig, Warning_, KeelCoreError,
                     SchemaError, ParseError, ConfigError, MissingDependencyError,
                     empty_buckets, new_result, validate_result)
from .normalize import (parse_jira_csv, parse_backlog_xlsx, normalize_jira,
                        normalize_backlog, parse_keel_items, parse_resolutions)
from .reconcile import reconcile
from .find import find, group_by_status
from .score import (validate_components, compute_wsjf, compute_rice, score_item,
                    score_all, SCALES_DOC, FIB, IMPACT, CONFIDENCE)
from .export import to_workbook
from .judge import (make_judgment_prompt, pairs_from_result, parse_verdicts,
                    apply_verdicts, semantic_records, VerdictError)

__version__ = "0.1.0"
__all__ = [
    "overlap", "toks", "norm_title",
    "BUCKETS", "ReconcileConfig", "Warning_", "KeelCoreError", "SchemaError",
    "ParseError", "ConfigError", "MissingDependencyError", "empty_buckets", "new_result", "validate_result",
    "parse_jira_csv", "parse_backlog_xlsx", "normalize_jira", "normalize_backlog",
    "parse_keel_items", "parse_resolutions", "reconcile",
    "find", "group_by_status",
    "validate_components", "compute_wsjf", "compute_rice", "score_item",
    "score_all", "SCALES_DOC", "FIB", "IMPACT", "CONFIDENCE",
    "to_workbook",
    "make_judgment_prompt", "pairs_from_result", "parse_verdicts",
    "apply_verdicts", "semantic_records", "VerdictError",
    "__version__",
]
