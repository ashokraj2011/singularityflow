/** Native clock adapter; the shared kernel owns slot and contract evaluation. */
import {contractResult as evaluateContract} from '../kernel/verification-contract-results.mjs';
export {witnessFindingOf,executionWord} from '../kernel/verification-contract-results.mjs';
export function contractResult(id,contract,entries,options={}){
  return evaluateContract(id,contract,entries,{...options,at:options.at===undefined?new Date().toISOString():options.at});
}
