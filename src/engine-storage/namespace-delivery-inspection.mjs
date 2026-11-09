/** Read accepted original/current source and test evidence without publishing or executing anything. */
import {createEngine} from '../engine-sdk/index.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {sourceSnapshotChanges} from '../kernel/source-changes.mjs';
import {phaseRequiresCodeDelivery} from '../kernel/phase-policy.mjs';
import {primaryDocumentPublicationRequirements} from '../kernel/publication-intent.mjs';
import {inspectSourceChanges,sourceBaselineInventory,deliveryPathCohorts,isExecutableTestSourceCandidate,uncoveredTestDeliveryPaths,testCoverageDeliveryPaths} from '../engine-compatibility/node-source-policy.mjs';
import {namespaceScope,namespaceIdentifier} from '../sda/namespace/values.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespacePreparationRuntime} from './namespace-preparation.mjs';
import {createNamespaceSourceObservations} from './namespace-source-observations.mjs';
import {createNamespaceSourceBaselineReader} from './namespace-source-baseline-reader.mjs';
import {createNamespaceSourceRetentionReader} from './namespace-source-retention-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const error=(message,code='ENGINE_INPUT_INVALID',details=null)=>new SingularityFlowError(message,{code,details});
function cancelled(signal){if(signal?.aborted)throw error('Delivery inspection was cancelled before its next read.','ENGINE_OPERATION_CANCELLED');}
const compact=(operationId,record,index)=>({operationId,record,index});
export function createNamespaceDeliveryInspectionPort(options={},runtime=null){
  const scope=namespaceScope(options.scope),workId=namespaceIdentifier(options.workId),observer=createNamespaceStoryObserver({...options,scope,workId});
  const sources=createNamespaceSourceObservations({observer,scope,sources:options.sources}),contexts=new WeakMap();
  const baseline=createNamespaceSourceBaselineReader({...options,scope,workId}),changed=createNamespaceSourceRetentionReader({...options,scope,workId}),checks=createNamespacePhaseCheckReader({...options,scope,workId,observer});
  async function indexFresh(binding,signal){if(!binding)return;const value=await observer.record('evidence',binding.index.key,false,signal);
    if(value.version!==binding.index.version)throw error('Retained delivery evidence changed during inspection.','ENGINE_CONTEXT_CHANGED',{operation:'phase.delivery.inspect',workId});}
  return {
    async load(input,{signal}={}){
      if(input.workId!==undefined&&input.workId!==workId)throw error('Delivery inspection is bound to another Story.','ACTIVE_SUBJECT_MISMATCH');cancelled(signal);
      if(!runtime)throw error('Inspecting a candidate requires its machine-local authored generation.','ENGINE_PORT_UNAVAILABLE',{operation:'phase.delivery.inspect',required:['machine-local-working-store']});
      const token=await runtime.captureSourceDraft(input.phaseId,{signal}),facts=runtime.sourceDraftFacts(token),context=Object.freeze({subject:{kind:'story',id:workId},phase:facts.phase});
      contexts.set(context,{token,facts});return context;
    },
    async inspect(context,input,{signal}={}){
      const s=contexts.get(context);if(!s)throw error('Use the issued delivery-inspection context.');cancelled(signal);
      const f=s.facts,w=f.workflow,p=f.draft?.payload,phase=w.phases[f.phase],draft=p?{generation:p.generation,revision:f.draft.revision,bodySha256:f.draft.bodySha256,baseRevision:p.baseRevision}:null;
      const result={workId,phase:f.phase,status:'missing-draft',revision:f.revision,authorityVersion:f.authorityVersion,configuration:f.configuration,draft,
        sourceBinding:null,evidence:{baseline:null,changes:null,checks:null},repositories:[],tests:{status:'not-configured',checks:[]},requiredPolicyOwners:[]};
      if(p&&p.baseRevision!==f.revision)result.status='stale-draft';
      else if(p&&!phaseRequiresCodeDelivery(phase))result.status='not-code-generation';
      else if(p){
        const captured=await observer.capture({signal});if(captured.snapshot.revision!==f.revision||captured.basis.authorityVersion!==f.authorityVersion)throw error('The Story changed before delivery inspection.','ENGINE_CONTEXT_CHANGED');
        const definition=(await observer.approved(captured.snapshot,{signal})).compiled.definition,{selected,repositories}=await sources.generation(w,p,signal);
        result.sourceBinding={operationId:selected.operationId};result.requiredPolicyOwners=[...primaryDocumentPublicationRequirements(w,phase,{definition})];
        const identity={phaseId:f.phase,generation:p.generation,baseRevision:f.revision,draft:{workId,phase:f.phase,revision:f.draft.revision,bodySha256:f.draft.bodySha256},artifact:p.artifact.current,configuration:f.configuration};
        const original=await baseline.inspectBinding(selected.operationId,{signal}),retained=await changed.inspectDraft(identity,{signal}),tested=await checks.inspectDraft(identity,{signal});
        if(original)result.evidence.baseline=compact(original.plan.input.operationId,original.record,{key:original.indexKey,version:original.indexVersion});
        if(retained)result.evidence.changes=compact(retained.plan.input.operationId,retained.record,retained.binding.index);
        if(tested){result.evidence.checks=compact(tested.binding.operationId,tested.binding.result,tested.binding.index);
          result.tests={status:tested.found.body.verdict,checks:tested.found.body.checks.map(row=>({id:row.id,repositoryId:row.repositoryId,status:row.status,
            tests:row.tests?Object.fromEntries(Object.entries(row.tests).filter(([key])=>['discovered','passed','failed','skipped','errors'].includes(key))):null}))};
        }else if(phase.qualityCommands?.length)result.tests.status='missing';
        const observed=[];let displayed=0,previewBytes=0;
        for(const repository of repositories){const before=await sources.baseline(repository,signal),current=await sources.capture(repository,signal);observed.push({repository,current});
          const classified=inspectSourceChanges(sourceSnapshotChanges(before,current.snapshot,repository.descriptor),{definition,workflow:w,phase,applicationOnly:true});
          const native=classified.entries.map(entry=>({status:entry.status==='D'?'deleted':entry.status==='A'?'added':'modified',oldPath:entry.oldPath,newPath:entry.newPath,
            newContent:entry.after?{kind:'regular-file'}:null,newMode:entry.after?(entry.after.executable?'100755':'100644'):'000000'}));
          const cohort=deliveryPathCohorts(native),steps=(tested?.found.plan.steps??[]).map((step,index)=>({step,check:tested.found.body.checks[index]})).filter(row=>row.step.repositoryId===repository.id),
            commands=steps.filter(row=>row.check.status==='passed'&&row.step.command.kind==='test').map(row=>row.step.command),sourceExtensions=[...new Set((phase.qualityCommands??[]).flatMap(command=>command.result?.sourceExtensions??[]))],
            testPaths=cohort.changedTestCandidates.filter(candidate=>isExecutableTestSourceCandidate(candidate,{sourceExtensions})),
            delivery={sourcePaths:cohort.changedSourcePaths,configurationPaths:cohort.configurationPaths,testPaths},affected=testCoverageDeliveryPaths(delivery,phase.sourceBoundary),
            uncovered=uncoveredTestDeliveryPaths(delivery,phase.sourceBoundary,commands),order=[...new Set([...uncovered,...affected,...testPaths])],rows=[];
          for(const candidate of order){const row={path:candidate,role:cohort.configurationPaths.includes(candidate)?'configuration':testPaths.includes(candidate)?'test':'source',covered:affected.includes(candidate)?!uncovered.includes(candidate):null},bytes=new TextEncoder().encode(canonicalJson(row)).byteLength;
            if(displayed<input.maximumEntries&&previewBytes+bytes<=262144){rows.push(row);displayed++;previewBytes+=bytes;}}
          const selectedSource=retained?.plan.sources.find(source=>source.repository.id===repository.id),selectedCheck=tested?.found.plan.sources.find(source=>source.id===repository.id),
            value=sourceBaselineInventory(current.snapshot,{definition,workflow:w});let sourceMatched=null,checksMatched=null;
          if(selectedSource){const snapshot=await changed.snapshot(selectedSource.observed.content,selectedSource.repository.descriptor,selectedSource.observed.revision,signal);sourceMatched=same(value,sourceBaselineInventory(snapshot,{definition,workflow:w}));}
          if(selectedCheck){const snapshot=await checks.snapshot(selectedCheck.content,selectedCheck.descriptor,signal);checksMatched=same(value,sourceBaselineInventory(snapshot,{definition,workflow:w}));}
          result.repositories.push({id:repository.id,baselineRevision:repository.revision,currentRevision:current.revision,retainedRevision:selectedSource?.observed.revision??null,sourceMatched,checksMatched,
            safety:{protectedChanges:classified.protectedChanges,boundaryViolations:classified.boundaryViolations},
            coverage:{required:w.resolution.codeDelivery?.tests?.requireAffectedModuleCoverage!==false,affectedPaths:affected.length,uncoveredPaths:uncovered.length,changedExecutableTests:testPaths.length,pathCount:order.length,paths:rows,truncated:rows.length<order.length}});
        }
        await sources.fresh(observed,signal);for(const binding of Object.values(result.evidence))await indexFresh(binding,signal);result.status='observed';
      }
      await runtime.revalidateSourceDraft(s.token,{signal});cancelled(signal);return result;
    }
  };
}
export function createNamespaceDeliveryInspectionEngine(options={}){const runtime=options.localRecords&&options.localContent?createNamespacePreparationRuntime(options):null;
  return createEngine({ports:{phaseDeliveryInspection:createNamespaceDeliveryInspectionPort(options,runtime)}});}
