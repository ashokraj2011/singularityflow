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

function publisherMap(trustedPublishers) {
  if (!trustedPublishers || typeof trustedPublishers !== 'object'
      || Array.isArray(trustedPublishers)) {
    fail('Capability Pack authority requires explicit approved publisher trust anchors.',
      'SGOS_CAPABILITY_PACK_UNTRUSTED');
  }
  return new Map(Object.entries(trustedPublishers));
}

function verifyTransportPack(signedPack, publishers) {
  const claimed = validatePlatformRecord(signedPack?.record, 'platform-capability-pack');
  const trustedPublicKeyPem = publishers.get(claimed.publisherKeyId);
  if (!trustedPublicKeyPem) {
    fail(`Capability Pack publisher '${claimed.publisherKeyId}' is not trusted.`,
      'SGOS_CAPABILITY_PACK_UNTRUSTED');
  }
  return verifySignedPlatformRecord(signedPack, {
    trustedPublicKeyPem,
    expectedKeyId: claimed.publisherKeyId,
    expectedKind: 'platform-capability-pack'
  });
}

/**
 * Revalidate the complete Capability Pack graph carried by a portable Authority Store.
 * Historical Packs may remain proposed or superseded, but every record and every current selector
 * must retain its exact signed Pack, review, activation, and nonrevoked status.
 */
export function validateCapabilityPackTransportEntries(entries, trustedPublishers) {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    fail('Transported Authority Store entries are invalid.',
      'SGOS_CAPABILITY_PACK_TRANSPORT_INVALID');
  }
  const publishers = publisherMap(trustedPublishers);
  const packs = new Map();
  const reviews = new Map();
  const revocations = new Map();
  const activations = new Map();
  const selectors = new Map();
  for (const [key, value] of Object.entries(entries)) {
    if (key.startsWith('pack:')) {
      const pack = verifyTransportPack(value, publishers);
      if (key !== packKey(pack.recordSha256)) {
        fail('Capability Pack authority key does not match its signed digest.',
          'SGOS_CAPABILITY_PACK_TAMPERED');
      }
      packs.set(pack.recordSha256, pack);
    } else if (key.startsWith('pack-review:')) {
      const review = validatePlatformRecord(value, 'platform-pack-review');
      if (key !== reviewKey(review.recordSha256)) {
        fail('Capability Pack review key does not match its digest.',
          'SGOS_CAPABILITY_PACK_TAMPERED');
      }
      reviews.set(review.recordSha256, review);
    } else if (key.startsWith('pack-revocation:')) {
      const revocation = validatePlatformRecord(value, 'platform-pack-revocation');
      if (key !== revocationKey(revocation.packSha256)) {
        fail('Capability Pack revocation key does not match its target.',
          'SGOS_CAPABILITY_PACK_TAMPERED');
      }
      revocations.set(revocation.packSha256, revocation);
    } else if (key.startsWith('pack-activation:')) {
      const activation = validatePlatformRecord(value, 'platform-pack-activation');
      if (key !== activationKey(activation.domain)) {
        fail('Capability Pack activation key does not match its domain.',
          'SGOS_CAPABILITY_PACK_TAMPERED');
      }
      activations.set(activation.domain, activation);
    } else if (key.startsWith('pack-active:')) {
      if (!value || typeof value !== 'object' || Array.isArray(value)
          || Object.keys(value).sort().join(',') !== 'domain,packSha256'
          || key !== activeKey(value.domain)
          || !/^sha256:[a-f0-9]{64}$/.test(String(value.packSha256 ?? ''))) {
        fail('Active Capability Pack selector is malformed.',
          'SGOS_CAPABILITY_PACK_TAMPERED');
      }
      selectors.set(value.domain, value);
    } else {
      fail(`Authority transport contains unsupported non-Pack namespace '${key}'.`,
        'SGOS_CAPABILITY_PACK_TRANSPORT_INVALID');
    }
  }
  for (const review of reviews.values()) {
    if (!packs.has(review.packSha256)) {
      fail('Capability Pack review target is missing.',
        'SGOS_CAPABILITY_PACK_REVIEW_REQUIRED');
    }
  }
  for (const revocation of revocations.values()) {
    if (!packs.has(revocation.packSha256)) {
      fail('Capability Pack revocation target is missing.',
        'SGOS_CAPABILITY_PACK_NOT_FOUND');
    }
  }
  const active = [];
  for (const [domain, selector] of selectors) {
    const pack = packs.get(selector.packSha256);
    if (!pack || pack.domain !== domain) {
      fail('Active Capability Pack target is missing or belongs to another domain.',
        'SGOS_CAPABILITY_PACK_NOT_FOUND');
    }
    if (revocations.has(pack.recordSha256)) {
      fail('Active Capability Pack is revoked.', 'SGOS_CAPABILITY_PACK_REVOKED');
    }
    const activation = activations.get(domain);
    const review = activation ? reviews.get(activation.reviewSha256) : null;
    if (!activation || activation.packSha256 !== pack.recordSha256
        || !review || review.packSha256 !== pack.recordSha256
        || review.decision !== 'approved') {
      fail('Active Capability Pack lacks its exact approval and activation authority.',
        'SGOS_CAPABILITY_PACK_ACTIVATION_STALE');
    }
    active.push({
      domain,
      packSha256: pack.recordSha256,
      reviewSha256: review.recordSha256,
      activationSha256: activation.recordSha256
    });
  }
  for (const [domain, activation] of activations) {
    const selector = selectors.get(domain);
    if (!selector || selector.packSha256 !== activation.packSha256) {
      fail('Capability Pack activation has no matching active selector.',
        'SGOS_CAPABILITY_PACK_ACTIVATION_STALE');
    }
  }
  active.sort((left, right) => left.domain.localeCompare(right.domain));
  return Object.freeze({
    total: packs.size,
    active: Object.freeze(active),
    revoked: revocations.size,
    superseded: Math.max(0, packs.size - active.length - revocations.size)
  });
}

