import { formatCommandRouteLines } from '../model-free-commands.mjs';
/**
 * The repository's own tests, run when a verification step is published, and reused or run again when
 * it is submitted [CQF:REQ-012].
 *
 * A step whose pinned definition says `repositoryTests: run` runs the test suite the repository's
 * build files name (npm test, mvn test, go test, ...) beside its own checks. Only the pinned
 * definition counts, so a Story started before its workflow asked for this keeps its contract.
 * Code steps already run their tests, so only other steps take part, and nothing is added when:
 *
 * - the step names its own test command: the team's choice stands;
 * - it reviews one code step's committed test receipt (`testEvidenceFrom`);
 * - the Story accepted known failures, or its code step's tests did not pass here. Running them
 *   again could not pass and would hold a step no rework can fix, so a note says why instead.
 *
 * A command the code step already ran on this same code is not run again: qualityChecks reuses that
 * run [TCE:REQ-080], so this adds only what has not run. On only its new and changed tests a Story
 * runs nothing here and says so [TCE:REQ-094].
 *
 * A repository with no test command sflow can find gets a note naming how to add one, and a run
 * that could not start (its launcher is not installed here) is recorded as not run. Neither holds
 * the step. A run that fails does not refuse the submission either: the step waits for review,
 * and its reviewer returns it to the step that repairs it.
 */
import { storyTestScope } from '../code-delivery-policy.mjs';
import { isTestQualityCommand, resolveDeliveryQualityCommands, reviewCodeSource, testCommandProvenance } from '../delivery-evidence.mjs';
import { nextPhaseGeneration } from '../phase-generation.mjs';
import { inferRepositoryTestCommands } from '../repository-test-command-inference.mjs';
import { workDirRelative } from '../story-paths.mjs';
import { nowIso } from '../util.mjs';
import { admitTestAttempts, recordRunsBeforeRefusal, recordTestAttempt } from './attempts.mjs';
import { readSealedStoryTestPolicy } from './test-policy.mjs';

export const REPOSITORY_TESTS_SOURCE = 'repository-tests';
const SETUP_ROUTE = "Set the repository's test commands, which every step that runs tests uses (Configuration Center → Tests, or "
  + `tests: in singularity/workflow.yml).\n${formatCommandRouteLines({ copilotCommand: '/sf-test-setup', command: 'singularity-flow capability test-setup --json' }).join('\n')}`;

function note(id, reason, at) {
  return {
    id, command: "the repository's own tests", kind: 'test', requirement: 'advisory', source: REPOSITORY_TESTS_SOURCE,
    startedAt: at, completedAt: at, status: 'skipped-warning', exitCode: null, stdout: '', stderr: reason
  };
}

/**
 * What a non-code step's submission adds: the inferred commands to run and the notes to record.
 * `configured` is the step's own resolved command list.
 */
export async function verificationRepositoryTests(root, config, workflow, phase, configured = [], { at = nowIso() } = {}) {
  const pinned = workflow.resolution?.phases?.find((entry) => entry.id === phase.id) ?? null;
  const none = { commands: [], notes: [] };
  if (pinned?.repositoryTests !== 'run' || pinned.testEvidenceFrom || configured.some(isTestQualityCommand)) return none;
  // Owner, 2026-11-06: on only its new and changed tests a Story never runs the others, and the review says so [TCE:REQ-094].
  // Owner, 2026-11-08: but its last step that runs tests runs once the existing tests that import a changed module [CQF:REQ-017].
  let importers = null;
  if (storyTestScope(workflow) === 'new-and-changed') {
    const change = workflow.testScopeChanges?.at(-1);
    const scoped = `this Story runs only its new and changed tests${change ? ` (${change.id}, ${change.actor}: ${change.reason})` : ''}`;
    const selection = await import('./test-scope-selection.mjs');
    importers = selection.lastTestingStep(workflow, phase) ? await selection.storyExistingImporters(root, workflow, phase) : null;
    if (!importers?.length) {
      return { commands: [], notes: [note('repository-tests', `Not run: ${scoped}, so its existing tests were not run${importers ? '; none of them imports a module it changed' : ''}.`, at)] };
    }
  }
  const sealed = await readSealedStoryTestPolicy(root, config, workflow);
  if (sealed?.record?.baselineFailures === 'accept-pre-existing'
      || workflow.testRecovery || workflow.resolution?.testRecovery?.enabled === true) {
    return { commands: [], notes: [note('repository-tests', 'Not run: this Story accepted known test failures, '
      + "so verification relies on the code step's reviewed test evidence.", at)] };
  }
  const code = reviewCodeSource(workflow, phase);
  const codeStatus = code?.deliveryEvidence?.validation?.status;
  if (code && codeStatus && codeStatus !== 'passed') {
    return { commands: [], notes: [note('repository-tests', `Not run: the tests of '${code.id}' did not pass here (${codeStatus}); `
      + 'their accepted risk covers this step too.', at)] };
  }
  let inferred;
  try {
    inferred = await inferRepositoryTestCommands(root);
  } catch (error) {
    return { commands: [], notes: [note('repository-tests', `Not run: ${error.message} ${SETUP_ROUTE}`, at)] };
  }
  const ids = new Set(configured.map((command) => command?.id).filter(Boolean));
  let commands = inferred.filter(Boolean).filter((command) => !ids.has(command.id))
    .map((command) => ({ ...command, requirement: 'required' }));
  if (!commands.length) {
    return { commands: [], notes: [note('repository-tests', `Not run: sflow found no test command in this repository's build files. ${SETUP_ROUTE}`, at)] };
  }
  if (importers) {
    // Only those files, each told to the command that covers it; a runner that cannot be told files runs none of them.
    commands = (await (await import('./test-scope-selection.mjs')).newAndChangedTestCommands(root,
      commands.map((command) => ({ ...command, provenance: 'inferred' })), [], { importers })).filter((command) => command.testScope?.importers?.length);
    if (!commands.length) {
      return { commands: [], notes: [note('repository-tests', `Not run: the existing tests that import a module this Story changed (${importers.join(', ')}) `
        + "cannot be run alone by this repository's test command, and this Story runs only its new and changed tests.", at)] };
    }
  }
  return { commands, notes: [] };
}

