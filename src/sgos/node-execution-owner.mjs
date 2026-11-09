/** Process-local ownership capability. A foreign/missing owner never authorizes an execution retry. */
import {randomUUID} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
export function createNodeExecutionOwner({hostId}={}) {
  if(typeof hostId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(hostId)) {
    throw new SingularityFlowError('Supply a stable, portable execution host ID.',{code:'SGOS_EXECUTION_OWNER_INVALID'});
  }
  const instanceId=randomUUID(),active=new Set();
  const descriptor=Object.freeze({profile:'sgos-execution-owner/v1',hostId,instanceId});
  function owns(token){return token?.hostId===hostId&&token.instanceId===instanceId&&active.has(token.id);}
  return Object.freeze({descriptor,
    async acquire(){const id=randomUUID();active.add(id);return Object.freeze({hostId,instanceId,id});},
    async assert(token){if(!owns(token))throw new SingularityFlowError('The execution lease is not owned by this live host instance.',{
      code:'SGOS_EXECUTION_LEASE_LOST'});return true;},
    async release(token){if(owns(token))active.delete(token.id);}
  });
}
