'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { stubNativeRoot } = require('./helpers/native-stub.cjs');

const help = '--cwd --max-turns --model --no-subagents --output-format --permission-mode --prompt-file --reasoning-effort --sandbox --session-id --single\n';

function probe(t, { version = '1.0.52', expected = version, flags = help, fault = '', noise = '' } = {}) {
  const native = stubNativeRoot();
  if (native.skipReason) { t.skip(native.skipReason); return null; }
  const dir = mkdtempSync(join(tmpdir(), 'deep-review-probe-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.after(() => rmSync(native.root, { recursive: true, force: true }));
  const record = join(dir, 'record.txt');
  const result = spawnSync(process.execPath, [join(__dirname, '..', 'scripts', 'probe-native-helper.mjs'), native.helperPath, 'grok-fixture', expected, record], {
    encoding: 'utf8', timeout: 10000, windowsHide: true,
    env: { ...process.env, STUB_PROVIDER_OUTPUT: `${noise}grok ${version} (0920c8169e27) [stable]\n`, STUB_PROVIDER_HELP_OUTPUT: flags, STUB_FAULT: fault },
  });
  return { ...result, record: readFileSync(record, 'utf8') };
}

test('release CLI probe checks version and help through the owner for both admitted profiles', t => {
  for (const version of ['1.0.13', '1.0.52']) {
    const result = probe(t, { version }); if (!result) return;
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /probe-native-helper: ok/u);
    assert.match(result.record, /^version_provider=/mu);
    assert.match(result.record, /^help_provider=/mu);
  }
});

test('release CLI probe rejects missing help flags after a valid version handshake', t => {
  const result = probe(t, { flags: help.replace('--sandbox ', '') }); if (!result) return;
  assert.equal(result.status, 1);
  assert.match(result.stderr, /help compatibility failed:.*--sandbox/u);
  assert.match(result.record, /^help_provider=/mu);
  assert.doesNotMatch(result.stdout, /probe-native-helper: ok/u);
});

test('release CLI probe rejects a retired CLI and an unexpected admitted version', t => {
  for (const [version, expected, pattern] of [['1.0.4', '1.0.52', /unsupported Grok CLI version/u], ['1.0.13', '1.0.52', /expected 1\.0\.52, observed 1\.0\.13/u]]) {
    const result = probe(t, { version, expected }); if (!result) return;
    assert.equal(result.status, 1);
    assert.match(result.stderr, pattern);
    assert.doesNotMatch(result.record, /^help_provider=/mu);
  }
});

test('release CLI probe refuses CLI output without a complete owner control stream', t => {
  const result = probe(t, { fault: 'no_ready' }); if (!result) return;
  assert.equal(result.status, 1);
  assert.match(result.stderr, /control stream invalid/u);
  assert.doesNotMatch(result.stdout, /probe-native-helper: ok/u);
});

test('release CLI probe preserves noise diagnostics and fails closed on a noisy version channel', t => {
  const result = probe(t, { noise: 'fixture warning: first-run notice\n' }); if (!result) return;
  assert.equal(result.status, 1);
  assert.match(result.stderr, /version compatibility failed: Grok CLI version stdout is malformed/u);
  assert.match(result.record, /fixture warning: first-run notice/u);
  assert.doesNotMatch(result.record, /^help_provider=/mu);
  assert.doesNotMatch(result.stdout, /probe-native-helper: ok/u);
});
