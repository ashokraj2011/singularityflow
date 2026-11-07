/** Standalone decision CLI adapters. Registered operations own admission and native effects. */
import {repoRoot} from '../git.mjs';
import {optionString,optionStrings,optionBoolean} from '../util.mjs';
import {createGitEngine} from '../engine-compatibility/git-publication.mjs';
import {checklistDecisions} from './shared/checklist-decisions.mjs';
import {applicabilityStatus} from '../evidence/applicability.mjs';
import {presentPostPublicationNotice} from '../phase-post-transition-guidance.mjs';
import {formatContextBoundaryHandoff} from '../context-policy.mjs';
import {recordedCompletion,printCompletionVerdict} from '../completion-verdict.mjs';
import {completionContinuation} from './shared/completion-continuation.mjs';
import {emitCommandResult} from '../narration/emit.mjs';
import {commandResult,succeeded,effects} from '../narration/command-result.mjs';

async function parseRequest(operation,options) {
  if(operation==='decision.scope')return {item:optionString(options,'item')??null,
    disposition:optionString(options,'as')??null,
    clauseIds:String(optionString(options,'clause')??'').split(',').map(entry=>entry.trim()).filter(Boolean),
    reason:optionString(options,'reason')??''};
  if(operation==='decision.completeness')return {confirm:optionString(options,'confirm')??null,
    checklist:await checklistDecisions(options),reason:optionString(options,'reason')??''};
  if(operation==='decision.applicability')return {responsibility:optionString(options,'responsibility')??null,
    reason:optionString(options,'reason')??''};
  if(operation==='decision.risk') {
    const transitions=optionStrings(options,'transition');
    return {revoke:optionString(options,'revoke')??null,obligationId:optionString(options,'obligation')??null,
      category:optionString(options,'category')??null,transitions:transitions.length?transitions:['terminal'],
      expires:optionString(options,'expires')??null,reason:optionString(options,'reason')??''};
  }
  return {option:optionString(options,'option')??null,to:optionString(options,'to')??null,
    reason:optionString(options,'reason')??'',expected:optionString(options,'expected')??null};
}

async function executeDecision(operation,positionals,options) {
  const root=repoRoot();
  const binding=createGitEngine({root,notice:presentPostPublicationNotice,
    decisionRecordInteraction:{prepare:()=>parseRequest(operation,options)}});
  const receipt=await binding.engine.run(operation,{workId:positionals[2]??optionString(options,'work-id')??null,
    fetch:optionBoolean(options,'fetch')});
  return {receipt,context:binding.presentation()};
}

