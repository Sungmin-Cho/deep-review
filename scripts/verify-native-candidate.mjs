#!/usr/bin/env node
// usage: node scripts/verify-native-candidate.mjs <extractedDir> <checkoutRoot>
// Verifies BUILD-MANIFEST.json (source digests against the checkout, artifact
// digests and POSIX modes against the extracted files, argv arrays present) and
// SHA256SUMS against the extracted artifacts. Exit 0 on success, 1 otherwise.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [extracted, checkout] = process.argv.slice(2);
if (!extracted || !checkout) { console.error('usage: verify-native-candidate.mjs <extractedDir> <checkoutRoot>'); process.exit(1); }
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const fail = (message) => { console.error(`verify-native-candidate: ${message}`); process.exit(1); };
const manifest = JSON.parse(readFileSync(join(extracted, 'BUILD-MANIFEST.json'), 'utf8'));
if (!/^[a-f0-9]{40}$/u.test(String(manifest.source_sha))) fail('source_sha malformed');
const head = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (manifest.source_sha !== head) fail(`source_sha ${manifest.source_sha} is not the checked-out commit ${head}`);
const expectedSources = ['grok-linux-pidns-owner.c', 'grok-win32-job-owner.c'];
if (JSON.stringify(Object.keys(manifest.sources ?? {}).sort()) !== JSON.stringify(expectedSources)) fail('manifest.sources is not exactly the two helper sources');
for (const [source, digest] of Object.entries(manifest.sources)) {
  const actual = sha(join(checkout, 'hooks', 'scripts', 'lib', 'native', source));
  if (actual !== digest) fail(`source ${source} digest ${actual} != manifest ${digest}`);
}
const ALLOWED_COMPILERS = new Set(['cc', 'gcc', 'x86_64-w64-mingw32-gcc', 'cl', 'cl.exe']);
const expectedSourceFor = { linux: 'grok-linux-pidns-owner.c', win32: 'grok-win32-job-owner.c' };
const expectedOutputFor = { linux: 'linux-x64/grok-linux-pidns-owner', win32: 'win32-x64/grok-win32-job-owner.exe' };
for (const target of ['linux', 'win32']) {
  const argv = manifest[target]?.argv;
  if (!Array.isArray(argv) || argv.length < 4) fail(`${target}.argv missing`);
  if (!ALLOWED_COMPILERS.has(argv[0].split(/[\\/]/u).pop())) fail(`${target}.argv[0] is not an allowed compiler: ${argv[0]}`);
  if (!argv.some((a) => a.endsWith(expectedSourceFor[target]))) fail(`${target}.argv does not name ${expectedSourceFor[target]}`);
  if (!argv.some((a) => a.replaceAll('\\', '/').endsWith(expectedOutputFor[target]))) fail(`${target}.argv does not name ${expectedOutputFor[target]}`);
  if (typeof manifest[target]?.compiler !== 'string' || manifest[target].compiler.length === 0) fail(`${target}.compiler missing`);
}
const expectedArtifacts = ['linux-x64/grok-linux-pidns-owner', 'win32-x64/grok-win32-job-owner.exe'];
if (JSON.stringify(Object.keys(manifest.artifacts ?? {}).sort()) !== JSON.stringify([...expectedArtifacts].sort())) fail('manifest.artifacts is not exactly the two helpers');
for (const rel of expectedArtifacts) {
  const entry = manifest.artifacts?.[rel];
  if (!entry) fail(`artifact ${rel} missing from manifest`);
  const file = join(extracted, ...rel.split('/'));
  const actual = sha(file);
  if (actual !== entry.sha256) fail(`artifact ${rel} digest ${actual} != manifest ${entry.sha256}`);
  if (process.platform !== 'win32') {
    const mode = (statSync(file).mode & 0o777).toString(8).padStart(4, '0');
    if (mode !== entry.mode) fail(`artifact ${rel} mode ${mode} != manifest ${entry.mode}`);
  }
}
const sums = readFileSync(join(extracted, 'SHA256SUMS'), 'utf8').split(/\r?\n/u).filter(Boolean);
if (sums.length !== expectedArtifacts.length) fail('SHA256SUMS line count');
for (const line of sums) {
  const match = /^([a-f0-9]{64})  (\S+)$/u.exec(line);
  if (!match || !expectedArtifacts.includes(match[2])) fail(`SHA256SUMS line ${line}`);
  if (match[1] !== manifest.artifacts[match[2]].sha256) fail(`SHA256SUMS ${match[2]} disagrees with the manifest`);
}
console.log('verify-native-candidate: ok');
