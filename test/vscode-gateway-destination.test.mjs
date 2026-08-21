import test from 'node:test';
import assert from 'node:assert/strict';

const { gatewayDestination, gatewayDestinationRequest } = await import('../apps/vscode/src/gateway-destination.ts');

test('typed and clicked start results use the same host destination and defaults', () => {
  const result = {
    operation: { id: 'work.start.intake' },
    data: { surface: 'start-intake', defaults: { source: 'jira', workType: 'bug-fix' } }
  };
  assert.deepEqual(gatewayDestinationRequest(result), {
    command: 'singularityFlow.startWork',
    args: [{ source: 'jira', workType: 'bug-fix' }]
  });
  assert.equal(gatewayDestination(result), 'singularityFlow.startWork');
});

test('a review packet opens the existing governed Approvals surface', () => {
  assert.equal(gatewayDestination({
    operation: { id: 'review.packet' },
    data: { surface: 'approvals', requestedWork: { id: 'WRK-42', kind: 'story' } }
  }), 'singularityFlow.openApprovals');
});

test('gateway destination routing is closed to unrelated or malformed results', () => {
  assert.equal(gatewayDestination({ operation: { id: 'work.handoff' }, data: { surface: 'approvals' } }), null);
  assert.equal(gatewayDestination({ operation: { id: 'review.packet' }, data: { surface: 'elsewhere' } }), null);
  assert.equal(gatewayDestination(null), null);
});

test('rootless workspace recovery results open only their dedicated host surfaces', () => {
  assert.equal(gatewayDestination({
    operation: { id: 'workspace.bootstrap.status' }, data: { surface: 'workspace-bootstrap' }
  }), 'singularityFlow.resumeWorkspaceBootstrap');
  assert.equal(gatewayDestination({
    operation: { id: 'workspace.prepare.guide' }, data: { surface: 'workspace-prepare' }
  }), 'singularityFlow.createWorkspace');
  assert.equal(gatewayDestination({
    operation: { id: 'repository.open.guide' }, data: { surface: 'repository-open' }
  }), 'singularityFlow.adoptWorkspace');
  assert.equal(gatewayDestination({
    operation: { id: 'workspace.doctor.guide' }, data: { surface: 'workspace-doctor' }
  }), 'singularityFlow.workspaceDoctor');
  assert.equal(gatewayDestination({
    operation: { id: 'workspace.explore.guide' }, data: { surface: 'workspace-explore' }
  }), 'singularityFlow.openWorkspaces');
  assert.equal(gatewayDestination({
    operation: { id: 'workspace.prepare.guide' }, data: { surface: 'workspace-bootstrap' }
  }), null);
});
