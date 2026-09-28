/**
 * `sflow product status|align`: which build each product surface runs, and bringing them to one.
 *
 * Machine-level, like `reinstall`: it never resolves a repository or a workspace. `status` only
 * reads. `align` changes installed product surfaces, and only to the build the machine's
 * installation receipt names, from the bytes that receipt retained.
 */
import { BUILD_INFO, versionLine } from '../build-info.mjs';
import { PRODUCT_SUBCOMMANDS } from '../command-registry.mjs';
import {
  commandResult, effects, failed, noEffects, noop, succeeded
} from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import {
  applyProductAlignment, observeProductSurfaces, planProductAlignment, PRODUCT_SURFACE_STATES
} from '../product-alignment.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

const OPTIONS = Object.freeze({
  status: ['json', 'extension-path', 'timings'],
  align: ['json', 'extension-path', 'dry-run', 'trigger', 'timings']
});
const TRIGGERS = new Set(['command', 'vscode-activation', 'first-mutation']);
const LABELS = Object.freeze({
  vscode: 'VS Code extension',
  cli: 'Terminal and Copilot CLI',
  copilot: 'Copilot plugin and skills'
});

function fail(message, code = 'PRODUCT_COMMAND_INVALID') {
  throw new SingularityFlowError(message, { code });
}

/** The running build, when it is a stamped package that can be told apart from another build. */
export function runningStampedBuild(info = BUILD_INFO) {
  return info?.commit || info?.sourceSha256 ? versionLine(info) : null;
}

function statusData(plan) {
  return {
    resultType: 'product-status',
    schemaVersion: 1, // schema-transient: public CLI result envelope
    verdict: plan.verdict,
    surfaces: plan.surfaces.map((entry) => ({ ...entry })),
    actions: plan.actions.map((entry) => ({ ...entry })),
    split: plan.split ? { ...plan.split } : null,
    next: plan.next.map((entry) => ({ ...entry }))
  };
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

export async function run(_argv, { positionals, options }) {
  const subcommand = positionals[1] ?? 'status';
  if (!PRODUCT_SUBCOMMANDS.includes(subcommand)) {
    fail(`Unknown product subcommand '${subcommand}'. Supported: ${PRODUCT_SUBCOMMANDS.join(', ')}.`, 'UNKNOWN_SUBCOMMAND');
  }
  if (positionals.length > 2) fail(`product ${subcommand} does not accept positional arguments.`);
  const unknown = Object.keys(options).filter((key) => !OPTIONS[subcommand].includes(key));
  if (unknown.length) fail(`Unsupported option(s) for product ${subcommand}: ${unknown.sort().map((key) => `--${key}`).join(', ')}.`);
  const json = optionBoolean(options, 'json');
  const extensionPath = optionString(options, 'extension-path') ?? null;
  const dryRun = subcommand === 'align' && optionBoolean(options, 'dry-run');

  if (subcommand === 'status' || dryRun) {
    const plan = planProductAlignment(await observeProductSurfaces({ extensionPath }));
    const data = statusData(plan);
    if (!json) printSurfaces(plan);
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
