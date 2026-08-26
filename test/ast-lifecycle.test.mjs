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
import { commitAndPublish, createWorkflow, loadConfig, publishGeneration, submitPhase } from '../src/state.mjs';
import { verifyAstLifecycleReceipt } from '../src/ast-lifecycle.mjs';
import { setAstPreference } from '../src/ast-mode.mjs';

const ACTOR = { name: 'AST Lifecycle', email: 'ast-lifecycle@example.invalid', login: null };

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

async function fixture({
  predicatePath = 'README.md', predicateSymbol = null, predicateMode = 'required', astMode = 'auto'
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-ast-lifecycle-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', ACTOR.name);
  git(root, 'config', 'user.email', ACTOR.email);
  await writeFile(path.join(root, 'README.md'), '# AST lifecycle fixture\n');
  if (predicateSymbol) await writeFile(path.join(root, 'Payment.java'), `public class ${predicateSymbol} {}\n`);
  await initializeDefinition(root);
  const definitionPath = path.join(root, 'singularity', 'workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.worldModel.sourceRoots = predicateSymbol ? ['Payment.java'] : ['README.md'];
  definition.ast.mode = astMode;
  definition.ast.predicates = [predicateSymbol ? {
    id: 'required-symbol', mode: predicateMode, type: 'symbol-exists', symbol: predicateSymbol,
    minimumAssurance: 'syntax'
  } : {
    id: 'required-path', mode: predicateMode, type: 'path-exists', path: predicatePath,
    minimumAssurance: 'text'
  }];
  await writeFile(definitionPath, YAML.stringify(definition));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initialize AST lifecycle fixture');
  git(root, 'switch', '-c', 'AST-1');

  const preference = path.join(root, '.git', 'ast-preference.json');
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

async function publishGoverned(root, config, workflow, phase, authorship) {
  const generation = Number(phase.generation) + 1;
  return commitAndPublish(
    root,
    config,
    workflow,
    { type: 'artifact-generated', phaseId: phase.id, generation },
    `[${workflow.workItem.id}][phase:${phase.id}][generated:${generation}] publish`,
    (phase.artifacts ?? []).map((artifact) => artifact.path),
    {
      beforeStateWrite: (publicationEvent, transactionContext) => publishGeneration(root, config, workflow, {
        phaseId: phase.id,
        authorship,
        persist: false,
        publicationTransaction: {
          publicationEvent,
          transactionId: transactionContext.transactionId,
          expectedHead: transactionContext.expectedHead
        }
      })
    }
  );
}

test('a required AST predicate remains an optional diagnostic during publication', async () => {
  const { root, config, workflow, phase, authorship } = await fixture({ predicatePath: 'missing.ts' });
  await inContext(root, async () => {
    await publishGeneration(root, config, workflow, { phaseId: phase.id, authorship });
    assert.equal(phase.generation, 1);
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

test('repository AST off bypasses required predicates without invalidating workflow configuration', async () => {
  const { root, config, workflow, phase, authorship } = await fixture({
    predicatePath: 'missing.ts', astMode: 'off'
  });
  await inContext(root, async () => {
    await publishGeneration(root, config, workflow, { phaseId: phase.id, authorship });
    assert.equal(phase.generation, 1);
    assert.equal(phase.astGates, undefined);
  });
});

test('local AST off is an escape hatch from required repository predicates', async () => {
  const { root, config, workflow, phase, authorship } = await fixture({ predicatePath: 'missing.ts' });
  await setAstPreference('off');
  await inContext(root, async () => {
    await publishGeneration(root, config, workflow, { phaseId: phase.id, authorship });
    assert.equal(phase.generation, 1);
    assert.equal(phase.astGates, undefined);
  });
});

test('advisory AST predicates never become lifecycle blockers', async () => {
  const { root, config, workflow, phase, authorship } = await fixture({
    predicatePath: 'missing.ts', predicateMode: 'advisory'
  });
  await inContext(root, async () => {
    await publishGeneration(root, config, workflow, { phaseId: phase.id, authorship });
    assert.equal(phase.generation, 1);
    assert.equal(phase.astGates, undefined);
  });
});

test('publication and submission never require an AST receipt', async () => {
  const { root, config, workflow, phase, authorship } = await fixture();
  await inContext(root, async () => {
    await publishGoverned(root, config, workflow, phase, authorship);
    assert.equal(phase.generation, 1);
    assert.equal(phase.astGates, undefined);

    const committed = await verifyAstLifecycleReceipt(root, config, workflow, phase, {
      generation: phase.generation, revalidate: false, sourceCommit: git(root, 'rev-parse', 'HEAD')
    });
    assert.equal(committed.applies, false);
    assert.equal(committed.reason, 'optional-diagnostic');
    assert.deepEqual(committed.errors, []);
    await submitPhase(root, config, workflow, { phaseId: phase.id, runChecks: false });
    assert.equal(workflow.status, 'complete');
  });
});

test('unavailable required syntax assurance cannot block publication', async () => {
  const { root, config, workflow, phase, authorship } = await fixture({ predicateSymbol: 'PaymentService' });
  await inContext(root, async () => {
    await publishGeneration(root, config, workflow, { phaseId: phase.id, authorship });
    assert.equal(phase.generation, 1);
    assert.equal(phase.astGates, undefined);
  });
});

test('source changes do not create an AST receipt prerequisite at submission', async () => {
  const { root, config, workflow, phase, authorship } = await fixture();
  await inContext(root, async () => {
    await publishGoverned(root, config, workflow, phase, authorship);
    await writeFile(path.join(root, 'README.md'), '# Relevant bytes changed after publication\n');
    const historical = await verifyAstLifecycleReceipt(root, config, workflow, phase, {
      generation: phase.generation, revalidate: false
    });
    assert.equal(historical.applies, false);
    assert.deepEqual(historical.errors, []);
    await submitPhase(root, config, workflow, { phaseId: phase.id, runChecks: false });
    assert.equal(workflow.status, 'complete');
  });
});

test('legacy or corrupt AST receipt summaries are ignored by lifecycle submission', async () => {
  const { root, config, workflow, phase, authorship } = await fixture();
  await inContext(root, async () => {
    phase.astGates = [{ generation: 1, path: '../invalid', sha256: 'f'.repeat(64) }];
    await publishGoverned(root, config, workflow, phase, authorship);

    const verification = await verifyAstLifecycleReceipt(root, config, workflow, phase);
    assert.equal(verification.applies, false);
    assert.deepEqual(verification.errors, []);
    await submitPhase(root, config, workflow, { phaseId: phase.id, runChecks: false });
    assert.equal(workflow.status, 'complete');
  });
});
