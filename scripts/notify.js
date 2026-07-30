#!/usr/bin/env node
/**
 * notify.js — operator notification helper.
 *
 * Sends a short message to whichever operator channels are ENABLED: Telegram
 * and/or Resend email. Each is gated on its capability (state/capabilities.json)
 * and its secrets are fetched at runtime from Key Vault via the managed-identity
 * helper — never from disk. If a channel is declined or unconfigured it is
 * skipped, not attempted. If nothing is enabled, this is a clean no-op.
 *
 * The scheduled jobs (health-check, digest) call this best-effort, so it NEVER
 * throws into the caller — every failure is caught and reported in the result.
 *
 * Usage:  node scripts/notify.js <topic> <message>
 *         node scripts/notify.js digest "3 overdue, 1 needs vision"
 *
 * The HTTP layer is injectable (fetchImpl) so the dispatch and payloads are
 * unit-testable without network; production uses global fetch.
 */

const path = require('path');
const { execFileSync } = require('child_process');

const AGENT_ROOT = process.env.AGENT_ROOT || path.dirname(__dirname);
const AGENT_LABEL = process.env.AGENT_NAME || 'Agent';
const AGENT_SLUG = (process.env.AGENT_NAME || 'agent').toLowerCase();
const FETCH_SECRET = process.env.FETCH_SECRET || '/opt/twin-bootstrap/fetch-secret.sh';

let capability;
try { capability = require('./capability'); } catch { capability = null; }

function capEnabled(id) {
  if (!capability) return false;
  try { return capability.status(id) === 'enabled'; } catch { return false; }
}

// Fetch a secret value via the managed-identity helper. Returns null if the
// helper is absent (e.g. off-VM) or the secret does not resolve. Never throws.
function getSecret(name) {
  try {
    const fs = require('fs');
    if (!fs.existsSync(FETCH_SECRET)) return null;
    const out = execFileSync(FETCH_SECRET, [name], { encoding: 'utf8', timeout: 20000 });
    const v = out.trim();
    return v.length ? v : null;
  } catch { return null; }
}

async function sendTelegram(text, deps) {
  if (!capEnabled('telegram')) return { channel: 'telegram', status: 'skipped', reason: 'not enabled' };
  const token = deps.getSecret('telegram-bot-token');
  const chat = deps.getSecret('telegram-chat-id');
  if (!token || !chat) return { channel: 'telegram', status: 'skipped', reason: 'secret unresolved' };
  try {
    const res = await deps.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
    return { channel: 'telegram', status: res.ok ? 'sent' : 'failed', code: res.status };
  } catch (e) { return { channel: 'telegram', status: 'failed', reason: (e.message || '').slice(0, 80) }; }
}

async function sendResend(subject, text, deps) {
  if (!capEnabled('resend')) return { channel: 'resend', status: 'skipped', reason: 'not enabled' };
  const key = deps.getSecret('resend-api-key');
  const to = deps.getSecret('review-email-address');
  if (!key || !to) return { channel: 'resend', status: 'skipped', reason: 'secret unresolved' };
  try {
    // Recipient is exactly the operator review address — the only permitted
    // recipient. The from-address uses the same review domain.
    const from = process.env.RESEND_FROM || `${AGENT_SLUG}@${(to.split('@')[1] || 'localhost')}`;
    const res = await deps.fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    return { channel: 'resend', status: res.ok ? 'sent' : 'failed', code: res.status };
  } catch (e) { return { channel: 'resend', status: 'failed', reason: (e.message || '').slice(0, 80) }; }
}

// Dispatch to all enabled channels. Never throws.
async function notify(topic, message, injected) {
  const deps = {
    fetch: (injected && injected.fetch) || globalThis.fetch,
    getSecret: (injected && injected.getSecret) || getSecret,
  };
  const subject = `[${AGENT_LABEL}] ${topic}`;
  const body = `${topic}: ${message}`;
  const results = [];
  results.push(await sendTelegram(body, deps));
  results.push(await sendResend(subject, message, deps));
  const sent = results.filter(r => r.status === 'sent').map(r => r.channel);
  return { topic, sent, results };
}

if (require.main === module) {
  const [topic, ...rest] = process.argv.slice(2);
  const message = rest.join(' ');
  if (!topic || !message) { console.error('usage: notify.js <topic> <message>'); process.exit(1); }
  notify(topic, message).then(r => {
    if (r.sent.length) console.log('notify: sent via ' + r.sent.join(', '));
    else console.log('notify: no enabled channel sent (' + r.results.map(x => `${x.channel}=${x.status}`).join(', ') + ')');
  }).catch(e => { console.error('notify: ' + e.message); /* best-effort: do not fail the caller */ process.exit(0); });
}

module.exports = { notify, sendTelegram, sendResend, capEnabled };
