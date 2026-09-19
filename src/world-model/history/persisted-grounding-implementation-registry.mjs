import { canonicalJson, deepFreeze } from '../canonicalize.mjs';
import { assertSha256, contractFailure } from '../contracts.mjs';

function unavailable(message, details = {}) {
  contractFailure(message, 'WMP_OWNER_IMPLEMENTATION_UNAVAILABLE', details);
}

function implementationKey(contract) {
  return `${contract.contractSha256}\0${contract.implementationSha256}`;
}

/** Append-only dispatch for exact retained grounding-composer implementations. */
export function createPersistedGroundingImplementationRegistry({
  entries = [], activeWriterId
} = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    unavailable('The persisted-grounding implementation registry is empty.');
  }
  const byId = new Map();
  const byKey = new Map();
  for (const candidate of entries) {
    const entry = deepFreeze({ ...candidate });
    const contract = entry.composerContract;
    if (typeof entry.id !== 'string' || !entry.id || !Number.isInteger(entry.version)
        || entry.version < 1 || typeof entry.replay !== 'function'
        || !contract || typeof contract !== 'object') {
      unavailable('A persisted-grounding implementation registry entry is malformed.', {
        id: entry.id ?? null, version: entry.version ?? null
      });
    }
    assertSha256(contract.contractSha256, 'grounding composer contractSha256');
    assertSha256(contract.implementationSha256,
      'grounding composer implementationSha256');
    if (contract.version !== entry.version) {
      unavailable(`Registry entry '${entry.id}' version does not match its composer contract.`, {
        entryVersion: entry.version, contractVersion: contract.version
      });
    }
    if (byId.has(entry.id)) {
      unavailable('Persisted-grounding implementation IDs must be unique.', { id: entry.id });
    }
    const key = implementationKey(contract);
    if (byKey.has(key)) {
      unavailable('The grounding composer contract is registered more than once.', {
        contractSha256: contract.contractSha256,
        implementationSha256: contract.implementationSha256
      });
    }
    byId.set(entry.id, entry);
    byKey.set(key, entry);
  }
  const activeWriter = byId.get(activeWriterId);
  if (!activeWriter) {
    unavailable('The active persisted-grounding writer is not registered.', {
      activeWriterId: activeWriterId ?? null
    });
  }

  function resolve(contract) {
    if (!contract || typeof contract !== 'object') {
      unavailable('The retained grounding composer contract is unavailable.');
    }
    assertSha256(contract.contractSha256, 'grounding composer contractSha256');
    assertSha256(contract.implementationSha256,
      'grounding composer implementationSha256');
    const entry = byKey.get(implementationKey(contract));
    if (!entry || canonicalJson(contract) !== canonicalJson(entry.composerContract)) {
      unavailable('No retained grounding composer implementation matches this contract.', {
        contractSha256: contract.contractSha256,
        implementationSha256: contract.implementationSha256
      });
    }
    return entry;
  }

  return Object.freeze({
    entries: Object.freeze([...byId.values()]),
    activeWriter,
    resolve,
    replay({ composerContract, entries: inputs }) {
      return resolve(composerContract).replay(inputs);
    }
  });
}
