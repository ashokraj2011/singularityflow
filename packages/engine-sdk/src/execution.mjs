/** Execution port binding only. No process, provider, repository or storage selection. */
import {SingularityFlowError} from '../../../src/foundation/failures.mjs';
export const EXECUTION_UNIT_CONTRACT='sflow-execution-unit/v1';
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
