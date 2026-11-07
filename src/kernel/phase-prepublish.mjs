/** Prepublication inspection contract. No host wording, executable routes or external effects. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {phaseInspectionGeneration} from './phase-policy.mjs';
import {phaseFindingCode,phaseFindingPolicyFromFacts} from './phase-findings.mjs';

const text=value=>typeof value==='string'&&value.length>0;
const nullableText=value=>value===null||text(value);
const count=value=>Number.isSafeInteger(value)&&value>=0;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
function bad(){throw new SingularityFlowError('The prepublication port returned invalid or differently bound facts.',{code:'ENGINE_PORT_RESULT_INVALID'});}

/** The same three conditions used by the installed prepublish check. Tests still run at publication. */
export function phasePrepublishReady(readiness) {
  return readiness.lifecycle===true&&readiness.authoring===true&&readiness.knownRecoveryBlockers===true;
}

export function phasePrepublishSelection(workflow,inputs) {
  const id=inputs.phaseId??workflow?.currentPhase;
  const phase=id!=null&&Object.hasOwn(workflow?.phases??{},id)?workflow.phases[id]:null;
  if(!phase)throw new SingularityFlowError(`Unknown or unavailable phase '${id??''}'. Provide a phase ID.`);
  const workId=workflow.workItem.id,current=phase.id===workflow.currentPhase;
  if(inputs.workId!=null&&inputs.workId!==workId)throw new SingularityFlowError(
    'Requested Story does not match the prepublication checkout.',{code:'ACTIVE_SUBJECT_MISMATCH',
      details:{expectedWorkId:inputs.workId,actualWorkId:workId}});
  if(!current&&!['in_progress','awaiting_approval'].includes(phase.status))throw new SingularityFlowError(
    `Phase '${phase.id}' is not the active review draft. Check '${workflow.currentPhase??'none'}' instead.`,
    {code:'PHASE_DRAFT_NOT_ACTIVE',details:{requestedPhase:phase.id,currentPhase:workflow.currentPhase}});
  return {workId,phase:phase.id,phaseStatus:phase.status,current,
    generation:phaseInspectionGeneration(workflow,phase)};
}

export function phasePrepublishManifest(binding,facts) {
  if(!exact(facts,['workId','phase','generation','phaseStatus','inspectionStage','readiness','producer','qualityDisposition',
    'draftFingerprint','findings','advisories','warningCount','correction','task'])
    ||facts.workId!==binding.workId||facts.phase!==binding.phase||facts.generation!==binding.generation
    ||facts.phaseStatus!==binding.phaseStatus||!['authoring','published','inactive'].includes(facts.inspectionStage)
    ||!exact(facts.readiness,['lifecycle','authoring','knownRecoveryBlockers','requiredTests','publicationTransaction'])
    ||['lifecycle','authoring','knownRecoveryBlockers'].some(key=>typeof facts.readiness[key]!=='boolean')
    ||facts.readiness.lifecycle!==(binding.current&&binding.phaseStatus==='in_progress')
    ||!text(facts.readiness.requiredTests)||!['already-published','not-run'].includes(facts.readiness.publicationTransaction)
    ||!nullableText(facts.producer)||!text(facts.qualityDisposition)||!nullableText(facts.draftFingerprint)
    ||!Array.isArray(facts.findings)||!Array.isArray(facts.advisories)||!count(facts.warningCount)
    ||!exact(facts.correction,['class','sameTurn','requiresNewGeneration'])||!nullableText(facts.correction.class)
    ||typeof facts.correction.sameTurn!=='boolean'||typeof facts.correction.requiresNewGeneration!=='boolean')bad();
  const findings=facts.findings.map(finding=>{
    if(!exact(finding,['code','sourceCode','category','message','phaseId','path','line','clauseId',
      'upstreamDecisionComplete','coverageReviewRequired','riskEligible'])
      ||!text(finding.code)||!nullableText(finding.sourceCode)||!nullableText(finding.category)
      ||typeof finding.message!=='string'||!nullableText(finding.phaseId)||finding.path!==null&&typeof finding.path!=='string'
      ||finding.line!==null&&!count(finding.line)||!nullableText(finding.clauseId)
      ||['upstreamDecisionComplete','coverageReviewRequired','riskEligible'].some(key=>typeof finding[key]!=='boolean'))bad();
    const code=phaseFindingCode({code:finding.code,details:{sourceCode:finding.sourceCode}});
    const policy=phaseFindingPolicyFromFacts({code,category:finding.category,hasPath:finding.path!==null,
      upstreamDecisionComplete:finding.upstreamDecisionComplete,coverageReviewRequired:finding.coverageReviewRequired,
      riskEligible:finding.riskEligible});
    return {code:finding.code,canonicalCode:code,sourceCode:finding.sourceCode,category:finding.category,
      message:finding.message,affectedPhase:finding.phaseId??(['upstream-defect','upstream-decision'].includes(policy.classification)?null:binding.phase),path:finding.path,line:finding.line,
      clauseId:finding.clauseId,policy};
  });
  for(const advisory of facts.advisories)if(!exact(advisory,['code','category','message','requiredBefore','ownerPhase','clauseId','issueRefs','status'])
    ||!nullableText(advisory.code)||!nullableText(advisory.category)||typeof advisory.message!=='string'
    ||!nullableText(advisory.requiredBefore)||!nullableText(advisory.ownerPhase)||!nullableText(advisory.clauseId)
    ||!nullableText(advisory.status)||!Array.isArray(advisory.issueRefs)||!advisory.issueRefs.every(text))bad();
  if(facts.task!==null&&(!exact(facts.task,['operationId','state','continuationBudget'])||!text(facts.task.operationId)
    ||!text(facts.task.state)||!exact(facts.task.continuationBudget,['consumed','maximum'])
    ||!count(facts.task.continuationBudget.consumed)||!count(facts.task.continuationBudget.maximum)))bad();
  const ready=phasePrepublishReady(facts.readiness);
  if(ready&&findings.length)bad();
  return {schemaVersion:1,contract:'sflow-phase-prepublish-manifest/v1',workId:binding.workId,phase:binding.phase,
    generation:binding.generation,inspectionStage:facts.inspectionStage,readiness:facts.readiness,
    producer:facts.producer,qualityDisposition:facts.qualityDisposition,draftFingerprint:facts.draftFingerprint,
    findings,advisories:facts.advisories,warningCount:facts.warningCount,correction:facts.correction,task:facts.task,
    admittedForAttempt:ready,finalBindingChecked:false,testsRun:false,mutationAuthorityGranted:false,
    approvalRecorded:false,humanReviewRecorded:false};
}
