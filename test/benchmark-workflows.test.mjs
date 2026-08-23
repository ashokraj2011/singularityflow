import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  initializeDefinition, loadDefinition, resolveWorkType, snapshotResolution, validateDefinition
} from '../src/config.mjs';
import { setAgentSession } from '../src/session.mjs';
import { createWorkflow, loadConfig } from '../src/state.mjs';
import { worldModelCommand } from '../src/worldmodel.mjs';
import { applyCapabilityPolicyToWorkResolution } from '../src/capability-context.mjs';
import { requiredStructuralPromptContext } from '../src/structural-prompt-context.mjs';
import { replayAstEvidence } from '../src/ast-replay.mjs';
import { setAstPreference } from '../src/ast-mode.mjs';

const PHASES = ['intake', 'design', 'implementation', 'testing', 'conformance'];

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

test('starter configuration ships comparable Benchmark A and Benchmark B workflows', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-benchmark-workflows-'));
  await initializeDefinition(root);
  const definition = await loadDefinition(root);
  const governed = resolveWorkType(definition, 'benchmarking-a');
  const generic = resolveWorkType(definition, 'benchmarking-b');

  assert.deepEqual(governed.phases.map((phase) => phase.id), PHASES);
  assert.deepEqual(generic.phases.map((phase) => phase.id), PHASES);
  assert.deepEqual(governed.intelligence, {
    worldModel: 'required', ast: 'optional-context', agentBriefs: 'required'
  });
  assert.deepEqual(generic.intelligence, {
    worldModel: 'off', ast: 'off', agentBriefs: 'off'
  });
  assert.equal(governed.worldModelGrounding, 'enforce');
  assert.equal(generic.worldModelGrounding, 'off');

  for (const id of PHASES) {
    const left = governed.phases.find((phase) => phase.id === id);
    const right = generic.phases.find((phase) => phase.id === id);
    assert.equal(left.template, right.template, `${id} must use the same artifact template`);
    assert.deepEqual(left.artifact, right.artifact, `${id} must produce the same artifact contract`);
    assert.deepEqual(left.approval, right.approval, `${id} must use the same approval ceremony`);
    assert.equal(left.defaultAgent, right.defaultAgent, `${id} must use the same governed agent`);
  }
  assert.equal(governed.phases.find((phase) => phase.id === 'testing').defaultAgent, 'qa');
  assert.ok(governed.phases.slice(1).every((phase) =>
    phase.inputs.some((input) => input.projection === 'approved-summary')));
  assert.ok(generic.phases.slice(1).every((phase) =>
    phase.inputs.every((input) => input.projection === undefined)));
  assert.ok(generic.phases.every((phase) => phase.worldModel.views.length === 0));

  const capabilityBoundGeneric = applyCapabilityPolicyToWorkResolution(generic, {
    id: 'benchmark-capability', sourceScope: { sourceRoots: ['src'], sharedRoots: [] },
    policy: { requiredWorldModelViews: ['security'], requiredAuthorityGroups: [] }
  });
  assert.ok(capabilityBoundGeneric.phases.every((phase) => phase.worldModel.views.length === 0));
  assert.equal(capabilityBoundGeneric.worldModelSourceScope, null);

  const governedSnapshot = await snapshotResolution(root, definition, governed);
  const genericSnapshot = await snapshotResolution(root, definition, generic);
  assert.deepEqual(governedSnapshot.intelligence, governed.intelligence);
  assert.deepEqual(genericSnapshot.intelligence, generic.intelligence);
  assert.equal(governedSnapshot.worldModelGrounding, 'enforce');
  assert.equal(genericSnapshot.worldModelGrounding, 'off');
});

test('benchmark intelligence declarations fail closed when their phase inputs disagree', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-benchmark-policy-'));
  await initializeDefinition(root);
  const definition = await loadDefinition(root);

  const missingBrief = structuredClone(definition);
  missingBrief.workTypes['benchmarking-a'].phaseOverrides.design.inputs = ['intake'];
  assert.throws(
    () => validateDefinition(missingBrief),
    /requires approved agent briefs.*design/
  );

  const leakedBrief = structuredClone(definition);
  leakedBrief.workTypes['benchmarking-b'].phaseOverrides.design.inputs = [{
    phase: 'intake', projection: 'approved-summary', fallback: 'whole'
  }];
  assert.throws(
    () => validateDefinition(leakedBrief),
    /disables agent briefs.*design/
  );

  const disabledAst = structuredClone(definition);
  disabledAst.ast.mode = 'off';
  assert.doesNotThrow(() => validateDefinition(disabledAst));
  assert.equal(resolveWorkType(disabledAst, 'benchmarking-b').intelligence.ast, 'off');
});

