/** Frozen human-decision v1 adapter over the shared read-only conditional-record verifier. */
import {createNamespaceRecordedMutationReader} from './namespace-recorded-mutation-reader.mjs';
import {namespaceHumanDecisionContract} from './namespace-human-decision-contract.mjs';
export function createNamespaceHumanDecisionReader(options){
  return createNamespaceRecordedMutationReader({...options,contract:namespaceHumanDecisionContract});
}
