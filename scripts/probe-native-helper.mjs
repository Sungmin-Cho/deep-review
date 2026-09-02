#!/usr/bin/env node
// usage: node scripts/probe-native-helper.mjs <helper> <launcher> <expectedVersion> <recordFile>
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { parseOwnerControlLines } from '../hooks/scripts/lib/grok-owner-control.mjs';

const [helper, launcher, expectedVersion, recordFile] = process.argv.slice(2);
if (!helper || !launcher || !expectedVersion || !recordFile) { console.error('usage: probe-native-helper.mjs <helper> <launcher> <expectedVersion> <recordFile>'); process.exit(1); }
const run = spawnSync(helper, ['--own-grok-tree', '--parent-pid', String(process.pid), '--', launcher, '--version'], { input: '', timeout: 30000, windowsHide: true, shell: false });
const provider = Buffer.from(run.stderr ?? []).toString('utf8');
appendFileSync(recordFile, `provider=${JSON.stringify(provider)}\n`);
if (run.error) { console.error(`probe: spawn failed: ${run.error.message}`); process.exit(1); }
if (run.status !== 0) { console.error(`probe: helper exit ${run.status} signal ${run.signal}\n${provider}`); process.exit(1); }
if (!provider.includes(`grok ${expectedVersion}`)) { console.error(`probe: banner for ${expectedVersion} missing on the provider channel:\n${provider}`); process.exit(1); }
const control = parseOwnerControlLines(run.stdout);
if (!control.ok) { console.error(`probe: control stream invalid: ${control.reason}\n${Buffer.from(run.stdout).toString('utf8')}`); process.exit(1); }
console.log('probe-native-helper: ok');
