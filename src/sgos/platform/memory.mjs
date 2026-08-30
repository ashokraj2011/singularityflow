import { SingularityFlowError } from '../../util.mjs';
import {
  clonePlatformJson, createMemoryPromotion, platformSha256, validatePlatformRecord
} from './contracts.mjs';
import { assertAuthorityStoreAdapter } from './authority-store.mjs';
import { loadApprovedPlatformMutationAuthority } from './authority.mjs';

function fail(message, code = 'SGOS_MEMORY_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

const keyDigest = (value) => platformSha256(value).slice(7);
const candidateKey = (candidateId) => `memory-candidate:${keyDigest(candidateId)}`;
const versionKey = (memoryId, version) => `memory-version:${keyDigest(memoryId)}:${version}`;
const currentKey = (memoryId) => `memory-current:${keyDigest(memoryId)}`;
const promotionKey = (candidateId) => `memory-promotion:${keyDigest(candidateId)}`;

function requireCas(expectedRevision, expectedStateSha256) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0
      || !/^sha256:[a-f0-9]{64}$/.test(String(expectedStateSha256 ?? ''))) {
    fail('Memory mutation requires an exact Authority Store revision and state digest.', 'SGOS_MEMORY_CAS_REQUIRED');
  }
}

function validateRefAgainstState(ref, entries, visited = new Set()) {
  const validated = validatePlatformRecord(ref, 'platform-memory-ref');
  const identity = `${validated.memoryId}:${validated.version}`;
  if (visited.has(identity)) fail(`Memory dependency cycle includes '${validated.memoryId}'.`, 'SGOS_MEMORY_DEPENDENCY_INVALID');
  const stored = entries[versionKey(validated.memoryId, validated.version)];
  if (!stored || stored.recordSha256 !== validated.recordSha256) {
    fail(`Memory reference '${identity}' is unavailable or changed.`, 'SGOS_MEMORY_REFERENCE_UNAVAILABLE');
  }
  const current = entries[currentKey(validated.memoryId)];
  if (!current || current.recordSha256 !== validated.recordSha256) {
    fail(`Memory reference '${identity}' is no longer current.`, 'SGOS_MEMORY_DEPENDENCY_INVALIDATED');
  }
  visited.add(identity);
  try {
    for (const dependency of validated.dependencies) {
      const dependencyRef = entries[versionKey(dependency.memoryId, dependency.version)];
      if (!dependencyRef || dependencyRef.recordSha256 !== dependency.refSha256) {
        fail(`Memory dependency '${dependency.memoryId}:${dependency.version}' is unavailable.`, 'SGOS_MEMORY_DEPENDENCY_INVALIDATED');
      }
      validateRefAgainstState(dependencyRef, entries, visited);
    }
  } finally {
    visited.delete(identity);
  }
  return validated;
}

