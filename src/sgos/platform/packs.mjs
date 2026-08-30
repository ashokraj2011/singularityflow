import { SingularityFlowError } from '../../util.mjs';
import {
  clonePlatformJson, createPackActivation, createPackRevocation, platformSha256,
  validatePlatformRecord
} from './contracts.mjs';
import { assertAuthorityStoreAdapter } from './authority-store.mjs';
import { loadApprovedPlatformMutationAuthority } from './authority.mjs';
import { verifySignedPlatformRecord } from './signatures.mjs';

function fail(message, code = 'SGOS_CAPABILITY_PACK_INVALID') {
  throw new SingularityFlowError(message, { code });
}

const keyDigest = (value) => platformSha256(value).slice(7);
const packKey = (sha256) => `pack:${keyDigest(sha256)}`;
const reviewKey = (sha256) => `pack-review:${keyDigest(sha256)}`;
const revocationKey = (sha256) => `pack-revocation:${keyDigest(sha256)}`;
const activeKey = (domain) => `pack-active:${keyDigest(domain)}`;
const activationKey = (domain) => `pack-activation:${keyDigest(domain)}`;

function requireCas(expectedRevision, expectedStateSha256) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0
      || !/^sha256:[a-f0-9]{64}$/.test(String(expectedStateSha256 ?? ''))) {
    fail('Capability Pack mutation requires an exact Authority Store revision and state digest.', 'SGOS_CAPABILITY_PACK_CAS_REQUIRED');
  }
}

