#!/usr/bin/env bash
# fetch-secret.sh — shared managed-identity -> Key Vault secret fetch.
# SOURCED, not executed:   . "$AGENT_ROOT/scripts/fetch-secret.sh"
#
# Provides, after sourcing:
#   fetch_secret_init      acquire the managed-identity token (retry loop); call ONCE before kv_get
#   kv_get <name>          print a Key Vault secret's value on stdout (retry loop)
#
# Requires KEY_VAULT_NAME + MSI_CLIENT_ID in the environment — bootstrap sources these
# from .provision-flags, which cloud-init writes from vm.bicep. Uses the VM's IMDS
# endpoint for the AAD token and the Key Vault REST API over curl: no az CLI, no account
# keys, no secret ever on disk. Retries absorb managed-identity / RBAC propagation lag
# (Bicep has no time_sleep, so the loop is where it lands). Load-bearing failures return
# non-zero so the caller decides fatal handling — nothing is silently skipped.
#
# This is Castor's proven bootstrap fetch logic, factored into fleet-core so every agent
# profile fetches secrets through one identical implementation.
#
# Host requirements: curl, python3.

: "${KV_API:=7.4}"
: "${FS_IMDS:=http://169.254.169.254/metadata/identity/oauth2/token}"

_fs_get_token() {
  curl -s -H 'Metadata:true' -G "$FS_IMDS" \
    --data-urlencode 'api-version=2018-02-01' \
    --data-urlencode 'resource=https://vault.azure.net' \
    --data-urlencode "client_id=${MSI_CLIENT_ID}" 2>/dev/null \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("access_token",""))' 2>/dev/null || true
}

# Acquire the AAD token into FS_TOKEN, retrying for MI / RBAC propagation.
# Returns non-zero (does not exit) so the caller controls fatal handling.
fetch_secret_init() {
  [ -n "${KEY_VAULT_NAME:-}" ] || { echo "fetch-secret: KEY_VAULT_NAME empty — no vault provisioned" >&2; return 2; }
  [ -n "${MSI_CLIENT_ID:-}" ]  || { echo "fetch-secret: MSI_CLIENT_ID empty" >&2; return 2; }
  FS_VAULT_BASE="https://${KEY_VAULT_NAME}.vault.azure.net"
  FS_TOKEN=""
  local i
  for i in $(seq 1 12); do
    FS_TOKEN="$(_fs_get_token)"
    [ -n "$FS_TOKEN" ] && break
    echo ">> IMDS token not ready ($i/12) — identity propagating, sleeping 15s" >&2
    sleep 15
  done
  [ -n "$FS_TOKEN" ] || { echo "fetch-secret: no managed-identity token from IMDS after 12 attempts" >&2; return 1; }
  return 0
}

# kv_get <name> -> prints the secret value on stdout; non-zero on failure.
#   200 value | 403 role propagating (retry) | 401 refresh token | 404 not set (fail w/ fix hint) | other retry
kv_get() {
  local name="${1:?kv_get <secret-name>}" out code body i
  [ -n "${FS_TOKEN:-}" ] || { echo "fetch-secret: kv_get called before fetch_secret_init" >&2; return 2; }
  for i in $(seq 1 12); do
    out="$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer ${FS_TOKEN}" \
      "${FS_VAULT_BASE}/secrets/${name}?api-version=${KV_API}" || true)"
    code="${out##*$'\n'}"
    body="${out%$'\n'*}"
    case "$code" in
      200) printf '%s' "$body" | python3 -c 'import sys,json;print(json.load(sys.stdin)["value"])'; return 0 ;;
      403) echo ">>   secret '$name': 403, role propagating ($i/12) — sleeping 15s" >&2; sleep 15 ;;
      401) echo ">>   token expired — refreshing" >&2; FS_TOKEN="$(_fs_get_token)" ;;
      404) echo "fetch-secret: secret '$name' not in ${KEY_VAULT_NAME}. Set it:" >&2
           echo "  az keyvault secret set --vault-name ${KEY_VAULT_NAME} --name ${name} --value <value>" >&2
           return 3 ;;
      *)   echo ">>   secret '$name': HTTP $code ($i/12) — sleeping 15s" >&2; sleep 15 ;;
    esac
  done
  echo "fetch-secret: could not read secret '$name' after 12 attempts" >&2
  return 1
}
