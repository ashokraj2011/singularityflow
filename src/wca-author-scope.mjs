/** Shared drafts use the approved authority owner, never a checkout or candidate destination. */
import { withApprovedConfigurationRead } from './approved-configuration-reader.mjs';
import { loadEnvironmentDeclaration } from './environment-declaration.mjs';
import { SingularityFlowError } from './util.mjs';

export async function resolveWorkflowAuthorScope(root) {
  return withApprovedConfigurationRead(root, async (authority) => {
    if (!authority || authority.kind === 'working-tree'
        || typeof authority.remote !== 'string' || !authority.remote.trim()
        || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(authority.commit ?? '')) {
      throw new SingularityFlowError(
        'Shared workflow drafts require a freshly verified configuration authority repository.',
        { code: 'WCA_DRAFT_SCOPE_UNAVAILABLE' }
      );
    }
    return {
      root, remote: authority.remote,
      // One repository-wide namespace is shared across machines and VS Code workspaces. Local
      // workspace names/paths are not durable cross-machine authoring identities.
      workspaceId: 'configuration',
      approvedConfiguration: { status: 'verified', kind: authority.kind,
        ref: authority.ref, commit: authority.commit },
      environmentDeclaration: await loadEnvironmentDeclaration(root, { optional: true })
    };
  }, { preferAuthority: true, requireAuthorityRefresh: true, allowLocalHeads: false });
}
