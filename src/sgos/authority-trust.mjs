/** SGOS-only trust policy for approved configuration references. */
import { withApprovedConfigurationRead } from '../approved-configuration-reader.mjs';
import { SingularityFlowError, run } from '../util.mjs';

const CONFIGURATION_SUFFIX = '/sflow/config';
const STATE_SUFFIX = '/state';

function fail(message, details = null) {
  throw new SingularityFlowError(message, {
    code: 'SGOS_CONFIGURATION_AUTHORITY_UNTRUSTED',
    details
  });
}

function configuredRemotes(root) {
  const result = run('git', ['remote'], { cwd: root, allowFailure: true });
  if (result.status !== 0) {
    fail('SGOS could not verify the repository remote boundary before loading execution authority.', {
      stderr: result.stderr.trim()
    });
  }
  return result.stdout.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean).sort();
}

function canonicalConfigurationRemote(remotes) {
  if (remotes.includes('origin')) return 'origin';
  if (remotes.length === 1) return remotes[0];
  if (remotes.length === 0) return null;
  fail('SGOS requires one canonical configuration remote. Configure an origin remote or remove ambiguous remotes before loading execution authority.', {
    configuredRemotes: remotes
  });
}

function localAuthorityHeads(root) {
  const result = run('git', [
    'for-each-ref', '--format=%(refname)',
    'refs/heads/sflow/config', 'refs/heads/state'
  ], { cwd: root, allowFailure: true });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean).sort();
}

function expectedSuffix(authority) {
  if (authority?.kind === 'approved-configuration-ref') return CONFIGURATION_SUFFIX;
  if (authority?.kind === 'verified-state-mirror') return STATE_SUFFIX;
  return null;
}

/**
 * Classify one already-verified authority ref against the repository's Git trust boundary.
 *
 * Remote-tracking refs are accepted only when their remote is still configured. Local authority
 * heads are an explicit offline profile and are accepted only in repositories with no remotes at
 * all. Consequently, adding a remote can never leave a locally manufactured `sflow/config` head
 * executable; an approved remote-tracking ref (or verified state mirror) must exist instead.
 */
export function assertTrustedSgosConfigurationAuthority(root, authority, { remotes = null } = {}) {
  const names = remotes ?? configuredRemotes(root);
  const selectedRemote = canonicalConfigurationRemote(names);
  const suffix = expectedSuffix(authority);
  const ref = authority?.ref;
  if (suffix == null || typeof ref !== 'string' || !ref.endsWith(suffix)) {
    fail('SGOS configuration authority has an unsupported kind or ref.', {
      kind: authority?.kind ?? null,
      ref: ref ?? null
    });
  }

  if (ref.startsWith('refs/remotes/')) {
    const remote = ref.slice('refs/remotes/'.length, -suffix.length);
    if (!remote || !names.includes(remote) || remote !== selectedRemote) {
      fail('SGOS configuration authority must come from the repository canonical remote.', {
        ref,
        configuredRemotes: names,
        canonicalRemote: selectedRemote
      });
    }
    return Object.freeze({ mode: 'remote-tracking-authority', remote });
  }

  const expectedLocal = `refs/heads${suffix}`;
  if (ref !== expectedLocal) {
    fail('SGOS configuration authority must be a remote-tracking ref or the canonical offline local authority head.', {
      ref
    });
  }
  if (names.length) {
    fail('SGOS refuses a local-only configuration authority when the repository has a configured remote. Fetch and review the remote sflow/config or verified state authority first.', {
      ref,
      configuredRemotes: names
    });
  }
  return Object.freeze({ mode: 'offline-local-head-authority', remote: null });
}

/** Mount only an authority admitted by the SGOS-specific remote/local trust policy. */
export async function withTrustedSgosConfigurationRead(root, fn, {
  refreshAuthority = true,
  requireFreshRemote = refreshAuthority,
  selectPaths = null
} = {}) {
  const remotes = configuredRemotes(root);
  const canonicalRemote = canonicalConfigurationRemote(remotes);
  return withApprovedConfigurationRead(root, async (authority) => {
    if (!authority || authority.kind === 'working-tree') {
      const localHeads = remotes.length ? localAuthorityHeads(root) : [];
      if (localHeads.length) {
        fail('SGOS refuses local-only configuration authority because this repository has a configured remote. Fetch and review the remote sflow/config or verified state authority first.', {
          localAuthorityRefs: localHeads,
          configuredRemotes: remotes
        });
      }
      return fn(authority, null);
    }
    const trust = assertTrustedSgosConfigurationAuthority(root, authority, { remotes });
    return fn(authority, trust);
  }, {
    preferAuthority: true,
    // A local authority head is useful for isolated/offline repositories, but it is never a
    // substitute for a configured repository's remote authority namespace.
    allowLocalHeads: remotes.length === 0,
    refreshAuthority,
    requireAuthorityRefresh: remotes.length > 0 && requireFreshRemote,
    // SGOS has one authority namespace. When the canonical remote is unavailable, the shared
    // reader must not silently authorize a different configured remote.
    canonicalRemote,
    selectPaths
  });
}
