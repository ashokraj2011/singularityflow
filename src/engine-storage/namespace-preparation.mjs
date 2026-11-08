/** Namespace phase preparation and private authoring over explicit ports. No checkout discovery. */
import { createHash } from 'node:crypto';
import { createEngine } from '../engine-sdk/index.mjs';
import { SingularityFlowError } from '../foundation/failures.mjs';
import { canonicalJson,NAMESPACE_PREPARATION_SCHEMAS,admitRecordSchemaVersion } from '../foundation/record-schema.mjs';
import { renderArtifactTemplateText,utf8Bytes } from '../kernel/artifact-content.mjs';
import { phaseDraftAccess,phasePreparationSelection } from '../kernel/phase-preparation.mjs';
import { phaseAgentMutationFacts,skillPhaseHostRequirement } from '../kernel/phase-admission.mjs';
import { phaseBeginSelection,phaseExplicitlyReopened,pendingIntentAmendmentAcknowledgement,phaseRequiresCodeDelivery } from '../kernel/phase-policy.mjs';
import { approvedInputPhases,resolvedPhaseInputs,workflowInputsMode } from '../kernel/phase-inputs.mjs';
import { sequenceAdmission } from '../kernel/lifecycle-transitions.mjs';
import { projectEnrollmentTimestamp } from '../kernel/project-enrollment.mjs';
import { storyActorValue } from '../kernel/story-creation.mjs';
import { sourceSnapshot,sourceUnitDescriptor,sourceRelativePath,validateSourceUnit } from '../foundation/source-snapshot.mjs';
import { namespaceScope,namespaceJson,namespaceIdentityJson,namespaceIdentifier,namespaceRevision,namespaceKey,exactObject } from '../sda/namespace/values.mjs';
import { contentReference,CONTENT_STORE_METHODS } from '../sda/content/contract.mjs';
import { NAMESPACE_STORE_METHODS } from '../sda/namespace/contract.mjs';
import { createNamespaceDraftStore } from './namespace-draft-store.mjs';
import { createNamespaceLifecycleObserver } from './namespace-lifecycle-reader.mjs';
import { createNamespaceConfigurationObserver } from './namespace-configuration-reader.mjs';
import { createNamespaceReadPorts } from './namespace-reader.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const error=(message,code,details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
function cancelled(signal){if(signal?.aborted)throw error('Private preparation was cancelled before its next effect.','ENGINE_OPERATION_CANCELLED');}
function utf8(data,label) {try {const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data);if(text.includes('\0'))throw Error('NUL');return text;}
  catch(cause){throw error(`${label} must be UTF-8 text without NUL bytes.`,'ENGINE_ARTIFACT_ENCODING_INVALID',null,cause);}}
