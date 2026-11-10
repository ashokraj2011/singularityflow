/** Plan row/evidence rules over exact approved values and explicitly admitted human records. No I/O or presence registry. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,textDigestCapability,namespacePlanCorrectionRecordProfile} from '../foundation/record-schema.mjs';
import {parseRecordShape} from '../foundation/record-shapes.mjs';
import {configurationPathSyntax} from './configuration-path-policies.mjs';
import {verificationContractPolicies} from './verification-policy.mjs';
import {fallbackAuthorities} from './approval-fallback.mjs';
import {phaseNeedsGeneration} from './phase-policy.mjs';
import {plannedClaimAllocatedTo} from './specification-policy.mjs';
import {planCorrectionRecordShapes} from './plan-correction-shapes.mjs';
export {planCorrectionRecordShapes} from './plan-correction-shapes.mjs';
export function planCorrectionPolicies(pathSyntax,digests){
  const {posix}=configurationPathSyntax(pathSyntax),{sha256Utf8}=textDigestCapability(digests),recordSha256=value=>sha256Utf8(canonicalJson(value)),
    {normalizeVerificationContracts}=verificationContractPolicies(pathSyntax,digests),shapes=planCorrectionRecordShapes(),
    PlanRowCorrectionSchema={safeParse:value=>parseRecordShape(shapes.row,value)},EvidenceAmendmentSchema={safeParse:value=>parseRecordShape(shapes.evidence,value)},
    portablePath={safeParse:value=>parseRecordShape(shapes.portablePath,value)},fulfillmentKind={safeParse:value=>parseRecordShape(shapes.fulfillment,value)};
  const MAX_OPERATIONS=20;
function invalidEvidence(message) { throw new SingularityFlowError(message, { code: 'PLAN_EVIDENCE_AMENDMENT_INTEGRITY' }); }

/** A different plan's reviewers cannot change this owner's approved contract. */
function evidenceOwnerAuthorities(workflow, ownerPhase) {
  const policy = workflow.phases?.[ownerPhase]?.approvalPolicy ?? {};
  return [...new Set([...(policy.authorities ?? []), ...(policy.requiredAuthorities ?? [])])].sort();
}

/** The same before/after projection is displayed for review and applied by every plan reader. */
function evidenceCorrectionProjection(clauseId, claim, evidencePath, method) {
  const contract = normalizeVerificationContracts([{ clauseId, combination: 'all', slots: [
    { slot: 'retained-evidence', method, role: 'primary',
      witness: method === 'visual' ? { target: evidencePath } : { path: evidencePath }, requiredAssurance: 'source-bound' },
    ...(claim.tests ?? []).map((test, index) => ({ slot: `supporting-test-${index + 1}`, method: 'test', role: 'supporting',
      witness: { path: test }, requiredAssurance: null }))
  ] }])[0];
  return { claim: { ...structuredClone(claim), fulfillment: 'evidence', expectedPaths: [evidencePath] }, contract };
}

/** Apply only the exact owner's generation. A later approved plan supersedes its old correction. */
function applyPlanEvidenceAmendments(record, workflow, { evidenceRoot } = {}, observed = workflow?.planAmendments ?? []) {
  let result = record;
  for (const value of observed) {
    if (value.kind !== 'evidence-contract-correction') continue;
    const checked = EvidenceAmendmentSchema.safeParse(value);
    if (!checked.success) invalidEvidence('Evidence amendment schema or human decision binding is invalid.');
    const amendment = checked.data;
    if (!evidenceOwnerAuthorities(workflow, amendment.ownerPhase).includes(amendment.authorityGroup)) invalidEvidence('Evidence amendment lacks its exact owner plan authority.');
    if (amendment.ownerPhase !== record.phase || amendment.ownerGeneration !== Number(record.generation)) continue;
    const pointer = workflow.phases?.[record.phase]?.claimMaps?.planned;
    if (!pointer || pointer.sha256 !== amendment.ownerMapSha256) invalidEvidence('Evidence amendment no longer binds its approved owner map.');
    const claim = result.claims?.[amendment.clauseId];
    if (!claim || recordSha256(claim) !== amendment.previousClaimSha256) invalidEvidence('Evidence amendment does not replace the exact reviewed clause row.');
    if (evidenceRoot && !amendment.path.startsWith(`${evidenceRoot}/`)) invalidEvidence('Evidence amendment points outside this Story.');
    result = structuredClone(result);
    // Retain planned test files as supporting witnesses, not primary visual proof. Commands and
    // their required execution policy do not change. Source obligations of other clauses survive.
    const { claim: corrected, contract } = evidenceCorrectionProjection(amendment.clauseId, claim, amendment.path, amendment.method);
    result.claims[amendment.clauseId] = corrected;
    result.verificationContracts = normalizeVerificationContracts([
      ...(result.verificationContracts ?? []).filter(entry => entry.clauseId !== amendment.clauseId), contract
    ]);
  }
  return result;
}

