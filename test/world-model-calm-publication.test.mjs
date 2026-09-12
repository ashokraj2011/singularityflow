import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { initializeDefinition, loadDefinition, resolveWorkType } from '../src/config.mjs';
import { recordSha256 } from '../src/records.mjs';
import { setAgentSession } from '../src/session.mjs';
import { createWorkflow, loadConfig } from '../src/state.mjs';
import { run } from '../src/util.mjs';
import { worldModelCommand } from '../src/worldmodel.mjs';
import {
  assertApprovedArchitectureIntent, createArchitectureIntentStabilityGuard,
  evaluateArchitectureIntentGate, projectArchitectureIntentStatus
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
import { readPendingPublication, writePendingPublication } from '../src/publication-pending.mjs';
import { validateStagedProjectionAuthorityAgainstSource } from '../src/world-model/publish/transaction.mjs';
import {
  assertArchitectureProjectionAuthoritySnapshots, resolveCurrentArchitectureProjectionInputs
} from '../src/world-model/projections/calm/authority.mjs';
import { resolveArchitectureIntentBase } from '../src/commands/architecture.mjs';
import { loadAcceptedStoryExecution } from '../src/accepted-story-execution.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function git(root, args) { return run('git', args, { cwd: root }).stdout.trim(); }

function flow(root, args, {
  allowFailure = false, actor = 'Architecture Reviewer', env = {}
} = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SINGULARITY_FLOW_TEST_IDENTITY: actor,
      ...env
    }
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `singularity-flow ${args.join(' ')} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
    );
  }
  return result;
}

function flowAsync(root, args, { actor = 'Architecture Reviewer', env = {} } = {}) {
  const child = spawn(process.execPath, [bin, ...args], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SINGULARITY_FLOW_TEST_IDENTITY: actor,
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  return {
    child,
    completed: new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
    })
  };
}

async function waitForRemoteCommit(root, remote, branch, before, { timeoutMs = 8_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observed = spawnSync('git', [
      '--git-dir', remote, 'rev-parse', '--verify', `refs/heads/${branch}`
    ], { cwd: root, encoding: 'utf8' });
    const commit = observed.status === 0 ? observed.stdout.trim() : null;
    if (commit && commit !== before) return commit;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Remote ${branch} did not advance within ${timeoutMs}ms.`);
}

