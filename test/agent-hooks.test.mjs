import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { copilotAgentStartHook, sessionStartAgentHook, agentGuardHook } from '../src/agent-hooks.mjs';
import {
  activateWorkItemSession, agentSessionStatus, clearCopilotTurnIntent, loadSession,
  recordCopilotTurnIntent, requireCopilotWorkItemSelection, sessionOnlyPrompt, setAgentSession,
  setNativeCopilotAgentSession
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

test('native readonly agents preserve author and cannot advance any phase through its identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-native-readonly-'));
  const current = workflow({ workItemSelection: 'off', requireBeforeTools: false });
  await setAgentSession(root, definition, { name: 'User', email: 'user@example.test' }, 'architect', 'HOOK-1', { phaseId: 'design' });
  for (const mode of ['read-only-review', 'read-only']) {
    await setNativeCopilotAgentSession(root, { copilotAgent: 'peer', source: 'same-name',
      agent: { id: 'peer', sha256: 'review-sha', metadata: { 'sflow-mode': mode } } });
    const session = await loadSession(root);
    assert.equal(session.agent, 'architect');
    assert.equal(session.agentSha256, 'arch-sha');
    for (const command of ['singularity-flow phase publish design --authored governed-agent --channel copilot-host',
      "'singularity-flow' 'submit' 'design'", 'singularity-flow approve design',
      'singularity-flow story intent-amendment acknowledge AMD-001 --work-id HOOK-1']) {
      const result = await agentGuardHook(root, definition, current, { toolName: 'bash', toolArgs: { command } });
      assert.equal(result.permissionDecision, 'deny', `${mode}: ${command}`);
    }
    for (const command of ['singularity-flow review-source context design --json',
      'singularity-flow review-source check design --report-file packet.json --json',
      'singularity-flow review-source submit design --report-file packet.json --json',
      'singularity-flow status --json']) {
      const result = await agentGuardHook(root, definition, current, { toolName: 'bash', toolArgs: { command } });
      assert.notEqual(result.permissionDecision, 'deny', `${mode}: ${command}`);
    }
    assert.equal((await agentGuardHook(root, definition, current, { toolName: 'edit', toolArgs: { path: 'src/app.js' } })).permissionDecision, 'deny');
  }
  await setNativeCopilotAgentSession(root, { copilotAgent: 'architect', source: 'same-name', agent: definition.agents.architect });
  assert.equal((await loadSession(root)).nativeAgentMode, null);
  assert.notEqual((await agentGuardHook(root, definition, current, { toolName: 'edit', toolArgs: { path: 'src/app.js' } })).permissionDecision, 'deny');
});

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

test('same-agent phase transitions still require an exact phase rebind', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-same-agent-phase-'));
  const qaDefinition = structuredClone(definition);
  qaDefinition.agents.qa = {
    id: 'qa', label: 'QA', description: 'Verify and release',
    phases: ['verification', 'release'], defaultFor: ['verification', 'release'],
    worldModelViews: ['testing'], sha256: 'qa-sha', scope: 'repository'
  };
  qaDefinition.agentCatalog = Object.values(qaDefinition.agents);
  const current = {
    workItem: { id: 'HOOK-QA' }, currentPhase: 'verification', status: 'in_progress',
    phases: {
      verification: { id: 'verification', status: 'in_progress', defaultAgent: 'qa' },
      release: { id: 'release', status: 'not_started', defaultAgent: 'qa' }
    },
    resolution: { session: { workItemSelection: 'off', requireBeforeTools: false } }
  };
  await activateWorkItemSession(root, qaDefinition, current);
  current.currentPhase = 'release';
  current.phases.verification.status = 'approved';
  current.phases.release.status = 'in_progress';

  const stale = await agentSessionStatus(root, qaDefinition, current);
  assert.equal(stale.ready, false);
  assert.equal(stale.activeAgent, null);
  assert.equal(stale.phaseAgent.reason, 'active-session-bound-to-different-phase');
  assert.deepEqual(stale.phaseAgent.handoff, {
    fromPhaseId: 'verification', fromAgent: 'qa', toPhaseId: 'release', toAgent: 'qa',
    copilotCommand: '/sf-session', command: 'singularity-flow session attach HOOK-QA --json'
  });

  await activateWorkItemSession(root, qaDefinition, current);
  const rebound = await agentSessionStatus(root, qaDefinition, current);
  assert.equal(rebound.ready, true);
  assert.equal(rebound.activeAgent, 'qa');
  assert.equal(rebound.phaseAgent.sessionPhaseId, 'release');
});

