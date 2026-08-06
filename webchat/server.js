require('dotenv').config();
const express = require('express');
const session = require('express-session');
const auth = require('../scripts/auth.js');
const crypto = require('crypto');
const path = require('path');
const http = require('http');
const readline = require('readline');
const { WebSocketServer } = require('ws');
const { spawn, execFileSync } = require('child_process');

const multer = require('multer');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const fs = require('fs');
const yaml = require('js-yaml');

// app-TOTP removed: Cloudflare Access is the sole authenticator (edge-only).

const KEEL_DIR = process.env.KEEL_DIR || path.join(process.env.HOME, 'keel');

// Append a one-line activity entry to today's daily log (ET), per the CLAUDE.md daily-log spec.
// Best-effort: never throws into the caller, so a logging failure can't break an upload/stage/interpret.
function logDaily(line) {
  try {
    const tz = 'America/New_York';
    const now = new Date();
    // ET date (YYYY-MM-DD) - correct even near UTC midnight, and correct DST offset automatically.
    const dateParts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const hm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
    const dir = path.join(KEEL_DIR, 'state', 'daily-logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, dateParts + '.md');
    let body = '';
    try { body = fs.readFileSync(file, 'utf8'); } catch { body = ''; }
    if (!body) {
      body = '# Daily Log - ' + dateParts + '\n';
    }
    if (!/^## Actions\s*$/m.test(body)) {
      body = body.replace(/\s*$/, '') + '\n\n## Actions\n';
    }
    body = body.replace(/\s*$/, '') + '\n- ' + hm + ' ET - ' + line + '\n';
    fs.writeFileSync(file, body, { mode: 0o600 });
  } catch (e) { /* logging is best-effort */ }
}

const { checkTripwire } = require('../gate/tripwire');
const { record: auditRecord } = require('../gate/audit');
const modelRouting = require('../scripts/model-routing');
const chatSession = require('../scripts/chat-session.js');
const chatOps = require('../scripts/webchat-ops.js');


const app = express();
app.use(express.urlencoded({ extended: false, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));

const sessionParser = session({
  secret: crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', maxAge: 12 * 60 * 60 * 1000 },
});
app.use(sessionParser);

// --- shared auth contract (fleet-core: scripts/auth.js) --------------------
// requireAuth + /login + /verify + /logout + a guarded GET / are single-sourced so the
// post-Access behavior cannot diverge between agents. Aegis service token bypasses;
// a human after Cloudflare Access gets no redundant app-TOTP (standardize-on-2).
const requireAuth = auth.requireAuth;
let AGENT_NAME = 'Agent';
try {
  const _m = require('fs').readFileSync(require('path').join(require('path').dirname(__dirname), 'system', 'agent.yaml'), 'utf8').match(/^\s*agent_name:\s*["']?([^"'\n]+?)["']?\s*$/m);
  if (_m) AGENT_NAME = _m[1].trim();
} catch (e) { /* default */ }
auth.mountAuth(app, { webchatDir: __dirname, agentName: AGENT_NAME });
app.get('/health/liveliness', (req, res) => res.status(200).send('ok'));

// GET / is registered by auth.mountAuth (guarded + brand-injected)
// --- per-instance UI accent color (set via chat: /color <name|hex>) ----------
const UI_STATE = path.join(KEEL_DIR, 'state', 'ui.json');
const MODEL_STATE = path.join(KEEL_DIR, 'state', 'active-model.json');
const ACCENT_DEFAULT = '#3b82f6'; // Keel default: azure
const PALETTE = { azure:'#3b82f6', cyan:'#22d3ee', emerald:'#10b981', lime:'#84cc16', amber:'#f59e0b', rose:'#f43f5e', violet:'#8b5cf6', fuchsia:'#d946ef' };
function readAccent() {
  try { const j = JSON.parse(fs.readFileSync(UI_STATE, 'utf8')); if (j && typeof j.accent === 'string') return j.accent; } catch {}
  return ACCENT_DEFAULT;
}
app.get('/color', requireAuth, (req, res) => res.json({ ok: true, accent: readAccent(), palette: PALETTE }));
// Shared webchat control endpoints (model / model-select / web-access / persona / session)
// live in fleet-core so they can't drift between agents. /color stays here (per-agent accent).
chatOps.mountChatOps(app, { requireAuth, modelRouting, cwd: KEEL_DIR, audit: auditRecord });



app.post('/color', requireAuth, (req, res) => {
  const v = String((req.body && req.body.value) || '').trim().toLowerCase();
  const hex = PALETTE[v] || (/^#[0-9a-f]{6}$/.test(v) ? v : null);
  if (!hex) return res.json({ ok: false, error: 'unknown color', palette: PALETTE });
  try {
    fs.mkdirSync(path.dirname(UI_STATE), { recursive: true });
    fs.writeFileSync(UI_STATE, JSON.stringify({ accent: hex }) + '\n');
    res.json({ ok: true, accent: hex });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// File upload: extract to text only. No skill runs, nothing is written (A1 review-first).
const upload = multer({
  dest: '/tmp/keel-uploads/',
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB cap
});

const ALLOWED = ['.pdf', '.docx', '.xlsx', '.csv', '.txt', '.md', '.png', '.jpg', '.jpeg', '.webp', '.gif'];

app.post('/upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file received.' });
  const orig = req.file.originalname || 'file';
  const ext = (orig.slice(orig.lastIndexOf('.')) || '').toLowerCase();
  const tmpPath = req.file.path;

  // Structured-data files (CSV/XLSX) are preserved RAW for the deterministic tools.
  // Text-extraction breaks multi-line quoted CSV fields, so we bypass it entirely:
  // raw bytes go to knowledge/import/raw/ (date-stamped), tools read from there.
  if (ext === '.csv' || ext === '.xlsx') {
    // Round-trip: an edited portfolio/multi-source export (by filename) is NOT a
    // new import - stage it and dry-run the diff-apply, gate the write behind /apply-edits.
    if (ext === '.xlsx' && /^(keel-portfolio-|keel-multisource-|multisource-)/i.test(orig)) {
      let _infCount = 0;
      try {
        const _probe = execFileSync('python3', ['tools/count_inference_decisions.py', tmpPath], { cwd: KEEL_DIR, encoding: 'utf8', timeout: 30000 });
        _infCount = parseInt((_probe || '0').trim(), 10) || 0;
      } catch (e) { _infCount = 0; }
      if (_infCount > 0) {
        try {
          const stageDir = path.join(KEEL_DIR, 'exports', 'inbound');
          fs.mkdirSync(stageDir, { recursive: true });
          const staged = path.join(stageDir, 'pending-inference.xlsx');
          fs.copyFileSync(tmpPath, staged);
          fs.unlinkSync(tmpPath);
          const out = execFileSync('python3', ['tools/apply_inference_decisions.py', staged],
                                   { cwd: KEEL_DIR, encoding: 'utf8', timeout: 60000 });
          return res.json({ ok: true, filename: orig, raw: true,
            text: 'Inference decisions detected (dry-run - nothing written yet):\n\n' + out +
                  '\n\nReply /apply-inference to apply these confirm/reject decisions.' });
        } catch (e) {
          return res.json({ ok: false, output: (e.stdout || '') + (e.stderr || '') + String(e) });
        }
      }
      try {
        const stageDir = path.join(KEEL_DIR, 'exports', 'inbound');
        fs.mkdirSync(stageDir, { recursive: true });
        const staged = path.join(stageDir, 'pending-edit.xlsx');
        fs.copyFileSync(tmpPath, staged);
        fs.unlinkSync(tmpPath);
        const out = execFileSync('python3', ['tools/apply_portfolio_edits.py', staged],
                                 { cwd: KEEL_DIR, encoding: 'utf8', timeout: 60000 });
        return res.json({
          ok: true, filename: orig, raw: true,
          text: 'Portfolio edit detected (dry-run - nothing written yet):\n\n' + out +
                '\n\nReply /apply-edits to write these changes to the portfolio.'
        });
      } catch (e) {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
        return res.status(500).json({ ok: false, error: 'Edit preview failed: ' + ((e.stdout||'') + (e.stderr||'') || e.message) });
      }
    }
    try {
      const rawDir = path.join(KEEL_DIR, 'knowledge', 'import', 'raw');
      fs.mkdirSync(rawDir, { recursive: true });
      const stamp = new Date().toISOString().slice(0, 10);
      const safeName = orig.replace(/[^A-Za-z0-9._-]/g, '_');
      const rawPath = path.join(rawDir, stamp + '_' + safeName);
      fs.copyFileSync(tmpPath, rawPath);
      fs.unlinkSync(tmpPath);
      return res.json({
        ok: true,
        filename: orig,
        text: 'Saved raw to knowledge/import/raw/' + stamp + '_' + safeName +
              '\n\nReady for /normalize-jira (Jira CSV), /normalize-ado (Azure DevOps CSV), or /normalize (backlog xlsx), then /reconcile-run.',
        raw: true
      });
    } catch (e) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      return res.status(500).json({ ok: false, error: 'Raw save failed: ' + e.message });
    }
  }

  try {
    if (!ALLOWED.includes(ext)) {
      return res.status(415).json({ ok: false, error: 'Unsupported type: ' + ext + '. Allowed: ' + ALLOWED.join(', ') });
    }

    const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

    // IMAGE PATH: local OCR, tripwire check, stash image for optional diagram interpretation.
    if (IMAGE_EXTS.includes(ext)) {
      // 1. Local OCR — image never leaves the VM here.
      let ocrText = '';
      try {
        ocrText = execFileSync('tesseract', [tmpPath, 'stdout'], { encoding: 'utf8', timeout: 60000 }).trim();
      } catch (e) { ocrText = ''; }

      // 2. Tripwire on the OCR text — hard-block if a never-egress term/secret is present.
      const trip = checkTripwire(ocrText || '');
      if (trip.blocked) {
        fs.unlink(tmpPath, () => {});
        auditRecord({ action: 'IMAGE_UPLOAD', status: 'BLOCKED', rule_types: trip.hits.map(h => h.type), redaction: 'BLOCKED' });
        return res.status(200).json({ ok: true, blocked: true, filename: orig,
          notification: 'Image blocked: its text tripped the never-egress list. Nothing was sent or stored.' });
      }

      // 3. Stash the image on the VM (never-egress) with an id + hash for the interpret path.
      const buf = fs.readFileSync(tmpPath);
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      const imgId = crypto.randomBytes(8).toString('hex') + ext;
      const stashDir = path.join(__dirname, 'img-stash');
      fs.mkdirSync(stashDir, { recursive: true });
      fs.writeFileSync(path.join(stashDir, imgId), buf, { mode: 0o600 });
      fs.unlink(tmpPath, () => {});

      auditRecord({ action: 'IMAGE_UPLOAD', status: 'OK', redaction: 'OCR_LOCAL', sha256: sha });

      const display = ocrText
        ? ocrText
        : '(no text found in image — if this is a diagram, use Interpret)';
      logDaily('read image "' + orig + '" via local OCR' + (ocrText ? '' : ' (no text found)'));
      return res.json({ ok: true, filename: orig, text: '[OCR from ' + orig + ']\n\n' + display,
        isImage: true, imgId, sha256: sha, ocrEmpty: !ocrText });
    }

    let text = '';
    if (ext === '.docx') {
      const result = await mammoth.extractRawText({ path: tmpPath });
      text = result.value || '';
    } else if (ext === '.xlsx') {
      const wb = XLSX.readFile(tmpPath);
      const parts = [];
      for (const name of wb.SheetNames) {
        parts.push('### Sheet: ' + name);
        parts.push(XLSX.utils.sheet_to_csv(wb.Sheets[name]));
      }
      text = parts.join('\n');
    } else if (ext === '.csv') {
      const csv = fs.readFileSync(tmpPath, 'utf8').replace(/^\uFEFF/, '');
      const sheetName = orig.slice(0, orig.lastIndexOf('.')) || orig;
      text = '### Sheet: ' + sheetName + '\n' + csv;
    } else if (ext === '.pdf') {
      const pdfText = execFileSync('pdftotext', ['-layout', tmpPath, '-'],
                                   { encoding: 'utf8', timeout: 60000 });
      if (pdfText.trim()) {
        text = pdfText;
      } else {
        text = '[PDF extracted no text - may be a scanned/image PDF needing OCR. Original: ' + orig + ']';
      }
    } else { // .txt / .md
      text = fs.readFileSync(tmpPath, 'utf8');
    }

    text = text.trim();
    if (!text) return res.json({ ok: true, filename: orig, text: '(no extractable text found)' });

    // Guard against an enormous extraction overwhelming the input box (display copy only)
    const MAX = 100000;
    let displayText = text;
    const truncated = displayText.length > MAX;
    if (truncated) displayText = displayText.slice(0, MAX) + '\n\n[...truncated for input box, ' + (text.length - MAX) + ' more chars — full text saved to knowledge/context]';
    logDaily('extracted document "' + orig + '"');
    return res.json({ ok: true, filename: orig, text: displayText, fullText: text, truncated });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Extraction failed: ' + e.message.slice(0, 200) });
  } finally {
    fs.unlink(tmpPath, () => {}); // delete the uploaded temp file regardless
  }
});

// Portfolio export: Roadmap rollup + Portfolio detail from work-item YAMLs. Read-only, nothing mutates.
app.get('/export', requireAuth, (req, res) => {
  try {
    const stateDir = path.join(KEEL_DIR, 'state');
    const files = fs.readdirSync(stateDir).filter(f =>
      f.endsWith('.yaml') && !f.startsWith('_'));
    const items = [];
    for (const f of files) {
      try {
        const doc = yaml.load(fs.readFileSync(path.join(stateDir, f), 'utf8'));
        const w = doc && doc.workitem;
        if (w) items.push(w);
      } catch (e) { /* skip unparseable */ }
    }
    // Support lane (bugs/tasks): included in Portfolio with Store=support
    const supportDir = path.join(KEEL_DIR, 'support');
    const supportItems = [];
    if (fs.existsSync(supportDir)) {
      for (const sf of fs.readdirSync(supportDir).filter(f => f.endsWith('.yaml') && !f.startsWith('_'))) {
        try {
          const sdoc = yaml.load(fs.readFileSync(path.join(supportDir, sf), 'utf8'));
          const sw = sdoc && sdoc.workitem;
          if (sw) { sw.__store = 'support'; supportItems.push(sw); }
        } catch (e) { /* skip unparseable support file */ }
      }
    }

    // Order: epics, then their features, then those features' stories
    const byKey = {};
    items.forEach(i => { byKey[i.key] = i; });
    const ordered = [];
    const epics = items.filter(i => i.type === 'epic');
    const childrenOf = (key) => items.filter(i => i.parent === key);
    for (const ep of epics) {
      ordered.push(ep);
      for (const fe of childrenOf(ep.key).filter(i => i.type === 'feature')) {
        ordered.push(fe);
        for (const st of childrenOf(fe.key).filter(i => i.type === 'story')) ordered.push(st);
      }
      // Stories parented directly to the epic (feature is optional in the model)
      for (const st of childrenOf(ep.key).filter(i => i.type === 'story')) ordered.push(st);
    }
    // Append any orphans not reached above (flagged in Orphan column)
    const orphans = new Set();
    for (const i of items) if (!ordered.includes(i)) { orphans.add(i.key); ordered.push(i); }
    // Support items follow the portfolio block (not flagged orphan)
    for (const s of supportItems) ordered.push(s);

    const rows = ordered.map(w => {
      const pr = w.prioritization || {};
      const ov = w.priority_override || {};
      const ac = Array.isArray(w.acceptance_criteria) ? w.acceptance_criteria : [];
      return {
        Key: w.key || '',
        Ref: ((w.source || {}).ref) || '',
        Type: w.type || '',
        Parent: w.parent || '',
        Name: w.name || '',
        Status: w.status || '',
        Stage: w.stage || '',
        Size: w.size || '',
        Description: (((w.source || {}).ref) ? (w.description || '').replace(/^\s*\[\s*draft\s*[\u2014\u2013-]\s*review\s*\]\s*/i, '') : (w.description || '')),
        AcceptanceCriteria: (((w.source || {}).ref) ? ac.map(function(x){ return (typeof x === 'string') ? x.replace(/^\s*\[\s*draft\s*[\u2014\u2013-]\s*review\s*\]\s*/i, '') : x; }).join('\n') : ac.join('\n')),
        WSJF: (pr.wsjf && pr.wsjf.score) || '',
        RICE: (pr.rice && pr.rice.score) || '',
        OverrideRank: ov.rank || '',
        OverrideReason: ov.reason || '',
        Stakeholders: Array.isArray(w.stakeholders) ? w.stakeholders.join(', ') : '',
        NextAction: w.next_action || '',
        NextActionRef: w.next_action_ref || '',
        Updated: w.updated || '',
        Store: w.__store || 'state',
        Orphan: orphans.has(w.key) ? 'YES' : '',
      };
    });

    const ws = XLSX.utils.json_to_sheet(rows);
    // Column widths for readability
    ws['!cols'] = [
      {wch:8},{wch:10},{wch:8},{wch:8},{wch:32},{wch:12},{wch:12},{wch:18},{wch:50},
      {wch:60},{wch:6},{wch:6},{wch:12},{wch:30},{wch:20},{wch:30},{wch:14},{wch:12},{wch:9},{wch:8}
    ];
    // Roadmap rollup: one row per epic, descendant status rollups
    const roadmapRows = epics.map(ep => {
      const feats = childrenOf(ep.key).filter(i => i.type === 'feature');
      const desc = [];
      for (const fe of feats) {
        desc.push(fe);
        for (const st of childrenOf(fe.key).filter(i => i.type === 'story')) desc.push(st);
      }
      for (const st of childrenOf(ep.key).filter(i => i.type === 'story')) desc.push(st);
      const nStatus = (st) => desc.filter(i => (i.status || '') === st).length;
      const done = nStatus('done'), inprog = nStatus('in-progress'), backlog = nStatus('backlog');
      const pr = ep.prioritization || {};
      return {
        Key: ep.key || '',
        Epic: ep.name || '',
        Stage: ep.stage || '',
        Status: ep.status || '',
        WSJF: (pr.wsjf && pr.wsjf.score) || '',
        RICE: (pr.rice && pr.rice.score) || '',
        Features: feats.length,
        Stories: desc.length - feats.length,
        Done: done,
        InProgress: inprog,
        Backlog: backlog,
        Other: desc.length - done - inprog - backlog,
        NextAction: ep.next_action || '',
      };
    });
    const rws = XLSX.utils.json_to_sheet(roadmapRows);
    rws['!cols'] = [
      {wch:8},{wch:40},{wch:12},{wch:12},{wch:6},{wch:6},
      {wch:9},{wch:8},{wch:6},{wch:11},{wch:8},{wch:7},{wch:30}
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, rws, 'Roadmap');
    XLSX.utils.book_append_sheet(wb, ws, 'Portfolio');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const today = new Date().toISOString().slice(0,10);
    res.setHeader('Content-Disposition', 'attachment; filename="keel-portfolio-' + today + '.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Export failed: ' + e.message });
  }
});

// Stage an uploaded doc's text into the chosen inbox: context library or triage inbox.
// destination: 'context' -> knowledge/context/ (context-only) | 'triage' -> knowledge/inbox/ (pending)
app.get('/img-stash/:id', requireAuth, (req, res) => {
  // Serve a stashed image to an authenticated session only (for the attestation thumbnail).
  try {
    const raw = String(req.params.id || '');
    // Strict whitelist: 16 hex chars + a known image extension. basename strips any path traversal.
    if (!/^[a-f0-9]{16}\.(png|jpg|jpeg|webp|gif)$/i.test(raw)) {
      return res.status(400).send('bad id');
    }
    const stashDir = path.join(__dirname, 'img-stash');
    const file = path.join(stashDir, path.basename(raw));
    if (!fs.existsSync(file)) return res.status(404).send('not found');
    return res.sendFile(file);
  } catch (e) {
    return res.status(500).send('error');
  }
});

app.post('/interpret', requireAuth, async (req, res) => {
  // The ONE place raw image bytes leave the VM. Attested per-image by the operator.
  const { imgId, sha256, attestation } = req.body || {};
  try {
    const raw = String(imgId || '');
    if (!/^[a-f0-9]{16}\.(png|jpg|jpeg|webp|gif)$/i.test(raw)) {
      return res.status(400).json({ ok: false, error: 'bad imgId' });
    }
    const stashDir = path.join(__dirname, 'img-stash');
    const file = path.join(stashDir, path.basename(raw));
    if (!fs.existsSync(file)) return res.status(404).json({ ok: false, error: 'image not found in stash' });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      auditRecord({ action: 'RAW_IMAGE', status: 'FAILED', redaction: 'ATTESTED_EGRESS', sha256: sha256, reason: 'no api key' });
      return res.status(500).json({ ok: false, error: 'API key not configured' });
    }

    // Verify the bytes match the attested hash before sending (the operator confirmed THIS image).
    const buf = fs.readFileSync(file);
    const actualSha = crypto.createHash('sha256').update(buf).digest('hex');
    if (sha256 && actualSha !== sha256) {
      auditRecord({ action: 'RAW_IMAGE', status: 'BLOCKED', redaction: 'ATTESTED_EGRESS', sha256: sha256, reason: 'hash mismatch' });
      return res.status(409).json({ ok: false, error: 'image hash mismatch - not sending' });
    }

    const ext = path.extname(raw).toLowerCase();
    const mediaType = ext === '.png' ? 'image/png'
      : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg'
      : ext === '.webp' ? 'image/webp'
      : ext === '.gif' ? 'image/gif' : 'image/png';
    const b64 = buf.toString('base64');

    // Audit the egress BEFORE the call - the attempt is recorded whether or not the call returns.
    auditRecord({
      action: 'RAW_IMAGE',
      status: 'SENT',
      redaction: 'ATTESTED_EGRESS',
      model: 'claude-sonnet-4-6',
      sha256: actualSha,
      attestation: String(attestation || 'operator-confirmed'),
    });

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
            { type: 'text', text: 'Describe the structure of this diagram or image in plain text. If it shows a flow, process, hierarchy, or relationships, lay out the components and how they connect. Be concise and factual; do not invent labels that are not legible.' },
          ],
        }],
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      auditRecord({ action: 'RAW_IMAGE', status: 'API_ERROR', redaction: 'ATTESTED_EGRESS', sha256: actualSha, http: resp.status });
      return res.status(502).json({ ok: false, error: 'Vision API error ' + resp.status + ': ' + errBody.slice(0, 200) });
    }

    const data = await resp.json();
    const text = Array.isArray(data.content)
      ? data.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
      : '';
    logDaily('interpreted image via Claude vision (sha ' + actualSha.slice(0,12) + ')');
    return res.json({ ok: true, text: text || '(vision returned no text)' });
  } catch (e) {
    auditRecord({ action: 'RAW_IMAGE', status: 'ERROR', redaction: 'ATTESTED_EGRESS', sha256: sha256, reason: e.message.slice(0, 120) });
    return res.status(500).json({ ok: false, error: 'Interpret failed: ' + e.message.slice(0, 200) });
  }
});

