/** A delivery capability's declared application, read the way lifecycle capability resolution reads the map. */
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  capabilityRepositories, IMPLICIT_CAPABILITY_ID, normalizeCapabilityApplication, resolveCapabilityOwner, resolveCapabilityPolicy
} from './capabilities.mjs';
import { readRetainedCapabilityMap, soleDelivery, sourceForRepository } from './capability-context.mjs';
import { CONFIGURATION_SOURCE_PATH } from './configuration-branch.mjs';
import { configurationReadRoot } from './configuration-read-scope.mjs';
import { typedApplication } from './run-configurations.mjs';
import { SingularityFlowError } from './util.mjs';

/**
 * One delivery capability's declared application (start entries and tests), for `app` and `tests`.
 *
 * The map is selected exactly as resolveLifecycleCapability selects it (the pinned or approved
 * overlay, else the active workspace's lead repository), from one retained byte buffer. Leases and
 * provenance are not read: these commands start local processes and pin nothing. Without a map the
 * implicit repository-root capability has no start entries and runs what the code step runs.
 *
 * Each start entry is typed (run-configurations.mjs): a typed entry's fields are checked here, with
 * the first located error refused, and what this checkout provides (wrappers, interpreter) is
 * detected for it. `readApplication: false` selects the capability without reading its block at all,
 * for app config preview, which checks a block from a file instead of the one in the map.
 */
export async function resolveCapabilityApplication(root, { capabilityId = null, subjectPath = null, readApplication = true } = {}) {
  const source = await sourceForRepository(root);
  const hasApprovedReadScope = path.resolve(configurationReadRoot(root)) !== path.resolve(root);
  const hasPinnedConfiguration = existsSync(path.join(root, CONFIGURATION_SOURCE_PATH));
  let mapRoot = hasPinnedConfiguration || hasApprovedReadScope ? root : source.mapRoot;
  let loaded = await readRetainedCapabilityMap(mapRoot);
  if (!loaded && mapRoot !== root) loaded = await readRetainedCapabilityMap(root);
  if (!loaded) {
    if (capabilityId && capabilityId !== IMPLICIT_CAPABILITY_ID) {
      throw new SingularityFlowError(
        `Unknown capability '${capabilityId}'. This repository currently uses the implicit '${IMPLICIT_CAPABILITY_ID}' capability.`,
        { code: 'CAPABILITY_UNKNOWN', details: { capabilityId, available: [IMPLICIT_CAPABILITY_ID] } });
    }
    return Object.freeze({
      capabilityId: IMPLICIT_CAPABILITY_ID, implicit: true, capability: null,
      application: normalizeCapabilityApplication(IMPLICIT_CAPABILITY_ID, null),
      repositories: source.repositoryId ? [source.repositoryId] : [], repositoryId: source.repositoryId ?? null,
      policy: {}, mapSha256: null
    });
  }
  const { definition, snapshot } = loaded;
  const deliveries = Object.entries(definition.capabilities)
    .filter(([, capability]) => capability.kind === 'delivery').map(([id]) => id);
  let selected = capabilityId;
  if (!selected && source.repositoryId) {
    const shipping = deliveries.filter((id) => capabilityRepositories(definition.capabilities[id]).includes(source.repositoryId));
    if (shipping.length === 1) [selected] = shipping;
    else if (shipping.length > 1) {
      const owner = resolveCapabilityOwner(definition, subjectPath ?? '').capabilityId;
      selected = shipping.includes(owner) ? owner : null;
    }
  }
  if (!selected && source.workspace?.capabilities?.length === 1) selected = source.workspace.capabilities[0];
  if (!selected) selected = soleDelivery(definition);
  if (!selected) {
    throw new SingularityFlowError(
      `This checkout maps to ${deliveries.length ? `more than one delivery capability (${deliveries.join(', ')})` : 'no delivery capability'}. Name one with --capability <ID>.`,
      { code: 'CAPABILITY_SELECTION_REQUIRED', details: { capabilityIds: deliveries, option: '--capability <id>' } });
  }
  const capability = definition.capabilities[selected];
  if (!capability) {
    throw new SingularityFlowError(`Unknown capability '${selected}'.`, {
      code: 'CAPABILITY_UNKNOWN', details: { capabilityId: selected, available: deliveries } });
  }
  if (capability.kind !== 'delivery') {
    throw new SingularityFlowError(`Capability '${selected}' is a collection; name one of its delivery capabilities with --capability.`, {
      code: 'CAPABILITY_NOT_DELIVERY', details: { capabilityId: selected, available: deliveries } });
  }
  const repositories = capabilityRepositories(capability);
  return Object.freeze({
    capabilityId: selected, implicit: false, capability,
    application: readApplication ? typedApplication(selected, capability.application, normalizeCapabilityApplication(selected, capability), {
      checkoutRoot: root, repositoryId: source.repositoryId ?? null, repositories }) : null,
    repositories, repositoryId: source.repositoryId ?? null,
    policy: resolveCapabilityPolicy(definition, selected).policy, mapSha256: snapshot.sha256
  });
}
