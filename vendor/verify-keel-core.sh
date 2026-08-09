#!/usr/bin/env bash
# verify-keel-core.sh -- assert vendored keel_core matches its manifest.
# Run inside a consumer's BUILD (Dockerfile) against the vendored dir:
#   ./verify-keel-core.sh <dir-containing-vendored-keel_core-and-stamp>
# Exits non-zero (fails the build) on any drift. The drift guarantee, applied
# to the reconciliation engine the same way the fleet applies it to core/.
set -euo pipefail
DIR="${1:?usage: verify-keel-core.sh <dir-with-vendored-keel_core-and-stamp>}"
STAMP="$DIR/.keel-core-version"
[ -f "$STAMP" ] || { echo "VERIFY FAIL: no .keel-core-version stamp in $DIR"; exit 1; }
MF="$(mktemp)"
awk '/^manifest:/{f=1;next} f&&/^  /{sub(/^  /,"");print}' "$STAMP" > "$MF"
[ -s "$MF" ] || { echo "VERIFY FAIL: no manifest lines in $STAMP"; rm -f "$MF"; exit 1; }
if ( cd "$DIR" && sha256sum -c "$MF" >/dev/null ); then
  rm -f "$MF"; echo "verify-keel-core OK: vendored engine matches manifest"
else
  rm -f "$MF"
  echo "VERIFY FAIL: vendored keel_core drifted from manifest (edit the engine in"
  echo "             the keel-core repo, then re-run sync-keel-core.sh)"
  exit 1
fi
