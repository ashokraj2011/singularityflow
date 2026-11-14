/** Execution port binding only. No process, provider, repository or storage selection. */
import {SingularityFlowError} from './failures.mjs';
export const EXECUTION_UNIT_CONTRACT='sflow-execution-unit/v1';
export const NODE_CHECK_EXECUTION_PROFILE='sflow-local-check-execution/v1';
export const NODE_QUALIFIED_CHECK_EXECUTION_PROFILE='sflow-local-check-execution/v2';
export const NODE_SELECTIVE_CHECK_EXECUTION_PROFILE='sflow-local-check-execution/v3';
export const NODE_SCRIPT_SELECTIVE_CHECK_EXECUTION_PROFILE='sflow-local-check-execution/v4';
export const NODE_COMMAND_EXECUTION_PROFILE='sflow-local-command-execution/v1';
export const NODE_QUALIFIED_COMMAND_EXECUTION_PROFILE='sflow-local-command-execution/v2';
/** Separate command observations never claim parsed tests. This is a port format, not authorization. */
export function localCheckExecutionProfile(policy){
  if(policy?.profile===NODE_CHECK_EXECUTION_PROFILE)return Object.freeze({format:NODE_CHECK_EXECUTION_PROFILE,testReport:true});
  if(policy?.profile===NODE_QUALIFIED_CHECK_EXECUTION_PROFILE)return Object.freeze({format:NODE_QUALIFIED_CHECK_EXECUTION_PROFILE,testReport:true,qualifiedEnvironment:true});
  if(policy?.profile===NODE_SELECTIVE_CHECK_EXECUTION_PROFILE)return Object.freeze({format:NODE_SELECTIVE_CHECK_EXECUTION_PROFILE,testReport:true,qualifiedEnvironment:true,selective:true});
  if(policy?.profile===NODE_SCRIPT_SELECTIVE_CHECK_EXECUTION_PROFILE)return Object.freeze({format:NODE_SCRIPT_SELECTIVE_CHECK_EXECUTION_PROFILE,testReport:true,qualifiedEnvironment:true,selective:true,scriptSelection:true});
  if(policy?.profile===NODE_COMMAND_EXECUTION_PROFILE&&typeof policy.commandKind==='string'&&policy.commandKind!=='test'
    &&/^[a-z][a-z0-9-]{0,31}$/u.test(policy.commandKind))return Object.freeze({format:NODE_COMMAND_EXECUTION_PROFILE,testReport:false,commandKind:policy.commandKind});
  if(policy?.profile===NODE_QUALIFIED_COMMAND_EXECUTION_PROFILE&&typeof policy.commandKind==='string'&&policy.commandKind!=='test'
    &&/^[a-z][a-z0-9-]{0,31}$/u.test(policy.commandKind))return Object.freeze({format:NODE_QUALIFIED_COMMAND_EXECUTION_PROFILE,testReport:false,qualifiedEnvironment:true,commandKind:policy.commandKind});
  throw new SingularityFlowError('Use the declared test-report or command-observation execution profile.',{code:'ENGINE_CHECK_BINDING_CHANGED'});
}
export function reviewedFileSelectionPolicy(selection,row,originalArgumentsSha256){return {
  profile:row.declaration.adapter==='node-script-junit-v1'?'sflow-node-check-file-selection/v2':'sflow-node-check-file-selection/v1',
  sha256:selection.record.contextSha256,originalArgumentsSha256,files:row.files,...(row.declaration.adapter==='node-script-junit-v1'?{adapter:row.declaration.adapter}:{})};}
export const EXECUTION_UNIT_METHODS=Object.freeze(['descriptor','doctor','planCapability','start','observe','requestStop','quiesce','collect']);
/** Trusted host construction; a captured method is not an authorization or verification receipt. */
export function captureExecutionUnit(unit) {
  const methods={};
  if(!unit||typeof unit!=='object')throw new SingularityFlowError('Supply an explicit execution-unit port.',{code:'ENGINE_EXECUTION_UNIT_PORT_INVALID'});
  for(const name of EXECUTION_UNIT_METHODS){let owner=unit,field,depth=0;
    while(owner&&!field&&depth++<64){field=Object.getOwnPropertyDescriptor(owner,name);if(!field)owner=Object.getPrototypeOf(owner);}
    if(!field||!Object.hasOwn(field,'value')||typeof field.value!=='function')throw new SingularityFlowError(
      'The execution-unit port is missing a plain method.',{code:'ENGINE_EXECUTION_UNIT_PORT_INVALID',details:{method:name}});
    methods[name]=field.value.bind(unit);}
  return Object.freeze(methods);
}
