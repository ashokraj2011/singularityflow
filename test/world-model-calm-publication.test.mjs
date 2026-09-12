import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { initializeDefinition, loadDefinition, resolveWorkType } from '../src/config.mjs';
import { setAgentSession } from '../src/session.mjs';
import { createWorkflow, loadConfig } from '../src/state.mjs';
import { run } from '../src/util.mjs';
import { worldModelCommand } from '../src/worldmodel.mjs';
import {
  assertApprovedArchitectureIntent, evaluateArchitectureIntentGate, projectArchitectureIntentStatus
} from '../src/architecture-intent-gate.mjs';
import {
  evaluateArchitectureIntentEvidence, publishedArchitectureIntentBinding,
  resolveArchitectureIntentPublicationBinding
} from '../src/architecture-intent-service.mjs';
import {
  createArchitectureIntent, verifyArchitectureIntent
} from '../src/world-model/projections/calm/projection.mjs';
import { canonicalJson, sealRecord } from '../src/world-model/canonicalize.mjs';
import { resolvePublishedWorldModelV4 } from '../src/world-model/store.mjs';
import { validateStagedProjectionAuthorityAgainstSource } from '../src/world-model/publish/transaction.mjs';
import {
  assertArchitectureProjectionAuthoritySnapshots, resolveCurrentArchitectureProjectionInputs
} from '../src/world-model/projections/calm/authority.mjs';
import { resolveArchitectureIntentBase } from '../src/commands/architecture.mjs';
import { loadAcceptedStoryExecution } from '../src/accepted-story-execution.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function git(root, args) { return run('git', args, { cwd: root }).stdout.trim(); }

