# Keel

Keel is a deterministic-first portfolio management agent. It reconciles work
items from external sources — Jira exports, backlog spreadsheets, ADO dumps —
against a canonical portfolio, scores and judges the differences, and proposes
changes. It never applies them: every mutation waits for the operator. All of
the mechanical work is pure Python with no model in the loop; an LLM is
reserved for the small set of judgments that are genuinely semantic, and even
those come back as proposals with provenance attached.

Keel is one agent in a small fleet. The provisioning lane, the shared runtime
core, and the control plane live in
[`marcusmayo/fleet`](https://github.com/marcusmayo/fleet); a sibling agent with
a different domain (research intake) is
[`marcusmayo/castor`](https://github.com/marcusmayo/castor). This repository is
the keel profile: the reconciliation engine, the webchat, the skills, and the
compliance surface.

## Run it locally

The fleet runs behind Cloudflare Access — auth is enforced at the edge, and the
app rejects anything that didn't come through it. That is the right posture for
a tunnel and a locked door for a laptop, so there is an explicit local mode:

Prerequisite: Docker Desktop running (Windows/macOS) or the docker engine
(Linux). The commands below are identical on all three — PowerShell included.

```bash
git clone https://github.com/marcusmayo/keel.git
cd keel/infra/docker

# 1. configure: two keys, one loudly-labelled line
cp keel.env.example keel.env
#   set  ANTHROPIC_API_KEY=sk-ant-...      (direct mode; simplest)
#   set  TOTP_SECRET=scratch               (vestigial; any value)
#   uncomment  AUTH_MODE=local             (local development ONLY)

# 2. build + run in one command
docker compose --env-file ../versions.lock up -d --build webchat
# open http://127.0.0.1:8443
```

The `--env-file` feeds the repo's pinned versions into the image build, and
the build still FAILS if any vendored module drifts from its manifest — same
guarantee, no bash, no sudo. (The fleet's own VMs build via
`infra/scripts/build-image.sh` instead; this path is for laptops.)

`AUTH_MODE=local` disables edge authentication entirely. It is default-off,
only the literal word `local` activates it, it is read from the environment at
request time so an image can never bake it on, and every page carries a
permanent red banner saying the edge is absent. Never set it on anything
reachable from a network. Unset, the app behaves byte-identically to the
production posture — a bare request gets 403 — and a test pins that.

To route text turns through OpenRouter instead of directly to Anthropic, start
the optional gateway (`docker compose --profile gateway up -d`) and put an
`sk-or-` key in `keel.env`; the model picker then accepts any slug on the
routing table. Web-research turns always run on a direct Anthropic model,
because real server-side web search only exists there.

## What deterministic-first means

The engine — vendored at `vendor/keel_core/` — is ordinary, testable Python
with five verbs: `normalize`, `reconcile`, `score`, `judge`, `export`. Parsing,
matching, arithmetic, spreadsheet round-trips: all deterministic, all
reproducible, none of it asks a model anything. The LLM enters only where the
question is semantic — "are these two differently-worded items the same work?" —
and its answer comes back labelled as a proposal, never as an applied change.

Three rules follow from that and hold everywhere:

- **Propose, don't mutate.** Every change the system derives is staged as
  PROPOSED and applied only on explicit operator action. This includes edits
  the engine is certain about.
- **Provenance at decision time.** A proposal carries the source rows, the
  rule or prompt that produced it, and the timestamp — attached when the
  decision is made, not reconstructed later.
- **Instrument before theorize.** When something looks wrong, the tooling
  reads the real bytes before anyone patches anything. The audit chain exists
  so that question is answerable.

## Architecture

Two containers, and a literal split between code and state:

- **`keel-webchat`** — the agent: Node webchat, the skills router, the engine,
  the Claude Code CLI for model turns. The image is the code; six named
  volumes are the state (`state/`, `knowledge/`, `logs/`, `support/`,
  `exports/`, and the CLI's session store, which is what gives the agent
  multi-turn memory across restarts).
- **`keel-gateway`** *(optional profile)* — LiteLLM, digest-pinned official
  image, mapping the model table to OpenRouter. No host port; only the webchat
  can reach it.

Model routing is one YAML table. The picker accepts any slug on it; web-ON
turns bypass the gateway for the selected model's direct-Anthropic equivalent
and return to it when web turns off — the pre-web model is captured and
restored server-side, so the toggle behaves the same from every surface.

**Drift is a build failure, twice.** Shared runtime code is vendored from the
fleet's `core/` with a SHA-256 manifest, and `verify-core.sh` runs inside the
Dockerfile — a modified vendored file fails the image build. The engine gets
the same treatment separately: `verify-keel-core.sh` hashes `vendor/keel_core/`
against its own stamp. Nothing shared can drift silently in either direction.

## Governance: Can't over Shouldn't

The framework this fleet is built on prefers structural guarantees to
behavioral rules: where possible, make the unwanted thing *impossible* rather
than *discouraged*. Concretely, in this repository:

- **Web access is a structural toggle, default OFF.** When off, the web tools
  are denied at spawn (`--disallowedTools`) — the agent doesn't promise not to
  browse; it can't.
- **Destructive lanes are attested.** A backup restore is a merge by default —
  nothing written since the snapshot is ever silently deleted. The true rewind
  exists behind an exact typed phrase, verifies the archive is readable before
  it wipes anything, and refuses before a single cloud call if the phrase is
  wrong.
- **The audit chain is hash-linked.** Every operator action and agent turn is
  a record with provenance; `/run-audit-verify` re-walks the chain. Failures
  ledger as failures — a control that half-applied says `incomplete:` and
  exits non-zero, because a green light that means "probably" is worse than a
  red one.
- **The compliance board reads evidence, not intentions.** Network ingress,
  edge auth, backup wiring, secrets hygiene, vulnerability posture, and a
  weekly PII scan — each check reads the live system. The scan's findings are
  recorded, not obeyed: a run that finds things still succeeds and writes what
  it found, so the signal stays meaningful.

## Operating it

Day to day the agent is driven through its webchat (or Telegram, via the
fleet's control plane). Operator skills are HTTP routes with a uniform shape —
among them `/run-normalize`, `/run-reconcile`, `/run-score-all`, `/run-merge`,
`/run-apply` (the one that mutates, on explicit call), `/run-audit-verify`, and
`/run-scan-tree`. `/queue` shows staged intake; processing is always a separate
operator decision from arrival.

Fleet operations — provisioning, rebuilds, backups, intake from anywhere,
policy — run from [`marcusmayo/fleet`](https://github.com/marcusmayo/fleet)'s
`fleetctl`: `up` a contract, `rebuild` at an asserted HEAD, `backup snapshot` /
`restore` (merge) / `restore --clean` (attested rewind), `intake put` to drop
files into the agent's staging from the desk. None of that is required to run
this repository locally.

## Repository map

```
scripts/          fleet-core vendored runtime (hash-manifested) + profile scripts
gate/             ingress/egress gates, tripwire, audit verify (vendored subset)
vendor/keel_core/ the deterministic engine, separately hash-stamped
webchat/          server + chat UI
system/           agent.yaml, skills.yaml, model-routing.yaml, compliance-controls.yaml
infra/            Dockerfile, compose, Bicep for the Azure path, bootstrap scripts
tests/            engine + behavior tests (fixtures use canonical fake data)
```

## Status

Live, small, and deliberately boring where boring is a feature. The interesting
parts are the guarantees: builds that fail on drift, restores that say which of
two things they are, an audit trail that can be re-verified, and a model kept
on a leash short enough to see.