function privateSchema(kind,value) {
  try {admitRecordSchemaVersion(NAMESPACE_PREPARATION_SCHEMAS[kind],value);}
  catch(cause){throw error(cause.message,['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT',cause.details,cause);}
}

export function createNamespacePreparationEngine({records,content,localRecords,localContent,scope,workId,authority,access,clock,
  sources=[],modelEnabled=true}={}) {
  scope=namespaceScope(scope);authority=Object.freeze(structuredClone(authority));
  const observer=createNamespaceLifecycleObserver({records,content,scope,workId,authority});
  const configured=createNamespaceConfigurationObserver({records,content,scope,authority});
  if(typeof access?.current!=='function'||typeof clock?.now!=='function'||typeof modelEnabled!=='boolean'||!Array.isArray(sources)||sources.length>32) {
    throw error('Preparation needs explicit access, clock, source and model-mode ports.','ENGINE_INPUT_INVALID');
  }
  const current=access.current.bind(access),now=clock.now.bind(clock),units=new Map(),unitIds=new Set();
  for(const source of sources) {const descriptor=validateSourceUnit(source);
    if(descriptor.projectId!==scope.projectId||units.has(descriptor.repositoryId)||unitIds.has(descriptor.id))throw error('Preparation source units must be distinct and project bound.','ENGINE_INPUT_INVALID');
    units.set(descriptor.repositoryId,{descriptor,capture:source.capture.bind(source)});unitIds.add(descriptor.id);}
  // Validate the separate private bindings at construction, including for an as-yet empty Story.
  createNamespaceDraftStore({records:localRecords,content:localContent,scope,workId,phaseId:'binding-check'});
  const privateRecords=Object.freeze({descriptor:structuredClone(localRecords.descriptor),
    ...Object.fromEntries(NAMESPACE_STORE_METHODS.map(name=>[name,localRecords[name].bind(localRecords)]))});
  const privateContent=Object.freeze({descriptor:structuredClone(localContent.descriptor),
    ...Object.fromEntries(CONTENT_STORE_METHODS.map(name=>[name,localContent[name].bind(localContent)]))});
  const contexts=new WeakMap(),preparations=new WeakMap(),outcomes=new WeakMap();
  const store=phaseId=>createNamespaceDraftStore({records:privateRecords,content:privateContent,scope,workId,phaseId});
  const selected=context=>{const value=contexts.get(context);if(!value)throw error('Use the issued preparation context.','ENGINE_INPUT_INVALID');return value;};
  async function authorize(operation,signal,expected=null) {
    cancelled(signal);const facts=namespaceJson(await current({projectId:scope.projectId,workId,operation,signal}));cancelled(signal);
    return phaseDraftAccess(facts,scope.projectId,operation,{expected});
  }
  async function canonical(phaseId,signal) {
    const captured=await observer.capture({signal}),workflow=captured.snapshot.workflow,id=phaseId??workflow.currentPhase;
    if(!id||!Object.hasOwn(workflow.phases,id))throw error('The requested phase is unavailable in this Story.','ENGINE_PHASE_UNAVAILABLE',{phaseId:id});
    return {...captured,phase:workflow.phases[id],store:store(id)};
  }
  async function unchanged(captured,signal) {
    const fresh=await observer.capture({signal});
    if(fresh.snapshot.revision!==captured.snapshot.revision||fresh.basis.authorityVersion!==captured.basis.authorityVersion) {
      throw error('The Story or authority changed during private preparation. The local draft is preserved.','ENGINE_CONTEXT_CHANGED',{
        workId,phase:captured.phase.id,expected:captured.snapshot.revision,observed:fresh.snapshot.revision});
    }
  }
  function payload(value,phaseId) {
    try {
      exactObject(value,['format','generation','baseRevision','authorityVersion','configuration','actor','agentId','createdAt',
        'template','artifact','inputContext','sources','generationIntent','previousDraft','updatedAt','updatedBy','reason']);
      if(value.format!=='sflow-namespace-prepared-phase/v1'||!Number.isSafeInteger(value.generation)||value.generation<1
        ||!Array.isArray(value.sources)
        ||value.sources.length>32||!value.artifact||typeof value.artifact.key!=='string'||!value.template||typeof value.template.key!=='string')throw Error('Invalid fields.');
      storyActorValue(value.actor);storyActorValue(value.updatedBy);projectEnrollmentTimestamp(value.createdAt);projectEnrollmentTimestamp(value.updatedAt);
      if(namespaceRevision(value.baseRevision)===null||namespaceRevision(value.authorityVersion)===null)throw Error('Missing captured revisions.');
      if(value.agentId!==null)namespaceIdentifier(value.agentId,'Author agent');
      exactObject(value.configuration,['key','content']);namespaceKey(value.configuration.key);
      exactObject(value.template,['key','reference']);exactObject(value.artifact,['key','initial','current']);sourceRelativePath(value.artifact.key);
      if(typeof value.reason!=='string'||!value.reason.trim()||value.reason.length>4096||/[\u0000\u007f]/u.test(value.reason))throw Error('Invalid draft reason.');
      for(const ref of [value.artifact.initial,value.artifact.current,value.inputContext,...(value.previousDraft?[value.previousDraft]:[])]) {
        if(contentReference(ref).namespace!=='local')throw Error('Private draft bytes are not local.');
      }
      if(contentReference(value.template.reference).namespace!=='config'||contentReference(value.configuration.content).namespace!=='config')throw Error('Missing approved resources.');
      const repositories=new Set();
      for(const source of value.sources) {
        exactObject(source,['id','unitId','provider','revision','descriptor','snapshot']);const descriptor=sourceUnitDescriptor(source.descriptor);
        if(descriptor.projectId!==scope.projectId||descriptor.repositoryId!==source.id||descriptor.id!==source.unitId||descriptor.provider!==source.provider
          ||repositories.has(source.id)||!/^sha256:[a-f0-9]{64}$/u.test(source.revision)||contentReference(source.snapshot).namespace!=='evidence')throw Error('Invalid source binding.');
        repositories.add(source.id);
      }
      if(value.generationIntent!==null) {
        exactObject(value.generationIntent,['id','generation','record']);
        if(value.generationIntent.generation!==value.generation||contentReference(value.generationIntent.record).namespace!=='local'
          ||value.generationIntent.id!=='generation-'+value.generationIntent.record.sha256||!value.sources.length)throw Error('Invalid generation intent.');
      }else if(value.sources.length)throw Error('Source bindings need their captured generation intent.');
    }catch(cause){throw error('The retained private phase draft is invalid.','ENGINE_STORAGE_CORRUPT',{workId,phase:phaseId},cause);}
    return value;
  }
  async function inspectPrivate(captured,signal) {
    const found=await captured.store.capture({signal});if(!found)return null;
    const p=payload(found.payload,captured.phase.id);
    await captured.store.bytes(p.artifact.initial,{signal});await captured.store.bytes(p.artifact.current,{signal});
    const contextBytes=await captured.store.bytes(p.inputContext,{signal});
    const intentBytes=p.generationIntent?await captured.store.bytes(p.generationIntent.record,{signal}):null;
    try {
      const context=JSON.parse(utf8(contextBytes,'Private input context'));
      privateSchema('context',context);
      exactObject(context,['schemaVersion','format','workId','phase','generation','configuration','resources']);
      if(context.format!=='sflow-namespace-preparation-context/v1'||context.workId!==workId||context.phase!==captured.phase.id
        ||context.generation!==p.generation||!same(context.configuration,p.configuration.content)||!Array.isArray(context.resources))throw Error('Another input context.');
      for(const resource of context.resources)contentReference(resource.reference);
      if(intentBytes) {
        const intent=JSON.parse(utf8(intentBytes,'Private generation intent'));
        privateSchema('generation',intent);
        exactObject(intent,['schemaVersion','format','workId','phase','generation','baseRevision','configuration','actor','agentId','createdAt','sources','inputContext']);
        if(intent.format!=='sflow-namespace-source-generation/v1'||intent.workId!==workId||intent.phase!==captured.phase.id
          ||['generation','baseRevision','configuration','actor','agentId','createdAt','sources','inputContext'].some(key=>!same(intent[key],p[key])))throw Error('Another generation intent.');
      }
    }catch(cause){if(cause.code==='ENGINE_STORAGE_UNSUPPORTED')throw cause;
      throw error('The retained private input context or generation intent has another binding.','ENGINE_STORAGE_CORRUPT',{workId,phase:captured.phase.id},cause);}
    return {...found,payload:p};
  }
  async function contract(captured,agent,signal) {
    const w=captured.snapshot.workflow,phase=captured.phase,sequence=sequenceAdmission(w,{requestedPhase:phase.id});
    if(!sequence.allowed)throw error('Preparation requires the current in-progress phase.','PHASE_DRAFT_NOT_ACTIVE',{sequence});
    if(pendingIntentAmendmentAcknowledgement(w))throw error('Acknowledge the approved intent amendment before preparing another draft.','INTENT_AMENDMENT_ACKNOWLEDGEMENT_REQUIRED');
    if(phase.generationIntent?.status==='consumed'&&!phaseExplicitlyReopened(w,phase))throw error('The published code generation needs an explicitly reviewed successor.','GENERATION_INTENT_ALREADY_CONSUMED');
    const approval=await configured.approved(w.resolution.configurationApprovalId,{signal});
    if(!same(approval.configuration,captured.snapshot.configuration))throw error('Preparation has another immutable configuration pin.','ENGINE_STORAGE_CORRUPT');
    const catalog=approval.compiled.definition.agentCatalog??[];
    const config={agents:Object.fromEntries(catalog.map(item=>[item.id,item]))};
    const role=phaseAgentMutationFacts(config,w,phase,{agent:agent.agentId},'prepare');
    if(!role.allowed)throw error('The selected agent is read-only for this phase.',role.code,role);
    if(agent.agentId!==null&&!catalog.some(item=>item.id===agent.agentId))throw error('The selected agent is not in the pinned catalog.','ENGINE_AGENT_UNAVAILABLE');
    if(phase.defaultAgent&&agent.agentId!==phase.defaultAgent)throw error('Select the pinned phase author before preparing its draft.','AGENT_SESSION_REQUIRED',{agentId:phase.defaultAgent});
    const skillHost=skillPhaseHostRequirement(w,phase);
    if(skillHost)throw error('The qualified skill containment and delivery host is not installed for this phase.','SKP_HOST_ENFORCEMENT_UNAVAILABLE',skillHost);
    if(phaseRequiresCodeDelivery(phase)&&w.resolution.testRecovery?.enabled)throw error('The code phase needs its retained test-recovery agreement and verified readiness on this backend.',
      w.resolution.testRecoveryAgreement?'TRP_READINESS_EVIDENCE_REQUIRED':'TRP_AGREEMENT_REQUIRED');
    if((w.referenceRepositories??[]).length)throw error('The declared reference repositories need actual source bindings before preparation.','REFERENCE_REPOSITORIES_NOT_READY');
    if((w.pendingPublications??[]).length)throw error('Reconcile the pending publication before preparing a private draft.','PENDING_PUBLICATION_REQUIRED');
    const configuredPhase=approval.compiled.workflows[w.workItem.workType]?.phases.find(item=>item.id===phase.id);
    if(!configuredPhase)throw error('The phase is absent from its approved workflow.','ENGINE_STORAGE_CORRUPT');
    return {approval,phase:configuredPhase};
  }
  async function resources(captured,approved,agent,signal) {
    const w=captured.snapshot.workflow,phase=captured.phase,result=[],inputs=[];
    const source=w.workItem.source?.content;
    if(!source)throw error('The Story has no retained source.','ENGINE_STORAGE_CONTENT_MISSING');
    utf8(await observer.bytes(source,source.bytes,signal),'Story source');result.push({kind:'story-source',id:'story-source',reference:source});
    for(const document of w.namespaceDocuments??[]) {
      if(document.role!=='file'||document.id==='story-source'||document.status==='detached'
        ||document.phase!==null&&document.phase!==undefined&&document.phase!==phase.id)continue;
      if(document.locality==='machine-local') {
        try {await captured.store.bytes(document.content,{signal});}
        catch(cause){if(cause.code!=='ENGINE_STORAGE_CONTENT_MISSING')throw cause;
          throw error('This phase needs the matching original document on this device.','DOCUMENT_REUPLOAD_REQUIRED',{
            workId,phase:phase.id,documentId:document.id,name:document.name,expected:document.content},cause);}
      }else await observer.bytes(document.content,document.content.bytes,signal);
      result.push({kind:'supporting-document',id:document.id,locality:document.locality,reference:document.content});
    }
    for(const id of approvedInputPhases(w,phase)) {
      const producer=w.phases[id],declarations=resolvedPhaseInputs(w,phase),optional=!declarations.some(item=>(typeof item==='string'?item:item.phase)===id&&(typeof item==='string'||item.required!==false));
      if(!producer||producer.status!=='approved') {
        if(optional||workflowInputsMode(w)!=='enforce')continue;
        throw error('An upstream input has no accepted generation.','PHASE_INPUTS_NOT_READY',{upstreamPhase:id});
      }
      const document=(w.namespaceDocuments??[]).find(item=>item.phase===id&&item.generation===producer.generation&&item.role==='artifact');
      const retained=(producer.artifacts??[]).find(item=>item.path===document?.sourceKey);
      if(!document?.content||!retained||retained.sha256!==document.content.sha256)throw error('The approved input has no matching retained content binding.','PHASE_INPUTS_NOT_READY',{upstreamPhase:id});
      await observer.bytes(document.content,document.content.bytes,signal);
      result.push({kind:'approved-input',phase:id,generation:producer.generation,reference:document.content,
        contract:declarations.filter(item=>(typeof item==='string'?item:item.phase)===id)});
      inputs.push(`- ${id}, generation ${producer.generation}: sha256:${document.content.sha256}`);
    }
    const seen=new Set();
    const add=async(kind,id,reference)=>{const key=kind+':'+id;if(seen.has(key))return;seen.add(key);
      await observer.bytes(reference,reference.bytes,signal);result.push({kind,id,reference});};
    const instruction=async id=>{const found=approved.instructions.find(item=>item.id===id);if(!found)throw error('A pinned instruction dependency is missing.','WFA_DEPENDENCY_UNAVAILABLE',{id});await add('instruction',id,found.body);};
    const skill=async id=>{const key='skill:'+id;if(seen.has(key))return;const found=approved.skills.find(item=>item.id===id);
      if(!found)throw error('A pinned skill dependency is missing.','WFA_DEPENDENCY_UNAVAILABLE',{id});await add('skill',id,found.body);
      for(const child of found.skills)await skill(child);for(const child of found.instructions)await instruction(child);};
    if(agent.agentId!==null) {
      const found=approved.agents.find(item=>item.id===agent.agentId);if(!found)throw error('The pinned author resource is missing.','WFA_DEPENDENCY_UNAVAILABLE');
      await add('agent',found.id,found.body);
      const activeSkills=found.skillBindings?found.skillBindings.filter(item=>!item.phases.length||item.phases.includes(phase.id)).map(item=>item.id):found.skills;
      for(const id of activeSkills)await skill(id);for(const id of found.instructions)await instruction(id);
    }
    const constitution=w.resolution.constitution;
    if(constitution?.mode!=='off'&&constitution?.path) {
      const found=approved.files.find(item=>item.path===constitution.path);
      if(!found&&constitution.mode==='enforce')throw error('The pinned constitution is unavailable.','WFA_DEPENDENCY_UNAVAILABLE',{path:constitution.path});
      if(found)await add('constitution',constitution.path,found.body);
    }
    return {records:result,rendered:inputs.join('\n\n')};
  }
  async function sourceBindings(captured,signal) {
    const w=captured.snapshot.workflow,repositories=w.sourceBindings?.current?.repositories;
    if(!Array.isArray(repositories)||!repositories.length)throw error('Bind actual repository sources before opening code generation.','ENGINE_SOURCE_UNIT_UNAVAILABLE');
    for(const repository of repositories) {
      const unit=units.get(repository.id);if(!unit)throw error('Configure the bound source unit before opening code generation.','ENGINE_SOURCE_UNIT_UNAVAILABLE',{repositoryId:repository.id});
      if(!same(unit.descriptor,repository.descriptor))throw error('The source unit differs from its accepted binding. Rebind the actual checkout before generation.','ENGINE_SOURCE_UNIT_UNAVAILABLE',{repositoryId:repository.id});
      const retained=JSON.parse(utf8(await observer.bytes(repository.snapshot,repository.snapshot.bytes,signal),'Source snapshot'));
      sourceSnapshot(retained,repository.descriptor);
      if(repository.revision!=='sha256:'+hash(canonicalJson(retained)))throw error('The retained source revision has another digest.','ENGINE_STORAGE_CORRUPT');
      const observed=await unit.capture({signal});sourceSnapshot(observed.snapshot,unit.descriptor);
      const revision='sha256:'+hash(canonicalJson(observed.snapshot));
      if(observed.revision!==revision)throw error('The source unit returned another digest.','ENGINE_PORT_RESULT_INVALID');
      if(!same(retained.entries,observed.snapshot.entries)||!same(retained.selection,observed.snapshot.selection))throw error('Source bytes changed after their accepted binding.','ENGINE_SOURCE_CHANGED',{repositoryId:repository.id});
    }
    return structuredClone(repositories);
  }
  async function makePayload(captured,binding,agent,previous,signal) {
    if(binding.mode==='deterministic-convergence')throw error('Convergence preparation requires its retained deterministic projection.','CONVERGENCE_PROJECTION_REQUIRED');
    if(binding.producer==='deterministic'&&!binding.authoringRequired)throw error('This phase needs its actual deterministic producer before preparation can complete.','PHASE_DETERMINISTIC_PRODUCER_REQUIRED');
    const {approval,phase}=await contract(captured,agent,signal),compiled=approval.compiled,w=captured.snapshot.workflow;
    const key=String(phase.template).startsWith('agent:')?phase.template:`${compiled.definition.templatesRoot}/${phase.template}`;
    const template=compiled.templates.find(item=>item.path===key);if(!template)throw error('The approved artifact template is missing.','WFA_DEPENDENCY_UNAVAILABLE',{key});
    const templateText=utf8(await observer.bytes(template.body,template.body.bytes,signal),'Artifact template');
    const inputs=await resources(captured,compiled,agent,signal),at=projectEnrollmentTimestamp(await now());
    const contextData=Buffer.from(canonicalJson({schemaVersion:1,format:'sflow-namespace-preparation-context/v1',workId,phase:phase.id,
      generation:binding.generation,configuration:captured.snapshot.configuration.content,resources:inputs.records}));
    const inputContext=await captured.store.put(contextData,{signal});
    const initial=previous?.payload.artifact.initial??await captured.store.put(Buffer.from(renderArtifactTemplateText(templateText,phase,{
      id:workId,title:w.workItem.title,workType:w.workItem.workType,inputs:inputs.rendered})),{signal});
    const artifact={key:binding.artifactKey,initial,current:previous?.payload.artifact.current??initial};
    if(typeof artifact.key!=='string'||!artifact.key)throw error('This phase needs its configured artifact contract.','ENGINE_ARTIFACT_CONTRACT_REQUIRED');
    const sources=binding.codeDeliveryRequired?await sourceBindings(captured,signal):[];
    let generationIntent=null;
    if(binding.codeDeliveryRequired) {
      const intent={schemaVersion:1,format:'sflow-namespace-source-generation/v1',workId,phase:phase.id,generation:binding.generation,
        baseRevision:captured.snapshot.revision,configuration:captured.snapshot.configuration,actor:agent.actor,agentId:agent.agentId,createdAt:at,sources,inputContext};
      const record=await captured.store.put(Buffer.from(canonicalJson(intent)),{signal});
      generationIntent={id:'generation-'+record.sha256,generation:binding.generation,record};
    }
    return {format:'sflow-namespace-prepared-phase/v1',generation:binding.generation,baseRevision:captured.snapshot.revision,
      authorityVersion:captured.basis.authorityVersion,configuration:captured.snapshot.configuration,actor:agent.actor,agentId:agent.agentId,createdAt:at,
      template:{key,reference:template.body},artifact,inputContext,sources,generationIntent,previousDraft:previous?.body??null,
      updatedAt:at,updatedBy:agent.actor,reason:previous?'Rebind the preserved authored draft.':'Prepare the phase artifact.'};
  }
  const phasePreparation={
    async load(inputs,{signal}={}) {
      if(inputs.workId!==undefined&&inputs.workId!==workId)throw error('Preparation is bound to another Story.','ACTIVE_SUBJECT_MISMATCH');
      const captured=await canonical(inputs.phaseId,signal),found=await inspectPrivate(captured,signal);
      const context={workflow:structuredClone(captured.snapshot.workflow),modelEnabled};
      contexts.set(context,{captured,found});return context;
    },
    async prepare(context,binding,{signal}={}) {
      const saved=selected(context),{captured,found}=saved,agent=await authorize('phase.prepare',signal);
      await contract(captured,agent,signal);
      if(found) {
        if(found.payload.baseRevision!==captured.snapshot.revision||found.payload.generation!==binding.generation)throw error('The existing private draft uses an earlier Story revision. Review it and explicitly rebind it.','ENGINE_DRAFT_BASIS_CHANGED',{
          workId,phase:binding.phase,revision:found.revision,confirm:found.body.sha256,operation:'phase.draft.rebase'});
        saved.accepted=found;saved.opened=false;await unchanged(captured,signal);return;
      }
      const value=await makePayload(captured,binding,agent,null,signal);
      if(value.sources.length)await sourceBindings(captured,signal);
      await authorize('phase.prepare',signal,agent);await unchanged(captured,signal);
      const parametersSha256=hash(canonicalJson({binding,base:captured.snapshot.revision,configuration:captured.snapshot.configuration}));
      saved.accepted=await captured.store.save({operationId:'prepare-'+parametersSha256,parametersSha256,expectedRevision:null,payload:value},{signal});
      saved.opened=binding.codeDeliveryRequired&&!saved.accepted.replayed;
    },
    async inspect(context,binding,{signal}={}) {
      const saved=selected(context),value=payload(saved.accepted.payload,binding.phase);await unchanged(saved.captured,signal);
      await saved.captured.store.bytes(value.artifact.current,{signal});
      return {workId,phase:binding.phase,generation:value.generation,producer:binding.producer,artifactKey:value.artifact.key,
        inputContext:{generation:value.generation,sha256:value.inputContext.sha256,renderedSha256:null},
        generationIntent:value.generationIntent?{id:value.generationIntent.id,generation:value.generation,sha256:value.generationIntent.record.sha256}:null,
        convergence:null,generationOpened:saved.opened};
    }
  };
  const phaseDraftRead={async load(inputs,{signal}={}) {
    if(inputs.workId!==undefined&&inputs.workId!==workId)throw error('Draft reading is bound to another Story.','ACTIVE_SUBJECT_MISMATCH');
    await authorize('phase.draft.read',signal);const captured=await canonical(inputs.phaseId,signal),context={subject:{kind:'story',id:workId},phase:captured.phase.id};
    contexts.set(context,{captured});return context;
  },async read(context,inputs,{signal}={}) {
    const {captured}=selected(context),found=await inspectPrivate(captured,signal);
    if(!found){await unchanged(captured,signal);return {workId,phase:context.phase,status:'missing'};}
    const p=found.payload,data=await captured.store.bytes(p.artifact.current,{signal});let preview;
    const maximumBytes=Math.min(inputs.maximumBytes,captured.snapshot.workflow.resolution.documents?.maxPreviewBytes??65_536);
    try {
      const full=utf8(data,'Authored artifact');let text='',bytes=0;
      for(const character of full){const n=utf8Bytes(character);if(bytes+n>maximumBytes)break;text+=character;bytes+=n;}
      preview={kind:'text',text,bytes,truncated:bytes<p.artifact.current.bytes};
    }catch(cause){if(cause.code!=='ENGINE_ARTIFACT_ENCODING_INVALID')throw cause;preview={kind:'binary',bytes:data.byteLength};}
    await unchanged(captured,signal);
    return {workId,phase:context.phase,status:p.baseRevision===captured.snapshot.revision?'open':'stale',
      draft:{generation:p.generation,revision:found.revision,bodySha256:found.body.sha256,baseRevision:p.baseRevision,currentRevision:captured.snapshot.revision,
        createdAt:p.createdAt,actor:p.actor,agentId:p.agentId},artifact:{key:p.artifact.key,reference:p.artifact.current,content:preview}};
  }};
  function mutationPort(kind) {
    const permission=kind==='write'?'phase.draft.write':'phase.draft.rebase';
    function contextValue(context){const found=selected(context);if(found.permission!==permission)throw error('Use this operation\'s issued draft context.','ENGINE_INPUT_INVALID');return found;}
    function outcome(context,result){const token=Object.freeze({});outcomes.set(token,{context,result});return token;}
    return {
      async load(input,{signal}={}) {cancelled(signal);if(input.workId!==workId)throw error('The draft belongs to another Story.','ACTIVE_SUBJECT_MISMATCH');
        const context=Object.freeze({}),parametersSha256=hash(namespaceIdentityJson({permission,input,scope,workId,authority}));
        contexts.set(context,{input,permission,parametersSha256,store:store(input.phaseId)});return context;},
      async retained(context,_input,{signal}={}) {const s=contextValue(context),accepted=await s.store.inspect(s.input.operationId,s.parametersSha256,{signal});
        return accepted?outcome(context,accepted):null;},
      async prepare(context,_input,{signal}={}) {
        const s=contextValue(context),captured=await canonical(s.input.phaseId,signal),found=await inspectPrivate(captured,signal);
        if(!found)throw error('Prepare this phase before saving an authored draft.','ENGINE_DRAFT_MISSING',{operation:'phase.prepare'});
        if(found.revision!==s.input.expectedRevision)throw error('The private draft changed; read and review its current bytes.','ENGINE_CONTEXT_CHANGED',{expected:s.input.expectedRevision,observed:found.revision});
        const agent=await authorize(permission,signal);await contract(captured,agent,signal);
        const binding=phaseBeginSelection(captured.snapshot.workflow,{workId,phaseId:captured.phase.id});
        let value;
        if(kind==='rebase') {
          if(s.input.confirm!==found.body.sha256)throw error('Draft rebind confirmation does not match the reviewed draft.','ENGINE_CONFIRMATION_REQUIRED',{confirm:found.body.sha256});
          // Use the normal preparation producer/mode resolver through the pinned effective phase.
          value=await makePayload(captured,phasePreparationSelection(captured.snapshot.workflow,{phaseId:captured.phase.id},modelEnabled),agent,found,signal);
          value.reason=s.input.reason;
        }else{
          if(found.payload.baseRevision!==captured.snapshot.revision||found.payload.generation!==binding.generation)throw error('Rebind the preserved draft before writing against another Story revision.','ENGINE_DRAFT_BASIS_CHANGED',{operation:'phase.draft.rebase',revision:found.revision,confirm:found.body.sha256});
          await s.store.bytes(s.input.content,{signal});
          const at=projectEnrollmentTimestamp(await now());value={...found.payload,artifact:{...found.payload.artifact,current:s.input.content},previousDraft:found.body,
            updatedAt:at,updatedBy:agent.actor,reason:s.input.reason};
        }
        const token=Object.freeze({});preparations.set(token,{context,captured,found,value,agent});return token;
      },
      async commit(context,token,{signal}={}) {
        const s=contextValue(context),p=preparations.get(token);if(!p||p.context!==context)throw error('Use this private draft operation\'s preparation.','ENGINE_INPUT_INVALID');
        const accepted=await s.store.inspect(s.input.operationId,s.parametersSha256,{signal});if(accepted)return outcome(context,accepted);
        if(kind==='rebase'&&p.value.sources.length)await sourceBindings(p.captured,signal);
        await authorize(permission,signal,p.agent);await unchanged(p.captured,signal);
        const result=await s.store.save({operationId:s.input.operationId,parametersSha256:s.parametersSha256,expectedRevision:p.found.revision,payload:p.value},{signal});
        return outcome(context,result);
      },
      async finish(context,token) {const s=contextValue(context),accepted=outcomes.get(token);if(!accepted||accepted.context!==context)throw error('The private draft has no accepted result.','ENGINE_PORT_RESULT_INVALID');
        const r=accepted.result,p=payload(r.payload,s.input.phaseId);
        return {workId,phase:s.input.phaseId,operationId:s.input.operationId,generation:p.generation,revision:r.revision,bodySha256:r.body.sha256,
          artifact:p.artifact.current,recordedAt:p.updatedAt,principalId:p.updatedBy.principalId,replayed:r.replayed===true};}
    };
  }
  return createEngine({ports:{...createNamespaceReadPorts({records,content,localContent,scope,workId}),phasePreparation,phaseDraftRead,
    phaseDraftWrite:mutationPort('write'),phaseDraftRebase:mutationPort('rebase')}});
}