function invalid(message, details = undefined) {
  throw new SingularityFlowError(message, { code: 'PLAN_ROW_CORRECTION_INTEGRITY', ...(details ? { details } : {}) });
}

function refused(message, details = undefined) {
  throw new SingularityFlowError(message, { code: 'PLAN_ROW_CORRECTION_INVALID', ...(details ? { details } : {}) });
}

function exactPath(value, label) {
  const candidate = posix(String(value ?? '').trim());
  if (!portablePath.safeParse(candidate).success || /[*?[\]{}]/u.test(candidate) || candidate.endsWith('/')) {
    refused(`${label} must be one exact repository-relative file path.`);
  }
  return candidate;
}

/** A row's paths are required unless it is test-only; never leave a row that needs them without one. */
function needsPaths(claim) {
  return claim.fulfillment != null && claim.fulfillment !== 'test-only';
}

/**
 * One operation applied to a cloned record. Shared by recording (which computes each row digest as
 * it goes) and by every reader (which proves the same digests), so the two cannot disagree.
 */
function applyOperation(result, operation, { check }) {
  const id = operation.clauseId;
  if (operation.op === 'add-row') {
    if (result.claims[id]) check(false, `The plan already has a row for ${id}; correct that row instead.`, { clauseId: id });
    result.claims[id] = structuredClone(operation.claim);
    return;
  }
  const claim = result.claims[id];
  if (!claim) return check(false, `The plan has no row for ${id}.`, { clauseId: id });
  check(recordSha256(claim) === operation.previousClaimSha256,
    `The plan row for ${id} is not the row this correction was decided against.`, { clauseId: id });
  if(operation.op==='reclassify-evidence'){
    check(/:AC-\d{3}$/u.test(id),'Only an acceptance criterion has a retained-evidence classification.',{clauseId:id});
    check(!(claim.fulfillment==='evidence'&&claim.expectedPaths?.includes(operation.path)),
      'This file already has an evidence contract; complete its actual witness instead.',{clauseId:id});
    const projected=evidenceCorrectionProjection(id,claim,operation.path,operation.method);result.claims[id]=projected.claim;
    result.verificationContracts=normalizeVerificationContracts([...(result.verificationContracts??[]).filter(row=>row.clauseId!==id),projected.contract]);return;
  }
  if (operation.op === 'set-fulfillment') {
    check((claim.fulfillment ?? null) !== operation.fulfillment, `${id} is already planned as ${operation.fulfillment}.`, { clauseId: id });
    claim.fulfillment = operation.fulfillment;
    // A test-only row names its tests and no product path: the tests are the whole delivery
    // (a test-generation Story whose plan said otherwise, PMBEPP 2026-10-27).
    if (operation.fulfillment === 'test-only') claim.expectedPaths = [];
    return;
  }
  if (operation.op === 'add-test') {
    check(claim.testDisposition !== 'non-test',
      `${id} is proven without executable tests; change its proof with an evidence correction or a new plan.`, { clauseId: id });
    check(!(claim.tests ?? []).includes(operation.test), `${operation.test} is already a planned test of ${id}.`, { clauseId: id });
    claim.tests = [...new Set([...(claim.tests ?? []), operation.test])].sort();
    claim.testDisposition = 'applicable';
    claim.testReason = null;
    const stated = (result.verificationContracts ?? []).find((entry) => entry.clauseId === id);
    if (stated) {
      // A stated contract governs the criterion; the added test joins it as a supporting witness.
      const used = new Set(stated.slots.map((entry) => entry.slot));
      let index = 1;
      while (used.has(`added-test-${index}`)) index += 1;
      result.verificationContracts = normalizeVerificationContracts((result.verificationContracts ?? []).map((entry) =>
        entry.clauseId !== id ? entry : { ...entry, slots: [...entry.slots, { slot: `added-test-${index}`, method: 'test',
          role: 'supporting', witness: { path: operation.test }, requiredAssurance: null }] }));
    }
    return;
  }
  if (operation.op === 'remove-test' || operation.op === 'replace-test') {
    // Tests delivered under other names than the plan's could only be renamed back or returned
    // (2026-10-28). A stated contract follows a replaced test; one naming a removed test is changed
    // with an evidence correction instead, so a proof never loses its witness here.
    const removed = operation.op === 'remove-test' ? operation.test : operation.from;
    const tests = claim.tests ?? [];
    check(tests.includes(removed), `${removed} is not a planned test of ${id}.`, { clauseId: id });
    const stated = (result.verificationContracts ?? []).find((entry) => entry.clauseId === id);
    const witnessed = (stated?.slots ?? []).some((entry) => entry.witness?.path === removed);
    if (operation.op === 'remove-test') {
      check(!witnessed, `${removed} is a witness of ${id}'s stated proof; change that proof with an evidence correction.`, { clauseId: id });
      check(tests.length > 1, `${removed} is ${id}'s only planned test; replace it with --replace-test instead of removing it.`, { clauseId: id });
      claim.tests = tests.filter((entry) => entry !== removed);
      return;
    }
    check(!tests.includes(operation.to), `${operation.to} is already a planned test of ${id}.`, { clauseId: id });
    claim.tests = [...new Set([...tests.filter((entry) => entry !== removed), operation.to])].sort();
    if (witnessed) {
      result.verificationContracts = normalizeVerificationContracts((result.verificationContracts ?? []).map((entry) =>
        entry.clauseId !== id ? entry : { ...entry, slots: entry.slots.map((slot) => slot.witness?.path !== removed ? slot
          : { ...slot, witness: { ...slot.witness, path: operation.to } }) }));
    }
    return;
  }
  const paths = claim.expectedPaths ?? [];
  const removed = operation.op === 'remove-location' ? operation.path : operation.from;
  check(paths.includes(removed), `${removed} is not an expected path of ${id}.`, { clauseId: id });
  const next = paths.filter((entry) => entry !== removed);
  if (operation.op === 'replace-location') {
    check(!paths.includes(operation.to), `${operation.to} is already an expected path of ${id}.`, { clauseId: id });
    next.push(operation.to);
  }
  check(next.length > 0 || !needsPaths(claim),
    `${id} is ${claim.fulfillment}, so it keeps at least one expected path; replace the path instead of removing it.`,
    { clauseId: id });
  claim.expectedPaths = [...new Set(next)].sort();
}

