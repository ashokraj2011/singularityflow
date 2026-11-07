/** Internal draft contract entry. No production adapter, authority registration or host I/O. */
export {
  NAMESPACES, NAMESPACE_LIMITS, addressIdentity, namespaceAddress, namespaceError,
  namespaceIdentifier, namespaceIdentityJson, namespaceJson, namespaceKey, namespaceName,
  namespaceRevision, namespaceScope
} from './values.mjs';
export {
  NAMESPACE_STORE_CAPABILITIES, NAMESPACE_STORE_CONTRACT, NAMESPACE_STORE_METHODS,
  assertNamespaceBinding, assertNamespaceNotCancelled, namespaceBinding, namespaceLimits,
  namespaceListQuery, namespaceStoreDescriptor, namespaceStoreOutcome, validateNamespaceStore
} from './contract.mjs';
export { namespaceTransaction, namespaceTransactionIdentity } from './transaction.mjs';
