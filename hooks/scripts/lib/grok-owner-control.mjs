// Every C0/C1 control except tab and LF (CR included: it can rewrite a terminal line).
const CONTROL_CHARACTERS = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]', 'gu');

export function sanitizeHelperStderr(bytes, { pluginRoot = null, maxBytes = 2048 } = {}) {
  const text = Buffer.from(bytes ?? []).subarray(0, maxBytes).toString('utf8').replace(CONTROL_CHARACTERS, '');
  return pluginRoot ? text.split(pluginRoot).join('{plugin_root}') : text;
}