export function createCapabilityPackRegistry({ authorityStore, trustedPublishers, repositoryRoot }) {
  const store = assertAuthorityStoreAdapter(authorityStore);
  if (!trustedPublishers || typeof trustedPublishers !== 'object' || Array.isArray(trustedPublishers)) {
    fail('Capability Pack registry requires explicit publisher trust anchors.', 'SGOS_CAPABILITY_PACK_UNTRUSTED');
  }
  const publishers = new Map(Object.entries(trustedPublishers));

  function verifyPack(signedPack) {
    const claimed = validatePlatformRecord(signedPack?.record, 'platform-capability-pack');
    const trustedPublicKeyPem = publishers.get(claimed.publisherKeyId);
    if (!trustedPublicKeyPem) {
      fail(`Capability Pack publisher '${claimed.publisherKeyId}' is not trusted.`, 'SGOS_CAPABILITY_PACK_UNTRUSTED');
    }
    return verifySignedPlatformRecord(signedPack, {
      trustedPublicKeyPem,
      expectedKeyId: claimed.publisherKeyId,
      expectedKind: 'platform-capability-pack'
    });
  }

  function readPack(entries, packSha256) {
    const signed = entries[packKey(packSha256)];
    if (!signed) fail(`Capability Pack '${packSha256}' is unavailable.`, 'SGOS_CAPABILITY_PACK_NOT_FOUND');
    const pack = verifyPack(signed);
    if (pack.recordSha256 !== packSha256) fail('Capability Pack authority key does not match its digest.', 'SGOS_CAPABILITY_PACK_TAMPERED');
    if (entries[revocationKey(packSha256)]) fail(`Capability Pack '${packSha256}' is revoked.`, 'SGOS_CAPABILITY_PACK_REVOKED');
    return { signed, pack };
  }

  function readActiveSelection(entries, domain, expectedPackSha256, {
    mismatchCode = 'SGOS_CAPABILITY_PACK_SUPERSEDED',
    revokedCode = 'SGOS_CAPABILITY_PACK_REVOKED'
  } = {}) {
    const selection = entries[activeKey(domain)];
    if (!selection) {
      if (entries[revocationKey(expectedPackSha256)]) {
        fail(`Capability Pack '${expectedPackSha256}' is revoked.`, revokedCode);
      }
      fail(`No active Capability Pack exists for '${domain}'.`, 'SGOS_CAPABILITY_PACK_NOT_ACTIVE');
    }
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)
        || Object.keys(selection).sort().join(',') !== 'domain,packSha256'
        || selection.domain !== domain) {
      fail('Active Capability Pack selection is malformed.', 'SGOS_CAPABILITY_PACK_TAMPERED');
    }
    if (selection.packSha256 !== expectedPackSha256) {
      fail('The requested Capability Pack was superseded by another active selection.',
        mismatchCode);
    }
    const { signed, pack } = readPack(entries, expectedPackSha256);
    const activation = entries[activationKey(domain)];
    if (!activation) {
      fail('Active Capability Pack has no activation authority.', 'SGOS_CAPABILITY_PACK_ACTIVATION_STALE');
    }
    validatePlatformRecord(activation, 'platform-pack-activation');
    if (activation.domain !== domain || activation.packSha256 !== expectedPackSha256) {
      fail('Active Capability Pack activation does not bind the selected Pack.',
        'SGOS_CAPABILITY_PACK_ACTIVATION_STALE');
    }
    const review = entries[reviewKey(activation.reviewSha256)];
    if (!review) {
      fail('Active Capability Pack approval is unavailable.', 'SGOS_CAPABILITY_PACK_REVIEW_REQUIRED');
    }
    validatePlatformRecord(review, 'platform-pack-review');
    if (review.recordSha256 !== activation.reviewSha256
        || review.packSha256 !== expectedPackSha256 || review.decision !== 'approved') {
      fail('Active Capability Pack does not retain its exact approving review.',
        'SGOS_CAPABILITY_PACK_REVIEW_REQUIRED');
    }
    return { signed, pack, review, activation };
  }

  return Object.freeze({
    profile: 'signed-declarative-local-v1',

    async propose(signedPack, { expectedRevision, expectedStateSha256 }) {
      requireCas(expectedRevision, expectedStateSha256);
      const authorization = await loadApprovedPlatformMutationAuthority(
        repositoryRoot, 'pack.propose'
      );
      const pack = verifyPack(signedPack);
      const state = await store.read();
      if (state.revision !== expectedRevision || state.recordSha256 !== expectedStateSha256) {
        fail('Capability Pack proposal lost its compare-and-swap race.', 'SGOS_CAPABILITY_PACK_CAS_MISMATCH');
      }
      if (state.entries[packKey(pack.recordSha256)]) fail('Capability Pack is already proposed.', 'SGOS_CAPABILITY_PACK_IMMUTABLE');
      await store.transact({
        expectedRevision,
        expectedStateSha256,
        actorId: authorization.actorId,
        authorization,
        changes: [{ op: 'put', key: packKey(pack.recordSha256), value: clonePlatformJson(signedPack) }]
      });
      return pack;
    },

    async recordReview(review, { expectedRevision, expectedStateSha256 }) {
      requireCas(expectedRevision, expectedStateSha256);
      const authorization = await loadApprovedPlatformMutationAuthority(
        repositoryRoot, 'pack.review'
      );
      const validated = validatePlatformRecord(review, 'platform-pack-review');
      if (validated.reviewerId !== authorization.actorId) {
        fail('Capability Pack review identity does not match the repository Git identity authorized by approved configuration.',
          'SGOS_CAPABILITY_PACK_REVIEWER_MISMATCH');
      }
      const state = await store.read();
      if (state.revision !== expectedRevision || state.recordSha256 !== expectedStateSha256) {
        fail('Capability Pack review lost its compare-and-swap race.', 'SGOS_CAPABILITY_PACK_CAS_MISMATCH');
      }
      readPack(state.entries, validated.packSha256);
      if (state.entries[reviewKey(validated.recordSha256)]) fail('Capability Pack review is already recorded.', 'SGOS_CAPABILITY_PACK_IMMUTABLE');
      await store.transact({
        expectedRevision,
        expectedStateSha256,
        actorId: authorization.actorId,
        authorization,
        changes: [{ op: 'put', key: reviewKey(validated.recordSha256), value: validated }]
      });
      return validated;
    },

    async activate({
      domain,
      packSha256,
      reviewSha256,
      confirmPackSha256,
      expectedRevision,
      expectedStateSha256
    }) {
      requireCas(expectedRevision, expectedStateSha256);
      const authorization = await loadApprovedPlatformMutationAuthority(
        repositoryRoot, 'pack.activate'
      );
      if (confirmPackSha256 !== packSha256) fail('Capability Pack activation confirmation is stale.', 'SGOS_CAPABILITY_PACK_CONFIRMATION_MISMATCH');
      const state = await store.read();
      if (state.revision !== expectedRevision || state.recordSha256 !== expectedStateSha256) {
        fail('Capability Pack activation lost its compare-and-swap race.', 'SGOS_CAPABILITY_PACK_CAS_MISMATCH');
      }
      const { pack } = readPack(state.entries, packSha256);
      if (pack.domain !== domain) fail('Capability Pack domain does not match activation domain.', 'SGOS_CAPABILITY_PACK_DOMAIN_MISMATCH');
      const review = state.entries[reviewKey(reviewSha256)];
      if (!review) fail('Capability Pack activation requires a recorded review.', 'SGOS_CAPABILITY_PACK_REVIEW_REQUIRED');
      validatePlatformRecord(review, 'platform-pack-review');
      if (review.packSha256 !== packSha256 || review.decision !== 'approved') {
        fail('Capability Pack does not have an exact approving review.', 'SGOS_CAPABILITY_PACK_REVIEW_REQUIRED');
      }
      const activation = createPackActivation({
        domain,
        packSha256,
        reviewSha256,
        activatedBy: authorization.actorId,
        activatedAt: new Date().toISOString()
      });
      await store.transact({
        expectedRevision,
        expectedStateSha256,
        actorId: authorization.actorId,
        authorization,
        changes: [
          { op: 'put', key: activationKey(domain), value: activation },
          { op: 'put', key: activeKey(domain), value: { domain, packSha256 } }
        ]
      });
      return activation;
    },

    async revoke({
      packSha256,
      reason,
      expectedRevision,
      expectedStateSha256
    }) {
      requireCas(expectedRevision, expectedStateSha256);
      const authorization = await loadApprovedPlatformMutationAuthority(
        repositoryRoot, 'pack.revoke'
      );
      const state = await store.read();
      if (state.revision !== expectedRevision || state.recordSha256 !== expectedStateSha256) {
        fail('Capability Pack revocation lost its compare-and-swap race.', 'SGOS_CAPABILITY_PACK_CAS_MISMATCH');
      }
      const { pack } = readPack(state.entries, packSha256);
      const revocation = createPackRevocation({
        packSha256,
        revokedBy: authorization.actorId,
        reason,
        revokedAt: new Date().toISOString()
      });
      const changes = [{ op: 'put', key: revocationKey(packSha256), value: revocation }];
      const active = state.entries[activeKey(pack.domain)];
      if (active?.packSha256 === packSha256) {
        changes.push({ op: 'delete', key: activeKey(pack.domain) });
        if (state.entries[activationKey(pack.domain)]) changes.push({ op: 'delete', key: activationKey(pack.domain) });
      }
      await store.transact({
        expectedRevision,
        expectedStateSha256,
        actorId: authorization.actorId,
        authorization,
        changes
      });
      return revocation;
    },

    async resolveActive(domain, expectedPackSha256) {
      const state = await store.read();
      return readActiveSelection(state.entries, domain, expectedPackSha256, {
        mismatchCode: 'SGOS_CAPABILITY_PACK_SELECTION_MISMATCH',
        revokedCode: 'SGOS_CAPABILITY_PACK_NOT_ACTIVE'
      }).pack;
    },

    /**
     * Return the exact immutable review/activation lineage used by compiler and runtime admission.
     * The caller still decides whether its trust anchors came from approved configuration; this
     * registry only proves those anchors against the Authority Store's verified event lineage.
     */
    async resolveActiveSelection(domain, expectedPackSha256) {
      const state = await store.read();
      const resolved = readActiveSelection(state.entries, domain, expectedPackSha256);
      return Object.freeze({
        profile: 'signed-declarative-local-v1',
        authorityStoreId: store.storeId,
        authorityStateSha256: state.recordSha256,
        signedPack: clonePlatformJson(resolved.signed),
        pack: clonePlatformJson(resolved.pack),
        review: clonePlatformJson(resolved.review),
        activation: clonePlatformJson(resolved.activation)
      });
    },

    async listActive() {
      const state = await store.read();
      const active = [];
      for (const [key, selection] of Object.entries(state.entries)) {
        if (!key.startsWith('pack-active:')) continue;
        active.push(readPack(state.entries, selection.packSha256).pack);
      }
      active.sort((left, right) => left.domain < right.domain ? -1 : left.domain > right.domain ? 1 : 0);
      return Object.freeze(active);
    }
  });
}
