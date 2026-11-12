/** Explicit namespace publication composition. Installed Git hosts never select this writer. */
import {createHash} from 'node:crypto';
import {createEngine} from '../engine-sdk/index.mjs';
import {createNamespaceReadSession} from './namespace-read-session.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,PHASE_PUBLICATION_SCHEMAS,phasePublicationBindingValue} from '../foundation/record-schema.mjs';
import {validateSourceUnit} from '../foundation/source-snapshot.mjs';
import {artifactBytesAreText,artifactContentObservation,inspectRequiredArtifactObservation,inspectBinaryArtifactSize} from '../kernel/artifact-content.mjs';
import {primaryDocumentPublicationRequirements,codePublicationPolicy,CODE_PUBLICATION_OWNERS,codeInputPublicationPolicy,CODE_INPUT_PUBLICATION_OWNERS,conformancePublicationPolicy,CONFORMANCE_PUBLICATION_OWNERS,convergencePublicationPolicy,CONVERGENCE_PUBLICATION_OWNERS} from '../kernel/publication-intent.mjs';
import {specificationPublicationPolicy,SPECIFICATION_PUBLICATION_OWNERS} from '../kernel/specification-publication.mjs';
import {specificationAnalysisPublicationPolicy} from '../kernel/specification-analysis.mjs';
import {resolvedClarificationPolicy} from '../kernel/clarification-responses.mjs';
import {buildGenerationAuthorship,phaseAssignmentRequired} from '../kernel/phase-policy.mjs';
import {beginGenerationPublication,appendGenerationAuthorship,resetGenerationDeliveryBindings} from '../kernel/lifecycle-transitions.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {namespaceScope,namespaceIdentifier,namespaceIdentityJson} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {createNamespacePreparationRuntime} from './namespace-preparation.mjs';
import {createNamespaceLifecycleCommitter} from './namespace-lifecycle-commit.mjs';
import {commitNamespaceOperation,prepareNamespaceOperation} from './namespace-commit-coordination.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {lifecycleRecord} from './namespace-lifecycle-contract.mjs';
import {namespaceLifecycleStoryKey} from './namespace-lifecycle-reader.mjs';
import {namespacePublicationValue,namespacePublicationRecord,NAMESPACE_PUBLICATION_PROFILE,NAMESPACE_CHECKED_PUBLICATION_PROFILE,NAMESPACE_SPECIFICATION_PUBLICATION_PROFILE,NAMESPACE_POLICY_PUBLICATION_PROFILE} from './namespace-publication-contract.mjs';
import {createNamespacePublicationReader} from './namespace-publication-reader.mjs';
import {createNamespaceTestCommandOwners} from './namespace-test-command-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {createNamespaceReadPorts} from './namespace-reader.mjs';
import {createNamespaceSpecificationWriter} from './namespace-specification-retention.mjs';
import {createNamespacePublicationPolicyWriter} from './namespace-policy-retention.mjs';
import {namespaceArtifactSetPolicies} from '../kernel/namespace-artifact-sets.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from '../engine-compatibility/node-configuration-path.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
export {NAMESPACE_PUBLICATION_PROFILE,NAMESPACE_CHECKED_PUBLICATION_PROFILE,NAMESPACE_SPECIFICATION_PUBLICATION_PROFILE,NAMESPACE_POLICY_PUBLICATION_PROFILE};

