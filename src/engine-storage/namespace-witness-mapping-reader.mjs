/** Exact published test proposals. Human authority and accepted approval receipts remain with their owners. */
import {createHash} from 'node:crypto';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {witnessMappingReviewPolicies} from '../kernel/human-witnesses.mjs';
import {NODE_TEXT_DIGESTS,NODE_TEXT_VALUE_SYNTAX} from '../records.mjs';
import {effectiveContract,mergedVerificationContracts,witnessMappingCore,witnessMappingSha256} from '../engine-compatibility/node-specification-policy.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),digest=value=>'sha256:'+createHash('sha256').update(canonicalJson(value)).digest('hex'),
  rules=witnessMappingReviewPolicies(NODE_TEXT_VALUE_SYNTAX,NODE_TEXT_DIGESTS),fail=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>{throw new SingularityFlowError(message,{code,details});};
export function namespaceWitnessMappingContext(snapshot,publication,plan,code){
  if(!code)fail('This publication has no exact Code test witnesses.','ENGINE_PORT_UNAVAILABLE',{required:['retained-code-policy']});
  const clauses=new Map(plan.active.indexes.flatMap(index=>index.clauses).map(clause=>[clause.id,clause])),
    contracts=mergedVerificationContracts([plan.planned]),proposals=new Map();
  for(const repository of code.report.repositories)for(const entry of repository.witnesses){
    const witness=entry.witness;if(!witness.identity||(witness.gaps??[]).length)continue;
    const clause=clauses.get(witness.clauseId);if(!clause?.bodySha256)fail('A published witness lost its original approved criterion.','WEL_WITNESS_MAPPING_STALE');
    const contract=effectiveContract(clause.id,contracts,plan.planned.claims[clause.id]);if(!contract)continue;
    const root=plan.repositoryPlan?.roots.find(row=>row.repositoryId===repository.id);
    if(plan.repositoryPlan&&!root)fail('A witness has no original approved repository root.');
    const testSource=root&&root.pathPrefix!=='.'?root.pathPrefix+'/'+witness.testSource:witness.testSource,
      core=witnessMappingCore({...witness,testSource},{clauseBodySha256:clause.bodySha256,contract}),mappingSha256=witnessMappingSha256(core);
    proposals.set(mappingSha256,{mappingSha256,...core});
  }
  const mappings=[...proposals.values()].sort((a,b)=>a.mappingSha256.localeCompare(b.mappingSha256)),
    identity={schemaVersion:1,profile:'sflow-namespace-witness-mapping-context/v1',workId:snapshot.workflow.workItem.id,phase:publication.phase,generation:publication.generation,
      configuration:publication.configuration,artifact:publication.artifact.content,checks:publication.checks,plan:plan.proof,mappings};
  return {identity,contextSha256:digest(identity),mappings};
}
export function namespaceWitnessMappingReview(context,answers,at,expectedContext,prior=[]){
  if(expectedContext!==context.contextSha256)fail('The tests, criteria or approved plan changed after inspection. Reopen the exact witness review.','WEL_WITNESS_MAPPING_STALE',{
    actions:[{operation:'test-witness.context',inputs:{workId:context.identity.workId,phaseId:context.identity.phase}}]});
  const result=rules.evaluateWitnessMappingReview({mappings:context.mappings,decisions:answers??[],prior,now:Date.parse(at)});
  if(!result.valid)fail('Correct the explicit test adequacy decisions for this published generation.','WEL_WITNESS_MAPPING_UNREVIEWED',{errors:result.errors});
  return {schemaVersion:1,profile:'sflow-namespace-witness-mapping-review/v1',contextSha256:context.contextSha256,answers:answers??[],decisions:result.decisions};
}
export function assertNamespaceWitnessMappingReview(expected,actual){if(!same(expected,actual))fail('The approval test review differs from its original exact proposals and answers.');}
export function namespaceWitnessMappingInput(graph,decisions,renewals){return {...graph,inputSha256:digest({profile:'sflow-namespace-witness-evidence-input/v1',
  source:graph.inputSha256,decisions:[...new Map(decisions.map(row=>[row.mappingSha256,row])).values()].sort((a,b)=>canonicalJson(a).localeCompare(canonicalJson(b))),renewals})};}
