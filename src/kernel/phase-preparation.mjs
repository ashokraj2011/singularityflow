/** Preparation selection and observations. No host locations, model wording, I/O or approval decisions. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {phaseBeginSelection,effectivePhasePublicationProducer,isConvergencePhase,
  phaseKernelOwned,phaseRequiresCodeDelivery} from './phase-policy.mjs';

const text=value=>typeof value==='string'&&value.length>0&&value.length<=4096;
const count=value=>Number.isSafeInteger(value)&&value>=0;
const digest=value=>typeof value==='string'&&/^(?:sha256:)?[a-f0-9]{64}$/u.test(value);
const nullable=(check,value)=>value===null||check(value);
const exact=(value,fields)=>value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).length===fields.length&&Object.keys(value).every(key=>fields.includes(key));
function bad(){throw new SingularityFlowError('The preparation port returned invalid or differently bound facts.',{code:'ENGINE_PORT_RESULT_INVALID'});}

export function phasePreparationSelection(workflow,inputs,modelEnabled) {
  if(typeof modelEnabled!=='boolean')bad();
  const {workId,phase,generation}=phaseBeginSelection(workflow,inputs),selected=workflow.phases[phase];
  const producer=effectivePhasePublicationProducer(selected,{modelEnabled});
  return {workId,phase,generation,producer,
    mode:isConvergencePhase(selected)&&producer==='deterministic'?'deterministic-convergence':'phase-draft',
    artifactKey:selected.requiredArtifact?.path??null,
    authoringRequired:producer!=='deterministic'||!phaseKernelOwned(selected),
    codeDeliveryRequired:phaseRequiresCodeDelivery(selected)};
}

export function phasePreparationManifest(binding,facts) {
  if(!exact(facts,['workId','phase','generation','producer','artifactKey','inputContext','generationIntent','convergence','generationOpened'])
    ||facts.workId!==binding.workId||facts.phase!==binding.phase||facts.generation!==binding.generation
    ||facts.producer!==binding.producer||facts.artifactKey!==binding.artifactKey
    ||!nullable(text,facts.artifactKey)||typeof facts.generationOpened!=='boolean')bad();
  const input=facts.inputContext,intent=facts.generationIntent,convergence=facts.convergence;
  if(input!==null&&(!exact(input,['generation','sha256','renderedSha256'])
    ||!nullable(count,input.generation)||!nullable(digest,input.sha256)||!nullable(digest,input.renderedSha256)))bad();
  if(intent!==null&&(!exact(intent,['id','generation','sha256'])
    ||!nullable(text,intent.id)||!nullable(count,intent.generation)||!nullable(digest,intent.sha256)))bad();
  if(facts.generationOpened&&(!binding.codeDeliveryRequired||!intent?.id||intent.generation!==binding.generation||!intent.sha256))bad();
  if(binding.mode==='deterministic-convergence'?convergence===null:convergence!==null)bad();
  if(convergence!==null&&(!exact(convergence,['iteration','sha256','factCount','settledCount','findingCount','undisposedItemIds','unresolvedBlockerCount'])
    ||!count(convergence.iteration)||convergence.iteration<1||!digest(convergence.sha256)
    ||['factCount','settledCount','findingCount','unresolvedBlockerCount'].some(key=>!count(convergence[key]))
    ||!Array.isArray(convergence.undisposedItemIds)||!convergence.undisposedItemIds.every(text)
    ||new Set(convergence.undisposedItemIds).size!==convergence.undisposedItemIds.length))bad();
  return {schemaVersion:1,contract:'sflow-phase-preparation-manifest/v1',workId:binding.workId,phase:binding.phase,
    generation:binding.generation,producer:binding.producer,mode:binding.mode,
    artifact:facts.artifactKey===null?null:{key:facts.artifactKey,contentVerified:false},
    authoringRequired:binding.authoringRequired,codeDeliveryRequired:binding.codeDeliveryRequired,
    inputContext:input?{...input,forPreparedGeneration:input.generation===binding.generation,integrityVerified:false}:null,
    generationIntent:intent?{...intent,forPreparedGeneration:intent.generation===binding.generation,integrityVerified:false}:null,
    convergence,publicationReadinessInspected:false,finalBindingChecked:false,testsRun:false,
    approvalRecorded:false,humanReviewRecorded:false};
}

/** Native projection summary shared with legacy hosts; it records no human disposition. */
export function convergencePreparationState(projection) {
  if (!projection) return null;
  const disposed = new Set((projection.findings ?? []).map((finding) => finding.itemId));
  const undisposedItemIds = [...(projection.facts ?? []), ...(projection.candidateSnapshot ?? [])]
    .map((item) => item.id)
    .filter((id) => !disposed.has(id));
  return {
    iteration: projection.iteration,
    sha256: projection.convergenceSha256,
    factCount: projection.facts?.length ?? 0,
    settledCount: projection.settledByPlan?.length ?? 0,
    findingCount: projection.findings?.length ?? 0,
    undisposedItemIds,
    unresolvedBlockers: projection.unresolvedBlockers ?? [],
    allowedNext: projection.allowedNext ?? []
  };
}
