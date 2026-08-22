#!/usr/bin/env bash
# fleet-core: weekly PII scan. Runs the profile's own scanner (scripts/scan-tree.js) over the
# whole app tree INSIDE the webchat container, and writes logs/pii-scan.log -- the exact file
# both compliance boards read, flagging it stale past eight days. Until this existed, that board
# line said "weekly scan log not present yet" on every agent, because nothing ever wrote it.
#
# Findings are the POINT of the log, not a failure of the run: the service exits non-zero only
# when the scan could not run at all (container down, scanner missing), never because the scan
# found something. The log carries the scanner's own exit code so a reader can tell "clean"
# from "found things" without guessing.
#
# Usage: agent-pii-scan          one pass (the weekly timer calls this)
set -uo pipefail
[ "$(id -u)" = 0 ] || exec sudo -n bash "$0" "$@"

HERE="$(cd "$(dirname "$0")/.." && pwd)"          # vendored FLAT into scripts/ -> one up is the agent root
FLAGS="$HERE/.provision-flags"
flag() { grep -E "^$1=" "$FLAGS" 2>/dev/null | head -1 | cut -d= -f2-; }
PROFILE="$(flag AGENT_PROFILE || true)"
[ -n "$PROFILE" ] || { echo "pii-scan ABORT: AGENT_PROFILE missing from .provision-flags"; exit 1; }
C="${PROFILE}-webchat"

docker ps --format '{{.Names}}' | grep -qx "$C" || { echo "pii-scan ABORT: container $C not running -- nothing scanned, log untouched"; exit 1; }

# The scan runs in the container because that is where the tree, node, and the logs volume live.
# stdout+stderr land in the log; the scanner's exit code is recorded, not obeyed.
docker exec "$C" sh -c 'cd /app && { node scripts/scan-tree.js . --quiet; echo "scan exit=$? at $(date -u +%FT%TZ)"; } > logs/pii-scan.log 2>&1'
RC=$?
[ "$RC" = 0 ] || { echo "pii-scan ABORT: docker exec failed (rc=$RC) -- the log was not refreshed"; exit 1; }

echo "pii-scan OK -- $(docker exec "$C" sh -c 'tail -1 logs/pii-scan.log' 2>/dev/null)"
