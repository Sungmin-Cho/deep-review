#!/usr/bin/env node
// D22 — the shipped Grok control-plane entrypoint.
//
//   grok-carrier-coordinator.mjs --cwd PROJECT_ROOT --mode review|dry-run
//
// It creates and owns the bounded private `--grok-carrier-fd` channel, spawns
// and drains real process A (`detect-environment.mjs`), and then stays alive
// serving fresh readable endpoints to every consumer until it is shut down.
//
// Public stdout is the environment JSON, exactly as the standalone detector
// prints it, followed by one coordinator descriptor line naming the private
// control path. The private descriptor itself is never fd=1/stdout: the
// canonical frame only ever travels over a fresh private endpoint.

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  COORDINATOR_MODES,
  COORDINATOR_PROTOCOL_VERSION,
  createGrokCarrierCoordinator,
} from './lib/grok-carrier-coordinator.mjs';

export function parseArguments(argv) {
  let cwd;
  let mode;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--cwd') {
      if (!argv[index + 1]) throw new Error('--cwd requires a value');
      cwd = argv[index + 1];
      index += 1;
    } else if (argument === '--mode') {
      if (!argv[index + 1]) throw new Error('--mode requires a value');
      mode = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (cwd === undefined) throw new Error('--cwd PROJECT_ROOT is required');
  if (mode === undefined) throw new Error('--mode review|dry-run is required');
  if (!COORDINATOR_MODES.includes(mode)) {
    throw new Error(`--mode must be one of ${COORDINATOR_MODES.join(', ')}`);
  }
  return { cwd: resolve(cwd), mode };
}

export async function runCoordinatorCli(argv, {
  createCoordinator = createGrokCarrierCoordinator,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const options = parseArguments(argv);
    const coordinator = await createCoordinator({
      cwd: options.cwd,
      mode: options.mode,
      env: process.env,
    });
    stdout.write(`${JSON.stringify(coordinator.environment)}\n`);
    stdout.write(`${JSON.stringify({
      protocol_version: COORDINATOR_PROTOCOL_VERSION,
      coordinator_id: coordinator.coordinator_id,
      generation: coordinator.generation,
      pid: coordinator.pid,
      mode: coordinator.mode,
      control_path: coordinator.control_path,
      environment_sha256: coordinator.environment_sha256,
    })}\n`);
    await coordinator.terminated;
  } catch (error) {
    if (error?.containment_refusal) {
      stdout.write(`${JSON.stringify(error.containment_refusal)}\n`);
      process.exitCode = 3;
      return;
    }
    stderr.write(`grok-carrier-coordinator: ${error.message}\n`);
    process.exitCode = 1;
  }
}

async function main() {
  await runCoordinatorCli(process.argv.slice(2));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main();
}
