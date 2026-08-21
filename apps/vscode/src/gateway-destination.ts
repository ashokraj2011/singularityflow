export interface GatewayDestination {
  readonly command: string;
  readonly args: readonly unknown[];
}

/** Host-owned destinations for results that already have a dedicated governed surface. */
export function gatewayDestinationRequest(result: any): GatewayDestination | null {
  if (result?.operation?.id === 'work.start.intake' && result?.data?.surface === 'start-intake') {
    return { command: 'singularityFlow.startWork', args: [result.data.defaults ?? {}] };
  }
  if (result?.operation?.id === 'review.packet' && result?.data?.surface === 'approvals') {
    return { command: 'singularityFlow.openApprovals', args: [] };
  }
  if (result?.operation?.id === 'workspace.bootstrap.status'
    && result?.data?.surface === 'workspace-bootstrap') {
    return { command: 'singularityFlow.resumeWorkspaceBootstrap', args: [] };
  }
  if (result?.operation?.id === 'workspace.prepare.guide'
    && result?.data?.surface === 'workspace-prepare') {
    return { command: 'singularityFlow.createWorkspace', args: [] };
  }
  if (result?.operation?.id === 'repository.open.guide'
    && result?.data?.surface === 'repository-open') {
    return { command: 'singularityFlow.adoptWorkspace', args: [] };
  }
  if (result?.operation?.id === 'workspace.doctor.guide'
    && result?.data?.surface === 'workspace-doctor') {
    return { command: 'singularityFlow.workspaceDoctor', args: [] };
  }
  if (result?.operation?.id === 'workspace.explore.guide'
    && result?.data?.surface === 'workspace-explore') {
    return { command: 'singularityFlow.openWorkspaces', args: [] };
  }
  return null;
}

/** Compatibility for callers and tests that only need the command identity. */
export function gatewayDestination(result: any): string | null {
  return gatewayDestinationRequest(result)?.command ?? null;
}
