/** Versioned human decisions. Conditional persistence has one shared coordinator. */
import {createNamespaceRecordedMutationPort} from './namespace-recorded-mutation.mjs';
import {namespaceHumanDecisionContract} from './namespace-human-decision-contract.mjs';
export function createNamespaceHumanDecisionPort(options,definition){
  return createNamespaceRecordedMutationPort(options,{...definition,contract:namespaceHumanDecisionContract,requiresHuman:true});
}
