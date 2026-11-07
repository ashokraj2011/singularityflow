/** Native decision-test-command recording. Existing authority, record and transaction semantics are retained. */
import {requireApprovalAuthority} from '../kernel/approval-policy.mjs';
import {testRunRiskAuthorities,testCommandDecisionPhase as decidingStep} from '../kernel/approval-fallback.mjs';
import {recordStoryTestCommandDecision,recordStoryTestCommandRequest,storyTestCommandState} from '../story-test-commands.mjs';
import {LIFECYCLE_EVENT} from '../lifecycle-event.mjs';
import {actorKey,assertNoPendingPublication,transactStory} from '../state-stores.mjs';
import {nowIso,SingularityFlowError} from '../util.mjs';
const fail=(message,code='TEST_COMMAND_DECISION_INVALID')=>{throw new SingularityFlowError(message,{code});};

/**
 * Record a request, or a person's acceptance or revocation of one, and commit it. The command and
 * the decision list both record through this, so authority, the record and its commit are the same.
 */
export async function recordStoryTestCommand(root, config, workflow, { phaseId = null, command = null, repin = null, accept = null, revoke = null, reason = '' }, { actor, agent = null }) {
  const id = workflow.workItem.id;
  const target = accept ?? revoke;
  const requested = target ? storyTestCommandState(workflow, target)?.request : null;
  if (target && !requested) fail(`This Story has no test command request ${target}.`, 'TEST_COMMAND_DECISION_UNKNOWN');
  const phase = target ? requested.phase : phaseId;
  let authority = null;
  if (target) {
    const groups = testRunRiskAuthorities(workflow, phase);
    if (!groups.length) fail(`Step ${phase} has no approval group, so nobody can decide its test commands.`, 'RISK_AUTHORITY_UNAVAILABLE');
    authority = requireApprovalAuthority(workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
      { mode: 'required', authorities: groups, requiredAuthorities: [], minimum: 1 }, actor);
  }
  const common = { actor: actorKey(actor), at: nowIso() };
  const decide = (aggregate) => target
    ? recordStoryTestCommandDecision(aggregate, { id: target, outcome: accept ? 'accept' : 'revoke', reason, ...common,
      authorityGroup: authority.authorityGroup, identityAssurance: authority.identityAssurance ?? null,
      selfApproval: aggregate.phases?.[decidingStep(aggregate, phase)]?.approvalPolicy?.allowSelfApproval !== false })
    : recordStoryTestCommandRequest(aggregate, { phaseId, command, repin, reason, ...common });
  const preview = decide(structuredClone(workflow));
  if (!target && storyTestCommandState(workflow, preview.id)) return { record: preview, publication: null, reused: true };
  const verb = accept ? 'accept' : revoke ? 'revoke' : 'request';
  const { value: record, publication } = await transactStory(
    root, config, workflow,
    { type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: phase, generation: null, actor, agent,
      authorityGroup: authority?.authorityGroup ?? null, payload: { decision: 'test-command' } },
    `[${id}][test-command:${verb}] ${target ?? `${phase} ${command.id}`}`,
    async (aggregate) => {
      await assertNoPendingPublication(root, config, aggregate, 'record a test command decision');
      const recorded = decide(aggregate);
      aggregate.history.push({
        at: recorded.at, actor: recorded.actor ?? recorded.requestedBy, agent, event: 'test_command_decided', phase,
        detail: recorded.id
          ? `${recorded.id} requests that ${phase} ${recorded.repin ? `re-pin test command ${recorded.command.id} (${recorded.repin.changes.join('; ')})` : `run test command ${recorded.command.id}`} for this Story. ${recorded.reason}`
          : `${target} ${accept ? 'accepted' : 'revoked'} through ${recorded.authorityGroup}.${recorded.reason ? ` ${recorded.reason}` : ''}`
      });
      return recorded;
    },
    { eventFromResult: (recorded) => ({ actor, agent, authorityGroup: recorded.authorityGroup ?? null, identityAssurance: recorded.identityAssurance ?? null,
      payload: { decision: 'test-command', record: recorded.id ?? target, outcome: verb, reviewPacketSha256: null } }) }
  );
  return { record, publication };
}
