/**
 * `sflow product status|align`: which build each product surface runs, and bringing them to one.
 *
 * Machine-level, like `reinstall`: it never resolves a repository or a workspace. `status` only
 * reads. `align` changes installed product surfaces, and only to the build the machine's
 * installation receipt names, from the bytes that receipt retained.
 */
import os from 'node:os';

import { BUILD_INFO, versionLine } from '../build-info.mjs';
import { PRODUCT_SUBCOMMANDS } from '../command-registry.mjs';
import { recordedConfigurationReviews, runConfigurationReviewPass } from '../configuration-review-pass.mjs';
import {
  commandResult, effects, failed, noEffects, noop, succeeded
} from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import {
  applyProductAlignment, observeProductSurfaces, planProductAlignment, PRODUCT_SURFACE_STATES
} from '../product-alignment.mjs';
import { recordedRequirementChecks } from '../product-requirement-gate.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

const OPTIONS = Object.freeze({
  status: ['json', 'extension-path', 'timings'],
  align: ['json', 'extension-path', 'dry-run', 'trigger', 'timings'],
  reviews: ['json', 'timings']
});
const TRIGGERS = new Set(['command', 'vscode-activation', 'first-mutation']);
const LABELS = Object.freeze({
  vscode: 'VS Code extension',
  cli: 'Terminal and Copilot CLI',
  copilot: 'Copilot plugin and skills'
});

const REQUIREMENT_LABELS = Object.freeze({
  satisfied: 'runs a build that meets its requirement',
  installed: 'installed the build it requires',
  'update-required': 'needs a newer build',
  failed: 'could not install the build it requires',
  unavailable: 'could not read its requirement',
  development: 'development build, never updated',
  unknown: 'build time unknown'
});

function fail(message, code = 'PRODUCT_COMMAND_INVALID') {
  throw new SingularityFlowError(message, { code });
}

/** The running build, when it is a stamped package that can be told apart from another build. */
export function runningStampedBuild(info = BUILD_INFO) {
  return info?.commit || info?.sourceSha256 ? versionLine(info) : null;
}

/**
 * What this machine recorded about its repositories, read locally: the configuration reviews this
 * build opened, and each repository's last product-requirement verdict.
 */
export async function productMachineRecords({
  homeDirectory = os.homedir(), runningBuild = runningStampedBuild()
} = {}) {
  const running = runningBuild;
  const [reviews, requirements] = await Promise.all([
    running ? recordedConfigurationReviews({ homeDirectory, runningBuild: running }) : null,
    recordedRequirementChecks({ homeDirectory })
  ]);
  return {
    configurationReviews: reviews ? {
      status: reviews.status ?? null,
      outcome: reviews.outcome ?? null,
      reviews: (reviews.reviews ?? []).map((entry) => ({ ...entry })),
      unfinished: (reviews.unfinished ?? []).map((entry) => ({ ...entry })),
      startedAt: reviews.startedAt ?? null,
      completedAt: reviews.completedAt ?? null,
      reason: reviews.reason ?? null
    } : null,
    requirements: requirements.filter((entry) => entry.verdict !== 'none').map((entry) => ({ ...entry }))
  };
}

function statusData(plan, records = { configurationReviews: null, requirements: [] }) {
  return {
    resultType: 'product-status',
    schemaVersion: 1, // schema-transient: public CLI result envelope
    verdict: plan.verdict,
    surfaces: plan.surfaces.map((entry) => ({ ...entry })),
    actions: plan.actions.map((entry) => ({ ...entry })),
    split: plan.split ? { ...plan.split } : null,
    next: plan.next.map((entry) => ({ ...entry })),
    configurationReviews: records.configurationReviews,
    requirements: records.requirements
  };
}

