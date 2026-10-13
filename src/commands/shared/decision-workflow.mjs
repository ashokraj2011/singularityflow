/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { repoRoot, branch } from '../../git.mjs';
import { optionString, optionBoolean, SingularityFlowError } from '../../util.mjs';
import { loadStoryDecisionExecution } from '../../story-decision-context.mjs';
import { prefetchStoryPublicationObservation, assertNoPendingPublication, previewTestingRepair } from '../../state-stores.mjs';
import { assertPhaseSequence } from '../../sequence.mjs';
import { assertLifecycleWorktreeClean } from '../../lifecycle-worktree.mjs';
import { resolveSelectionReceipt } from '../../choices.mjs';
import { phaseUsesDeterministicGeneration } from '../../manual-authorship.mjs';
import { actionActor, activatePhaseAgent } from '../kernel.mjs';

export async function decisionWorkflow(positionals, options, action) {
  const root = repoRoot();
  const receiptToken = optionString(options, 'selection-receipt');
  const { requestedPhase, definition: config, workflow } = await loadStoryDecisionExecution(root, positionals, options, action);
  prefetchStoryPublicationObservation(root, config, workflow);
  if (action === 'approve' && requestedPhase && workflow.phases[requestedPhase]?.status === 'approved') {
    await assertPhaseSequence(root, workflow, action, { requestedPhase });
  }
  if (receiptToken) assertLifecycleWorktreeClean(root, null, null, { workId: optionString(options, 'work-id') ?? branch(root) });
  if (action === 'approve') assertLifecycleWorktreeClean(root, config, workflow);
  const workId = workflow.workItem.id;
  const overridesBefore = workflow.sequenceOverrides?.length ?? 0;
  await assertNoPendingPublication(root, config, workflow, action);
  const testingRepair = action === 'reject' && optionBoolean(options, 'repair');
  if (testingRepair && optionString(options, 'selection-receipt')) {
    throw new SingularityFlowError(
      'Early review repair requires an exact phase and Code target, without a selection receipt.',
      { code: 'TESTING_REPAIR_ROUTE_INVALID' }
    );
  }
  const phase = await assertPhaseSequence(root, workflow, action, {
    requestedPhase,
    allowedStatuses: testingRepair ? ['in_progress'] : ['awaiting_approval']
  });
  const testingRepairPlan = testingRepair ? await previewTestingRepair(root, config, workflow) : null;
  if (testingRepairPlan && (requestedPhase !== testingRepairPlan.phase
      || optionString(options, 'to') !== testingRepairPlan.targetPhase)) {
    throw new SingularityFlowError(
      `Early review repair requires reject ${testingRepairPlan.phase} --to ${testingRepairPlan.targetPhase} --repair.`,
      { code: 'TESTING_REPAIR_ROUTE_INVALID' }
    );
  }
  if (testingRepairPlan && optionString(options, 'confirm') !== testingRepairPlan.confirmation) {
    throw new SingularityFlowError(
      `The review contains source or test edits. Review ${testingRepairPlan.changedPaths.join(', ')} and return them to Code only after confirmation. `
      + 'Copilot: /sf-reject. '
      + `Shell: singularity-flow reject ${testingRepairPlan.phase} --to ${testingRepairPlan.targetPhase} --repair --reason <REASON> --confirm ${testingRepairPlan.confirmation}. VS Code (model-free): not available for this action.`,
      { code: 'TESTING_REPAIR_CONFIRMATION_REQUIRED', details: { plan: testingRepairPlan } }
    );
  }
  const receipt = receiptToken
    ? await resolveSelectionReceipt(root, config, receiptToken, { action, workId: workflow.workItem.id, workflow })
    : null;
  const session = phaseUsesDeterministicGeneration(phase)
    ? { actor: actionActor(root), agent: null }
    : await activatePhaseAgent(
        root, config, workflow.workItem.id, phase, optionString(options, 'agent') ?? null,
        // `config` already carries this Story's verified saved agent catalog. Passing the workflow
        // here would verify the same closure a second time inside the same approval operation.
        null
      );
  for (const override of (workflow.sequenceOverrides ?? []).slice(overridesBefore)) {
    override.actor = session.actor;
    override.agent = session.agent;
    const history = workflow.history?.find((event) => event.event === 'sequence_gate_overridden' && event.at === override.at);
    if (history) {
      history.actor = session.actor.login ?? session.actor.email ?? session.actor.name ?? 'interactive-user';
      history.agent = session.agent;
    }
  }
  return { root, config, workflow, phase, session, receipt, receiptToken, testingRepairPlan };
}
