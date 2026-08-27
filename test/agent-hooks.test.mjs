import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { copilotAgentStartHook, sessionStartAgentHook, agentGuardHook } from '../src/agent-hooks.mjs';
import {
  activateWorkItemSession, agentSessionStatus, clearCopilotTurnIntent, loadSession,
  recordCopilotTurnIntent, requireCopilotWorkItemSelection, sessionOnlyPrompt, setAgentSession
} from '../src/session.mjs';

const definition = {
  session: { workItemSelection: 'prompt', requireBeforeTools: true },
  agents: {
    developer: {
      id: 'developer', label: 'Developer', description: 'Build and test', phases: ['implementation'],
      defaultFor: ['implementation'], worldModelViews: ['development'], sha256: 'dev-sha', scope: 'repository'
    },
    architect: {
      id: 'architect', label: 'Architect', description: 'Design and review', phases: ['design'],
      defaultFor: ['design'], worldModelViews: ['architecture'], sha256: 'arch-sha', scope: 'repository'
    }
  },
  agentCatalog: []
};
definition.agentCatalog = Object.values(definition.agents);

function workflow(policy = definition.session) {
  return {
    workItem: { id: 'HOOK-1' },
    currentPhase: 'design',
    phases: { design: { id: 'design', status: 'in_progress', defaultAgent: 'architect' } },
    resolution: { session: policy }
  };
}

test('phase activation selects the configured agent automatically and reselects on phase change', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-phase-agent-'));
  const current = workflow({ workItemSelection: 'off', requireBeforeTools: false });
  let activation = await activateWorkItemSession(root, definition, current);
  assert.equal(activation.selectionRequired, false);
  assert.equal(activation.selectedAgent, 'architect');
  let session = await loadSession(root);
  assert.equal(session.agent, 'architect');
  assert.equal(session.phaseId, 'design');
  assert.equal(session.agentSource, 'phase-default');

  current.currentPhase = 'implementation';
  current.phases.implementation = { id: 'implementation', status: 'in_progress', defaultAgent: 'developer' };
  activation = await activateWorkItemSession(root, definition, current);
  assert.equal(activation.selectedAgent, 'developer');
  session = await loadSession(root);
  assert.equal(session.agent, 'developer');
  assert.equal(session.phaseId, 'implementation');
});

test('terminal Story sessions attach without inventing a null phase agent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-terminal-agent-'));
  const current = workflow({ workItemSelection: 'off', requireBeforeTools: false });
  await setAgentSession(root, definition, 'User <user@example.com>', 'architect', 'HOOK-1', { phaseId: 'design' });
  current.currentPhase = null;
  current.status = 'complete';

  const activation = await activateWorkItemSession(root, definition, current);
  assert.equal(activation.phase, null);
  assert.equal(activation.workflowStatus, 'complete');
  assert.equal(activation.selectedAgent, null);
  assert.equal(await loadSession(root, { required: false }), null, 'the final-phase agent is no longer presented as active');
});

test('a non-terminal Story without an active phase reports corrupt state clearly', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-missing-phase-'));
  const current = workflow({ workItemSelection: 'off', requireBeforeTools: false });
  current.currentPhase = null;
  current.status = 'in_progress';
  await assert.rejects(
    () => activateWorkItemSession(root, definition, current),
    /has no active phase while its status is 'in_progress'.*doctor/
  );
});

test('explicit agent override is local, audited, and does not grant approval authority', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-override-'));
  const session = await setAgentSession(root, definition, 'User <user@example.com>', 'developer', 'HOOK-1', {
    phaseId: 'design', source: 'explicit-override'
  });
  assert.equal(session.agent, 'developer');
  assert.equal(session.agentSource, 'explicit-override');
  assert.equal(session.phaseCompatibilityOverride.phase, 'design');
  assert.equal(session.actor, 'User <user@example.com>');
  assert.equal(session.approvalAuthority, undefined);
});

