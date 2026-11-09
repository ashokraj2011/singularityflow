/** Archive an accepted application baseline through explicit SGOS/SDA capabilities. */
import {createHash} from 'node:crypto';
import {createEngine} from '../engine-sdk/index.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {sourceBaselineInventory} from '../engine-compatibility/node-source-policy.mjs';
import {sourceBaselineRetentionAccess} from '../kernel/source-changes.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {namespaceScope,namespaceIdentifier,namespaceJson} from '../sda/namespace/values.mjs';
import {createNamespaceSourceObservations} from './namespace-source-observations.mjs';
import {createNamespaceSourceContent} from './namespace-source-content.mjs';
import {createNamespaceSourceBaselineReader,emptySourceBaselineTotals} from './namespace-source-baseline-reader.mjs';
import {sourceBaselineRecord,NAMESPACE_SOURCE_BASELINE_PROFILE} from './namespace-source-baseline-contract.mjs';
const hash=data=>createHash('sha256').update(data).digest('hex');
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const error=(message,code='ENGINE_INPUT_INVALID',details=null)=>new SingularityFlowError(message,{code,details});
function cancelled(signal){if(signal?.aborted)throw error('Baseline retention was cancelled; source files and prepared evidence are preserved.','ENGINE_OPERATION_CANCELLED');}
export function createNamespaceSourceBaselinePort(options={}){
  const {records,access,clock}=options,scope=namespaceScope(options.scope),workId=namespaceIdentifier(options.workId);
  if(typeof access?.current!=='function'||typeof clock?.now!=='function')throw error('Baseline archival needs explicit access and clock ports.');
  const reader=createNamespaceSourceBaselineReader({...options,scope,workId}),{observer,codec}=reader;
  const observations=createNamespaceSourceObservations({observer,sources:options.sources,scope}),files=createNamespaceSourceContent({...options,scope,observer});
  const current=access.current.bind(access),now=clock.now.bind(clock),transact=records.transact.bind(records),contexts=new WeakMap(),prepared=new WeakMap(),collected=new WeakMap();
  function selected(context){const s=contexts.get(context);if(!s)throw error('Use the issued baseline-retention context.');return s;}
  async function authorize(expected,signal,authorize=true){cancelled(signal);const facts=namespaceJson(await current({projectId:scope.projectId,workId,operation:'source.baseline.retain',signal}));
    cancelled(signal);return sourceBaselineRetentionAccess(facts,scope.projectId,{expected,authorize});}
  function checked(plan,s){if(plan&&(!same(plan.input,s.input)||plan.parametersSha256!==s.parameters))throw error('This operation ID belongs to another baseline request.','ENGINE_OPERATION_ID_REUSED');return plan;}
  async function acknowledged(s,signal){const accepted=await reader.accepted(s.input,{signal});if(!accepted)return null;
    checked(accepted.plan,s);await authorize(accepted.plan.actor,signal,false);return {...accepted,replayed:true};}
  async function sourceFresh(s,signal){
    for(const source of s.plan.sources){const captured=await observations.capture(source.repository,signal),
      observed=sourceBaselineInventory(captured.snapshot,{definition:s.proof.definition,workflow:s.proof.workflow}),
      expected=await reader.inventory(source.repository,s.proof.workflow,s.proof.definition,signal);
      if(!same(observed,expected))throw error('The selected application files no longer match this baseline. Restore its original source selection; retained work was preserved.','ENGINE_SOURCE_CHANGED',{
        operation:'source.baseline.retain',sourceBindingId:s.input.sourceBindingId,repositoryId:source.repository.id,expected:source.repository.revision});
    }
  }
  async function fresh(s,signal){await authorize(s.plan.actor,signal);const captured=await observer.capture({signal});
    if(captured.snapshot.revision!==s.plan.basis.headVersion||captured.basis.authorityVersion!==s.plan.basis.authorityVersion
      ||captured.basis.configurationVersion!==s.plan.basis.configurationVersion)throw error('The Story or authority changed after baseline preparation. Preserve this intent and select a new operation.','ENGINE_CONTEXT_CHANGED',{
        operation:'source.baseline.retain',newOperationRequired:true});
    await sourceFresh(s,signal);
  }
  return {
    async load(input,{signal}={}){cancelled(signal);if(input.workId!==workId)throw error('Baseline retention belongs to another Story.','ACTIVE_SUBJECT_MISMATCH');
      const context=Object.freeze({subject:{kind:'story',id:workId}});contexts.set(context,{input,parameters:hash(canonicalJson({input,binding:codec.binding}))});return context;},
    async retained(context,_input,{signal}={}){return acknowledged(selected(context),signal);},
    async prepare(context,_input,{signal}={}){
      const s=selected(context),original=await reader.intent(s.input,{signal});
      if(original){s.plan=checked(original.plan,s);s.reference=original.reference;s.proof=original;
        for(const source of s.plan.sources)files.bound(source.repository,source.reader);await fresh(s,signal);
      }else{
        const actor=await authorize(null,signal),captured=await observer.capture({signal}),{workflow,selected:selection}=await reader.binding(s.input.sourceBindingId,signal);
        const definition=(await observer.approved({workflow,configuration:captured.snapshot.configuration},{signal})).compiled.definition;
        const sources=[];
        for(const repository of selection.repositories){const bound=files.readers.get(repository.id)??null;
          if(bound&&!same(bound.descriptor.source,repository.descriptor))throw error('The baseline reader has another selected repository.','ENGINE_SOURCE_CONTENT_READER_UNAVAILABLE',{repositoryId:repository.id});
          const inventory=await reader.inventory(repository,workflow,definition,signal);
          if(!bound&&inventory.entries.some(entry=>entry.bytes>0))throw error('Bind a content reader for this nonempty baseline.','ENGINE_SOURCE_CONTENT_READER_UNAVAILABLE',{repositoryId:repository.id});
          sources.push({repository,reader:bound?.descriptor??null});}
        s.plan=sourceBaselineRecord('plan',{profile:NAMESPACE_SOURCE_BASELINE_PROFILE,binding:codec.binding,input:s.input,parametersSha256:s.parameters,
          recordedAt:projectEnrollmentTimestamp(await now()),actor,basis:{authorityVersion:captured.basis.authorityVersion,headVersion:captured.basis.headVersion,
            configurationVersion:captured.basis.configurationVersion,configuration:captured.snapshot.configuration,head:captured.basis.head},sources});
        s.proof={plan:s.plan,workflow,definition};await fresh(s,signal);
        s.reference=await files.shared(Buffer.from(canonicalJson(s.plan)),'runtime',signal);s.proof.reference=s.reference;
        const tx=codec.transaction(s.plan,s.reference,{intent:true});
        try{codec.receipt(await transact(scope,tx,{signal}),tx);}
        catch(cause){if(!['SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code))throw cause;
          const concurrent=await reader.intent(s.input,{signal});
          if(!concurrent||!same(concurrent.plan,{...s.plan,recordedAt:concurrent.plan.recordedAt}))throw cause;
          s.plan=checked(concurrent.plan,s);s.reference=concurrent.reference;s.proof=concurrent;await fresh(s,signal);}
      }
      const token=Object.freeze({});prepared.set(token,context);return token;
    },
    async collect(context,token,{signal}={}){
      if(prepared.get(token)!==context)throw error('Use this baseline preparation.');const s=selected(context),repositories=[],totals=emptySourceBaselineTotals();
      for(const source of s.plan.sources){const inventory=await reader.inventory(source.repository,s.proof.workflow,s.proof.definition,signal),entries=[],budget={chunks:0};
        const bound=files.bound(source.repository,source.reader);
        for(const entry of inventory.entries){const {role,...member}=entry,retained=await files.retain(member,bound,{signal,budget,repositoryId:source.repository.id});
          entries.push({...member,role,chunks:retained.chunks});totals.files++;totals.bytes+=retained.bytes;totals.chunks+=retained.chunks.length;}
        const body=sourceBaselineRecord('repository',{profile:NAMESPACE_SOURCE_BASELINE_PROFILE,plan:s.reference,id:source.repository.id,
          baselineRevision:source.repository.revision,...inventory,entries});
        repositories.push({id:source.repository.id,manifest:await files.shared(Buffer.from(canonicalJson(body)),'evidence',signal)});}
      const body=sourceBaselineRecord('result',{profile:NAMESPACE_SOURCE_BASELINE_PROFILE,plan:s.reference,recordedAt:s.plan.recordedAt,repositories,totals});
      const reference=await files.shared(Buffer.from(canonicalJson(body)),'evidence',signal),issued=Object.freeze({});collected.set(issued,{context,reference});return issued;
    },
    async commit(context,token,{signal}={}){
      const completed=collected.get(token);if(!completed||completed.context!==context)throw error('Use this baseline collection.');const s=selected(context);
      for(let attempt=0;attempt<8;attempt++){
        const accepted=await acknowledged(s,signal);if(accepted)return accepted;await fresh(s,signal);
        const prior=await observer.record('evidence',codec.indexKey(s.input),false,signal,true);
        if(prior){const index=codec.index(prior.value,s.input),metadata=await observer.record('evidence',index.manifestKey,true,signal);
          const previous=await reader.accepted({...s.input,operationId:metadata.value.operationId},{signal});
          if(!previous||codec.keys(previous.plan.input).manifest!==index.manifestKey)throw error('The baseline index has no accepted result.','ENGINE_STORAGE_CORRUPT');}
        const tx=codec.transaction(s.plan,completed.reference,{previousIndexVersion:prior?.version??null});
        try{codec.receipt(await transact(scope,tx,{signal}),tx);return {...await reader.accepted(s.input,{signal}),replayed:false};}
        catch(cause){if(!['SDA_NAMESPACE_REVISION_CONFLICT','SDA_NAMESPACE_OPERATION_ID_REUSED'].includes(cause.code))throw cause;}
      }throw error('The baseline index changed beyond its bounded acceptance retry.','ENGINE_CONTEXT_CHANGED');
    },
    async finish(context,accepted){const s=selected(context);if(!accepted?.record||!same(accepted.plan.input,s.input))throw error('Use the actual accepted baseline receipt.','ENGINE_PORT_RESULT_INVALID');
      return {workId,operationId:s.input.operationId,sourceBindingId:s.input.sourceBindingId,record:accepted.record,recordedAt:accepted.body.recordedAt,
        principalId:accepted.plan.actor.principalId,replayed:accepted.replayed,repositories:accepted.body.repositories,totals:accepted.body.totals};}
  };
}
export function createNamespaceSourceBaselineEngine(options={}){return createEngine({ports:{sourceBaselineRetention:createNamespaceSourceBaselinePort(options)}});}
