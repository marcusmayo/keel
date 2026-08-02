/**
 * model-routing.js -- tier resolver, change CLI, and gateway-config generator.
 *
 * system/model-routing.yaml is the single source of truth for model routing.
 * This module resolves a tier to the model_name that `claude -p` requests,
 * regenerates the LiteLLM gateway config from the same file (so the gateway can
 * never drift from policy), and lets the operator change a model with one
 * command instead of editing YAML by hand.
 *
 * The file is read at call time, so a change takes effect on the next
 * invocation -- no restart, no code change.
 *
 * CLI:
 *   node scripts/model-routing.js resolve <tier>        -> model_name for --model
 *   node scripts/model-routing.js list                  -> current mapping
 *   node scripts/model-routing.js gateway-config        -> LiteLLM openrouter.yaml
 *   node scripts/model-routing.js set <tier> --slug openrouter/<v>/<m> [--name <model_name>]
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const AGENT_ROOT = process.env.AGENT_ROOT || path.dirname(__dirname);
// Image default (baked, read-only) vs writable state copy (a volume, persists
// across restarts). A `set` writes the state copy; reads prefer it so an
// operator's model change survives a container restart. On a fresh deploy the
// state copy does not exist yet, so reads fall back to the image default.
const ROUTING_DEFAULT = process.env.MODEL_ROUTING || path.join(AGENT_ROOT, 'system', 'model-routing.yaml');
const ROUTING_STATE = process.env.MODEL_ROUTING_STATE || path.join(AGENT_ROOT, 'state', 'model-routing.yaml');
// The LiteLLM gateway config regenerated after a change (mounted, read-write).
const GATEWAY_CONFIG = process.env.GATEWAY_CONFIG_PATH || path.join(AGENT_ROOT, 'infra', 'docker', 'litellm', 'openrouter.yaml');
function readPath() { return fs.existsSync(ROUTING_STATE) ? ROUTING_STATE : ROUTING_DEFAULT; }
const ROUTING = ROUTING_STATE; // back-compat export

const HEADER = `# Model routing -- tier -> model policy, and the single source of truth for both
# the model \`claude -p\` requests (model_name) and the OpenRouter model it maps
# to (openrouter_slug).
#
# Change a model with one command, no code edit:
#   node scripts/model-routing.js set <tier> --slug openrouter/<vendor>/<model>
#
# The LiteLLM gateway config is GENERATED from this file:
#   node scripts/model-routing.js gateway-config > infra/docker/litellm/openrouter.yaml
# so the gateway can never drift from this policy. Written by the CLI on \`set\`.
`;

function load() {
  let raw;
  const src = readPath();
  try { raw = fs.readFileSync(src, 'utf8'); }
  catch (e) { throw new Error(`model-routing.yaml unreadable at ${src}: ${e.message}`); }
  const doc = yaml.load(raw);
  if (!doc || !doc.tiers || typeof doc.tiers !== 'object') {
    throw new Error('model-routing.yaml has no tiers');
  }
  return doc;
}

function save(doc) {
  const body = yaml.dump(doc, { lineWidth: 100, noRefs: true });
  fs.mkdirSync(path.dirname(ROUTING_STATE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(ROUTING_STATE, HEADER + '\n' + body, { mode: 0o644 });
}

// Regenerate the gateway config from the current routing, into the mounted
// LiteLLM config path if that directory exists. Called after a model change so
// the gateway never drifts. Returns true if written.
function regenerateGateway() {
  try {
    if (!fs.existsSync(path.dirname(GATEWAY_CONFIG))) return false;
    fs.writeFileSync(GATEWAY_CONFIG, gatewayConfig(), { mode: 0o644 });
    return true;
  } catch { return false; }
}

// Resolve a tier (or the default) to the model_name claude -p should request.
function resolve(tier) {
  const doc = load();
  const t = tier || doc.default_tier || 'routine';
  const entry = doc.tiers[t];
  if (!entry) throw new Error(`unknown tier: ${t} (have: ${Object.keys(doc.tiers).join(', ')})`);
  if (!entry.model_name) throw new Error(`tier ${t} has no model_name`);
  return entry.model_name;
}

// Generate the LiteLLM gateway config from the routing file. Each tier's
// model_name maps to its openrouter_slug; the key is read from the environment,
// matching the Keel gateway (keyless master, OPENROUTER_API_KEY per call).
function gatewayConfig() {
  const doc = load();
  const seen = new Set();
  const model_list = [];
  for (const [tierName, t] of Object.entries(doc.tiers)) {
    if (!t.model_name || !t.openrouter_slug) continue;
    if (seen.has(t.model_name)) continue; // a name maps once even if two tiers share it
    seen.add(t.model_name);
    model_list.push({
      model_name: t.model_name,
      litellm_params: { model: t.openrouter_slug, api_key: 'os.environ/OPENROUTER_API_KEY' },
    });
  }
  const cfg = { model_list, litellm_settings: { drop_params: true } };
  const banner = '# GENERATED from system/model-routing.yaml by scripts/model-routing.js.\n' +
                 '# Do not edit by hand -- change models via: model-routing.js set <tier> --slug ...\n' +
                 '# Key = OPENROUTER_API_KEY in the service environment.\n';
  return banner + yaml.dump(cfg, { lineWidth: 100, noRefs: true });
}

function set(tier, fields) {
  const doc = load();
  if (!doc.tiers[tier]) throw new Error(`unknown tier: ${tier} (have: ${Object.keys(doc.tiers).join(', ')})`);
  if (!fields.slug && !fields.name) throw new Error('nothing to set: pass --slug and/or --name');
  if (fields.slug) doc.tiers[tier].openrouter_slug = fields.slug;
  if (fields.name) doc.tiers[tier].model_name = fields.name;
  save(doc);
  return doc.tiers[tier];
}

// Picker selection, decoupled from tier mutation. Records which model the user
// picked as a top-level `selected_slug` (NOT a tier), so the routine tier's slug
// is never overwritten and the gateway model_list (built from tiers) is unchanged.
function setSelected(slug) {
  const doc = load();
  const owner = Object.values(doc.tiers).find(t => t.openrouter_slug === slug);
  if (!owner) throw new Error(`slug not on any tier: ${slug}`);
  doc.selected_slug = slug;
  save(doc);
  return slug;
}

// The selected slug, or null if the user has not picked one.
function getSelected() {
  const doc = load();
  return doc.selected_slug || null;
}

// Resolve the effective default model_name: the user's picked slug if set
// (mapped back to its owning tier's model_name), otherwise the default tier.
function resolveSelected() {
  const doc = load();
  if (doc.selected_slug) {
    const owner = Object.values(doc.tiers).find(t => t.openrouter_slug === doc.selected_slug);
    if (owner && owner.model_name) return owner.model_name;
  }
  return resolve();
}

// Vision model for the attested-image interpret path. Direct to Anthropic,
// separate from the OpenRouter text tiers. Returns { model, api_url }.
function resolveVision() {
  const doc = load();
  const v = doc.vision || {};
  return {
    model: v.model || 'claude-sonnet-4-6',
    api_url: v.api_url || 'https://api.anthropic.com/v1/messages',
  };
}

function setVision(fields) {
  const doc = load();
  if (!fields.model && !fields.url) throw new Error('nothing to set: pass --model and/or --url');
  doc.vision = doc.vision || {};
  if (fields.model) doc.vision.model = fields.model;
  if (fields.url) doc.vision.api_url = fields.url;
  save(doc);
  return doc.vision;
}

function list() {
  const doc = load();
  const rows = [];
  for (const [name, t] of Object.entries(doc.tiers)) {
    rows.push({ tier: name, model_name: t.model_name, slug: t.openrouter_slug, default: name === doc.default_tier });
  }
  return rows;
}

function parseFlags(argv) {
  const flags = {}; const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { flags[argv[i].slice(2)] = argv[i + 1]; i++; }
    else rest.push(argv[i]);
  }
  return { flags, rest };
}

if (require.main === module) {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (cmd === 'resolve') {
      console.log(resolve(args[0]));
    } else if (cmd === 'list') {
      for (const r of list()) console.log(`${(r.tier + (r.default ? '*' : '')).padEnd(10)} ${(r.model_name || '?').padEnd(28)} -> ${r.slug || '?'}`);
      const v = resolveVision();
      console.log(`${'vision'.padEnd(10)} ${v.model.padEnd(28)} -> ${v.api_url} (direct Anthropic)`);
    } else if (cmd === 'vision') {
      const v = resolveVision();
      console.log(`vision model: ${v.model}`);
      console.log(`vision api:   ${v.api_url}`);
    } else if (cmd === 'set-vision') {
      const { flags } = parseFlags(args);
      const v = setVision({ model: flags.model, url: flags.url });
      console.log(`set vision: ${v.model} -> ${v.api_url}`);
    } else if (cmd === 'gateway-config') {
      process.stdout.write(gatewayConfig());
    } else if (cmd === 'set-selected') {
    const { flags } = parseFlags(args);
    if (!flags.slug) { console.error('usage: set-selected --slug openrouter/<v>/<m>'); process.exit(1); }
    const sel = setSelected(flags.slug);
    console.log(`selected -> ${sel}`);
  } else if (cmd === 'set') {
      const { flags, rest } = parseFlags(args);
      const tier = rest[0];
      if (!tier) { console.error('usage: set <tier> --slug openrouter/<v>/<m> [--name <model_name>]'); process.exit(1); }
      const updated = set(tier, { slug: flags.slug, name: flags.name });
      console.log(`set ${tier}: ${updated.model_name} -> ${updated.openrouter_slug}`);
      if (regenerateGateway()) console.log('gateway config regenerated -- restart the gateway container for it to take effect');
    } else {
      console.error('commands: resolve <tier> | list | gateway-config | vision | set-vision --model ... [--url ...] | set <tier> --slug ... [--name ...]');
      process.exit(1);
    }
  } catch (e) { console.error('model-routing: ' + e.message); process.exit(1); }
}

module.exports = { load, resolve, resolveVision, resolveSelected, getSelected, setSelected, setVision, gatewayConfig, regenerateGateway, set, list, ROUTING, ROUTING_STATE, ROUTING_DEFAULT };
