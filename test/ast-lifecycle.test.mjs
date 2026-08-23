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
import { setAstPreference } from '../src/ast-mode.mjs';
import { replayAstEvidence } from '../src/ast-replay.mjs';
import { recordSha256 } from '../src/records.mjs';
import { astEvidenceReplayPlanner } from '../src/gateway/planners/ast-intelligence.mjs';

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

test('publication records an AST receipt and submission verifies its exact relevant bytes', async () => {
  const { root, config, workflow, phase, authorship } = await fixture();
  await inContext(root, async () => {
    await publishGeneration(root, config, workflow, { phaseId: phase.id, authorship });
    assert.equal(phase.generation, 1);
    assert.equal(phase.astGates.length, 1);
    const summary = phase.astGates[0];
    const receipt = JSON.parse(await readFile(path.join(root, summary.path), 'utf8'));
    assert.equal(receipt.allowed, true);
    assert.equal(receipt.schemaVersion, 3);
    assert.equal(receipt.derivation.replayability, 'replayable');
    const derivation = JSON.parse(await readFile(path.join(root, receipt.derivation.path), 'utf8'));
    assert.equal(derivation.engine.version, 3);
    assert.equal(derivation.adapter.id, 'builtin-text');
    assert.match(summary.provenanceLine, /^AST evidence replayable/);
    assert.doesNotMatch(JSON.stringify(derivation), /sourceBody|bytesBase64|sflow-ast-lifecycle-/);
    assert.equal(receipt.predicates[0].outcome, 'pass');
    assert.equal(receipt.predicates[0].derivationSha256, receipt.derivation.sha256);

    await rm(path.join(root, '.git', 'singularity-flow', 'ast'), { recursive: true, force: true });
    const replay = await replayAstEvidence(root, { receipt: summary.path });
    assert.equal(replay.result, 'identical');
    const gatewayReplay = await astEvidenceReplayPlanner({
      root, subject: { kind: 'work-item', id: 'AST-1' }, arguments: { receipt: summary.path }
    });
    assert.equal(gatewayReplay.data.ast.result, 'identical');
    await rm(path.join(
      root, '.singularity-flow', 'ast-evidence-store', 'bundles',
      `${derivation.retention.bundleSha256}.json`
    ));
    const unavailable = await replayAstEvidence(root, { receipt: summary.path });
    assert.equal(unavailable.result, 'unavailable');
    assert.equal(unavailable.reasons[0].code, 'toolchain-bundle-missing');

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

test('the bundled polyglot preview cannot publish a required syntax gate', async () => {
  const { root, config, workflow, phase, authorship } = await fixture({ predicateSymbol: 'PaymentService' });
  await inContext(root, async () => {
    await assert.rejects(
      () => publishGeneration(root, config, workflow, { phaseId: phase.id, authorship }),
      (error) => error?.code === 'AST_LIFECYCLE_GATE_BLOCKED' && /required-symbol/.test(error.message)
    );
    assert.equal(phase.generation, 0);
    assert.equal(phase.astGates, undefined);
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
      (error) => error?.code === 'AST_LIFECYCLE_RECEIPT_INVALID' && /exact committed inputs/.test(error.message)
    );
    assert.equal(phase.status, 'in_progress');
    assert.equal(phase.generationCommit, undefined);
  });
});

test('submission refuses a validly rehashed receipt with a different derivation reference', async () => {
  const { root, config, workflow, phase, authorship } = await fixture();
  await inContext(root, async () => {
    await publishGeneration(root, config, workflow, { phaseId: phase.id, authorship });
    const summary = phase.astGates[0];
    const receipt = JSON.parse(await readFile(path.join(root, summary.path), 'utf8'));
    receipt.derivation.sha256 = 'f'.repeat(64);
    const { integritySha256: _oldIntegrity, ...payload } = receipt;
    receipt.integritySha256 = recordSha256(payload);
    summary.sha256 = receipt.integritySha256;
    await writeFile(path.join(root, summary.path), `${JSON.stringify(receipt, null, 2)}\n`);

    const verification = await verifyAstLifecycleReceipt(root, config, workflow, phase);
    assert.match(verification.errors.join('\n'), /derivation integrity/);
    await assert.rejects(
      () => submitPhase(root, config, workflow, { phaseId: phase.id, runChecks: false }),
      (error) => error?.code === 'AST_LIFECYCLE_RECEIPT_INVALID'
        && /derivation integrity/.test(error.message)
    );
    assert.equal(phase.status, 'in_progress');
  });
});