test('Copilot custom-agent mapping changes instructions but preserves the governed work item', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-native-agent-'));
  await mkdir(path.join(root, '.github', 'agents'), { recursive: true });
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, '.github', 'agents', 'architecture.agent.md'), `---
name: architecture
description: Architecture review
phases: [design]
defaultFor: []
worldModelViews: [architecture]
---

# Architecture review

Inspect boundaries and contracts.
`);
  await writeFile(path.join(root, 'singularity', 'agent-mappings.yml'), 'version: 1\nmappings:\n  enterprise-delivery: architecture\n');
  await setAgentSession(root, definition, 'User <user@example.com>', 'architect', 'HOOK-1', { phaseId: 'design' });
  const hook = await copilotAgentStartHook(root, { agentName: 'enterprise-delivery' });
  assert.match(hook.additionalContext, new RegExp(`Working repository: ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(hook.additionalContext, /Governed artifacts for HOOK-1 live under singularity\/work-items\/HOOK-1\//);
  assert.match(hook.additionalContext, /Use this exact repository as the cwd for every shell and file tool/);
  assert.match(hook.additionalContext, /Never search \$HOME, a parent directory, or outside this repository/);
  const session = await loadSession(root);
  assert.equal(session.agent, 'architecture');
  assert.equal(session.nativeCopilotAgent, 'enterprise-delivery');
  assert.equal(session.workId, 'HOOK-1');
});

test('unmapped Copilot agents retain the phase agent and are explicitly reported', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-unmapped-agent-'));
  await setAgentSession(root, definition, 'User <user@example.com>', 'architect', 'HOOK-1', { phaseId: 'design' });
  const result = await copilotAgentStartHook(root, { agentName: 'security-review' });
  assert.match(result.additionalContext, /not mapped/);
  const session = await loadSession(root);
  assert.equal(session.agent, 'architect');
  assert.equal(session.nativeCopilotAgent, 'security-review');
});

test('session start gates only work-item selection and then activates the phase agent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-session-'));
  const current = workflow();
  const start = await sessionStartAgentHook(root, definition, current, { sessionId: 'copilot-new', source: 'startup' });
  assert.match(start.additionalContext, /work-item selection is required/);
  assert.match(start.additionalContext, new RegExp(`Working repository: ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(start.additionalContext, /Governed artifacts for HOOK-1 live under singularity\/work-items\/HOOK-1\//);
  assert.match(start.additionalContext, /Use this exact repository as the cwd for every shell and file tool/);
  assert.match(start.additionalContext, /Never search \$HOME, a parent directory, or outside this repository/);
  let status = await agentSessionStatus(root, definition, current);
  assert.equal(status.workItemSelectionRequired, true);
  assert.equal(status.selectionRequired, false);

  const denied = await agentGuardHook(root, definition, current, { toolName: 'edit', toolArgs: { path: 'src/app.js' } });
  assert.equal(denied.permissionDecision, 'deny');
  assert.match(denied.permissionDecisionReason, /session attach HOOK-1/);
  assert.deepEqual(await agentGuardHook(root, definition, current, {
    toolName: 'bash', toolArgs: { command: 'singularity-flow session attach HOOK-1' }
  }), {});

  await activateWorkItemSession(root, definition, current);
  status = await agentSessionStatus(root, definition, current);
  assert.equal(status.workItemSelectionRequired, false);
  assert.equal(status.selectionRequired, false);
  assert.equal(status.activeAgent, 'architect');
  assert.deepEqual(await agentGuardHook(root, definition, current, { toolName: 'edit', toolArgs: { path: 'src/app.js' } }), {});
});

test('a workspace-only handoff preserves explicit Story selection for repositories with old policy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-session-gate-'));
  const current = workflow({ workItemSelection: 'off', requireBeforeTools: false });
  await requireCopilotWorkItemSelection(root, definition, current);

  const start = await sessionStartAgentHook(root, definition, current, {
    sessionId: 'copilot-workspace', source: 'startup'
  });
  assert.match(start.additionalContext, /work-item selection is required/);
  let status = await agentSessionStatus(root, definition, current);
  assert.equal(status.workItemSelectionRequired, true);
  assert.equal(status.workId, null);
  assert.equal(status.candidateWorkId, 'HOOK-1');

  await activateWorkItemSession(root, definition, current);
  status = await agentSessionStatus(root, definition, current);
  assert.equal(status.workItemSelectionRequired, false, 'an explicit attachment consumes the gate');
  assert.equal(status.workId, 'HOOK-1');
});

