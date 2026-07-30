/**
 * redact.js — shared PII redaction module (Argus file-structure parity).
 *
 * The implementation lives in gate/ and is a verbatim port of Keel's egress
 * gate, per the ruling that Castor and Keel use identical redaction. This
 * file exists so the documented Argus layout (scripts/redact.js imported by
 * every ingest path) is preserved without forking the logic.
 *
 *   redact(text, mapState)      -> { redacted, map, counters, reverse }
 *   prepareForEgress(text, ...) -> tripwire check + tokenization
 *   rehydrate(text, mapState)   -> restore real values locally
 *
 * Never re-implement patterns here. Change gate/redact.js so Keel and Castor
 * stay identical.
 */
const { redact } = require('../gate/redact');
const { prepareForEgress, rehydrate } = require('../gate/gate');
const { checkTripwire } = require('../gate/tripwire');

module.exports = { redact, prepareForEgress, rehydrate, checkTripwire };