export function createPlatformMemoryService({ authorityStore, repositoryRoot }) {
  const store = assertAuthorityStoreAdapter(authorityStore);
  return Object.freeze({
    async registerCandidate(candidate, {
      expectedRevision,
      expectedStateSha256
    }) {
      requireCas(expectedRevision, expectedStateSha256);
      const authorization = await loadApprovedPlatformMutationAuthority(
        repositoryRoot, 'memory.register'
      );
      const validated = validatePlatformRecord(candidate, 'platform-memory-candidate');
      if (validated.proposedRef.authorityStoreId !== store.storeId) {
        fail('Memory candidate targets another Authority Store.', 'SGOS_MEMORY_AUTHORITY_MISMATCH');
      }
      const state = await store.read();
      if (state.revision !== expectedRevision || state.recordSha256 !== expectedStateSha256) {
        fail('Memory candidate registration lost its compare-and-swap race.', 'SGOS_MEMORY_CAS_MISMATCH');
      }
      if (Object.hasOwn(state.entries, candidateKey(validated.candidateId))) {
        fail(`Memory candidate '${validated.candidateId}' already exists.`, 'SGOS_MEMORY_IMMUTABLE');
      }
      return store.transact({
        expectedRevision,
        expectedStateSha256,
        actorId: authorization.actorId,
        authorization,
        changes: [{ op: 'put', key: candidateKey(validated.candidateId), value: validated }]
      });
    },

    async promote({
      candidateId,
      confirmCandidateSha256,
      reason,
      expectedRevision,
      expectedStateSha256
    }) {
      requireCas(expectedRevision, expectedStateSha256);
      const authorization = await loadApprovedPlatformMutationAuthority(
        repositoryRoot, 'memory.promote'
      );
      const state = await store.read();
      if (state.revision !== expectedRevision || state.recordSha256 !== expectedStateSha256) {
        fail('Memory promotion lost its compare-and-swap race.', 'SGOS_MEMORY_CAS_MISMATCH');
      }
      const candidate = state.entries[candidateKey(candidateId)];
      if (!candidate) fail(`Memory candidate '${candidateId}' does not exist.`, 'SGOS_MEMORY_CANDIDATE_NOT_FOUND');
      validatePlatformRecord(candidate, 'platform-memory-candidate');
      if (candidate.recordSha256 !== confirmCandidateSha256) {
        fail('Memory promotion confirmation does not match the exact candidate.', 'SGOS_MEMORY_CONFIRMATION_MISMATCH');
      }
      if (Object.hasOwn(state.entries, promotionKey(candidateId))) {
        fail(`Memory candidate '${candidateId}' has already been decided.`, 'SGOS_MEMORY_IMMUTABLE');
      }
      const ref = candidate.proposedRef;
      if (ref.class === 'cache') fail('Cache memory cannot be promoted into governed memory.', 'SGOS_MEMORY_CLASS_FORBIDDEN');
      if (ref.authorityStoreId !== store.storeId) fail('Memory candidate targets another Authority Store.', 'SGOS_MEMORY_AUTHORITY_MISMATCH');
      if (ref.dependencies.some((dependency) => dependency.memoryId === ref.memoryId)) {
        fail('Memory cannot depend on another version of itself.', 'SGOS_MEMORY_DEPENDENCY_INVALID');
      }
      for (const dependency of ref.dependencies) {
        const dependencyRef = state.entries[versionKey(dependency.memoryId, dependency.version)];
        if (!dependencyRef || dependencyRef.recordSha256 !== dependency.refSha256) {
          fail(`Memory dependency '${dependency.memoryId}:${dependency.version}' is unavailable.`, 'SGOS_MEMORY_DEPENDENCY_INVALID');
        }
        validateRefAgainstState(dependencyRef, state.entries);
      }
      const current = state.entries[currentKey(ref.memoryId)] ?? null;
      const expectedVersion = current ? current.version + 1 : 1;
      if (ref.version !== expectedVersion) {
        fail(`Memory '${ref.memoryId}' must promote as immutable version ${expectedVersion}.`, 'SGOS_MEMORY_VERSION_INVALID');
      }
      if (Object.hasOwn(state.entries, versionKey(ref.memoryId, ref.version))) {
        fail(`Memory version '${ref.memoryId}:${ref.version}' already exists.`, 'SGOS_MEMORY_IMMUTABLE');
      }
      // Validate against the state that the transaction would create, not only the old state.
      // Otherwise A-v2 may depend on B-v1 while B-v1 depends on A-v1: every dependency is valid
      // before the update, but installing A-v2 immediately invalidates B and therefore A-v2.
      const projectedEntries = clonePlatformJson(state.entries);
      projectedEntries[versionKey(ref.memoryId, ref.version)] = ref;
      projectedEntries[currentKey(ref.memoryId)] = ref;
      validateRefAgainstState(ref, projectedEntries);
      const promotion = createMemoryPromotion({
        candidateSha256: candidate.recordSha256,
        memoryRefSha256: ref.recordSha256,
        reviewerId: authorization.actorId,
        decision: 'approved',
        reason,
        promotedAt: new Date().toISOString()
      });
      const after = await store.transact({
        expectedRevision,
        expectedStateSha256,
        actorId: authorization.actorId,
        authorization,
        changes: [
          { op: 'put', key: currentKey(ref.memoryId), value: ref },
          { op: 'put', key: promotionKey(candidateId), value: promotion },
          { op: 'put', key: versionKey(ref.memoryId, ref.version), value: ref }
        ]
      });
      return Object.freeze({ promotion, authorityState: clonePlatformJson(after) });
    },

    async resolve(ref) {
      const state = await store.read();
      return validateRefAgainstState(ref, state.entries);
    },

    async inspect(memoryId) {
      const state = await store.read();
      const current = state.entries[currentKey(memoryId)] ?? null;
      if (!current) return Object.freeze({ available: false, memoryId });
      try {
        const ref = validateRefAgainstState(current, state.entries);
        return Object.freeze({ available: true, valid: true, ref });
      } catch (error) {
        if (!String(error?.code ?? '').startsWith('SGOS_MEMORY_')) throw error;
        return Object.freeze({
          available: true,
          valid: false,
          ref: clonePlatformJson(current),
          error: Object.freeze({ code: error.code, message: error.message })
        });
      }
    }
  });
}
