/**
 * `decision visual-risk`: an approver of the visual verification step accepts the risk of one failed
 * visual comparison, with an expiry and a reason [PHR:REQ-006], owner decision 2026-11-10. See
 * src/visual-risks.mjs.
 *
 *   singularity-flow decision visual-risk [WORK-ID] --comparison VISUAL-ID --expires YYYY-MM-DD --reason TEXT
 *
 * The Copilot guard refuses this command, like a dated risk: an agent may name the route, never decide it.
 */
import { checkoutStoryBranch } from '../story-branch-name.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { requireApprovalAuthority } from '../approval-authority.mjs';
import { riskAuthorities } from '../evidence/risk-decisions.mjs';
import { repoRoot } from '../git.mjs';
import { LIFECYCLE_EVENT } from '../lifecycle-event.mjs';
import { commandResult, effects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { visualVerificationPhaseOf } from '../phase-roles.mjs';
import { loadSession } from '../session.mjs';
import { actorKey, assertNoPendingPublication, loadConfig, transactStory } from '../state-stores.mjs';
import { workDir } from '../story-paths.mjs';
import { nowIso, optionBoolean, optionString, SingularityFlowError } from '../util.mjs';
import { listVisualComparisons } from '../visual-compare.mjs';
import { recordVisualRisk } from '../visual-risks.mjs';
import { actionActor } from './kernel.mjs';

export async function decisionVisualRiskCommand(positionals, options) {
  const root = repoRoot();
  const requestedId = positionals[2] ?? optionString(options, 'work-id') ?? null;
  let config = await loadConfig(root);
  if (requestedId) await checkoutStoryBranch(root, config, requestedId, { fetch: optionBoolean(options, 'fetch') });
  const accepted = await loadAcceptedStoryExecution(root, requestedId ?? undefined);
  config = accepted.definition;
  const workflow = accepted.workflow;
  const id = workflow.workItem.id;
  if (workflow.status !== 'in_progress') {
    throw new SingularityFlowError(`Story ${id} is ${workflow.status}; a visual risk is accepted while it is in progress.`, { code: 'VISUAL_RISK_INVALID' });
  }
  const step = visualVerificationPhaseOf(workflow, null);
  if (!step) throw new SingularityFlowError(`Story ${id} has no visual verification step to accept a comparison's risk for.`, { code: 'VISUAL_RISK_INVALID' });
  const comparisonId = optionString(options, 'comparison') ?? '';
  const comparison = (await listVisualComparisons(root, workflow, { itemDirectory: workDir(root, config, id) }))
    .find((entry) => entry.id === comparisonId) ?? null;
  // Whoever approves the visual step decides; an exact, live comparison only.
  const groups = riskAuthorities(workflow, { owningSteps: [step.id] });
  if (!groups.length) throw new SingularityFlowError(`${step.id} has no approval group, so nobody can accept this risk.`, { code: 'VISUAL_RISK_INVALID' });
  const actor = actionActor(root);
  const authority = requireApprovalAuthority(workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    { mode: 'required', authorities: groups, requiredAuthorities: [], minimum: 1 }, actor);
  const loadedSession = await loadSession(root, { required: false });
  const agent = loadedSession?.workId === id ? loadedSession.agent ?? null : null;
  const request = { comparison, phase: step.id, expires: optionString(options, 'expires'), reason: optionString(options, 'reason') ?? '',
    actor: actorKey(actor), authorityGroup: authority.authorityGroup, identityAssurance: authority.identityAssurance ?? null };
  // Checked before anything is written, so a refusal changes nothing.
  recordVisualRisk(structuredClone(workflow), { ...request, at: nowIso() });
  const { value: record, publication } = await transactStory(root, config, workflow, {
    type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: workflow.currentPhase ?? null, generation: null,
    actor, agent, authorityGroup: authority.authorityGroup, payload: { decision: 'visual-risk' }
  }, `[${id}][visual-risk] ${comparisonId}`, async (aggregate) => {
    await assertNoPendingPublication(root, config, aggregate, 'accept a visual risk');
    const recorded = recordVisualRisk(aggregate, { ...request, at: nowIso() });
    aggregate.history.push({ at: recorded.at, actor: recorded.actor, agent, event: 'visual_risk_accepted', phase: aggregate.currentPhase ?? null,
      detail: `${recorded.id}: the failed comparison ${recorded.comparisonId} is accepted until ${recorded.expiresAt.slice(0, 10)}. ${recorded.reason}` });
    return recorded;
  }, {
    exactWorkItemPaths: [],
    eventFromResult: (recorded) => ({ actor, agent, authorityGroup: recorded.authorityGroup, identityAssurance: recorded.identityAssurance,
      payload: { decision: 'visual-risk', record: recorded.id, reviewPacketSha256: null } })
  });
  if (!optionBoolean(options, 'json')) {
    console.log(`Recorded ${record.id}: the failed comparison ${record.comparisonId} is accepted until ${record.expiresAt.slice(0, 10)}, through ${record.authorityGroup}. It is not passing evidence.`);
    console.log(publication.pushed
      ? `Decision committed and pushed.`
      : `Decision committed locally; push is disabled by git.publish: off.`);
  }
  emitCommandResult(commandResult({
    operation: { id: 'decision.visual-risk', classification: 'mutation' },
    subject: { kind: 'story', id },
    outcome: succeeded('decision.visual-risk.succeeded', { record: record.id }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }),
    data: { commit: publication.sha, pushed: publication.pushed, record }
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}
