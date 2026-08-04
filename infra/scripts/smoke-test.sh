#!/usr/bin/env bash
# Shared smoke gate (T0-T3). Usage: smoke-test.sh [container] [base_url]
set -euo pipefail
cd "$(dirname "$0")/../.."
source infra/versions.lock
C="${1:-keel-webchat}"; URL="${2:-http://127.0.0.1:8443}"
OPX=$(grep -oP '^openpyxl==\K[0-9.]+' infra/docker/requirements.txt)
PYY=$(grep -oP '^PyYAML==\K[0-9.]+' infra/docker/requirements.txt)
pass=0; fail=0
chk(){ if [ "$2" = "$3" ]; then echo "PASS $1 ($3)"; pass=$((pass+1)); else echo "FAIL $1 expected=$2 actual=$3"; fail=$((fail+1)); fi; }
chk node     "v${NODE_VERSION}"          "$(sudo docker exec "$C" node --version)"
chk claude   "${CLAUDE_CODE_VERSION}"    "$(sudo docker exec "$C" sh -c 'claude --version 2>/dev/null | cut -d" " -f1')"
chk openpyxl "$OPX" "$(sudo docker exec "$C" python3 -c 'import openpyxl;print(openpyxl.__version__)')"
chk pyyaml   "$PYY" "$(sudo docker exec "$C" python3 -c 'import yaml;print(yaml.__version__)')"
h=unknown; for i in $(seq 1 20); do
  h=$(sudo docker inspect -f '{{.State.Health.Status}}' "$C"); [ "$h" = healthy ] && break; sleep 5
done
chk health healthy "$h"
code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/" || echo 000)
# Edge-only Cloudflare auth: a DIRECT hit to "/" (no Access JWT) is correctly 403ed by
# requireAuth, which proves the app is up AND enforcing auth. 200/302 = unauth build.
case "$code" in 200|302) echo "PASS http ($code)"; pass=$((pass+1));; 403) echo "PASS http ($code — edge-auth enforced; direct/unauth request correctly rejected)"; pass=$((pass+1));; *) echo "FAIL http ($code)"; fail=$((fail+1));; esac
res=$(sudo docker exec "$C" grep -rli --exclude-dir=node_modules "nexgen\|nvcc\|NGE-[0-9]" /app 2>/dev/null | wc -l) || true
chk residue 0 "$res"
w=$(sudo docker exec "$C" sh -c 'touch /app/state/.smoke && rm /app/state/.smoke && echo ok') || true
chk state-writable ok "$w"
echo "---- smoke: ${pass} pass / ${fail} fail ----"
exit $((fail > 0))
