import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { buildGenerationAuthorship, importManualArtifact, normalizeAuthorshipOptions } from '../src/manual-authorship.mjs';
import { withOperationContext } from '../src/operation-context.mjs';
import { setAgentSession } from '../src/session.mjs';
import { createWorkflow, loadConfig, publishGeneration, submitPhase } from '../src/state.mjs';
import { verifyAstLifecycleReceipt } from '../src/ast-lifecycle.mjs';
import { recordSha256 } from '../src/records.mjs';

const ACTOR = { name: 'AST Lifecycle', email: 'ast-lifecycle@example.invalid', login: null };

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

async function fixture({ predicatePath = 'README.md' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-ast-lifecycle-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', ACTOR.name);
  git(root, 'config', 'user.email', ACTOR.email);
  await writeFile(path.join(root, 'README.md'), '# AST lifecycle fixture\n');
  await initializeDefinition(root);
  const definitionPath = path.join(root, 'singularity', 'workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.worldModel.sourceRoots = ['README.md'];
  definition.ast.predicates = [{
    id: 'required-path', mode: 'required', type: 'path-exists', path: predicatePath,
    minimumAssurance: 'text'
  }];
  await writeFile(definitionPath, YAML.stringify(definition));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initialize AST lifecycle fixture');
  git(root, 'switch', '-c', 'AST-1');

  const preference = path.join(root, '.ast-preference.json');
  process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE = preference;
  const config = await loadConfig(root);
  config.git.publish = 'off';
  const resolved = resolveWorkType(config, 'feature');
  resolved.phases = [{
    ...resolved.phases[0], order: 0,
    approval: { mode: 'none', authorities: [], minimum: 0, rejectTo: ['intake'] }
  }];
  await setAgentSession(root, config, ACTOR, 'developer', 'AST-1', { phaseId: 'intake', source: 'test' });
  const workflow = await createWorkflow(root, config, {
    id: 'AST-1', title: 'Enforce structural lifecycle policy',
    source: {
      type: 'manual', key: 'AST-1', title: 'Enforce structural lifecycle policy',
      description: 'Prove that structural predicates participate in publication and submission.',
      acceptanceCriteria: ['Required structural policy is fail closed.']
    },
    baseBranch: 'main', workType: 'feature', agent: 'developer', resolved
  });
  const phase = workflow.phases.intake;
  const target = path.join(root, 'singularity', 'work-items', 'AST-1', phase.requiredArtifact.path);
  const source = path.join(root, 'authored-intake.md');
  await writeFile(source, [
    '# Intake', '', '## Problem', '',
    'Structural policy previously existed only behind a manually invoked diagnostic command.', '',
    '## Outcome', '',
    'Publication and submission verify a content-bound structural receipt before lifecycle state changes.', '',
    '## Acceptance criteria', '', '- Required predicates fail closed.', '- Receipt integrity is governed.'
  ].join('\n'));
  const imported = await importManualArtifact({ sourcePath: source, targetPath: target, contract: phase.requiredArtifact });
  await rm(source);
  const authorship = buildGenerationAuthorship({
    options: normalizeAuthorshipOptions({ producer: 'human', channel: 'manual-import', imported: true, externalAiUse: 'none' }),
    actor: ACTOR, governedAgentContext: 'developer', source: imported
  });
  return { root, config, workflow, phase, authorship };
}

function inContext(root, run) {
  return withOperationContext({
    operation: { id: 'test.ast-lifecycle', command: 'test', modelPolicy: 'never' },
    modelMode: { enabled: false, source: 'test' }, root, command: 'test'
  }, run);
}

test('a required AST predicate refuses publication before generation mutation', async () => {
  const { root, config, workflow, phase, authorship } = await fixture({ predicatePath: 'missing.ts' });
  await inContext(root, async () => {
    const before = JSON.stringify(phase);
    await assert.rejects(
      () => publishGeneration(root, config, workflow, { phaseId: phase.id, authorship }),
      (error) => error?.code === 'AST_LIFECYCLE_GATE_BLOCKED' && /required-path/.test(error.message)
    );
    assert.equal(JSON.stringify(phase), before);
    assert.equal(phase.generation, 0);
    assert.equal(phase.astGates, undefined);
  });
});

test('an explicit generic intelligence profile skips repository AST lifecycle gates', async () => {
  const { root, config, workflow, phase, authorship } = await fixture({ predicatePath: 'missing.ts' });
  workflow.resolution.intelligence = { worldModel: 'off', ast: 'off', agentBriefs: 'off' };
  await inContext(root, async () => {
    await publishGeneration(root, config, workflow, { phaseId: phase.id, authorship });
    assert.equal(phase.generation, 1);
    assert.equal(phase.astGates, undefined);
  });
});

test('publication records an AST receipt and submission verifies its exact relevant bytes', async () => {
  const { root, config, workflow, phase, authorship } = await fixture();
  await inContext(root, async () => {
    await publishGeneration(root, config, workflow, { phaseId: phase.id, authorship });
    assert.equal(phase.generation, 1);
    assert.equal(phase.astGates.length, 1);
    const summary = phase.astGates[0];
    const receipt = JSON.parse(await readFile(path.join(root, summary.path), 'utf8'));
    assert.equal(receipt.allowed, true);
    assert.deepEqual(receipt.engine, { id: 'singularity-flow-ast-broker', version: 2 });
    assert.deepEqual(receipt.extractors, [{ id: 'builtin-text', version: 1, assurance: 'text' }]);
    assert.equal(receipt.predicates[0].outcome, 'pass');
    assert.deepEqual(receipt.predicates[0].extractors, receipt.extractors);

    git(root, 'add', 'singularity');
    git(root, 'commit', '-m', '[AST-1][phase:intake][generated:1] publish AST receipt');
    assert.doesNotThrow(() => git(root, 'cat-file', '-e', `HEAD:${summary.path}`));
    const committed = await verifyAstLifecycleReceipt(root, config, workflow, phase, {
      generation: phase.generation, revalidate: false, sourceCommit: git(root, 'rev-parse', 'HEAD')
    });
    assert.deepEqual(committed.errors, []);
    assert.match(committed.passes[0], /generation commit/);
    await submitPhase(root, config, workflow, { phaseId: phase.id, runChecks: false });
    assert.equal(workflow.status, 'complete');
  });
});

test('submission refuses when a relevant file changes after the AST receipt was published', async () => {
  const { root, config, workflow, phase, authorship } = await fixture();
  await inContext(root, async () => {
    await publishGeneration(root, config, workflow, { phaseId: phase.id, authorship });
    git(root, 'add', 'singularity');
    git(root, 'commit', '-m', '[AST-1][phase:intake][generated:1] publish AST receipt');
    await writeFile(path.join(root, 'README.md'), '# Relevant bytes changed after publication\n');
    const historical = await verifyAstLifecycleReceipt(root, config, workflow, phase, {
      generation: phase.generation, revalidate: false
    });
    assert.deepEqual(historical.errors, [], 'the committed historical receipt remains valid evidence');
    await assert.rejects(
      () => submitPhase(root, config, workflow, { phaseId: phase.id, runChecks: false }),
      (error) => error?.code === 'AST_LIFECYCLE_RECEIPT_INVALID' && /relevant file bytes changed/.test(error.message)
    );
    assert.equal(phase.status, 'in_progress');
    assert.equal(phase.generationCommit, undefined);
  });
});

test('submission refuses a validly rehashed receipt from a different broker or extractor version', async () => {
  const { root, config, workflow, phase, authorship } = await fixture();
  await inContext(root, async () => {
    await publishGeneration(root, config, workflow, { phaseId: phase.id, authorship });
    const summary = phase.astGates[0];
    const receipt = JSON.parse(await readFile(path.join(root, summary.path), 'utf8'));
    receipt.engine.version += 1;
    receipt.extractors[0].version += 1;
    receipt.predicates[0].extractors[0].version += 1;
    const { integritySha256: _oldIntegrity, ...payload } = receipt;
    receipt.integritySha256 = recordSha256(payload);
    summary.sha256 = receipt.integritySha256;
    await writeFile(path.join(root, summary.path), `${JSON.stringify(receipt, null, 2)}\n`);

    const verification = await verifyAstLifecycleReceipt(root, config, workflow, phase);
    assert.match(verification.errors.join('\n'), /broker engine changed/);
    assert.match(verification.errors.join('\n'), /extractor identity, version, or assurance changed/);
    await assert.rejects(
      () => submitPhase(root, config, workflow, { phaseId: phase.id, runChecks: false }),
      (error) => error?.code === 'AST_LIFECYCLE_RECEIPT_INVALID'
        && /broker engine changed/.test(error.message)
        && /extractor identity, version, or assurance changed/.test(error.message)
    );
    assert.equal(phase.status, 'in_progress');
  });
});
