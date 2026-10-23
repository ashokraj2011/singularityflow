/**
 * The repository's own tests, run when a verification step is submitted.
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
 * A repository with no test command sflow can find gets a note naming how to add one, and a run
 * that could not start (its launcher is not installed here) is recorded as not run. Neither holds
 * the step. A run that fails does not refuse the submission either: the step waits for review,
 * and its reviewer returns it to the step that repairs it.
 */
import { isTestQualityCommand, reviewCodeSource } from '../delivery-evidence.mjs';
import { inferRepositoryTestCommands } from '../repository-test-command-inference.mjs';
import { nowIso } from '../util.mjs';
import { readSealedStoryTestPolicy } from './test-policy.mjs';

export const REPOSITORY_TESTS_SOURCE = 'repository-tests';
const SETUP_ROUTE = "Name the repository's test command in this step's checks (Workflow Studio, or qualityCommands in "
  + 'singularity/workflow.yml); Copilot: /sf-test-setup; Shell: singularity-flow capability test-setup --json.';

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
  const commands = inferred.filter(Boolean).filter((command) => !ids.has(command.id))
    .map((command) => ({ ...command, requirement: 'required' }));
  if (!commands.length) {
    return { commands: [], notes: [note('repository-tests', `Not run: sflow found no test command in this repository's build files. ${SETUP_ROUTE}`, at)] };
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
