import path from 'node:path';

export function requireActiveRepository(activeRepository, repository) {
  const resolved = path.resolve(repository || '');
  if (!activeRepository || resolved !== path.resolve(activeRepository)) {
    throw new Error('Repository is not open in Singularity Flow.');
  }
  return resolved;
}

export function requireActiveWorkspace(activeWorkspace, workspace) {
  const resolved = path.resolve(workspace || '');
  const activePath = activeWorkspace?.workspace?.path;
  if (!activePath || resolved !== path.resolve(activePath)) {
    throw new Error('Workspace is not open in Singularity Flow.');
  }
  return resolved;
}

export function requireReadyLeadRepository(status) {
  const leadId = status?.workspace?.leadRepository;
  const lead = status?.repositories?.find((repository) => repository.id === leadId);
  if (!lead) throw new Error(`Workspace does not contain its configured lead repository '${leadId ?? '(missing)'}.`);
  if (lead.state !== 'ready' || !lead.absolutePath) {
    throw new Error(`Workspace cannot be opened because its lead repository '${leadId}' is ${lead.state ?? 'unavailable'}. Repair the workspace and try again.`);
  }
  return path.resolve(lead.absolutePath);
}
