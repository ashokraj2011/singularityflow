import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { buildGenerationAuthorship, normalizeAuthorshipOptions } from '../src/manual-authorship.mjs';
import { withOperationContext } from '../src/operation-context.mjs';
import { setAgentSession } from '../src/session.mjs';
import { createWorkflow, loadConfig, publishGeneration, scanArtifacts } from '../src/state.mjs';

const ACTOR = { name: 'Template Author', email: 'author@example.invalid', login: null };

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

async function fixture(name) {
  const root = await mkdtemp(path.join(os.tmpdir(), `sflow-publication-preflight-${name}-`));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', ACTOR.name);
  git(root, 'config', 'user.email', ACTOR.email);
  await writeFile(path.join(root, 'README.md'), '# Publication preflight\n');
  await initializeDefinition(root);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initialize repository');
  git(root, 'switch', '-c', 'PREFLIGHT-1');

  const config = await loadConfig(root);
  config.git.publish = 'off';
  const resolved = resolveWorkType(config, 'feature');
  resolved.phases = [{
    ...resolved.phases[0],
    order: 0,
    clarification: { ...resolved.phases[0].clarification, mode: 'off' },
    approval: { mode: 'none', authorities: [], minimum: 0, rejectTo: ['intake'] }
  }];
  await setAgentSession(root, config, ACTOR, 'product-owner', 'PREFLIGHT-1', { phaseId: 'intake', source: 'test' });
  const workflow = await createWorkflow(root, config, {
    id: 'PREFLIGHT-1',
    title: 'Refuse an untouched template before publication mutation',
    source: {
      type: 'manual', key: 'PREFLIGHT-1', title: 'Refuse an untouched template before publication mutation',
      description: 'Keep template instructions out of governed generations.',
      acceptanceCriteria: ['Publication refuses an untouched prepared artifact.']
    },
    baseBranch: 'main',
    workType: 'feature',
    agent: 'product-owner',
    resolved
  });
  const phase = workflow.phases.intake;
  const target = path.join(root, 'singularity', 'work-items', 'PREFLIGHT-1', phase.requiredArtifact.path);
  const statePath = path.join(root, 'singularity', 'work-items', 'PREFLIGHT-1', 'workflow.json');
  return { root, config, workflow, phase, target, statePath };
}

async function codeFixture(name, { acceptance = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), `sflow-code-delivery-${name}-`));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', ACTOR.name);
  git(root, 'config', 'user.email', ACTOR.email);
  await writeFile(path.join(root, 'pom.xml'), '<project><artifactId>delivery</artifactId></project>\n');
  await initializeDefinition(root);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initialize repository');
  git(root, 'switch', '-c', 'DELIVERY-1');

  const config = await loadConfig(root);
  config.git.publish = 'off';
  const resolved = resolveWorkType(config, 'feature');
  const implementation = resolved.phases.find((phase) => phase.id === 'implementation');
  resolved.phases = [{
    ...implementation,
    order: 0,
    inputs: [],
    clarification: { ...implementation.clarification, mode: 'off' },
    approval: { mode: 'none', authorities: [], minimum: 0, rejectTo: ['implementation'] }
  }];
  await setAgentSession(root, config, ACTOR, 'developer', 'DELIVERY-1', { phaseId: 'implementation', source: 'test' });
  const workflow = await createWorkflow(root, config, {
    id: 'DELIVERY-1',
    title: 'Require source and acceptance tests',
    source: {
      type: 'manual', key: 'DELIVERY-1', title: 'Require source and acceptance tests',
      description: 'A code phase must not publish an artifact-only result.',
      acceptanceCriteria: ['Changed source and tests are both required.']
    },
    baseBranch: 'main',
    workType: 'feature',
    agent: 'developer',
    resolved
  });
  const phase = workflow.phases.implementation;
  const item = path.join(root, 'singularity', 'work-items', 'DELIVERY-1');
  const target = path.join(item, phase.requiredArtifact.path);
  await writeFile(target, '# Implementation\n\nImplemented source and acceptance tests with deterministic validation evidence.\n');

  if (acceptance) {
    const requirementsPath = path.join(item, 'artifacts', 'requirements', 'requirements.md');
    await mkdir(path.dirname(requirementsPath), { recursive: true });
    await writeFile(requirementsPath, '# Requirements\n\nThe delivery is covered by [DELIVERY-1:AC-001].\n');
    workflow.phases.requirements = {
      id: 'requirements', status: 'approved', generation: 1,
      requiredArtifact: { path: 'artifacts/requirements/requirements.md', kind: 'requirements' },
      artifacts: [], approvals: [], qualityCommands: []
    };
    workflow.phaseOrder = ['requirements', 'implementation'];
  }
  return { root, config, workflow, phase, target };
}

function inContext(root, run) {
  return withOperationContext({
    operation: { id: 'test.publication-preflight', command: 'test', modelPolicy: 'never' },
    modelMode: { enabled: false, source: 'test' },
    root,
    command: 'test'
  }, run);
}

const AUTHORSHIP = buildGenerationAuthorship({
  options: normalizeAuthorshipOptions({ producer: 'human', channel: 'manual-in-place', externalAiUse: 'none' }),
  actor: ACTOR,
  governedAgentContext: 'product-owner',
  source: null
});