function flow(root, args, { allowFailure = false, actor = 'Architecture Reviewer' } = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SINGULARITY_FLOW_TEST_IDENTITY: actor
    }
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `singularity-flow ${args.join(' ')} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
    );
  }
  return result;
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmc-publication-'));
  const remote = `${root}.git`;
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  });
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'WMC Test']);
  git(root, ['config', 'user.email', 'wmc@example.invalid']);
  await writeFile(path.join(root, 'app.mjs'), 'export const ready = true;\n');
  await initializeDefinition(root);
  const workflowPath = path.join(root, 'singularity', 'workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.worldModel.format = 'registered-v4';
  workflow.worldModel.promptSource = 'builtin';
  workflow.worldModel.views = ['dev.impact'];
  workflow.worldModel.v4 = {
    composer: 'deterministic', consumer: 'developer', cachePolicy: 'reuse-valid',
    totalMaximumOutputTokens: 1400
  };
  workflow.worldModel.grounding = 'off';
  workflow.git.publish = 'off';
  workflow.approvalSecurity = { profile: 'poc' };
  workflow.architectureIntent = {
    enabled: true,
    allowedPhases: ['planning'],
    blockRequiredUnfulfilledAt: ['verification']
  };
  for (const authority of Object.values(workflow.approvalAuthorities)) {
    authority.allowAnyGitIdentity = true;
  }
  // Keep this integration deliberately small while retaining the real planning phase, architect
  // agent, publication transaction, submission packet and approval authority path.
  delete workflow.phases.planning.artifactSet;
  workflow.workTypes['architecture-lifecycle-test'] = {
    label: 'Architecture lifecycle test',
    description: 'One-phase public lifecycle fixture for immutable architecture evidence.',
    phases: ['planning', 'verification'],
    phaseOverrides: { planning: { inputs: [] }, verification: { inputs: ['planning'] } }
  };
  workflow.worldModel.projections['arch.calm'].enabled = true;
  for (const phase of Object.values(workflow.phases)) {
    if (phase.worldModel?.views?.length) phase.worldModel.views = ['dev.impact'];
  }
  await writeFile(workflowPath, YAML.stringify(workflow));
  for (const name of await readdir(path.join(root, '.github', 'agents'))) {
    if (!name.endsWith('.agent.md')) continue;
    const target = path.join(root, '.github', 'agents', name);
    const source = await readFile(target, 'utf8');
    await writeFile(target, source.replace(
      /sflow-world-model-views: "[^"]*"/, 'sflow-world-model-views: "dev.impact"'
    ));
  }
  await writeFile(path.join(root, 'singularity', 'capabilities.yml'), YAML.stringify({
    version: 2,
    management: { mode: 'sflow-cli' },
    capabilities: {
      platform: {
        name: 'Platform', kind: 'delivery', repository: 'platform',
        architecture: { nodeType: 'service' }, sourceRoots: []
      }
    }
  }));
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'initialize CALM publication fixture']);
  git(root, ['init', '--bare', '-q', '-b', 'main', remote]);
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', '-q', '-u', 'origin', 'main']);
  return root;
}

async function applyLiveStoryPolicyDrift(root) {
  const target = path.join(root, 'singularity', 'workflow.yml');
  const original = await readFile(target, 'utf8');
  const live = YAML.parse(original);
  live.workItemRoot = 'singularity/live-work-items';
  live.worldModel.outputDir = 'singularity/live-world-model';
  live.worldModel.stateBranch = 'live-state';
  live.ledger.branch = 'live-state';
  live.architectureIntent.enabled = false;
  const authority = Object.values(live.approvalAuthorities)[0];
  authority.label = `${authority.label} (live replacement)`;
  await writeFile(target, YAML.stringify(live));
  return { target, original };
}

async function approvedIntentFixture(root, {
  workId = 'WRK-CALM', clauses, exerciseLivePolicyDrift = false
} = {}) {
  const store = resolvePublishedWorldModelV4(root, { stateBranch: 'state' });
  const current = store.projections.find((entry) => entry.projectionId === 'arch.calm');
  git(root, ['switch', '-q', '-c', workId, 'origin/main']);
  const config = await loadConfig(root);
  config.git.publish = 'off';
  config.worldModel.grounding = 'off';
  const actor = { name: 'Architecture Reviewer', email: 'wmc@example.invalid', login: null };
  await setAgentSession(root, config, actor, 'architect', workId, {
    phaseId: 'planning', source: 'test'
  });
  await createWorkflow(root, config, {
    id: workId,
    title: 'Exercise architecture authority',
    source: {
      type: 'manual', key: workId, title: 'Exercise architecture authority',
      description: 'Publish and approve exact architecture intent evidence.',
      acceptanceCriteria: ['The exact intent remains bound to lifecycle evidence.']
    },
    baseBranch: 'main',
    workType: 'architecture-lifecycle-test',
    agent: 'architect',
    resolved: resolveWorkType(config, 'architecture-lifecycle-test')
  });
  git(root, ['add', `singularity/work-items/${workId}`]);
  git(root, ['commit', '-q', '-m', `[${workId}][init] create architecture lifecycle fixture`]);

  const drift = exerciseLivePolicyDrift ? await applyLiveStoryPolicyDrift(root) : null;
  const candidatePath = path.join(root, `architecture-intent-${workId}.json`);
  const initialClauses = exerciseLivePolicyDrift ? [...clauses, {
    clauseId: `${workId}:ARCH-TEMP`, operation: 'remove-node', elementId: 'temporary-node',
    required: false, value: {}
  }] : clauses;
  await writeFile(candidatePath, `${JSON.stringify({ phase: 'planning', clauses: initialClauses }, null, 2)}\n`);
  flow(root, [
    'architecture', 'intent', 'init', '--work-id', workId,
    '--from', path.basename(candidatePath), '--json'
  ]);
  if (exerciseLivePolicyDrift) {
    const initialIntent = JSON.parse(await readFile(path.join(
      root, 'singularity', 'work-items', workId, 'context', 'architecture',
      'architecture-intent.json'
    ), 'utf8'));
    await writeFile(candidatePath, `${JSON.stringify({ phase: 'planning', clauses }, null, 2)}\n`);
    const revised = flow(root, [
      'architecture', 'intent', 'revise', '--work-id', workId,
      '--from', path.basename(candidatePath), '--expect-intent', initialIntent.intentSha256, '--json'
    ]);
    assert.equal(JSON.parse(revised.stdout).status, 'revised');
    await writeFile(drift.target, drift.original);
  }
  await rm(candidatePath);

  let workflow = JSON.parse(await readFile(
    path.join(root, 'singularity', 'work-items', workId, 'workflow.json'), 'utf8'
  ));
  const artifact = path.join(
    root, 'singularity', 'work-items', workId, workflow.phases.planning.requiredArtifact.path
  );
  await writeFile(artifact, `# Architecture planning\n\n## Scope\n\nThis governed planning generation binds the reviewed architecture intent to exact immutable evidence.\n\n## Decision\n\nThe architecture reviewer checks the CALM change clauses and the reusable world-model base.\n\n## Verification\n\nPublication, submission, approval, deterministic rendering, and fulfilment verification must agree on the same intent hash.\n`);
  flow(root, [
    'phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place'
  ]);
  flow(root, ['submit', 'planning', '--skip-checks']);
  flow(root, ['approve', 'planning', '--yes']);

  if (exerciseLivePolicyDrift) await applyLiveStoryPolicyDrift(root);
  const accepted = await loadAcceptedStoryExecution(root, workId);
  const definition = accepted.definition;
  workflow = accepted.workflow;
  const directory = path.join(
    root, 'singularity', 'work-items', workId, 'context', 'architecture'
  );
  const intentPath = path.join(directory, 'architecture-intent.json');
  const intent = JSON.parse(await readFile(intentPath, 'utf8'));
  return { store, current, intent, directory, intentPath, definition, workflow };
}

