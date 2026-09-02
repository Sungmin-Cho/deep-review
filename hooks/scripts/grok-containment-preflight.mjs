#!/usr/bin/env node

// The production-path containment preflight (SLICE-008c — D21 / I41).
//
// Thin by construction: every rule lives in `lib/grok-process-supervisor.mjs`,
// the retained containment owner. This file is the seam that the review
// pipeline calls, and its call site is fixed — after routing classification
// (`review-execution.md:182-189`, §3.2) and *before* privacy
// (`review-execution.md:163-180`, §3.1), fingerprint, UUID, prompt composition
// and provider launch (`:247-260`).
//
// `containment_ready` is the pre-launch admission; `termination_confirmed` is
// the post-exit proof. They are not interchangeable: using
// `termination_confirmed` as the pre-launch privacy gate is rejected.
//
// On success the preflight issues one owner-bound `containment_ready_token`
// that is carried into `run-grok-reviewer.mjs`. On refusal it issues none, and
// the bridge — which consumes the token and never establishes readiness — makes
// zero downstream calls.

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import {
  assertContainmentReadyToken,
  preflightGrokContainment,
  releaseGrokContainment,
} from './lib/grok-process-supervisor.mjs';

export { preflightGrokContainment, releaseGrokContainment };

const ACCEPTED_PRIVACY_OUTCOMES = new Set(['auto_ack', 'acknowledged']);

// The three named release causes, plus the completed launch. A launch that was
// never attempted is `no_launch`; one refused by the privacy gate carries its
// declining outcome and is named as such, because the two are different
// operator-visible events.
export function classifyContainmentRelease({ error = null, result = null } = {}) {
  if (error) return 'error';
  if (result === null || typeof result !== 'object' || result.attempted !== true) {
    const outcome = result && typeof result === 'object' ? result.privacyOutcome ?? null : null;
    return outcome !== null && !ACCEPTED_PRIVACY_OUTCOMES.has(outcome) ? 'privacy_decline' : 'no_launch';
  }
  return 'completed';
}

// The ordered lifecycle, owned in one place:
//   preflight → containment_ready → privacy/UUID/prompt/provider launch →
//   termination_report → post-fingerprint → sibling eligibility.
// A refusal returns before `launch` is ever called, so an unsupported platform
// produces zero privacy/config mutation, fingerprint, UUID, prompt and
// provider-child calls.
export async function withGrokContainment(launch, options = {}) {
  const {
    preflight = preflightGrokContainment,
    release = releaseGrokContainment,
    ...preflightOptions
  } = options;
  const admission = preflight(preflightOptions);
  if (admission.ok !== true || admission.containment_ready_token === null) {
    return {
      ok: false,
      reason: admission.reason,
      containment_ready: false,
      containment_ready_token: null,
      launched: false,
      released: false,
      release_reason: null,
      result: null,
    };
  }

  const token = admission.containment_ready_token;
  let result = null;
  let failure = null;
  try {
    result = await launch(token);
  } catch (error) {
    failure = error;
  }
  const releaseReason = classifyContainmentRelease({ error: failure, result });
  const released = release(token, { reason: releaseReason });
  if (failure) throw failure;
  return {
    ok: true,
    reason: null,
    containment_ready: true,
    containment_ready_token: token,
    launched: releaseReason === 'completed',
    released: released.released === true,
    release_reason: releaseReason,
    result,
  };
}

export function parseArguments(argv) {
  if (argv.length === 0) return { mode: 'preflight' };
  if (argv[0] !== '--release') throw new Error(`unknown argument: ${argv[0]}`);
  if (argv[1] !== '--containment-ready-token-json' || typeof argv[2] !== 'string' || argv.length !== 3) {
    throw new Error('--release requires --containment-ready-token-json JSON');
  }
  let token;
  try { token = JSON.parse(argv[2]); } catch (error) { throw new Error(`invalid_containment_ready_token: ${error.message}`); }
  try { assertContainmentReadyToken(token); } catch (error) { throw new Error(`invalid_containment_ready_token: ${error.message}`); }
  return { mode: 'release', token };
}

async function main() {
  let options;
  try { options = parseArguments(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`grok-containment-preflight.mjs: ${error.message}\n`); process.exitCode = 1; return; }
  if (options.mode === 'release') {
    const released = releaseGrokContainment(options.token, { reason: 'released_by_cli' });
    process.stdout.write(`${JSON.stringify({ released: released.released, reason: released.reason, owner_id: released.owner_id })}\n`);
    if (!released.released) process.exitCode = 3;
    return;
  }
  const preflight = preflightGrokContainment();
  process.stdout.write(`${JSON.stringify(preflight)}\n`);
  if (!preflight.ok) process.exitCode = 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`grok-containment-preflight.mjs: ${error.message}\n`);
    process.exitCode = 2;
  });
}
