/** Read-only audit of registered native and namespace hosts. No repository or store is opened. */
import {fileURLToPath} from 'node:url';import path from 'node:path';
import {ENGINE_CONTRACT,ENGINE_OPERATIONS} from '../src/engine-sdk/index.mjs';
import {createGitEngine} from '../src/engine-compatibility/git-publication.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {namespaceStoreDescriptor,NAMESPACE_STORE_METHODS} from '../src/sda/namespace/contract.mjs';
import {contentStoreDescriptor,CONTENT_STORE_METHODS} from '../src/sda/content/contract.mjs';
const parity=Object.freeze({publication:['engine-publication-parity'],submission:['engine-submission-parity'],approval:['engine-approval-parity'],
  rejection:['engine-rejection-parity'],decisions:['engine-decisions-parity'],decisionList:['engine-decision-list-parity'],advancement:['engine-advancement'],planCorrection:['engine-plan-correction-parity'],
  decisionRecord:['engine-decision-record-parity','engine-witness-decisions-parity'],testDecisionRecord:['engine-test-decisions-parity'],upstream:['engine-upstream-parity'],
  storyGuide:['engine-guide-parity'],storyNext:['engine-next-plan-parity'],storyStatus:['engine-story-status-parity'],phaseReview:['engine-phase-review-parity'],
  documentRead:['engine-document-read-parity'],phaseEntry:['engine-phase-entry-parity'],phaseBegin:['engine-phase-begin-parity'],
  phasePreparation:['engine-phase-preparation-parity'],phaseInputs:['engine-phase-inputs-parity'],phaseRollover:['engine-phase-rollover-parity'],
  phasePrepublish:['engine-phase-prepublish-parity'],phaseDraftCheck:['engine-phase-draft-check-parity']});
export function engineOperationInventory(){
  const forbidden=()=>{throw Error('Operation inventory cannot read repositories, stores, identities, clocks or execution.');},
    shared={kind:'shared'},local={kind:'machine-local',deviceId:'inventory-device'},
    records=binding=>({descriptor:namespaceStoreDescriptor({id:binding.kind==='shared'?'inventory-shared':'inventory-local',qualification:'test-only',binding}),
      ...Object.fromEntries(NAMESPACE_STORE_METHODS.map(key=>[key,forbidden]))}),
    content=binding=>({descriptor:contentStoreDescriptor({id:binding.kind==='shared'?'inventory-shared-bytes':'inventory-local-bytes',binding,maximumBytes:134217728}),
      ...Object.fromEntries(CONTENT_STORE_METHODS.map(key=>[key,forbidden]))}),
    native=createGitEngine({root:path.resolve(path.sep,'sflow-inventory-no-checkout')}).engine.capabilities,
    namespace=createNamespaceEngine({records:records(shared),content:content(shared),scope:{projectId:'inventory'},workId:'story',
      authority:{id:'inventory-authority',epoch:1},access:{current:forbidden},clock:{now:forbidden},
      working:{records:records(local),content:content(local)}}).capabilities,
    nativeIds=new Set(native.boundOperations.map(row=>row.id)),namespaceIds=new Set(namespace.boundOperations.map(row=>row.id));
  const operations=ENGINE_OPERATIONS.map(operation=>{
    const bound=nativeIds.has(operation.id),tests=bound?parity[operation.port]:null;
    if(bound&&!tests?.length)throw Error('A native operation has no declared compatibility qualifier: '+operation.id);
    return {id:operation.id,version:operation.version,effect:operation.effect,port:operation.port,
      inputFields:[...operation.inputFields],requiredFields:[...(operation.requiredFields??[])],stages:[...operation.stages],
      nativeBound:bound,namespaceBound:namespaceIds.has(operation.id),nativeQualification:tests?.map(name=>'test/'+name+'.test.mjs')??[],
      ...(operation.id==='phase.checks.run'?{optionalCapability:'explicit-check-execution'}:{})};
  });
  return {schemaVersion:1,profile:'sflow-engine-operation-inventory/v1',contract:ENGINE_CONTRACT,
    hosts:{native:'createGitEngine',namespace:'createNamespaceEngine with private working stores, without optional execution'},operations,
    totals:{registered:operations.length,native:nativeIds.size,namespace:namespaceIds.size},
    qualificationExecuted:false,authorityGranted:false,readinessEstablished:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const report=engineOperationInventory();if(process.argv.slice(2).some(value=>value!=='--json'))throw Error('Use --json or no arguments.');
  process.stdout.write(JSON.stringify(report,null,process.argv.includes('--json')?undefined:2)+'\n');
}
