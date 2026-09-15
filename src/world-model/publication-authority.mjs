import { normalizeLedgerConfig } from '../ledger-config.mjs';
import {
  materializeStateBranchPublicationAuthority, stateBranchPublicationTargetIdentity
} from '../ledger.mjs';
import { exactRemoteBranchObservationAsync, refHead } from '../git.mjs';
import { configuredRemoteIdentity } from '../git-remote-diagnostics.mjs';
import { SingularityFlowError } from '../util.mjs';
import { canonicalJson } from './canonicalize.mjs';

const DEFAULT_MESSAGE = '[world-model][wmb-v4] publish registered views';
const COMMIT = /^[a-f0-9]{40,64}$/;
const GUARDED_REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function publicationLedgerConfig(rawConfig) {
  const ledger = normalizeLedgerConfig(rawConfig);
  const fullRef = ledger.branch.startsWith('refs/')
    ? ledger.branch : `refs/heads/${ledger.branch}`;
  const components = fullRef.split('/');
  if (!GUARDED_REF.test(fullRef) || fullRef.includes('..')
      || fullRef.includes('//') || fullRef.endsWith('/') || fullRef.includes('@{')
      || components.some((component) => component.startsWith('.')
        || component.endsWith('.') || component.endsWith('.lock'))) {
    throw new SingularityFlowError(
      'WMB v4 state publication accepts only a branch name or an explicit local refs/heads/... authority.',
      {
        code: 'WMB_GATEWAY_PUBLICATION_AUTHORITY_INVALID',
        details: { branch: ledger.branch }
      }
    );
  }
  // The state writer owns the `refs/heads/` namespace and therefore accepts a branch name. Keep
  // approved local-mode history policy expressive at its read boundary, but never concatenate a
  // full ref into `refs/heads/refs/heads/...` at publication time.
  return Object.freeze({
    ...ledger,
    branch: fullRef.slice('refs/heads/'.length)
  });
}

function commit(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (value === undefined) return undefined;
  const normalized = String(value);
  if (!COMMIT.test(normalized)) {
    throw new SingularityFlowError(`WMB v4 ${label} is invalid.`, {
      code: 'WMB_GATEWAY_PUBLICATION_AUTHORITY_INVALID'
    });
  }
  return normalized;
}

function guardedRemoteRefs(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError('WMB v4 guarded remote refs must be an object.', {
      code: 'WMB_GATEWAY_PUBLICATION_AUTHORITY_INVALID'
    });
  }
  const entries = Object.entries(value);
  if (entries.length > 64) {
    throw new SingularityFlowError('WMB v4 publication contains too many guarded remote refs.', {
      code: 'WMB_GATEWAY_PUBLICATION_AUTHORITY_INVALID'
    });
  }
  const result = {};
  for (const [ref, sha] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (ref.length > 512 || !GUARDED_REF.test(ref) || ref.includes('..')) {
      throw new SingularityFlowError(`WMB v4 guarded remote ref '${ref}' is invalid.`, {
        code: 'WMB_GATEWAY_PUBLICATION_AUTHORITY_INVALID'
      });
    }
    result[ref] = commit(sha, `guarded commit for ${ref}`);
  }
  return Object.freeze(result);
}

function message(value) {
  const normalized = String(value ?? DEFAULT_MESSAGE);
  if (!normalized.trim() || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new SingularityFlowError('WMB v4 publication commit message is invalid.', {
      code: 'WMB_GATEWAY_PUBLICATION_AUTHORITY_INVALID'
    });
  }
  return normalized;
}

function exactOptions(authority, supplied = {}) {
  for (const [field, label] of [
    ['expectedRemoteSha', 'expected remote SHA'], ['baseRef', 'publication base']
  ]) {
    if (Object.hasOwn(supplied, field)) {
      const received = commit(supplied[field], label, { nullable: field === 'expectedRemoteSha' });
      if (received !== authority[field]) {
        throw new SingularityFlowError(
          `WMB v4 publication ${label} does not match the currently observed state authority.`,
          { code: 'WMB_GATEWAY_PUBLICATION_AUTHORITY_OVERRIDE' }
        );
      }
    }
  }
  return Object.freeze({
    message: message(supplied.message),
    ...(Object.hasOwn(authority, 'expectedRemoteSha')
      ? { expectedRemoteSha: authority.expectedRemoteSha } : {}),
    ...(authority.baseRef ? { baseRef: authority.baseRef } : {}),
    refreshRemote: false,
    guardedRemoteRefs: guardedRemoteRefs(supplied.guardedRemoteRefs)
  });
}

