/** Exact declaration/run joins over accepted namespace records. No execution, writes or host discovery. */
import {createEngine} from '../engine-sdk/index.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {phaseRequiresCodeDelivery} from '../kernel/phase-policy.mjs';
import {plannedClaimAllocatedTo,specificationCriteria,tagKey} from '../kernel/specification-policy.mjs';
import {primaryDocumentPublicationRequirements} from '../kernel/publication-intent.mjs';
import {witnessResult,aggregateWitnesses} from '../kernel/verification-witnesses.mjs';
import {ASSURANCE} from '../kernel/verification-policy.mjs';
import {discoverAcceptanceWitnessesReplay,commandForTestFileReplay,sourceBaselineInventory,applicationPathContext} from '../engine-compatibility/node-source-policy.mjs';
import {persistedOccurrences} from '../verification/test-report-reader.mjs';
import {effectiveContract} from '../engine-compatibility/node-specification-policy.mjs';
import {repositoryPlanTestLocation} from '../engine-compatibility/node-repository-plan.mjs';
import {scanJavaScriptDeclarations,scanSourceClauseTags} from '../engine-compatibility/node-source-analysis.mjs';
import {namespaceScope,namespaceIdentifier} from '../sda/namespace/values.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespacePreparationRuntime} from './namespace-preparation.mjs';
import {createNamespaceSpecificationReader} from './namespace-specifications.mjs';
import {createNamespaceSourceObservations} from './namespace-source-observations.mjs';
import {createNamespaceSourceBaselineReader} from './namespace-source-baseline-reader.mjs';
import {createNamespaceSourceRetentionReader} from './namespace-source-retention-reader.mjs';
import {createNamespaceSourceControlReader} from './namespace-source-control-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {verifySourceFileChunks} from './namespace-source-content-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),compact=value=>value?{operationId:value.operationId??value.plan.input.operationId,record:value.record,index:value.binding?.index??{key:value.indexKey,version:value.indexVersion}}:null;
const error=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>new SingularityFlowError(message,{code,details});
const cancelled=signal=>{if(signal?.aborted)throw error('Test witness inspection was cancelled.','ENGINE_OPERATION_CANCELLED');};
export function createNamespaceTestWitnessInspectionPort(options={},runtime=null){
  const scope=namespaceScope(options.scope),workId=namespaceIdentifier(options.workId),observer=createNamespaceStoryObserver({...options,scope,workId}),contexts=new WeakMap(),
    changes=createNamespaceSourceRetentionReader({...options,scope,workId}),baseline=createNamespaceSourceBaselineReader({...options,scope,workId}),
    checks=createNamespacePhaseCheckReader({...options,scope,workId,observer}),specifications=createNamespaceSpecificationReader({observer,scope,workId,checks}),
    controlReader=createNamespaceSourceControlReader({...options,scope,workId}),sources=createNamespaceSourceObservations({observer,scope,sources:options.sources});
  async function indexFresh(binding,signal){if(!binding)return;const value=await observer.record('evidence',binding.index.key,false,signal);
    if(value.version!==binding.index.version)throw error('Witness evidence changed during inspection.','ENGINE_CONTEXT_CHANGED');}
  return {
    async load(input,{signal}={}){
      if(input.workId!==undefined&&input.workId!==workId)throw error('Witness inspection is bound to another Story.','ACTIVE_SUBJECT_MISMATCH');cancelled(signal);
      if(!runtime)throw error('Inspect candidate witnesses using the machine-local authored generation.','ENGINE_PORT_UNAVAILABLE',{required:['machine-local-working-store'],operation:'phase.test-witnesses.inspect'});
      const token=await runtime.captureSourceDraft(input.phaseId,{signal}),facts=runtime.sourceDraftFacts(token),context=Object.freeze({subject:{kind:'story',id:workId},phase:facts.phase});
      contexts.set(context,{token,facts});return context;
    },
    async inspect(context,input,{signal}={}){
      const saved=contexts.get(context);if(!saved)throw error('Use the issued witness inspection.','ENGINE_INPUT_INVALID');cancelled(signal);
      const f=saved.facts,p=f.draft?.payload,w=f.workflow,phase=w.phases[f.phase],result={workId,phase:f.phase,revision:f.revision,authorityVersion:f.authorityVersion,
        configuration:f.configuration,draft:p?{generation:p.generation,revision:f.draft.revision,bodySha256:f.draft.bodySha256,baseRevision:p.baseRevision}:null,
        status:'missing-draft',plan:null,source:null,checks:null,control:null,repositories:[],totals:{paths:0,witnesses:0,met:0,missing:0,failed:0,inconclusive:0,pending:0},paths:[],truncated:false,requiredPolicyOwners:[]};
      if(p&&p.baseRevision!==f.revision)result.status='stale-draft';
      else if(p&&!phaseRequiresCodeDelivery(phase))result.status='not-code-generation';
      else if(p){
        const captured=await observer.capture({signal});if(captured.snapshot.revision!==f.revision||captured.basis.authorityVersion!==f.authorityVersion)throw error('The Story changed before witness inspection.','ENGINE_CONTEXT_CHANGED');
        const definition=(await observer.approved(captured.snapshot,{signal})).compiled.definition;
        result.requiredPolicyOwners=[...primaryDocumentPublicationRequirements(w,phase,{definition})];
        if(w.resolution?.plannedClaims?.mode!=='required'){result.status='pending-owner';result.requiredPolicyOwners.push('approved-planned-witnesses');}
        else{
          const plan=await specifications.sourcePlan(captured.snapshot,f.phase,{signal});result.plan=plan.proof;
          const identity={phaseId:f.phase,generation:p.generation,baseRevision:f.revision,draft:{workId,phase:f.phase,revision:f.draft.revision,bodySha256:f.draft.bodySha256},artifact:p.artifact.current,configuration:f.configuration},
            original=await baseline.inspectBinding(w.sourceBindings.current.operationId,{signal}),retained=await changes.inspectDraft(identity,{signal}),tested=await checks.inspectDraft(identity,{signal}),control=await controlReader.inspectDraft(identity,{signal});
          result.source=compact(retained);result.checks=tested?{operationId:tested.binding.operationId,record:tested.binding.result,index:tested.binding.index}:null;result.control=control?{operationId:control.plan.input.operationId,record:control.record,index:control.binding.index}:null;
          if(!retained)result.status='missing-source-evidence';
          else if(retained.plan.sources.length!==1&&!plan.repositoryPlan){result.status='pending-owner';result.requiredPolicyOwners.push('repository-qualified-claims');}
          else{
            result.status='observed';const {repositories}=await sources.generation(w,p,signal),observed=[],rows=[],owners=new Set();
            const contracts=new Map((plan.planned.verificationContracts??[]).map(value=>[value.clauseId,value])),criteria=plan.active.indexes.flatMap(index=>index.clauses)
              .filter(clause=>(clause.type==='AC'||/:AC-\d{3}$/u.test(clause.id))&&plannedClaimAllocatedTo(plan.planned.claims[clause.id],f.phase)),seen=new Set();
            for(const repository of repositories){
              const source=retained.plan.sources.find(row=>row.repository.id===repository.id),position=retained.plan.sources.indexOf(source);
              if(!source)throw error('The accepted source archive lost a selected repository.');
              const {value}=await changes.verifyRepository(retained,source,retained.body.repositories[position].manifest,signal),snapshot=await changes.snapshot(source.observed.content,source.repository.descriptor,source.observed.revision,signal),
                members=new Map(snapshot.entries.map(entry=>[entry.path,entry])),edited=new Map(value.entries.filter(entry=>entry.after).map(entry=>[entry.newPath,entry])),buffers=new Map();
              let originalMembers=null,originalSource=null,totalBytes=0;
              const current=await sources.capture(repository,signal);observed.push({repository,current});
              const inventory=value=>sourceBaselineInventory(value,{definition,workflow:w}),sourceMatched=same(inventory(snapshot),inventory(current.snapshot)),
                checkedSource=tested?.found.plan.sources.find(row=>row.id===repository.id),checkedSnapshot=checkedSource?await checks.snapshot(checkedSource.content,checkedSource.descriptor,signal):null,
                checksMatched=checkedSnapshot?same(inventory(checkedSnapshot),inventory(current.snapshot)):null,
                archiveChecksMatched=checkedSnapshot?same(inventory(checkedSnapshot),inventory(snapshot)):false;
              result.repositories.push({id:repository.id,sourceMatched,checksMatched});
              async function bytes(file){
                if(buffers.has(file))return buffers.get(file);const member=members.get(file);if(!member)return null;
                let entry=edited.get(file)?.after,chunks=edited.get(file)?.chunks,maximumChunkBytes=source.reader?.maximumChunkBytes;
                if(!entry){if(!original){owners.add('source-baseline-bytes');return null;}
                  if(!originalMembers){const index=original.plan.sources.findIndex(row=>row.repository.id===repository.id);originalSource=original.plan.sources[index];
                    if(!originalSource||!same(originalSource.repository,source.repository))throw error('The original witness archive names another source binding.');
                    const verified=await baseline.verifyRepository(original,originalSource,original.body.repositories[index].manifest,signal);originalMembers=new Map(verified.body.entries.map(row=>[row.path,row]));}
                  entry=originalMembers.get(file);if(!entry||!same({sha256:entry.sha256,bytes:entry.bytes,executable:entry.executable},{sha256:member.sha256,bytes:member.bytes,executable:member.executable}))throw error('The unchanged witness has no matching original bytes.');
                  chunks=entry.chunks;maximumChunkBytes=originalSource.reader?.maximumChunkBytes;
                }
                if(entry.bytes>1048576){owners.add('bounded-test-declarations');return null;}
                const parts=[];await verifySourceFileChunks(entry,chunks,{maximumChunkBytes,signal,read:async(...args)=>{cancelled(signal);const data=await observer.bytes(...args);parts.push(data);return data;}});
                const data=Buffer.concat(parts);while(totalBytes+data.length>16777216&&buffers.size){const [key,old]=buffers.entries().next().value;buffers.delete(key);totalBytes-=old.length;}
                buffers.set(file,data);totalBytes+=data.length;return data;
              }
              const planned=[];
              for(const clause of criteria){const claim=plan.planned.claims[clause.id],contract=effectiveContract(clause.id,contracts,claim);
                for(const slot of contract?.slots??[])if(slot.method==='test')for(const global of slot.witness.path?[slot.witness.path]:slot.witness.paths??[]){
                  const local=plan.repositoryPlan?repositoryPlanTestLocation(plan.repositoryPlan,global,{workflow:w,definition}):{repositoryId:repository.id,path:global};
                  if(local?.repositoryId===repository.id)planned.push({clauseId:clause.id,slot,local:local.path});}}
              const testPaths=[...new Set(planned.map(row=>row.local))],bindings=[],tags=[];
              for(const file of testPaths){const data=await bytes(file);if(!data)continue;let text;
                try{text=new TextDecoder('utf-8',{fatal:true}).decode(data);}catch{owners.add('test-source-encoding');continue;}
                for(const tag of scanSourceClauseTags(text,{sourcePath:file}).filter(tag=>tag.tag==='ac')){tags.push({...tag,testSource:file});bindings.push({clauseId:tag.clauseId,testSource:file,bindingAssurance:'namespace-qualified'});}}
              const sharedNamespaces=specificationCriteria(plan.active,w,definition)?.sharedNamespaces??new Set();
              const sharedTags=tags.filter(tag=>sharedNamespaces.has(tag.clauseId.split(':')[0])),added=new Set();
              if(sharedTags.length){const origin=control?.plan.origins?.find(row=>row.id===repository.id);
                if(!origin)owners.add('source-tag-origin');else{
                  const i=control.plan.observations.findIndex(row=>row.id===repository.id),row=control.plan.observations[i],verified=await controlReader.readObservation({...row,content:control.body.repositories[i].observation},control.source,signal,origin),
                    facts=await controlReader.origins.replayFacts(origin,control.source,verified.value,repository.id,signal);
                  for(const key of await facts.added(sharedTags.map(tag=>({path:tag.testSource,line:tag.line})),applicationPathContext(definition,w.resolution),'ac'))added.add(key);
                }}
              const othersTag=({testSource,clauseId,line})=>{if(!sharedNamespaces.has(clauseId.split(':')[0]))return false;
                const last=Math.max(0,...tags.filter(tag=>tag.testSource===testSource&&tag.clauseId===clauseId&&tag.line<=line).map(tag=>tag.line));return !added.has(tagKey(testSource,last));};
              const replay=discoverAcceptanceWitnessesReplay(phase,{testPaths,requiredAcIds:[...new Set(planned.filter(row=>row.slot.role==='primary').map(row=>row.clauseId))],bindings,othersTag});let step=replay.next();
              while(!step.done){cancelled(signal);let reply;const request=step.value;
                if(request.kind==='witness-test-commands')reply=phase.qualityCommands??[];
                else if(request.kind==='witness-command-for-file'){const choice=commandForTestFileReplay(request.commands,request.file);let next=choice.next();
                  while(!next.done)next=choice.next((await bytes(next.value.file))?.toString('utf8')??'');reply=next.value;}
                else if(request.kind==='witness-declarations'){
                  reply={declarations:[],unattachedTags:[],fileGaps:{}};const framework={'node-test-v1':'node:test','jest-static-v2':'jest','vitest-static-v2':'vitest','playwright-json-v1':'playwright'}[request.profile];
                  if(!framework){owners.add('test-declaration-adapter');for(const file of request.files)reply.fileGaps[file]=[{code:'TEST_DECLARATION_OWNER_REQUIRED',message:'The pinned language profile needs its declaration owner.'}];}
                  else for(const file of request.files){const data=await bytes(file);if(!data){reply.fileGaps[file]=[{code:'TEST_SOURCE_UNAVAILABLE',message:'Exact retained test bytes are unavailable.'}];continue;}
                    const result=scanJavaScriptDeclarations(data.toString('utf8'),{sourcePath:file,framework});reply.declarations.push(...result.declarations);reply.unattachedTags.push(...result.unattachedTags.map(tag=>({sourcePath:file,...tag})));if(result.fileGaps.length)reply.fileGaps[file]=result.fileGaps;}
                }else throw error('The witness rule needs its named observation owner.','ENGINE_PORT_UNAVAILABLE',{required:[request.kind]});step=replay.next(reply);
              }
              for(const plannedPath of planned){const {clauseId,slot,local:testSource}=plannedPath,key=[repository.id,clauseId,slot.slot,testSource].join('\0');if(seen.has(key))continue;seen.add(key);
                const matching=step.value.witnesses.filter(witness=>witness.clauseId===clauseId&&witness.testSource===testSource),results=[];
                for(const witness of matching){const index=archiveChecksMatched?tested?.found.plan.steps.findIndex(row=>row.repositoryId===repository.id&&row.command.id===witness.commandId):-1,run=index>=0?tested.found.body.results[index]:null,
                    out=run?.candidate?.output,check=index>=0?tested.found.body.checks[index]:null,attempt=check?{attemptId:tested.binding.operationId+':'+witness.commandId,status:check.status,
                      exitCode:out?.process.status??null,terminal:out?.process.closed===true,timedOut:out?.process.timedOut===true,adapter:out?.reports.adapter,tests:check.tests,occurrences:persistedOccurrences(out?.reports.parsed)}:null;
                  const result=witnessResult(witness,attempt,{submitted:true,enforceAssertionAdequacy:w.resolution.codeDelivery?.assertionAdequacy==='enforce'});
                  results.push({logicalTestId:witness.logicalTestId,declarationSha256:witness.declarationSha256,line:witness.line,outcome:result.outcome,status:result.status,
                    assurance:result.assurance,identity:result.identity,execution:result.execution,requiredAssurance:result.requiredAssurance,attemptId:result.attemptId,reasons:result.reasons});}
                const aggregate=aggregateWitnesses(results),requiredAssurance=slot.requiredAssurance??(step.value.profiles.find(row=>row.testSource===testSource)?.ceiling??'module-observed'),
                  status=aggregate.status==='met'&&ASSURANCE.indexOf(aggregate.assurance)<ASSURANCE.indexOf(requiredAssurance)?'inconclusive':aggregate.status;
                rows.push({repositoryId:repository.id,clauseId,slot:slot.slot,role:slot.role,testSource,profile:step.value.profiles.find(row=>row.testSource===testSource)?.profile??'module-counts-v1',
                  status,assurance:aggregate.assurance,requiredAssurance,witnessCount:results.length,witnesses:results.slice(0,64),truncated:results.length>64,
                  gaps:[...new Set([...step.value.errorFindings.filter(row=>row.value===clauseId).map(row=>row.code),...(tested&&!archiveChecksMatched?['CHECK_SOURCE_BINDING_MISMATCH']:[]),
                    ...(sharedTags.some(tag=>tag.clauseId===clauseId)&&!control?.plan.origins?.some(row=>row.id===repository.id)?['SOURCE_TAG_ORIGIN_REQUIRED']:[])])]});
              }
            }
            let bytes=0;for(const row of rows){result.totals.paths++;result.totals.witnesses+=row.witnessCount;result.totals[row.status]++;
              const size=Buffer.byteLength(canonicalJson(row));if(result.paths.length<input.maximumEntries&&bytes+size<=65536){result.paths.push(row);bytes+=size;}else result.truncated=true;result.truncated||=row.truncated;}
            result.requiredPolicyOwners.push(...owners);if(owners.size)result.status='pending-owner';await sources.fresh(observed,signal);
          }
          for(const binding of [result.source,result.checks,result.control])await indexFresh(binding,signal);
          for(const row of control?.plan.origins??[])for(const proof of [row.origin,row.baseline])await indexFresh(proof,signal);
        }
      }
      result.requiredPolicyOwners=[...new Set(result.requiredPolicyOwners)].sort();await runtime.revalidateSourceDraft(saved.token,{signal});cancelled(signal);return result;
    }
  };
}
export function createNamespaceTestWitnessInspectionEngine(options={}){const runtime=options.localRecords&&options.localContent?createNamespacePreparationRuntime(options):null;
  return createEngine({ports:{phaseTestWitnessInspection:createNamespaceTestWitnessInspectionPort(options,runtime)}});}