test('one WMB v4 transaction publishes and reuses the exact CALM product on state', async (t) => {
  const root = await repository(t);
  const built = await worldModelCommand(root, ['wm', 'build'], {
    format: 'registered-v4', views: 'dev.impact'
  });
  assert.equal(built.status, 'completed');
  assert.deepEqual(built.projections.map(({ projectionId, status }) => ({ projectionId, status })), [
    { projectionId: 'arch.calm', status: 'available' }
  ]);
  assert.equal(built.publication.branch, 'state');
  assert.equal(git(root, ['status', '--short']), '');

  const status = await worldModelCommand(root, ['wm', 'status'], { json: true });
  assert.equal(status.fresh, true);
  assert.deepEqual(status.projections.map(({ projectionId, status: projectionStatus }) => ({
    projectionId, status: projectionStatus
  })), [{ projectionId: 'arch.calm', status: 'available' }]);
  const projection = JSON.parse(git(root, [
    'show', 'state:singularity/world-model/projections/arch.calm.json'
  ]));
  assert.equal(projection.$schema, 'https://calm.finos.org/release/1.2/meta/calm.json');
  assert.ok(projection.nodes.some((node) => node['unique-id'] === 'platform'));
});

test('owning publication binds exact next-generation architecture intent bytes', async (t) => {
  const root = await repository(t);
  const definition = await loadDefinition(root);
  const policy = {
    enabled: true, allowedPhases: ['planning'], blockRequiredUnfulfilledAt: ['verification']
  };
  const intent = createArchitectureIntent({
    workId: 'WRK-NEXT', phase: 'planning', generation: 1,
    base: {
      worldModelManifestSha256: `sha256:${'a'.repeat(64)}`,
      calmProjectionSha256: `sha256:${'b'.repeat(64)}`
    },
    clauses: [{
      clauseId: 'WRK-NEXT:ARCH-001', operation: 'remove-node', elementId: 'legacy',
      required: false, value: {}
    }]
  });
  const intentPath = path.join(
    root, 'singularity', 'work-items', 'WRK-NEXT', 'context', 'architecture',
    'architecture-intent.json'
  );
  await mkdir(path.dirname(intentPath), { recursive: true });
  await writeFile(intentPath, canonicalJson(intent));
  const workflow = {
    workItem: { id: 'WRK-NEXT' },
    resolution: { workItemRoot: 'singularity/work-items', architectureIntent: policy },
    phases: { planning: { id: 'planning', generation: 0, generationPublications: [] } }
  };
  const binding = await resolveArchitectureIntentPublicationBinding(
    root, definition, workflow, workflow.phases.planning, 1
  );
  assert.equal(binding.intentSha256, intent.intentSha256);
  assert.equal(binding.generation, 1);
  assert.match(binding.blobSha256, /^sha256:[a-f0-9]{64}$/);
  workflow.phases.planning.generationPublications.push({
    generation: 1, architectureIntent: binding
  });
  assert.deepEqual(publishedArchitectureIntentBinding(workflow.phases.planning, 1), binding);
  await assert.rejects(
    resolveArchitectureIntentPublicationBinding(
      root, definition, workflow, workflow.phases.planning, 2
    ),
    (error) => error.code === 'WMC_INTENT_GENERATION_STALE'
  );
});

