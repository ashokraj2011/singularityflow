/** Read a real private generation baseline and current SGOS sources. Never write or run checks. */
import {createHash} from 'node:crypto';
import {createEngine} from '../engine-sdk/index.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {sourceSnapshotChanges} from '../kernel/source-changes.mjs';
import {phaseRequiresCodeDelivery} from '../kernel/phase-policy.mjs';
import {inspectSourceChanges} from '../engine-compatibility/node-source-policy.mjs';
import {namespaceScope,namespaceIdentifier} from '../sda/namespace/values.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespacePreparationRuntime} from './namespace-preparation.mjs';
import {createNamespaceSourceObservations} from './namespace-source-observations.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(left,right)=>canonicalJson(left)===canonicalJson(right);
const error=(message,code,details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
function cancelled(signal){if(signal?.aborted)throw error('Source inspection was cancelled before its next read.','ENGINE_OPERATION_CANCELLED');}
const MAXIMUM_PREVIEW_BYTES=262_144;

export function createNamespaceSourceInspectionPort(options={},runtime=null) {
  const scope=namespaceScope(options.scope),workId=namespaceIdentifier(options.workId,'Story ID');
  const observer=createNamespaceStoryObserver({...options,scope,workId}),contexts=new WeakMap();
  const observations=createNamespaceSourceObservations({observer,sources:options.sources,scope});
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
        const {selected,repositories}=await observations.generation(w,p,signal);
        const captured=await observer.capture({signal});
        if(captured.snapshot.revision!==facts.revision||captured.basis.authorityVersion!==facts.authorityVersion)throw error('The Story changed before source inspection.','ENGINE_CONTEXT_CHANGED');
        const approval=await observer.approved(captured.snapshot,{signal}),definition=approval.compiled.definition;
        const observed=[],reports=[];let previewBytes=0;
        for(const repository of repositories){
          const retained=await observations.baseline(repository,signal),current=await observations.capture(repository,signal);observed.push({repository,current});
          const changes=sourceSnapshotChanges(retained,current.snapshot,repository.descriptor);
          const classification=inspectSourceChanges(changes,{definition,workflow:w,phase});
          const report={id:repository.id,unitId:repository.unitId,baselineRevision:repository.revision,observedRevision:current.revision,
            changesSha256:hash(canonicalJson(changes)),policy:classification.policy,
            totals:changes.totals,roles:classification.roles,protectedChanges:classification.protectedChanges,boundaryViolations:classification.boundaryViolations,entries:[]};
          for(const row of classification.entries){
            const bytes=Buffer.byteLength(canonicalJson(row));
            if(result.totals.shown<input.maximumEntries&&previewBytes+bytes<=MAXIMUM_PREVIEW_BYTES){report.entries.push(row);previewBytes+=bytes;result.totals.shown++;}
          }
          reports.push(report);
          for(const key of ['added','modified','removed','changes'])result.totals[key]+=changes.totals[key];
        }
        // Re-observe every selected repository after the entire read, including ones without changes.
        await observations.fresh(observed,signal);
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
