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
  const receipt = '00000000-0000-4000-8000-000000000000';
  assert.deepEqual(await personaGuardHook(root, definition, current, { toolName: 'bash', toolArgs: { command: 'singularity-flow choices begin start HOOK-2 --json' } }), {});
  assert.deepEqual(await personaGuardHook(root, definition, current, { toolName: 'bash', toolArgs: { command: `singularity-flow choices answer ${receipt} persona architect --json` } }), {});
  assert.deepEqual(await personaGuardHook(root, definition, current, { toolName: 'bash', toolArgs: { command: 'singularity-flow choices begin approve HOOK-2 --fetch --json' } }), {});
  assert.deepEqual(await personaGuardHook(root, definition, current, { toolName: 'bash', toolArgs: { command: `singularity-flow choices answer ${receipt} phase-confirmation intake --json` } }), {});
  assert.deepEqual(await personaGuardHook(root, definition, current, { toolName: 'bash', toolArgs: { command: `singularity-flow start HOOK-2 --story-file /tmp/story.yml --selection-receipt ${receipt}` } }), {});
  assert.deepEqual(await personaGuardHook(root, definition, current, { toolName: 'bash', toolArgs: { command: `singularity-flow story start HOOK-2 --fetch --selection-receipt ${receipt}` } }), {});
  assert.deepEqual(await personaGuardHook(root, definition, current, { toolName: 'bash', toolArgs: { command: `singularity-flow approve HOOK-2 --fetch --selection-receipt ${receipt}` } }), {});
  assert.deepEqual(await personaGuardHook(root, definition, current, { toolName: 'bash', toolArgs: { command: `cd "/tmp/repository path" && singularity-flow choices status ${receipt} --json` } }), {});
  const unsafeStart = await personaGuardHook(root, definition, current, { toolName: 'bash', toolArgs: { command: `singularity-flow start HOOK-2 --selection-receipt ${receipt}; rm -rf output` } });
  assert.equal(unsafeStart.permissionDecision, 'deny');
  assert.deepEqual(await personaGuardHook(root, definition, current, { toolName: 'bash', toolArgs: { command: 'singularity-flow inbox --json' } }), {});
  assert.deepEqual(await personaGuardHook(root, definition, current, { toolName: 'bash', toolArgs: { command: 'singularity-flow session candidates --json' } }), {});
  assert.deepEqual(await personaGuardHook(root, definition, current, { toolName: 'bash', toolArgs: { command: 'singularity-flow session attach HOOK-1' } }), {});
  assert.deepEqual(await personaGuardHook(root, definition, current, { toolName: 'bash', toolArgs: { command: 'singularity-flow workspace list --json' } }), {});
  assert.deepEqual(await personaGuardHook(root, definition, current, { toolName: 'bash', toolArgs: { command: 'singularity-flow workspace current --json' } }), {});
  assert.deepEqual(await personaGuardHook(root, definition, current, { toolName: 'bash', toolArgs: { command: 'singularity-flow workspace use payments --repository api --story PAY-12 --json' } }), {});
  const unsafeWorkspace = await personaGuardHook(root, definition, current, { toolName: 'bash', toolArgs: { command: 'singularity-flow workspace use payments; rm -rf output' } });
  assert.equal(unsafeWorkspace.permissionDecision, 'deny');

  for (const allowed of [
    'singularity-flow wm init',
    'singularity-flow wm build',
    'singularity-flow wm build --depth deep --phase requirements --task "Formalize checkout requirements" --focus "payment boundaries" --local',
    'sflow wm build --views architecture,security --focus repository',
    'singularity-flow wm check',
    'singularity-flow wm context requirements --concat --evidence --no-persona'
  ]) {
    assert.deepEqual(
      await personaGuardHook(root, definition, current, { toolName: 'bash', toolArgs: { command: allowed } }),
      {},
      `expected repository-scoped '${allowed}' to be allowed without a work item`
    );
  }
  for (const deniedWorldModel of [
    'singularity-flow wm build --runner "touch /tmp/bypass"',
    'singularity-flow wm build --out /tmp/model',
    'singularity-flow wm compose --phase design --persona architect',
    'singularity-flow wm build; rm -rf output'
  ]) {
    const decision = await personaGuardHook(root, definition, current, {
      toolName: 'bash', toolArgs: { command: deniedWorldModel }
    });
    assert.equal(decision.permissionDecision, 'deny', `expected '${deniedWorldModel}' to remain gated`);
  }

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

