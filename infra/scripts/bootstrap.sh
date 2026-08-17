#!/usr/bin/env bash
# First-login bootstrap on a freshly provisioned VM (either profile).
# Injects the two runtime secrets and starts Keel. Run as the admin user.
set -euo pipefail
die(){ printf 'ABORT: %s\n' "$*" >&2; exit 1; }
cd "$(dirname "$0")/../.."
AGENT_ROOT="$(pwd)"
FLAGS="$AGENT_ROOT/.provision-flags"
ENV=infra/docker/keel.env
# Resume, never refuse. An existing env means an earlier run got this far; secrets are re-fetched
# from the vault (a rotation lands on any re-run) and the file rewritten; only when the vault
# cannot answer and there is no terminal does the existing env stand in for a missing secret.
# The old rule ("exists -- already bootstrapped, delete to redo") made the self-heal retry mean
# a different thing here than on the other profile; the retry timer had to delete the file to
# get past it. Idempotent by construction now, on both profiles: fetch, write, generate, up.
RESUME=0
[ -f "$ENV" ] && { RESUME=1; echo "$ENV exists -- resuming (secrets re-fetched, nothing refused)"; }
env_get(){ [ "$RESUME" = 1 ] && sed -n "s/^$1=//p" "$ENV" 2>/dev/null | head -n 1 || true; }
sudo docker image inspect keel:latest >/dev/null 2>&1 || { echo "image missing -- building"; ./infra/scripts/build-image.sh; }
# Runtime secrets: fetch from the per-agent Key Vault via the VM's managed identity
# when the vault is provisioned + seeded (fire-and-forget, no prompts). Fall back to
# the interactive path PER SECRET if the vault is absent or a secret isn't seeded yet,
# so a vault-less or half-seeded box still bootstraps. app-TOTP is removed (edge auth), not
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

# vault_get_or_wait <name>: print a seeded secret from the vault.
#   * vault reachable + secret present      -> prints it (rc 0)
#   * NO terminal (cloud-init) + not seeded  -> LOUDLY waits on the serial console for
#       `set-secrets`, up to 10 min, then aborts NAMING the secret (never prompts)
#   * a terminal (operator SSH) + not seeded, OR no vault at all -> rc 3, so the caller
#       falls back interactively (prompt for keys), naming the secret
vault_get_or_wait() {
  local name="$1" val rc waited=0
  [ "$VAULT_OK" = 1 ] || return 3
  while :; do
    val="$(kv_get "$name")"; rc=$?
    [ "$rc" = 0 ] && { printf '%s' "$val"; return 0; }
    [ "$rc" != 3 ] && return "$rc"          # hard vault error (kv_get already retried inside)
    [ -t 0 ] && return 3                      # interactive + not seeded -> caller falls back
    if [ "$waited" -ge 600 ]; then
      die "secret '$name' was never seeded (waited 10 min). From the workstation run: fleetctl set-secrets <this-agent>  then reboot the VM -- or SSH in and run this script to paste it by hand."
    fi
    echo ">> WAITING FOR SECRET '$name' -- not in the vault yet. Seed it now:  fleetctl set-secrets <this-agent>   (${waited}s / 600s)" >&2
    sleep 20; waited=$((waited + 20))
  done
}

# App-TOTP removed (edge-only auth migration): Cloudflare Access is the gate; nothing to fetch.
# ANTHROPIC_API_KEY -- interactive fallback prompts, naming the secret loudly.
if APIKEY="$(vault_get_or_wait anthropic-api-key)"; then
  echo "ANTHROPIC_API_KEY: fetched from vault"
elif [ -t 0 ]; then
  echo ""
  echo ">> SECRET NEEDED: 'anthropic-api-key' is not in the vault. Paste it now, or Ctrl-C and seed it:  fleetctl set-secrets <this-agent>"
  read -rs -p "ANTHROPIC_API_KEY: " APIKEY; echo
elif APIKEY="$(env_get ANTHROPIC_API_KEY)" && [ -n "$APIKEY" ]; then
  echo "ANTHROPIC_API_KEY: kept from the existing $ENV (vault unreachable, no terminal)"
else
  die "cannot obtain 'anthropic-api-key' -- no vault, no terminal to prompt, no earlier env to resume from."
