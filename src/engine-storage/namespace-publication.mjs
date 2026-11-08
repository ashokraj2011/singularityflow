/** Explicit namespace publication composition. Installed Git hosts never select this writer. */
import {createHash} from 'node:crypto';
import {createEngine} from '../engine-sdk/index.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,PHASE_PUBLICATION_SCHEMAS,phasePublicationBindingValue} from '../foundation/record-schema.mjs';
import {artifactBytesAreText,artifactContentObservation,inspectRequiredArtifactObservation,inspectBinaryArtifactSize} from '../kernel/artifact-content.mjs';
import {primaryDocumentPublicationRequirements} from '../kernel/publication-intent.mjs';
import {buildGenerationAuthorship} from '../kernel/phase-policy.mjs';
import {beginGenerationPublication,appendGenerationAuthorship,resetGenerationDeliveryBindings} from '../kernel/lifecycle-transitions.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {namespaceScope,namespaceIdentifier,namespaceIdentityJson} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {createNamespacePreparationRuntime} from './namespace-preparation.mjs';
import {createNamespaceLifecycleCommitter} from './namespace-lifecycle-commit.mjs';
import {createNamespaceLifecycleObserver} from './namespace-lifecycle-reader.mjs';
import {lifecycleRecord} from './namespace-lifecycle-contract.mjs';
import {namespaceLifecycleStoryKey} from './namespace-lifecycle-reader.mjs';
import {namespacePublicationValue,NAMESPACE_PUBLICATION_PROFILE} from './namespace-publication-contract.mjs';
import {createNamespacePublicationReader} from './namespace-publication-reader.mjs';
export {NAMESPACE_PUBLICATION_PROFILE};