// Generate + download the reconcile worklist as .xlsx
// Multi-source worklist: runs BOTH reconcile passes + merges -> xlsx download
// Round-trip commit: write the staged portfolio edits to YAML (operator-gated)
app.get('/run-apply-edits', requireAuth, (req, res) => {
  try {
    const staged = path.join(KEEL_DIR, 'exports', 'inbound', 'pending-edit.xlsx');
    if (!fs.existsSync(staged)) return res.json({ ok: false, output: 'no pending portfolio edit - upload an edited export first' });
    const out = execFileSync('python3', ['tools/apply_portfolio_edits.py', staged, '--commit'],
                             { cwd: KEEL_DIR, encoding: 'utf8', timeout: 60000 });
    return res.json({ ok: true, output: out });
  } catch (e) {
    return res.json({ ok: false, output: (e.stdout || '') + (e.stderr || '') + String(e) });
  }
});

app.get('/run-apply-inference', requireAuth, (req, res) => {
  try {
    const staged = path.join(KEEL_DIR, 'exports', 'inbound', 'pending-inference.xlsx');
    if (!fs.existsSync(staged)) return res.json({ ok: false, output: 'no pending inference decisions - upload an Unconfirmed sheet with Decision cells filled first' });
    const out = execFileSync('python3', ['tools/apply_inference_decisions.py', staged, '--commit'],
                             { cwd: KEEL_DIR, encoding: 'utf8', timeout: 60000 });
    return res.json({ ok: true, output: out });
  } catch (e) {
    return res.json({ ok: false, output: (e.stdout || '') + (e.stderr || '') + String(e) });
  }
});