test('handcrafted approval fields cannot manufacture architecture authority', async (t) => {
  const root = await repository(t);
  const definition = await loadDefinition(root);
  const workId = 'WRK-HANDCRAFTED';
  const policy = {
    enabled: true, allowedPhases: ['planning'], blockRequiredUnfulfilledAt: ['verification']
  };
  const intent = createArchitectureIntent({
    workId, phase: 'planning', generation: 1,
    base: {
      worldModelManifestSha256: `sha256:${'a'.repeat(64)}`,
      calmProjectionSha256: `sha256:${'b'.repeat(64)}`
    },
    clauses: [{
      clauseId: `${workId}:ARCH-001`, operation: 'remove-node', elementId: 'legacy',
      required: false, value: {}
    }]
  });
  const intentPath = path.join(
    root, 'singularity', 'work-items', workId, 'context', 'architecture',
    'architecture-intent.json'
  );
  await mkdir(path.dirname(intentPath), { recursive: true });
  await writeFile(intentPath, canonicalJson(intent));
  const phase = {
    id: 'planning', generation: 0, generationPublications: [],
    approvalPolicy: {
      mode: 'required', authorities: ['architecture-reviewers'],
      requiredAuthorities: ['architecture-reviewers'], minimum: 1
    },
    approvals: []
  };
  const workflow = {
    workItem: { id: workId },
    resolution: {
      workItemRoot: 'singularity/work-items', architectureIntent: policy,
      approvalAuthorities: {
        'architecture-reviewers': {
          label: 'Architecture reviewers', allowAnyGitIdentity: true, members: []
        }
      }
    },
    phases: { planning: phase }
  };
  const binding = await resolveArchitectureIntentPublicationBinding(
    root, definition, workflow, phase, 1
  );
  phase.generation = 1;
  phase.generationPublications.push({ generation: 1, architectureIntent: binding });
  phase.approvals.push({
    decision: 'approved', phase: 'planning', generation: 1,
    at: '2026-01-02T03:06:05.000Z',
    actor: { name: 'Invented Reviewer', email: 'invented@example.invalid', login: null },
    agent: 'architect', authorityGroup: 'architecture-reviewers',
    identityAssurance: 'configured-local', reviewPacketSha256: 'a'.repeat(64),
    evidenceCommit: git(root, ['rev-parse', 'HEAD']), artifactSetSha256: 'b'.repeat(64),
    architectureIntent: binding
  });

  await assert.rejects(
    assertApprovedArchitectureIntent(root, definition, workflow, intent, intentPath),
    (error) => error.code === 'WMC_INTENT_NOT_APPROVED'
      && Array.isArray(error.details?.reasons)
      && error.details.reasons.length > 0
  );
});

