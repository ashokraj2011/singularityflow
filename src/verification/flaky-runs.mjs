/**
 * Flaky test commands [CQF:REQ-013]: runs of one command on the same code and environment that disagree.
 * Read by the review packet and `tests summary`, only when asked, so no gate loads it.
 */
import { workDirRelative } from '../story-paths.mjs';
import { stepAttempts } from './attempts.mjs';

/**
 * The commands whose runs disagree on the same code and environment: one failed and one passed [CQF:REQ-013].
 * A run is compared with the others of the same program, folder, report form, application source, test
 * inputs and environment, whichever step made it. A reused run is a copy, not a run, and a run given an
 * environment's values cannot be compared, so neither counts. It is a fact for a person; it refuses nothing.
 */
export function flakyTestRuns(attempts) {
  const groups = new Map();
  for (const attempt of attempts) {
    if (attempt.reusedFrom || attempt.evidenceClass === 'local-integration' || !['passed', 'failed'].includes(attempt.status)
        || !attempt.candidate?.treeSha256 || !attempt.environmentSha256) continue;
    // Documentation is not the code it ran on [CQF:REQ-011].
    const key = JSON.stringify([attempt.argvSha256, attempt.workingDirectory, attempt.adapter, attempt.candidate.codeTreeSha256 ?? attempt.candidate.treeSha256,
      attempt.candidate.testInputSha256 ?? null, attempt.environmentSha256]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(attempt);
  }
  return [...groups.values()].filter((runs) => runs.some((run) => run.status === 'passed') && runs.some((run) => run.status === 'failed'))
    .map((runs) => {
      const ids = (status) => runs.filter((run) => run.status === status).map((run) => run.attemptId);
      const [failed, passed] = [ids('failed'), ids('passed')];
      return { commandId: runs.at(-1).commandId, attemptIds: runs.map((run) => run.attemptId), failed, passed,
        treeSha256: runs[0].candidate.treeSha256,
        words: `${runs.at(-1).commandId} is flaky: on the same code and environment ${failed.join(', ')} failed and ${passed.join(', ')} passed` };
    });
}

/** Every step's recorded runs of a Story, read once, and the flaky commands among them [CQF:REQ-013]. */
export async function storyFlakyTestRuns(root, itemRelative, workflow) {
  const attempts = [];
  for (const id of workflow.phaseOrder ?? []) attempts.push(...await stepAttempts(root, itemRelative, workflow.workItem.id, id));
  return flakyTestRuns(attempts);
}

/**
 * The review packet's flaky commands: those this step ran or reused whose runs disagree, in any step. Read
 * only for a step with test runs; {} when none is flaky.
 */
export async function flakyTestReview(root, config, workflow, phase) {
  const reused = (phase.checks ?? []).map((check) => check.reusedFrom?.attemptId).filter(Boolean);
  if (!phase.deliveryEvidence && !reused.length && !(phase.checks ?? []).some((check) => check.kind === 'test')) return {};
  const itemRelative = workDirRelative(config, workflow.workItem.id);
  const own = new Set([...(await stepAttempts(root, itemRelative, workflow.workItem.id, phase.id)).map((attempt) => attempt.reusedFrom?.attemptId ?? attempt.attemptId), ...reused]);
  const flaky = (await storyFlakyTestRuns(root, itemRelative, workflow)).filter((entry) => entry.attemptIds.some((id) => own.has(id)));
  return flaky.length ? { flakyTestRuns: flaky.map(({ commandId, failed, passed, words }) => ({ commandId, failed, passed, words })) } : {};
}
