/** Publication byte/identity records. No admission, authority selection or I/O. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {namespacePublicationRecordProfile,canonicalJson} from '../foundation/record-schema.mjs';
import {exactObject,namespaceIdentifier,namespaceKey,namespaceRevision} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {sourceRelativePath} from '../foundation/source-snapshot.mjs';
import {storyActorValue} from '../kernel/story-creation.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {buildGenerationAuthorship,normalizeAuthorshipOptions} from '../kernel/phase-policy.mjs';
import {phaseCheckEvidenceBinding} from './namespace-phase-check-contract.mjs';
import {namespaceSpecificationBinding} from './namespace-specification-contract.mjs';
import {namespacePolicyEvidenceBinding} from './namespace-policy-contract.mjs';
export {NAMESPACE_SPECIFICATION_PUBLICATION_PROFILE} from './namespace-specification-contract.mjs';
export {NAMESPACE_POLICY_PUBLICATION_PROFILE} from './namespace-policy-contract.mjs';
export const NAMESPACE_PUBLICATION_PROFILE='sflow-primary-document-publication/v1';
export const NAMESPACE_CHECKED_PUBLICATION_PROFILE='sflow-primary-document-publication/v2';

export function namespacePublicationRecord(value,{checks=null,specifications=null,policyEvidence=null}={}) {
  if(!value||typeof value!=='object'||Array.isArray(value)||['schemaVersion','format','profile','checks','specifications','policyEvidence'].some(key=>Object.hasOwn(value,key)))
    throw new SingularityFlowError('Publication metadata must come from its registered profile.',{code:'ENGINE_INPUT_INVALID'});
  const profile=namespacePublicationRecordProfile({schemaVersion:policyEvidence!==null?4:specifications!==null?3:checks===null?1:2});
  return {schemaVersion:profile.version,format:profile.format,profile:profile.profile,...value,
    ...(profile.checks?{checks:checks===null&&profile.optionalChecks?null:phaseCheckEvidenceBinding(checks)}:{}),
    ...(profile.specifications?{specifications:specifications===null&&profile.optionalSpecifications?null:namespaceSpecificationBinding(specifications)}:{}),
    ...(profile.policyEvidence?{policyEvidence:policyEvidence.map(namespacePolicyEvidenceBinding)}:{})};
}

function publicationInput(value) {
  const reference=contentReference(value.reference);
  if(value.kind==='approved-input') {
    exactObject(value,['kind','phase','generation','reference','contract']);namespaceIdentifier(value.phase,'Input phase');
    if(!Number.isSafeInteger(value.generation)||value.generation<1||!Array.isArray(value.contract)||reference.namespace!=='evidence')throw Error('Invalid approved input binding.');
  }else {
    const supported=['story-source','supporting-document','agent','skill','instruction','constitution'];
    if(!supported.includes(value.kind))throw Error('Unknown publication input kind.');
    exactObject(value,['kind','id','reference',...(value.kind==='supporting-document'?['locality']:[])]);
    if(value.kind==='constitution')sourceRelativePath(value.id);
    else if(value.kind==='supporting-document') {
      if(typeof value.id!=='string'||!value.id||value.id.length>2048||/[\u0000-\u001f]/u.test(value.id))throw Error('Invalid document identity.');
    }else namespaceIdentifier(value.id,'Publication input');
    if(value.kind==='supporting-document'&&(!['project','machine-local'].includes(value.locality)
      ||(value.locality==='machine-local')!==(value.reference.namespace==='local')))throw Error('Invalid input locality.');
    if(value.kind==='story-source'?reference.namespace!=='state':value.kind!=='supporting-document'&&reference.namespace!=='config')throw Error('Invalid input namespace.');
  }
}

export function namespacePublicationValue(value,{projectId,workId,phaseId}={}) {
  let profile=null;
  try {
    profile=namespacePublicationRecordProfile(value);
    exactObject(value,['schemaVersion','format','profile','projectId','workId','phase','generation','operationId','requestSha256',
      'baseRevision','configuration','draft','actor','agentId','publishedAt','authorship','artifact','inputs',...(profile.checks?['checks']:[]),
      ...(profile.specifications?['specifications']:[]),...(profile.policyEvidence?['policyEvidence']:[])]);
    if(value.format!==profile.format||value.profile!==profile.profile||value.projectId!==projectId||value.workId!==workId||value.phase!==phaseId
      ||!Number.isSafeInteger(value.generation)||value.generation<1)throw Error('Another publication binding.');
    namespaceIdentifier(value.projectId,'Project ID');namespaceIdentifier(value.workId,'Story ID');namespaceIdentifier(value.phase,'Phase ID');
    namespaceIdentifier(value.operationId,'Publication operation');
    if(namespaceRevision(value.baseRevision)===null)throw Error('Publication requires an existing Story revision.');
    exactObject(value.actor,['principalId','actorKind','identity']);const actor=storyActorValue(value.actor);
    if(canonicalJson(actor)!==canonicalJson(value.actor))throw Error('The author identity is not a canonical retained binding.');
    projectEnrollmentTimestamp(value.publishedAt);if(value.agentId!==null)namespaceIdentifier(value.agentId,'Publication agent');
    if(!/^[a-f0-9]{64}$/u.test(value.requestSha256)||!/^[a-f0-9]{64}$/u.test(value.draft.sha256))throw Error('Invalid publication digest.');
    if(namespaceRevision(value.draft.revision)===null)throw Error('Publication requires an authored draft revision.');
    exactObject(value.draft,['revision','sha256']);
    exactObject(value.configuration,['key','content']);namespaceKey(value.configuration.key);
    if(contentReference(value.configuration.content).namespace!=='config')throw Error('Invalid configuration.');
    exactObject(value.artifact,['key','sourceKey','kind','encoding','content','fingerprint']);
    sourceRelativePath(value.artifact.key);sourceRelativePath(value.artifact.sourceKey);
    if(typeof value.artifact.kind!=='string'||!value.artifact.kind||!Array.isArray(value.inputs)||value.inputs.length>4096)throw Error('Invalid artifact kind or input bound.');
    if(contentReference(value.artifact.content).namespace!=='evidence'||!['utf8','binary'].includes(value.artifact.encoding)
      ||(value.artifact.encoding==='binary'?value.artifact.fingerprint!==null:!/^sha256:[a-f0-9]{64}$/u.test(value.artifact.fingerprint)))throw Error('Invalid retained artifact.');
    const identities=new Set();
    if(profile.checks&&(!profile.optionalChecks||value.checks!==null))phaseCheckEvidenceBinding(value.checks);
    if(profile.specifications&&(!profile.optionalSpecifications||value.specifications!==null))namespaceSpecificationBinding(value.specifications);
    if(profile.policyEvidence) {
      if(!Array.isArray(value.policyEvidence)||!value.policyEvidence.length||value.policyEvidence.length>16)throw Error('Invalid policy evidence bound.');
      const kinds=new Set();for(const binding of value.policyEvidence){namespacePolicyEvidenceBinding(binding);
        if(kinds.has(binding.kind))throw Error('Duplicate policy evidence kind.');kinds.add(binding.kind);}
    }
    for(const input of value.inputs) {
      publicationInput(input);const identity=canonicalJson([input.kind,input.id??input.phase]);
      if(identities.has(identity))throw Error('Duplicate retained publication input.');identities.add(identity);
    }
    const options=normalizeAuthorshipOptions({producer:value.authorship.producer,channel:value.authorship.channel,
      externalAiUse:value.authorship.externalAiUse?.status==='unavailable'?null:value.authorship.externalAiUse?.value,changeOrigins:value.authorship.changeOrigins});
    const authorship=buildGenerationAuthorship({options,actor:actor.identity,
      governedAgentContext:options.producer==='governed-agent'?value.agentId:null,source:null,generation:value.generation});
    if(canonicalJson(authorship)!==canonicalJson(value.authorship))throw Error('The publication authorship is not its bound author and observations.');
  }catch(cause){throw new SingularityFlowError('The retained namespace publication is invalid.',{cause,
    code:['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)
      ||profile?.specifications&&cause.code==='ENGINE_STORAGE_UNSUPPORTED'?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT'});}
  return value;
}
