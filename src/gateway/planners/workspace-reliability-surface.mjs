/**
 * Rootless workspace recovery destinations.
 *
 * These are reads rather than mutations: the gateway validates and seals the selected destination,
 * then the host opens its governed setup surface. Creation, cloning and registry changes still
 * happen through the existing CLI-backed forms and retain their own confirmations.
 */
import { readWorkspaceBootstrap } from '../../workspace-bootstrap.mjs';
import { noEffects, sflowResult } from '../result.mjs';

function surfaceResult(operation, surface, reason, data = {}) {
  return sflowResult({
    kind: 'read',
    operation: { id: operation.id, classification: 'read' },
    outcome: { status: 'succeeded', messageId: 'gateway.read', slots: { surface } },
    effects: noEffects(),
    why: [{ code: reason, source: 'deterministic' }],
    next: [],
    restState: 'informational',
    data: { surface, ...data }
  });
}

export async function workspaceBootstrapStatus({ operation, arguments: input, context = {} } = {}) {
  const bootstrap = context.bootstrap?.bootstrapId === input.bootstrapId
    ? context.bootstrap
    : await readWorkspaceBootstrap(input.bootstrapId).catch(() => null);
  return surfaceResult(operation, 'workspace-bootstrap', 'workspace.bootstrap-available', {
    bootstrap: bootstrap ? {
      bootstrapId: bootstrap.bootstrapId,
      status: bootstrap.status,
      confirmation: bootstrap.plan?.workspace?.confirmation ?? null,
      workspaceId: bootstrap.plan?.workspace?.id ?? bootstrap.request?.workspaceId ?? null,
      workspaceName: bootstrap.plan?.workspace?.name ?? bootstrap.request?.workspaceName ?? null,
      nextAction: bootstrap.nextAction ?? null
    } : { bootstrapId: input.bootstrapId, status: 'unavailable' }
  });
}

export function workspacePrepareGuide({ operation } = {}) {
  return surfaceResult(operation, 'workspace-prepare', 'workspace.prepare-available');
}

export function repositoryOpenGuide({ operation } = {}) {
  return surfaceResult(operation, 'repository-open', 'workspace.open-available');
}

export function workspaceDoctorGuide({ operation } = {}) {
  return surfaceResult(operation, 'workspace-doctor', 'workspace.doctor-available');
}

export function workspaceExploreGuide({ operation } = {}) {
  return surfaceResult(operation, 'workspace-explore', 'workspace.explore-available');
}
