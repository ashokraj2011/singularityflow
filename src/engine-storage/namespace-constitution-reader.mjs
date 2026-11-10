/** Replay the exact approved document and policy. Human judgment remains the phase approver's act. */
import {canonicalJson,admitRecordSchemaVersion,NAMESPACE_PHASE_POLICY_SCHEMAS} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {constitutionPublicationPolicies,CONSTITUTION_POLICY_EVIDENCE} from '../kernel/constitution-publication.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {namespaceCandidateContent} from './namespace-candidate-content.mjs';
import {namespaceConstitutionManifest} from './namespace-policy-contract.mjs';
import {namespaceSpecificationIdentity} from './namespace-specification-contract.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
let selectedRules=null;
async function policyRules(){if(selectedRules)return selectedRules;
  const {NODE_CONSTITUTION_VALUES}=await import('../engine-compatibility/node-constitution-policy.mjs');
  return selectedRules??=constitutionPublicationPolicies(NODE_CONSTITUTION_VALUES,NODE_TEXT_DIGESTS);}
const error=(message,code,details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
function text(bytes){try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch(cause){throw error('Constitution evidence requires its actual UTF-8 bytes.','ENGINE_ARTIFACT_ENCODING_INVALID',null,cause);}}
export {CONSTITUTION_POLICY_EVIDENCE};
export async function namespaceConstitutionObservation(approved,workflow,{read,configuration,artifact=null,signal}={}){
  const policy=workflow.resolution.constitution,found=policy?.mode!=='off'?approved.files.find(row=>row.path===policy.path):null;
  const document=found?{content:found.body,markdown:text(await read(found.body,found.body.bytes,signal))}:null;
  return (await policyRules()).observation({resolution:workflow.resolution,configuration,document,artifact});
}
export function assertNamespaceConstitution(report,phase=null){if(report.errors.length)throw error('Repair the constitution or its artifact citations against the exact pinned configuration.',
  'CONSTITUTION_POLICY_REQUIRED',{phase,errors:report.errors,findings:report.findings,operation:'phase.draft.write'});return report;}
export function createNamespaceConstitutionReader({observer,scope,workId}){
  async function candidate(publication,snapshot,{signal,artifactBytes}={}){
    const approved=await observer.approved(snapshot,{signal}),data=await namespaceCandidateContent(observer,publication.artifact.content,{signal,artifactBytes});
    const report=await namespaceConstitutionObservation(approved.compiled,snapshot.workflow,{read:observer.bytes,configuration:snapshot.configuration,
      artifact:{key:publication.artifact.sourceKey,content:publication.artifact.content,text:publication.artifact.encoding==='utf8'?text(data):null},signal});
    assertNamespaceConstitution(report,publication.phase);return {report,policy:{owners:['constitution-policy']}};
  }
  async function json(ref,signal){try{return JSON.parse(text(await observer.bytes(ref,ref.bytes,signal)));}
    catch(cause){if(cause.code)throw cause;throw error('Constitution proof is not retained JSON.','ENGINE_STORAGE_CORRUPT',null,cause);}}
  async function verify(publication,binding,{signal}={}){
    const manifest=namespaceConstitutionManifest(await json(binding.record,signal),{scope,workId,phaseId:publication.phase}),identity=namespaceSpecificationIdentity(publication);
    if(!same(identity,Object.fromEntries(Object.keys(identity).map(key=>[key,manifest[key]])))||manifest.recordedAt!==publication.publishedAt
      ||!same(manifest.artifact,{key:publication.artifact.sourceKey,content:publication.artifact.content})||!same(manifest.configuration,manifest.basis.head.configuration))
      throw error('The constitution proof has another artifact, author or configuration.','ENGINE_STORAGE_CORRUPT');
    const state=await observer.state(await observer.bytes(manifest.basis.head.state,manifest.basis.head.state.bytes,signal),manifest.basis.head,{signal}),
      snapshot={revision:manifest.basis.revision,configuration:manifest.basis.head.configuration,workflow:state.workflow},expected=await candidate(publication,snapshot,{signal}),report=await json(manifest.report,signal);
    try{admitRecordSchemaVersion(NAMESPACE_PHASE_POLICY_SCHEMAS.constitutionReport,report);}
    catch(cause){throw error('The constitution report has an unsupported or invalid schema.',
      ['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT',null,cause);}
    if(!same(report,expected.report))throw error('The constitution report differs from its exact original document and policy.','ENGINE_STORAGE_CORRUPT');
    return {binding,manifest,report,policy:expected.policy};
  }
  return Object.freeze({candidate,verify});
}
