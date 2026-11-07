/** Git decision execution. Legacy writer functions are explicit compatibility dependencies;
 * this port never calls CLI dispatch, argument parsing or another executable. */
import {actionActor} from '../git.mjs';
import {loadAcceptedStoryExecution} from '../accepted-story-execution.mjs';
import {loadConfig} from '../state-stores.mjs';
import {readPendingList} from '../decision-list-reads.mjs';
import {loadSession} from '../session.mjs';
import {parseDecisionAnswers,decisionPolicyPacket} from '../kernel/decision-plan.mjs';
import {legacyDecisionPlan,effectWords} from '../decision-list.mjs';
import {nowIso} from '../util.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';

async function applyEffect(root, config, workflow, effect, step, produced, { actor, agent }) {
  if (effect.kind === 'upstream-issue') {
    const { commitUpstreamIssue } = await import('../commands/upstream-issue.mjs');
    return commitUpstreamIssue(root, config, workflow, { phase: effect.phase, about: effect.about, problem: effect.problem,
      assumption: null, impact: null, proposed: 'unknown', source: null, supersedes: null }, { actor, agent });
  }
  if (effect.kind === 'evidence-reuse') {
    const { recordEvidenceReuseDecision } = await import('../commands/decision-evidence-reuse.mjs');
    return (await recordEvidenceReuseDecision(root, config, workflow, { phaseId: effect.phase, attemptId: effect.attemptId,
      reason: step.values.reason }, { actor, agent })).record;
  }
  if (effect.kind === 'plan-amendment') {
    const { commitPlanAmendment } = await import('../commands/decision-plan-amendment.mjs');
    const changes = (effect.changes ?? [effect.change]).map((change) => (change.kind === 'add-supporting' ? { ...change, reason: step.values.reason } : change));
    return (await commitPlanAmendment(root, config, workflow, { changes, reason: step.values.reason }, { actor, agent })).amendment;
  }
  if (effect.kind === 'node-pin') {
    const { commitNodePin } = await import('../commands/decision-plan-amendment.mjs');
    return commitNodePin(root, config, workflow, { version: effect.version, replaces: effect.replaces ?? null, reason: step.values.reason }, { actor, agent });
  }
  if (effect.kind === 'obligation-risk') {
    const { commitRiskDecision } = await import('../commands/decision-obligation-risk.mjs');
    return (await commitRiskDecision(root, config, workflow, { obligationId: effect.obligation, category: effect.category,
      expires: step.values.expires, reason: step.values.reason }, { actor, agent })).record;
  }
  if (effect.kind === 'visual-profile') {
    const { recordVisualProfileDecisionFor } = await import('../commands/decision-visual-profile.mjs');
    return (await recordVisualProfileDecisionFor(root, config, workflow, { phaseId: effect.phase, profileId: effect.profileId,
      reason: step.values.reason }, { actor, agent })).record;
  }
  if (['scope-disposition', 'completeness-review', 'applicability', 'routing'].includes(effect.kind)) {
    const records = await import('../commands/decision-story-records.mjs');
    if (effect.kind === 'scope-disposition') return (await records.commitScopeDecision(root, config, workflow, { item: effect.item, disposition: effect.disposition,
      clauseIds: step.values.clause ?? [], reason: step.values.reason }, { actor, agent })).decision;
    if (effect.kind === 'completeness-review') return (await records.commitCompletenessReview(root, config, workflow, { confirm: effect.inventorySha256,
      checklist: step.values.article, reason: step.values.reason }, { actor, agent })).review;
    if (effect.kind === 'applicability') return (await records.commitApplicabilityDecision(root, config, workflow, { responsibility: effect.responsibility,
      reason: step.values.reason }, { actor, agent })).decision;
    return (await records.commitRoutingChoice(root, config, workflow, { option: effect.option ?? null, to: effect.to ?? null, reason: step.values.reason, expected: effect.key },
      { actor, agent })).result.outcome;
  }
  if (effect.kind === 'test-command') {
    const { recordStoryTestCommand } = await import('../commands/decision-test-command.mjs');
    return (await recordStoryTestCommand(root, config, workflow, { accept: effect.request, reason: step.values.reason ?? '' }, { actor, agent })).record;
  }
  if (effect.kind === 'test-narrowing') {
    const { recordTestNarrowingDecision } = await import('../commands/decision-test-narrowing.mjs');
    return (await recordTestNarrowingDecision(root, config, workflow, { phaseId: effect.phase, commandId: effect.commandId,
      reason: step.values.reason }, { actor, agent })).record;
  }
  if (effect.kind === 'test-run-risk') {
    const { recordTestRunRiskDecision } = await import('../commands/decision-test-risk.mjs');
    return (await recordTestRunRiskDecision(root, config, workflow, { phaseId: effect.phase, commandId: effect.commandId,
      cause: step.values.cause, reason: step.values.reason, expires: step.values.expires }, { actor, agent })).record;
  }
  const { decideUpstreamIssueRecord } = await import('../commands/upstream-issue.mjs');
  const issueId = effect.issue ?? produced.issue;
  const { value } = await decideUpstreamIssueRecord(root, config, workflow, issueId, { outcome: effect.outcome, reason: step.values.reason,
    expires: effect.outcome === 'accept-risk' ? step.values.expires : null }, { actor, agent });
  const { changeRequest, ...decision } = value;
  return { ...decision, ...(changeRequest ? { changeRequestId: changeRequest.id } : {}) };
}

