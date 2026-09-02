#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const specs = {
  'linux-x64': { source: 'grok-linux-pidns-owner.c', output: 'linux-x64/grok-linux-pidns-owner' },
  'win32-x64': { source: 'grok-win32-job-owner.c', output: 'win32-x64/grok-win32-job-owner.exe' },
};
export const NATIVE_PLACEHOLDER_DIGEST = '0'.repeat(64);   // must equal lib/grok-native-artifact.mjs (T-PACK-3 pins the equality)

export function writeNativeSums(outputRoot) {
  const lines = Object.values(specs).map(({ output }) => {
    const file = join(outputRoot, ...output.split('/'));
    const digest = existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : NATIVE_PLACEHOLDER_DIGEST;
    return `${digest}  ${output}`;
  });
  writeFileSync(join(outputRoot, 'SHA256SUMS'), `${lines.join('\n')}\n`);
}

function main() {
  const inferred = process.platform === 'linux' && process.arch === 'x64' ? 'linux-x64'
    : process.platform === 'win32' && process.arch === 'x64' ? 'win32-x64' : null;
  const target = process.env.GROK_NATIVE_TARGET || inferred;
  const spec = specs[target];
  if (!spec) throw new Error('build:native supports only linux-x64 and win32-x64');
  const sourceRoot = join(root, 'hooks', 'scripts', 'lib', 'native');
  const outputRoot = resolve(process.env.GROK_NATIVE_OUTPUT_ROOT || sourceRoot);
  const source = join(sourceRoot, spec.source);
  const output = join(outputRoot, ...spec.output.split('/'));
  mkdirSync(dirname(output), { recursive: true });
  const family = process.env.GROK_NATIVE_COMPILER_FAMILY || (target === 'win32-x64' && process.platform === 'win32' ? 'msvc' : 'gnu');
  const compiler = process.env.CC || (family === 'msvc' ? 'cl' : 'cc');
  const object = join(tmpdir(), 'grok-win32-job-owner.obj');
  const args = family === 'msvc'
    ? ['/nologo', '/std:c11', '/utf-8', '/W4', '/WX', '/O2', '/TC', source, `/Fo${object}`, `/Fe${output}`]
    : ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', ...(target === 'win32-x64' ? ['-municode'] : []), source, '-o', output];
  const result = spawnSync(compiler, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  writeNativeSums(outputRoot);
  // The build receipt is the ONLY source of provenance the manifest may copy:
  // the exact executable and argv this process invoked, as it invoked them.
  writeFileSync(join(outputRoot, `build-receipt.${target}.json`), `${JSON.stringify({ target, compiler, argv: [compiler, ...args], source: spec.source, output: spec.output }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