test('deterministic convergence explicitly clears and exempts the phase agent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-deterministic-agent-'));
  const current = workflow({ workItemSelection: 'off', requireBeforeTools: false });
  await activateWorkItemSession(root, definition, current);
  current.currentPhase = 'convergence';
  current.phases.convergence = {
    id: 'convergence', status: 'in_progress', defaultAgent: 'architect',
    generationPolicy: { defaultProducer: 'deterministic', allowedProducers: ['deterministic'] }
  };
  const activation = await activateWorkItemSession(root, definition, current);
  assert.equal(activation.selectedAgent, null);
  assert.equal(await loadSession(root, { required: false }), null);
  const status = await agentSessionStatus(root, definition, current);
  assert.equal(status.ready, true);
  assert.equal(status.activeAgent, null);
  assert.deepEqual(status.phaseAgent, {
    required: false, phaseId: 'convergence', expectedAgent: null,
    sessionPhaseId: null, activeAgent: null, valid: true,
    reason: 'deterministic-phase-does-not-require-agent', handoff: null
  });
});

test('Copilot session-start never synthesizes a phase agent for deterministic convergence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-deterministic-hook-'));
  const current = workflow({ workItemSelection: 'off', requireBeforeTools: false });
  await setAgentSession(root, definition, 'User <user@example.com>', 'architect', 'HOOK-1', {
    phaseId: 'design'
  });
  current.currentPhase = 'convergence';
  current.phases.convergence = {
    id: 'convergence', status: 'in_progress', defaultAgent: 'architect',
    generationPolicy: { defaultProducer: 'deterministic', allowedProducers: ['deterministic'] }
  };

  const started = await sessionStartAgentHook(root, definition, current, {
    sessionId: 'copilot-deterministic', source: 'startup'
  });
  assert.match(started.additionalContext, /kernel-owned and deterministic/);
  assert.doesNotMatch(started.additionalContext, /Agent architect is active/);
  assert.equal(await loadSession(root, { required: false }), null);
  const status = await agentSessionStatus(root, definition, current);
  assert.equal(status.ready, true);
  assert.equal(status.activeAgent, null);
  assert.equal(status.phaseAgent.reason, 'deterministic-phase-does-not-require-agent');
});

