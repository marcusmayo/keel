#!/usr/bin/env bash
# First-login bootstrap on a freshly provisioned VM (either profile).
# Injects the two runtime secrets and starts Keel. Run as the admin user.
set -euo pipefail
cd "$(dirname "$0")/../.."
ENV=infra/docker/keel.env
[ -f "$ENV" ] && { echo "ABORT: $ENV exists -- already bootstrapped (delete to redo)"; exit 1; }
sudo docker image inspect keel:latest >/dev/null 2>&1 || { echo "image missing -- building"; ./infra/scripts/build-image.sh; }
echo "== TOTP enrollment =="
SECRET="$(./infra/scripts/gen-totp.sh)"
echo "== Anthropic API key (input hidden) =="
read -rs -p "ANTHROPIC_API_KEY: " APIKEY; echo
echo "== OpenRouter API key (input hidden) =="
read -rs -p "OPENROUTER_API_KEY (must start with sk-or-): " ORKEY; echo
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