app.get('/export-multisource', requireAuth, (req, res) => {
  try {
    execFileSync('python3', ['tools/export_multisource.py'],
                 { cwd: KEEL_DIR, encoding: 'utf8', timeout: 180000 });
    const dir = path.join(KEEL_DIR, 'exports');
    const files = fs.readdirSync(dir).filter(f => f.startsWith('multisource-') && f.endsWith('.xlsx'));
    if (!files.length) return res.status(404).json({ ok: false, output: 'no xlsx produced' });
    files.sort();
    const latest = files[files.length - 1];
    res.download(path.join(dir, latest), latest);
  } catch (e) {
    res.status(500).json({ ok: false, output: (e.stdout || '') + (e.stderr || '') + String(e) });
  }
});

app.get('/export-reconcile', requireAuth, (req, res) => {
  try {
    execFileSync('python3', ['tools/export_reconcile.py'],
                 { cwd: KEEL_DIR, encoding: 'utf8', timeout: 30000 });
    const dir = path.join(KEEL_DIR, 'exports');
    const files = fs.readdirSync(dir).filter(f => f.startsWith('reconcile-') && f.endsWith('.xlsx'));
    if (!files.length) return res.status(404).json({ ok: false, output: 'no xlsx produced' });
    files.sort();
    const latest = files[files.length - 1];
    res.download(path.join(dir, latest), latest);
  } catch (e) {
    res.status(500).json({ ok: false, output: (e.stdout || '') + (e.stderr || '') + String(e) });
  }
});

