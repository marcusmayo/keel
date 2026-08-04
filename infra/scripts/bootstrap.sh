#!/usr/bin/env bash
# First-login bootstrap on a freshly provisioned VM (either profile).
# Injects the two runtime secrets and starts Keel. Run as the admin user.
set -euo pipefail
cd "$(dirname "$0")/../.."
AGENT_ROOT="$(pwd)"
FLAGS="$AGENT_ROOT/.provision-flags"
ENV=infra/docker/keel.env
[ -f "$ENV" ] && { echo "ABORT: $ENV exists -- already bootstrapped (delete to redo)"; exit 1; }
sudo docker image inspect keel:latest >/dev/null 2>&1 || { echo "image missing -- building"; ./infra/scripts/build-image.sh; }
# Runtime secrets: fetch from the per-agent Key Vault via the VM's managed identity
# when the vault is provisioned + seeded (fire-and-forget, no prompts). Fall back to
# the interactive path PER SECRET if the vault is absent or a secret isn't seeded yet,
# so a vault-less or half-seeded box still bootstraps. TOTP is seed-time (fetched), not
# generated, so it stays stable across reboots; generating is only the fallback.
VAULT_OK=0
if [ -f "$FLAGS" ]; then
  # shellcheck disable=SC1090
  . "$FLAGS"
  if [ -n "${KEY_VAULT_NAME:-}" ] && [ -n "${MSI_CLIENT_ID:-}" ] && [ -f "$AGENT_ROOT/scripts/fetch-secret.sh" ]; then
    # shellcheck disable=SC1091
    . "$AGENT_ROOT/scripts/fetch-secret.sh"
    if fetch_secret_init; then VAULT_OK=1; echo "vault=$KEY_VAULT_NAME (managed-identity fetch)"; fi
  fi
fi

if [ "$VAULT_OK" = 1 ] && SECRET="$(kv_get totp-secret)"; then
  echo "TOTP secret: fetched from vault"
else
  echo "== TOTP enrollment (generating -- no seeded totp-secret) =="
  SECRET="$(./infra/scripts/gen-totp.sh)"
fi
if [ "$VAULT_OK" = 1 ] && APIKEY="$(kv_get anthropic-api-key)"; then
  echo "ANTHROPIC_API_KEY: fetched from vault"
else
  echo "== Anthropic API key (input hidden) =="
  read -rs -p "ANTHROPIC_API_KEY: " APIKEY; echo
fi
if [ "$VAULT_OK" = 1 ] && ORKEY="$(kv_get openrouter-api-key)"; then
  echo "OPENROUTER_API_KEY: fetched from vault"
else
  echo "== OpenRouter API key (input hidden) =="
  read -rs -p "OPENROUTER_API_KEY (must start with sk-or-): " ORKEY; echo
fi
case "$ORKEY" in
  sk-or-*) : ;;
  "") echo "ABORT: OPENROUTER_API_KEY empty -- the gateway needs it to route. Nothing written."; exit 1 ;;
  *) echo "ABORT: OPENROUTER_API_KEY must start with sk-or- (got a placeholder or wrong key). Nothing written."; exit 1 ;;
esac
umask 177
printf 'TOTP_SECRET=%s\nANTHROPIC_API_KEY=%s\nOPENROUTER_API_KEY=%s\nANTHROPIC_BASE_URL=http://gateway:4000\n' "$SECRET" "$APIKEY" "$ORKEY" > "$ENV"
umask 022
# regenerate the LiteLLM gateway config from system/model-routing.yaml so the
# bind-mounted ./litellm has the current 6-model table (fall back to committed).
GATEWAY_CFG=infra/docker/litellm/openrouter.yaml
if sudo docker run --rm -w /app -e AGENT_ROOT=/app keel:latest \
     node scripts/model-routing.js gateway-config > "${GATEWAY_CFG}.tmp" 2>/dev/null && [ -s "${GATEWAY_CFG}.tmp" ]; then
  mv "${GATEWAY_CFG}.tmp" "$GATEWAY_CFG"; echo "gateway config regenerated -> $GATEWAY_CFG"
else
  rm -f "${GATEWAY_CFG}.tmp"; [ -s "$GATEWAY_CFG" ] || { echo "ABORT: gateway-config regen failed and no committed openrouter.yaml"; exit 1; }
  echo "WARNING: gateway-config regen failed -- using committed $GATEWAY_CFG"
fi
# Publish address: tailnet IP when joined; loopback otherwise (reach via SSH tunnel).
ADDR=127.0.0.1
command -v tailscale >/dev/null 2>&1 && { ADDR="$(tailscale ip -4 2>/dev/null | head -1)" || ADDR=127.0.0.1; }
[ -n "$ADDR" ] || ADDR=127.0.0.1
echo "publishing webchat on ${ADDR}:8443"
sudo env KEEL_PUBLISH_ADDR="$ADDR" docker compose -f infra/docker/compose.yaml --profile gateway up -d
./infra/scripts/smoke-test.sh keel-webchat "http://${ADDR}:8443"
echo "bootstrap complete -- webchat: http://${ADDR}:8443"