/**
 * The owner plan's approval groups decide; a different plan's reviewers cannot correct this one. A
 * plan step with no approval group is corrected by the nearest step that has one.
 */
function planCorrectionAuthorities(workflow, ownerPhase) {
  const own = evidenceOwnerAuthorities(workflow, ownerPhase);
  return own.length ? own : fallbackAuthorities(workflow, [ownerPhase]);
}

/**
 * Validate and record one correction against the owner's current planned record (already read and
 * verified by the caller). `normalizeRow(clauseId, rawClaim)` is the plan's own row normalizer, so
 * an added or changed row is refused exactly where a planner's row would be, and `validate(plan)`
 * checks the whole corrected plan (approved verification intent) before anything is recorded.
 */
function previewPlanRowCorrection(workflow, {
  ownerRecord, ownerMapSha256, operations = [], activeClauseIds = [], normalizeRow, validate = () => {},
  reason, actor, authorityGroup, identityAssurance = null, authorizationId, at, upstreamIssue = null,
  namespaceEvidence = null
}) {
  if (!ownerRecord || ownerRecord.kind !== 'planned') refused('A plan correction needs the approved plan it corrects.');
  if (!operations.length || operations.length > MAX_OPERATIONS) {
    refused(`Name 1 to ${MAX_OPERATIONS} corrections with --add-row, --set-fulfillment, --add-test, --remove-test, --replace-test, --remove-location or --replace-location.`);
  }
  if(namespaceEvidence&&operations.some(row=>row.op==='reclassify-evidence')){
    const clauses=operations.map(row=>String(row.clauseId??'').toUpperCase());
    if(operations.some(row=>row.op!=='reclassify-evidence')||new Set(clauses).size!==clauses.length)refused(
      'Review evidence classification in its own exact packet, once per criterion. Record other row/test changes in a separate correction.');
  }
  const active = new Set(activeClauseIds.map((value) => String(value).toUpperCase()));
  const result = structuredClone(ownerRecord);
  const check = (condition, message, details) => { if (!condition) refused(message, details); };
  const recorded = operations.map((input) => {
    const clauseId = String(input.clauseId ?? '').toUpperCase();
    if (!active.has(clauseId)) refused(`${clauseId || 'That clause'} is not an approved clause of this Story.`, { clauseId });
    let operation;
    if(input.op==='reclassify-evidence'&&namespaceEvidence){
      if(Object.keys(input).some(key=>!['op','clauseId','path','method','content'].includes(key)))refused('The evidence correction accepts an exact path, method and retained content only.');
      const path=exactPath(input.path,`The retained evidence of ${clauseId}`),claim=result.claims[clauseId];
      if(!claim||!plannedClaimAllocatedTo(claim,workflow.currentPhase)||!/:AC-\d{3}$/u.test(clauseId))refused('Choose an approved criterion allocated to the current phase.');
      if(!path.startsWith(namespaceEvidence.root+'/'))refused('The retained file must belong to this Story evidence directory.');
      if((namespaceEvidence.protectedPaths??[]).some(guard=>path.toLowerCase()===String(guard).toLowerCase()
        ||path.toLowerCase().startsWith(String(guard).replace(/\/$/u,'').toLowerCase()+'/')))refused('Protected evidence needs its original authority.');
      operation={op:input.op,clauseId,path,method:input.method,content:structuredClone(input.content??null),previousClaimSha256:recordSha256(claim),
        delivery:{phase:namespaceEvidence.phaseId,generation:namespaceEvidence.generation}};
      if(!parseRecordShape(shapes.namespaceEvidenceOperation,operation).success)refused('Review one exact retained visual/inspection evidence file and its content reference.');
    } else if (input.op === 'add-row') {
      const raw = {
        expectedPaths: (input.expectedPaths ?? []).map((value) => exactPath(value, `An expected path of ${clauseId}`)),
        tests: (input.tests ?? []).map((value) => exactPath(value, `A planned test of ${clauseId}`)),
        ...(input.fulfillment ? { fulfillment: input.fulfillment } : {}),
        ...(input.steps?.length ? { steps: input.steps } : {}),
        ...(input.observableResult ? { observableResult: input.observableResult } : {})
      };
      if (!raw.expectedPaths.length && !raw.tests.length) refused(`A new row for ${clauseId} needs expected paths or planned tests.`);
      operation = { op: 'add-row', clauseId, claim: normalizeRow(clauseId, raw) };
    } else if (input.op === 'set-fulfillment') {
      operation = { op: 'set-fulfillment', clauseId, fulfillment: String(input.fulfillment ?? '').trim() };
      if (!fulfillmentKind.safeParse(operation.fulfillment).success) refused(`Name the fulfillment of ${clauseId}, such as test-only.`, { clauseId });
    } else if (input.op === 'add-test') {
      operation = { op: 'add-test', clauseId, test: exactPath(input.test, `The planned test for ${clauseId}`) };
    } else if (input.op === 'remove-test') {
      operation = { op: 'remove-test', clauseId, test: exactPath(input.test, `The planned test to remove from ${clauseId}`) };
    } else if (input.op === 'replace-test') {
      operation = { op: 'replace-test', clauseId, from: exactPath(input.from, `The planned test to replace in ${clauseId}`),
        to: exactPath(input.to, `The replacement test for ${clauseId}`) };
    } else if (input.op === 'remove-location') {
      operation = { op: 'remove-location', clauseId, path: exactPath(input.path, `The path to remove from ${clauseId}`) };
    } else if (input.op === 'replace-location') {
      operation = { op: 'replace-location', clauseId, from: exactPath(input.from, `The path to replace in ${clauseId}`),
        to: exactPath(input.to, `The replacement path for ${clauseId}`) };
    } else {
      refused('A plan correction adds a row or a test, changes a row\'s fulfillment, or removes or replaces a test or a path.');
    }
    if (operation.op !== 'add-row') {
      if (!result.claims[clauseId]) refused(`The plan has no row for ${clauseId}; add one with --add-row.`, { clauseId });
      operation.previousClaimSha256 = recordSha256(result.claims[clauseId]);
    }
    applyOperation(result, operation, { check });
    return operation;
  });
  // Every row a correction touched must still be a row the planner could have written.
  for (const clauseId of new Set(recorded.map((operation) => operation.clauseId))) normalizeRow(clauseId, result.claims[clauseId]);
  validate(result);
  const text = String(reason ?? '').trim();
  if (text.length < 20 || text.length > 1000) refused('Say why the plan is corrected in 20 to 1000 characters with --reason.');
  const ids=[...new Set(recorded.map(operation=>operation.clauseId))],
    before=Object.fromEntries(ids.map(id=>[id,structuredClone(ownerRecord.claims[id]??null)])),
    after=Object.fromEntries(ids.map(id=>[id,structuredClone(result.claims[id]??null)])),
    contracts=plan=>(plan.verificationContracts??[]).filter(row=>ids.includes(row.clauseId));
  return {ownerPhase:ownerRecord.phase,ownerGeneration:Number(ownerRecord.generation),ownerMapSha256,operations:recorded,reason:text,upstreamIssue,
    before,after,contractsBefore:structuredClone(contracts(ownerRecord)),contractsAfter:structuredClone(contracts(result)),
    previewSha256:recordSha256({owner:ownerRecord.phase,generation:Number(ownerRecord.generation),map:ownerMapSha256,operations:recorded,reason:text,upstreamIssue})};
}
function recordPlanRowCorrection(workflow,input){
  const {ownerRecord,ownerMapSha256,actor,authorityGroup,identityAssurance=null,authorizationId,at,upstreamIssue=null}=input,
    {operations:recorded,reason:text}=previewPlanRowCorrection(workflow,input);
  workflow.planAmendments ??= [];
  const sequence = workflow.planAmendments.filter((entry) => entry?.kind === 'plan-row-correction').length + 1;
  const correction = {
    id: `PRC-${String(sequence).padStart(3, '0')}`, kind: 'plan-row-correction',
    ownerPhase: ownerRecord.phase, ownerGeneration: Number(ownerRecord.generation), ownerMapSha256,
    operations: recorded, reason: text, actor, authorityGroup, identityAssurance, authorizationId,
    reviewAssurance: 'live-terminal-exact-plan-review', at, upstreamIssue
  };
  const checked = PlanRowCorrectionSchema.safeParse(correction);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    refused(`The plan correction is not well formed: ${issue?.path?.length ? `${issue.path.join('.')}: ` : ''}${issue?.message ?? 'invalid'}.`);
  }
  workflow.planAmendments.push(correction);
  return correction;
}

