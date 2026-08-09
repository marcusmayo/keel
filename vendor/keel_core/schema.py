"""Buckets, configuration, warnings, typed errors, and result validation.

Ported from tools/_recon.py, plus the warnings model that product rule 5
requires: a degraded run must be visible in the returned value, never silent.
"""
from dataclasses import dataclass, field, asdict

BUCKETS = ("changed", "duplicate", "completed", "conflict", "gap", "done_gap", "ambiguous")

DEFAULT_PORTFOLIO_TYPES = frozenset({"epic", "story"})
DEFAULT_KEEL_DONE = frozenset({"done", "released", "complete", "completed"})
DEFAULT_SRC_DONE = frozenset({"done"})


# --------------------------------------------------------------------- errors
class KeelCoreError(Exception):
    """Base error. Carries a machine-readable code, the offending value, and a
    one-line fix hint, so a caller (including an MCP server) can turn it into a
    structured tool error instead of an opaque stack trace."""

    code = "KEEL_CORE_ERROR"

    def __init__(self, message, value=None, hint=""):
        super().__init__(message)
        self.message = message
        self.value = value
        self.hint = hint

    def as_dict(self):
        return {"error": self.code, "message": self.message,
                "value": self.value, "fix": self.hint}


class SchemaError(KeelCoreError):
    code = "SCHEMA_INVALID"


class ParseError(KeelCoreError):
    code = "PARSE_FAILED"


class ConfigError(KeelCoreError):
    code = "CONFIG_INVALID"


class MissingDependencyError(KeelCoreError):
    """An optional extra is required for this call and is not installed.

    FIX B5: the engine core needs no spreadsheet library, so openpyxl is an
    optional extra. Without this, a lean install surfaced a bare
    ModuleNotFoundError from deep inside the call -- which tells a caller
    nothing about how to fix it, and violates the structured-errors rule.
    """
    code = "DEPENDENCY_MISSING"


# ------------------------------------------------------------------- warnings
@dataclass(frozen=True)
class Warning_:
    """A thing that went wrong without stopping the run. Never dropped.

    FIX A2/A3: legacy swallowed YAML parse failures (stderr warning in
    reconcile.py, silence in find.py). An excluded item then produced a source
    row with no match, which the operator read as 'this work item does not
    exist' -- a parse error laundered into an instruction to create a duplicate.
    """
    code: str
    message: str
    context: str = ""

    def as_dict(self):
        return {"code": self.code, "message": self.message, "context": self.context}


# --------------------------------------------------------------------- config
@dataclass(frozen=True)
class ReconcileConfig:
    """Everything the legacy tools read from ambient state, as arguments.

    Defaults reproduce legacy values. `legacy_compat=True` additionally
    suppresses every behavioural fix, which is what the Phase 7a parity gate
    asserts against captured legacy output.
    """
    source_key_prefix: str = ""
    high: float = 0.80
    low: float = 0.40
    portfolio_types: frozenset = DEFAULT_PORTFOLIO_TYPES
    keel_done: frozenset = DEFAULT_KEEL_DONE
    src_done: frozenset = DEFAULT_SRC_DONE
    type_overrides: dict = field(default_factory=dict)
    tie_epsilon: float = 0.001
    legacy_compat: bool = False

    def __post_init__(self):
        for name in ("high", "low"):
            v = getattr(self, name)
            if not 0.0 <= v <= 1.0:
                raise ConfigError(f"{name} must be within [0.0, 1.0]", value=v,
                                  hint=f"pass ReconcileConfig({name}=0.8)")
        if self.low > self.high:
            raise ConfigError("low threshold exceeds high threshold",
                              value={"low": self.low, "high": self.high},
                              hint="low must be <= high")


# --------------------------------------------------------------------- result
def empty_buckets():
    return {b: [] for b in BUCKETS}


def new_result(summary=None, buckets=None, warnings=None, generated=""):
    """Build a result envelope.

    FIX A8: `generated` is supplied by the caller. Nothing in keel_core reads a
    clock, so identical inputs produce byte-identical output.
    """
    return {
        "generated": generated,
        "summary": summary or {},
        "buckets": buckets if buckets is not None else empty_buckets(),
        "warnings": [w.as_dict() if isinstance(w, Warning_) else w
                     for w in (warnings or [])],
    }


def validate_result(d):
    """Validate a reconcile result envelope. Raises SchemaError (legacy exited
    the process, which no library may do)."""
    if not isinstance(d, dict):
        raise SchemaError("result must be a mapping", value=type(d).__name__,
                          hint="pass the dict returned by reconcile()")
    missing = [k for k in ("generated", "summary", "buckets") if k not in d]
    if missing:
        raise SchemaError("result is missing required keys", value=missing,
                          hint="build results with keel_core.schema.new_result()")
    b = d["buckets"]
    if not isinstance(b, dict):
        raise SchemaError("buckets must be a mapping", value=type(b).__name__,
                          hint="expected one key per bucket name")
    unknown = sorted(k for k in b if k not in BUCKETS)
    if unknown:
        raise SchemaError("unknown bucket name", value=unknown,
                          hint=f"valid buckets: {', '.join(BUCKETS)}")
    for k in BUCKETS:
        b.setdefault(k, [])
    d.setdefault("warnings", [])
    return d
