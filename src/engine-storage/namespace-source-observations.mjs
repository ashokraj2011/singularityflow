/** Shared read-only source proof and fresh observations; no content or lifecycle writes. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {sourceSnapshot,validateSourceUnit} from '../foundation/source-snapshot.mjs';
import {storedSourceBinding} from '../kernel/source-binding.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const error=(message,code,details=null,cause=undefined)=>new SingularityFlowError(message,{code,details,cause});
function cancelled(signal){if(signal?.aborted)throw error('Source inspection was cancelled before its next read.','ENGINE_OPERATION_CANCELLED');}
export function createNamespaceSourceObservations({observer,sources=[],scope}={}) {
  const units=new Map(),unitIds=new Set();
  if(!Array.isArray(sources)||sources.length>32)throw error('Bind a bounded explicit source-unit list.','ENGINE_INPUT_INVALID');
  for(const source of sources){const descriptor=validateSourceUnit(source);
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
    const data=await observer.bytes(repository.snapshot,repository.snapshot.bytes,signal);let value;
    try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));sourceSnapshot(value,repository.descriptor);}
    catch(cause){if(['SGOS_SOURCE_UNSUPPORTED','ENGINE_STORAGE_UNSUPPORTED'].includes(cause.code))throw cause;
      throw error('The retained generation baseline is not its bound source snapshot.','ENGINE_STORAGE_CORRUPT',{repositoryId:repository.id},cause);}
    if(repository.revision!=='sha256:'+hash(canonicalJson(value)))throw error('The retained source baseline has another digest.','ENGINE_STORAGE_CORRUPT',{repositoryId:repository.id});
    return value;
  }
  async function binding(operationId,signal) {
    const proof=await observer.accepted(operationId,{signal});
    if(proof.plan.operation!=='source.bind')throw error('The selected source has no accepted source-binding operation.','ENGINE_STORAGE_CORRUPT',{operationId});
    const workflow=proof.state.workflow,selected=storedSourceBinding(workflow.sourceBindings?.current,operationId);
    return {proof,workflow,selected};
  }
  async function generation(workflow,payload,signal) {
    const selected=workflow.sourceBindings?.current,repositories=selected?.repositories;
    if(!payload.generationIntent||!payload.sources.length||!Array.isArray(repositories)||!repositories.length||!same(payload.sources,repositories)) {
      throw error('The private generation has no matching accepted source selection.','ENGINE_STORAGE_CORRUPT');
    }
    const {selected:accepted}=await binding(selected.operationId,signal);
    if(!same(accepted,selected))throw error('The source selection differs from its accepted lifecycle binding.','ENGINE_STORAGE_CORRUPT');
    return {selected,repositories};
  }
  async function fresh(observed,signal) {
    for(const {repository,current}of observed){const final=await capture(repository,signal);
      if(final.revision!==current.revision)throw error('Source bytes changed during inspection; the draft is preserved.','ENGINE_SOURCE_CHANGED',{repositoryId:repository.id});}
  }
  return Object.freeze({capture,baseline,binding,generation,fresh});
}
