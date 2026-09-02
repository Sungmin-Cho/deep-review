'use strict';
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const SOURCE = path.join(__dirname, '..', 'fixtures', 'native', 'stub-owner.c');
const GROK_SOURCE = path.join(__dirname, '..', 'fixtures', 'native', 'stub-grok.c');
const ARGV_MATRIX = JSON.parse(readFileSync(path.join(__dirname, '..', 'fixtures', 'native', 'argv-matrix.json'), 'utf8'));
const INVENTORY = { 'linux/x64': 'linux-x64/grok-linux-pidns-owner', 'win32/x64': 'win32-x64/grok-win32-job-owner.exe' };
const PLACEHOLDER = '0'.repeat(64);
const HOST_STUB_PLATFORM = process.platform === 'win32' ? 'win32' : 'linux';
const HOST_STUB_ARCH = 'x64';
let compiled = null;
let compiledGrok = null;

function compileOnce() {
  if (compiled) return compiled;
  const dir = mkdtempSync(path.join(tmpdir(), 'deep-review-stub-'));
  const binary = path.join(dir, process.platform === 'win32' ? 'stub-owner.exe' : 'stub-owner');
  const attempts = process.platform === 'win32'
    ? [['cl', ['/nologo', '/std:c11', '/W3', '/O2', '/TC', SOURCE, `/Fo${path.join(dir, 'stub.obj')}`, `/Fe${binary}`]], ['gcc', ['-std=c11', '-O2', SOURCE, '-o', binary]]]
    : [['cc', ['-std=c11', '-O2', SOURCE, '-o', binary]], ['clang', ['-std=c11', '-O2', SOURCE, '-o', binary]], ['gcc', ['-std=c11', '-O2', SOURCE, '-o', binary]]];
  for (const [compiler, args] of attempts) {
    const result = spawnSync(compiler, args, { encoding: 'utf8', windowsHide: true });
    if (!result.error && result.status === 0 && existsSync(binary)) { compiled = { binary }; return compiled; }
  }
  compiled = { skipReason: 'no C compiler available for the stub owner helper (cc/clang/gcc/cl)' };
  return compiled;
}

function compileGrokOnce() {
  if (compiledGrok) return compiledGrok;
  const dir = mkdtempSync(path.join(tmpdir(), 'deep-review-stub-grok-'));
  const binary = path.join(dir, process.platform === 'win32' ? 'stub-grok.exe' : 'stub-grok');
  const attempts = process.platform === 'win32'
    ? [['cl', ['/nologo', '/std:c11', '/W3', '/O2', '/TC', GROK_SOURCE, `/Fo${path.join(dir, 'grok.obj')}`, `/Fe${binary}`]], ['gcc', ['-std=c11', '-O2', GROK_SOURCE, '-o', binary]]]
    : [['cc', ['-std=c11', '-O2', GROK_SOURCE, '-o', binary]], ['clang', ['-std=c11', '-O2', GROK_SOURCE, '-o', binary]], ['gcc', ['-std=c11', '-O2', GROK_SOURCE, '-o', binary]]];
  for (const [compiler, args] of attempts) {
    const result = spawnSync(compiler, args, { encoding: 'utf8', windowsHide: true });
    if (!result.error && result.status === 0 && existsSync(binary)) { compiledGrok = { binary }; return compiledGrok; }
  }
  compiledGrok = { skipReason: 'no C compiler available for the stub grok launcher (cc/clang/gcc/cl)' };
  return compiledGrok;
}

function digestOf(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }

function stubNativeRoot({ platform = HOST_STUB_PLATFORM, arch = HOST_STUB_ARCH, otherPlatformPresent = false } = {}) {
  const built = compileOnce();
  if (built.skipReason) return { skipReason: built.skipReason };
  const root = mkdtempSync(path.join(tmpdir(), 'deep-review-stub-native-'));
  const hostKey = `${platform}/${arch}`;
  const helperPath = path.join(root, ...INVENTORY[hostKey].split('/'));
  mkdirSync(path.dirname(helperPath), { recursive: true });
  copyFileSync(built.binary, helperPath);
  if (process.platform !== 'win32') chmodSync(helperPath, 0o755);
  if (otherPlatformPresent) {
    for (const [key, rel] of Object.entries(INVENTORY)) {
      if (key === hostKey) continue;
      const other = path.join(root, ...rel.split('/'));
      mkdirSync(path.dirname(other), { recursive: true });
      copyFileSync(built.binary, other);
      if (process.platform !== 'win32') chmodSync(other, 0o755);
    }
  }
  const lines = Object.entries(INVENTORY).map(([key, rel]) => {
    const file = path.join(root, ...rel.split('/'));
    return `${key === hostKey || otherPlatformPresent ? digestOf(file) : PLACEHOLDER}  ${rel}`;
  });
  writeFileSync(path.join(root, 'SHA256SUMS'), `${lines.join('\n')}\n`);
  return { root, helperPath, helperSha256: digestOf(helperPath), skipReason: null };
}

function stubGrokLauncher({ version = '1.0.4', build = 'd846eb93d94d', helpFlags = null } = {}) {
  const built = compileGrokOnce();
  if (built.skipReason) return { skipReason: built.skipReason };
  const root = mkdtempSync(path.join(tmpdir(), 'deep-review-stub-grok-bin-'));
  const bin = path.join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const launcher = path.join(bin, process.platform === 'win32' ? 'grok.exe' : 'grok');
  copyFileSync(built.binary, launcher);
  if (process.platform !== 'win32') chmodSync(launcher, 0o755);
  const log = path.join(root, 'grok-calls.ndjson');
  const env = { STUB_GROK_LOG: log, STUB_GROK_VERSION: version, STUB_GROK_BUILD: build, ...(helpFlags ? { STUB_GROK_HELP_FLAGS: helpFlags.join(' ') } : {}) };
  return { root, bin, launcher, log, env, skipReason: null };
}

module.exports = { stubNativeRoot, stubGrokLauncher, ARGV_MATRIX, INVENTORY, PLACEHOLDER, HOST_STUB_PLATFORM, HOST_STUB_ARCH };