function applyRowCorrection(record, workflow, value) {
  const checked = PlanRowCorrectionSchema.safeParse(value);
  if (!checked.success) invalid('A plan correction record is not well formed.', { id: value?.id ?? null });
  return applyCorrection(record,workflow,checked.data);
}
function applyCorrection(record,workflow,correction,originalMapSha256=undefined){
  if (!planCorrectionAuthorities(workflow, correction.ownerPhase).includes(correction.authorityGroup)) {
    invalid(`Plan correction ${correction.id} lacks its owner plan's authority.`, { id: correction.id });
  }
  if (correction.ownerPhase !== record.phase || correction.ownerGeneration !== Number(record.generation)) return record;
  const pointer = workflow.phases?.[record.phase]?.claimMaps?.planned;
  if ((originalMapSha256===undefined?pointer?.sha256:originalMapSha256) !== correction.ownerMapSha256) {
    invalid(`Plan correction ${correction.id} no longer binds its approved plan.`, { id: correction.id });
  }
  const result = structuredClone(record);
  const check = (condition, message, details) => { if (!condition) invalid(`Plan correction ${correction.id}: ${message}`, details); };
  for (const operation of correction.operations) applyOperation(result, operation, { check });
  return result;
}

/**
 * Apply every evidence and row correction of this exact owner generation in recorded order. Each
 * one pins the row it replaces as the readers showed it when it was decided, which includes every
 * earlier correction of either kind, so they must replay in that same order. Later plans supersede them.
 */