// Semantic pass over reconcile's ambiguous bucket (LLM judge - slow lane).
app.get('/run-reconcile-semantic', requireAuth, (req, res) => {
  try {
    const out = execFileSync('python3', ['tools/reconcile_semantic.py'],
                             { cwd: KEEL_DIR, encoding: 'utf8', timeout: 260000 });
    res.json({ ok: true, output: out });
  } catch (e) {
    res.json({ ok: false, output: (e.stdout || '') + (e.stderr || '') + String(e) });
  }
});

// Full Northwind E2E demo (DESTRUCTIVE to demo state; confirm-gated). README-only -- no chip.
app.get('/run-e2e', requireAuth, (req, res) => {
  if ((req.query.confirm || '') !== '1') {
    return res.json({ ok: true, output:
      'RUN-E2E -- full pipeline demo on SYNTHETIC Northwind example data.\n' +
      'DESTRUCTIVE: regenerates the demo corpus, OVERWRITES keel.config.json\n' +
      '(SOURCE_KEY_PREFIX=NWR), reseeds knowledge/import/raw/, and drafts 25 demo\n' +
      'items into state/. Do NOT run on a deployment holding real data.\n' +
      'Suggested use: run once on a FRESH deployment before loading real data.\n' +
      'Step 9 calls the LLM: ~30-60s (cloud), seconds (local GPU), several\n' +
      'minutes (local CPU). The chat will wait -- do not resend.\n\n' +
      'To proceed, type: /run-e2e confirm' });
  }
  try {
    const out = execFileSync('bash', ['run_e2e.sh', '--yes'],
                  { cwd: KEEL_DIR, encoding: 'utf8', timeout: 900000, maxBuffer: 10 * 1024 * 1024 });
    res.json({ ok: true, output: out });
  } catch (e) {
    res.json({ ok: false, output: (e.stdout || '') + (e.stderr || '') + String(e) });
  }
});

