/** Read a real private generation baseline and current SGOS sources. Never write or run checks. */
import {createHash} from 'node:crypto';
import {createEngine} from '../engine-sdk/index.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {sourceSnapshot,validateSourceUnit} from '../foundation/source-snapshot.mjs';
import {sourceSnapshotChanges} from '../kernel/source-changes.mjs';
import {phaseRequiresCodeDelivery} from '../kernel/phase-policy.mjs';
import {applicationPathContext,classifyDeliveryChanges,evaluateProtectedPaths,evaluateSourceBoundary,
  isTestAutomationPath,normalizeSourceBoundary} from '../engine-compatibility/node-source-policy.mjs';
import {namespaceScope,namespaceIdentifier} from '../sda/namespace/values.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespacePreparationRuntime} from './namespace-preparation.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(left,right)=>canonicalJson(left)===canonicalJson(right);
const error=(message,code,details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
function cancelled(signal){if(signal?.aborted)throw error('Source inspection was cancelled before its next read.','ENGINE_OPERATION_CANCELLED');}
const MAXIMUM_PREVIEW_BYTES=262_144;

export function createNamespaceSourceInspectionPort(options={},runtime=null) {
  const scope=namespaceScope(options.scope),workId=namespaceIdentifier(options.workId,'Story ID');
  const observer=createNamespaceStoryObserver({...options,scope,workId}),units=new Map(),unitIds=new Set(),contexts=new WeakMap();
  if(!Array.isArray(options.sources??[])||(options.sources??[]).length>32)throw error('Bind a bounded explicit source-unit list.','ENGINE_INPUT_INVALID');
  for(const source of options.sources??[]) {
    const descriptor=validateSourceUnit(source);
    if(descriptor.projectId!==scope.projectId||units.has(descriptor.repositoryId)||unitIds.has(descriptor.id)) {
      throw error('Source inspection units must be distinct and project bound.','ENGINE_INPUT_INVALID');
    }
    units.set(descriptor.repositoryId,{descriptor,capture:source.capture.bind(source)});unitIds.add(descriptor.id);
  }
  async function capture(repository,signal) {
    cancelled(signal);const unit=units.get(repository.id);
    if(!unit||!same(unit.descriptor,repository.descriptor))throw error('Bind the original repository source unit to inspect this generation.','ENGINE_SOURCE_UNIT_UNAVAILABLE',{
      repositoryId:repository.id,unitId:repository.unitId});
    const found=await unit.capture({signal});cancelled(signal);sourceSnapshot(found?.snapshot,unit.descriptor);
    const revision='sha256:'+hash(canonicalJson(found.snapshot));
    if(found.revision!==revision)throw error('The source unit returned another snapshot digest.','ENGINE_PORT_RESULT_INVALID',{repositoryId:repository.id});
    return {snapshot:found.snapshot,revision};
  }
  async function baseline(repository,signal) {
    const data=await observer.bytes(repository.snapshot,repository.snapshot.bytes,signal);
    let value;
    try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));sourceSnapshot(value,repository.descriptor);}
    catch(cause){if(['SGOS_SOURCE_UNSUPPORTED','ENGINE_STORAGE_UNSUPPORTED'].includes(cause.code))throw cause;
      throw error('The retained generation baseline is not its bound source snapshot.','ENGINE_STORAGE_CORRUPT',{repositoryId:repository.id},cause);}
    if(repository.revision!=='sha256:'+hash(canonicalJson(value)))throw error('The retained source baseline has another digest.','ENGINE_STORAGE_CORRUPT',{repositoryId:repository.id});
    return value;
  }
  return {
    async load(input,{signal}={}) {
      if(input.workId!==undefined&&input.workId!==workId)throw error('Source inspection is bound to another Story.','ACTIVE_SUBJECT_MISMATCH');
      cancelled(signal);
      if(!runtime)throw error('Inspecting an authored generation requires its machine-local working store.','ENGINE_PORT_UNAVAILABLE',{
        operation:'phase.source.inspect',required:['machine-local-working-store']});
      const token=await runtime.captureSourceDraft(input.phaseId,{signal}),facts=runtime.sourceDraftFacts(token);
      const context=Object.freeze({subject:{kind:'story',id:workId},phase:facts.phase});contexts.set(context,{token,facts});return context;
    },
    async inspect(context,input,{signal}={}) {
      const s=contexts.get(context);if(!s)throw error('Use the issued source-inspection context.','ENGINE_INPUT_INVALID');
      cancelled(signal);const {facts,token}=s,w=facts.workflow,p=facts.draft?.payload,phase=w.phases[facts.phase];
      const draft=p?{generation:p.generation,revision:facts.draft.revision,bodySha256:facts.draft.bodySha256,baseRevision:p.baseRevision}:null;
      const result={workId,phase:facts.phase,status:'missing-draft',revision:facts.revision,authorityVersion:facts.authorityVersion,
        configuration:facts.configuration,draft,sourceBinding:null,repositories:[],
        totals:{added:0,modified:0,removed:0,changes:0,shown:0,truncated:false},recovery:null};
      if(!p)result.recovery={operation:'phase.prepare',inputs:{workId,phaseId:facts.phase}};
      else if(p.baseRevision!==facts.revision){result.status='stale-draft';result.recovery={operation:'phase.draft.rebase',inputs:{workId,phaseId:facts.phase,
        expectedRevision:facts.draft.revision,confirm:facts.draft.bodySha256},requires:['operationId','reason']};}
      else if(!phaseRequiresCodeDelivery(phase)){result.status='not-code-generation';}
      else {
        if(p.authorityVersion!==facts.authorityVersion||!same(p.configuration,facts.configuration)) {
          throw error('The private generation uses another configuration or authority binding.','ENGINE_STORAGE_CORRUPT');
        }
        const selected=w.sourceBindings?.current,repositories=selected?.repositories;
        if(!p.generationIntent||!p.sources.length||!Array.isArray(repositories)||!repositories.length||!same(p.sources,repositories)) {
          throw error('The private generation has no matching accepted source selection.','ENGINE_STORAGE_CORRUPT');
        }
        const proof=await observer.accepted(selected.operationId,{signal});
        if(!same(proof.state.workflow.sourceBindings?.current,selected))throw error('The source selection differs from its accepted lifecycle binding.','ENGINE_STORAGE_CORRUPT');
        const captured=await observer.capture({signal});
        if(captured.snapshot.revision!==facts.revision||captured.basis.authorityVersion!==facts.authorityVersion)throw error('The Story changed before source inspection.','ENGINE_CONTEXT_CHANGED');
        const approval=await observer.approved(captured.snapshot,{signal}),definition=approval.compiled.definition;
        const guards=[...new Set([...(definition.governance?.protectedPaths??[]),...(w.resolution.governance?.protectedPaths??[]),
          ...(w.resolution.capability?.policy?.protectedPaths??[])])];
        const boundary=normalizeSourceBoundary(phase.sourceBoundary,phase.id);
        // Source-unit v1 has no filesystem case-sensitivity or Git tracking observation. Keep
        // canonical path classification explicit, and conservatively report guarded case variants.
        const pathContext=applicationPathContext(definition,w.resolution);
        const observed=[],reports=[];let previewBytes=0;
        for(const repository of repositories){
          const retained=await baseline(repository,signal),current=await capture(repository,signal);observed.push({repository,current});
          const changes=sourceSnapshotChanges(retained,current.snapshot,repository.descriptor);
          const classification=classifyDeliveryChanges(changes,{pathContext});
          const roles=new Map(classification.entries.map(entry=>[entry.changeId,entry.role]));
          const protectedSet=new Set(evaluateProtectedPaths(changes,guards,{caseInsensitive:true}).violations.map(entry=>entry.changeId));
          const outside=new Set(evaluateSourceBoundary(changes,boundary,{allowedPath:isTestAutomationPath,phaseId:phase.id}).violations.map(entry=>entry.changeId));
          const report={id:repository.id,unitId:repository.unitId,baselineRevision:repository.revision,observedRevision:current.revision,
            changesSha256:hash(canonicalJson(changes)),policy:{sourceBoundary:boundary,classificationComparison:pathContext.caseInsensitivePaths?'pinned-case-insensitive':'case-sensitive-portable',
              protectedComparison:'portable-case-insensitive',tracking:'not-observed',renameDetection:'not-observed'},
            totals:changes.totals,roles:{},protectedChanges:protectedSet.size,boundaryViolations:outside.size,entries:[]};
          for(const entry of changes.entries){
            const role=roles.get(entry.changeId)??'engine-owned';report.roles[role]=(report.roles[role]??0)+1;
            const row={...entry,role,protected:protectedSet.has(entry.changeId),sourceBoundaryAllowed:!outside.has(entry.changeId)};
            const bytes=Buffer.byteLength(canonicalJson(row));
            if(result.totals.shown<input.maximumEntries&&previewBytes+bytes<=MAXIMUM_PREVIEW_BYTES){report.entries.push(row);previewBytes+=bytes;result.totals.shown++;}
          }
          reports.push(report);
          for(const key of ['added','modified','removed','changes'])result.totals[key]+=changes.totals[key];
        }
        // Re-observe every selected repository after the entire read, including ones without changes.
        for(const {repository,current}of observed){
          const final=await capture(repository,signal);
          if(final.revision!==current.revision)throw error('Source bytes changed during inspection; the draft is preserved.','ENGINE_SOURCE_CHANGED',{repositoryId:repository.id});
        }
        result.status='inspected';result.repositories=reports;result.sourceBinding={operationId:selected.operationId,generationIntent:p.generationIntent.id};
        result.totals.truncated=result.totals.shown<result.totals.changes;
      }
      await runtime.revalidateSourceDraft(token,{signal});cancelled(signal);return result;
    }
  };
}

export function createNamespaceSourceInspectionEngine(options={}) {
  const runtime=options.localRecords&&options.localContent?createNamespacePreparationRuntime(options):null;
  return createEngine({ports:{phaseSourceInspection:createNamespaceSourceInspectionPort(options,runtime)}});
}
