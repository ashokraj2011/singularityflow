/** Host-owned destinations for read results that already have a dedicated governed surface. */
export function gatewayDestination(result: any): string | null {
  if (result?.operation?.id === 'review.packet' && result?.data?.surface === 'approvals') {
    return 'singularityFlow.openApprovals';
  }
  if (result?.operation?.id === 'workspace.bootstrap.status'
    && result?.data?.surface === 'workspace-bootstrap') {
    return 'singularityFlow.resumeWorkspaceBootstrap';
  }
  if (result?.operation?.id === 'workspace.prepare.guide'
    && result?.data?.surface === 'workspace-prepare') {
    return 'singularityFlow.createWorkspace';
  }
  if (result?.operation?.id === 'repository.open.guide'
    && result?.data?.surface === 'repository-open') {
    return 'singularityFlow.adoptWorkspace';
  }
  if (result?.operation?.id === 'workspace.doctor.guide'
    && result?.data?.surface === 'workspace-doctor') {
    return 'singularityFlow.workspaceDoctor';
  }
  if (result?.operation?.id === 'workspace.explore.guide'
    && result?.data?.surface === 'workspace-explore') {
    return 'singularityFlow.openWorkspaces';
  }
  return null;
}