test('an initiative branch is a governed session, so the hooks do not demand a work item', async () => {
  const { initializeDefinition } = await import('../src/config.mjs');
  const { createInitiative } = await import('../src/initiative-state.mjs');
  const { run } = await import('../src/util.mjs');
  const YAML = (await import('yaml')).default;
  const { readFile, writeFile } = await import('node:fs/promises');

  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-hook-initiative-'));
  const root = path.join(base, 'app');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(root);
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Owner'], { cwd: root });
  run('git', ['config', 'user.email', 'owner@example.com'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# App\n');
  await initializeDefinition(root);
  const portfolioFile = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
  for (const authority of Object.values(portfolio.approvalAuthorities)) {
    authority.members = [{ name: 'Owner', email: 'owner@example.com' }];
  }
  await writeFile(portfolioFile, YAML.stringify(portfolio));
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const definitionYaml = YAML.parse(await readFile(workflowFile, 'utf8'));
  definitionYaml.worldModel.grounding = 'off';
  await writeFile(workflowFile, YAML.stringify(definitionYaml));
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'init'], { cwd: root });

  const { loadDefinition } = await import('../src/config.mjs');
  const repositoryDefinition = await loadDefinition(root);
  run('git', ['checkout', '-b', 'SF-E900'], { cwd: root });
  await createInitiative(root, { id: 'SF-E900', title: 'Governed epic', profile: 'initiative-lite', persona: 'product-owner' });

  // The shipped policy is workItemSelection: prompt + requireBeforeTools: true. An initiative
  // branch has no work item and never will, so demanding one there starved every governed
  // initiative session — including Copilot Studio, whose whole purpose is composing these phases.
  const started = await sessionStartPersonaHook(root, repositoryDefinition, null, { sessionId: 'sess-1', source: 'startup' });
  assert.match(started.additionalContext, /initiative SF-E900 is active on this branch/);
  assert.match(started.additionalContext, /not a work item/);
  assert.doesNotMatch(started.additionalContext, /work-item selection is required/);

  // Tools must not be denied: lifecycle mutation stays gated by the initiative's own phase,
  // approval, and evidence checks rather than by a selection that cannot be made.
  const guard = await personaGuardHook(root, repositoryDefinition, null, { toolName: 'bash', toolArgs: { command: 'ls' } });
  assert.deepEqual(guard, {});
});

test('reading the activity log survives the gate, but nothing can be smuggled past it', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-hook-logs-'));
  const { run } = await import('../src/util.mjs');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { initializeDefinition, loadDefinition } = await import('../src/config.mjs');
  const root = path.join(base, 'app');
  await mkdir(root);
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Owner'], { cwd: root });
  run('git', ['config', 'user.email', 'owner@example.com'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# App\n');
  await initializeDefinition(root);
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'init'], { cwd: root });
  const repositoryDefinition = await loadDefinition(root);

  const decide = (command) => personaGuardHook(root, repositoryDefinition, null, { toolName: 'bash', toolArgs: { command } });

  // A gated session is exactly when the log matters: it is the only thing that can explain the
  // refusal. Read-only log reads therefore have to pass the guard.
  for (const allowed of [
    'singularity-flow logs',
    'singularity-flow logs --level error',
    'sflow logs --tail 50 --event hook',
    'singularity-flow logs path',
    'singularity-flow logs level --json'
  ]) {
    assert.deepEqual(await decide(allowed), {}, `expected '${allowed}' to be allowed`);
  }

  // The allowance must not become a shell. Values admit no metacharacters, and no other
  // subcommand rides along on the prefix.
  for (const denied of [
    'singularity-flow logs; rm -rf /',
    'singularity-flow logs && curl example.com',
    'singularity-flow logs --event $(whoami)',
    'singularity-flow logs | tee /tmp/out',
    'singularity-flow logs --level error > /tmp/out',
    'singularity-flow logsx',
    'singularity-flow approve'
  ]) {
    const decision = await decide(denied);
    assert.equal(decision.permissionDecision, 'deny', `expected '${denied}' to be denied`);
  }
});
