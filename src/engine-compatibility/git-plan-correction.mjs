/** Native reviewed plan-correction port. No flags, prompts or command-result rendering. */
import path from 'node:path';
import {head,identity} from '../git.mjs';
import {recordSha256} from '../records.mjs';
import {loadBoundActiveSpecRecords,normalizeClaimMap} from '../specifications.mjs';
import {validatePlannedVerification} from '../verification/intent.mjs';
import {planCorrectionAuthorities,recordPlanRowCorrection} from '../plan-row-corrections.mjs';
import {requireApprovalAuthority} from '../kernel/approval-policy.mjs';
import {planCorrectionOwner} from '../kernel/decision-plan.mjs';
import {assertNoPendingPublication,actorKey,transactStory} from '../state-stores.mjs';
import {LIFECYCLE_EVENT} from '../lifecycle-event.mjs';
import {nowIso,SingularityFlowError} from '../util.mjs';
import {loadNativeDecisionRecordContext} from './record-decision-context.mjs';

function refused(message,details=undefined) {
  throw new SingularityFlowError(message,{code:'PLAN_ROW_CORRECTION_INVALID',...(details?{details}:{})});
}

async function preview(root, config, workflow, input) {
  const owner = planCorrectionOwner(workflow, input.ownerPhase);
  const policy = workflow.resolution?.spec ?? config.spec ?? {};
  const itemDirectory = path.join(root, config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
  const records = await loadBoundActiveSpecRecords(root, itemDirectory, workflow, policy, { plannedOnly: true });
  const ownerRecord = (records.planned ?? []).find((record) => !record.amendment && record.phase === owner.id);
  if (!ownerRecord) refused(`The approved plan of ${owner.id} could not be read.`);
  const clauses = records.indexes.flatMap((index) => index.clauses ?? []);
  const clauseIds = clauses.map((clause) => String(clause.id).toUpperCase());
  const normalizeRow = (clauseId, raw) => normalizeClaimMap({ claims: { [clauseId]: raw } },
    { kind: 'planned', clauseIds, policy }).claims[clauseId];
  const operations = input.operations;
  const scratch = structuredClone(workflow);
  const correction = recordPlanRowCorrection(scratch, {
    ownerRecord, ownerMapSha256: owner.claimMaps.planned.sha256, operations, activeClauseIds: clauseIds, normalizeRow,
    validate: (plan) => validatePlannedVerification(plan.claims, plan.verificationContracts ?? [], clauses),
    reason: input.reason, actor: 'preview', authorityGroup: 'preview',
    authorizationId: '00000000-0000-4000-8000-000000000000', at: nowIso(),
    upstreamIssue: input.upstreamIssue
  });
  return { owner, ownerRecord, operations, correction, normalizeRow, clauses, clauseIds,
    previewSha256: recordSha256({ owner: owner.id, generation: owner.generation, map: owner.claimMaps.planned.sha256,
      operations: correction.operations, reason: correction.reason, upstreamIssue: correction.upstreamIssue }) };
}


export function createGitPlanCorrectionPort({root,interaction=null,onContext=()=>{}}) {
  const prepare=typeof interaction?.prepare==='function'?interaction.prepare.bind(interaction):null;
  const capture=typeof interaction?.capture==='function'?interaction.capture.bind(interaction):null;
  const suppliedConsume=typeof interaction?.consume==='function'?interaction.consume.bind(interaction):null;
  return {
    async load(input,{operation}) {
      const context=await loadNativeDecisionRecordContext(root,input,operation);
      onContext(context);return context;
    },
    prepare:(context,input,options)=>prepare?prepare(context,input,options):input,
    async review(context,input) {
      const {config,workflow}=context;
      const groups=planCorrectionAuthorities(workflow,planCorrectionOwner(workflow,input.ownerPhase).id);
      if(!groups.length)refused('The plan has no approval group, so nobody can correct it.');
      const reviewed=await preview(root,config,workflow,input);
      Object.assign(context,{groups,reviewed});
      return JSON.parse(JSON.stringify({workId:workflow.workItem.id,currentPhase:workflow.currentPhase??null,
        ownerPhase:reviewed.owner.id,ownerGeneration:reviewed.owner.generation,ownerMapSha256:reviewed.owner.claimMaps.planned.sha256,
        previewSha256:reviewed.previewSha256,operations:reviewed.correction.operations,authorityGroups:groups,
        reason:reviewed.correction.reason,upstreamIssue:reviewed.correction.upstreamIssue}));
    },
    async authorize(context) {
      const {config,workflow,reviewed,groups}=context,id=workflow.workItem.id;
      const {owner,correction}=reviewed;
      const actor = identity(root);
      const authority = requireApprovalAuthority(workflow.resolution?.approvalAuthorities ?? config.approvalAuthorities,
        { mode: 'required', authorities: groups, requiredAuthorities: [], minimum: 1 }, actor);
      context.who={actor,agent:null};
      context.authority=authority;
      const actionId = `PRC-${reviewed.previewSha256.slice(0, 24)}`;
      const card = { plan: { planId: actionId, planHash: reviewed.previewSha256, reviewer: actorKey(actor),
        subject: { workId: id, phaseId: owner.id }, revision: head(root),
        ownerPhase: owner.id, ownerGeneration: owner.generation, operations: correction.operations,
        rowsBefore: Object.fromEntries(correction.operations.map((operation) =>
          [operation.clauseId, reviewed.ownerRecord.claims[operation.clauseId] ?? null])),
        reason: correction.reason, testsWaived: false, phaseApproved: false },
      action: { actionId, confirmation: { required: true } } };
      context.card=card;
      if(!capture)throw new SingularityFlowError('This action requires direct terminal review of its exact current plan.',
        {code:'ACTION_TERMINAL_PRESENTATION_REQUIRED'});
      const grant=await capture(root,structuredClone(card.plan),structuredClone(card.action),{label:`Correct plan ${owner.id}`});
      context.grant=grant;
      return {workId:id,ownerPhase:owner.id,ownerGeneration:owner.generation,previewSha256:reviewed.previewSha256,
        confirmed:Boolean(grant),actorId:actorKey(actor),authorityGroup:authority.authorityGroup};
    },
    async commit(context,input) {
      const {config,workflow,reviewed,card,grant,authority}=context,id=workflow.workItem.id;
      const {owner,correction}=reviewed,actor=context.who.actor;
      const consume=suppliedConsume??(await import('../action-authorization.mjs')).consumeActionAuthorization;
      const { value: recorded, publication } = await transactStory(root, config, workflow, {
        type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: workflow.currentPhase ?? null, generation: null,
        actor, agent: null, authorityGroup: authority.authorityGroup, payload: { decision: 'plan' }
      }, `[${id}][plan:correct] ${owner.id} ${correction.operations.length} change(s)`, async (aggregate) => {
        await assertNoPendingPublication(root, config, aggregate, 'correct the plan');
        const fresh = await preview(root, config, aggregate, input);
        if (fresh.previewSha256 !== reviewed.previewSha256) {
          refused('The plan changed during review. Nothing was recorded; review the correction again.');
        }
        const authorization = await consume(root, grant.token, card.plan, card.action, { requireTerminalPresentation: true });
        const record = recordPlanRowCorrection(aggregate, {
          ownerRecord: fresh.ownerRecord, ownerMapSha256: owner.claimMaps.planned.sha256, operations: fresh.operations,
          activeClauseIds: fresh.clauseIds, normalizeRow: fresh.normalizeRow,
          validate: (plan) => validatePlannedVerification(plan.claims, plan.verificationContracts ?? [], fresh.clauses),
          reason: correction.reason, actor: actorKey(actor), authorityGroup: authority.authorityGroup,
          identityAssurance: authority.identityAssurance ?? null, authorizationId: authorization.authorizationId,
          at: nowIso(), upstreamIssue: correction.upstreamIssue
        });
        aggregate.history.push({ at: record.at, actor: record.actor, agent: null, event: 'plan_amended', phase: aggregate.currentPhase ?? null,
          detail: `${record.id} corrects ${owner.id}: ${record.operations.map((operation) => `${operation.op} ${operation.clauseId}`).join('; ')}. ${record.reason}` });
        return record;
      }, {
        exactWorkItemPaths: [],
        eventFromResult: (record) => ({ actor, agent: null, authorityGroup: record.authorityGroup, identityAssurance: record.identityAssurance,
          payload: { decision: 'plan', amendment: record.id, reviewPacketSha256: null } })
      });
      context.record=recorded;
      return publication;
    },
    finish(context,input,publication) {
      return JSON.parse(JSON.stringify({workId:context.workflow.workItem.id,currentPhase:context.workflow.currentPhase??null,
        record:context.record,revision:publication.sha,pushed:publication.pushed,
        actorId:actorKey(context.who.actor),authorityGroup:context.authority.authorityGroup}));
    }
  };
}
