#!/usr/bin/env bash
# fleet-core: intake sweep. Pulls items an operator dropped into this agent's OWN container,
# under the intake/ prefix, down into the agent's staging dir -- the same place a panel upload
# lands. It STAGES ONLY. Nothing is processed, extracted or admitted: the operator's Process
# decision still applies, exactly as it does for an upload.
#
# Why the host and not the container: auth is the VM's managed identity, and the proven MSI path
# on these VMs is host-side curl against IMDS (core/backup-push.sh does the same). Running it in
# the webchat container would depend on IMDS being reachable through the bridge, which is not
# something this fleet has verified -- and an unverified assumption is not what a fresh agent
# should be built on.
#
# Why the store and not an external source: the drop box is a container in the operator's own
# subscription that only their own workstation writes to. There is no path from any other system
# into this one, which is a property of the mechanism rather than a rule someone has to follow.
#
# The sweep is a QUEUE, not a mirror: a blob that lands in staging is deleted from the container,
# so there is no seen-list to drift out of step with reality and no re-staging after the operator
# deletes something. The container carries the fleet's 14-day rule anyway; the copy that matters
# is the one the agent admits, which the nightly push preserves.
#
# Usage: agent-intake-sweep            one pass (the timer calls this)
#        agent-intake-sweep --status   what is waiting, without fetching
set -euo pipefail
[ "$(id -u)" = 0 ] || exec sudo -n bash "$0" "$@"   # the state volume is root-owned; the timer is root already

HERE="$(cd "$(dirname "$0")/.." && pwd)"            # vendored FLAT into scripts/ -> one level up is the agent root
FLAGS="$HERE/.provision-flags"
flag() { grep -E "^$1=" "$FLAGS" 2>/dev/null | head -1 | cut -d= -f2-; }
ACC="$(flag BACKUP_ACCOUNT || true)"
AGENT="$(flag AGENT_NAME || true)"
PROFILE="$(flag AGENT_PROFILE || true)"
[ -n "$ACC" ] || { echo "intake: no store configured (BACKUP_ACCOUNT empty) — nothing to sweep"; exit 0; }
[ -n "$AGENT" ] || { echo "intake ABORT: AGENT_NAME missing from .provision-flags"; exit 1; }
[ -n "$PROFILE" ] || { echo "intake ABORT: AGENT_PROFILE missing from .provision-flags"; exit 1; }

# Staging lives on the state volume, which is where the webchat reads it from. Volume naming is
# the fleet's own convention (<profile>_<profile>-state), the same one backup-push.sh relies on.
STATE_VOL="/var/lib/docker/volumes/${PROFILE}_${PROFILE}-state/_data"
[ -d "$STATE_VOL" ] || { echo "intake: state volume not present yet ($STATE_VOL) — the agent has not finished its first boot"; exit 0; }
STAGE="$STATE_VOL/staging"

BASE="https://$ACC.blob.core.windows.net/$AGENT"
HV="x-ms-version: 2021-08-06"
tok() {
  curl -fsS --get -H Metadata:true \
    --data-urlencode "api-version=2018-02-01" \
    --data-urlencode "resource=https://storage.azure.com/" \
    "http://169.254.169.254/metadata/identity/oauth2/token" \
  | grep -o '"access_token":"[^"]*' | cut -d'"' -f4
}

T="$(tok)"
LIST="$(curl -fsS -H "Authorization: Bearer $T" -H "$HV" \
  "$BASE?restype=container&comp=list&prefix=intake/" || true)"
# One <Name> per blob. Names are operator-supplied, so anything outside the safe charset is
# reported and SKIPPED rather than fetched -- a name is not trusted just because it is ours.
NAMES="$(printf '%s' "$LIST" | grep -o '<Name>[^<]*</Name>' | sed 's|<Name>||; s|</Name>||' || true)"

if [ "${1:-}" = "--status" ]; then
  n=0; while IFS= read -r b; do [ -n "$b" ] && n=$((n+1)); done <<< "$NAMES"
  echo "intake: $n item(s) waiting under intake/ for $AGENT"
  printf '%s\n' "$NAMES" | sed '/^$/d; s/^/  /'
  exit 0
fi

mkdir -p "$STAGE"
# The staging dir must stay readable AND writable by the container user, which owns the volume's
# contents (uid 10001). A root-owned file dropped in would list fine and then fail to move --
# and the DIR itself has the same rule: Process removes a staged file from inside the container,
# and unlink needs write on the parent, so a root-owned staging dir makes every Process fail
# with EACCES while listing works perfectly. A clean restore surfaced exactly that: tar re-
# created staging root-owned, and only the volume ROOT gets the ownership repair. Re-asserting
# it here makes every sweep self-healing, whatever recreated the dir.
OWN="$(stat -c '%u:%g' "$STATE_VOL")"
chown "$OWN" "$STAGE"
staged=0; skipped=0
while IFS= read -r blob; do
  [ -n "$blob" ] || continue
  leaf="${blob#intake/}"
  case "$leaf" in
    ""|*/*) echo "intake: skipping $blob (nested paths are not staged)"; skipped=$((skipped+1)); continue;;
    *[!A-Za-z0-9._-]*) echo "intake: skipping $blob (name fails the safe charset)"; skipped=$((skipped+1)); continue;;
  esac
  tmp="$(mktemp)"
  if ! curl -fsS -H "Authorization: Bearer $T" -H "$HV" -o "$tmp" "$BASE/$blob"; then
    echo "intake: download failed for $blob (left in the store; the next sweep retries)"
    rm -f "$tmp"; skipped=$((skipped+1)); continue
  fi
  # Never clobber something already staged and not yet processed: same name, new item, both kept.
  dest="$STAGE/$leaf"
  if [ -e "$dest" ]; then dest="$STAGE/$(date -u +%Y%m%dT%H%M%SZ)-$leaf"; fi
  mv "$tmp" "$dest"
  chmod 0644 "$dest"; chown "$OWN" "$dest"
  # Delete the source only after the file is on disk -- a failed delete leaves a duplicate for
  # the operator to remove, which is recoverable; deleting first would lose the item outright.
  if curl -fsS -X DELETE -H "Authorization: Bearer $T" -H "$HV" "$BASE/$blob" >/dev/null; then
    echo "intake: staged $(basename "$dest")"
  else
    echo "intake: staged $(basename "$dest") BUT the source blob could not be deleted — remove intake/$leaf by hand or the next sweep stages it again"
  fi
  staged=$((staged+1))
done <<< "$NAMES"

echo "intake: $staged staged, $skipped skipped — Process moves them into the profile's pipeline"
