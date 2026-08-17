#!/usr/bin/env bash
# fleet-core: agent-side backup push/restore. Mechanism in core; values per agent
# in system/backup.yaml (volumes/paths/containers). Auth = VM managed identity ->
# fleet backup store (container = agent name). Modes: push (default) | final | restore <blob>.
# No-ops cleanly when BACKUP_ACCOUNT is empty (fleet not backup-initialized at build).
set -euo pipefail
[ "$(id -u)" = 0 ] || exec sudo -n bash "$0" "$@"    # volume paths need root; timer runs root already
HERE="$(cd "$(dirname "$0")/.." && pwd)"             # vendored FLAT into scripts/ -> one level up is the agent root (keel: repo root, castor: scaffold/)
FLAGS="$HERE/.provision-flags"
flag() { grep -E "^$1=" "$FLAGS" 2>/dev/null | head -1 | cut -d= -f2-; }
ACC="$(flag BACKUP_ACCOUNT || true)"; AGENT="$(flag AGENT_NAME || true)"
[ -n "$ACC" ] || { echo "backup: not configured (BACKUP_ACCOUNT empty) — nothing to do"; exit 0; }
[ -n "$AGENT" ] || { echo "backup ABORT: AGENT_NAME missing from .provision-flags"; exit 1; }
CFG="$HERE/system/backup.yaml"
[ -f "$CFG" ] || { echo "backup ABORT: $CFG missing"; exit 1; }
yl() { awk -v k="$1" '$0 ~ "^"k":" {f=1; next} f && /^[a-z]/ {f=0} f && /^ *- / {gsub(/^ *- */,""); print}' "$CFG"; }
tok() {
  curl -fsS --get -H Metadata:true \
    --data-urlencode "api-version=2018-02-01" \
    --data-urlencode "resource=https://storage.azure.com/" \
    "http://169.254.169.254/metadata/identity/oauth2/token" \
  | grep -o '"access_token":"[^"]*' | cut -d'"' -f4
}
MODE="${1:-push}"
BASE="https://$ACC.blob.core.windows.net/$AGENT"
HV="x-ms-version: 2021-08-06"
if [ "$MODE" = "restore" ]; then
  BLOB="${2:?usage: agent-backup restore <blob>}"
  case "$BLOB" in *[!A-Za-z0-9._-]*) echo "backup ABORT: blob name fails safe charset"; exit 1;; esac
  T="$(tok)"; TMP="/tmp/$BLOB"
  curl -fsS -H "Authorization: Bearer $T" -H "$HV" -o "$TMP" "$BASE/$BLOB"
  # Volume-dir ownership BEFORE the extract: tar as root restores each archived entry's uid/gid,
  # but a volume directory it has to CREATE (a re-provisioned VM whose containers have never run)
  # is left root-owned -- and Docker only copies the image's owned content into a volume that is
  # still empty. The container user (uid 10001) could then read its restored files but not create
  # new ones in the directory: /color returned EACCES writing state/ui.json on the first region
  # move, with everything else looking healthy. Capture, extract, then put the ownership back.
  declare -A OWN=()
  while read -r v; do d="/var/lib/docker/volumes/$v/_data"; [ -n "$v" ] && [ -d "$d" ] && OWN["$d"]="$(stat -c '%u:%g' "$d")"; done < <(yl volumes)
  tar -xzf "$TMP" -C /
  rm -f "$TMP"
  while read -r v; do
    d="/var/lib/docker/volumes/$v/_data"; [ -n "$v" ] && [ -d "$d" ] || continue
    if [ -n "${OWN[$d]:-}" ]; then chown "${OWN[$d]}" "$d"
    else
      # never mounted before: adopt the ownership the archive carried for its own contents
      inner="$(find "$d" -mindepth 1 -maxdepth 1 -printf '%u:%g\n' 2>/dev/null | head -n 1)"
      [ -n "$inner" ] && chown "$inner" "$d"
    fi
  done < <(yl volumes)
  while read -r ct; do [ -n "$ct" ] && docker restart "$ct" >/dev/null 2>&1 || true; done < <(yl containers)
  echo "restored: $BLOB"
  exit 0
fi
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"; SUF=""; [ "$MODE" = "final" ] && SUF="-final"
BLOB="$AGENT-$STAMP$SUF.tar.gz"; TMP="/tmp/$BLOB"
REL=()
while read -r p; do [ -n "$p" ] && [ -e "$HERE/$p" ] && REL+=("${HERE#/}/$p"); done < <(yl paths)
while read -r v; do d="/var/lib/docker/volumes/$v/_data"; [ -n "$v" ] && [ -d "$d" ] && REL+=("${d#/}"); done < <(yl volumes)
[ "${#REL[@]}" -gt 0 ] || { echo "backup ABORT: nothing to back up (check system/backup.yaml)"; exit 1; }
tar -czf "$TMP" -C / "${REL[@]}"
T="$(tok)"
curl -fsS -X PUT -H "Authorization: Bearer $T" -H "$HV" -H "x-ms-blob-type: BlockBlob" \
  -H "Content-Type: application/gzip" --data-binary "@$TMP" "$BASE/$BLOB"
rm -f "$TMP"
echo "pushed: $BLOB"