test('terminal Story sessions attach without inventing a null phase agent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-terminal-agent-'));
  const current = workflow({ workItemSelection: 'off', requireBeforeTools: false });
  await setAgentSession(root, definition, 'User <user@example.com>', 'architect', 'HOOK-1', { phaseId: 'design' });
  current.currentPhase = null;
  current.status = 'closed';

  const activation = await activateWorkItemSession(root, definition, current);
  assert.equal(activation.phase, null);
  assert.equal(activation.workflowStatus, 'closed');
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
  const current = workflow({ workItemSelection: 'off', requireBeforeTools: false });
  const status = await agentSessionStatus(root, definition, current);
  assert.equal(status.ready, true, 'a recorded same-phase explicit override remains a valid session');
  assert.equal(status.activeAgent, 'developer');
  assert.equal(status.phaseAgent.expectedAgent, 'architect', 'the phase default remains visible guidance');
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
  assert.match(hook.additionalContext, /Artifacts for HOOK-1 live under singularity\/work-items\/HOOK-1\//);
  assert.match(hook.additionalContext, /Use this exact repository as the cwd for every shell and file tool/);
  assert.match(hook.additionalContext, /Never search \$HOME, a parent directory, or outside this repository/);
  // Selecting a governed agent directly says how to run the step; the agent alone runs nothing.
  assert.match(hook.additionalContext, /To draft or continue a Story step \(HOOK-1\) as .+, run \/sf-next, or \/sf-phase for the current step/);
  assert.match(hook.additionalContext, /Selecting the agent alone does not run the workflow\./);
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
  assert.match(start.additionalContext, /Artifacts for HOOK-1 live under singularity\/work-items\/HOOK-1\//);
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
    toolName: 'run_in_terminal',
    toolArgs: { command: 'singularity-flow submit implementation --work-id HOOK-1' }
  }), {});
  assert.deepEqual(await agentGuardHook(root, definition, current, {
    toolName: 'run_in_terminal',
    toolArgs: { command: 'singularity-flow submit implementation --work-id HOOK-1 --skip-checks --json' }
  }), {});
  assert.deepEqual(await agentGuardHook(root, definition, current, {
    toolName: 'run_in_terminal', toolArgs: { command: 'singularity-flow recover HOOK-1 --phase implementation --json' }
  }), {});
  assert.deepEqual(await agentGuardHook(root, definition, current, {
    toolName: 'run_in_terminal',
    toolArgs: { command: 'singularity-flow status HOOK-1 --submission-readiness --json' }
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

// The batch shape Copilot 1.0.9x records for preToolUse: { sessionId, cwd, toolCalls: [{ id, name, args }] }.
function toolCall(id, name, args) { return { id: `call_${id}`, name, args }; }

test('a batched toolCalls payload passes the selection gate only when every call would', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-guard-batch-'));
  const current = workflow();
  await sessionStartAgentHook(root, definition, current, { sessionId: 'copilot-batch', source: 'startup' });
  const batch = (...toolCalls) => agentGuardHook(root, definition, current, { sessionId: 'copilot-batch', cwd: root, toolCalls });
  const attach = toolCall(1, 'bash', { command: 'singularity-flow session attach HOOK-1' });
  const probe = toolCall(2, 'bash', { command: 'git status --short --branch' });
  const edit = toolCall(3, 'edit', { path: 'src/app.js' });

  assert.deepEqual(await batch(attach, probe), {}, 'every call is a permitted session-management call');
  const denied = await batch(edit);
  assert.equal(denied.permissionDecision, 'deny');
  assert.match(denied.permissionDecisionReason, /before using 'edit'/);
  const mixed = await batch(attach, edit, probe);
  assert.equal(mixed.permissionDecision, 'deny', 'one gated call denies the whole batch');
  assert.match(mixed.permissionDecisionReason, /before using 'edit'.*session attach HOOK-1/);
  assert.deepEqual(await batch(toolCall(4, 'bash', JSON.stringify({ command: 'singularity-flow session attach HOOK-1' }))), {},
    'arguments may arrive as a JSON string');

  // An empty or malformed batch is read as the single-call shape; a malformed entry is an unnamed tool.
  assert.deepEqual(await agentGuardHook(root, definition, current, { toolCalls: [],
    toolName: 'bash', toolArgs: { command: 'singularity-flow session attach HOOK-1' } }), {});
  assert.equal((await agentGuardHook(root, definition, current, { toolCalls: 'edit',
    toolName: 'edit', toolArgs: { path: 'src/app.js' } })).permissionDecision, 'deny');
  assert.match((await batch(attach, null)).permissionDecisionReason, /before using 'this tool'/);

  await activateWorkItemSession(root, definition, current);
  assert.deepEqual(await batch(attach, edit), {}, 'a selected work item lifts the gate for every call');
});

test('session-only, read-only agent and published-generation checks see every batched call', async () => {
  const status = toolCall(1, 'bash', { command: 'singularity-flow session status --json' });
  const edit = toolCall(2, 'edit', { path: 'src/app.js' });

  const sessionRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-guard-batch-session-'));
  const sessionStory = workflow({ workItemSelection: 'off', requireBeforeTools: true });
  await activateWorkItemSession(sessionRoot, definition, sessionStory);
  await recordCopilotTurnIntent(sessionRoot, { sessionId: 'copilot-batch', prompt: '/sflow-session HOOK-1' });
  const inSession = (...toolCalls) => agentGuardHook(sessionRoot, definition, sessionStory, { sessionId: 'copilot-batch', toolCalls });
  assert.deepEqual(await inSession(status, toolCall(3, 'bash', { command: 'singularity-flow nextsteps HOOK-1 --json' })), {});
  const setup = await inSession(status, edit);
  assert.equal(setup.permissionDecision, 'deny');
  assert.match(setup.permissionDecisionReason, /session-setup-only turn/);
  await clearCopilotTurnIntent(sessionRoot, 'copilot-batch');
  assert.deepEqual(await inSession(status, edit), {});

  const reviewRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-guard-batch-review-'));
  const reviewStory = workflow({ workItemSelection: 'off', requireBeforeTools: false });
  await setAgentSession(reviewRoot, definition, { name: 'User', email: 'user@example.test' }, 'architect', 'HOOK-1', { phaseId: 'design' });
  await setNativeCopilotAgentSession(reviewRoot, { copilotAgent: 'peer', source: 'same-name',
    agent: { id: 'peer', sha256: 'review-sha', metadata: { 'sflow-mode': 'read-only-review' } } });
  const inReview = (...toolCalls) => agentGuardHook(reviewRoot, definition, reviewStory, { toolCalls });
  const context = toolCall(4, 'bash', { command: 'singularity-flow review-source context design --json' });
  assert.notEqual((await inReview(status, context)).permissionDecision, 'deny');
  const approve = await inReview(context, toolCall(5, 'bash', { command: 'singularity-flow approve design' }));
  assert.equal(approve.permissionDecision, 'deny');
  assert.match(approve.permissionDecisionReason, /is read-only/);

  const codeRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-guard-batch-consumed-'));
  const codeStory = workflow({ workItemSelection: 'off', requireBeforeTools: false });
  codeStory.currentPhase = 'implementation';
  codeStory.phases.implementation = {
    id: 'implementation', status: 'in_progress', generation: 1, defaultAgent: 'developer',
    generationPolicy: { task: 'code' }, generationIntent: { generation: 1, status: 'consumed' }
  };
  await activateWorkItemSession(codeRoot, definition, codeStory);
  const inCode = (...toolCalls) => agentGuardHook(codeRoot, definition, codeStory, { toolCalls });
  const submit = toolCall(6, 'run_in_terminal', { command: 'singularity-flow submit implementation --json' });
  const recover = toolCall(7, 'run_in_terminal', { command: 'singularity-flow recover HOOK-1 --phase implementation --json' });
  const npmTest = toolCall(8, 'run_in_terminal', { command: 'npm test' });
  assert.deepEqual(await inCode(submit, recover), {});
  const immutable = await inCode(submit, npmTest);
  assert.equal(immutable.permissionDecision, 'deny');
  assert.match(immutable.permissionDecisionReason, /already published and immutable/);
  const authorship = await inCode(npmTest,
    toolCall(9, 'run_in_terminal', { command: 'singularity-flow phase publish implementation --authored human' }));
  assert.match(authorship.permissionDecisionReason, /configured producer/, 'the first check that denies any call gives the reason');
});

test('a conversation opened after the approval boundary keeps the Story this checkout selected', async () => {
  const story = (contextPolicy) => ({
    workItem: { id: 'HOOK-1' }, currentPhase: 'implementation', phaseOrder: ['design', 'implementation'],
    phases: {
      design: { id: 'design', status: 'approved', defaultAgent: 'architect' },
      implementation: { id: 'implementation', status: 'in_progress', defaultAgent: 'developer', generation: 0 }
    },
    resolution: { session: definition.session, contextPolicy }
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-handover-hook-'));
  const current = story({ onApproval: 'new' });
  // The approval's activation selected the Story for this checkout in the earlier conversation.
  await activateWorkItemSession(root, definition, current);
  const fresh = await sessionStartAgentHook(root, definition, current, { sessionId: 'chat-after-approval', source: 'startup' });
  assert.doesNotMatch(JSON.stringify(fresh), /select|choose/i, 'SFlow asked for this reset, so it does not ask for the Story again');
  assert.equal((await agentSessionStatus(root, definition, current)).ready, true);

  // Once the phase is prepared, the prompt policy applies to a new conversation again.
  current.phases.implementation.authoringBaseline = { generation: 1 };
  await sessionStartAgentHook(root, definition, current, { sessionId: 'chat-later', source: 'startup' });
  assert.equal((await agentSessionStatus(root, definition, current)).ready, false);

  const keep = await mkdtemp(path.join(os.tmpdir(), 'sflow-handover-keep-'));
  const kept = story({ onApproval: 'keep' });
  await activateWorkItemSession(keep, definition, kept);
  await sessionStartAgentHook(keep, definition, kept, { sessionId: 'chat-other', source: 'startup' });
  assert.equal((await agentSessionStatus(keep, definition, kept)).ready, false, 'without a requested reset nothing is handed over');
});