function recordId(kind, record) {
  if (kind === 'upstream-issue-decision') return `${record?.issue} ${record?.outcome}`;
  if (kind === 'scope-disposition') return `${record?.item} ${record?.disposition}`;
  if (kind === 'completeness-review') return 'completeness review';
  if (kind === 'applicability') return `${record?.responsibility} does not apply`;
  if (kind === 'routing') return `route ${record?.route}`;
  return record?.id ?? record?.accepts ?? record?.revokes ?? null;
}

export function createGitDecisionPort({root,interaction=null,onContext=()=>{},notice=()=>{}}) {
  const prepare=typeof interaction?.prepare==='function' ? interaction.prepare.bind(interaction) :
    async(context,input)=>({answers:parseDecisionAnswers(input.answers ?? {}),confirmation:input.confirmation ?? null});
  return {
    async load(input) {
      if(input.workId) {
        const {checkoutStoryBranch}=await import('../story-branch-name.mjs');
        await checkoutStoryBranch(root,await loadConfig(root),input.workId,{fetch:input.fetch === true});
      }
      const accepted=await loadAcceptedStoryExecution(root,input.workId ?? undefined);
      const config=accepted.definition,workflow=accepted.workflow;
      if(workflow.status!=='in_progress')throw new SingularityFlowError(
        `Story ${workflow.workItem.id} is ${workflow.status}; decisions are recorded while it is in progress.`,{code:'DECISIONS_STORY_CLOSED'});
      const phaseId=input.phaseId ?? null,at=nowIso();
      const packet=await readPendingList(root,config,workflow,{phaseId,at});
      // Native list builders may omit optional fields. Capture their actual JSON wire data once;
      // no caller-supplied packet, actor, authority or effect plan enters the operation.
      const policy=JSON.parse(JSON.stringify(decisionPolicyPacket(packet)));
      const context={root,config,workflow,phaseId,at,packet,policy,subject:Object.freeze({kind:'story',id:workflow.workItem.id})};
      onContext(context);return context;
    },
    prepare,
    async apply(context,effect,step,produced) {
      if(!context.who) {
        const actor=actionActor(root),session=await loadSession(root,{required:false});
        context.who={actor,agent:session?.workId===context.workflow.workItem.id ? session.agent ?? null : null};
      }
      return applyEffect(root,context.config,context.workflow,effect,step,produced,context.who);
    },
    async finish(context,plan,outcome) {
      const {config,workflow,phaseId}=context;
      const legacy=legacyDecisionPlan(context.packet,plan);
      const recorded=outcome.recorded.map(entry=>({item:entry.item,kind:entry.kind,record:recordId(entry.kind,entry.record),value:entry.record}));
      const remaining=outcome.remaining.map(entry=>({item:entry.item,kind:entry.kind,words:effectWords(workflow,entry.effect,
        plan.steps.find(step=>step.item===entry.item)?.values ?? {})}));
      if(outcome.failed) {
        const error=outcome.failed.error,list=`singularity-flow decisions ${workflow.workItem.id}`;
        throw new SingularityFlowError(
          `${recorded.length ? `Recorded ${recorded.map(entry=>`${entry.item}: ${entry.record}`).join(', ')}; then ` : ''}`
          +`${outcome.failed.item} stopped: ${error.message} Not recorded: ${remaining.map(entry=>`${entry.item}: ${entry.words}`).join('; ')}. `
          +`List what remains with: ${list}`,
          {code:recorded.length ? 'DECISIONS_PARTLY_RECORDED' : error.code ?? 'DECISIONS_RECORD_FAILED',
            details:{recorded,remaining,failed:{item:outcome.failed.item,kind:outcome.failed.kind,code:error.code ?? null,message:error.message},
              cause:error.details ?? null,nextAction:{command:list,skill:'/sf-decide',label:'List what remains to decide.'}}});
      }
      let after=null;
      try {after=await readPendingList(root,config,workflow,{phaseId,at:nowIso()});}
      catch(error) {
        context.inspectionError=error;
        try {await notice({code:'decisions.inspection-unavailable',workId:workflow.workItem.id,error});}
        catch(observerError) {context.noticeError=observerError;}
      }
      Object.assign(context,{plan,legacyPlan:legacy,recorded,after});
      return JSON.parse(JSON.stringify({workId:workflow.workItem.id,phase:context.packet.phase ?? null,
        recorded,refused:plan.refused,remaining:after?.items.map(item=>({id:item.id,kind:item.kind,title:item.title})) ?? null,
        packetSha256:after?.packetSha256 ?? null}));
    }
  };
}
