import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { generationStartPublicationBinding } from '../src/generation-boundary.mjs';
import {
  commitAndPublish, createWorkflow, inspectRequiredArtifactRegistration, loadConfig, preparePhaseInputs,
  publishGeneration, scanArtifacts, submitPhase
} from '../src/state.mjs';

const ACTOR = { name: 'Template Author', email: 'author@example.invalid', login: null };
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function flow(root, args, { allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: ACTOR.name }
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
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

async function codeFixture(name, { acceptance = true, trackedResult = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), `sflow-code-delivery-${name}-`));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', ACTOR.name);
  git(root, 'config', 'user.email', ACTOR.email);
  await writeFile(path.join(root, 'package.json'), `${JSON.stringify({
    name: 'delivery-fixture', private: true, scripts: { test: 'node test-runner.mjs' }
  }, null, 2)}\n`);
  await writeFile(path.join(root, 'test-runner.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync('.sflow/results/unit.json', JSON.stringify({ run: Date.now(), tests: { discovered: 1, passed: 1, failed: 0, skipped: 0 } }));",
    ''
  ].join('\n'));
  if (trackedResult) {
    await mkdir(path.join(root, '.sflow', 'results'), { recursive: true });
    await writeFile(path.join(root, '.sflow', 'results', 'unit.json'),
      '{"run":"legacy","tests":{"discovered":1,"passed":1,"failed":0,"skipped":0}}\n');
  }
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
    approval: { mode: 'none', authorities: [], minimum: 0, rejectTo: ['implementation'] },
    qualityCommands: [{
      id: 'fixture-tests', kind: 'test', argv: [process.execPath, 'test-runner.mjs'],
      workingDirectory: '.', affectedRoots: ['.'], modelPolicy: 'never',
      result: { adapter: 'sflow-test-result-v1', path: '.sflow/results/unit.json', minimumDiscovered: 1 }
    }]
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
      id: 'requirements', label: 'Requirements', order: 0, status: 'approved', generation: 1,
      requiredArtifact: { path: 'artifacts/requirements/requirements.md', kind: 'requirements' },
      artifacts: [], approvals: [], usage: [], qualityCommands: []
    };
    phase.order = 1;
    workflow.phaseOrder = ['requirements', 'implementation'];
    workflow.resolution.phases = [
      { id: 'requirements', order: 0 },
      ...workflow.resolution.phases.map((entry) => ({ ...entry, order: Number(entry.order) + 1 }))
    ];
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

async function publishCodeGoverned(root, config, workflow, phaseId) {
  await scanArtifacts(root, config, workflow, phaseId);
  const phase = workflow.phases[phaseId];
  const generation = Number(phase.generation) + 1;
  const payload = await generationStartPublicationBinding(root, workflow, phase);
  return commitAndPublish(
    root,
    config,
    workflow,
    { type: 'artifact-generated', phaseId, generation, payload },
    `[${workflow.workItem.id}][phase:${phaseId}][generated:${generation}] publish artifacts`,
    (phase.artifacts ?? []).map((entry) => entry.path),
    {
      beforeStateWrite: (publicationEvent, transactionContext) => publishGeneration(root, config, workflow, {
        phaseId, authorship: AUTHORSHIP, persist: false,
        publicationTransaction: {
          publicationEvent,
          transactionId: transactionContext.transactionId,
          expectedHead: transactionContext.expectedHead
        }
      })
    }
  );
}

async function publishGoverned(root, config, workflow, phaseId) {
  await scanArtifacts(root, config, workflow, phaseId);
  const phase = workflow.phases[phaseId];
  const generation = Number(phase.generation) + 1;
  const payload = await generationStartPublicationBinding(root, workflow, phase);
  return commitAndPublish(
    root,
    config,
    workflow,
    { type: 'artifact-generated', phaseId, generation, payload },
    `[${workflow.workItem.id}][phase:${phaseId}][generated:${generation}] publish artifacts`,
    (phase.artifacts ?? []).map((entry) => entry.path),
    {
      beforeStateWrite: (publicationEvent, transactionContext) => publishGeneration(root, config, workflow, {
        phaseId, authorship: AUTHORSHIP, persist: false,
        publicationTransaction: {
          publicationEvent,
          transactionId: transactionContext.transactionId,
          expectedHead: transactionContext.expectedHead
        }
      })
    }
  );
}

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