const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const error=(message,code,details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
function cancelled(signal){if(signal?.aborted)throw error('Publication was cancelled before its next effect.','ENGINE_OPERATION_CANCELLED');}

export function createNamespacePublicationEngine(options={}) {
  const {records,content,localRecords,localContent,access,clock,sources=[],modelEnabled=true,notice=()=>{}}=options;
  const scope=namespaceScope(options.scope),workId=namespaceIdentifier(options.workId,'Story ID'),authority=Object.freeze(structuredClone(options.authority));
  const runtime=createNamespacePreparationRuntime({records,content,localRecords,localContent,scope,workId,authority,access,clock,sources,modelEnabled});
  const committer=createNamespaceLifecycleCommitter({records,content,scope,workId,authority}),observer=createNamespaceLifecycleObserver({records,content,scope,workId,authority});
  const publicationReader=createNamespacePublicationReader({observer,scope,workId});
  const put=content.put.bind(content),now=clock.now.bind(clock),contexts=new WeakMap(),preparations=new WeakMap();
  if(typeof notice!=='function')throw error('Publication notice must be an explicit observer.','ENGINE_INPUT_INVALID');
  function selected(context){const value=contexts.get(context);if(!value)throw error('Use the issued publication context.','ENGINE_INPUT_INVALID');return value;}
  async function shared(data,signal) {
    cancelled(signal);const expected={namespace:'evidence',sha256:hash(data),bytes:data.byteLength},saved=await put(scope,'evidence',data,{signal});
    if(!same(contentReference(saved?.reference),expected)||typeof saved.reused!=='boolean')throw error('The content port stored another publication body.','ENGINE_PORT_RESULT_INVALID');
    await observer.bytes(expected,expected.bytes,signal);return expected;
  }
  function checkedPlan(plan,s) {
    if(plan&&(plan.operation!=='phase.publish'||plan.inputsSha256!==s.requestSha256))throw error('This publication ID has another retained request.','ENGINE_OPERATION_ID_REUSED');
    return plan;
  }
  async function readPublication(binding,s,signal) {
    return publicationReader.read(binding,s.phaseId,{signal});
  }
  async function retainedPublication(plan,s,signal) {
    checkedPlan(plan,s);const state=observer.state(await observer.bytes(plan.state,plan.state.bytes,signal),plan.basis.head),phase=state.workflow.phases[s.phaseId];
    const binding=(phase?.publicationBindings??[]).find(item=>item.generation===phase.generation);
    if(!binding)throw error('The prepared publication lost its retained binding.','ENGINE_STORAGE_CORRUPT');
    const publication=await readPublication(binding,s,signal);
    if(publication.operationId!==s.operationId||publication.requestSha256!==s.requestSha256||publication.draft.sha256!==s.identity.bodySha256
      ||publication.generation!==phase.generation||!same(publication.configuration,plan.basis.head.configuration)
      ||s.expectedRecord&&!same(s.expectedRecord,binding.record))throw error('The publication record has another operation or generation.','ENGINE_STORAGE_CORRUPT');
    return {phase,publication};
  }
  function facts(s,publication,accepted,retained=false) {
    const row=accepted.receipt.records.find(item=>item.namespace==='state'&&item.key===namespaceLifecycleStoryKey(workId));
    if(!row)throw error('The publication receipt has no accepted Story revision.','ENGINE_PORT_RESULT_INVALID');
    return {workId,phase:s.phaseId,generation:publication.generation,revision:row.version,pushed:false,artifact:publication.artifact.key,
      ...(retained?{retentionReason:'unchanged-document'}:{})};
  }
  const publication={notice,
    async load(input,{signal}={}) {
      cancelled(signal);
      if(input.workId!=null&&input.workId!==workId)throw error('Publication is bound to another Story.','ACTIVE_SUBJECT_MISMATCH');
      const missingPorts=[...(input.from!=null?['artifactImport']:[]),...(input.usageFile!=null||input.usage!=null?['telemetry']:[])];
      if(missingPorts.length)throw error('This publication host needs the declared import or telemetry owner for those inputs.','ENGINE_PORT_UNAVAILABLE',{
        operation:'phase.publish',ports:missingPorts});
      const peek=input.phaseId==null?await observer.inspect({signal}):null,phaseId=input.phaseId??peek.snapshot.workflow.currentPhase;
      namespaceIdentifier(phaseId,'Phase ID');
      const request={workId,phaseId,authored:input.authored??null,channel:input.channel??null,externalAiUse:input.externalAiUse??null,changeOrigins:input.changeOrigins??null};
      const requestSha256=hash(namespaceIdentityJson(request));let draft=null,identity=null,missing=null;
      try{draft=await runtime.captureDraft(phaseId,{signal});identity=runtime.draftIdentity(draft);}
      catch(cause){if(!['ENGINE_DRAFT_MISSING','ENGINE_STORAGE_CONTENT_MISSING'].includes(cause.code))throw cause;missing=cause;}
      const operationId=identity?'publish-'+hash(namespaceIdentityJson({scope,authority,workId,phaseId,draft:identity.bodySha256,request})):null;
      const context={subject:Object.freeze({kind:'story',id:workId}),phase:{id:phaseId},modelEnabled};
      contexts.set(context,{phaseId,draft,identity,requestSha256,operationId,peek,missing});return context;
    },
    async retained(context,_input,{signal}={}) {
      const s=selected(context);
      if(s.missing) {
        const peek=s.peek??await observer.inspect({signal}),phase=peek.snapshot.workflow.phases[s.phaseId];
        const binding=(phase?.publicationBindings??[]).find(item=>item.generation===phase.generation);
        if(!binding)throw s.missing;
        const record=await readPublication(binding,s,signal);
        if(record.requestSha256!==s.requestSha256)throw s.missing;
        s.operationId=record.operationId;s.identity={bodySha256:record.draft.sha256};s.expectedRecord=binding.record;
      }
      const accepted=await committer.inspect(s.operationId,{signal});
      if(accepted.status==='committed') {
        const plan=checkedPlan(await committer.intent(s.operationId,{signal}),s);
        if(!plan)throw error('The accepted publication lost its intent.','ENGINE_STORAGE_CORRUPT');
        return facts(s,(await retainedPublication(plan,s,signal)).publication,accepted,true);
      }
      if(s.missing)throw s.missing;
      const plan=checkedPlan(await committer.intent(s.operationId,{signal}),s);
      if(plan){s.plan=plan;context.phase=(await retainedPublication(plan,s,signal)).phase;}
      else {
        s.snapshot=await committer.capture({signal});context.phase=s.snapshot.workflow.phases[s.phaseId];
        if(!context.phase)throw error('The phase is not in this Story.','ENGINE_PHASE_UNAVAILABLE',{phase:s.phaseId});
      }
      return null;
    },
    async prepare(context,_input,intent,{signal}={}) {
      const s=selected(context),admission=await runtime.admitDraft(s.draft,'phase.publish',{signal}),observed=runtime.draftFacts(admission);
      const snapshot=s.snapshot??await committer.capture({signal}),phase=snapshot.workflow.phases[s.phaseId];
      if(snapshot.revision!==observed.revision||s.plan&&snapshot.revision!==s.plan.basis.headVersion)throw error('The Story changed before publication preparation.','ENGINE_CONTEXT_CHANGED');
      const required=primaryDocumentPublicationRequirements(snapshot.workflow,phase,{definition:observed.definition});
      if(required.length)throw error('This phase requires policy/execution owners not yet bound by the primary-document publication host.','ENGINE_PORT_UNAVAILABLE',{
        operation:'phase.publish',phase:s.phaseId,required});
      const data=runtime.artifactBytes(admission),text=artifactBytesAreText(data),observation=text?artifactContentObservation(data.toString('utf8')):null;
      const original=artifactContentObservation(runtime.initialArtifactBytes(admission).toString('utf8'));
      const configured={...phase,authoringBaseline:{generation:observed.payload.generation,fingerprint:'sha256:'+hash(original.fingerprintText)}};
      const fingerprint=observation?'sha256:'+hash(observation.fingerprintText):null;
      const findings=observation?inspectRequiredArtifactObservation(observation,configured,{path:observed.payload.artifact.key,generation:observed.payload.generation,fingerprint})
        :inspectBinaryArtifactSize(data.byteLength,configured,{path:observed.payload.artifact.key});
      if(findings.length)throw error('Complete the authored artifact before publication.','ARTIFACT_AUTHORING_INCOMPLETE',{
        workId,phase:s.phaseId,findings,operation:'phase.draft.write'});
      if(s.plan) {
        const retained=(await retainedPublication(s.plan,s,signal)).publication;
        if(!same(retained.actor,observed.actor)||retained.agentId!==observed.agentId)throw error('Resume publication under its original authenticated author.','ENGINE_ACTOR_CHANGED');
      }else{
        const artifact=await shared(data,signal),publishedAt=projectEnrollmentTimestamp(await now()),generation=observed.payload.generation;
        const sourceKey=(observed.definition.workItemRoot??'singularity/work-items')+'/'+workId+'/'+observed.payload.artifact.key;
        const authorship=buildGenerationAuthorship({options:intent.authorship,actor:observed.actor.identity,
          governedAgentContext:intent.authorship.producer==='governed-agent'?observed.agentId:null,
          source:null,generation});
        const record={schemaVersion:PHASE_PUBLICATION_SCHEMAS.manifest.currentVersion,format:'sflow-namespace-phase-publication/v1',profile:NAMESPACE_PUBLICATION_PROFILE,
          projectId:scope.projectId,workId,phase:s.phaseId,generation,operationId:s.operationId,requestSha256:s.requestSha256,
          baseRevision:snapshot.revision,configuration:snapshot.configuration,draft:{revision:observed.draftRevision,sha256:observed.bodySha256},
          actor:observed.actor,agentId:observed.agentId,publishedAt,authorship,
          artifact:{key:observed.payload.artifact.key,sourceKey,kind:phase.requiredArtifact.kind??'document',encoding:text?'utf8':'binary',content:artifact,fingerprint},inputs:observed.resources};
        namespacePublicationValue(record,{projectId:scope.projectId,workId,phaseId:s.phaseId});
        const reference=await shared(Buffer.from(canonicalJson(record)),signal),binding={schemaVersion:PHASE_PUBLICATION_SCHEMAS.binding.currentVersion,
          format:'sflow-phase-publication-binding/v1',generation,record:reference};phasePublicationBindingValue(binding);
        beginGenerationPublication(phase,{targetGeneration:generation,actor:observed.actor.identity,agent:observed.agentId,producer:intent.authorship.producer});
        appendGenerationAuthorship(phase,authorship,publishedAt);resetGenerationDeliveryBindings(phase);
        phase.publicationBindings=[...(phase.publicationBindings??[]).filter(item=>item.generation!==generation),binding];
        phase.artifacts=[{path:sourceKey,sha256:artifact.sha256,size:artifact.bytes,kind:record.artifact.kind}];
        snapshot.workflow.namespaceDocuments=[...(snapshot.workflow.namespaceDocuments??[]),{id:'PUB-'+s.phaseId+'-GEN-'+generation,phase:s.phaseId,generation,
          sourceKey,role:'artifact',name:phase.label??s.phaseId,kind:record.artifact.kind,mimeType:text?'text/markdown':'application/octet-stream',encoding:record.artifact.encoding,
          locality:'project',status:'active',aliases:[],content:artifact}];
        snapshot.workflow.history.push({at:publishedAt,actor:observed.actor.principalId,agent:observed.agentId,event:'phase_generated',phase:s.phaseId,detail:'generation '+generation});
        const body=lifecycleRecord('state',{projectId:scope.projectId,workId,authorityId:authority.id,epoch:authority.epoch,
          configuration:snapshot.configuration.content,workflow:snapshot.workflow});
        await runtime.revalidateDraft(admission,{signal});
        const evidence=[...new Map([artifact,reference,...observed.resources.map(item=>item.reference).filter(ref=>ref.namespace==='evidence')]
          .map(ref=>[canonicalJson(ref),ref])).values()];
        try{await committer.prepare(snapshot,{operationId:s.operationId,operation:'phase.publish',inputsSha256:s.requestSha256,
          state:Buffer.from(canonicalJson(body)),evidence},{signal});}
        catch(cause){if(!['ENGINE_OPERATION_ID_REUSED','SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code))throw cause;
          const competing=checkedPlan(await committer.intent(s.operationId,{signal}),s);if(!competing)throw cause;
          const original=(await retainedPublication(competing,s,signal)).publication;
          if(!same(original.actor,observed.actor)||original.agentId!==observed.agentId)throw cause;}
        s.plan=checkedPlan(await committer.intent(s.operationId,{signal}),s);
        if(!s.plan)throw error('Publication preparation has no retained intent.','ENGINE_STORAGE_CORRUPT');
      }
      const token=Object.freeze({});preparations.set(token,{context,admission});return token;
    },
    async commit(context,token,{signal}={}) {
      const s=selected(context),p=preparations.get(token);if(!p||p.context!==context)throw error('Use this publication preparation.','ENGINE_INPUT_INVALID');
      const accepted=await committer.inspect(s.operationId,{signal});if(accepted.status==='committed')return accepted;
      await runtime.revalidateDraft(p.admission,{signal});return committer.commit(s.operationId,{signal});
    },
    async finish(context,_prepared,accepted) {
      const s=selected(context),plan=checkedPlan(await committer.intent(s.operationId),s);
      if(!plan)throw error('The accepted publication has no retained intent.','ENGINE_STORAGE_CORRUPT');
      return facts(s,(await retainedPublication(plan,s,null)).publication,accepted);
    }
  };
  return createEngine({ports:{...runtime.ports,publication}});
}