test('session-only prompts allow synchronization commands but no implementation work', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-session-only-'));
  const current = workflow({ workItemSelection: 'off', requireBeforeTools: true });
  await activateWorkItemSession(root, definition, current);
  assert.deepEqual(sessionOnlyPrompt('/sflow-session HOOK-1'), { intent: 'session-only', workId: 'HOOK-1' });
  assert.deepEqual(sessionOnlyPrompt('/singularity-flow/sflow-session WORK-124'), { intent: 'session-only', workId: 'WORK-124' });
  assert.equal(sessionOnlyPrompt('/sflow-session WORK-124 and implement it'), null);
  await recordCopilotTurnIntent(root, { sessionId: 'copilot-new', prompt: '/sflow-session HOOK-1' });
  assert.deepEqual(await agentGuardHook(root, definition, current, {
    sessionId: 'copilot-new', toolName: 'bash', toolArgs: { command: 'singularity-flow session status --json' }
  }), {});
  const denied = await agentGuardHook(root, definition, current, {
    sessionId: 'copilot-new', toolName: 'edit', toolArgs: { path: 'src/app.js' }
  });
  assert.equal(denied.permissionDecision, 'deny');
  assert.match(denied.permissionDecisionReason, /session-setup-only turn/);
  await clearCopilotTurnIntent(root, 'copilot-new');
  assert.deepEqual(await agentGuardHook(root, definition, current, {
    sessionId: 'copilot-new', toolName: 'edit', toolArgs: { path: 'src/app.js' }
  }), {});
});

test('Copilot cannot mutate a consumed code generation or claim human authorship', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-consumed-generation-'));
  const current = workflow({ workItemSelection: 'off', requireBeforeTools: false });
  current.currentPhase = 'implementation';
  current.phases.implementation = {
    id: 'implementation', status: 'in_progress', generation: 1, defaultAgent: 'developer',
    generationPolicy: { task: 'code' },
    generationIntent: { generation: 1, status: 'consumed' }
  };
  await activateWorkItemSession(root, definition, current);

  for (const payload of [
    { toolName: 'copilot_applyPatch', toolArgs: { path: 'src/app.js' } },
    { toolName: 'replace_string_in_file', toolArgs: { path: 'src/app.js' } },
    { toolName: 'run_in_terminal', toolArgs: { command: 'npm test' } },
    { toolName: 'run_in_terminal', toolArgs: { command: 'git status; npm test' } }
  ]) {
    const denied = await agentGuardHook(root, definition, current, payload);
    assert.equal(denied.permissionDecision, 'deny');
    assert.match(denied.permissionDecisionReason, /already published and immutable/);
  }
  assert.deepEqual(await agentGuardHook(root, definition, current, {
    toolName: 'run_in_terminal',
    toolArgs: { command: `cd '${root}' && singularity-flow submit implementation` }
  }), {});
  assert.deepEqual(await agentGuardHook(root, definition, current, {
    toolName: 'run_in_terminal', toolArgs: { command: 'singularity-flow recover HOOK-1 --phase implementation --json' }
  }), {});
  assert.deepEqual(await agentGuardHook(root, definition, current, {
    toolName: 'run_in_terminal', toolArgs: { command: 'singularity-flow phase rollover implementation --json' }
  }), {});
  assert.deepEqual(await agentGuardHook(root, definition, current, {
    toolName: 'run_in_terminal',
    toolArgs: { command: `singularity-flow phase rollover implementation --confirm sha256:${'a'.repeat(64)}` }
  }), {});
  const wrongAuthorship = await agentGuardHook(root, definition, current, {
    toolName: 'run_in_terminal',
    toolArgs: { command: 'singularity-flow phase publish implementation --authored human' }
  });
  assert.equal(wrongAuthorship.permissionDecision, 'deny');
  assert.match(wrongAuthorship.permissionDecisionReason, /configured producer/);

  current.phases.implementation.generationPolicy.defaultProducer = 'deterministic';
  assert.deepEqual(await agentGuardHook(root, definition, current, {
    toolName: 'run_in_terminal',
    toolArgs: { command: 'singularity-flow phase publish implementation --authored deterministic --channel kernel-generator' }
  }), {});
  const wrongConfiguredProducer = await agentGuardHook(root, definition, current, {
    toolName: 'run_in_terminal',
    toolArgs: { command: 'singularity-flow phase publish implementation --authored governed-agent --channel copilot-host' }
  });
  assert.equal(wrongConfiguredProducer.permissionDecision, 'deny');
  assert.match(wrongConfiguredProducer.permissionDecisionReason, /--authored deterministic --channel kernel-generator/);
});
