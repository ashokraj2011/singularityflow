/** Shared-only proof that each consumed dataset/query is an actual human-approved output. */
import {canonicalJson} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {createNamespaceSubmissionReader} from './namespace-submission-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
export async function namespaceApprovedWorkProductInputs({observer,scope,workId},snapshot,current,{signal,policyTraversal}={}){
  if(!current.assets.length)return [];
  const checks=createNamespacePhaseCheckReader({...observer.evidenceReads,observer}),packets=createNamespaceSubmissionReader({observer,scope,workId,checks}),
    ids=[...new Set(current.assets.map(row=>row.phase))],proofs=await packets.inspectApprovedMany(snapshot,ids,{signal,policyTraversal}),sources=[];
  for(const [i,id]of ids.entries()){
    const proof=proofs[i],upstream=packets.publicationReader.policies.workProductEvidence(proof.published);
    if(!upstream)throw new SingularityFlowError('An input needs its actual approved producing publication.',{code:'ENGINE_DATA_INPUT_APPROVAL_REQUIRED',details:{phaseId:id}});
    for(const row of current.assets.filter(r=>r.phase===id)){const {amendment,...original}=row;if(amendment)original.asset=amendment.originalAsset;
      if(row.generation!==proof.value.generation||!upstream.report.outputs.some(output=>same(output,original)))
      throw new SingularityFlowError('The input differs from its human-approved producing output.',{code:'ENGINE_DATA_INPUT_APPROVAL_REQUIRED',details:{assetId:row.asset.id,phaseId:id}});}
    sources.push({phase:id,generation:proof.value.generation,publication:proof.value.publication,submission:proof.binding,evidence:upstream.binding,requirementsTrace:upstream.report.requirementsTrace});
  }
  return sources;
}