// Merge-confirm: accept/reject/distinct keel-origin merge proposals -> resolutions.json
app.get('/run-merge', requireAuth, (req, res) => {
  try {
    const action = (req.query.action || '').toString();
    if (!['accept','reject','distinct'].includes(action))
      return res.json({ ok: false, output: 'action must be accept|reject|distinct' });
    const keys = (req.query.keys || '').toString().split(/[\s,]+/).filter(Boolean);
    const out = execFileSync('python3', ['tools/merge_accept.py', action, ...keys],
                             { cwd: KEEL_DIR, encoding: 'utf8', timeout: 30000 });
    res.json({ ok: true, output: out });
  } catch (e) {
    res.json({ ok: false, output: (e.stdout || '') + (e.stderr || '') + String(e) });
  }
});

// Portfolio single-item query. ?q=<text> scored against all state/ item names.
app.get('/run-find', requireAuth, (req, res) => {
  try {
    const q = (req.query.q || '').toString();
    if (!q.trim()) return res.json({ ok: false, output: 'usage: /find <feature or idea>' });
    const out = execFileSync('python3', ['tools/find.py', q],
                             { cwd: KEEL_DIR, encoding: 'utf8', timeout: 30000 });
    res.json({ ok: true, output: out });
  } catch (e) {
    res.json({ ok: false, output: (e.stdout || '') + (e.stderr || '') + String(e) });
  }
});

