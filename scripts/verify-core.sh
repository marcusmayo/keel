#!/usr/bin/env bash
# verify-core.sh -- assert vendored shared modules match the fleet-core manifest.
# Run inside an agent BUILD (Dockerfile) against the vendored dir:
#   ./verify-core.sh <dir-containing-vendored-core-files-and-stamp>
# Exits non-zero (fails the build) if any vendored file's SHA256 != the manifest
# shipped in its .fleet-core-version stamp. The drift guarantee.
set -euo pipefail
DIR="${1:?usage: verify-core.sh <dir-with-vendored-core-and-stamp>}"
STAMP="$DIR/.fleet-core-version"
[ -f "$STAMP" ] || { echo "VERIFY FAIL: no .fleet-core-version stamp in $DIR"; exit 1; }
# extract the manifest lines (indented under 'manifest:') from the stamp
MF="$(mktemp)"
awk '/^manifest:/{f=1;next} f&&/^  /{sub(/^  /,"");print}' "$STAMP" > "$MF"
[ -s "$MF" ] || { echo "VERIFY FAIL: no manifest lines in stamp $STAMP"; rm -f "$MF"; exit 1; }
# sha256sum -c reads paths relative to CWD, so check from inside DIR
if ( cd "$DIR" && sha256sum -c "$MF" ); then
  rm -f "$MF"
  echo "verify-core OK: vendored core matches fleet-core manifest"
else
  rm -f "$MF"
  echo "VERIFY FAIL: vendored core drifted from manifest (edit shared code in fleet/core/, then re-sync)"
  exit 1
fi