const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const error=(message,code,details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
function cancelled(signal){if(signal?.aborted)throw error('Publication was cancelled before its next effect.','ENGINE_OPERATION_CANCELLED');}

export function createNamespacePublicationPort(options={},runtime=null) {
  const {records,content,clock,modelEnabled=true,notice=()=>{}}=options;
  const scope=namespaceScope(options.scope),workId=namespaceIdentifier(options.workId,'Story ID'),authority=Object.freeze(structuredClone(options.authority));
  const committer=createNamespaceLifecycleCommitter({records,content,scope,workId,authority}),observer=createNamespaceStoryObserver({records,content,scope,workId,authority});
  const checks=createNamespacePhaseCheckReader({records,content,scope,workId,authority,observer});
  const publicationReader=createNamespacePublicationReader({observer,scope,workId,checks});
  const specificationWriter=createNamespaceSpecificationWriter({observer,scope,workId,content,reader:publicationReader.specifications});
  const policyWriter=createNamespacePublicationPolicyWriter({observer,scope,workId,content,reader:publicationReader.policies});
  const artifactSets=namespaceArtifactSetPolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_DIGESTS);
  const sources=(options.sources??[]).map(unit=>Object.freeze({descriptor:structuredClone(validateSourceUnit(unit)),capture:unit.capture.bind(unit)}));
  const put=content.put.bind(content),now=clock.now.bind(clock),contexts=new WeakMap(),preparations=new WeakMap();
  if(typeof notice!=='function')throw error('Publication notice must be an explicit observer.','ENGINE_INPUT_INVALID');
  function selected(context){const value=contexts.get(context);if(!value)throw error('Use the issued publication context.','ENGINE_INPUT_INVALID');return value;}
  const workingRequired=phase=>error('New publication requires an explicit machine-local working store.','ENGINE_PORT_UNAVAILABLE',{
    operation:'phase.publish',phase,required:['machine-local-working-store']});
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
    checkedPlan(plan,s);const state=await observer.state(await observer.bytes(plan.state,plan.state.bytes,signal),plan.basis.head,{signal}),phase=state.workflow.phases[s.phaseId];
    const binding=(phase?.publicationBindings??[]).find(item=>item.generation===phase.generation);
    if(!binding)throw error('The prepared publication lost its retained binding.','ENGINE_STORAGE_CORRUPT');
    const publication=await readPublication(binding,s,signal);
    if(publication.operationId!==s.operationId||publication.requestSha256!==s.requestSha256||publication.draft.sha256!==s.identity.bodySha256
      ||publication.generation!==phase.generation||!same(publication.configuration,plan.basis.head.configuration)
      ||s.expectedRecord&&!same(s.expectedRecord,binding.record))throw error('The publication record has another operation or generation.','ENGINE_STORAGE_CORRUPT');
    publicationReader.verifyPlan(publication,plan);
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
      if(runtime===null)missing=workingRequired(phaseId);
      else try{draft=await runtime.captureDraft(phaseId,{signal});identity=runtime.draftIdentity(draft);}
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
      const observed=await observer.inspect({signal}),publishedPhase=observed.snapshot.workflow.phases[s.phaseId];
      const clarificationMode=resolvedClarificationPolicy({},observed.snapshot.workflow,publishedPhase).mode;
      if(publishedPhase?.qualityCommands?.length||observed.snapshot.workflow.testCommandDecisions?.length||clarificationMode!=='off'||codePublicationPolicy(observed.snapshot.workflow,publishedPhase)){
        const binding=publishedPhase.publicationBindings?.find(item=>item.generation===publishedPhase.generation);
        if(binding){const publication=await readPublication(binding,s,signal);
          if(publication.draft.sha256===s.identity.bodySha256&&publication.requestSha256===s.requestSha256){
            s.operationId=publication.operationId;s.expectedRecord=binding.record;
            const receipt=await committer.inspect(s.operationId,{signal}),plan=checkedPlan(await committer.intent(s.operationId,{signal}),s);
            if(receipt.status!=='committed'||!plan)throw error('The publication has no accepted original receipt.','ENGINE_STORAGE_CORRUPT');
            return facts(s,(await retainedPublication(plan,s,signal)).publication,receipt,true);
          }
        }
      }
      const plan=checkedPlan(await committer.intent(s.operationId,{signal}),s);
      if(plan){s.plan=plan;context.phase=(await retainedPublication(plan,s,signal)).phase;}
      else {
        s.snapshot=await committer.capture({signal});await observer.approved(s.snapshot,{signal});context.phase=s.snapshot.workflow.phases[s.phaseId];
        if(!context.phase)throw error('The phase is not in this Story.','ENGINE_PHASE_UNAVAILABLE',{phase:s.phaseId});
      }
      return null;
    },
    async prepare(context,_input,intent,{signal}={}) {
      const s=selected(context);if(runtime===null)throw workingRequired(s.phaseId);
      const current=s.snapshot??await committer.capture({signal}),currentPhase=current.workflow.phases[s.phaseId],
        clarificationMode=resolvedClarificationPolicy({},current.workflow,currentPhase).mode,
        commandProof=await createNamespaceTestCommandOwners({observer,scope,workId}).commands(current,s.phaseId,{signal});
      if(commandProof.commands.length||clarificationMode!=='off'||codePublicationPolicy(current.workflow,currentPhase)){
        s.snapshot=current;
        s.admission=await runtime.admitDraft(s.draft,'phase.publish',{signal});
        const observed=runtime.draftFacts(s.admission);
        if(commandProof.commands.length)s.checkEvidence=await checks.forDraft({phaseId:s.phaseId,generation:observed.payload.generation,baseRevision:observed.revision,
          draft:s.identity,artifact:observed.payload.artifact.current,configuration:s.snapshot.configuration},{signal});
        if(clarificationMode!=='off') {
          const candidate=await publicationReader.policies.clarificationCandidate({phase:s.phaseId,generation:observed.payload.generation,
            agentId:observed.agentId,inputs:observed.resources,authorship:intent.authorship},s.snapshot,{signal});
          s.clarificationObservation=candidate.checkpoint.observed;
        }
        if(codePublicationPolicy(current.workflow,currentPhase))s.codeSource=await publicationReader.policies.codeSourceBinding(current,{
          phaseId:s.phaseId,generation:observed.payload.generation,baseRevision:observed.revision,draft:s.identity,
          artifact:observed.payload.artifact.current,configuration:current.configuration},{signal});
        // A repaired run gets its own candidate; an earlier conditional publication stays immutable.
        s.operationId='publish-'+hash(namespaceIdentityJson({scope,authority,workId,phaseId:s.phaseId,draft:s.identity.bodySha256,
          requestSha256:s.requestSha256,...(s.checkEvidence?{checks:s.checkEvidence}:{}),
          ...(s.clarificationObservation?{clarification:s.clarificationObservation}:{}),...(s.codeSource?{source:s.codeSource}:{})}));
        s.plan=checkedPlan(await committer.intent(s.operationId,{signal}),s);
      }
      return prepareNamespaceOperation(committer,s.operationId,async()=>{
        const admission=s.admission??await runtime.admitDraft(s.draft,'phase.publish',{signal}),observed=runtime.draftFacts(admission);
        const snapshot=s.snapshot??await committer.capture({signal}),phase=snapshot.workflow.phases[s.phaseId];
        await observer.approved(snapshot,{signal});
        if(snapshot.revision!==observed.revision||s.plan&&snapshot.revision!==s.plan.basis.headVersion)throw error('The Story changed before publication preparation.','ENGINE_CONTEXT_CHANGED');
        let required=primaryDocumentPublicationRequirements(snapshot.workflow,phase,{definition:observed.definition});
        if(s.checkEvidence){await checks.freshSources(s.checkEvidence,s.phaseId,sources,{signal});required=required.filter(item=>item!=='check-execution');}
        const specificationPolicy=specificationPublicationPolicy(snapshot.workflow,phase);
        const analysisPolicy=specificationAnalysisPublicationPolicy(observed.definition,snapshot.workflow,phase);
        const clarificationPolicy=resolvedClarificationPolicy(observed.definition,snapshot.workflow,phase);
        const codePolicy=codePublicationPolicy(snapshot.workflow,phase);
        const convergencePolicy=convergencePublicationPolicy(snapshot.workflow,phase),codeInputsPolicy=convergencePolicy?null:codeInputPublicationPolicy(snapshot.workflow,phase),conformancePolicy=conformancePublicationPolicy(snapshot.workflow,phase);
        const assignmentRequired=phaseAssignmentRequired(snapshot.workflow,observed.definition),constitutionRequired=snapshot.workflow.resolution.constitution?.mode!=='off';
        const artifactSet=artifactSets.declaration(observed.definition,snapshot.workflow,phase);
        const available=[...(specificationPolicy?SPECIFICATION_PUBLICATION_OWNERS:[]),...(analysisPolicy?['specification-analysis']:[]),
          ...(clarificationPolicy.mode!=='off'?['clarification-record']:[]),...(codePolicy?CODE_PUBLICATION_OWNERS:[]),...(convergencePolicy?CONVERGENCE_PUBLICATION_OWNERS:[]),...(codeInputsPolicy?CODE_INPUT_PUBLICATION_OWNERS:[]),...(conformancePolicy?CONFORMANCE_PUBLICATION_OWNERS:[]),...(artifactSet?['artifact-set']:[]),...(assignmentRequired?['assignment-record']:[]),...(constitutionRequired?['constitution-policy']:[])];
        const pending=required.filter(item=>!available.includes(item));
        if(pending.length)throw error('This phase requires policy/execution owners not yet bound by the primary-document publication host.','ENGINE_PORT_UNAVAILABLE',{
          operation:'phase.publish',phase:s.phaseId,required:pending});
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
          const base={projectId:scope.projectId,workId,phase:s.phaseId,generation,operationId:s.operationId,requestSha256:s.requestSha256,
            baseRevision:snapshot.revision,configuration:snapshot.configuration,draft:{revision:observed.draftRevision,sha256:observed.bodySha256},
            actor:observed.actor,agentId:observed.agentId,publishedAt,authorship,
            artifact:{key:observed.payload.artifact.key,sourceKey,kind:phase.requiredArtifact.kind??'document',encoding:text?'utf8':'binary',content:artifact,fingerprint},inputs:observed.resources};
          let specifications=null,analysis=null,clarification=null,codeEvidence=null,codeInputs=null,conformance=null,bundle=null,assignment=null,constitution=null,convergence=null;
          if(convergencePolicy||specificationPolicy||analysisPolicy||clarificationPolicy.mode!=='off'||codePolicy||codeInputsPolicy||conformancePolicy||artifactSet||assignmentRequired||constitutionRequired) {
            const head=await observer.record('state',namespaceLifecycleStoryKey(workId),false,signal);
            if(head.version!==snapshot.revision)throw error('The Story changed before specification retention.','ENGINE_CONTEXT_CHANGED');
            if(specificationPolicy)specifications=await specificationWriter.retain(base,{snapshot,head:head.value,signal});
            if(clarificationPolicy.mode!=='off')clarification=await policyWriter.retainClarification(base,{snapshot,head:head.value,signal});
            if(analysisPolicy)analysis=await policyWriter.retain(clarification?{...base,policyEvidence:[clarification]}:base,{snapshot,head:head.value,signal});
            if(codePolicy){codeEvidence=await policyWriter.retainCode({...base,checks:s.checkEvidence??null},{snapshot,head:head.value,signal});
              if(!same(codeEvidence.sourceBinding,s.codeSource))throw error(
                'Code source evidence changed while preparing publication. Reinspect its retained candidate.','ENGINE_CONTEXT_CHANGED');}
            if(codeInputsPolicy)codeInputs=await policyWriter.retainCodeInputs({...base,checks:s.checkEvidence??null},{snapshot,head:head.value,signal});
            if(convergencePolicy)convergence=await policyWriter.retainConvergence(base,{snapshot,head:head.value,signal});
            if(conformancePolicy)conformance=await policyWriter.retainConformance({...base,checks:s.checkEvidence??null},{snapshot,head:head.value,signal});
            if(constitutionRequired)constitution=await policyWriter.retainConstitution(base,{snapshot,head:head.value,signal});
            if(assignmentRequired)assignment=await policyWriter.retainAssignment(base,{snapshot,head:head.value,signal});
            if(artifactSet){const members=[];for(const member of observed.payload.members??[])members.push({path:member.path,data:await runtime.artifactMemberBytes(admission,member.path,{signal})});
              bundle=await policyWriter.retainArtifactSet(base,{snapshot,head:head.value,signal,members});}
          }
          const policyEvidence=[...(convergence?[convergence.binding]:[]),...(clarification?[clarification]:[]),...(analysis?[analysis.binding]:[]),...(codeEvidence?[codeEvidence.binding]:[]),...(codeInputs?[codeInputs.binding]:[]),...(conformance?[conformance.binding]:[]),...(bundle?[bundle.binding]:[]),...(assignment?[assignment.binding]:[]),...(constitution?[constitution.binding]:[])];
          const record=namespacePublicationRecord(base,{checks:s.checkEvidence??null,specifications,policyEvidence:policyEvidence.length?policyEvidence:null});
          namespacePublicationValue(record,{projectId:scope.projectId,workId,phaseId:s.phaseId});
          const reference=await shared(Buffer.from(canonicalJson(record)),signal),binding={schemaVersion:PHASE_PUBLICATION_SCHEMAS.binding.currentVersion,
            format:'sflow-phase-publication-binding/v1',generation,record:reference};phasePublicationBindingValue(binding);
          const verified=specifications||policyEvidence.length?await publicationReader.read(binding,s.phaseId,{signal}):record;
          if(codePolicy&&!s.checkEvidence)await publicationReader.policies.freshCodeSources(verified,sources,{signal});
          if(convergencePolicy||codeInputsPolicy||conformancePolicy)await publicationReader.policies.freshInputSources(verified,sources,{signal});
          const fulfilled=[...publicationReader.specifications.owners(verified),...publicationReader.policies.owners(verified)];
          required=required.filter(owner=>!fulfilled.includes(owner));
          if(required.length)throw error('This phase still requires its remaining publication policy owners.','ENGINE_PORT_UNAVAILABLE',{
            operation:'phase.publish',phase:s.phaseId,required});
          beginGenerationPublication(phase,{targetGeneration:generation,actor:observed.actor.identity,agent:observed.agentId,producer:intent.authorship.producer});
          appendGenerationAuthorship(phase,authorship,publishedAt);resetGenerationDeliveryBindings(phase);
          phase.publicationBindings=[...(phase.publicationBindings??[]).filter(item=>item.generation!==generation),binding];
          phase.artifacts=[{path:sourceKey,sha256:artifact.sha256,size:artifact.bytes,kind:record.artifact.kind}];
          snapshot.workflow.namespaceDocuments=[...(snapshot.workflow.namespaceDocuments??[]),{id:'PUB-'+s.phaseId+'-GEN-'+generation,phase:s.phaseId,generation,
            sourceKey,role:'artifact',name:phase.label??s.phaseId,kind:record.artifact.kind,mimeType:text?'text/markdown':'application/octet-stream',encoding:record.artifact.encoding,
            locality:'project',status:'active',aliases:[],content:artifact}];
          if(bundle){const root=sourceKey.slice(0,-artifactSet.set.primary.length);
            if(publicationReader.policies.artifactSetEvidence(verified)?.report.repair)delete phase.surgicalReopen;
            snapshot.workflow.namespaceDocuments.push({id:'BUNDLE-'+s.phaseId+'-GEN-'+generation,phase:s.phaseId,generation,
              sourceKey:(observed.definition.workItemRoot??'singularity/work-items')+'/'+workId+'/context/'+s.phaseId+'-artifact-set-gen'+generation+'.json',
              role:'file',name:'Typed output bundle',kind:'artifact-set',mimeType:'application/json',encoding:'utf8',locality:'project',status:'active',aliases:[],content:bundle.report});
            for(const member of bundle.members){const memberKey=root+member.path;
              phase.artifacts.push({path:memberKey,sha256:member.content.sha256,size:member.content.bytes,kind:'artifact-set-member'});
              snapshot.workflow.namespaceDocuments.push({id:'MEMBER-'+s.phaseId+'-GEN-'+generation+'-'+hash(member.path).slice(0,24),phase:s.phaseId,generation,
                sourceKey:memberKey,role:'file',name:member.path,kind:'artifact-set-member',mimeType:member.encoding==='utf8'?'text/plain':'application/octet-stream',encoding:member.encoding,
                locality:'project',status:'active',aliases:[],content:member.content});}}
          if(analysis)snapshot.workflow.namespaceDocuments.push({id:'ANALYSIS-'+s.phaseId+'-GEN-'+generation,phase:s.phaseId,generation,
            sourceKey:(observed.definition.workItemRoot??'singularity/work-items')+'/'+workId+'/context/'+s.phaseId+'-analysis-gen'+generation+'.json',
            role:'file',name:'Specification analysis',kind:'specification-analysis',mimeType:'application/json',encoding:'utf8',locality:'project',status:'active',aliases:[],content:analysis.report});
          if(constitution)snapshot.workflow.namespaceDocuments.push({id:'CONSTITUTION-'+s.phaseId+'-GEN-'+generation,phase:s.phaseId,generation,
            sourceKey:(observed.definition.workItemRoot??'singularity/work-items')+'/'+workId+'/context/'+s.phaseId+'-constitution-gen'+generation+'.json',
            role:'file',name:'Pinned constitution and citations',kind:'constitution-policy',mimeType:'application/json',encoding:'utf8',locality:'project',status:'active',aliases:[],content:constitution.report});
          if(assignment)snapshot.workflow.namespaceDocuments.push({id:'ASSIGNMENT-'+s.phaseId+'-GEN-'+generation,phase:s.phaseId,generation,
            sourceKey:(observed.definition.workItemRoot??'singularity/work-items')+'/'+workId+'/context/'+s.phaseId+'-assignment-gen'+generation+'.json',
            role:'file',name:'Phase coordination',kind:'phase-assignment',mimeType:'application/json',encoding:'utf8',locality:'project',status:'active',aliases:[],content:assignment.report});
          if(codeEvidence)snapshot.workflow.namespaceDocuments.push({id:'CODE-'+s.phaseId+'-GEN-'+generation,phase:s.phaseId,generation,
            sourceKey:(observed.definition.workItemRoot??'singularity/work-items')+'/'+workId+'/context/'+s.phaseId+'-code-policy-gen'+generation+'.json',
            role:'file',name:'Code delivery evidence',kind:'code-delivery',mimeType:'application/json',encoding:'utf8',locality:'project',status:'active',aliases:[],content:codeEvidence.report});
          for(const output of publicationReader.policies.resources(verified).filter(row=>row.kind==='retained-output')){
            const data=await observer.bytes(output.reference,output.reference.bytes,signal),encoding=artifactBytesAreText(data)?'utf8':'binary';
            phase.artifacts.push({path:output.sourceKey,sha256:output.reference.sha256,size:output.reference.bytes,kind:'retained-output'});
            snapshot.workflow.namespaceDocuments.push({id:'OUTPUT-'+s.phaseId+'-GEN-'+generation+'-'+hash(output.sourceKey).slice(0,24),phase:s.phaseId,generation,
              sourceKey:output.sourceKey,role:'file',name:output.sourceKey.split('/').at(-1),kind:'retained-output',mimeType:'application/octet-stream',encoding,
              locality:'project',status:'active',aliases:[],content:output.reference});}
          if(codeInputs)snapshot.workflow.namespaceDocuments.push({id:'CODE-INPUTS-'+s.phaseId+'-GEN-'+generation,phase:s.phaseId,generation,
            sourceKey:(observed.definition.workItemRoot??'singularity/work-items')+'/'+workId+'/context/'+s.phaseId+'-code-inputs-gen'+generation+'.json',
            role:'file',name:'Approved Code inputs',kind:'code-inputs',mimeType:'application/json',encoding:'utf8',locality:'project',status:'active',aliases:[],content:codeInputs.report});
          if(conformance)snapshot.workflow.namespaceDocuments.push({id:'CONFORMANCE-'+s.phaseId+'-GEN-'+generation,phase:s.phaseId,generation,
            sourceKey:(observed.definition.workItemRoot??'singularity/work-items')+'/'+workId+'/context/'+s.phaseId+'-conformance-gen'+generation+'.json',
            role:'file',name:'Conformance evidence',kind:'conformance',mimeType:'application/json',encoding:'utf8',locality:'project',status:'active',aliases:[],content:conformance.report});
          if(clarification) {
            const checkpointResource=publicationReader.policies.resources(verified).find(item=>item.kind==='clarification-record');
            if(!checkpointResource)throw error('The accepted checkpoint has no readable evidence reference.','ENGINE_STORAGE_CORRUPT');
            snapshot.workflow.namespaceDocuments.push({id:'CLARIFICATION-'+s.phaseId+'-GEN-'+generation,phase:s.phaseId,generation,
              sourceKey:(observed.definition.workItemRoot??'singularity/work-items')+'/'+workId+'/context/clarifications-'+s.phaseId+'-gen'+generation+'.json',
              role:'file',name:'Clarification checkpoint',kind:'clarification-record',mimeType:'application/json',encoding:'utf8',locality:'project',status:'active',aliases:[],content:checkpointResource.reference});
          }
          snapshot.workflow.history.push({at:publishedAt,actor:observed.actor.principalId,agent:observed.agentId,event:'phase_generated',phase:s.phaseId,detail:'generation '+generation});
          const body=lifecycleRecord('state',{projectId:scope.projectId,workId,authorityId:authority.id,epoch:authority.epoch,
            configuration:snapshot.configuration.content,workflow:snapshot.workflow});
          await runtime.revalidateDraft(admission,{signal});
          const evidence=[...new Map([artifact,reference,...publicationReader.specifications.evidence(verified),...publicationReader.policies.evidence(verified),...(s.checkEvidence?[s.checkEvidence.result.content]:[]),...observed.resources.map(item=>item.reference).filter(ref=>ref.namespace==='evidence')]
            .map(ref=>[canonicalJson(ref),ref])).values()];
          const readBindings=[...publicationReader.policies.readBindings(verified),...(s.checkEvidence?checks.readBindings(s.checkEvidence):[])];
          try{await committer.prepare(snapshot,{operationId:s.operationId,operation:'phase.publish',inputsSha256:s.requestSha256,
            state:Buffer.from(canonicalJson(body)),evidence,...(readBindings.length?{readBindings}:{})},{signal});}
          catch(cause){if(!['ENGINE_OPERATION_ID_REUSED','SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code))throw cause;
            const competing=checkedPlan(await committer.intent(s.operationId,{signal}),s);if(!competing)throw cause;
            const original=(await retainedPublication(competing,s,signal)).publication;
            if(!same(original.actor,observed.actor)||original.agentId!==observed.agentId)throw cause;}
          s.plan=checkedPlan(await committer.intent(s.operationId,{signal}),s);
          if(!s.plan)throw error('Publication preparation has no retained intent.','ENGINE_STORAGE_CORRUPT');
        }
        const token=Object.freeze({});preparations.set(token,{context,admission});return token;
      },async accepted=>{
        const plan=checkedPlan(await committer.intent(s.operationId,{signal}),s);
        if(!plan)throw error('The accepted publication lost its retained candidate.','ENGINE_STORAGE_CORRUPT');
        await retainedPublication(plan,s,signal);s.plan=plan;
        const token=Object.freeze({});preparations.set(token,{context,accepted});return token;
      },{signal});
    },
    async commit(context,token,{signal}={}) {
      const s=selected(context),p=preparations.get(token);if(!p||p.context!==context)throw error('Use this publication preparation.','ENGINE_INPUT_INVALID');
      if(p.accepted)return p.accepted;
      return commitNamespaceOperation(committer,s.operationId,async()=>{
        await runtime.revalidateDraft(p.admission,{signal});
        if(s.checkEvidence)await checks.freshSources(s.checkEvidence,s.phaseId,sources,{signal});
        const retained=(await retainedPublication(s.plan,s,signal)).publication,owners=publicationReader.policies.owners(retained);
        if(!s.checkEvidence&&owners.includes('code-delivery'))await publicationReader.policies.freshCodeSources(retained,sources,{signal});
        if(owners.includes('code-delivery-inputs'))await publicationReader.policies.freshInputSources(retained,sources,{signal});
      },{signal});
    },
    async finish(context,_prepared,accepted) {
      const s=selected(context),plan=checkedPlan(await committer.intent(s.operationId),s);
      if(!plan)throw error('The accepted publication has no retained intent.','ENGINE_STORAGE_CORRUPT');
      return facts(s,(await retainedPublication(plan,s,null)).publication,accepted);
    }
  };
  return publication;
}

export function createNamespacePublicationEngine(options={}) {
  const readSession=createNamespaceReadSession({records:options?.records,content:options?.content});
  options={...options,records:readSession.records,content:readSession.content};
  const {records,content,localRecords,localContent,access,clock,sources=[],modelEnabled=true,notice=()=>{},
    scope:givenScope,workId:givenWorkId,authority:givenAuthority}=options;
  const scope=namespaceScope(givenScope),workId=namespaceIdentifier(givenWorkId,'Story ID'),authority=Object.freeze(structuredClone(givenAuthority));
  const bound={records,content,localRecords,localContent,scope,workId,authority,access,clock,sources,modelEnabled,notice};
  const runtime=createNamespacePreparationRuntime(bound);
  return createEngine({ports:{invocation:{run:readSession.run},...createNamespaceReadPorts(bound),...runtime.ports,publication:createNamespacePublicationPort(bound,runtime)}});
}