function applyTransportChanges(entries, changes) {
  const next = clonePlatformJson(entries);
  for (const change of changes) {
    if (change.op === 'put') next[change.key] = clonePlatformJson(change.value);
    else if (change.op === 'delete') delete next[change.key];
    else fail('Authority transport event contains an unsupported change operation.',
      'SGOS_CAPABILITY_PACK_TRANSPORT_INVALID');
  }
  return next;
}

function exactChange(change, operation, prefix = null) {
  return change?.op === operation && typeof change.key === 'string'
    && (prefix === null || change.key.startsWith(prefix));
}

/**
 * Replay every portable mutation using the exact Pack operation grammar. Approved transport v2
 * explicitly grants its exporter full Store-snapshot attestation authority; this replay proves
 * that the attested bytes still describe a legal Pack history rather than a fabricated final map.
 */
export function validateCapabilityPackTransportLineage(events, finalEntries, trustedPublishers) {
  if (!Array.isArray(events)) {
    fail('Authority transport Pack lineage must be an array.',
      'SGOS_CAPABILITY_PACK_TRANSPORT_INVALID');
  }
  const publishers = publisherMap(trustedPublishers);
  let entries = {};
  for (const event of events) {
    const authorization = validatePlatformRecord(
      event.authorization, 'platform-mutation-authorization'
    );
    if (event.actorId !== authorization.actorId) {
      fail('Authority transport event actor does not equal its approved authorization.',
        'SGOS_CAPABILITY_PACK_TRANSPORT_INVALID');
    }
    const changes = event.changes;
    if (authorization.operation === 'pack.propose') {
      if (changes.length !== 1 || !exactChange(changes[0], 'put', 'pack:')) {
        fail('Pack proposal transport event must contain exactly one Pack put.',
          'SGOS_CAPABILITY_PACK_TRANSPORT_INVALID');
      }
      const pack = verifyTransportPack(changes[0].value, publishers);
      if (changes[0].key !== packKey(pack.recordSha256) || entries[changes[0].key]) {
        fail('Pack proposal transport event does not create one new exact signed Pack.',
          'SGOS_CAPABILITY_PACK_TAMPERED');
      }
    } else if (authorization.operation === 'pack.review') {
      if (changes.length !== 1 || !exactChange(changes[0], 'put', 'pack-review:')) {
        fail('Pack review transport event must contain exactly one review put.',
          'SGOS_CAPABILITY_PACK_TRANSPORT_INVALID');
      }
      const review = validatePlatformRecord(changes[0].value, 'platform-pack-review');
      if (changes[0].key !== reviewKey(review.recordSha256)
          || review.reviewerId !== event.actorId || entries[changes[0].key]
          || !entries[packKey(review.packSha256)]) {
        fail('Pack review transport event lacks its exact Pack or authorized reviewer.',
          'SGOS_CAPABILITY_PACK_REVIEW_REQUIRED');
      }
    } else if (authorization.operation === 'pack.activate') {
      if (changes.length !== 2 || changes.some((change) => change.op !== 'put')) {
        fail('Pack activation transport event must contain exactly activation and selector puts.',
          'SGOS_CAPABILITY_PACK_TRANSPORT_INVALID');
      }
      const activationChange = changes.find((change) => change.key.startsWith('pack-activation:'));
      const selectorChange = changes.find((change) => change.key.startsWith('pack-active:'));
      if (!activationChange || !selectorChange) {
        fail('Pack activation transport event is missing its activation or selector.',
          'SGOS_CAPABILITY_PACK_ACTIVATION_STALE');
      }
      const activation = validatePlatformRecord(
        activationChange.value, 'platform-pack-activation'
      );
      const selector = selectorChange.value;
      const signedPack = entries[packKey(activation.packSha256)];
      const pack = signedPack ? verifyTransportPack(signedPack, publishers) : null;
      const review = entries[reviewKey(activation.reviewSha256)];
      if (activationChange.key !== activationKey(activation.domain)
          || selectorChange.key !== activeKey(activation.domain)
          || activation.activatedBy !== event.actorId
          || !selector || Object.keys(selector).sort().join(',') !== 'domain,packSha256'
          || selector.domain !== activation.domain
          || selector.packSha256 !== activation.packSha256
          || !pack || pack.domain !== activation.domain
          || entries[revocationKey(activation.packSha256)]
          || !review || validatePlatformRecord(review, 'platform-pack-review').decision !== 'approved'
          || review.packSha256 !== activation.packSha256) {
        fail('Pack activation transport event lacks its exact Pack, review, actor, or selector.',
          'SGOS_CAPABILITY_PACK_ACTIVATION_STALE');
      }
    } else if (authorization.operation === 'pack.revoke') {
      const revocationChange = changes.find((change) =>
        exactChange(change, 'put', 'pack-revocation:'));
      if (!revocationChange
          || changes.filter((change) => change.op === 'put').length !== 1) {
        fail('Pack revocation transport event must contain exactly one revocation put.',
          'SGOS_CAPABILITY_PACK_TRANSPORT_INVALID');
      }
      const revocation = validatePlatformRecord(
        revocationChange.value, 'platform-pack-revocation'
      );
      const signedPack = entries[packKey(revocation.packSha256)];
      const pack = signedPack ? verifyTransportPack(signedPack, publishers) : null;
      if (!pack || revocation.revokedBy !== event.actorId
          || revocationChange.key !== revocationKey(revocation.packSha256)
          || entries[revocationChange.key]) {
        fail('Pack revocation transport event lacks its exact Pack or authorized actor.',
          'SGOS_CAPABILITY_PACK_REVOKED');
      }
      const expectedDeletes = [];
      if (entries[activeKey(pack.domain)]?.packSha256 === revocation.packSha256) {
        expectedDeletes.push(activeKey(pack.domain));
        if (entries[activationKey(pack.domain)]) expectedDeletes.push(activationKey(pack.domain));
      }
      const observedDeletes = changes.filter((change) => change.op === 'delete')
        .map((change) => change.key).sort();
      if (observedDeletes.join('\0') !== expectedDeletes.sort().join('\0')
          || changes.some((change) => !['put', 'delete'].includes(change.op))) {
        fail('Pack revocation transport event changes authority outside its exact revocation scope.',
          'SGOS_CAPABILITY_PACK_TRANSPORT_INVALID');
      }
    } else {
      fail(`Authority transport event operation '${authorization.operation}' is not portable.`,
        'SGOS_CAPABILITY_PACK_TRANSPORT_INVALID');
    }
    entries = applyTransportChanges(entries, changes);
  }
  if (platformSha256(entries) !== platformSha256(finalEntries)) {
    fail('Authority transport Pack lineage does not reconstruct its final entries.',
      'SGOS_CAPABILITY_PACK_TRANSPORT_INVALID');
  }
  return validateCapabilityPackTransportEntries(entries, trustedPublishers);
}

