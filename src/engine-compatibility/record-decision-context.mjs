/** Shared native admission facts. No CLI grammar or rendered output. */
import {actionActor} from '../git.mjs';
import {loadConfig} from '../state-stores.mjs';
import {loadAcceptedStoryExecution} from '../accepted-story-execution.mjs';
import {checkoutStoryBranch} from '../story-branch-name.mjs';
import {loadSession} from '../session.mjs';

export async function nativeDecisionRecordActor(context) {
  if (!context.who) {
    const actor = actionActor(context.root);
    const session = await loadSession(context.root, {required:false});
    context.who = {actor, agent:session?.workId === context.workflow.workItem.id ? session.agent ?? null : null};
  }
  return context.who;
}

export async function loadNativeDecisionRecordContext(root,input,operation) {
  const initial = await loadConfig(root);
  if (input.workId) await checkoutStoryBranch(root, initial, input.workId, {fetch:input.fetch === true});
  const accepted = await loadAcceptedStoryExecution(root, input.workId ?? undefined);
  const workflow = accepted.workflow;
  return {root, config:accepted.definition, workflow, pending:workflow.pendingDecision ?? null,
    phaseId:operation.id === 'decision.choose' ? workflow.pendingDecision?.after ?? null : workflow.currentPhase ?? null,
    subject:{kind:'story', id:workflow.workItem.id}};
}