// Run apply (land reconcile proposals into state/). ?commit=1 writes; else dry-run.
app.get('/run-apply', requireAuth, (req, res) => {
  try {
    const args = ['tools/apply.py'];
    if (req.query.commit === '1') args.push('--commit');
    const out = execFileSync('python3', args,
                             { cwd: KEEL_DIR, encoding: 'utf8', timeout: 60000 });
    res.json({ ok: true, output: out });
  } catch (e) {
    res.json({ ok: false, output: (e.stdout || '') + (e.stderr || '') + String(e) });
  }
});

// Batch WSJF/RICE scoring: propose scores for ~3 batches per click (score_pass resumes).
// Writes proposals to exports/score-proposals.json only; does NOT apply to item YAML.
app.get('/run-score-all', requireAuth, (req, res) => {
  try {
    const out = execFileSync('python3', ['tools/score_pass.py', '--limit', '30'],
                             { cwd: KEEL_DIR, encoding: 'utf8', timeout: 120000 });
    res.json({ ok: true, output: out });
  } catch (e) {
    res.json({ ok: false, output: (e.stdout || '') + (e.stderr || '') + String(e) });
  }
});

// Run the deterministic Jira normalizer (no LLM; pure script)
app.get('/run-normalize-jira', requireAuth, (req, res) => {
  try {
    const out = execFileSync('python3', ['tools/normalize_jira.py'],
                             { cwd: KEEL_DIR, encoding: 'utf8', timeout: 30000 });
    res.json({ ok: true, output: out });
  } catch (e) {
    res.json({ ok: false, output: (e.stdout || '') + (e.stderr || '') + String(e) });
  }
});