test('Benchmark B composes a generic governed prompt without a world-model snapshot', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-benchmark-generic-compose-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Benchmark User');
  git(root, 'config', 'user.email', 'benchmark@example.invalid');
  await initializeDefinition(root);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initialize benchmark fixture');
  git(root, 'switch', '-c', 'BENCH-B-1');
  const config = await loadConfig(root);
  config.git.publish = 'off';
  await setAgentSession(root, config, {
    name: 'Benchmark User', email: 'benchmark@example.invalid', login: null
  }, 'product-owner', 'BENCH-B-1', { phaseId: 'intake', source: 'test' });
  const workflow = await createWorkflow(root, config, {
    id: 'BENCH-B-1', title: 'Generic benchmark arm',
    source: {
      type: 'manual', key: 'BENCH-B-1', title: 'Generic benchmark arm',
      description: 'Prove generic composition does not require repository intelligence.',
      acceptanceCriteria: ['Prompt composition succeeds without a world-model directory.']
    },
    baseBranch: 'main', workType: 'benchmarking-b', agent: 'product-owner',
    resolved: resolveWorkType(config, 'benchmarking-b')
  });

  assert.equal(workflow.resolution.worldModelGrounding, 'off');
  const composed = await worldModelCommand(root, ['wm', 'compose'], {
    phase: 'intake', agent: 'product-owner', 'render-only': true,
    out: '.git/benchmark-generic-prompt.md'
  });
  assert.match(composed, /Active Story phase contract: Intake/);
  assert.match(composed, new RegExp('Repository root: `' + root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '`'));
  assert.match(composed, /Work-item directory: `singularity\/work-items\/BENCH-B-1`/);
  assert.match(composed, /Required artifact: `singularity\/work-items\/BENCH-B-1\/artifacts\/intake\/intake\.md`/);
  assert.match(composed, /Never search the filesystem outside this repository/);
  assert.doesNotMatch(composed, /required repository world-model grounding/i);
  assert.doesNotMatch(composed, /Bounded repository structural context/);
});

test('Benchmark A injects a bounded, provenance-bearing AST evidence page', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-benchmark-ast-context-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Benchmark User');
  git(root, 'config', 'user.email', 'benchmark@example.invalid');
  await writeFile(path.join(root, 'service.mjs'), 'export function benchmarkSubject() { return true; }\n');
  await initializeDefinition(root);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initialize benchmark AST fixture');
  const preference = path.join(root, '.git', 'benchmark-ast-preference.json');
  const previousPreference = process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE;
  process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE = preference;
  try {
    const result = await requiredStructuralPromptContext(root, {
      workItem: { id: 'BENCH-A-1', workType: 'benchmarking-a' },
      resolution: { intelligence: { worldModel: 'required', ast: 'required-context', agentBriefs: 'required' } }
    });
    assert.match(result.text, /Bounded repository structural context/);
    assert.match(result.text, /benchmarkSubject/);
    assert.match(result.record.coneSha256, /^[0-9a-f]{64}$/);
    assert.match(result.record.factsSha256, /^[0-9a-f]{64}$/);
    assert.equal(result.record.derivation.replayability, 'replayable');
    const derivation = JSON.parse(await readFile(path.join(root, result.record.derivation.path), 'utf8'));
    assert.equal(derivation.subject.evidenceClass, 'recorded-context');
    assert.equal(derivation.outputs.page.factsSha256, result.record.factsSha256);
    const replay = await replayAstEvidence(root, { receipt: result.record.derivation.path });
    assert.equal(replay.result, 'identical', JSON.stringify(replay, null, 2));
    assert.equal(result.record.engine, 'singularity-flow-ast-broker');
    assert.ok(result.record.factsReturned > 0);
  } finally {
    if (previousPreference == null) delete process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE;
    else process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE = previousPreference;
  }
});

test('AST off degrades an explicitly selected structural-context operation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-benchmark-ast-disabled-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Benchmark User');
  git(root, 'config', 'user.email', 'benchmark@example.invalid');
  await initializeDefinition(root);
  const preference = path.join(root, '.git', 'benchmark-ast-preference.json');
  const previousPreference = process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE;
  process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE = preference;
  try {
    await setAstPreference('off');
    const governed = await requiredStructuralPromptContext(root, {
      workItem: { id: 'BENCH-A-OFF', workType: 'benchmarking-a' },
      resolution: { intelligence: { worldModel: 'required', ast: 'optional-context', agentBriefs: 'required' } }
    });
    assert.equal(governed.text, '');
    assert.equal(governed.record, null);
    assert.match(governed.warnings.join('\n'), /ordinary repository file access/);
    const generic = await requiredStructuralPromptContext(root, {
      workItem: { id: 'BENCH-B-OFF', workType: 'benchmarking-b' },
      resolution: { intelligence: { worldModel: 'off', ast: 'off', agentBriefs: 'off' } }
    });
    assert.equal(generic.text, '');
    assert.equal(generic.record, null);
  } finally {
    if (previousPreference == null) delete process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE;
    else process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE = previousPreference;
  }
});
