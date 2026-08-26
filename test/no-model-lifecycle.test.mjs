import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { buildGenerationAuthorship, importManualArtifact, normalizeAuthorshipOptions } from '../src/manual-authorship.mjs';
import { withOperationContext } from '../src/operation-context.mjs';
import { setAgentSession } from '../src/session.mjs';
import { commitAndPublish, createWorkflow, loadConfig, publishGeneration, submitPhase } from '../src/state.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

test('a Story can complete through manual authorship with model mode disabled', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-no-model-lifecycle-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Manual Author');
  git(root, 'config', 'user.email', 'manual@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# Model-independent lifecycle\n');
  await initializeDefinition(root);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initialize repository');
  git(root, 'switch', '-c', 'MANUAL-1');

  const config = await loadConfig(root);
  config.git.publish = 'off';
  const resolved = resolveWorkType(config, 'feature');
  resolved.phases = [{
    ...resolved.phases[0],
    order: 0,
    approval: { mode: 'none', authorities: [], minimum: 0, rejectTo: ['intake'] }
  }];
  const actor = { name: 'Manual Author', email: 'manual@example.invalid', login: null };
  await setAgentSession(root, config, actor, 'developer', 'MANUAL-1', { phaseId: 'intake', source: 'test' });

  await withOperationContext({
    operation: { id: 'test.manual-lifecycle', command: 'test', modelPolicy: 'never' },
    modelMode: { enabled: false, source: 'test' },
    root,
    command: 'test'
  }, async () => {
    const workflow = await createWorkflow(root, config, {
      id: 'MANUAL-1',
      title: 'Complete without a kernel model',
      source: { type: 'manual', key: 'MANUAL-1', title: 'Complete without a kernel model', description: 'Use reviewed human-authored evidence.', acceptanceCriteria: ['The lifecycle completes without a model invocation.'] },
      baseBranch: 'main',
      workType: 'feature',
      agent: 'developer',
      resolved
    });
    const phase = workflow.phases.intake;
    const target = path.join(root, 'singularity', 'work-items', 'MANUAL-1', phase.requiredArtifact.path);
    const source = path.join(root, 'manual-intake.md');
    await writeFile(source, `# Intake\n\n## Problem\n\nProve that a governed Story can complete without a kernel model call.\n\n## Outcome\n\nThe human-authored artifact is validated, published, and deterministically accepted.\n\n## Acceptance criteria\n\n- No model provider is invoked.\n- Authorship remains explicit and auditable.\n`);
    const imported = await importManualArtifact({ sourcePath: source, targetPath: target, contract: phase.requiredArtifact });
    await rm(source);
    const authorship = buildGenerationAuthorship({
      options: normalizeAuthorshipOptions({ producer: 'human', channel: 'manual-import', imported: true, externalAiUse: 'none' }),
      actor,
      governedAgentContext: 'developer',
      source: imported
    });
    await commitAndPublish(
      root,
      config,
      workflow,
      { type: 'artifact-generated', phaseId: 'intake', generation: 1 },
      '[MANUAL-1][phase:intake][generated:1] publish manual artifact',
      [path.relative(root, target).replaceAll(path.sep, '/')],
      {
        beforeStateWrite: (publicationEvent, transactionContext) => publishGeneration(root, config, workflow, {
          phaseId: 'intake', authorship, persist: false,
          publicationTransaction: {
            publicationEvent,
            transactionId: transactionContext.transactionId,
            expectedHead: transactionContext.expectedHead
          }
        })
      }
    );
    await submitPhase(root, config, workflow, { phaseId: 'intake', runChecks: false });

    assert.equal(workflow.status, 'complete');
    assert.equal(workflow.currentPhase, null);
    assert.equal(workflow.phases.intake.status, 'approved');
    assert.equal(workflow.phases.intake.authorship.at(-1).producer, 'human');
    assert.equal(workflow.phases.intake.authorship.at(-1).kernelModel.invoked, false);
    assert.equal(workflow.usage.records, 0);
    const telemetry = JSON.parse(await readFile(path.join(root, workflow.phases.intake.telemetry[0].path), 'utf8'));
    assert.equal(workflow.phases.intake.telemetry[0].status, 'not-invoked');
    assert.equal(telemetry.source, 'not-invoked');
    assert.deepEqual(telemetry.usage, []);
  });
});