// Run the deterministic ADO normalizer (no LLM; pure script).
// Zero-arg: template defaults to agile; output -> state/normalized/ado.json.
// Demo seed: if no ADO CSV is present, copy the shipped example so a fresh
// clone demonstrates the lane. Touches only the gitignored import dir.
app.get('/run-normalize-ado', requireAuth, (req, res) => {
  try {
    const rawDir = path.join(KEEL_DIR, 'knowledge', 'import', 'raw');
    fs.mkdirSync(rawDir, { recursive: true });
    const hasAdo = fs.readdirSync(rawDir)
      .some(f => f.toLowerCase().includes('ado') && f.toLowerCase().endsWith('.csv'));
    let seeded = '';
    if (!hasAdo) {
      const example = path.join(KEEL_DIR, 'examples', 'northwind', 'ado_sample.csv');
      if (fs.existsSync(example)) {
        fs.copyFileSync(example, path.join(rawDir, 'ado_sample.csv'));
        seeded = '(seeded demo ADO CSV from examples/northwind/ado_sample.csv)\n';
      }
    }
    const out = execFileSync('python3', ['tools/normalize_ado.py'],
                             { cwd: KEEL_DIR, encoding: 'utf8', timeout: 30000 });
    res.json({ ok: true, output: seeded + out });
  } catch (e) {
    res.json({ ok: false, output: (e.stdout || '') + (e.stderr || '') + String(e) });
  }
});

// Run the deterministic reconcile (no LLM; pure script)
app.get('/run-reconcile', requireAuth, (req, res) => {
  try {
    const out = execFileSync('python3', ['tools/reconcile.py'],
                             { cwd: KEEL_DIR, encoding: 'utf8', timeout: 30000 });
    res.json({ ok: true, output: out });
  } catch (e) {
    res.json({ ok: false, output: (e.stdout || '') + (e.stderr || '') + String(e) });
  }
});

// Run the deterministic backlog normalizer (no LLM; pure script)
app.get('/run-normalize', requireAuth, (req, res) => {
  try {
    const out = execFileSync('python3', ['tools/normalize_backlog.py'],
                             { cwd: KEEL_DIR, encoding: 'utf8', timeout: 30000 });
    res.json({ ok: true, output: out });
  } catch (e) {
    res.json({ ok: false, output: (e.stdout || '') + (e.stderr || '') + String(e) });
  }
});

// Governance: verify the tamper-evident audit chain (scripts/audit-log.js).
app.get('/run-audit-verify', requireAuth, (req, res) => {
  try {
    const out = execFileSync('node', ['scripts/audit-log.js', 'verify'],
                             { cwd: KEEL_DIR, encoding: 'utf8', timeout: 30000 });
    res.json({ ok: true, output: out });
  } catch (e) {
    res.json({ ok: false, output: (e.stdout || '') + (e.stderr || '') + String(e) });
  }
});

// Governance: recursive PII/secret scan over the repo (scripts/scan-tree.js).
app.get('/run-scan-tree', requireAuth, (req, res) => {
  try {
    const out = execFileSync('node', ['scripts/scan-tree.js', '.'],
                             { cwd: KEEL_DIR, encoding: 'utf8', timeout: 60000 });
    res.json({ ok: true, output: out });
  } catch (e) {
    res.json({ ok: false, output: (e.stdout || '') + (e.stderr || '') + String(e) });
  }
});

// Weekly report status: report the ready/failed marker for the expected week-ending Friday.
app.get('/weekly-status', requireAuth, (req, res) => {
  try {
    const dir = path.join(KEEL_DIR, 'state', 'weekly-reports');
    // Compute this week's Friday in ET (same logic the wrapper uses).
    const tz = 'America/New_York';
    const now = new Date();
    const dowName = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now);
    const dowMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
    const dow = dowMap[dowName] || 1;
    const delta = 5 - dow; // days to Friday (negative Sat/Sun -> last Friday)
    const fri = new Date(now.getTime() + delta * 86400000);
    const friday = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(fri);

    const readyFile = path.join(dir, '.ready-' + friday);
    const failedFile = path.join(dir, '.failed-' + friday);
    if (fs.existsSync(readyFile)) {
      const msg = fs.readFileSync(readyFile, 'utf8').trim();
      return res.json({ state: 'ready', date: friday, message: msg });
    }
    if (fs.existsSync(failedFile)) {
      const msg = fs.readFileSync(failedFile, 'utf8').trim();
      return res.json({ state: 'failed', date: friday, message: msg });
    }
    return res.json({ state: 'none', date: friday });
  } catch (e) {
    return res.json({ state: 'none' });
  }
});

// Acknowledge (dismiss) the weekly marker: delete the ready/failed marker for the given date.
app.post('/weekly-ack', requireAuth, (req, res) => {
  try {
    const date = String((req.body && req.body.date) || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ ok: false, error: 'bad date' });
    const dir = path.join(KEEL_DIR, 'state', 'weekly-reports');
    for (const m of ['.ready-' + date, '.failed-' + date]) {
      const f = path.join(dir, m);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'ack failed' });
  }
});

// Daily digest status: report the ready/failed marker for today (ET). Respects the mute flag —
// when .banner-muted exists, returns 'none' so the banner stays hidden (digest still on disk).
app.get('/digest-status', requireAuth, (req, res) => {
  try {
    const dir = path.join(KEEL_DIR, 'state', 'daily-digests');
    if (fs.existsSync(path.join(dir, '.banner-muted'))) {
      return res.json({ state: 'none', muted: true });
    }
    const tz = 'America/New_York';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const readyFile = path.join(dir, '.ready-' + today);
    const failedFile = path.join(dir, '.failed-' + today);
    if (fs.existsSync(readyFile)) {
      let body = '';
      try { body = fs.readFileSync(path.join(dir, today + '.md'), 'utf8'); } catch (e) {}
      return res.json({ state: 'ready', date: today, body: body });
    }
    if (fs.existsSync(failedFile)) {
      const msg = fs.readFileSync(failedFile, 'utf8').trim();
      return res.json({ state: 'failed', date: today, message: msg });
    }
    return res.json({ state: 'none', date: today });
  } catch (e) {
    return res.json({ state: 'none' });
  }
});

