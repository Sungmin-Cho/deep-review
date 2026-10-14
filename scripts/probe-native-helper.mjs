#!/usr/bin/env node
// usage: node scripts/probe-native-helper.mjs <helper> <launcher> <expectedVersion> <recordFile>
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { parseOwnerControlLines } from '../hooks/scripts/lib/grok-owner-control.mjs';
import { parseGrokCompatibilityStdout } from '../hooks/scripts/lib/grok-compatibility-carrier.mjs';

const [helper, launcher, expectedVersion, recordFile] = process.argv.slice(2);
if (!helper || !launcher || !expectedVersion || !recordFile) { console.error('usage: probe-native-helper.mjs <helper> <launcher> <expectedVersion> <recordFile>'); process.exit(1); }
// These are real CLI startup probes, not authenticated provider model turns.
for (const kind of ['version', 'help']) {
  const run = spawnSync(helper, ['--own-grok-tree', '--parent-pid', String(process.pid), '--', launcher, `--${kind}`], { input: '', timeout: 30000, windowsHide: true, shell: false });
  const provider = Buffer.from(run.stderr ?? []).toString('utf8');
  appendFileSync(recordFile, `${kind}_provider=${JSON.stringify(provider)}\n`);
  if (run.error) { console.error(`probe: ${kind} spawn failed: ${run.error.message}`); process.exit(1); }
  if (run.status !== 0) { console.error(`probe: ${kind} helper exit ${run.status} signal ${run.signal}\n${provider}`); process.exit(1); }
  const control = parseOwnerControlLines(run.stdout);
  if (!control.ok) { console.error(`probe: ${kind} control stream invalid: ${control.reason}\n${Buffer.from(run.stdout).toString('utf8')}`); process.exit(1); }
  try {
    const parsed = parseGrokCompatibilityStdout(provider, kind, { version: expectedVersion });
    if (kind === 'version' && parsed.version !== expectedVersion) throw new Error(`expected ${expectedVersion}, observed ${parsed.version}`);
  } catch (error) { console.error(`probe: ${kind} compatibility failed: ${error.message}`); process.exit(1); }
}
console.log('probe-native-helper: ok');
