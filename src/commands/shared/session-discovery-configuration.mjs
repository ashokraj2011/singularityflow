/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { sessionRepositoryAuthority } from './session-repository-authority.mjs';
import { configurationReadAuthority } from '../../configuration-read-scope.mjs';
import { loadConfig } from '../../state-stores.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { CONFIGURATION_BRANCH } from '../../configuration-branch.mjs';
import { refExists, fetchRemote, localBranches, branch } from '../../git.mjs';
import { definitionAtRef } from './definition-at-ref.mjs';
import { WORKFLOW_PATH } from '../../config.mjs';

export async function sessionDiscoveryConfiguration(root, authority = null, { storyBootstrap = false } = {}) {
  authority ??= await sessionRepositoryAuthority(root);
  if (configurationReadAuthority(root)) {
    const definition = await loadConfig(root, { storyBootstrap });
    return {
      definition,
      remote: definition.git?.remote ?? 'origin',
      source: 'approved-configuration-overlay'
    };
  }
  if (authority?.source === 'working-tree') {
    const definition = await loadConfig(root, { storyBootstrap });
    return { definition, remote: definition.git?.remote ?? 'origin', source: 'working-tree' };
  }
  if (!authority?.remote) {
    throw new SingularityFlowError(
      `Repository '${root}' has no working-tree definition and no published ${CONFIGURATION_BRANCH} authority.`,
      { code: 'SESSION_REPOSITORY_NOT_GOVERNED' }
    );
  }
  const approvedRef = `${authority.remote}/${CONFIGURATION_BRANCH}`;
  if (refExists(root, `refs/remotes/${approvedRef}`)) {
    const definition = definitionAtRef(root, approvedRef);
    if (!definition) {
      throw new SingularityFlowError(
        `Approved ${CONFIGURATION_BRANCH} is missing ${WORKFLOW_PATH}; refresh or repair its review proposal.`,
        { code: 'SESSION_CONFIGURATION_UNAVAILABLE' }
      );
    }
    return { definition, remote: definition.git?.remote ?? authority.remote, source: approvedRef };
  }
  if (authority.source === 'configuration-remote') {
    await fetchRemote(root, authority.remote, { respectPartialClone: true });
    const definition = definitionAtRef(root, approvedRef);
    if (!definition) {
      throw new SingularityFlowError(
        `Approved ${CONFIGURATION_BRANCH} is missing ${WORKFLOW_PATH}; refresh or repair its review proposal.`,
        { code: 'SESSION_CONFIGURATION_UNAVAILABLE' }
      );
    }
    return { definition, remote: definition.git?.remote ?? authority.remote, source: approvedRef };
  }
  // Legacy branch-local workflows remain readable only when no approved configuration was found.
  // They must not replace a known, malformed sflow/config with an unrelated lifecycle definition.
  const legacyCandidates = [authority.ref, ...localBranches(root), branch(root)].filter(Boolean);
  for (const ref of [...new Set(legacyCandidates)]) {
    try {
      const definition = definitionAtRef(root, ref);
      if (definition) return { definition, remote: authority.remote, source: ref };
    } catch { /* Try another legacy lifecycle ref; attachment validates the selected Story strictly. */ }
  }
  throw new SingularityFlowError(
    `Remote '${authority.remote}' has no readable governed definition on ${CONFIGURATION_BRANCH} or a lifecycle branch.`,
    { code: 'SESSION_CONFIGURATION_UNAVAILABLE' }
  );
}
