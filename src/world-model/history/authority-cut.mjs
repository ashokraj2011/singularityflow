import { loadDefinition } from '../../config.mjs';
import { configuredRemoteIdentity } from '../../git-remote-diagnostics.mjs';
import { run, SingularityFlowError } from '../../util.mjs';
import { worldModelStateAuthority } from '../authority-config.mjs';

const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const REF = /^refs\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const LOCAL_AUTHORITY_REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;

function offlineGitEnvironment(env = process.env) {
  return {
    ...env,
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never'
  };
}

function safeRef(value) {
  const ref = String(value ?? '').trim();
  return REF.test(ref) && !ref.includes('..') && !ref.includes('//')
    && !ref.endsWith('/') && !ref.endsWith('.lock') && !ref.includes('@{');
}

function fail(message, code, details = {}) {
  throw new SingularityFlowError(message, { code, details });
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
    : configuredRemoteIdentity(root, remote, { direction: 'fetch' });
  if (configured?.ambiguous) {
    fail(
      'The configured World-model state authority has more than one fetch identity.',
      'WMP_AUTHORITY_CUT_REQUIRED',
      { branch, remote, configuredRemotes: configured.urls.length }
    );
  }
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
  const localEnv = offlineGitEnvironment(env);
  const formatted = runCommand('git', ['check-ref-format', authorityRef], {
    cwd: root, allowFailure: true, env: localEnv
  });
  if (formatted.status !== 0) {
    fail(
      'Approved World-model state configuration does not produce a valid Git authority ref.',
      'WMP_AUTHORITY_CUT_REQUIRED',
      { branch, remote }
    );
  }
  const observed = runCommand('git', [
    'rev-parse', '--verify', `${authorityRef}^{commit}`
  ], { cwd: root, allowFailure: true, env: localEnv });
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
