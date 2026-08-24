import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { recoveryPlan } from '../src/collaboration.mjs';
import { buildGenerationAuthorship, normalizeAuthorshipOptions } from '../src/manual-authorship.mjs';
import { withOperationContext } from '../src/operation-context.mjs';
import {
  artifactPlaceholderFindings, authoredArtifactFingerprint, inspectArtifactContent,
  inspectRequiredArtifactContent
} from '../src/publication-preflight.mjs';
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
  await writeFile(target, [
    '# Implementation', '',
    'Implemented the bounded product change and its acceptance-mapped tests.', '',
    '## Delivery evidence', '',
    'The generation records the exact changed source paths, test paths, traceability tags, and configured command results. Publication binds those bytes to the open generation intent and preserves the resulting receipt for later verification.', '',
    '## Residual risk', '',
    'No additional behavior is claimed beyond the source and acceptance evidence registered by this generation.', ''
  ].join('\n'));

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

test('artifact preflight reports every authored placeholder and excludes approved managed inputs', () => {
  const findings = artifactPlaceholderFindings([
    '# Implementation', '',
    'TODO replace the scaffold.',
    'Owner: {{owner}}',
    'Path: <path or module>',
    'Run with <AUTHORIZED-URL>.',
    '<!-- singularity-flow:inputs:start -->',
    'TBD approved upstream text with <legacy path>.',
    '<!-- singularity-flow:inputs:end -->'
  ].join('\n'));
  assert.deepEqual(findings.map((finding) => finding.value), ['TODO', '{{owner}}', '<path or module>']);
  assert.deepEqual(findings.map((finding) => finding.line), [3, 4, 5]);
});

test('one content inspection counts only authored bytes and reports every blocker in recovery order', () => {
  const text = [
    '<!-- singularity-flow:metadata', '{"large":"managed metadata does not prove authoring"}', '-->',
    '# Intake', '', '## Objective', '', 'TODO describe it.', '',
    '<!-- singularity-flow:inputs:start -->', 'Approved input '.repeat(100),
    '<!-- singularity-flow:inputs:end -->', ''
  ].join('\n');
  const baseline = {
    generation: 1,
    fingerprint: authoredArtifactFingerprint(text)
  };
  const inspected = inspectArtifactContent(text, {
    path: 'intake.md', contract: { generation: 1, minimumBytes: 200 }, baseline
  });
  assert.ok(inspected.bytes < 200, 'managed metadata or approved inputs counted as authored bytes');
  assert.deepEqual(inspected.findings.map((finding) => finding.code), [
    'artifact.placeholder.unresolved',
    'artifact.template.unchanged',
    'artifact.required.too-short'
  ]);
  assert.equal(inspected.findings[0].value, 'TODO');
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
        (error) => {
          assert.equal(error.code, 'ARTIFACT_AUTHORING_INCOMPLETE');
          assert.match(error.message, /contains unresolved placeholder 'TODO' at line \d+/);
          assert.match(error.message, /still matches its prepared template/);
          assert.match(error.message, /recover PREFLIGHT-1 --phase intake --json/);
          assert.deepEqual(error.details.retry, {
            skill: '/sf-phase', maximumAttempts: 1, requiresFingerprintChange: true,
            command: 'singularity-flow phase publish intake --authored governed-agent --channel copilot-host'
          });
          return true;
        }
      );
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(JSON.stringify(phase), phaseBefore, 'the refused template advanced or annotated the phase');
    assert.equal(await readFile(statePath, 'utf8'), stateBefore, 'the refused template rewrote durable Story state');
    assert.deepEqual(warnings, [], 'an expected prepared artifact was reported as accidental adoption');
  });
});

