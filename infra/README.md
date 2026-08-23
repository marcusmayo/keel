# Keel — Deployment

Keel runs as a pinned, hash-verified container. Two deployment profiles share
one image and one cloud-init core:

- **self-contained** — Docker Compose on your own hardware. No cloud, no
  tailnet. The public quickstart. Sole external dependency: `api.anthropic.com`
  (or a configured gateway; see Models).
- **cloud (Bicep)** — an Azure VM on *your* (or an employer's) subscription.
  No public IP on either profile.

## Prerequisites
- Docker Engine + Compose v2 (self-contained), or Azure CLI with Bicep (cloud).
- An Anthropic API key (or a gateway endpoint — see Models).
- `knowledge/people/` populated with your own stakeholders (names live in data,
  never in code); edit `system/operator-profile.yaml` and
  `system/voice-profile.yaml` — both ship as `<placeholder>` templates.
- Set `SOURCE_KEY_PREFIX` in `keel.config.json` to your tracker's key prefix
  (e.g. `PROJ`); leave empty to disable embedded-key scanning.

## Quickstart — self-contained
```bash
./infra/scripts/build-image.sh        # hash-verified build (see Supply chain)
./infra/scripts/bootstrap.sh          # model keys -> keel.env -> up
```
Webchat serves on `127.0.0.1:8443` (no app login; Cloudflare Access is the
factor in front of it). `bootstrap.sh` publishes on
the tailnet IP automatically if Tailscale is present, loopback otherwise.

## Quickstart — cloud (Bicep)
Deploy submits from a machine with the Azure CLI; the VM builds the image
itself via cloud-init, then you bootstrap over the network.
```bash
export KEEL_SSH_PUBKEY="$(cat ~/.ssh/id_ed25519.pub)"
# personal (tailnet):
export TAILSCALE_AUTH_KEY=tskey-...        # single-use, ~1h, ephemeral=no
./infra/scripts/deploy.sh personal
# employer (no tailnet; reachable from a private CIDR):
export KEEL_SSH_CIDR=10.0.0.0/8            # and DO NOT set TAILSCALE_AUTH_KEY
./infra/scripts/deploy.sh employer
```
`deploy.sh` enforces the profile boundary before submitting: personal requires
the auth key; employer **aborts if the auth key is set at all** — an employer
VM never joins a personal tailnet. After provisioning, SSH in (tailnet or
`deploy.sh` prints nothing reachable by itself: for the personal profile the VM joins your tailnet as `keel-vm` (MagicDNS: `ssh <admin>@keel-vm`; the name must be free -- decommission or rename any existing node first). Employer profile: SSH from the allowed CIDR. Then tail
`infra/scripts/bootstrap.sh`.

## Profiles at a glance
| | self-contained | personal (tailnet) | employer |
|---|---|---|---|
| launcher | Compose | Bicep | Bicep |
| network | host-only | tailnet, 0 inbound | private CIDR, SSH only |
| public IP | none | none | none |
| Tailscale | no | yes | **never** |

## Models - using a provider other than Anthropic

The harness is `claude -p`, so the endpoint moves without touching a single tool
or skill. Three paths:

- **Anthropic direct** (default): a real key in `ANTHROPIC_API_KEY`; optionally
  set `ANTHROPIC_MODEL`.
- **Bedrock / Vertex**: the CLI's own env switches (employer-hosted Claude).
- **Anything else** (OpenAI, Gemini, Azure OpenAI, local Ollama): run the
  optional LiteLLM gateway. Keel keeps speaking the Anthropic Messages API; the
  gateway translates.

### Verified providers

| Provider | Model tested | `claude -p` result |
|---|---|---|
| Google Gemini | `gemini-flash-latest` | works, coherent |
| OpenAI | `gpt-5` | works, coherent |
| OpenAI | `gpt-4.1` | **400** - `reasoning.effort` unsupported |
| Ollama (local) | `deepseek-r1:1.5b` | routes + answers, output incoherent |
| Ollama (local) | `llama3.1:8b` | **error** - "does not support thinking" |

**The far-end model must be reasoning-capable.** `claude -p` always sends
thinking/reasoning parameters. Non-reasoning models reject the request, and it
cannot be stripped gateway-side (`drop_params` / `additional_drop_params` do not
cover it). This is a property of the CLI, not a Keel setting.

**There is also a capability floor.** A 1.5B local model accepts the request and
replies fluently - with content unrelated to the prompt. Small local models
prove the plumbing; they do not run the skills. Use a frontier model for work.

### Keys: what you need, where it comes from

| Variable | What it is | Source |
|---|---|---|
| `LITELLM_MASTER_KEY` | password protecting *your* gateway | **you invent it**: `sk-$(openssl rand -hex 24)`. Nobody issues it. |
| `ANTHROPIC_API_KEY` | in gateway mode, **the master key above** | same value - `claude -p` authenticates to the *gateway*, not to Anthropic. Your Anthropic key is unused. |
| `GEMINI_API_KEY` | real Google credential | https://aistudio.google.com -> "Get API key" (free tier available) |
| `OPENAI_API_KEY` | real OpenAI credential | https://platform.openai.com/api-keys |
| - | Ollama | no key, no account |

LiteLLM itself is free, self-hosted, and requires no account or license.

### Selecting a model

Two files, one variable:

1. `LITELLM_CONFIG` in `keel.env` picks the provider config from
   `infra/docker/litellm/` - `gemini.yaml`, `openai.yaml`, or `ollama.yaml`.
2. Inside that file, `model_list` maps the name `claude -p` asks for onto the
   model that actually serves it:

    model_list:
      - model_name: claude-sonnet-4-5      # what claude -p requests
        litellm_params:
          model: openai/gpt-5              # what actually answers
          api_key: os.environ/OPENAI_API_KEY

Change the `model:` line to change models; add a `model_list` entry to add one.

A complete `keel.env` for OpenAI:

    ANTHROPIC_BASE_URL=http://gateway:4000
    ANTHROPIC_API_KEY=sk-<same value as LITELLM_MASTER_KEY>
    LITELLM_MASTER_KEY=sk-<invent this>
    LITELLM_CONFIG=openai.yaml
    OPENAI_API_KEY=sk-proj-...

Then:

    docker compose -f infra/docker/compose.yaml --profile gateway up -d --force-recreate gateway
    ./infra/scripts/verify-gateway.sh

`infra/docker/.env` is a symlink to `keel.env`. Compose reads `LITELLM_CONFIG`
at *parse* time, not from `env_file:` - without the symlink the setting is
silently ignored and you get the default config. Keep the symlink.

### Verifying which model you are actually using

**Do not ask the model.** Every model answers "I am Claude, built by Anthropic"
- the CLI's system prompt says so. Gemini and GPT-5 both claimed it while
demonstrably serving from Google and OpenAI.

**Do not trust response cost.** A reasoning model can price a short call at
0.0, which is indistinguishable from a free local model.

Ground truth is the proxy's routing table:

    $ ./infra/scripts/verify-gateway.sh
    == routing table (from the running proxy) ==
      claude-sonnet-4-5   -> openai/gpt-5
    == live call (must return content, not just 200) ==
      response: OK
    ROUTING VERIFIED: upstream provider(s) = openai

### Known gotchas

- **New Gemini keys cannot reach the 2.5 generation**: `gemini-2.5-pro` returns
  quota `limit: 0` (paid-only), `gemini-2.5-flash` returns 404 "no longer
  available to new users". The shipped config uses `-latest` aliases, which
  track Google's current generation without the churn of `-preview` IDs.
- **Ollama must bind non-loopback**: `OLLAMA_HOST=0.0.0.0`, or the container
  cannot reach it. The gateway service already sets
  `extra_hosts: host.docker.internal:host-gateway`, which Linux does not
  provide by default.

## Supply chain
`infra/versions.lock` pins every install; regenerate with
`infra/scripts/gen-versions-lock.py` (derives hashes live from nodejs.org,
PyPI, npm, dpkg, and the base-image digest). The build fails loud on any hash
mismatch: digest-pinned base image, SHA256-verified Node tarball,
`pip install --require-hashes`, `npm ci`. No `latest`, no unpinned installs.
The LiteLLM gateway must clear this same bar (pinned + hash-verified, advisories
reviewed) before its module is written.

## Testing (T0–T3)
`infra/scripts/smoke-test.sh` is one gate shared across all four: versions
match the lock, container healthy, webchat answering, zero employer residue,
state writable.
- **T0** image build + smoke on any host (scratch state).
- **T1** Compose on your own hardware (self-contained path).
- **T2** throwaway employer-profile Bicep deploy (`KEEL_SSH_CIDR=<you>/32`),
  smoke over SSH, `az group delete`.
- **T3** personal-tailnet deploy — the production provision.

## Fresh repo
`infra/scripts/seed-fresh-repo.sh` births the public `keel` repo from a private
build repo: whitelist copy (tracked code only — no data, no history, no
secrets), config flip to empty prefix, Apache-2.0, and a residue gate that
fails on any name from `knowledge/people/`, employer term, tailnet IP, or
secret shape.