function printRecords(records, log = console.log) {
  const reviews = records.configurationReviews;
  if (reviews?.status === 'running') {
    log(`Configuration reviews: checking this build's packaged configuration in the background since ${reviews.startedAt}.`);
  } else if (reviews?.outcome === 'reviews-opened') {
    log('Configuration reviews opened for this build (nothing changes until each is merged):');
    for (const entry of reviews.reviews) log(`- ${entry.repository} → ${entry.proposalBranch}`);
  } else if (reviews?.outcome === 'current') {
    log(reviews.unfinished?.length
      ? "Configuration reviews: every registered repository this build could check matches its configuration."
      : "Configuration reviews: every registered repository's approved configuration matches this build.");
  } else if (reviews) {
    log(`Configuration reviews could not be opened${reviews.reason && !reviews.unfinished?.length ? `: ${reviews.reason}` : '.'} Preview them with: singularity-flow workspace refresh-configuration --dry-run`);
  }
  if (reviews?.unfinished?.length) {
    log('Not yet checked or proposed, tried again after an hour:');
    for (const entry of reviews.unfinished) log(`- ${entry.repository}: ${entry.reason}`);
  }
  if (records.requirements.length) {
    log('Repository requirements (last check on this machine):');
    for (const entry of records.requirements) {
      const label = REQUIREMENT_LABELS[entry.verdict] ?? entry.verdict;
      const required = entry.required ? ` · requires a build from ${entry.required}` : '';
      log(`- ${entry.repository}: ${label}${required} · checked ${entry.checkedAt ?? 'never'}${entry.reason ? ` — ${entry.reason}` : ''}`);
    }
  }
}

function printSurfaces(plan, log = console.log) {
  for (const surface of plan.surfaces) {
    const running = surface.live ?? (surface.state === 'not-installed' ? 'not installed' : 'no readable build');
    log(`- ${LABELS[surface.id]}: ${surface.state} · ${running}`);
    if (surface.installed && surface.installed !== surface.live) log(`  installed build: ${surface.installed}`);
    if (surface.reason) log(`  ${surface.reason}`);
    else if (surface.state !== 'aligned') log(`  ${PRODUCT_SURFACE_STATES[surface.state]}`);
  }
  for (const entry of plan.next) log(`Next: ${entry.command} — ${entry.reason}`);
}

function verdictOutcome(plan) {
  const slots = { count: plan.actions.length };
  return succeeded(`product.${plan.verdict}`, slots);
}

/**
 * This build's configuration-review pass, in the foreground: the one pass per build that a new
 * build's first mutation otherwise starts in the background. A pass already recorded is reported
 * as it is; a worker still running is left to finish.
 */
export async function productReviews({
  json = false, runningBuild = runningStampedBuild(), pass = runConfigurationReviewPass
} = {}) {
  const result = runningBuild
    ? await pass({ runningBuild })
    : { status: 'development', outcome: 'development', reviews: [] };
  const data = {
    resultType: 'product-configuration-reviews',
    schemaVersion: 1, // schema-transient: public CLI result envelope
    status: result.status,
    outcome: result.outcome ?? null,
    reviews: (result.reviews ?? []).map((entry) => ({ ...entry })),
    unfinished: (result.unfinished ?? []).map((entry) => ({ ...entry })),
    startedAt: result.startedAt ?? null,
    completedAt: result.completedAt ?? null,
    reason: result.reason ?? null
  };
  if (!json) {
    if (data.status === 'development') console.log('A development checkout proposes no configuration reviews of its own.');
    else printRecords({ configurationReviews: data, requirements: [] });
  }
  const count = data.reviews.length;
  // A pass that ran but left no outcome (its record could not be written) failed; it never "opened 0".
  // One that could not check its repositories yet is no failure: it is tried again after an hour.
  const failure = data.outcome === 'failed' || (data.status === 'ran' && !data.outcome);
  const outcome = data.status === 'development' ? noop('product.reviews-development')
    : data.status === 'running' ? noop('product.reviews-running')
      : data.outcome === 'unavailable' ? noop('product.reviews-unavailable', { count: data.unfinished.length })
      : data.outcome === 'current'
        ? (data.unfinished.length ? noop('product.reviews-incomplete', { count: data.unfinished.length }) : noop('product.reviews-current'))
        : failure ? failed('product.reviews-failed', { reason: data.reason ?? data.outcome ?? 'the pass recorded no outcome' })
          : data.status === 'ran' ? succeeded('product.reviews-opened', { count })
            : noop('product.reviews-recorded', { count });
  emitCommandResult(commandResult({
    operation: { id: 'product.reviews', classification: 'mutation' },
    outcome,
    // Opening a review pushes a review branch; approved configuration itself never changes.
    effects: data.status === 'ran' && count ? effects({ stateChanged: true }) : noEffects(),
    restState: 'informational',
    data
  }), { json });
  // A pass that failed just now fails the command; an earlier recorded failure is only reported.
  if (failure && data.status === 'ran') process.exitCode = 1;
  return data;
}

