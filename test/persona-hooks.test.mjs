import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sessionStartPersonaHook, personaGuardHook } from '../src/persona-hooks.mjs';
import { activateWorkItemSession, personaSessionStatus, setPersonaSession } from '../src/session.mjs';

const definition = {
  session: { workItemSelection: 'prompt', personaSelection: 'prompt', promptOnNewSession: true, promptOnResume: false, requireBeforeTools: true },
  personas: {
    developer: { label: 'Developer', description: 'Build and test' },
    architect: { label: 'Architect', description: 'Design and review' }
  }
};

function workflow(policy = definition.session) {
  return {
    workItem: { id: 'HOOK-1' }, currentPhase: 'design',
    phases: { design: { id: 'design', status: 'in_progress' } },
    resolution: { session: policy }
  };
}

test('new Copilot sessions require work-item selection before persona selection and guard tools until both complete', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-persona-hook-'));
  const current = workflow();
  await setPersonaSession(root, definition, 'User <user@example.com>', 'developer', 'HOOK-1');

  const start = await sessionStartPersonaHook(root, definition, current, { sessionId: 'copilot-new', source: 'startup' });
  assert.match(start.additionalContext, /work-item selection is required/);
  assert.match(start.additionalContext, /work ID or Jira ID/);
  let status = await personaSessionStatus(root, definition, current);
  assert.equal(status.workItemSelectionRequired, true);
  assert.equal(status.selectionRequired, false);
  assert.equal(status.bound, false);

  const denied = await personaGuardHook(root, definition, current, { toolName: 'edit', toolArgs: { path: 'src/app.js' } });
  assert.equal(denied.permissionDecision, 'deny');
  assert.match(denied.permissionDecisionReason, /work\/Jira ID/);
  assert.deepEqual(await personaGuardHook(root, definition, current, { toolName: 'bash', toolArgs: { command: 'singularity-flow inbox --json' } }), {});
  assert.deepEqual(await personaGuardHook(root, definition, current, { toolName: 'bash', toolArgs: { command: 'singularity-flow session candidates --json' } }), {});
  assert.deepEqual(await personaGuardHook(root, definition, current, { toolName: 'bash', toolArgs: { command: 'singularity-flow session attach HOOK-1' } }), {});

  await activateWorkItemSession(root, definition, current);
  status = await personaSessionStatus(root, definition, current);
  assert.equal(status.workItemSelectionRequired, false);
  assert.equal(status.selectionRequired, true);
  assert.deepEqual(await personaGuardHook(root, definition, current, { toolName: 'bash', toolArgs: { command: 'singularity-flow persona HOOK-1' } }), {});

  await setPersonaSession(root, definition, 'User <user@example.com>', 'architect', 'HOOK-1');
  status = await personaSessionStatus(root, definition, current);
  assert.equal(status.selectionRequired, false);
  assert.equal(status.bound, true);
  assert.equal(status.activePersona, 'architect');
  assert.equal(status.ready, true);
  assert.deepEqual(await personaGuardHook(root, definition, current, { toolName: 'edit', toolArgs: { path: 'src/app.js' } }), {});
});

test('resume reuses and rebinds a valid persona when promptOnResume is disabled', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-persona-resume-'));
  const current = workflow();
  await setPersonaSession(root, definition, 'User <user@example.com>', 'developer', 'HOOK-1');
  await sessionStartPersonaHook(root, definition, current, { sessionId: 'copilot-resumed', source: 'startup' });
  await activateWorkItemSession(root, definition, current);
  await setPersonaSession(root, definition, 'User <user@example.com>', 'developer', 'HOOK-1');
  const result = await sessionStartPersonaHook(root, definition, current, { sessionId: 'copilot-resumed', source: 'resume' });
  assert.match(result.additionalContext, /Acting as developer/);
  const status = await personaSessionStatus(root, definition, current);
  assert.equal(status.selectionRequired, false);
  assert.equal(status.workItemSelectionRequired, false);
  assert.equal(status.bound, true);
  assert.equal(status.copilotSessionId, 'copilot-resumed');
});

test('absent session policy remains inert for existing repositories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-persona-off-'));
  const legacyDefinition = { personas: definition.personas };
  const current = workflow({ workItemSelection: 'off', personaSelection: 'off', promptOnNewSession: false, promptOnResume: false, requireBeforeTools: false });
  const result = await sessionStartPersonaHook(root, legacyDefinition, current, { sessionId: 'copilot-off', source: 'startup' });
  assert.doesNotMatch(result.additionalContext, /selection is required/);
  assert.deepEqual(await personaGuardHook(root, legacyDefinition, current, { toolName: 'edit', toolArgs: {} }), {});
});
