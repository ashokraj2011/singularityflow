import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { buildGenerationAuthorship, importManualArtifact, normalizeAuthorshipOptions } from '../src/manual-authorship.mjs';
import { withOperationContext } from '../src/operation-context.mjs';
import { setAgentSession } from '../src/session.mjs';
import {
  commitAndPublish, createWorkflow, loadConfig, loadWorkflow, publishGeneration, submitPhase,
  storyWelEnrollmentStatus, validateWorkflow
} from '../src/state.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

test('a migrated pre-anchor Story is not reported as policy tampering', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-legacy-policy-anchor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Legacy Author');
  git(root, 'config', 'user.email', 'legacy@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# Legacy policy anchor compatibility\n');
  await initializeDefinition(root);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initialize repository');
  git(root, 'switch', '-c', 'LEGACY-1');

  const config = await loadConfig(root);
  config.git.publish = 'off';
  const actor = { name: 'Legacy Author', email: 'legacy@example.invalid', login: null };
  await setAgentSession(root, config, actor, 'developer', 'LEGACY-1', {
    phaseId: 'intake', source: 'test'
  });
  await createWorkflow(root, config, {
    id: 'LEGACY-1',
    title: 'Continue a Story created before policy anchors',
    source: {
      type: 'manual', key: 'LEGACY-1', title: 'Continue a Story created before policy anchors',
      description: 'Exercise schema migration without inventing a policy receipt.',
      acceptanceCriteria: ['The migrated Story remains usable.']
    },
    baseBranch: 'main',
    workType: 'feature',
    agent: 'developer'
  });

  const workflowFile = path.join(root, config.workItemRoot, 'LEGACY-1', 'workflow.json');
  const legacy = JSON.parse(await readFile(workflowFile, 'utf8'));
  legacy.schemaVersion = 1;
  delete legacy.resolution.policySha256;
  // These fields are supplied by storyWorkflowV1ToV2. Their absence proves this is exercising a
  // migrated creation record rather than merely a current record with its anchor deleted.
  for (const field of ['workType', 'workTypeLabel', 'sequenceGates', 'session', 'contextPolicy', 'templates', 'phases']) {
    delete legacy.resolution[field];
  }
  await writeFile(workflowFile, `${JSON.stringify(legacy, null, 2)}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'legacy Story creation');

  const migrated = await loadWorkflow(root, config, 'LEGACY-1');
  assert.equal(migrated.schemaVersion, currentSchemaVersion('story-workflow'));
  assert.equal(migrated.resolution.policySha256, undefined);
  const validation = await validateWorkflow(root, config, migrated);
  assert.equal(validation.errors.some((message) =>
    /immutable creation policy|operational policy differs/.test(message)), false,
  validation.errors.join('\n'));

  git(root, 'switch', 'main');
  git(root, 'switch', '-c', 'ANCHOR-BAD-1');
  await setAgentSession(root, config, actor, 'developer', 'ANCHOR-BAD-1', {
    phaseId: 'intake', source: 'test'
  });
  await createWorkflow(root, config, {
    id: 'ANCHOR-BAD-1',
    title: 'Refuse a false creation anchor',
    source: {
      type: 'manual', key: 'ANCHOR-BAD-1', title: 'Refuse a false creation anchor',
      description: 'Bind the policy receipt to the creation bytes.',
      acceptanceCriteria: ['A mismatched creation digest is refused.']
    },
    baseBranch: 'main',
    workType: 'feature',
    agent: 'developer'
  });
  const anchoredFile = path.join(root, config.workItemRoot, 'ANCHOR-BAD-1', 'workflow.json');
  const falselyAnchored = JSON.parse(await readFile(anchoredFile, 'utf8'));
  falselyAnchored.resolution.workTypeLabel = 'Manually weakened after receipt creation';
  await writeFile(anchoredFile, `${JSON.stringify(falselyAnchored, null, 2)}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'tampered anchored Story creation');

  const tampered = await loadWorkflow(root, config, 'ANCHOR-BAD-1');
  const tamperedValidation = await validateWorkflow(root, config, tampered);
  assert.equal(tamperedValidation.valid, false);
  assert.ok(tamperedValidation.errors.some((message) =>
    /creation policy anchor .* does not match its committed resolution bytes/.test(message)),
  tamperedValidation.errors.join('\n'));

  git(root, 'switch', 'main');
  git(root, 'switch', '-c', 'ANCHOR-MALFORMED-1');
  await setAgentSession(root, config, actor, 'developer', 'ANCHOR-MALFORMED-1', {
    phaseId: 'intake', source: 'test'
  });
  await createWorkflow(root, config, {
    id: 'ANCHOR-MALFORMED-1',
    title: 'Keep WEL classification separate from policy validation',
    source: {
      type: 'manual', key: 'ANCHOR-MALFORMED-1',
      title: 'Keep WEL classification separate from policy validation',
      description: 'A malformed creation anchor is legacy for WEL and invalid for lifecycle policy.',
      acceptanceCriteria: ['Classification does not weaken the immutable policy gate.']
    },
    baseBranch: 'main',
    workType: 'feature',
    agent: 'developer'
  });
  const malformedFile = path.join(root, config.workItemRoot, 'ANCHOR-MALFORMED-1', 'workflow.json');
  const malformed = JSON.parse(await readFile(malformedFile, 'utf8'));
  malformed.resolution.policySha256 = 'not-a-policy-digest';
  await writeFile(malformedFile, `${JSON.stringify(malformed, null, 2)}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'malformed anchored Story creation');

  const classification = storyWelEnrollmentStatus(root, config, 'ANCHOR-MALFORMED-1');
  assert.equal(classification.classification, 'legacy');
  assert.equal(classification.reason, 'creation-anchor-malformed');
  const malformedWorkflow = await loadWorkflow(root, config, 'ANCHOR-MALFORMED-1');
  const malformedValidation = await validateWorkflow(root, config, malformedWorkflow);
  assert.equal(malformedValidation.valid, false);
  assert.ok(malformedValidation.errors.some((message) =>
    /creation policy anchor .* is malformed/.test(message)), malformedValidation.errors.join('\n'));
});

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
    const governedScope = phase.writeScope;
    phase.writeScope = governedScope === 'artifact-only' ? 'source-and-artifact' : 'artifact-only';
    const tampered = await validateWorkflow(root, config, workflow);
    assert.equal(tampered.valid, false);
    assert.ok(tampered.errors.some((message) =>
      /operational policy differs from the immutable profile snapshot/.test(message)));
    phase.writeScope = governedScope;
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