test('public init, publish, submit, approve, render and verify bind exact architecture evidence', async (t) => {
  const root = await repository(t);
  await worldModelCommand(root, ['wm', 'build'], { format: 'registered-v4', views: 'dev.impact' });
  const fixture = await approvedIntentFixture(root, {
    workId: 'WRK-CALM', phase: 'planning', generation: 1,
    exerciseLivePolicyDrift: true,
    clauses: [{
      clauseId: 'WRK-CALM:ARCH-001', operation: 'change-node', elementId: 'platform',
      required: true, value: { name: 'Platform' }
    }]
  });
  const { store, current, intent, directory, definition, workflow } = fixture;
  const publication = workflow.phases.planning.generationPublications.find(
    (entry) => entry.generation === 1
  );
  assert.equal(publication.architectureIntent.intentSha256, intent.intentSha256);
  assert.equal(workflow.lineage.submissions.length, 1);
  assert.equal(
    workflow.phases.planning.approvals[0].reviewPacketSha256,
    workflow.lineage.submissions[0].packetSha256
  );
  const rendered = flow(root, [
    'architecture', 'intent', 'render', '--work-id', workflow.workItem.id, '--json'
  ]);
  assert.equal(JSON.parse(rendered.stdout).status, 'rendered');
  const renderReceipt = JSON.parse(await readFile(
    path.join(directory, 'planned-projection-receipt.json'), 'utf8'
  ));
  assert.equal(renderReceipt.intentSha256, intent.intentSha256);
  const historicalBase = resolveArchitectureIntentBase(root, definition, intent);
  assert.equal(historicalBase.projection.$id, current.projection.$id);
  assert.equal(historicalBase.commit, store.commit);
  assert.ok(historicalBase.sourceMap);
  const candidateStatus = await projectArchitectureIntentStatus(root, definition, {
    ...workflow, phases: { planning: { ...workflow.phases.planning, approvals: [] } }
  });
  assert.equal(candidateStatus.status, 'candidate');
  assert.equal(candidateStatus.approved, false);
  await assert.rejects(
    assertApprovedArchitectureIntent(root, definition, {
      ...workflow, phases: { planning: { ...workflow.phases.planning, approvals: [] } }
    }, intent, path.join(directory, 'architecture-intent.json')),
    (error) => error.code === 'WMC_INTENT_NOT_APPROVED'
  );
  assert.equal((await assertApprovedArchitectureIntent(
    root, definition, workflow, intent, path.join(directory, 'architecture-intent.json')
  )).approved, true);
  await assert.rejects(
    assertApprovedArchitectureIntent(root, definition, {
      ...workflow,
      phases: {
        planning: { ...workflow.phases.planning, generationPublications: [] }
      }
    }, intent, path.join(directory, 'architecture-intent.json')),
    (error) => error.code === 'WMC_INTENT_NOT_APPROVED'
      && error.details.reasons.some((reason) => /no owning generation-publication binding/.test(reason))
  );
  assert.equal((await projectArchitectureIntentStatus(root, definition, workflow)).status, 'approved');
  const missing = await evaluateArchitectureIntentGate(root, definition, workflow, 'verification');
  assert.match(missing.errors.join('\n'), /has no fulfilment receipt/);

  const report = verifyArchitectureIntent({
    intent, baseAfter: current.projection, baseAfterSha256: current.projectionSha256
  });
  await writeFile(path.join(directory, 'intent-fulfilment.json'), canonicalJson(report));
  const fulfilledStatus = await projectArchitectureIntentStatus(root, definition, workflow);
  assert.equal(fulfilledStatus.fulfilment.status, 'recorded-unverified');
  assert.equal(fulfilledStatus.fulfilment.baseAfterSha256, current.projectionSha256);
  assert.equal(fulfilledStatus.fulfilment.counts.fulfilled, 1);
  const mismatched = await evaluateArchitectureIntentGate(root, definition, workflow, 'verification');
  assert.match(mismatched.errors.join('\n'), /WMC_INTENT_REPORT_MISMATCH/);

  flow(root, [
    'architecture', 'intent', 'verify', '--work-id', workflow.workItem.id, '--json'
  ]);
  const recomputed = JSON.parse(await readFile(
    path.join(directory, 'intent-fulfilment.json'), 'utf8'
  ));
  assert.equal(recomputed.intentSha256, intent.intentSha256);
  const satisfied = await evaluateArchitectureIntentGate(root, definition, workflow, 'verification');
  assert.deepEqual(satisfied.errors, []);
  assert.match(satisfied.passes[0], /architecture intent fulfilled/);
});

test('the gate rejects a self-hashed report edited to claim a missing requirement is fulfilled', async (t) => {
  const root = await repository(t);
  await worldModelCommand(root, ['wm', 'build'], { format: 'registered-v4', views: 'dev.impact' });
  const fixture = await approvedIntentFixture(root, {
    workId: 'WRK-TAMPER',
    clauses: [{
      clauseId: 'WRK-TAMPER:ARCH-001', operation: 'add-node', elementId: 'missing-cache',
      required: true,
      value: { 'node-type': 'database', name: 'Missing cache', description: 'Required cache' }
    }]
  });
  const honest = (await evaluateArchitectureIntentEvidence(
    root, fixture.definition, fixture.workflow, fixture.intent
  )).report;
  assert.equal(honest.blocking, true);
  assert.equal(honest.clauses[0].verdict, 'missing');

  // This is not a bad-hash fixture: it is a syntactically valid report whose self-hash exactly
  // matches the malicious claim. Enforcement must still recompute from projection evidence.
  const tampered = sealRecord({
    ...honest,
    clauses: honest.clauses.map((clause) => ({
      ...clause, verdict: 'fulfilled', elementIds: ['missing-cache']
    })),
    blocking: false
  }, 'reportSha256');
  const reportPath = path.join(fixture.directory, 'intent-fulfilment.json');
  const tamperedBytes = canonicalJson(tampered);
  await writeFile(reportPath, tamperedBytes);

  const status = await projectArchitectureIntentStatus(
    root, fixture.definition, fixture.workflow
  );
  assert.equal(status.fulfilment.status, 'recorded-unverified');
  assert.equal(status.fulfilment.blocking, true);
  assert.equal(status.fulfilment.reportedBlocking, false);

  const gate = await evaluateArchitectureIntentGate(
    root, fixture.definition, fixture.workflow, 'verification'
  );
  assert.equal(gate.code, 'WMC_INTENT_REPORT_MISMATCH');
  assert.ok(gate.reasonCodes.includes('WMC_INTENT_UNFULFILLED'));
  assert.match(gate.errors.join('\n'), /WMC_INTENT_REPORT_MISMATCH/);
  assert.match(gate.errors.join('\n'), /required architecture clause .* is missing/);
  assert.deepEqual(gate.passes, []);
  assert.equal(await readFile(reportPath, 'utf8'), tamperedBytes);
});

