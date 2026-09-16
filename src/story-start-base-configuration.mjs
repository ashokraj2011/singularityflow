import { loadDefinition, WORKFLOW_PATH } from './config.mjs';
import { withRepositoryConfigurationCommitRead } from './approved-configuration-reader.mjs';
import { resolveLifecycleCapability } from './capability-context.mjs';
import { loadPortfolio } from './initiative-config.mjs';
import { SingularityFlowError } from './util.mjs';

async function selectedBaseCapabilityEvidence(root, capabilityId) {
  if (!capabilityId) return null;
  const capability = await resolveLifecycleCapability(root, {
    capabilityId,
    required: true,
    offline: true
  });
  const mapSha256 = capability?.map?.sha256 ?? null;
  if (!mapSha256) {
    throw new SingularityFlowError(
      `Selected base does not bind capability '${capabilityId}' to an exact capability map.`,
      { code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID' }
    );
  }
  return Object.freeze({
    capability,
    mapSha256,
    portfolio: await loadPortfolio(root, { required: false })
  });
}

/**
 * Load and fully validate the configuration carried by the exact selected application base.
 *
 * Shared sflow/config remains higher authority. This helper is only the fail-closed compatibility
 * path used when no approved snapshot exists. It reads workflow, agents, templates, portfolio and
 * referenced prompts from one frozen commit without checking it out or changing application files.
 */
export async function loadLegacyStoryBaseContext(root, {
  remote = 'origin', baseBranch, baseCommit, capabilityId = null
} = {}) {
  const ref = `refs/remotes/${remote}/${baseBranch}`;
  try {
    return await withRepositoryConfigurationCommitRead(root, {
      commit: baseCommit,
      ref
    }, async () => {
      const definition = await loadDefinition(root);
      const configuredRemote = definition.git?.remote ?? 'origin';
      if (configuredRemote !== remote) {
        throw new SingularityFlowError(
          `Selected base '${baseBranch}' configures Story remote '${configuredRemote}', but intake selected it from '${remote}'. Refresh intake from the selected base and retry; nothing was changed.`,
          {
            code: 'STORY_BASE_CONFIGURATION_MISMATCH',
            details: { baseBranch, baseCommit, selectedRemote: remote, configuredRemote }
          }
        );
      }
      return Object.freeze({
        definition,
        capabilityEvidence: await selectedBaseCapabilityEvidence(root, capabilityId)
      });
    });
  } catch (error) {
    if (error?.code === 'APPROVED_CONFIGURATION_INCOMPLETE'
        && String(error.message).includes(WORKFLOW_PATH)) {
      throw new SingularityFlowError(
        `Selected base branch '${baseBranch}' does not contain ${WORKFLOW_PATH}, and no approved configuration authority is available. Nothing was changed.`,
        {
          code: 'STORY_CONFIGURATION_AUTHORITY_MISSING',
          details: { baseBranch, baseCommit, remote }
        }
      );
    }
    throw error;
  }
}

export async function loadLegacyStoryBaseDefinition(root, options = {}) {
  return (await loadLegacyStoryBaseContext(root, options)).definition;
}

/** Load policy carried by an already-materialized Epic Story seed branch at one exact tip. */
export async function loadLegacyMaterializedStoryDefinition(root, {
  remote = 'origin', storyBranch, seedCommit
} = {}) {
  const ref = `refs/remotes/${remote}/${storyBranch}`;
  try {
    return await withRepositoryConfigurationCommitRead(root, {
      commit: seedCommit,
      ref
    }, async () => {
      const definition = await loadDefinition(root);
      const configuredRemote = definition.git?.remote ?? 'origin';
      if (configuredRemote !== remote) {
        throw new SingularityFlowError(
          `Materialized Story branch '${storyBranch}' configures Story remote '${configuredRemote}', but intake found it on '${remote}'. Refresh the Story seed and retry; nothing was changed.`,
          {
            code: 'STORY_SEED_CONFIGURATION_MISMATCH',
            details: { storyBranch, seedCommit, selectedRemote: remote, configuredRemote }
          }
        );
      }
      return definition;
    });
  } catch (error) {
    if (error?.code === 'APPROVED_CONFIGURATION_INCOMPLETE'
        && String(error.message).includes(WORKFLOW_PATH)) {
      throw new SingularityFlowError(
        `Materialized Story branch '${storyBranch}' does not contain ${WORKFLOW_PATH}, and no approved configuration authority is available. Nothing was changed.`,
        {
          code: 'STORY_CONFIGURATION_AUTHORITY_MISSING',
          details: { storyBranch, seedCommit, remote }
        }
      );
    }
    throw error;
  }
}