async function publishCorruptStatePath(root, relativePath, bytes) {
  const worktree = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmc-corrupt-state-'));
  let attached = false;
  try {
    git(root, ['worktree', 'add', '-q', '--detach', worktree, 'refs/remotes/origin/state']);
    attached = true;
    const target = path.join(worktree, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    // Make the authority's manifest path part of this commit without changing its parsed or
    // self-declared identity. Historical lookup is intentionally bounded to manifest history;
    // this models a reserialized matching declaration whose transitive source map is corrupt.
    const manifestPath = 'singularity/world-model/manifest.json';
    const manifestTarget = path.join(worktree, manifestPath);
    await writeFile(manifestTarget, `${await readFile(manifestTarget, 'utf8')} \n`);
    git(worktree, ['add', relativePath, manifestPath]);
    git(worktree, ['commit', '-q', '-m', 'corrupt retained architecture evidence']);
    const commit = git(worktree, ['rev-parse', 'HEAD']);
    git(worktree, ['push', '-q', 'origin', `${commit}:refs/heads/state`]);
    git(root, ['fetch', '-q', 'origin', 'state']);
    return commit;
  } finally {
    if (attached) {
      run('git', ['worktree', 'remove', '--force', worktree], {
        cwd: root, allowFailure: true
      });
    }
    await rm(worktree, { recursive: true, force: true });
  }
}

async function repository(t, { publication = 'off' } = {}) {
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
  workflow.git.publish = publication;
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
    phaseOverrides: {
      planning: { inputs: [] },
      verification: {
        inputs: ['planning'],
        approval: { rejectTo: ['planning', 'verification'] }
      }
    }
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

async function downgradeOwningPublicationToLegacy(root, workId, phaseId = 'planning') {
  const workflowPath = path.join(
    root, 'singularity', 'work-items', workId, 'workflow.json'
  );
  const workflow = JSON.parse(await readFile(workflowPath, 'utf8'));
  const phase = workflow.phases[phaseId];
  const publication = phase.generationPublications.find((entry) =>
    Number(entry.generation) === Number(phase.generation));
  const recordPath = publication.record.path;
  const absoluteRecordPath = path.join(root, recordPath);
  const record = JSON.parse(await readFile(absoluteRecordPath, 'utf8'));

  // Model the exact historical v1 shape. Its own hash and the aggregate's record reference are
  // updated before amending the still-unsubmitted generation commit; no current binding is copied
  // into the legacy record.
  record.schemaVersion = 1;
  delete record.architectureIntent;
  delete record.architectureDecision;
  const { recordSha256: _priorRecordSha256, ...core } = record;
  record.recordSha256 = `sha256:${recordSha256(core)}`;
  publication.record.sha256 = record.recordSha256;
  delete publication.architectureIntent;
  delete publication.architectureDecision;
  if (phase.generationIntent?.publication?.record) {
    phase.generationIntent.publication.record.sha256 = record.recordSha256;
  }
  workflow.schemaVersion = 5;
  for (const storedPhase of Object.values(workflow.phases)) {
    delete storedPhase.submissionArchitectureDecision;
    for (const storedPublication of storedPhase.generationPublications ?? []) {
      delete storedPublication.architectureIntent;
      delete storedPublication.architectureDecision;
    }
  }
  await writeFile(absoluteRecordPath, `${JSON.stringify(record, null, 2)}\n`);
  await writeFile(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`);
  git(root, ['add', recordPath, path.relative(root, workflowPath)]);
  git(root, ['commit', '--amend', '-q', '--no-edit']);
}

async function approvedIntentFixture(root, {
  workId = 'WRK-CALM', clauses, exerciseLivePolicyDrift = false,
  legacyPublication = false
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
  if (legacyPublication) await downgradeOwningPublicationToLegacy(root, workId);
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

async function authorableIntentStory(root, workId, { publication = 'off' } = {}) {
  git(root, ['switch', '-q', '-c', workId, 'origin/main']);
  const config = await loadConfig(root);
  config.git.publish = publication;
  config.worldModel.grounding = 'off';
  const actor = { name: 'Architecture Reviewer', email: 'wmc@example.invalid', login: null };
  await setAgentSession(root, config, actor, 'architect', workId, {
    phaseId: 'planning', source: 'test'
  });
  await createWorkflow(root, config, {
    id: workId,
    title: 'Guard architecture intent publication ordering',
    source: {
      type: 'manual', key: workId, title: 'Guard architecture intent publication ordering',
      description: 'Do not accept a new architecture intent while lifecycle publication is pending.',
      acceptanceCriteria: ['Pending lifecycle publication must be recovered before intent mutation.']
    },
    baseBranch: 'main',
    workType: 'architecture-lifecycle-test',
    agent: 'architect',
    resolved: resolveWorkType(config, 'architecture-lifecycle-test')
  });
  git(root, ['add', `singularity/work-items/${workId}`]);
  git(root, ['commit', '-q', '-m', `[${workId}][init] create pending-publication fixture`]);
  if (publication !== 'off') git(root, ['push', '-q', '-u', 'origin', workId]);
  return config;
}

async function writeIntentCandidate(root, workId, elementId, {
  operation = 'remove-node', required = false, value = {}, generation
} = {}) {
  const relative = `architecture-intent-${workId}.json`;
  await writeFile(path.join(root, relative), `${JSON.stringify({
    phase: 'planning',
    ...(generation === undefined ? {} : { generation }),
    clauses: [{
      clauseId: `${workId}:ARCH-001`, operation, elementId, required, value
    }]
  }, null, 2)}\n`);
  return relative;
}

async function writePhaseArtifact(root, workId, phaseId, paragraph) {
  const accepted = await loadAcceptedStoryExecution(root, workId);
  const phase = accepted.workflow.phases[phaseId];
  const target = path.join(
    root, accepted.definition.workItemRoot, workId, phase.requiredArtifact.path
  );
  await writeFile(target,
    `# ${phase.label}\n\n## Scope\n\n${paragraph}\n\n## Evidence\n\n`
    + 'The governed lifecycle binds this reviewed artifact to the exact phase generation, '
    + 'repository revision, architecture evidence, and approval record. Historical evidence '
    + 'remains immutable so later generations can be reviewed without transferring authority.\n');
  return target;
}

async function retainStoryPublication(root, workId) {
  await writePendingPublication(root, {
    kind: 'story',
    id: workId,
    record: {
      schemaVersion: 2,
      subject: { kind: 'story', id: workId },
      branch: workId,
      remote: 'origin',
      commit: null,
      event: null,
      transactionId: `pending-${workId}`,
      tree: null,
      eventSha256: null,
      stateSha256: null,
      publicationMode: 'required',
      recoveryStage: 'interrupted-before-branch-ref-advanced',
      createdAt: '2026-09-12T00:00:00.000Z'
    }
  });
}

function assertPendingIntentRefusal(result, action) {
  assert.notEqual(result.status, 0);
  const refusal = JSON.parse(result.stderr);
  assert.equal(refusal.resultType, 'command-result');
  assert.equal(refusal.outcome.status, 'refused');
  assert.equal(refusal.outcome.messageId, 'sequence.refused');
  assert.equal(refusal.outcome.slots.action, `${action} architecture intent`);
  assert.equal(refusal.outcome.slots.gate, 'publicationPending');
  assert.equal(refusal.why[0].code, 'publication.pending');
  assert.equal(refusal.next[0].command, 'singularity-flow sync');
  assert.deepEqual(refusal.effects, {
    stateChanged: false,
    filesChanged: false,
    publicationCreated: false,
    externalSystemsChanged: false
  });
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

test('architecture intent init refuses pending Story publication before creating a draft', async (t) => {
  const root = await repository(t);
  const workId = 'WRK-PENDING-INIT';
  await authorableIntentStory(root, workId);
  const candidate = `architecture-intent-${workId}.json`;
  await writeFile(path.join(root, candidate), `${JSON.stringify({
    phase: 'planning',
    clauses: [{
      clauseId: `${workId}:ARCH-001`, operation: 'remove-node', elementId: 'legacy-node',
      required: false, value: {}
    }]
  }, null, 2)}\n`);
  await retainStoryPublication(root, workId);

  const result = flow(root, [
    'architecture', 'intent', 'init', '--work-id', workId, '--from', candidate, '--json'
  ], { allowFailure: true });
  assertPendingIntentRefusal(result, 'init');
  await assert.rejects(
    readFile(path.join(
      root, 'singularity', 'work-items', workId, 'context', 'architecture',
      'architecture-intent.json'
    )),
    (error) => error?.code === 'ENOENT'
  );
});

test('architecture intent revise refuses pending Story publication without changing the draft', async (t) => {
  const root = await repository(t);
  const workId = 'WRK-PENDING-REVISE';
  await authorableIntentStory(root, workId);
  const intentPath = path.join(
    root, 'singularity', 'work-items', workId, 'context', 'architecture',
    'architecture-intent.json'
  );
  const existing = createArchitectureIntent({
    workId, phase: 'planning', generation: 1,
    base: {
      worldModelManifestSha256: `sha256:${'a'.repeat(64)}`,
      calmProjectionSha256: `sha256:${'b'.repeat(64)}`
    },
    clauses: [{
      clauseId: `${workId}:ARCH-001`, operation: 'remove-node', elementId: 'legacy-node',
      required: false, value: {}
    }]
  });
  await mkdir(path.dirname(intentPath), { recursive: true });
  const existingBytes = canonicalJson(existing);
  await writeFile(intentPath, existingBytes);
  const candidate = `architecture-intent-${workId}.json`;
  await writeFile(path.join(root, candidate), `${JSON.stringify({
    phase: 'planning',
    clauses: [{
      clauseId: `${workId}:ARCH-001`, operation: 'remove-node', elementId: 'replacement-node',
      required: false, value: {}
    }]
  }, null, 2)}\n`);
  await retainStoryPublication(root, workId);

  const result = flow(root, [
    'architecture', 'intent', 'revise', '--work-id', workId, '--from', candidate,
    '--expect-intent', existing.intentSha256, '--json'
  ], { allowFailure: true });
  assertPendingIntentRefusal(result, 'revise');
  assert.equal(await readFile(intentPath, 'utf8'), existingBytes);
});

test('architecture intent creation is idempotent and conflicting init or stale revise cannot overwrite it', async (t) => {
  const root = await repository(t);
  const workId = 'WRK-INTENT-CAS';
  await worldModelCommand(root, ['wm', 'build'], {
    format: 'registered-v4', views: 'dev.impact'
  });
  await authorableIntentStory(root, workId);
  const candidate = await writeIntentCandidate(root, workId, 'legacy-service');

  const created = JSON.parse(flow(root, [
    'architecture', 'intent', 'init', '--work-id', workId, '--from', candidate, '--json'
  ]).stdout);
  assert.equal(created.status, 'created');
  assert.equal(created.generation, 1);
  const intentPath = path.join(root, created.path);
  const acceptedBytes = await readFile(intentPath, 'utf8');
  const workflowPath = path.join(
    root, 'singularity', 'work-items', workId, 'workflow.json'
  );
  assert.equal(JSON.parse(await readFile(workflowPath, 'utf8')).phases.planning.generation, 0);

  const identical = JSON.parse(flow(root, [
    'architecture', 'intent', 'init', '--work-id', workId, '--from', candidate, '--json'
  ]).stdout);
  assert.equal(identical.status, 'existing');
  assert.equal(identical.intentSha256, created.intentSha256);
  assert.equal(await readFile(intentPath, 'utf8'), acceptedBytes);

  const conflicting = await writeIntentCandidate(root, workId, 'replacement-service');
  const initConflict = flow(root, [
    'architecture', 'intent', 'init', '--work-id', workId, '--from', conflicting, '--json'
  ], { allowFailure: true });
  assert.notEqual(initConflict.status, 0);
  assert.match(initConflict.stderr, /WMC_INTENT_ALREADY_EXISTS/);
  assert.equal(await readFile(intentPath, 'utf8'), acceptedBytes);

  const staleRevision = flow(root, [
    'architecture', 'intent', 'revise', '--work-id', workId, '--from', conflicting,
    '--expect-intent', `sha256:${'0'.repeat(64)}`, '--json'
  ], { allowFailure: true });
  assert.notEqual(staleRevision.status, 0);
  assert.match(staleRevision.stderr, /WMC_INTENT_REVISION_CONFLICT/);
  assert.equal(await readFile(intentPath, 'utf8'), acceptedBytes);
  assert.equal(JSON.parse(await readFile(workflowPath, 'utf8')).phases.planning.generation, 0);
});

test('lost publication response recovers the exact intent generation without allocating another one', async (t) => {
  const root = await repository(t, { publication: 'required' });
  const remote = `${root}.git`;
  const workId = 'WRK-INTENT-PUSH-LOSS';
  await worldModelCommand(root, ['wm', 'build'], {
    format: 'registered-v4', views: 'dev.impact'
  });
  await authorableIntentStory(root, workId, { publication: 'required' });
  const candidate = await writeIntentCandidate(root, workId, 'legacy-service');
  const created = JSON.parse(flow(root, [
    'architecture', 'intent', 'init', '--work-id', workId, '--from', candidate, '--json'
  ]).stdout);
  await rm(path.join(root, candidate));
  await writePhaseArtifact(
    root, workId, 'planning',
    'The first architecture generation removes the reviewed legacy service without changing its immutable base authority.'
  );
  const baseline = git(root, ['rev-parse', 'HEAD']);
  const hook = path.join(remote, 'hooks', 'post-receive');
  await writeFile(hook, '#!/bin/sh\nsleep 4\n');
  await chmod(hook, 0o755);

  const interrupted = flow(root, [
    'phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place'
  ], {
    allowFailure: true,
    env: { SINGULARITY_FLOW_GIT_PUSH_TIMEOUT_MS: '750' }
  });
  assert.notEqual(interrupted.status, 0);
  assert.match(`${interrupted.stdout}\n${interrupted.stderr}`, /retained locally but push failed/i);

  const pending = await readPendingPublication(root, { kind: 'story', id: workId });
  assert.equal(pending.record.pushOutcome, 'transport-indeterminate');
  const publishedCommit = pending.record.commit;
  assert.notEqual(publishedCommit, baseline);
  assert.equal(git(root, ['rev-parse', 'HEAD']), publishedCommit);
  assert.equal(await waitForRemoteCommit(root, remote, workId, baseline), publishedCommit);
  await writeFile(hook, '#!/bin/sh\nexit 0\n');
  await chmod(hook, 0o755);

  let accepted = await loadAcceptedStoryExecution(root, workId);
  assert.equal(accepted.workflow.phases.planning.generation, 1);
  assert.equal(accepted.workflow.phases.planning.generationPublications.length, 1);
  assert.equal(
    accepted.workflow.phases.planning.generationPublications[0].architectureIntent.intentSha256,
    created.intentSha256
  );

  flow(root, ['sync']);
  assert.equal(await readPendingPublication(root, { kind: 'story', id: workId }), null);
  assert.equal(git(root, ['rev-parse', 'HEAD']), publishedCommit);
  accepted = await loadAcceptedStoryExecution(root, workId);
  assert.equal(accepted.workflow.phases.planning.generation, 1);
  assert.equal(accepted.workflow.phases.planning.generationPublications.length, 1);

  const duplicate = flow(root, [
    'phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place'
  ], { allowFailure: true });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /targets generation 1, but the next 'planning' publication is generation 2/);
  assert.equal(git(root, ['rev-parse', 'HEAD']), publishedCommit);
  accepted = await loadAcceptedStoryExecution(root, workId);
  assert.equal(accepted.workflow.phases.planning.generation, 1);
  assert.equal(accepted.workflow.phases.planning.generationPublications.length, 1);
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

  // The fixture deliberately left a conflicting live policy in the worktree to prove the
  // accepted Story uses its saved closure. Remove that unrelated probe before exercising a real
  // protected-path publication boundary.
  await writeFile(
    path.join(root, 'singularity', 'workflow.yml'),
    `${git(root, ['show', 'HEAD:singularity/workflow.yml'])}\n`
  );
  flow(root, ['prepare', 'verification']);
  await writePhaseArtifact(
    root, workflow.workItem.id, 'verification',
    'The exact approved architecture intent is fulfilled by the independently verified current CALM authority.'
  );
  flow(root, [
    'phase', 'publish', 'verification', '--authored', 'human', '--channel', 'manual-in-place'
  ]);
  let accepted = await loadAcceptedStoryExecution(root, workflow.workItem.id);
  let verification = accepted.workflow.phases.verification;
  const enforcingPublication = verification.generationPublications.find(
    (entry) => Number(entry.generation) === Number(verification.generation)
  );
  assert.deepEqual(enforcingPublication.architectureDecision, satisfied.architectureDecision);
  assert.deepEqual(Object.keys(enforcingPublication.architectureDecision).sort(), [
    'afterAuthorityCommit', 'afterManifestSha256', 'afterProjectionSha256',
    'approvalEvidenceCommit', 'beforeManifestSha256', 'beforeProjectionSha256',
    'computedReportSha256', 'intentGeneration', 'intentPhase', 'intentSha256',
    'sourceManifestSha256', 'verifierProfile'
  ]);

  flow(root, ['submit', 'verification', '--skip-checks']);
  accepted = await loadAcceptedStoryExecution(root, workflow.workItem.id);
  verification = accepted.workflow.phases.verification;
  assert.deepEqual(
    verification.submissionArchitectureDecision,
    { generation: verification.generation, identity: enforcingPublication.architectureDecision }
  );
  const submittedHead = git(root, ['rev-parse', 'HEAD']);

  // The publication/approval guard must reject a source observation that disappears after its
  // successful first pass. This is a retryable snapshot race, not a second readiness decision.
  const sourceGuard = await createArchitectureIntentStabilityGuard(
    root, accepted.definition, accepted.workflow, verification, verification.generation,
    { operation: 'the approval commit' }
  );
  const applicationPath = path.join(root, 'app.mjs');
  const applicationBytes = await readFile(applicationPath, 'utf8');
  await writeFile(applicationPath, 'export const ready = false;\n');
  await assert.rejects(
    sourceGuard,
    (error) => error.code === 'PUBLICATION_SNAPSHOT_CHANGED'
  );
  await writeFile(applicationPath, applicationBytes);
  assert.equal(git(root, ['status', '--short']), '');
  assert.equal(git(root, ['rev-parse', 'HEAD']), submittedHead);

  // A state ref can move without changing projection bytes. The durable decision remains bound to
  // the World-Model publication commit, while the operation-scoped authority observation makes
  // this same stability guard reject a mixed validation window.
  const priorAuthority = git(root, ['rev-parse', 'refs/remotes/origin/state']);
  const stateTree = git(root, ['rev-parse', `${priorAuthority}^{tree}`]);
  const advancedAuthority = run('git', [
    '-c', 'user.name=State Authority', '-c', 'user.email=state-authority@example.invalid',
    'commit-tree', stateTree, '-p', priorAuthority, '-m', 'advance equivalent state authority'
  ], { cwd: root }).stdout.trim();
  git(root, ['push', '-q', 'origin', `${advancedAuthority}:refs/heads/state`]);
  git(root, ['fetch', '-q', 'origin', 'state']);
  await assert.rejects(
    sourceGuard,
    (error) => error.code === 'PUBLICATION_SNAPSHOT_CHANGED'
  );
  assert.equal(git(root, ['rev-parse', 'HEAD']), submittedHead);

  const unavailableBaseIntent = createArchitectureIntent({
    workId: intent.workId,
    phase: intent.phase,
    generation: intent.generation,
    base: {
      worldModelManifestSha256: `sha256:${'7'.repeat(64)}`,
      calmProjectionSha256: `sha256:${'8'.repeat(64)}`
    },
    clauses: intent.clauses
  });
  assert.throws(
    () => resolveArchitectureIntentBase(root, accepted.definition, unavailableBaseIntent),
    (error) => error.code === 'WMC_INTENT_BASE_STALE'
      && error.details?.worldModelManifestSha256
        === unavailableBaseIntent.base.worldModelManifestSha256
  );

  // A newer retained commit that copies a matching manifest declaration but corrupts the bound
  // source map is an integrity failure. The resolver must not skip it and borrow a convenient
  // older valid publication with the same editable manifest identity.
  await publishCorruptStatePath(
    root, 'singularity/world-model/catalogs/projections/arch.calm.sources.json',
    '{"corrupt":true}\n'
  );
  assert.throws(
    () => resolveArchitectureIntentBase(root, accepted.definition, intent),
    (error) => error.code !== 'WMC_INTENT_BASE_STALE'
      && /source map|projection/i.test(error.message)
  );
  assert.equal(git(root, ['rev-parse', 'HEAD']), submittedHead);
});

test('reopened owner generation keeps generation-one history and requires a new exact approval', async (t) => {
  const root = await repository(t);
  const workId = 'WRK-INTENT-GEN2';
  await worldModelCommand(root, ['wm', 'build'], {
    format: 'registered-v4', views: 'dev.impact'
  });
  const first = await approvedIntentFixture(root, {
    workId,
    clauses: [{
      clauseId: `${workId}:ARCH-001`, operation: 'change-node', elementId: 'platform',
      required: true, value: { name: 'Platform' }
    }]
  });
  const generationOneBytes = await readFile(first.intentPath, 'utf8');
  const generationOnePublication = first.workflow.phases.planning.generationPublications[0];
  const generationOneApproval = first.workflow.phases.planning.approvals.find(
    (entry) => entry.decision === 'approved' && entry.generation === 1
  );
  assert.ok(generationOneApproval);

  flow(root, ['architecture', 'intent', 'verify', '--work-id', workId, '--json']);
  flow(root, ['prepare', 'verification']);
  await writePhaseArtifact(
    root, workId, 'verification',
    'Generation one architecture evidence is deterministic, complete, and ready for a governed change request.'
  );
  flow(root, [
    'phase', 'publish', 'verification', '--authored', 'human', '--channel', 'manual-in-place'
  ]);
  flow(root, ['submit', 'verification', '--skip-checks']);
  flow(root, [
    'reject', 'verification', '--to', 'planning', '--reason',
    'The approved owner phase requires a reviewed generation-two architecture revision.'
  ]);

  let accepted = await loadAcceptedStoryExecution(root, workId);
  let planning = accepted.workflow.phases.planning;
  assert.equal(planning.status, 'in_progress');
  assert.equal(planning.generation, 1);
  assert.deepEqual(planning.generationPublications.map((entry) => entry.generation), [1]);
  assert.ok(planning.approvals.find(
    (entry) => entry.generation === 1 && entry.decision === 'approved' && entry.invalidatedAt
  ));

  const candidate = await writeIntentCandidate(root, workId, 'platform', {
    operation: 'change-node', required: true, value: { name: 'Platform generation two' }
  });
  const revised = JSON.parse(flow(root, [
    'architecture', 'intent', 'revise', '--work-id', workId, '--from', candidate,
    '--expect-intent', first.intent.intentSha256, '--json'
  ]).stdout);
  await rm(path.join(root, candidate));
  assert.equal(revised.status, 'revised');
  assert.equal(revised.generation, 2);
  const generationTwoBytes = await readFile(first.intentPath, 'utf8');
  assert.notEqual(generationTwoBytes, generationOneBytes);
  const generationTwoIntent = JSON.parse(generationTwoBytes);
  await assert.rejects(
    assertApprovedArchitectureIntent(
      root, accepted.definition, accepted.workflow, generationTwoIntent, first.intentPath
    ),
    (error) => error.code === 'WMC_INTENT_NOT_APPROVED'
  );

  await writePhaseArtifact(
    root, workId, 'planning',
    'Generation two replaces the reviewed platform label while retaining every immutable generation-one publication and decision.'
  );
  flow(root, [
    'phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place'
  ]);
  flow(root, ['submit', 'planning', '--skip-checks']);
  accepted = await loadAcceptedStoryExecution(root, workId);
  planning = accepted.workflow.phases.planning;
  assert.equal(planning.generation, 2);
  assert.deepEqual(planning.generationPublications.map((entry) => entry.generation), [1, 2]);
  assert.deepEqual(planning.generationPublications[0], generationOnePublication);
  assert.ok(planning.approvals.find(
    (entry) => entry.generation === 1 && entry.decision === 'approved' && entry.invalidatedAt
  ));
  await assert.rejects(
    assertApprovedArchitectureIntent(
      root, accepted.definition, accepted.workflow, generationTwoIntent, first.intentPath
    ),
    (error) => error.code === 'WMC_INTENT_NOT_APPROVED'
  );

  flow(root, ['approve', 'planning', '--yes']);
  accepted = await loadAcceptedStoryExecution(root, workId);
  planning = accepted.workflow.phases.planning;
  const activeApprovals = planning.approvals.filter(
    (entry) => entry.decision === 'approved' && !entry.invalidatedAt
  );
  assert.deepEqual(activeApprovals.map((entry) => entry.generation), [2]);
  assert.equal(
    planning.generationPublications[1].architectureIntent.intentSha256,
    generationTwoIntent.intentSha256
  );
  assert.equal((await assertApprovedArchitectureIntent(
    root, accepted.definition, accepted.workflow, generationTwoIntent, first.intentPath
  )).approved, true);
  assert.equal(generationOneApproval.generation, 1);
});

test('editing an approved current intent cannot borrow its published approval', async (t) => {
  const root = await repository(t);
  const workId = 'WRK-INTENT-POST-PUBLISH-EDIT';
  await worldModelCommand(root, ['wm', 'build'], {
    format: 'registered-v4', views: 'dev.impact'
  });
  const fixture = await approvedIntentFixture(root, {
    workId,
    clauses: [{
      clauseId: `${workId}:ARCH-001`, operation: 'change-node', elementId: 'platform',
      required: true, value: { name: 'Approved platform' }
    }]
  });
  const acceptedHead = git(root, ['rev-parse', 'HEAD']);
  const replacement = createArchitectureIntent({
    workId, phase: 'planning', generation: 1, base: fixture.intent.base,
    clauses: [{
      clauseId: `${workId}:ARCH-001`, operation: 'change-node', elementId: 'platform',
      required: true, value: { name: 'Unapproved edited platform' }
    }]
  });
  await writeFile(fixture.intentPath, canonicalJson(replacement));

  await assert.rejects(
    assertApprovedArchitectureIntent(
      root, fixture.definition, fixture.workflow, replacement, fixture.intentPath
    ),
    (error) => error.code === 'WMC_INTENT_NOT_APPROVED'
  );
  const render = flow(root, [
    'architecture', 'intent', 'render', '--work-id', workId, '--json'
  ], { allowFailure: true });
  assert.notEqual(render.status, 0);
  assert.match(render.stderr, /WMC_INTENT_NOT_APPROVED/);
  assert.equal(git(root, ['rev-parse', 'HEAD']), acceptedHead);
  const accepted = await loadAcceptedStoryExecution(root, workId);
  assert.equal(
    accepted.workflow.phases.planning.approvals.filter(
      (entry) => entry.decision === 'approved' && !entry.invalidatedAt
    ).length,
    1
  );
  assert.equal(
    accepted.workflow.phases.planning.generationPublications[0].architectureIntent.intentSha256,
    fixture.intent.intentSha256
  );
  assert.notEqual(replacement.intentSha256, fixture.intent.intentSha256);
});

test('publication and intent revision serialize on one Story lock without mixed evidence', async (t) => {
  const root = await repository(t, { publication: 'required' });
  const remote = `${root}.git`;
  const workId = 'WRK-INTENT-PUBLISH-REVISE-RACE';
  await worldModelCommand(root, ['wm', 'build'], {
    format: 'registered-v4', views: 'dev.impact'
  });
  await authorableIntentStory(root, workId, { publication: 'required' });
  const initialCandidate = await writeIntentCandidate(root, workId, 'legacy-service');
  const created = JSON.parse(flow(root, [
    'architecture', 'intent', 'init', '--work-id', workId,
    '--from', initialCandidate, '--json'
  ]).stdout);
  await rm(path.join(root, initialCandidate));
  const intentPath = path.join(root, created.path);
  const initialBytes = await readFile(intentPath, 'utf8');
  await writePhaseArtifact(
    root, workId, 'planning',
    'The exact initial intent must remain stable while the governing publication owns the Story mutation lease.'
  );
  const before = git(root, ['rev-parse', 'HEAD']);
  const hook = path.join(remote, 'hooks', 'post-receive');
  await writeFile(hook, '#!/bin/sh\nsleep 4\n');
  await chmod(hook, 0o755);

  const publishing = flowAsync(root, [
    'phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place'
  ]);
  const remotePublication = await waitForRemoteCommit(root, remote, workId, before);
  const revisedCandidate = await writeIntentCandidate(root, workId, 'replacement-service');
  const revision = flow(root, [
    'architecture', 'intent', 'revise', '--work-id', workId, '--from', revisedCandidate,
    '--expect-intent', created.intentSha256, '--json'
  ], { allowFailure: true });
  await rm(path.join(root, revisedCandidate));
  const published = await publishing.completed;
  await writeFile(hook, '#!/bin/sh\nexit 0\n');
  await chmod(hook, 0o755);
  assert.notEqual(revision.status, 0);
  const refusal = JSON.parse(revision.stderr);
  assert.equal(refusal.outcome.status, 'refused');
  assert.equal(refusal.outcome.slots.gate, 'publicationPending');
  assert.equal(refusal.why[0].code, 'publication.pending');
  assert.equal(published.status, 0, `${published.stdout}\n${published.stderr}`);
  assert.equal(git(root, ['rev-parse', 'HEAD']), remotePublication);
  assert.equal(await readFile(intentPath, 'utf8'), initialBytes);

  const accepted = await loadAcceptedStoryExecution(root, workId);
  const planning = accepted.workflow.phases.planning;
  assert.equal(planning.generation, 1);
  assert.equal(planning.generationPublications.length, 1);
  assert.equal(
    planning.generationPublications[0].architectureIntent.intentSha256,
    created.intentSha256
  );
  assert.equal(
    git(root, ['show', `${remotePublication}:${created.path}`]),
    initialBytes.trimEnd()
  );
});

test('a legacy v1 publication keeps an exactly proven approved intent without inventing a binding', async (t) => {
  const root = await repository(t);
  await worldModelCommand(root, ['wm', 'build'], {
    format: 'registered-v4', views: 'dev.impact'
  });
  const fixture = await approvedIntentFixture(root, {
    workId: 'WRK-LEGACY-INTENT',
    legacyPublication: true,
    clauses: [{
      clauseId: 'WRK-LEGACY-INTENT:ARCH-001', operation: 'change-node',
      elementId: 'platform', required: true, value: { name: 'Platform' }
    }]
  });
  const phase = fixture.workflow.phases.planning;
  const publication = phase.generationPublications.find((entry) => entry.generation === 1);
  const rawRecord = JSON.parse(git(root, [
    'show', `${phase.generationCommit}:${publication.record.path}`
  ]));
  assert.equal(rawRecord.schemaVersion, 1);
  assert.equal(Object.hasOwn(rawRecord, 'architectureIntent'), false);
  assert.equal(publication.architectureIntent, null);

  const approved = await assertApprovedArchitectureIntent(
    root, fixture.definition, fixture.workflow, fixture.intent, fixture.intentPath
  );
  assert.equal(approved.approved, true);
  assert.equal(approved.publicationBinding, null);

  // A different unapproved file that still names the already-published legacy generation cannot
  // borrow that historical approval. The compatibility reader proves bytes; it never relabels a
  // current draft or manufactures the missing publication binding.
  const replacement = createArchitectureIntent({
    workId: fixture.intent.workId,
    phase: fixture.intent.phase,
    generation: fixture.intent.generation,
    base: fixture.intent.base,
    clauses: [{
      clauseId: 'WRK-LEGACY-INTENT:ARCH-002', operation: 'remove-node',
      elementId: 'different-node', required: false, value: {}
    }]
  });
  await writeFile(fixture.intentPath, canonicalJson(replacement));
  await assert.rejects(
    assertApprovedArchitectureIntent(
      root, fixture.definition, fixture.workflow, replacement, fixture.intentPath
    ),
    (error) => error.code === 'WMC_INTENT_NOT_APPROVED'
      && error.details.reasons.some((reason) => /legacy architecture intent publication cannot be proven/.test(reason))
  );
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
  const reportPath = path.join(fixture.directory, 'intent-fulfilment.json');

  const missingReport = await evaluateArchitectureIntentGate(
    root, fixture.definition, fixture.workflow, 'verification'
  );
  assert.equal(missingReport.code, 'WMC_INTENT_UNFULFILLED');
  assert.match(missingReport.errors.join('\n'), /has no fulfilment receipt/);
  await assert.rejects(readFile(reportPath), (error) => error?.code === 'ENOENT');

  const honestBytes = canonicalJson(honest);
  await writeFile(reportPath, honestBytes);
  const matchingBlocking = await evaluateArchitectureIntentGate(
    root, fixture.definition, fixture.workflow, 'verification'
  );
  assert.equal(matchingBlocking.code, 'WMC_INTENT_UNFULFILLED');
  assert.equal(matchingBlocking.reasonCodes.includes('WMC_INTENT_REPORT_MISMATCH'), false);
  assert.match(matchingBlocking.errors.join('\n'), /required architecture clause .* is missing/);
  assert.equal(await readFile(reportPath, 'utf8'), honestBytes);

  // Each semantic binding is checked independently against evaluator-owned evidence. Every
  // variant below is structurally valid and correctly self-hashed; none relies on the trivial
  // bad-hash rejection path.
  const alteredDigest = `sha256:${'9'.repeat(64)}`;
  const selfHashedTamperCases = [
    ['required result removed', {
      ...honest, clauses: []
    }],
    ['intent identity changed', {
      ...honest, intentSha256: alteredDigest
    }],
    ['historical base changed', {
      ...honest, baseBeforeSha256: alteredDigest
    }],
    ['current projection changed', {
      ...honest, baseAfterSha256: alteredDigest
    }],
    ['source-map references changed', {
      ...honest,
      clauses: honest.clauses.map((clause) => ({
        ...clause, sourceRefs: [`capability:forged@${alteredDigest}`]
      }))
    }],
    ['another Story report substituted', {
      ...honest, workId: 'WRK-OTHER'
    }]
  ];
  for (const [label, core] of selfHashedTamperCases) {
    const tamperedReport = sealRecord(core, 'reportSha256');
    const bytes = canonicalJson(tamperedReport);
    await writeFile(reportPath, bytes);
    const refused = await evaluateArchitectureIntentGate(
      root, fixture.definition, fixture.workflow, 'verification'
    );
    assert.ok(
      refused.reasonCodes.includes('WMC_INTENT_REPORT_MISMATCH'),
      `${label}: ${refused.errors.join('\n')}`
    );
    assert.deepEqual(refused.passes, [], label);
    assert.equal(await readFile(reportPath, 'utf8'), bytes, `${label} rewrote the report`);
  }

  // This is not a bad-hash fixture: it is a syntactically valid report whose self-hash exactly
  // matches the malicious claim. Enforcement must still recompute from projection evidence.
  const tampered = sealRecord({
    ...honest,
    clauses: honest.clauses.map((clause) => ({
      ...clause, verdict: 'fulfilled', elementIds: ['missing-cache']
    })),
    blocking: false
  }, 'reportSha256');
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

test('approval keeps a successful architecture decision across unrelated state transactions', async (t) => {
  const root = await repository(t);
  await worldModelCommand(root, ['wm', 'build'], { format: 'registered-v4', views: 'dev.impact' });
  const fixture = await approvedIntentFixture(root, {
    workId: 'WRK-APPROVAL-STATE-MOVE',
    clauses: [{
      clauseId: 'WRK-APPROVAL-STATE-MOVE:ARCH-001', operation: 'change-node',
      elementId: 'platform', required: true, value: { name: 'Platform' }
    }]
  });

  flow(root, [
    'architecture', 'intent', 'verify', '--work-id', fixture.workflow.workItem.id, '--json'
  ]);
  flow(root, ['prepare', 'verification']);
  let workflow = JSON.parse(await readFile(path.join(
    root, 'singularity', 'work-items', fixture.workflow.workItem.id, 'workflow.json'
  ), 'utf8'));
  const artifact = path.join(
    root, 'singularity', 'work-items', fixture.workflow.workItem.id,
    workflow.phases.verification.requiredArtifact.path
  );
  await writeFile(artifact, `# Verification\n\n## Architecture decision\n\nThe deterministic architecture fulfilment report matches the exact approved intent and the current reusable CALM authority.\n\n## Evidence\n\nThe verification generation records the immutable World-Model publication identity before review. Unrelated Story ledger transactions may advance the shared state branch without changing that evidence.\n`);
  flow(root, [
    'phase', 'publish', 'verification', '--authored', 'human', '--channel', 'manual-in-place'
  ]);
  flow(root, ['submit', 'verification', '--skip-checks']);
  workflow = JSON.parse(await readFile(path.join(
    root, 'singularity', 'work-items', fixture.workflow.workItem.id, 'workflow.json'
  ), 'utf8'));
  const submittedDecision = workflow.phases.verification.submissionArchitectureDecision?.identity;
  assert.match(submittedDecision?.afterAuthorityCommit ?? '', /^[a-f0-9]{40,64}$/);
  const storyHead = git(root, ['rev-parse', 'HEAD']);

  // Advance the selected authority without changing any World-Model byte. The branch-tip
  // observation changes, but the manifest publication commit and every decision input stay exact.
  const priorAuthority = git(root, ['rev-parse', 'refs/remotes/origin/state']);
  const stateTree = git(root, ['rev-parse', `${priorAuthority}^{tree}`]);
  const advancedAuthority = run('git', [
    '-c', 'user.name=State Authority', '-c', 'user.email=state-authority@example.invalid',
    'commit-tree', stateTree, '-p', priorAuthority, '-m', 'advance equivalent state authority'
  ], { cwd: root }).stdout.trim();
  git(root, ['push', '-q', 'origin', `${advancedAuthority}:refs/heads/state`]);
  git(root, ['fetch', '-q', 'origin', 'state']);
  assert.notEqual(advancedAuthority, submittedDecision.afterAuthorityCommit);

  const result = flow(root, ['approve', 'verification', '--yes', '--json'], { allowFailure: true });
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(git(root, ['rev-parse', 'HEAD']), storyHead);
  workflow = JSON.parse(await readFile(path.join(
    root, 'singularity', 'work-items', fixture.workflow.workItem.id, 'workflow.json'
  ), 'utf8'));
  assert.equal(workflow.phases.verification.status, 'approved');
  assert.deepEqual(
    workflow.phases.verification.submissionArchitectureDecision.identity,
    submittedDecision
  );
  assert.equal(workflow.phases.verification.approvals.length, 1);
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
