import { canonicalJson, deepFreeze } from '../canonicalize.mjs';
import { assertSha256, contractFailure } from '../contracts.mjs';

function unavailable(message, details = {}) {
  contractFailure(message, 'WMP_OWNER_IMPLEMENTATION_UNAVAILABLE', details);
}

function implementationKey(contract) {
  return `${contract.contractSha256}\0${contract.implementationSha256}`;
}

function assertRegisteredContract(received, installed, owner) {
  if (canonicalJson(received) !== canonicalJson(installed)) {
    unavailable(`The retained ${owner} contract bytes do not match its registered implementation.`, {
      owner,
      contractSha256: received.contractSha256,
      implementationSha256: received.implementationSha256
    });
  }
}

/**
 * Build an append-only dispatch table for immutable persisted-view implementations.
 *
 * Historical readers resolve both the self-hashed contract and its implementation digest. The
 * active writer is deliberately a separate pointer: changing it never changes or shadows an older
 * entry, and an unknown implementation always fails closed rather than using current behavior.
 */
export function createPersistedViewImplementationRegistry({
  entries = [], activeWriterId
} = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    unavailable('The persisted-view implementation registry is empty.');
  }
  const byId = new Map();
  const rendererByKey = new Map();
  const validatorByKey = new Map();
  for (const candidate of entries) {
    const entry = deepFreeze({ ...candidate });
    if (typeof entry.id !== 'string' || !entry.id || !Number.isInteger(entry.version)
        || entry.version < 1 || typeof entry.replay !== 'function') {
      unavailable('A persisted-view implementation registry entry is malformed.', {
        id: entry.id ?? null, version: entry.version ?? null
      });
    }
    if (byId.has(entry.id)) unavailable('Persisted-view implementation IDs must be unique.', {
      id: entry.id
    });
    for (const [owner, contract] of [
      ['renderer', entry.rendererContract], ['validator', entry.validatorContract]
    ]) {
      if (!contract || typeof contract !== 'object') {
        unavailable(`The ${owner} contract is missing from registry entry '${entry.id}'.`);
      }
      assertSha256(contract.contractSha256, `${owner} contractSha256`);
      assertSha256(contract.implementationSha256, `${owner} implementationSha256`);
      if (contract.version !== entry.version) unavailable(
        `Registry entry '${entry.id}' version does not match its ${owner} contract.`,
        { entryVersion: entry.version, contractVersion: contract.version, owner }
      );
      const index = owner === 'renderer' ? rendererByKey : validatorByKey;
      const key = implementationKey(contract);
      if (index.has(key)) unavailable(`The ${owner} contract is registered more than once.`, {
        contractSha256: contract.contractSha256,
        implementationSha256: contract.implementationSha256
      });
      index.set(key, entry);
    }
    byId.set(entry.id, entry);
  }
  const activeWriter = byId.get(activeWriterId);
  if (!activeWriter) unavailable('The active persisted-view writer is not registered.', {
    activeWriterId: activeWriterId ?? null
  });

  function resolve(owner, contract) {
    if (!contract || typeof contract !== 'object') {
      unavailable(`The retained ${owner} contract is unavailable.`);
    }
    assertSha256(contract.contractSha256, `${owner} contractSha256`);
    assertSha256(contract.implementationSha256, `${owner} implementationSha256`);
    const index = owner === 'renderer' ? rendererByKey : validatorByKey;
    const entry = index.get(implementationKey(contract));
    if (!entry) unavailable(`No retained ${owner} implementation matches this contract.`, {
      owner,
      contractSha256: contract.contractSha256,
      implementationSha256: contract.implementationSha256
    });
    const installed = owner === 'renderer'
      ? entry.rendererContract : entry.validatorContract;
    assertRegisteredContract(contract, installed, owner);
    return entry;
  }

  return Object.freeze({
    entries: Object.freeze([...byId.values()]),
    activeWriter,
    resolveRenderer: (contract) => resolve('renderer', contract),
    resolveValidator: (contract) => resolve('validator', contract),
    replay({ rendererContract, validatorContract, ...input }) {
      const renderer = resolve('renderer', rendererContract);
      const validator = resolve('validator', validatorContract);
      if (renderer !== validator) unavailable(
        'Retained renderer and validator contracts resolve to different implementation versions.',
        {
          rendererEntryId: renderer.id,
          validatorEntryId: validator.id
        }
      );
      return renderer.replay({
        ...input, rendererContract, validatorContract
      });
    }
  });
}
