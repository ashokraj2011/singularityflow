import { loadDefinition } from '../../config.mjs';
import {
  assertCredentialFreeRemote, remoteFingerprint
} from '../../git-remote-diagnostics.mjs';
import { run, SingularityFlowError } from '../../util.mjs';
import { worldModelStateAuthority } from '../authority-config.mjs';
import { runWorldModelHistoryGitRead } from './git-read.mjs';

const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const REF = /^refs\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const LOCAL_AUTHORITY_REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;

function safeRef(value) {
  const ref = String(value ?? '').trim();
  return REF.test(ref) && !ref.includes('..') && !ref.includes('//')
    && !ref.endsWith('/') && !ref.endsWith('.lock') && !ref.includes('@{');
}

function fail(message, code, details = {}) {
  throw new SingularityFlowError(message, { code, details });
}

/**
 * Resolve the exact configured fetch identity for one history authority remote.
 *
 * Git permits more than one `remote.<name>.url`. A remote-tracking ref does not record which
 * of those endpoints supplied it, so admitting that ref would make the Repository Domain
 * attribution ambiguous. Keep this resolver shared by authority selection and public history
 * inspection so both boundaries fail closed before looking at the tracking ref.
 */
export function resolveConfiguredWorldModelHistoryFetchIdentity(root, remote, {
  env = process.env,
  runCommand = run,
  operation = 'remote-identity'
} = {}) {
  const result = runWorldModelHistoryGitRead(root, [
    'config', '--local', '--get-all', `remote.${remote}.url`
  ], { env, runCommand, operation });
  const urls = result.status === 0
    ? String(result.stdout ?? '').split('\n').map((value) => value.trim()).filter(Boolean)
      .map(assertCredentialFreeRemote)
    : [];
  const unique = [...new Set(urls)];
  const url = unique.length === 1 ? unique[0] : null;
  const configured = Object.freeze({
    urls: Object.freeze(urls),
    configured: urls.length > 0,
    ambiguous: unique.length > 1,
    fingerprint: url ? remoteFingerprint(url) : null
  });
  if (configured.ambiguous) {
    fail(
      'The configured World-model state authority has more than one fetch identity.',
      'WMP_AUTHORITY_CUT_REQUIRED',
      { remote, configuredRemotes: configured.urls.length }
    );
  }
  return configured;
}

/**
 * Select the one locally materialized history cut admitted by approved configuration.
 *
 * This operation never contacts a remote. When a remote is configured, only its remote-tracking
 * ref is authority; an unpublished local state branch must not masquerade as shared state. A local
 * state branch is accepted only when approved local-mode policy names an explicit full ref.
 */
export function configuredWorldModelHistoryAuthorityCut(root, definition, {
  env = process.env,
  runCommand = run,
  expectedRepositoryIdentitySha256 = null
} = {}) {
  const { branch, remote } = worldModelStateAuthority(definition ?? {});
  const explicitRef = String(branch).startsWith('refs/');
  if (explicitRef && !LOCAL_AUTHORITY_REF.test(String(branch))) {
    fail(
      'Approved local-mode World-model history authority must name an explicit refs/heads/... ref.',
      'WMP_AUTHORITY_CUT_REQUIRED',
      { branch }
    );
  }
  const configured = explicitRef
    ? null
    : resolveConfiguredWorldModelHistoryFetchIdentity(root, remote, { env, runCommand });
  if (!explicitRef && !configured?.configured) {
    fail(
      'The approved World-model state authority names a remote which is not configured in this checkout.',
      'WMP_AUTHORITY_CUT_REQUIRED',
      {
        branch,
        remote,
        remediation: 'Configure the approved remote, or use an explicit refs/heads/... authority in approved local-mode policy.'
      }
    );
  }
  if (!explicitRef) {
    if (!SHA256.test(String(expectedRepositoryIdentitySha256 ?? ''))) {
      fail(
        'Remote-backed World-model history requires the approved Repository Domain identity.',
        'WMP_STATE_AUTHORITY_IDENTITY_REQUIRED',
        { branch, remote }
      );
    }
    const observedRepositoryIdentitySha256 = configured?.fingerprint
      ? `sha256:${configured.fingerprint}` : null;
    if (observedRepositoryIdentitySha256 !== expectedRepositoryIdentitySha256) {
      fail(
        'The configured World-model state remote does not match the approved Repository Domain.',
        'WMP_STATE_AUTHORITY_IDENTITY_MISMATCH',
        {
          branch,
          remote,
          expectedRepositoryIdentitySha256,
          observedRepositoryIdentitySha256
        }
      );
    }
  }
  const authorityRef = explicitRef
    ? String(branch)
    : `refs/remotes/${remote}/${branch}`;
  if (!safeRef(authorityRef)) {
    fail(
      'Approved World-model state configuration does not produce a safe authority ref.',
      'WMP_AUTHORITY_CUT_REQUIRED',
      { branch, remote }
    );
  }
  const formatted = runWorldModelHistoryGitRead(root, [
    'check-ref-format', authorityRef
  ], { env, runCommand, operation: 'authority-ref-format' });
  if (formatted.status !== 0) {
    fail(
      'Approved World-model state configuration does not produce a valid Git authority ref.',
      'WMP_AUTHORITY_CUT_REQUIRED',
      { branch, remote }
    );
  }
  const observed = runWorldModelHistoryGitRead(root, [
    'rev-parse', '--verify', `${authorityRef}^{commit}`
  ], { env, runCommand, operation: 'authority-cut' });
  const commit = observed.status === 0
    ? String(observed.stdout ?? '').trim().toLowerCase()
    : null;
  if (!COMMIT.test(commit ?? '')) {
    fail(
      'The configured World-model state-authority ref is not available locally. Refresh approved state authority before looking up persisted models.',
      'WMP_AUTHORITY_REFRESH_REQUIRED',
      {
        branch,
        remote,
        authorityRef,
        command: 'singularity-flow wm refresh-authority --format registered-v4'
      }
    );
  }
  return Object.freeze({
    ref: authorityRef,
    commit,
    repositoryIdentitySha256: explicitRef
      ? null
      : `sha256:${configured.fingerprint}`
  });
}

/** Load the current approved (or immutable Story-pinned) definition before selecting its cut. */
export async function resolveConfiguredWorldModelHistoryAuthorityCut(root, options = {}) {
  const definition = await loadDefinition(root);
  return configuredWorldModelHistoryAuthorityCut(root, definition, options);
}
