/**
 * Internal migration profile: logical namespaces routed to the existing Git owners. This is not
 * the draft namespace record-store protocol and cannot be selected as a replacement authority.
 * Native ports retain their own versioned contracts, results and recovery guarantees.
 */
import { exactObject, namespaceError, namespaceName, namespaceScope } from './namespace/values.mjs';
import { LIFECYCLE_AUTHORITY_CONTRACT } from './lifecycle-authority-contract.mjs';
import { SHARED_STATE_CONTRACT } from './shared-state-contract.mjs';

export const GIT_COMPATIBILITY_CONTRACT = 'sda-git-compatibility/draft-1';
const CONFIGURATION_OPERATIONS = Object.freeze([
  'withRead', 'withCommitRead', 'propose', 'listProposals', 'inspectProposal', 'activateProposal',
  'transactions', 'reconcileTransaction'
]);
export const GIT_COMPATIBILITY_PORTS = Object.freeze({
  configuration: Object.freeze({
    namespace: 'config', role: 'configuration',
    protocol: 'existing-reviewed-configuration', operations: CONFIGURATION_OPERATIONS,
    cancellation: 'before-start'
  }),
  lifecycle: Object.freeze({
    namespace: 'state', role: 'lifecycle',
    protocol: LIFECYCLE_AUTHORITY_CONTRACT,
    operations: Object.freeze(['observe', 'publish', 'pending']), cancellation: 'existing-stage-boundaries'
  }),
  proof: Object.freeze({
    namespace: 'state', role: 'proof', protocol: SHARED_STATE_CONTRACT,
    operations: Object.freeze(['append', 'page', 'verify']), cancellation: 'before-start'
  })
});

export function gitCompatibilityDescriptor(options) {
  exactObject(options, ['scope'], ['proof'], 'Compatibility descriptor');
  const { scope, proof = false } = options;
  if (typeof proof !== 'boolean') throw namespaceError('Proof availability must be a boolean.');
  return Object.freeze({
    id: 'git-compatibility', contract: GIT_COMPATIBILITY_CONTRACT,
    scope: namespaceScope(scope), authorityEligible: false, namespaceStoreEligible: false,
    rawTransactions: false, crossNamespaceAtomicity: false,
    ports: Object.freeze(['configuration', 'lifecycle', ...(proof ? ['proof'] : [])]
      .map(role => GIT_COMPATIBILITY_PORTS[role]))
  });
}

export function assertGitCompatibilityScope(bound, requested) {
  const scope = namespaceScope(requested);
  if (scope.projectId !== bound.projectId) {
    throw namespaceError('The requested project does not match this Git binding.', 'SDA_NAMESPACE_INPUT_INVALID', {
      expectedProjectId: bound.projectId, projectId: scope.projectId
    });
  }
}

export function gitCompatibilityPort(descriptor, address) {
  exactObject(address, ['namespace', 'role'], [], 'Compatibility port');
  namespaceName(address.namespace);
  if (typeof address.role !== 'string' || address.role.length < 1 || address.role.length > 128) {
    throw namespaceError('A compatibility role must be a bounded name.');
  }
  const port = descriptor.ports.find(item => item.namespace === address.namespace && item.role === address.role);
  if (!port) {
    throw namespaceError('This Git binding does not support that namespace and role. Use its existing owner protocol.',
      'SDA_NAMESPACE_UNSUPPORTED', { namespace: address.namespace, role: address.role });
  }
  return port;
}