export async function decisionScopeCommand(positionals,options) {
  const {receipt,context}=await executeDecision('decision.scope',positionals,options);
  const {workflow}=context;
  const id=receipt.subject.id;
  const publication={sha:receipt.revision,pushed:receipt.effects.pushed};
  const {item,disposition}=context.request;
  const decision=receipt.record;
  if (!optionBoolean(options, 'json')) {
    console.log(`Recorded that ${item} is ${disposition} for ${id}, decided by ${decision.actor} through ${decision.authorityGroup}.`);
    console.log(publication.pushed
      ? `Decision committed ${publication.sha.slice(0, 8)} and pushed.`
      : `Decision committed ${publication.sha.slice(0, 8)} locally; push is disabled by git.publish: off.`);
  }
  emitCommandResult(commandResult({
    operation: { id: 'decision.scope', classification: 'mutation' },
    subject: { kind: 'story', id },
    outcome: succeeded('decision.scope.succeeded', { item, disposition }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }),
    data: { commit: publication.sha, pushed: publication.pushed, decision }
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}

export async function decisionCompletenessCommand(positionals,options) {
  const {receipt,context}=await executeDecision('decision.completeness',positionals,options);
  const {workflow}=context;
  const id=receipt.subject.id;
  const publication={sha:receipt.revision,pushed:receipt.effects.pushed};
  const review=receipt.record;
  if (!optionBoolean(options, 'json')) {
    console.log(`Recorded that ${review.actor} reviewed the scope of ${id} for completeness through ${review.authorityGroup}.`);
    console.log(publication.pushed
      ? `Decision committed ${publication.sha.slice(0, 8)} and pushed.`
      : `Decision committed ${publication.sha.slice(0, 8)} locally; push is disabled by git.publish: off.`);
  }
  emitCommandResult(commandResult({
    operation: { id: 'decision.completeness', classification: 'mutation' },
    subject: { kind: 'story', id },
    outcome: succeeded('decision.completeness.succeeded', { inventory: review.inventorySha256.slice(7, 19) }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }),
    data: { commit: publication.sha, pushed: publication.pushed, review }
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}

export async function decisionApplicabilityCommand(positionals,options) {
  const {receipt,context}=await executeDecision('decision.applicability',positionals,options);
  const {workflow}=context;
  const id=receipt.subject.id;
  const publication={sha:receipt.revision,pushed:receipt.effects.pushed};
  const {responsibility}=context.request;
  const decision=receipt.record;
  if (!optionBoolean(options, 'json')) {
    console.log(`Recorded that ${responsibility} does not apply to ${id}, decided by ${decision.actor} through ${decision.authorityGroup}.`);
    console.log(publication.pushed
      ? `Decision committed ${publication.sha.slice(0, 8)} and pushed.`
      : `Decision committed ${publication.sha.slice(0, 8)} locally; push is disabled by git.publish: off.`);
    const open = applicabilityStatus(workflow).filter((row) => !row.satisfied);
    if (open.length) console.log(`Still to decide before the Story can finish: ${open.map((row) => row.responsibility).join(', ')}.`);
  }
  emitCommandResult(commandResult({
    operation: { id: 'decision.applicability', classification: 'mutation' },
    subject: { kind: 'story', id },
    outcome: succeeded('decision.applicability.succeeded', { responsibility }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }),
    data: { commit: publication.sha, pushed: publication.pushed, decision, applicability: applicabilityStatus(workflow) }
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}

export async function decisionRiskCommand(positionals,options) {
  const {receipt,context}=await executeDecision('decision.risk',positionals,options);
  const {workflow}=context;
  const id=receipt.subject.id;
  const publication={sha:receipt.revision,pushed:receipt.effects.pushed};
  const record=receipt.record;
  if (!optionBoolean(options, 'json')) {
    console.log(record.revokes
      ? `Revoked ${record.revokes} on ${record.obligationId}.`
      : `Recorded ${record.id}: the ${record.category} risk of ${record.obligationId} is accepted until ${record.expiresAt.slice(0, 10)} through ${record.authorityGroup}.`);
    console.log(publication.pushed
      ? `Decision committed ${publication.sha.slice(0, 8)} and pushed.`
      : `Decision committed ${publication.sha.slice(0, 8)} locally; push is disabled by git.publish: off.`);
  }
  emitCommandResult(commandResult({
    operation: { id: 'decision.risk', classification: 'mutation' },
    subject: { kind: 'story', id },
    outcome: succeeded('decision.risk.succeeded', { record: record.revokes ? `the revocation of ${record.revokes}` : record.id }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }),
    data: { commit: publication.sha, pushed: publication.pushed, record }
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}

export async function decisionChooseCommand(positionals,options) {
  const {receipt,context}=await executeDecision('decision.choose',positionals,options);
  const {workflow}=context;
  const id=receipt.subject.id;
  const publication={sha:receipt.revision,pushed:receipt.effects.pushed};
  const pending=context.pending, authority={authorityGroup:receipt.authorityGroup};
  const result={...context.result.result,outcome:receipt.record};
  const outcome = result.outcome;
  const where = outcome.kind === 'loop' ? `back to ${workflow.phases[outcome.target]?.label ?? outcome.target}`
    : outcome.kind === 'end' ? 'the end of the Story' : workflow.phases[outcome.target]?.label ?? outcome.target;
  if (!optionBoolean(options, 'json')) {
    console.log(`Decision '${pending.label}': ${outcome.routeLabel} → ${where}, chosen by ${receipt.actorId} through ${authority.authorityGroup}.`);
    if (outcome.skipped?.length) console.log(`Skipped: ${outcome.skipped.map((id) => workflow.phases[id]?.label ?? id).join(', ')}.`);
    console.log(publication.pushed
      ? `Decision committed ${publication.sha.slice(0, 8)} and pushed.`
      : `Decision committed ${publication.sha.slice(0, 8)} locally; push is disabled by git.publish: off.`);
    formatContextBoundaryHandoff(result.contextBoundary).forEach((line) => console.log(line));
  }
  const completion = recordedCompletion(workflow);
  if (completion && !optionBoolean(options, 'json')) printCompletionVerdict(completion);
  emitCommandResult(commandResult({
    operation: { id: 'decision.choose', classification: 'mutation' },
    subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded('decision.choose.succeeded', {
      decision: pending.decision, route: outcome.route, kind: outcome.kind, target: outcome.target ?? null,
      ...(completion ? { finalCheck: completion.verified ? 'passed' : 'failed', completionLabel: completion.label ?? null } : {})
    }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }),
    ...completionContinuation(completion),
    data: {
      commit: publication.sha, pushed: publication.pushed, authorityGroup: authority.authorityGroup, skipped: outcome.skipped ?? [],
      ...(completion ? { finalCheck: { verified: completion.verified, errors: completion.errors } } : {})
    }
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}