export async function run(_argv, { positionals, options }) {
  const subcommand = positionals[1] ?? 'status';
  if (!PRODUCT_SUBCOMMANDS.includes(subcommand)) {
    fail(`Unknown product subcommand '${subcommand}'. Supported: ${PRODUCT_SUBCOMMANDS.join(', ')}.`, 'UNKNOWN_SUBCOMMAND');
  }
  if (positionals.length > 2) fail(`product ${subcommand} does not accept positional arguments.`);
  const unknown = Object.keys(options).filter((key) => !OPTIONS[subcommand].includes(key));
  if (unknown.length) fail(`Unsupported option(s) for product ${subcommand}: ${unknown.sort().map((key) => `--${key}`).join(', ')}.`);
  const json = optionBoolean(options, 'json');
  if (subcommand === 'reviews') return productReviews({ json });
  const extensionPath = optionString(options, 'extension-path') ?? null;
  const dryRun = subcommand === 'align' && optionBoolean(options, 'dry-run');

  if (subcommand === 'status' || dryRun) {
    const plan = planProductAlignment(await observeProductSurfaces({ extensionPath }));
    const records = await productMachineRecords();
    const data = statusData(plan, records);
    if (!json) {
      printSurfaces(plan);
      printRecords(records);
    }
    emitCommandResult(commandResult({
      operation: { id: `product.${subcommand}`, classification: subcommand === 'status' ? 'read' : 'mutation' },
      outcome: verdictOutcome(plan),
      effects: noEffects(),
      restState: 'informational',
      data
    }), { json });
    return data;
  }

  const trigger = optionString(options, 'trigger') ?? 'command';
  if (!TRIGGERS.has(trigger)) fail(`--trigger must be one of: ${[...TRIGGERS].join(', ')}.`);
  const result = await applyProductAlignment({
    extensionPath,
    runningBuild: runningStampedBuild(),
    trigger,
    log: json ? () => {} : (line) => console.log(line)
  });
  const aligned = result.steps.filter((entry) => entry.outcome === 'aligned');
  const data = {
    ...statusData(result.plan),
    resultType: 'product-alignment',
    status: result.status,
    steps: result.steps.map((entry) => ({ ...entry }))
  };
  if (!json) printSurfaces(result.plan);
  const failure = result.steps.find((entry) => entry.outcome === 'failed');
  const narration = commandResult({
    operation: { id: 'product.align', classification: 'mutation' },
    outcome: failure
      ? failed('product.align-failed', { surface: LABELS[failure.surface], reason: failure.reason })
      : aligned.length
        ? succeeded('product.align-completed', { count: aligned.length })
        : noop(`product.${result.plan.verdict}`, { count: result.plan.actions.length }),
    effects: aligned.length ? effects({ stateChanged: true, filesChanged: true }) : noEffects(),
    restState: 'informational',
    data
  });
  emitCommandResult(narration, { json });
  if (failure) process.exitCode = 1;
  return data;
}