test('recovery exposes the same authored-byte findings and a bounded Copilot retry contract', async () => {
  const { root, config, workflow, phase } = await fixture('recovery-authoring');
  const findings = await inspectRequiredArtifactContent(root, config, workflow, phase);
  assert.ok(findings.some((finding) => finding.code === 'artifact.placeholder.unresolved'));
  assert.ok(findings.some((finding) => finding.code === 'artifact.template.unchanged'));
  const plan = await recoveryPlan(root, config, workflow, { phaseId: 'intake' });
  const action = plan.actions.find((entry) => entry.id === 'complete-artifact:intake');
  assert.deepEqual(action.retry, {
    maximumAttempts: 1,
    requiresFingerprintChange: true,
    beforeRetry: 'singularity-flow recover PREFLIGHT-1 --phase intake --json',
    command: 'singularity-flow phase publish intake --authored governed-agent --channel copilot-host'
  });
  assert.equal(action.skill, '/sf-phase');
});

test('scaffold angle placeholders are rejected but immutable approved-input placeholders are ignored', async () => {
  const unfinished = await fixture('angle-placeholder');
  await writeFile(unfinished.target, [
    '# Intake', '',
    '## Requested outcome', '', 'Deliver reviewed publication evidence.', '',
    '## Scope and constraints', '', '| Surface | Change |', '|---|---|', '| <path or module> | <what changes> |', '',
    '## Evidence', '', 'The artifact must contain concrete repository paths.'
  ].join('\n'));
  await inContext(unfinished.root, async () => {
    await assert.rejects(
      () => publishGeneration(unfinished.root, unfinished.config, unfinished.workflow, {
        phaseId: 'intake', authorship: AUTHORSHIP
      }),
      /contains unresolved placeholder '<path or module>'/
    );
  });

  const downstream = await fixture('managed-input-placeholder');
  await writeFile(downstream.target, [
    '# Intake', '',
    '## Requested outcome', '', 'Deliver complete, reviewable evidence.', '',
    '## Scope and constraints', '', 'The authored portion has no unresolved instructions.', '',
    '## Evidence', '', 'Repository evidence is identified and bounded.',
    'Run `singularity-flow mcp smoke playwright --url <AUTHORIZED-URL>` after authorization.', '',
    '<!-- singularity-flow:inputs:start -->', '',
    '# Approved upstream evidence', '', 'Legacy approved text containing TODO and <path or module>.', '',
    '<!-- singularity-flow:inputs:end -->', ''
  ].join('\n'));
  await inContext(downstream.root, async () => {
    const published = await publishGeneration(downstream.root, downstream.config, downstream.workflow, {
      phaseId: 'intake', authorship: AUTHORSHIP
    });
    assert.equal(published.generation, 1);
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

test('an unsupported AST language does not block ordinary code publication', async () => {
  const context = await codeFixture('unsupported-language');
  await mkdir(path.join(context.root, 'src', 'test'), { recursive: true });
  await writeFile(path.join(context.root, 'src', 'app.cpp'), 'int answer() { return 42; }\n');
  await writeFile(path.join(context.root, 'src', 'test', 'app.test.cpp'), '// @ac:DELIVERY-1:AC-001\nint main() { return answer() == 42 ? 0 : 1; }\n');
  await inContext(context.root, async () => {
    await publishGeneration(context.root, context.config, context.workflow, {
      phaseId: 'implementation', authorship: AUTHORSHIP, persist: false
    });
  });
  assert.equal(context.phase.generation, 1);
  assert.deepEqual(context.phase.deliveryEvidence.sourcePaths, ['src/app.cpp']);
  assert.deepEqual(context.phase.deliveryEvidence.testPaths, ['src/test/app.test.cpp']);
});

test('an AST-off code phase publishes through normal non-AST file access', async () => {
  const context = await codeFixture('unsupported-language-ast-off');
  context.config.ast = { ...context.config.ast, mode: 'off' };
  await mkdir(path.join(context.root, 'src', 'test'), { recursive: true });
  await writeFile(path.join(context.root, 'src', 'app.cpp'), 'int answer() { return 42; }\n');
  await writeFile(path.join(context.root, 'src', 'test', 'app.test.cpp'), '// @ac:DELIVERY-1:AC-001\nint main() { return answer() == 42 ? 0 : 1; }\n');
  await inContext(context.root, async () => {
    await publishGeneration(context.root, context.config, context.workflow, {
      phaseId: 'implementation', authorship: AUTHORSHIP, persist: false
    });
  });
  assert.equal(context.phase.generation, 1);
  assert.deepEqual(context.phase.deliveryEvidence.sourcePaths, ['src/app.cpp']);
  assert.deepEqual(context.phase.deliveryEvidence.testPaths, ['src/test/app.test.cpp']);
});

test('an AST-off workflow profile bypasses AST without weakening ordinary delivery checks', async () => {
  const context = await codeFixture('unsupported-language-profile-off');
  context.workflow.resolution.intelligence = {
    ...context.workflow.resolution.intelligence,
    ast: 'off'
  };
  await mkdir(path.join(context.root, 'src', 'test'), { recursive: true });
  await writeFile(path.join(context.root, 'src', 'app.cpp'), 'int answer() { return 42; }\n');
  await writeFile(path.join(context.root, 'src', 'test', 'app.test.cpp'), '// @ac:DELIVERY-1:AC-001\nint main() { return answer() == 42 ? 0 : 1; }\n');
  await inContext(context.root, async () => {
    await publishGeneration(context.root, context.config, context.workflow, {
      phaseId: 'implementation', authorship: AUTHORSHIP, persist: false
    });
  });
  assert.equal(context.phase.generation, 1);
  assert.deepEqual(context.phase.deliveryEvidence.acceptanceCriteria.missing, []);
});

test('a code phase publishes source and acceptance-mapped tests with a delivery receipt', async () => {
  const context = await codeFixture('complete');
  await mkdir(path.join(context.root, 'src', 'test'), { recursive: true });
  await writeFile(path.join(context.root, 'src', 'app.java'), 'final class App {}\n');
  await writeFile(path.join(context.root, 'src', 'test', 'AppTest.java'), '/** @ac:DELIVERY-1:AC-001 */\nfinal class AppTest {}\n');
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

  const retried = await inContext(context.root, () => publishGeneration(
    context.root, context.config, context.workflow,
    { phaseId: 'implementation', authorship: AUTHORSHIP, persist: false }
  ));
  assert.equal(retried.generation, 1, 'an unchanged retry created another generation');

  await writeFile(
    path.join(context.root, context.phase.deliveryEvidence.receiptPath),
    `${JSON.stringify({ ...receipt, status: 'tampered-secondary-output' }, null, 2)}\n`
  );
  await inContext(context.root, () => assert.rejects(
    () => publishGeneration(context.root, context.config, context.workflow, {
      phaseId: 'implementation', authorship: AUTHORSHIP, persist: false
    }),
    /already consumed and the source or artifact bytes now differ/
  ));
  const recovery = await recoveryPlan(context.root, context.config, context.workflow, {
    phaseId: 'implementation'
  });
  assert.equal(recovery.requiresRecovery, true);
  assert.ok(recovery.blockers.some((entry) => entry.code === 'generation.intent.consumed-changed'));
  const renewal = recovery.actions.find((entry) => entry.id === 'begin-new-generation:implementation');
  assert.ok(renewal, 'recovery did not offer a new generation boundary');
  assert.equal(renewal.mode, 'manual');
  assert.equal(renewal.command, null, 'blocked adoption policy was bypassed');

  context.workflow.resolution.codeDelivery.generationBoundary.dirtyStart = 'allow-explicit-adoption';
  const adoptable = await recoveryPlan(context.root, context.config, context.workflow, {
    phaseId: 'implementation'
  });
  const adoption = adoptable.actions.find((entry) => entry.id === 'begin-new-generation:implementation');
  assert.match(adoption.command, /^singularity-flow phase begin implementation --adopt-existing --confirm sha256:/);
});