/**
 * Mark the checks the repository's tests produced, record a run that could not start as not run,
 * and add the notes. Returns the failed repository-test checks a reviewer must see.
 */
export function settleRepositoryTestChecks(checks, added) {
  if (!added) return [];
  const ids = new Set(added.commands.map((command) => command.id));
  const failed = [];
  for (const check of checks) {
    if (!ids.has(check.id)) continue;
    check.source = REPOSITORY_TESTS_SOURCE;
    if (check.infrastructureUnavailable) {
      check.status = 'unavailable';
      check.requirement = 'advisory';
      check.stderr = `Not run here: ${check.stderr} Install it, or run the tests where it is installed.`;
    } else if (['failed', 'blocked'].includes(check.status)) failed.push(check);
  }
  checks.push(...added.notes);
  return failed;
}

/**
 * A non-code step's repository-test runs, fresh or reused, as the Story binds them [CQF:REQ-010]. Each fresh
 * run is recorded as an attempt of this step; a run that stood is named by the attempt it reused, and one
 * another step or generation made says so in `reusedFrom`. Its status is its attempt's, judged by its counts.
 */
export async function bindRepositoryTestRuns(root, itemRelative, { commands, checks, purpose, workflow, phase, generation }) {
  const runs = [];
  for (const command of commands) {
    const check = checks.find((entry) => entry.id === command.id);
    if (!check || check.status === 'skipped-warning' || check.infrastructureUnavailable) continue;
    const recorded = check.unchangedRun ?? await recordTestAttempt(root, itemRelative, {
      command, check, purpose, workId: workflow.workItem.id, phaseId: phase.id, generation });
    const { attempt } = recorded;
    const elsewhere = attempt.phase !== phase.id || Number(attempt.generation) !== Number(generation);
    runs.push({ commandId: command.id, attemptId: attempt.attemptId, receiptPath: recorded.path, receiptSha256: recorded.sha256,
      status: attempt.status, counts: attempt.tests ?? null, ...(elsewhere ? { reusedFrom: { attemptId: attempt.attemptId, phase: attempt.phase } } : {}),
      ...(command.testScope?.importers ? { importers: command.testScope.importers } : {}) });
  }
  return runs;
}

/**
 * A non-code step whose workflow runs the repository's tests runs or reuses them at publication, so its
 * document can cite its own run, and submission reuses that run [CQF:REQ-012]. A failure refuses nothing
 * here: submission runs it again, and a failure there goes to the step's reviewer as before. `kernel` is
 * the gates' own runner (state.mjs localTestRunKernel).
 */
export async function preflightRepositoryTests(root, config, workflow, phase, kernel) {
  const configured = await resolveDeliveryQualityCommands(root, phase, { executionMode: storyTestScope(workflow) });
  const added = await verificationRepositoryTests(root, config, workflow, phase, configured);
  if (!added.commands.length) return null;
  const itemRelative = workDirRelative(config, workflow.workItem.id);
  const fields = { purpose: 'preflight', workId: workflow.workItem.id, phaseId: phase.id, generation: nextPhaseGeneration(phase) };
  const checks = await kernel.qualityChecks(root, phase, config, workflow, added.commands, {
    commandProvenance: new Map(added.commands.map((command) => [command, testCommandProvenance(phase, command)])),
    reuseUnchanged: kernel.mayReuseUnchangedRuns(workflow),
    onMutation: (ran) => recordRunsBeforeRefusal(root, itemRelative, added.commands, ran, fields)
  });
  try {
    const runs = await bindRepositoryTestRuns(root, itemRelative, { commands: added.commands, checks, workflow, phase, ...fields });
    const failed = runs.filter((run) => run.status !== 'passed').map((run) => `${run.commandId}${Number(run.counts?.discovered) === 0 ? ' (no tests ran)' : ''}`);
    if (failed.length) console.warn(`Warning: the repository's tests did not pass here: ${failed.join(', ')}. ${phase.id} still publishes; submission runs them again.`);
    await admitTestAttempts(root, itemRelative, workflow.workItem.id, phase.id);
    return runs;
  } finally {
    for (const check of checks) await kernel.restoreTransientQualityResult(check);
  }
}