test('architecture enforcement refuses unavailable current source without rewriting its report', async (t) => {
  const root = await repository(t);
  await worldModelCommand(root, ['wm', 'build'], { format: 'registered-v4', views: 'dev.impact' });
  const fixture = await approvedIntentFixture(root, {
    workId: 'WRK-SOURCE-GAP',
    clauses: [{
      clauseId: 'WRK-SOURCE-GAP:ARCH-001', operation: 'change-node', elementId: 'platform',
      required: true, value: { name: 'Platform' }
    }]
  });
  const report = (await evaluateArchitectureIntentEvidence(
    root, fixture.definition, fixture.workflow, fixture.intent
  )).report;
  const reportPath = path.join(fixture.directory, 'intent-fulfilment.json');
  const reportBytes = canonicalJson(report);
  await writeFile(reportPath, reportBytes);
  const stateBefore = git(root, ['rev-parse', 'state']);

  await writeFile(path.join(root, 'app.mjs'), 'export const ready = false;\n');
  await assert.rejects(
    () => evaluateArchitectureIntentEvidence(
      root, fixture.definition, fixture.workflow, fixture.intent
    ),
    (error) => error.code === 'WMB_SOURCE_SNAPSHOT_REQUIRED'
      && error.details?.freshness?.status === 'unavailable'
  );
  const gate = await evaluateArchitectureIntentGate(
    root, fixture.definition, fixture.workflow, 'verification'
  );
  assert.equal(gate.code, 'WMB_SOURCE_SNAPSHOT_REQUIRED');
  assert.match(gate.errors.join('\n'), /WMB_SOURCE_SNAPSHOT_REQUIRED/);
  assert.deepEqual(gate.passes, []);
  assert.equal(await readFile(reportPath, 'utf8'), reportBytes);
  assert.equal(git(root, ['rev-parse', 'state']), stateBefore);
  assert.match(git(root, ['status', '--short']), /app\.mjs/);
});

test('capability authority changes stale a reusable CALM projection without source changes', async (t) => {
  const root = await repository(t);
  await worldModelCommand(root, ['wm', 'build'], { format: 'registered-v4', views: 'dev.impact' });
  const publishedPaths = git(root, [
    'ls-tree', '-r', '--name-only', 'state', '--', 'singularity/world-model'
  ]).split('\n').filter(Boolean);
  const files = Object.fromEntries(publishedPaths.map((target) => [
    target, run('git', ['show', `state:${target}`], { cwd: root }).stdout
  ]));
  const publication = {
    outputDir: 'singularity/world-model',
    manifestPath: 'singularity/world-model/manifest.json',
    manifest: JSON.parse(files['singularity/world-model/manifest.json']),
    files,
    replaceRoots: ['singularity/world-model']
  };
  const capabilityPath = path.join(root, 'singularity', 'capabilities.yml');
  const capabilities = YAML.parse(await readFile(capabilityPath, 'utf8'));
  capabilities.capabilities.platform.name = 'Renamed platform';
  await writeFile(capabilityPath, YAML.stringify(capabilities));

  const status = await worldModelCommand(root, ['wm', 'status'], { json: true });
  assert.equal(status.fresh, false);
  assert.ok(status.freshness.changes.some(
    (change) => change.reason === 'capability-snapshot-changed'
  ));
  await assert.rejects(
    () => validateStagedProjectionAuthorityAgainstSource(root, publication),
    (error) => error.code === 'WMC_PROJECTION_INPUT_CHANGED'
  );
});

test('publication refuses a self-consistent normalized snapshot forged from genuine source bytes', async (t) => {
  const root = await repository(t);
  const current = await resolveCurrentArchitectureProjectionInputs(root, await loadDefinition(root));
  const forged = structuredClone(current);
  forged.capabilitySnapshot.capabilities[0].label = 'Forged label';
  forged.capabilitySnapshot = sealRecord({
    ...forged.capabilitySnapshot, snapshotSha256: undefined
  }, 'snapshotSha256');

  assert.throws(
    () => assertArchitectureProjectionAuthoritySnapshots(forged, current),
    (error) => error.code === 'WMC_PROJECTION_INPUT_CHANGED'
      && error.details.changes[0].authority === 'capability'
  );
});