test('preparation baselines only a template the kernel creates, across every preparation entry point', async () => {
  const { root, config, workflow, phase, target } = await fixture('baseline-capture');
  delete phase.authoringBaseline;
  await writeFile(target, [
    '# Intake', '',
    '## Outcome', '',
    'The contributor-authored outcome is already complete and must never become a new template baseline after an upgrade.', '',
    '## Evidence', '',
    'The reviewed scope, measurable result, constraints, ownership, and validation evidence are all recorded here before preparation is repeated.'
  ].join('\n'));
  await inContext(root, () => preparePhaseInputs(root, config, workflow, 'intake'));
  assert.equal(phase.authoringBaseline, undefined, 'repeated preparation captured existing authored content as a template');

  await unlink(target);
  await inContext(root, () => preparePhaseInputs(root, config, workflow, 'intake'));
  assert.equal(phase.authoringBaseline.generation, 1);
  assert.equal(phase.authoringBaseline.fingerprint, authoredArtifactFingerprint(await readFile(target, 'utf8')));
  assert.ok(phase.authoringBaseline.bytes >= phase.requiredArtifact.minimumBytes);
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
    const beforePublication = await inspectRequiredArtifactRegistration(root, config, workflow, phase);
    assert.equal(beforePublication.status, 'not-applicable');
    assert.equal(beforePublication.reason, 'unpublished');
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

test('artifact scan repairs a stale registration even when the governed artifact is Git-clean', async () => {
  const { root, target } = await fixture('clean-stale-registration');
  const workflowPath = path.join(root, 'singularity', 'work-items', 'PREFLIGHT-1', 'workflow.json');
  const relative = 'singularity/work-items/PREFLIGHT-1/artifacts/intake/intake.md';
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const prepared = await readFile(target, 'utf8');
  const managedMetadata = prepared.match(/^<!-- singularity-flow:metadata\n[\s\S]*?\n-->/)?.[0];
  assert.ok(managedMetadata, 'the prepared artifact has no managed lifecycle metadata');

  await writeFile(target, [
    managedMetadata, '',
    '# Intake', '',
    '## Requested outcome', '',
    'Keep exact artifact registration synchronized with durable lifecycle metadata.', '',
    '## Scope and constraints', '',
    'A clean tracked artifact may still expose a legacy registration written by an older engine.', '',
    '## Evidence', '',
    'The explicit scanner must compare already-governed paths rather than relying only on Git changes.', ''
  ].join('\n'));
  flow(root, ['artifact', 'scan']);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'register authored intake artifact');

  const registeredBefore = JSON.parse(await readFile(workflowPath, 'utf8'))
    .phases.intake.artifacts.find((artifact) => artifact.path === relative);
  const registeredText = await readFile(target, 'utf8');
  const changedText = registeredText.replace('"status": "in_progress"', '"status": "awaiting_approval"');
  assert.notEqual(changedText, registeredText, 'the fixture did not find the managed lifecycle metadata');
  const changed = Buffer.from(changedText);
  await writeFile(target, changed);
  git(root, 'add', relative);
  git(root, 'commit', '-m', 'simulate legacy managed metadata rewrite');
  assert.equal(git(root, 'status', '--short'), '', 'the regression artifact was not Git-clean');
  assert.notEqual(registeredBefore.sha256, digest(changed), 'the fixture did not create stale registration state');

  const repaired = flow(root, ['artifact', 'scan']);
  assert.match(repaired.stdout, new RegExp(relative.replaceAll('/', '\\/')));
  const workflowAfter = JSON.parse(await readFile(workflowPath, 'utf8'));
  const registeredAfter = workflowAfter.phases.intake.artifacts.find((artifact) => artifact.path === relative);
  assert.equal(registeredAfter.sha256, digest(changed));
  assert.equal(registeredAfter.size, changed.length);
});

test('submit repairs only a stale required-artifact registration and records a governed receipt', async () => {
  const context = await fixture('submit-managed-registration-repair');
  await writeFile(context.target, [
    '# Intake', '',
    '## Requested outcome', '',
    'Submit a published artifact without making an operator repair stale engine bookkeeping.', '',
    '## Scope and constraints', '',
    'Only the registration digest may be repaired; author-owned bytes remain bound to the immutable generation.', '',
    '## Evidence', '',
    'This fixture replaces the stored digest after publication and expects submission to heal it transactionally.', ''
  ].join('\n'));
  await inContext(context.root, () => publishGoverned(
    context.root, context.config, context.workflow, 'intake'
  ));

  const relative = 'singularity/work-items/PREFLIGHT-1/artifacts/intake/intake.md';
  const registered = context.phase.artifacts.find((artifact) => artifact.path === relative);
  const current = await readFile(context.target);
  const currentSha256 = createHash('sha256').update(current).digest('hex');
  registered.sha256 = '0'.repeat(64);
  registered.size = 1;
  const classified = await inspectRequiredArtifactRegistration(
    context.root, context.config, context.workflow, context.phase
  );
  assert.equal(classified.status, 'repairable');
  assert.equal(classified.reason, 'managed-registration-stale');

  await inContext(context.root, () => submitPhase(
    context.root, context.config, context.workflow, { phaseId: 'intake', runChecks: false, persist: false }
  ));

  const finalBytes = await readFile(context.target);
  assert.equal(registered.sha256, createHash('sha256').update(finalBytes).digest('hex'));
  assert.equal(registered.size, finalBytes.length);
  assert.equal(context.phase.status, 'approved');
  const repair = context.phase.artifactRegistrationRepairs.at(-1);
  assert.equal(repair.path, relative);
  assert.equal(repair.previousSha256, '0'.repeat(64));
  assert.equal(repair.currentSha256, currentSha256);
  assert.equal(repair.reason, 'managed-registration-stale');
  assert.ok(context.workflow.history.some((entry) =>
    entry.event === 'artifact_registration_repaired' && entry.phase === 'intake'));
});

test('artifact scan cannot bless authored changes made after the immutable generation', async () => {
  const context = await fixture('submit-authored-change');
  await writeFile(context.target, [
    '# Intake', '',
    '## Requested outcome', '',
    'Bind the reviewed intake content to one immutable published generation.', '',
    '## Scope and constraints', '',
    'A later authored edit requires a new generation even when artifact scan refreshed the registration.', '',
    '## Evidence', '',
    'The submit gate compares authored content with the exact generation commit rather than trusting its mutable index.', ''
  ].join('\n'));
  await inContext(context.root, () => publishGoverned(
    context.root, context.config, context.workflow, 'intake'
  ));
  await writeFile(context.target, `${await readFile(context.target, 'utf8')}\nPost-publication authored change.\n`);
  await inContext(context.root, () => scanArtifacts(
    context.root, context.config, context.workflow, 'intake'
  ));
  const classified = await inspectRequiredArtifactRegistration(
    context.root, context.config, context.workflow, context.phase
  );
  assert.equal(classified.status, 'unsafe');
  assert.equal(classified.reason, 'authored-content-changed');

  await assert.rejects(
    () => inContext(context.root, () => submitPhase(
      context.root, context.config, context.workflow, { phaseId: 'intake', runChecks: false, persist: false }
    )),
    (error) => error.code === 'ARTIFACT_AUTHORED_BYTES_CHANGED_AFTER_PUBLICATION'
      && /Published authored hash: sha256:[a-f0-9]{64}/.test(error.message)
      && /Current authored hash: sha256:[a-f0-9]{64}/.test(error.message)
      && /singularity-flow recover PREFLIGHT-1 --phase intake/.test(error.message)
  );
  assert.equal(context.phase.artifactRegistrationRepairs.length, 0);
  assert.equal(context.phase.status, 'in_progress');
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

test('structured test discovery fails before publication consumes the generation intent', async () => {
  const context = await codeFixture('test-preflight');
  await mkdir(path.join(context.root, 'src', 'test'), { recursive: true });
  await writeFile(path.join(context.root, 'src', 'app.java'), 'final class App {}\n');
  await writeFile(path.join(context.root, 'src', 'test', 'AppTest.java'), '/** @ac:DELIVERY-1:AC-001 */\nfinal class AppTest {}\n');
  await writeFile(path.join(context.root, 'test-runner.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync('.sflow/results/unit.json', JSON.stringify({ tests: { discovered: 0, passed: 0, failed: 0, skipped: 0 } }));",
    ''
  ].join('\n'));
  await inContext(context.root, () => assert.rejects(
    () => publishGeneration(context.root, context.config, context.workflow, {
      phaseId: 'implementation', authorship: AUTHORSHIP, persist: false
    }),
    (error) => error.code === 'CODE_TEST_ZERO_DISCOVERED' && /before publication/.test(error.message)
  ));
  assert.equal(context.phase.generation, 0);
  assert.equal(context.phase.generationIntent.status, 'open');
  assert.equal(context.phase.deliveryEvidence, undefined);
  await assert.rejects(
    () => readFile(path.join(context.root, '.sflow', 'results', 'unit.json')),
    (error) => error.code === 'ENOENT',
    'a refused publication left disposable structured test output in the worktree'
  );
});

test('a code phase publishes source and acceptance-mapped tests with a delivery receipt', async () => {
  const context = await codeFixture('complete');
  await mkdir(path.join(context.root, 'src', 'test'), { recursive: true });
  await writeFile(path.join(context.root, 'src', 'app.java'), 'final class App {}\n');
  await writeFile(path.join(context.root, 'src', 'test', 'AppTest.java'), '/** @ac:DELIVERY-1:AC-001 */\nfinal class AppTest {}\n');
  await inContext(context.root, () => publishCodeGoverned(
    context.root, context.config, context.workflow, 'implementation'
  ));
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
  assert.deepEqual(receipt.changeClassification.declaredOrigins, ['human']);
  assert.equal(receipt.changeClassification.inference, 'path-policy');
  assert.equal(receipt.changeClassification.counts['product-source'], 1);
  assert.equal(receipt.changeClassification.counts['test-source'], 1);
  assert.deepEqual(
    receipt.changeClassification.entries.map((entry) => [entry.newPath, entry.role]),
    [['src/app.java', 'product-source'], ['src/test/AppTest.java', 'test-source']]
  );

  const retried = await inContext(context.root, () => publishGeneration(
    context.root, context.config, context.workflow,
    { phaseId: 'implementation', authorship: AUTHORSHIP, persist: false }
  ));
  assert.equal(retried.generation, 1, 'an unchanged retry created another generation');

  await writeFile(path.join(context.root, 'src', 'app.java'), 'final class App { int unbound = 1; }\n');
  const unavailableBaseline = await recoveryPlan(context.root, context.config, context.workflow, {
    phaseId: 'implementation'
  });
  const bounded = unavailableBaseline.actions.find((entry) => entry.id === 'begin-new-generation:implementation');
  assert.equal(bounded.mode, 'guided');
  assert.match(bounded.command, /^singularity-flow phase rollover implementation --confirm sha256:/);
  assert.equal(bounded.skill, '/sf-code');
  await writeFile(path.join(context.root, 'src', 'app.java'), 'final class App {}\n');

  await writeFile(
    path.join(context.root, context.phase.deliveryEvidence.receiptPath),
    `${JSON.stringify({ ...receipt, status: 'tampered-secondary-output' }, null, 2)}\n`
  );
  await writeFile(path.join(context.root, 'src', 'app.java'), 'final class App { int repaired = 1; }\n');
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
  assert.equal(renewal.mode, 'guided');
  assert.match(renewal.command, /^singularity-flow phase rollover implementation --confirm sha256:/);
  assert.equal(renewal.skill, '/sf-code');

  const generatedContext = path.join(
    context.root, 'singularity', 'work-items', 'DELIVERY-1', 'context', 'recovery-attempt.json'
  );
  await writeFile(generatedContext, '{"generatedBy":"singularity-flow"}\n');
  git(context.root, 'add', 'singularity/work-items/DELIVERY-1/context/recovery-attempt.json');
  git(context.root, 'commit', '-m', 'record governance-only recovery context');
  await writeFile(path.join(context.root, '.sflow', 'results', 'retry.json'), '{"status":"passed"}\n');
  const stableRecovery = await recoveryPlan(context.root, context.config, context.workflow, {
    phaseId: 'implementation'
  });
  const stableRenewal = stableRecovery.actions.find((entry) => entry.id === 'begin-new-generation:implementation');
  assert.equal(stableRenewal.command, renewal.command,
    'governance commits or generated test results changed the recovery adoption digest');

  context.workflow.resolution.codeDelivery.generationBoundary.dirtyStart = 'allow-explicit-adoption';
  const adoptable = await recoveryPlan(context.root, context.config, context.workflow, {
    phaseId: 'implementation'
  });
  const adoption = adoptable.actions.find((entry) => entry.id === 'begin-new-generation:implementation');
  assert.match(adoption.command, /^singularity-flow phase rollover implementation --confirm sha256:/);
});

test('tracked volatile SFlow test output is restored and never blocks publish or submit', async () => {
  const context = await codeFixture('tracked-result', { trackedResult: true });
  const resultPath = path.join(context.root, '.sflow', 'results', 'unit.json');
  const baselineResult = await readFile(resultPath, 'utf8');
  await mkdir(path.join(context.root, 'src', 'test'), { recursive: true });
  await writeFile(path.join(context.root, 'src', 'app.java'), 'final class App {}\n');
  await writeFile(path.join(context.root, 'src', 'test', 'AppTest.java'),
    '/** @ac:DELIVERY-1:AC-001 */\nfinal class AppTest {}\n');

  // Simulate a legacy registration produced before `.sflow/results/**` became reserved transport.
  context.phase.artifacts.push({
    path: '.sflow/results/unit.json', kind: 'configuration', status: 'pending', exists: true,
    size: Buffer.byteLength(baselineResult), sha256: 'legacy-registration'
  });

  await inContext(context.root, () => publishCodeGoverned(
    context.root, context.config, context.workflow, 'implementation'
  ));
  assert.equal(await readFile(resultPath, 'utf8'), baselineResult,
    'publication left timestamp-bearing reporter output in the tracked worktree');
  assert.equal(context.phase.artifacts.some((artifact) => artifact.path === '.sflow/results/unit.json'), false,
    'legacy raw result registration survived artifact scanning');
  assert.equal(context.phase.deliveryEvidence.sourcePaths.includes('.sflow/results/unit.json'), false,
    'raw reporter output entered the governed source boundary');

  await inContext(context.root, () => submitPhase(
    context.root, context.config, context.workflow, { phaseId: 'implementation', persist: false }
  ));
  assert.equal(context.phase.status, 'approved');
  assert.equal(await readFile(resultPath, 'utf8'), baselineResult,
    'submission left its fresh raw test report as an application change');
  assert.doesNotMatch(git(context.root, 'status', '--short'), /\.sflow\/results\/unit\.json/);
  assert.equal(context.phase.deliveryEvidence.testExecutions.length, 1,
    'submission did not replace raw output with a durable normalized test receipt');
});

test('prepare refuses a consumed code generation before writing next-generation state', async () => {
  const context = await codeFixture('consumed-prepare');
  await mkdir(path.join(context.root, 'src', 'test'), { recursive: true });
  await writeFile(path.join(context.root, 'src', 'app.java'), 'final class App {}\n');
  await writeFile(path.join(context.root, 'src', 'test', 'AppTest.java'), '/** @ac:DELIVERY-1:AC-001 */\nfinal class AppTest {}\n');
  await inContext(context.root, () => publishGeneration(context.root, context.config, context.workflow, {
    phaseId: 'implementation', authorship: AUTHORSHIP, persist: false
  }));
  const artifactBefore = await readFile(context.target, 'utf8');
  const phaseBefore = JSON.stringify(context.phase);
  const nextReceipt = path.join(
    context.root, 'singularity', 'work-items', 'DELIVERY-1',
    'context', 'generation-start', 'implementation-gen2.json'
  );

  await assert.rejects(
    () => inContext(context.root, () => preparePhaseInputs(
      context.root, context.config, context.workflow, 'implementation'
    )),
    (error) => error.code === 'GENERATION_INTENT_ALREADY_CONSUMED'
      && /recover DELIVERY-1 --phase implementation --json/.test(error.message)
      && /exact phase-begin action before preparing/.test(error.message)
  );

  assert.equal(await readFile(context.target, 'utf8'), artifactBefore,
    'prepare rewrote the artifact before rejecting the consumed generation');
  assert.equal(JSON.stringify(context.phase), phaseBefore,
    'prepare mutated phase state before rejecting the consumed generation');
  await assert.rejects(() => readFile(nextReceipt), (error) => error.code === 'ENOENT');
});

test('phase rollover previews exact current bytes and opens one successor without erasing publication', async () => {
  const context = await codeFixture('rollover-command');
  await mkdir(path.join(context.root, 'src', 'test'), { recursive: true });
  await writeFile(path.join(context.root, 'src', 'app.java'), 'final class App {}\n');
  await writeFile(path.join(context.root, 'src', 'test', 'AppTest.java'),
    '/** @ac:DELIVERY-1:AC-001 */\nfinal class AppTest {}\n');
  await inContext(context.root, () => publishCodeGoverned(
    context.root, context.config, context.workflow, 'implementation'
  ));
  const publishedHead = git(context.root, 'rev-parse', 'HEAD');
  await writeFile(path.join(context.root, 'src', 'app.java'), 'final class App { int next = 2; }\n');

  const preview = JSON.parse(flow(context.root, [
    'phase', 'rollover', 'implementation', '--json'
  ]).stdout);
  assert.equal(preview.fromGeneration, 1);
  assert.equal(preview.toGeneration, 2);
  assert.match(preview.confirmation, /^sha256:[a-f0-9]{64}$/);
  assert.equal(preview.mutates, false);
  let stored = JSON.parse(await readFile(path.join(
    context.root, 'singularity', 'work-items', 'DELIVERY-1', 'workflow.json'
  ), 'utf8'));
  assert.equal(stored.phases.implementation.generationIntent.status, 'consumed');

  const stale = flow(context.root, [
    'phase', 'rollover', 'implementation', '--confirm', `sha256:${'0'.repeat(64)}`
  ], { allowFailure: true });
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /confirmation must equal the current digest/i);

  flow(context.root, [
    'phase', 'rollover', 'implementation', '--confirm', preview.confirmation
  ]);
  stored = JSON.parse(await readFile(path.join(
    context.root, 'singularity', 'work-items', 'DELIVERY-1', 'workflow.json'
  ), 'utf8'));
  assert.equal(stored.phases.implementation.generation, 1);
  assert.equal(stored.phases.implementation.generationIntent.generation, 2);
  assert.equal(stored.phases.implementation.generationIntent.status, 'open');
  assert.equal(git(context.root, 'rev-parse', 'HEAD'), publishedHead,
    'rollover created a commit instead of a local authoring boundary');
});