// Dismiss the digest marker for a given date (delete it; the dated digest file stays as record).
app.post('/digest-ack', requireAuth, (req, res) => {
  try {
    const date = String((req.body && req.body.date) || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ ok: false, error: 'bad date' });
    const dir = path.join(KEEL_DIR, 'state', 'daily-digests');
    for (const m of ['.ready-' + date, '.failed-' + date]) {
      const f = path.join(dir, m);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'ack failed' });
  }
});

// Toggle the digest banner mute flag. POST {muted: true} creates it, {muted: false} removes it.
app.post('/digest-mute', requireAuth, (req, res) => {
  try {
    const dir = path.join(KEEL_DIR, 'state', 'daily-digests');
    const flag = path.join(dir, '.banner-muted');
    const muted = !!(req.body && req.body.muted);
    if (muted) { fs.writeFileSync(flag, 'muted ' + new Date().toISOString() + '\n'); }
    else { if (fs.existsSync(flag)) fs.unlinkSync(flag); }
    return res.json({ ok: true, muted: muted });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'mute toggle failed' });
  }
});

app.post('/stage', requireAuth, (req, res) => {
  try {
    const { filename, text, destination } = req.body || {};
    if (!text || !filename) return res.status(400).json({ ok: false, error: 'Missing text or filename.' });
    const dest = (destination === 'triage' || destination === 'triage-now') ? 'inbox' : 'context';
    const dir = path.join(KEEL_DIR, 'knowledge', dest);
    fs.mkdirSync(dir, { recursive: true });
    const base = String(filename).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'document';
    const today = new Date().toISOString().slice(0, 10);
    const savedAs = today + '_' + base + '.md';
    const fm = dest === 'inbox'
      ? '---\nsource: ' + filename + '\ningested: ' + new Date().toISOString() + '\ntriaged: false\n---\n\n'
      : '---\nsource: ' + filename + '\ningested: ' + new Date().toISOString() + '\ntype: context-only\n---\n\n';
    fs.writeFileSync(path.join(dir, savedAs), fm + text, { mode: 0o600 });
    auditRecord({ action: 'STAGE_DOC', status: 'OK', redaction: 'NONE', dest: dest, file: savedAs });
    logDaily('staged "' + filename + '" to ' + (dest === 'inbox' ? 'triage inbox' : 'context library') + ' (' + savedAs + ')');
    return res.json({ ok: true, savedAs, dest });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Stage failed: ' + e.message });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  sessionParser(req, {}, () => {
    // Mirror requireAuth: Cloudflare Access validated the request at the edge
    // (Cf-Access-* header present == authenticated), OR a direct session is authed.
    const cfAuthed = req.headers['cf-access-jwt-assertion'] || req.headers['cf-access-client-id'];
    if (!cfAuthed && (!req.session || !req.session.authed)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
});

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    let prompt;
    try { prompt = JSON.parse(data).prompt; } catch { prompt = String(data); }
    if (!prompt || !prompt.trim()) {
      ws.send(JSON.stringify({ type: 'error', text: 'Empty prompt.' }));
      return;
    }

    ws.send(JSON.stringify({ type: 'start' }));

    // Multi-turn: fleet-core chat-session resumes ONE rolling session per agent, so the
    // agent's own webchat AND the Aegis relay append to the same conversation. Mechanism
    // lives in core; the transcript is in the Claude Code session store (persistent volume).
    let activeModel; try { activeModel = modelRouting.resolveSelected(); } catch (e) { activeModel = null; }
    let finalText = '';
    let errText = '';
    let done = false;
    const finish = () => { if (done) return; done = true; ws.send(JSON.stringify({ type: 'done' })); };

    const child = chatSession.runChatTurn(
      { prompt, model: activeModel, cwd: KEEL_DIR, stateDir: path.join(KEEL_DIR, 'state'), env: process.env },
      (ev) => {
        if (ev.type === 'system' && ev.subtype === 'init') {
          ws.send(JSON.stringify({ type: 'step', text: 'Session ready — conversation memory on' }));
        }
        else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
          for (const block of ev.message.content) {
            if (block.type === 'text' && block.text) {
              finalText += block.text;
              ws.send(JSON.stringify({ type: 'token', text: block.text }));
            } else if (block.type === 'tool_use') {
              ws.send(JSON.stringify({ type: 'step', text: 'Using: ' + (block.name || 'tool') }));
            }
          }
        }
        else if (ev.type === 'result') {
          if (ev.is_error) errText = ev.result || 'Model reported an error';
        }
      },
      (code, stderr) => {
        if (stderr) errText += stderr;
        if (code !== 0 && !finalText) {
          ws.send(JSON.stringify({ type: 'error', text: (errText || 'Model call failed').trim().slice(0, 500) }));
        }
        finish();
      }
    );

    child.on('error', (e) => {
      ws.send(JSON.stringify({ type: 'error', text: 'Failed to start: ' + e.message }));
      finish();
    });
  });
});

const PORT = parseInt(process.env.KEEL_PORT || '8443', 10);
const HOST = process.env.KEEL_BIND || '127.0.0.1';
server.listen(PORT, HOST, () => console.log(`Keel webchat listening on http://${HOST}:${PORT}`));
