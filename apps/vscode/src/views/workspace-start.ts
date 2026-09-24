type WorkspaceRepository = {
  id: string;
  required?: boolean;
  state: string;
  capabilities?: string[];
};

type SelectedWorkspace = {
  repositoryId?: string;
  repositoryCapabilities?: string[];
};

/** Select only provably needed checkouts; keep all required members for ambiguous intake. */
export function deferredWorkspaceRepositories(
  repositories: WorkspaceRepository[],
  selected: SelectedWorkspace,
  wizardCapabilityId: string | null = null
): WorkspaceRepository[] {
  const bindings = selected.repositoryCapabilities ?? [];
  const capabilityId = wizardCapabilityId || (bindings.length === 1 ? bindings[0] : null);
  const exactDelivery = capabilityId
    ? repositories.filter((entry) => entry.capabilities?.includes(capabilityId)) : [];
  // A collection names descendant deliveries, not an exact repository binding. Never infer
  // its closure from a workspace manifest that lists only leaf delivery capabilities.
  const neededIds = exactDelivery.length
    ? new Set([selected.repositoryId, ...exactDelivery.map((entry) => entry.id)])
    : null;
  return repositories.filter((entry) =>
    (neededIds ? neededIds.has(entry.id) : entry.required !== false)
    && entry.state !== 'ready');
}