test('an untouched prepared template is refused before publication mutates phase state', async () => {
  const { root, config, workflow, phase, target, statePath } = await fixture('placeholder');
  await inContext(root, async () => {
    assert.match(await readFile(target, 'utf8'), /TODO/);
    const phaseBefore = JSON.stringify(phase);
    const stateBefore = await readFile(statePath, 'utf8');
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(String(message));
    try {
      await assert.rejects(
        () => publishGeneration(root, config, workflow, { phaseId: 'intake', authorship: AUTHORSHIP }),
        /contains unresolved placeholder 'TODO' at line \d+[\s\S]*Complete .*intake\.md, remove every placeholder/
      );
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(JSON.stringify(phase), phaseBefore, 'the refused template advanced or annotated the phase');
    assert.equal(await readFile(statePath, 'utf8'), stateBefore, 'the refused template rewrote durable Story state');
    assert.deepEqual(warnings, [], 'an expected prepared artifact was reported as accidental adoption');
  });
});

test('the required artifact is expected while unrelated untracked files still warn', async () => {
  const { root, config, workflow, phase, target } = await fixture('adoption');
  await inContext(root, async () => {
    await writeFile(target, [
      '# Intake', '',
      '## Requested outcome', '',
      'Publish only fully authored phase evidence and keep accidental files visible to the contributor.', '',
      '## Scope and constraints', '',
      'The publication preflight reads the required artifact before changing generation state. The artifact scan still registers this declared file as governed evidence.', '',
      '## Evidence', '',
      'The regression test proves both the expected-file path and the unrelated-file warning path.', ''
    ].join('\n'));
    const firstWarnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => firstWarnings.push(String(message));
    try { await scanArtifacts(root, config, workflow, 'intake'); }
    finally { console.warn = originalWarn; }
    assert.deepEqual(firstWarnings, [], 'the declared required artifact was reported as accidental adoption');
    assert.ok(phase.artifacts.some((artifact) => artifact.path.endsWith('/artifacts/intake/intake.md')));

    await writeFile(path.join(root, 'unexpected-source.js'), 'export const unexpected = true;\n');
    const secondWarnings = [];
    console.warn = (message) => secondWarnings.push(String(message));
    try { await scanArtifacts(root, config, workflow, 'intake'); }
    finally { console.warn = originalWarn; }
    assert.ok(secondWarnings.some((message) => message.includes('unexpected-source.js')),
      `the unrelated file was not disclosed: ${JSON.stringify(secondWarnings)}`);
    assert.ok(secondWarnings.every((message) => !message.includes('/artifacts/intake/intake.md')),
      `the required artifact reappeared in the adoption warning: ${JSON.stringify(secondWarnings)}`);
  });
});

test('a code phase refuses an artifact-only generation before mutating phase state', async () => {
  const { root, config, workflow, phase } = await codeFixture('artifact-only', { acceptance: false });
  await inContext(root, async () => {
    const before = JSON.stringify(phase);
    await assert.rejects(
      () => publishGeneration(root, config, workflow, { phaseId: 'implementation', authorship: AUTHORSHIP }),
      /no product source path changed[\s\S]*no acceptance test is available/
    );
    assert.equal(JSON.stringify(phase), before, 'a refused code delivery mutated the phase');
  });
});

test('a code phase refuses source without tests and tests without acceptance tags', async () => {
  const sourceOnly = await codeFixture('source-only');
  await mkdir(path.join(sourceOnly.root, 'src'), { recursive: true });
  await writeFile(path.join(sourceOnly.root, 'src', 'app.java'), 'final class App {}\n');
  await inContext(sourceOnly.root, async () => {
    await assert.rejects(
      () => publishGeneration(sourceOnly.root, sourceOnly.config, sourceOnly.workflow, { phaseId: 'implementation', authorship: AUTHORSHIP }),
      /no acceptance test is available/
    );
  });

  const untagged = await codeFixture('untagged');
  await mkdir(path.join(untagged.root, 'src', 'test'), { recursive: true });
  await writeFile(path.join(untagged.root, 'src', 'app.java'), 'final class App {}\n');
  await writeFile(path.join(untagged.root, 'src', 'test', 'AppTest.java'), 'final class AppTest {}\n');
  await inContext(untagged.root, async () => {
    await assert.rejects(
      () => publishGeneration(untagged.root, untagged.config, untagged.workflow, { phaseId: 'implementation', authorship: AUTHORSHIP }),
      /changed tests do not contain required traceability tags: @ac:DELIVERY-1:AC-001/
    );
  });
});

test('a code phase publishes source and acceptance-mapped tests with a delivery receipt', async () => {
  const context = await codeFixture('complete');
  await mkdir(path.join(context.root, 'src', 'test'), { recursive: true });
  await writeFile(path.join(context.root, 'src', 'app.java'), 'final class App {}\n');
  await writeFile(path.join(context.root, 'src', 'test', 'AppTest.java'), '/** @ac:AC-001 */\nfinal class AppTest {}\n');
  await inContext(context.root, async () => {
    await publishGeneration(context.root, context.config, context.workflow, {
      phaseId: 'implementation', authorship: AUTHORSHIP, persist: false
    });
  });
  assert.equal(context.phase.generation, 1);
  assert.equal(context.phase.deliveryEvidence.sourcePaths.length, 1);
  assert.equal(context.phase.deliveryEvidence.testPaths.length, 1);
  assert.deepEqual(context.phase.deliveryEvidence.acceptanceCriteria.missing, []);
  assert.equal(context.phase.deliveryEvidence.sourceTreeSha256.startsWith('sha256:'), true);
  assert.equal(context.phase.generationIntent.status, 'consumed');
  const receipt = JSON.parse(await readFile(path.join(context.root, context.phase.deliveryEvidence.receiptPath), 'utf8'));
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.status, 'pending-tests');
  assert.equal(receipt.generationIntentId, context.phase.generationIntent.id);
  assert.equal(receipt.changeSet.digest, context.phase.deliveryEvidence.changeSet.digest);
});
