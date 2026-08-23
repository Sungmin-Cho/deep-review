#!/usr/bin/env node

import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { prepareExternalPrivacy } from './lib/agy-privacy.mjs';
import { resolvePluginRoot } from './lib/runtime-context.mjs';

function parseCli(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    const key = {
      '--repo': 'repo',
      '--plugin-root': 'pluginRoot',
      '--config': 'configPath',
      '--approval': 'approval',
    }[flag];
    if (!key || index + 1 >= argv.length) throw new Error(`unknown or incomplete argument: ${flag}`);
    values[key] = argv[index + 1];
    index += 1;
  }
  return values;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: grok-privacy-preflight.mjs --repo DIR --plugin-root DIR --approval auto|approve|decline [--config FILE]\n');
    return;
  }
  options.repo = resolve(options.repo || process.cwd());
  options.pluginRoot = resolve(options.pluginRoot || resolvePluginRoot());
  options.configPath = resolve(options.configPath || join(options.repo, '.deep-review', 'config.yaml'));
  const result = await prepareExternalPrivacy({ ...options, provider: 'grok' });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.error) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`grok-privacy-preflight.mjs: ${error.message}\n`);
    process.exitCode = 2;
  });
}