/**
 * Refuse a rollback that would reactivate authority revoked or superseded by the imported head.
 *
 * Final entry maps are deliberately insufficient here. Revoking the Pack which superseded an
 * older selection removes its active selector and activation record, but it does not erase that
 * immutable activation from Authority Store history. Both exact lineages are therefore mandatory.
 */
export function validateCapabilityPackTransportRollback(
  rollbackEntries, currentEntries, rollbackEvents, currentEvents, trustedPublishers
) {
  if (!Array.isArray(rollbackEvents) || !Array.isArray(currentEvents)) {
    fail('Authority rollback requires both exact Capability Pack event lineages.',
      'SGOS_CAPABILITY_PACK_TRANSPORT_INVALID');
  }
  const rollback = validateCapabilityPackTransportLineage(
    rollbackEvents, rollbackEntries, trustedPublishers
  );
  validateCapabilityPackTransportLineage(currentEvents, currentEntries, trustedPublishers);
  if (rollbackEvents.length > currentEvents.length) {
    fail('Authority rollback lineage is not a prefix of the current Capability Pack lineage.',
      'SGOS_CAPABILITY_PACK_TRANSPORT_INVALID');
  }
  for (let index = 0; index < rollbackEvents.length; index += 1) {
    if (rollbackEvents[index].recordSha256 !== currentEvents[index].recordSha256) {
      fail('Authority rollback lineage diverges from the current Capability Pack lineage.',
        'SGOS_CAPABILITY_PACK_TRANSPORT_INVALID');
    }
  }
  const laterActivations = currentEvents.slice(rollbackEvents.length)
    .filter((event) => event.authorization.operation === 'pack.activate')
    .map((event) => validatePlatformRecord(
      event.changes.find((change) => change.key.startsWith('pack-activation:')).value,
      'platform-pack-activation'
    ));
  for (const selection of rollback.active) {
    if (currentEntries[revocationKey(selection.packSha256)]) {
      fail('Authority rollback would reactivate a revoked Capability Pack.',
        'SGOS_CAPABILITY_PACK_REVOKED');
    }
    if (laterActivations.some((activation) => activation.domain === selection.domain
        && activation.packSha256 !== selection.packSha256)) {
      fail('Authority rollback would reactivate a Capability Pack superseded later in history.',
        'SGOS_CAPABILITY_PACK_SUPERSEDED');
    }
    const current = currentEntries[activeKey(selection.domain)];
    if (current && current.packSha256 !== selection.packSha256) {
      fail('Authority rollback would replace a newer active Capability Pack selection.',
        'SGOS_CAPABILITY_PACK_SUPERSEDED');
    }
  }
  return rollback;
}

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
  const publishers = publisherMap(trustedPublishers);

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
    async resolveActiveSelection(domain, expectedPackSha256, { minimumAuthority = null } = {}) {
      if (minimumAuthority !== null && typeof store.readAtMinimum !== 'function') {
        fail('Capability Pack resolution requires an Authority Store that can verify the approved minimum checkpoint.',
          'SGOS_AUTHORITY_PROFILE_UNSUPPORTED');
      }
      // The selected Pack and the anti-rollback decision come from one verified snapshot. Keeping
      // this as one Store read prevents a concurrent cutover from separating the check from use.
      const state = minimumAuthority === null
        ? await store.read()
        : await store.readAtMinimum(minimumAuthority);
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
        active.push(readActiveSelection(
          state.entries, selection.domain, selection.packSha256
        ).pack);
      }
      active.sort((left, right) => left.domain < right.domain ? -1 : left.domain > right.domain ? 1 : 0);
      return Object.freeze(active);
    }
  });
}