function applyPlanCorrections(record, workflow, options = {}, observed = workflow?.planAmendments ?? []) {
  if (!record || record.amendment) return record;
  let result = record;
  for (const value of observed) {
    if (value?.kind === 'evidence-contract-correction') {
      result = applyPlanEvidenceAmendments(result, { ...workflow, planAmendments: [value] }, options);
    } else if (value?.kind === 'plan-row-correction') {
      result = applyRowCorrection(result, workflow, value);
    }
  }
  return result;
}

/** Separate namespace wire: an exact authenticated context is not a terminal ceremony. */
function recordNamespacePlanCorrection(workflow,input){
  const preview=previewPlanRowCorrection(workflow,input),expected='sha256:'+preview.previewSha256;
  if(input.expectedPreview!==expected)throw new SingularityFlowError('Review the current exact plan correction before recording it.',{
    code:'PLAN_CORRECTION_REVIEW_CHANGED',details:{operation:'plan.correction.context',expectedPreview:expected}});
  const profile=namespacePlanCorrectionRecordProfile('record',{schemaVersion:preview.operations.some(row=>row.op==='reclassify-evidence')?2:1}),
    record={schemaVersion:profile.version,format:profile.format,
    id:'PRC-'+String((workflow.planAmendments??[]).filter(row=>row?.kind==='plan-row-correction').length+1).padStart(3,'0'),kind:'plan-row-correction',
    ownerPhase:preview.ownerPhase,ownerGeneration:preview.ownerGeneration,ownerMapSha256:preview.ownerMapSha256,
    operations:preview.operations,reason:preview.reason,actor:input.actor,authorityGroup:input.authorityGroup,identityAssurance:null,
    at:input.at,upstreamIssue:preview.upstreamIssue,reviewContext:expected};
  const checked=parseRecordShape(profile.evidenceClassification?shapes.namespaceRowV2:shapes.namespaceRow,record);if(!checked.success)refused('The namespace correction does not satisfy its record contract.');
  workflow.planAmendments??=[];workflow.planAmendments.push(record);return record;
}
function previewNamespacePlanCorrection(workflow,input){return previewPlanRowCorrection(workflow,input);}
function applyNamespacePlanCorrections(record,workflow,observed=[],{originalMapSha256}={}){
  if(!record||record.amendment)return record;let result=record;
  for(const value of observed){if(value.kind!=='plan-row-correction')continue;
    const profile=namespacePlanCorrectionRecordProfile('record',value),checked=parseRecordShape(profile.evidenceClassification?shapes.namespaceRowV2:shapes.namespaceRow,value);
    if(value.format!==profile.format||!checked.success)invalid('The accepted namespace correction has an invalid wire contract.');
    if(!/^[a-f0-9]{64}$/u.test(originalMapSha256??''))invalid('Namespace projection needs the original approved map digest.');
    result=applyCorrection(result,workflow,checked.data,originalMapSha256);
  }return result;
}
/** A new plan cannot silently reinterpret an already accepted Code proof. */
function namespaceCorrectionRequirements(workflow,preview){
  const required=new Set(),affectedPhases=[];
  if(workflow.resolution?.presence)required.add('person-presence');
  for(const [id,owner]of Object.entries(workflow.resolution?.plannedClaims?.owners??{})){
    if(owner!==preview?.ownerPhase)continue;
    const affected=(preview.operations??[]).some(row=>[preview.before?.[row.clauseId],preview.after?.[row.clauseId]].some(claim=>claim&&plannedClaimAllocatedTo(claim,id))),phase=workflow.phases?.[id];
    if(affected&&phase?.publicationBindings?.some(row=>row.generation===phase.generation)&&!phaseNeedsGeneration(workflow,phase)){
      affectedPhases.push(id);required.add('namespace-plan-revalidation');}
  }
  return {status:required.size?'owner-required':'requires-human-review',requiredOwners:[...required].sort(),affectedPhases};
}

/** Corrections in force for a plan generation, for disclosure. */
function planRowCorrections(workflow, ownerPhase = null, observed = workflow?.planAmendments ?? []) {
  return observed.filter((entry) => entry?.kind === 'plan-row-correction'
    && (!ownerPhase || entry.ownerPhase === ownerPhase));
}

return Object.freeze({planCorrectionAuthorities,recordPlanRowCorrection,previewPlanRowCorrection,previewNamespacePlanCorrection,recordNamespacePlanCorrection,applyNamespacePlanCorrections,namespaceCorrectionRequirements,applyPlanCorrections,planRowCorrections,
  evidenceOwnerAuthorities,evidenceCorrectionProjection,applyPlanEvidenceAmendments});
}