function publicEndpoint(endpoint) {
  return Object.freeze({
    remote: endpoint.remote,
    branch: endpoint.branch,
    targetRef: endpoint.targetRef,
    configured: endpoint.configured,
    configuredUrlSha256: endpoint.configuredUrlSha256,
    effectiveUrlSha256: endpoint.effectiveUrlSha256
  });
}

async function observePublicationAuthority(root, ledger, endpoint) {
  const localBase = refHead(root, `refs/heads/${ledger.branch}`) ?? undefined;
  if (!endpoint.configured) return Object.freeze({ baseRef: localBase, refreshRemote: false });
  const observed = await exactRemoteBranchObservationAsync(
    root, endpoint.effectiveUrl, ledger.branch
  );
  if (!observed.reachable) {
    throw new SingularityFlowError(
      `The state publication target '${ledger.remote}/${ledger.branch}' could not be observed.`,
      { code: 'WMB_GATEWAY_PUBLICATION_AUTHORITY_UNAVAILABLE' }
    );
  }
  if (observed.malformed) {
    throw new SingularityFlowError(
      `The state publication target '${ledger.remote}/${ledger.branch}' returned an ambiguous ref advertisement.`,
      { code: 'WMB_GATEWAY_PUBLICATION_AUTHORITY_INVALID' }
    );
  }
  return Object.freeze({
    expectedRemoteSha: observed.sha,
    ...(observed.sha || localBase ? { baseRef: observed.sha ?? localBase } : {}),
    refreshRemote: false
  });
}

/**
 * Capture every byte that can select or authorize the state-branch publication.
 *
 * Runtime-only test seams (`publisher` and `env`) are deliberately absent. They are not authority
 * and cannot change the signed target, CAS base, guarded refs, or commit message.
 */
export async function captureWorldModelPublicationReview(root, {
  outputDir = 'singularity/world-model', ledgerConfig = {}, publicationOptions = {},
  requireHistoryPublicationEndpoint = false,
} = {}) {
  const ledger = Object.freeze(publicationLedgerConfig(ledgerConfig));
  const endpoint = stateBranchPublicationTargetIdentity(root, ledger);
  // Persisted history is read from the configured fetch repository, so a split or rewritten push
  // transport must be refused before `ls-remote` observes it. This check uses local Git config only:
  // no remote probe, credential helper, or transport process has run at this point. Keeping the
  // check beside endpoint resolution also prevents a caller from accidentally restoring the old
  // probe-then-compare ordering.
  if (requireHistoryPublicationEndpoint) {
    assertWorldModelHistoryPublicationEndpoint(root, {
      remote: ledger.remote,
      branch: ledger.branch,
      targetRef: endpoint.targetRef,
      publicationBase: null,
      endpoint: publicEndpoint(endpoint),
      historyObservationAttempted: false
    });
  }
  // Exact planning must remain effect-free. Observe the configured endpoint directly instead of
  // fetching into refs/remotes/* before the person has confirmed the Plan.
  const authority = await observePublicationAuthority(root, ledger, endpoint);
  return Object.freeze({
    target: 'state-branch',
    remote: ledger.remote,
    branch: ledger.branch,
    targetRef: endpoint.targetRef,
    remoteEndpointSha256: endpoint.effectiveUrlSha256,
    expectedRemoteHead: Object.hasOwn(authority, 'expectedRemoteSha')
      ? authority.expectedRemoteSha : null,
    publicationBase: authority.baseRef ?? null,
    outputDir,
    atomic: true,
    ledger,
    endpoint: publicEndpoint(endpoint),
    options: Object.freeze({
      ...exactOptions(authority, publicationOptions),
      remoteEndpointSha256: endpoint.effectiveUrlSha256
    })
  });
}

/** Re-observe and compare the complete signed publication authority. */
export async function assertWorldModelPublicationReview(root, expected, options = {}) {
  const current = await captureWorldModelPublicationReview(root, options);
  if (canonicalJson(current) !== canonicalJson(expected)) {
    throw new SingularityFlowError(
      'The registered world-model publication target or CAS authority changed after confirmation.',
      {
        code: 'WMB_GATEWAY_PLAN_DRIFTED',
        details: {
          expectedEndpointSha256: expected?.endpoint?.effectiveUrlSha256 ?? null,
          currentEndpointSha256: current.endpoint.effectiveUrlSha256,
          expectedRemoteSha: expected?.options?.expectedRemoteSha ?? null,
          currentRemoteSha: current.options.expectedRemoteSha ?? null
        }
      }
    );
  }
  return current;
}

