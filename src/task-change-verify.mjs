/**
 * The check every reader runs after an accepted task change [ITW:REQ-009], beside verifyAcceptedTestCommandAmendment
 * (story-test-command-amendment.mjs): kept apart from the writer (task-amendment.mjs) so a reader loads only this.
 */
import { canonicalJson } from './records.mjs';
import { SingularityFlowError } from './util.mjs';

const same = (left, right) => canonicalJson(left ?? null) === canonicalJson(right ?? null);

/**
 * Protect every reader after an accepted task change, as verifyAcceptedTestCommandAmendment does for a test command: the
 * Story's changes, composition and steps are exactly those its accepted revision committed, and each added step is in
 * the Story. The snapshot chain itself replays each change against its decision (workflow-snapshots.mjs).
 */
export async function verifyAcceptedTaskChanges(root, config, workflow, verified = null) {
  const changes = workflow?.taskChanges ?? [];
  if (!changes.length) return;
  const [{ prospectiveTestCommandAmendment }, snapshots, contracts, { exactFileAtObject }, { storyLocation }] = await Promise.all([
    import('./test-command-amendment-contracts.mjs'), import('./workflow-snapshots.mjs'), import('./task-change-contracts.mjs'),
    import('./git.mjs'), import('./story-paths.mjs')]);
  if (prospectiveTestCommandAmendment(workflow)) return;
  const id = workflow.workItem.id;
  const stale = (message) => new SingularityFlowError(message, { code: 'TASK_CHANGE_STALE',
    details: { nextAction: { command: 'singularity-flow validate', label: 'Check the Story\'s record against its history.' } } });
  verified ??= await snapshots.verifyWorkflowSnapshot(root, config, workflow, { requireAccepted: true, retainBytes: true });
  const bytes = verified.acceptanceCommit
    ? exactFileAtObject(root, verified.acceptanceCommit, storyLocation(null, config, id).record(`workflow.json`), { maximumBytes: 16 * 1024 * 1024 }) : null;
  if (!bytes) throw stale(`${id}'s added steps cannot be read from the commit that accepted them.`);
  const accepted = JSON.parse(bytes.toString('utf8'));
  if (!same(accepted.taskChanges, workflow.taskChanges) || !same(accepted.resolution?.composition, workflow.resolution?.composition)) {
    throw stale(`${id}'s added steps differ from the ones its history accepted.`);
  }
  const order = (workflow.resolution?.phases ?? []).map((phase) => phase.id);
  if (!same(order, workflow.phaseOrder) || !same(order, (workflow.resolution?.composition?.steps ?? []).map((step) => step.id))) {
    throw stale(`${id}'s steps differ from its task's steps.`);
  }
  for (const summary of changes) {
    contracts.validateTaskChangeSummary(summary);
    if (!workflow.phases?.[summary.phaseId] || !workflow.phaseOrder.includes(summary.phaseId)) throw stale(`${id} has lost the ${summary.phaseId} step it gained.`);
  }
}
