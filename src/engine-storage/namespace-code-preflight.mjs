/** Serve shared Code policy from actual accepted namespace inputs. No execution or lifecycle writes. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {plannedClaimAllocatedTo,acceptanceTagBindings} from '../kernel/specification-policy.mjs';
import {SPECIFICATION_CLAIM_TIMESTAMP_REQUEST} from '../kernel/specification-values.mjs';
import {namespaceCodeDeliveryPreflightReplay,codeDeliveryCandidateScope,isExecutableTestSourceCandidate,isConfigurationPath,isAllowedTestAutomationPath,
  isDocumentationPath,applicationPathContext,discoverAcceptanceWitnessesReplay,commandForTestFileReplay} from '../engine-compatibility/node-source-policy.mjs';
import {candidateSpecificationCoverageReplay,requiredAcceptanceFromPlan,mergedVerificationContracts} from '../engine-compatibility/node-specification-policy.mjs';
import {implementationBindingsReplay,scanSourceClauseTags,scanJavaScriptDeclarations} from '../engine-compatibility/node-source-analysis.mjs';
import {repositoryPlanProjection,repositoryPlanAmendmentProjection,repositoryPlanTestLocation} from '../engine-compatibility/node-repository-plan.mjs';
import {createNamespaceCodeSourceReader} from './namespace-code-source.mjs';
import {namespaceCodePreflightVersion} from '../foundation/record-schema.mjs';
import {createNamespaceInitialCodeHistoryReader} from './namespace-code-initial-history.mjs';
import {createNamespaceCodePredecessorReader} from './namespace-code-predecessors.mjs';
import {createNamespaceCodeHistoryReader} from './namespace-code-history.mjs';
import {createNamespaceStoryObserver} from './namespace-story-reader.mjs';
import {createNamespaceSpecificationReader} from './namespace-specifications.mjs';
import {createNamespaceSourceRetentionReader} from './namespace-source-retention-reader.mjs';
import {createNamespaceSourceBaselineReader} from './namespace-source-baseline-reader.mjs';
import {createNamespaceSourceClauseReader} from './namespace-source-clauses.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {createNamespaceSourceControlReader} from './namespace-source-control-reader.mjs';
import {createNamespaceTestCommandOwners} from './namespace-test-command-reader.mjs';
import {createNamespaceOutputRetentionReader} from './namespace-output-retention-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),hash=data=>createHash('sha256').update(data).digest('hex');
const failure=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>new SingularityFlowError(message,{code,details});
const required=owner=>{throw failure('Code publication requires its named evidence owner.','ENGINE_PORT_UNAVAILABLE',{required:[owner]});};
async function replay(generator,read){let step=generator.next();while(!step.done){let value;try{value=await read(step.value);}catch(error){step=generator.throw(error);continue;}step=generator.next(value);}return step.value;}
export function createNamespaceCodePreflightReader(options){return codePreflightReader(options,true);}
/** Exact accepted publication proofs replay immutable records, with original read fences checked by verifyPlan. */
export function createNamespaceRetainedCodePreflightReader(options){return codePreflightReader(options,false);}
function codePreflightReader(options,requireCurrentIndices){
  const {scope,workId}=options,observer=options.observer??createNamespaceStoryObserver(options),changes=createNamespaceSourceRetentionReader({...options,observer}),
    baseline=createNamespaceSourceBaselineReader({...options,observer}),checks=createNamespacePhaseCheckReader({...options,observer}),
    plans=createNamespaceSpecificationReader({observer,scope,workId,checks}),controlReader=createNamespaceSourceControlReader({...options,observer}),
    clauses=createNamespaceSourceClauseReader({observer,scope,workId,retention:changes,baseline,checks,controlReader}),
    files=createNamespaceCodeSourceReader({observer,retention:changes,baseline,requireCurrentIndices}),outputsReader=createNamespaceOutputRetentionReader({...options,observer,sourceReader:changes});
  async function inspect(snapshot,phaseId,identity,{signal,binding=null,policyTraversal}={}){
    const workflow=snapshot.workflow,commandProof=await createNamespaceTestCommandOwners({observer,scope,workId}).commands(snapshot,phaseId,{signal,policyTraversal}),
      phase={...workflow.phases[phaseId],qualityCommands:commandProof.commands},definition=(await observer.approved(snapshot,{signal})).compiled.definition;
    if(workflow.resolution.testRecovery?.enabled)required('test-recovery');
    if(!requireCurrentIndices&&!binding)throw failure('Replay the exact accepted publication source binding.','ENGINE_INPUT_INVALID');
    const retained=binding?await changes.accepted({operationId:binding.source.operationId,workId,phaseId},{signal}):await changes.inspectDraft(identity,{signal});
    if(!retained)throw failure('Retain this exact authored generation before code publication.','ENGINE_SOURCE_EVIDENCE_REQUIRED',{operation:'phase.source.retain',workId,phaseId});
    if(retained.plan.basis.headVersion!==snapshot.revision||!same(retained.plan.basis.configuration,snapshot.configuration)||!same(retained.workflow,workflow))throw failure('Code source evidence belongs to another lifecycle basis.','ENGINE_CONTEXT_CHANGED');
    const predecessors=createNamespaceCodePredecessorReader({observer,scope,workId}),priorCode=await predecessors.inspect(snapshot,phaseId,retained,{signal,policyTraversal});
    const history=retained.plan.generation>1?await createNamespaceCodeHistoryReader({observer,scope,workId}).inspect(snapshot,phaseId,retained,{signal,policyTraversal})
      :await createNamespaceInitialCodeHistoryReader({observer,scope,workId}).inspect(snapshot,phaseId,{signal,policyTraversal});
    if((retained.plan.generation===1)!==(phase.generation===0))throw failure('The Code generation has no matching predecessor.','ENGINE_CODE_REWORK_REQUIRED');
    if(binding&&!same(retained.binding,binding.source))throw failure('The retained Code result names another accepted source archive.','ENGINE_STORAGE_CORRUPT');
    let original=binding?await baseline.accepted({operationId:binding.baseline.operationId,workId,sourceBindingId:retained.plan.sourceBinding.operationId},{signal})
      :await baseline.inspectBinding(retained.plan.sourceBinding.operationId,{signal});
    if(!original)throw failure('Retain the exact original source selection before code publication.','ENGINE_SOURCE_BASELINE_REQUIRED',{
      operation:'source.baseline.retain',sourceBindingId:retained.plan.sourceBinding.operationId,workId});
    if(binding){original={...original,indexKey:baseline.codec.indexKey(original.plan.input)};
      if(!same(original.record,binding.baseline.record)||original.indexVersion!==binding.baseline.index.version||original.indexKey!==binding.baseline.index.key)throw failure('The retained Code result names another accepted baseline.','ENGINE_STORAGE_CORRUPT');}
    const plan=await plans.sourcePlan(snapshot,phaseId,{signal}),control=requireCurrentIndices?await controlReader.inspectDraft(identity,{signal}):null,
      clauseFacts=await clauses.inspect(snapshot,phaseId,retained,original,{signal,control});
    if(clauseFacts.requiredPolicyOwners.length)required(clauseFacts.requiredPolicyOwners[0]);
    const outputs=binding&&!binding.outputs?null:await outputsReader.selection({phaseId,generation:retained.plan.generation,
      configuration:snapshot.configuration,source:retained},{signal,...(binding?{binding:binding.outputs}:{})}),repositories=[];
    for(const source of retained.plan.sources){
      const id=source.repository.id,context=await files.capture(retained,original,id,{signal}),sourceBasis=context.sourceBasis,
        projection=plan.repositoryPlan?repositoryPlanProjection(plan.repositoryPlan,id):null,
        planned=projection?{...plan.planned,claims:projection.claims,supportingFiles:projection.supportingFiles,supportingFileDetails:projection.supportingFileDetails}:plan.planned,
        amendments=projection?plan.records.filter(row=>row.amendment).map(row=>repositoryPlanAmendmentProjection(plan.repositoryPlan,row,id,{workflow,definition})).filter(Boolean):[],
        earlier=predecessors.repository(priorCode,id,{workflow,definition}),
        records={indexes:plan.active.indexes,planned:[...new Map([...(projection?[planned,...amendments]:plan.records),...earlier.records].map(row=>[canonicalJson(row),row])).values()],observed:earlier.observed,acceptance:[]},
        obligations=Object.entries(planned.claims).filter(([,claim])=>plannedClaimAllocatedTo(claim,phaseId)).map(([clauseId,claim])=>({clauseId,...claim})),
        scope=codeDeliveryCandidateScope(records.planned,workflow,phase),nativeEntries=files.changes(context,{signal}).map(entry=>({
          status:entry.status==='D'?'deleted':entry.status==='A'?'added':'modified',oldPath:entry.oldPath,newPath:entry.newPath,untracked:false,
          oldMode:entry.before?(entry.before.executable?'100755':'100644'):'000000',newMode:entry.after?(entry.after.executable?'100755':'100644'):'000000',
          oldObject:null,newContent:entry.after?{kind:'regular-file',sha256:entry.after.sha256,size:entry.after.bytes}:null,
          baseline:entry.before?{sha256:entry.before.sha256,size:entry.before.bytes,executable:entry.before.executable}:null})),
        changeSet={schemaVersion:1,profile:'sflow-namespace-code-change-set/v1',sourceBasis,entries:nativeEntries},
        bound=clauseFacts.repositories.find(row=>row.id===id)?.value;
      let coverage=null;
      const correctedEvidence=new Map();
      for(const amendment of plan.amendments)for(const operation of amendment.operations??[]){
        if(operation.op!=='reclassify-evidence'||operation.delivery.phase!==phaseId||operation.delivery.generation!==retained.plan.generation||!planned.claims[operation.clauseId]?.expectedPaths?.includes(operation.path)
          ||planned.claims[operation.clauseId].fulfillment!=='evidence')continue;
        const prior=correctedEvidence.get(operation.path);if(prior&&!same(prior,operation.content))throw failure('One evidence path has conflicting retained human-reviewed bytes.','PLAN_EVIDENCE_AMENDMENT_INTEGRITY');
        correctedEvidence.set(operation.path,operation.content);}
      // A new output proves its own actual source/generation. It grants no additional clause scope.
      for(const output of outputs?.files??[])if(Object.values(planned.claims).some(claim=>claim.fulfillment==='evidence'&&claim.expectedPaths?.includes(output.path)))
        correctedEvidence.set(output.path,output.content);
      const pathFacts=path=>correctedEvidence.has(path)?{exists:true,regular:true,bytes:correctedEvidence.get(path).bytes}:files.facts(context,path,{signal}),
        readBytes=async(path,maximumBytes=16*1024*1024)=>{const reference=correctedEvidence.get(path);
          if(!reference)return files.bytes(context,path,{signal,maximumBytes});
          if(reference.bytes>maximumBytes)throw failure('The evidence request exceeds its exact retained-file limit.','ENGINE_CODE_SOURCE_LIMIT');
          return observer.bytes(reference,reference.bytes,signal);},
        text=async(path,maximumBytes)=>{const value=await readBytes(path,maximumBytes);if(value===null)return null;
          try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(value);}catch(cause){throw new SingularityFlowError('Read actual UTF-8 source before deriving Code bindings.',{code:'ENGINE_SOURCE_DIFF_TEXT_REQUIRED',cause});}};
      const accounted=new Map();for(const amendment of plan.amendments)for(const change of amendment.changes??[]){
        accounted.set(change.path,{change,amendment:amendment.id,sha256:amendment.contentHashes?.[change.path]??null});}
      for(const [global,expected]of accounted){if(!expected.sha256)continue;
        const location=plan.repositoryPlan?repositoryPlanTestLocation(plan.repositoryPlan,global,{workflow,definition}):{repositoryId:id,path:global};
        if(location?.repositoryId!==id)continue;const bytes=await readBytes(location.path);
        if(bytes===null||hash(bytes)!==expected.sha256)throw failure('A file changed after its human plan accounting. Review the current bytes before accepting it again.',
          'PLAN_AMENDMENT_CONTENT_CHANGED',{workId,phase:phaseId,path:global,amendment:expected.amendment,
            actions:[{operation:'decision.plan',inputs:{workId,changes:[expected.change]}}],requiredInputs:['operationId','reason']});
      }
      async function discover(request){
        return replay(discoverAcceptanceWitnessesReplay(phase,request),async item=>{
          if(item.kind==='witness-test-commands')return commandProof.commands;
          if(item.kind==='witness-command-for-file')return replay(commandForTestFileReplay(item.commands,item.file),async item=>(await text(item.file,1048576))??'');
          if(item.kind!=='witness-declarations')required(item.kind);
          const framework={'node-test-v1':'node:test','jest-static-v2':'jest','vitest-static-v2':'vitest','playwright-json-v1':'playwright'}[item.profile];
          if(!framework)required('test-declaration-adapter');const result={declarations:[],unattachedTags:[],fileGaps:{}};
          for(const file of item.files){const source=await text(file,1048576);if(source===null){result.fileGaps[file]=[{code:'TEST_SOURCE_UNAVAILABLE',message:'The exact retained test source is missing.'}];continue;}
            const value=scanJavaScriptDeclarations(source,{sourcePath:file,framework});result.declarations.push(...value.declarations);result.unattachedTags.push(...value.unattachedTags.map(tag=>({sourcePath:file,...tag})));if(value.fileGaps.length)result.fileGaps[file]=value.fileGaps;}
          return result;
        });
      }
      const read=async request=>{
        if(signal?.aborted)throw failure('Code preflight was cancelled.','ENGINE_OPERATION_CANCELLED');
        switch(request.kind){
          case 'verify-source-generation':if(!same(request.sourceBasis,sourceBasis))throw failure('Code preflight changed its authenticated source basis.','ENGINE_INPUT_INVALID');return files.finish(context,{signal});
          case 'working-change-set':return changeSet;
          case 'merged-base-paths':return null;
          case 'candidate-scope':return scope;
          // No unselected application bytes may influence the published candidate.
          case 'outside-candidates':return priorCode?path=>earlier.paths.has(path):null;
          case 'unreconciled-candidates':return scope?[...new Set(nativeEntries.flatMap(entry=>[entry.oldPath,entry.newPath].filter(path=>path&&!scope.allows(path)&&!earlier.paths.has(path))))].sort():[];
          case 'executable-test-path':return files.facts(context,request.candidate,{signal}).regular&&isExecutableTestSourceCandidate(request.candidate,{sourceExtensions:request.sourceExtensions});
          case 'reusable-paths':if(request.candidates.length)required('namespace-code-history');return [];
          case 'reviewed-baseline-tests':return [];
          case 'allocated-obligations':return obligations;
          case 'working-path-facts':return pathFacts(request.candidate);
          case 'working-path-bytes':return readBytes(request.candidate);
          case 'required-acceptance':return definition.governance?.requireAcceptanceCriteriaTags?requiredAcceptanceFromPlan(
            plan.active.indexes.flatMap(index=>index.clauses).filter(clause=>clause.type==='AC'||/:AC-\d+$/u.test(clause.id)).map(clause=>clause.id),planned.claims,mergedVerificationContracts([planned]),phaseId):[];
          case 'specification-records':return records;
          case 'acceptance-tags':{const occurrences=[];for(const path of request.testPaths){const source=await text(path,1048576);if(source!==null)occurrences.push(...scanSourceClauseTags(source,{sourcePath:path}).filter(tag=>tag.tag==='ac').map(tag=>({clauseId:tag.clauseId,line:tag.line,testSource:path})));}return acceptanceTagBindings(occurrences);}
          case 'story-added-acceptance-tags':case 'carried-criterion-tags':required('namespace-code-test-origins');break;
          case 'acceptance-witnesses':return discover(request);
          case 'source-clause-bindings':if(clauseFacts.status==='off')return {mode:'off',required:[],bindings:[],missing:[]};if(!bound)required('source-clause-bindings');return bound;
          case 'implementation-bindings':return replay(implementationBindingsReplay(request),async item=>{
            if(item.kind==='implementation-diff-preview')return files.regions(context,item.paths,{signal});
            if(item.kind==='implementation-source'){const source=await text(item.path,item.maximumBytes);if(source?.includes('\0'))throw failure('Binary implementation needs its explicit analysis owner.','ENGINE_SOURCE_DIFF_TEXT_REQUIRED');return source;}
            required(item.kind);
          });
          case 'accepted-dispute':if(Object.keys(workflow.phaseFindingDisputes??{}).length)required('namespace-code-finding-decisions');return {active:null};
          case 'format-preflight-refusal':return failure('Repair this code generation before publication.','CODE_DELIVERY_INCOMPLETE',{workId,phase:phaseId,
            profile:'sflow-namespace-code-preflight-refusal/v1',sourceBasis,candidateSha256:request.candidateSha256??null,
            reason:request.reason,errors:request.errors??[],findings:request.findings??[],unresolved:request.unresolved??[],unsafeExclusions:request.unsafeExclusions??[],protectedPaths:request.protectedPaths??[],
            recovery:{authoringPhase:phaseId,planningPhase:workflow.resolution.plannedClaims?.owners?.[phaseId]??null,
              requires:[request.reason==='protected'?'restore-protected-paths':['unsafe','unreconciled'].includes(request.reason)?'reconcile-candidate-scope':'repair-code-evidence'],
              afterCorrection:{operation:'phase.source.retain',inputs:{workId,phaseId}}}});
          case 'path-evidence':{const rows=[];for(const path of request.paths){const facts=outputs?pathFacts(path):files.facts(context,path,{signal}),data=facts.exists?await readBytes(path):null,
              original=nativeEntries.find(entry=>entry.oldPath===path&&!entry.newPath)?.baseline;
            rows.push({path,kind:isConfigurationPath(path)?'configuration':isAllowedTestAutomationPath(path)?'test':isDocumentationPath(path)?'documentation':'source',
              fileKind:facts.exists?'regular-file':'missing',exists:facts.exists,size:facts.exists?facts.bytes:null,sha256:data?hash(data):null,
              ...(!facts.exists&&original?{verifiedAbsence:true,baseline:{profile:'sflow-namespace-absent-source/v1',...original,sourceBasis}}:{})});}return rows;}
          case 'candidate-coverage':{
            coverage=await replay(candidateSpecificationCoverageReplay(definition,workflow,phase,request.delivery,{pathContext:applicationPathContext(definition,workflow)}),async item=>{
              if(item.kind==='candidate-coverage-records')return records;
              if(item===SPECIFICATION_CLAIM_TIMESTAMP_REQUEST)return retained.body.recordedAt;
              required(item.kind);
            });
            if(coverage?.status==='correction-required')throw failure('Repair the exact planned claim coverage before publication.','SPEC_COVERAGE_INCOMPLETE',coverage);return coverage;
          }
          default:required(request.kind);
        }
      };
      const delivery=await replay(namespaceCodeDeliveryPreflightReplay(definition,workflow,phase,{sourceBasis,strictCoverage:true,requireReconciled:true}),read);
      await files.finish(context,{signal});repositories.push({id,delivery,coverage});
    }
    for(const binding of [control?.binding.index,...(control?.plan.origins??[]).flatMap(row=>[row.origin,row.baseline]).map(value=>value.index)])if(binding){
      const current=await observer.record('evidence',binding.key,false,signal);if(current?.version!==binding.version)throw failure('Code origin evidence changed during preflight.','ENGINE_CONTEXT_CHANGED');
    }
    return {profile:'sflow-namespace-code-preflight/v'+namespaceCodePreflightVersion({history,plan:plan.proof,priorCode,outputs}),...(history?{history}:{}),...(priorCode?{priorCode}:{}),...(outputs?{outputs}:{}),source:retained.binding,baseline:{operationId:original.plan.input.operationId,record:original.record,
      index:{key:original.indexKey,version:original.indexVersion}},plan:plan.proof,repositories};
  }
  return Object.freeze({inspect});
}