/**
 * Refuse split or rewritten publication transports before the reviewed base is fetched.
 *
 * Persisted history is selected from the configured fetch repository. Its publication must use
 * that same literal repository identity, without an independent pushurl or an ambient
 * insteadOf/pushInsteadOf rewrite. Checking this after materialization is too late: the fetch used
 * to materialize the push endpoint can already have replaced refs/remotes/<remote>/<branch> and
 * thereby changed the history cut which is supposed to authorize the comparison.
 */
export function assertWorldModelHistoryPublicationEndpoint(root, review) {
  const history = configuredRemoteIdentity(root, review.remote, { direction: 'fetch' });
  const historyRepositoryIdentitySha256 = history.fingerprint
    ? `sha256:${history.fingerprint}` : null;
  const publicationConfiguredRepositoryIdentitySha256 =
    review.endpoint?.configuredUrlSha256 ?? null;
  const publicationEffectiveRepositoryIdentitySha256 =
    review.endpoint?.effectiveUrlSha256 ?? null;
  const mismatch = review.endpoint?.configured
    ? history.ambiguous || !history.configured || historyRepositoryIdentitySha256 === null
      || historyRepositoryIdentitySha256 !== publicationConfiguredRepositoryIdentitySha256
      || historyRepositoryIdentitySha256 !== publicationEffectiveRepositoryIdentitySha256
    : history.configured || history.ambiguous
      || historyRepositoryIdentitySha256 !== null
      || publicationConfiguredRepositoryIdentitySha256 !== null
      || publicationEffectiveRepositoryIdentitySha256 !== null;
  if (!mismatch) return review;

  const historyRef = review.endpoint?.configured
    ? `refs/remotes/${review.remote}/${review.branch}` : review.targetRef;
  throw new SingularityFlowError(
    'Persisted World-model history authority does not equal the reviewed state publication authority.',
    {
      code: 'WMP_HISTORY_PUBLICATION_AUTHORITY_MISMATCH',
      details: {
        expectedRef: historyRef,
        receivedRef: historyRef,
        expectedCommit: review.publicationBase ?? null,
        receivedCommit: refHead(root, historyRef) ?? null,
        historyRepositoryIdentitySha256,
        publicationConfiguredRepositoryIdentitySha256,
        publicationEffectiveRepositoryIdentitySha256,
        historyObservationAttempted: review.historyObservationAttempted !== false
      }
    }
  );
}

/** Fetch the reviewed base only after confirmation, preserving every signed CAS field. */
export async function materializeWorldModelPublicationReview(root, review, {
  publicationOptions = {}, requireHistoryPublicationEndpoint = false
} = {}) {
  await assertWorldModelPublicationReview(root, review, {
    outputDir: review.outputDir,
    ledgerConfig: review.ledger,
    publicationOptions,
    requireHistoryPublicationEndpoint
  });
  const endpoint = stateBranchPublicationTargetIdentity(root, review.ledger);
  if (endpoint.effectiveUrlSha256 !== review.remoteEndpointSha256) {
    throw new SingularityFlowError(
      'The registered world-model publication endpoint changed before its base was materialized.',
      { code: 'WMB_GATEWAY_PLAN_DRIFTED' }
    );
  }
  const materialized = await materializeStateBranchPublicationAuthority(root, review.ledger, {
    expectedRemoteSha: Object.hasOwn(review.options, 'expectedRemoteSha')
      ? review.options.expectedRemoteSha : undefined,
    env: publicationOptions.env,
    transportRemote: endpoint.effectiveUrl ?? undefined
  });
  if ((materialized.baseRef ?? null) !== (review.options.baseRef ?? null)) {
    throw new SingularityFlowError(
      'The reviewed state publication base changed while it was materialized.',
      { code: 'WMB_GATEWAY_PLAN_DRIFTED' }
    );
  }
  return assertWorldModelPublicationReview(root, review, {
    outputDir: review.outputDir,
    ledgerConfig: review.ledger,
    publicationOptions,
    requireHistoryPublicationEndpoint
  });
}

/** Runtime callbacks may vary in tests; every authority-bearing option comes from the review. */
export function publicationRuntimeOptions(root, review, supplied = {}) {
  const endpoint = stateBranchPublicationTargetIdentity(root, review.ledger);
  if (endpoint.effectiveUrlSha256 !== review.remoteEndpointSha256) {
    throw new SingularityFlowError(
      'The registered world-model publication endpoint changed before publication.',
      { code: 'WMB_GATEWAY_PLAN_DRIFTED' }
    );
  }
  return Object.freeze({
    ...review.options,
    ...(endpoint.effectiveUrl ? { transportRemote: endpoint.effectiveUrl } : {}),
    ...(typeof supplied.publisher === 'function' ? { publisher: supplied.publisher } : {}),
    ...(supplied.env && typeof supplied.env === 'object' ? { env: supplied.env } : {})
  });
}
