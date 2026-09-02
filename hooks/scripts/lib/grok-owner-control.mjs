// Every C0/C1 control except tab and LF (CR included: it can rewrite a terminal line).
const CONTROL_CHARACTERS = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]', 'gu');

export function sanitizeHelperStderr(bytes, { pluginRoot = null, maxBytes = 2048 } = {}) {
  const text = Buffer.from(bytes ?? []).subarray(0, maxBytes).toString('utf8').replace(CONTROL_CHARACTERS, '');
  return pluginRoot ? text.split(pluginRoot).join('{plugin_root}') : text;
}

const HANDSHAKES = new Set(['containment_ready', 'termination_report']);
const OWNER_FIELDS = ['owner_id', 'generation', 'observed_at', 'handshake_lost', 'deadline_exceeded'];

function validLine(line) {
  if (!line || typeof line !== 'object' || Array.isArray(line)) return false;
  if (line.protocol_version !== '1.0' || !HANDSHAKES.has(line.handshake)) return false;
  if (OWNER_FIELDS.some((field) => Object.hasOwn(line, field))) return false;
  if (line.handshake === 'containment_ready') {
    return line.containment_ready === true && typeof line.mechanism === 'string' && line.mechanism.length > 0;
  }
  return Number.isSafeInteger(line.live_members) && line.live_members >= 0 && Array.isArray(line.member_pids);
}

export function parseOwnerControlLines(buffer) {
  const text = Buffer.from(buffer ?? []).toString('utf8').trim();
  if (text.length === 0) return { ok: false, reason: 'empty', lines: [] };
  const lines = [];
  for (const raw of text.split(/\r?\n/u)) {
    let parsed;
    try { parsed = JSON.parse(raw.trim()); } catch { return { ok: false, reason: 'malformed', lines }; }
    lines.push(parsed);
  }
  const shapeOk = lines.length === 2 && lines.every(validLine)
    && lines[0].handshake === 'containment_ready' && lines[1].handshake === 'termination_report';
  return shapeOk ? { ok: true, lines } : { ok: false, reason: 'shape', lines };
}