fi
# OPENROUTER_API_KEY -- same; validated below regardless of source.
if ORKEY="$(vault_get_or_wait openrouter-api-key)"; then
  echo "OPENROUTER_API_KEY: fetched from vault"
elif [ -t 0 ]; then
  echo ""
  echo ">> SECRET NEEDED: 'openrouter-api-key' is not in the vault. Paste it now, or Ctrl-C and seed it:  fleetctl set-secrets <this-agent>"
  read -rs -p "OPENROUTER_API_KEY (must start with sk-or-): " ORKEY; echo
elif ORKEY="$(env_get OPENROUTER_API_KEY)" && [ -n "$ORKEY" ]; then
  echo "OPENROUTER_API_KEY: kept from the existing $ENV (vault unreachable, no terminal)"
else
  ORKEY=""
fi
case "$ORKEY" in
  sk-or-*) : ;;
  "") echo "ABORT: OPENROUTER_API_KEY empty -- the gateway needs it to route. Nothing written."; exit 1 ;;
  *) echo "ABORT: OPENROUTER_API_KEY must start with sk-or- (got a placeholder or wrong key). Nothing written."; exit 1 ;;
esac
umask 177
printf 'ANTHROPIC_API_KEY=%s\nOPENROUTER_API_KEY=%s\nANTHROPIC_BASE_URL=http://gateway:4000\n' "$APIKEY" "$ORKEY" > "$ENV"
umask 022
# Generate the LiteLLM gateway config from system/model-routing.yaml into an UNTRACKED file the
# gateway mounts (openrouter.generated.yaml, gitignored); the committed openrouter.yaml beside it
# is the baseline copied in when generation fails. It used to be written over the tracked file,
# which left the checkout dirty and made a pull that touched it conflict on the VM.
# Generated by the webchat service's OWN runtime (compose run: same image, same environment, same
# NODE_PATH), never by a bare `docker run` -- that path could not resolve js-yaml and fell back to
# the committed baseline on every boot, silently (stderr went to /dev/null): the gateway ran a
# six-model table without provider.data_collection: deny while the panel offered eight. A failure
# now prints the generator's own words before the fallback.
GATEWAY_SRC=infra/docker/litellm/openrouter.yaml
GATEWAY_CFG=infra/docker/litellm/openrouter.generated.yaml
GEN_ERR="${GATEWAY_CFG}.err"
if sudo docker compose -f infra/docker/compose.yaml run --rm --no-deps -T webchat \
     node scripts/model-routing.js gateway-config > "${GATEWAY_CFG}.tmp" 2>"$GEN_ERR" && [ -s "${GATEWAY_CFG}.tmp" ]; then
  mv "${GATEWAY_CFG}.tmp" "$GATEWAY_CFG"; rm -f "$GEN_ERR"; echo "gateway config generated -> $GATEWAY_CFG ($(grep -c 'model_name' "$GATEWAY_CFG") models)"
else
  rm -f "${GATEWAY_CFG}.tmp"
  echo "WARNING: gateway-config generation FAILED:"; tail -n 4 "$GEN_ERR" 2>/dev/null | sed 's/^/    /'; rm -f "$GEN_ERR"
  [ -s "$GATEWAY_SRC" ] || { echo "ABORT: and no committed $GATEWAY_SRC to fall back to"; exit 1; }
  cp "$GATEWAY_SRC" "$GATEWAY_CFG"; echo "WARNING: using the committed baseline $GATEWAY_SRC -> $GATEWAY_CFG ($(grep -c 'model_name' "$GATEWAY_CFG") models) -- fix the generator, then re-run bootstrap"
fi
# Publish address: tailnet IP when joined; loopback otherwise (reach via SSH tunnel).
ADDR=127.0.0.1
command -v tailscale >/dev/null 2>&1 && { ADDR="$(tailscale ip -4 2>/dev/null | head -1)" || ADDR=127.0.0.1; }
[ -n "$ADDR" ] || ADDR=127.0.0.1
echo "publishing webchat on ${ADDR}:8443"
sudo env KEEL_PUBLISH_ADDR="$ADDR" docker compose -f infra/docker/compose.yaml --profile gateway up -d
./infra/scripts/smoke-test.sh keel-webchat "http://${ADDR}:8443"
echo "bootstrap complete -- webchat: http://${ADDR}:8443"
