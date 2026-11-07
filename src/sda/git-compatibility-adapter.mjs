/**
 * Phase 3 composition boundary. No new Git layout, serializer, journal, approval path or writer.
 * Opening a native port delegates to its installed owner; it does not turn arbitrary record puts
 * into lifecycle transitions. Root/project binding is supplied by trusted host composition, not
 * by an engine operation or a model. SDK/CLI routing is a subsequent migration slice.
 */
import path from 'node:path';
import { assertNotCancelled } from './shared-state-contract.mjs';
import { exactObject, namespaceError } from './namespace/values.mjs';
import {
  assertGitCompatibilityScope, gitCompatibilityDescriptor, gitCompatibilityPort
} from './git-compatibility-contract.mjs';

// Each lazy loader has one concrete owner. A failed import may be retried; native operation errors
// are returned unchanged, with their cause, outcome, pending publication and recovery details.
function lazy(load) {
  let pending;
  return () => pending ??= load().catch(error => { pending = undefined; throw error; });
}

function configurationPort(root) {
  const readers = lazy(() => import('../approved-configuration-reader.mjs'));
  const proposals = lazy(() => import('../configuration-proposal.mjs'));
  const call = async (load, name, args, signal) => {
    assertNotCancelled(signal, 'configuration operation');
    const owner = await load();
    assertNotCancelled(signal, 'configuration operation');
    return owner[name](root, ...args);
  };
  // These are trusted native callbacks, as in the existing reader/proposal APIs, not serializable
  // public engine inputs. Identity checks, confirmation and semantic transactions stay in owners.
  return Object.freeze({
    withRead: (fn, options = {}) => call(readers, 'withApprovedConfigurationRead', [fn, options], options.signal),
    withCommitRead: (binding, fn, { signal } = {}) => call(readers, 'withRepositoryConfigurationCommitRead', [binding, fn], signal),
    propose: (change, options = {}) => call(proposals, 'proposeConfigurationChange', [change, options], options.signal),
    listProposals: (options = {}) => call(proposals, 'listWorkflowConfigurationProposals', [options], options.signal),
    inspectProposal: (branch, { signal } = {}) => call(proposals, 'inspectWorkflowConfigurationProposal', [branch], signal),
    activateProposal: (branch, options = {}) => call(proposals, 'activateWorkflowConfigurationProposal', [branch, options], options.signal),
    transactions: ({ signal } = {}) => call(proposals, 'configurationTransactions', [], signal),
    reconcileTransaction: (id, { signal } = {}) => call(proposals, 'reconcileConfigurationTransaction', [id], signal)
  });
}

/**
 * @param {{root: string, scope: {projectId: string}, proof?: {config: object, options?: object}}} options
 * @returns {{descriptor: object, open: Function}}
 *
 * await adapter.open(scope, {namespace: 'state', role: 'lifecycle'|'proof'}, {signal}?)
 * await adapter.open(scope, {namespace: 'config', role: 'configuration'}, {signal}?)
 *
 * An explicit absolute checkout root is required. This factory performs no I/O. Each opened port
 * stays bound to that root; scope validation is a binding check, not a new authorization system.
 */
export function createGitCompatibilityAdapter(options) {
  exactObject(options, ['root', 'scope'], ['proof'], 'Git compatibility binding');
  if (typeof options.root !== 'string' || !path.isAbsolute(options.root) || options.root.includes('\0')) {
    throw namespaceError('A Git compatibility binding requires an explicit absolute repository root.');
  }
  const root = path.resolve(options.root);
  if (options.proof !== undefined) {
    exactObject(options.proof, ['config'], ['options'], 'Proof binding');
    exactObject(options.proof.config, [], Object.keys(options.proof.config ?? {}), 'Proof configuration');
    if (options.proof.options !== undefined) {
      exactObject(options.proof.options, [], ['env', 'transportRemote'], 'Proof transport options');
      if (options.proof.options.env !== undefined) {
        exactObject(options.proof.options.env, [], Object.keys(options.proof.options.env ?? {}), 'Proof environment');
      }
    }
  }
  // Capture the binding; caller mutation must not redirect a previously opened proof port.
  let proof = null;
  if (options.proof !== undefined) {
    try {
      proof = { config: structuredClone(options.proof.config), options: { ...options.proof.options,
        ...(options.proof.options?.env ? { env: { ...options.proof.options.env } } : {}) } };
    } catch (cause) {
      throw namespaceError('Proof configuration must be detachable data.', 'SDA_NAMESPACE_INPUT_INVALID', null, cause);
    }
  }
  const descriptor = gitCompatibilityDescriptor({ scope: options.scope, proof: proof !== null });
  const load = {
    configuration: lazy(async () => configurationPort(root)),
    lifecycle: lazy(async () => {
      const { lifecycleAuthority } = await import('./story-branch-authority.mjs');
      return lifecycleAuthority(root);
    }),
    proof: lazy(async () => {
      const { createGitLedgerAdapter } = await import('./git-ledger-adapter.mjs');
      return createGitLedgerAdapter(root, proof.config, proof.options);
    })
  };
  return Object.freeze({
    descriptor,
    async open(scope, address, { signal = null } = {}) {
      assertGitCompatibilityScope(descriptor.scope, scope);
      const { role } = gitCompatibilityPort(descriptor, address);
      assertNotCancelled(signal, 'compatibility port opening');
      const port = await load[role]();
      assertNotCancelled(signal, 'compatibility port opening');
      return port;
    }
  });
}
