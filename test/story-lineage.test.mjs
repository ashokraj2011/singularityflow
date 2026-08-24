import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin/singularity-flow.mjs');

function command(executable, args, cwd, { allowFailure = false, selection = true } = {}) {
  const selected = typeof selection === 'object'
    ? selection
    : { workType: 'feature', agent: 'developer' };
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Story Developer',
    ...(selection ? { SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify(selected) } : {})
  };
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', env });
  if (!allowFailure && result.status !== 0) throw new Error(`${executable} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

test('spec-driven submission binds downstream briefs to the reviewed generation source', async () => {
  const { root } = await repository();
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.phases.specification.clarification = { mode: 'off', markers: { mode: 'off' } };
  config.phases.specification.specificationQuality = { mode: 'off' };
  await writeFile(configPath, YAML.stringify(config));
  git(root, ['add', configPath]);
  git(root, ['commit', '-m', 'Use deterministic brief fixture policy']);
  git(root, ['push']);

  flow(root, ['start', 'BRIEF-1', '--from-branch', 'main', '--title', 'Bound downstream context'], {
    selection: { workType: 'spec-driven-standard', agent: 'product-owner' }
  });
  const artifactPath = path.join(root, 'singularity/work-items/BRIEF-1/artifacts/specification/spec.md');
  await writeFile(artifactPath, [
    '# Specification — BRIEF-1', '',
    '## Agent brief', '',
    'Deliver approval-bound, bounded context to downstream agents while preserving exact evidence.', '',
    '## Actors', '', 'Developers author evidence and reviewers approve its downstream projection.', '',
    '## User scenarios', '',
    '### S1 — Consume approved context', '',
    '**Given** a reviewed specification **When** implementation prepares **Then** it receives the reviewed brief.', '',
    '## Failure and empty states', '', 'Missing or altered briefs block enforced preparation.', '',
    '## Permissions', '', 'Only configured human authorities approve the source and brief packet.', '',
    '## Boundary conditions', '', 'The rendered projection is bounded to 32768 UTF-8 bytes.', '',
    '## Requirements', '', '- REQ-001 — Bind every brief to source, policy, generation, and consumer.', '',
    '## Non-functional requirements', '', 'Preparation verifies integrity without a model call.', '',
    '## Constitution articles', '', 'No constitution article is active in this fixture.', '',
    '## Assumptions', '', 'Harness Imports remains enabled for exact expansion.', '',
    '## Out of scope', '', 'This fixture does not approve or execute the downstream phase.'
  ].join('\n'));

  const published = flow(root, ['phase', 'publish', 'specification']);
  assert.match(published.stdout, /Agent brief for planning/);
  let workflow = JSON.parse(await readFile(path.join(root, 'singularity/work-items/BRIEF-1/workflow.json'), 'utf8'));
  assert.equal(workflow.phases.specification.agentBriefs.length, 4);
  assert.ok(workflow.phases.specification.agentBriefs.every((brief) => brief.status === 'ready'));

  flow(root, ['submit', 'specification']);
  workflow = JSON.parse(await readFile(path.join(root, 'singularity/work-items/BRIEF-1/workflow.json'), 'utf8'));
  const submission = workflow.lineage.submissions.at(-1);
  const packet = JSON.parse(await readFile(path.join(root, submission.path), 'utf8'));
  assert.equal(packet.agentBriefs.length, 4);
  const source = packet.artifacts.find((artifact) => artifact.path.endsWith('/artifacts/specification/spec.md'));
  for (const brief of packet.agentBriefs) {
    const record = JSON.parse(await readFile(path.join(root, brief.path), 'utf8'));
    assert.equal(record.source.sha256, brief.sourceSha256,
      'the packet binds the exact generation bytes from which the brief was rendered');
    assert.equal(record.integritySha256, brief.integritySha256);
  }
  assert.notEqual(packet.agentBriefs[0].sourceSha256, source.sha256,
    'submission metadata may change the review artifact without redefining the published brief source');
});

function git(root, args, options = {}) {
  return command('git', args, root, { ...options, selection: false });
}

function flow(root, args, options = {}) {
  return command(process.execPath, [bin, ...args], root, options);
}

async function repository() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-lineage-'));
  const root = path.join(base, 'repo');
  const remote = path.join(base, 'remote.git');
  git(base, ['init', '--bare', remote]);
  git(base, ['init', '-b', 'main', root]);
  git(root, ['config', 'user.name', 'Story Developer']);
  git(root, ['config', 'user.email', 'developer@example.com']);
  git(root, ['remote', 'add', 'origin', remote]);
  await writeFile(path.join(root, 'README.md'), '# Story lineage fixture\n');
  flow(root, ['init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  await writeFile(configPath, YAML.stringify(config));
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'Initialize Story repository']);
  git(root, ['push', '-u', 'origin', 'main']);
  return { root, remote };
}

test('registered child branches publish hash-bound review packets and unknown branches require a parent Story', async () => {
  const { root, remote } = await repository();
  flow(root, ['start', 'MOB-123', '--from-branch', 'main', '--title', 'Build mobile login']);
  flow(root, ['story', 'branch', 'create', 'feature/login-ui', '--parent', 'MOB-123']);

  const status = JSON.parse(flow(root, ['story', 'branch', 'status', '--parent', 'MOB-123', '--json']).stdout);
  assert.equal(status.workId, 'MOB-123');
  assert.equal(status.canonicalBranch, 'MOB-123');
  assert.equal(status.currentBranch, 'feature/login-ui');
  assert.equal(status.kind, 'child');
  assert.equal(status.registered, true);

  const workflowPath = path.join(root, 'singularity/work-items/MOB-123/workflow.json');
  let workflow = JSON.parse(await readFile(workflowPath, 'utf8'));
  const artifactPath = path.join(root, 'singularity/work-items/MOB-123/artifacts/intake/intake.md');
  await writeFile(
    artifactPath,
    (await readFile(artifactPath, 'utf8'))
      .replace(/TODO:[^\n]*/g, 'Complete Epic-derived scope and acceptance evidence for the mobile login Story.')
      .replace(/\bTODO\b/g, 'Complete')
  );
  flow(root, ['phase', 'publish', 'intake']);
  const submitted = flow(root, ['story', 'submit']);
  assert.match(submitted.stdout, /Review packet:/);

  workflow = JSON.parse(await readFile(workflowPath, 'utf8'));
  const record = workflow.lineage.submissions.at(-1);
  assert.equal(record.branch, 'feature/login-ui');
  assert.match(record.packetSha256, /^[a-f0-9]{64}$/);
  const packet = JSON.parse(await readFile(path.join(root, record.path), 'utf8'));
  assert.equal(packet.workId, 'MOB-123');
  assert.equal(packet.canonicalBranch, 'MOB-123');
  assert.equal(packet.submittedBranch, 'feature/login-ui');
  assert.equal(packet.packetSha256, record.packetSha256);
  assert.match(
    git(root, ['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'refs/heads/feature/login-ui']).stdout,
    new RegExp(record.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  );

  git(root, ['switch', '-c', 'feature/unregistered']);
  const blocked = flow(root, ['agent', 'MOB-123', '--agent', 'developer'], { allowFailure: true, selection: false });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /not registered for Story 'MOB-123'/);
  assert.match(blocked.stderr, /story branch attach --parent MOB-123/);
});

test('finalize binds a completed Story to its governed specifications and exact source tree', async () => {
  const { root, remote } = await repository();
  flow(root, ['start', 'MOB-200', '--from-branch', 'main', '--title', 'Complete mobile login']);
  const workflowPath = path.join(root, 'singularity/work-items/MOB-200/workflow.json');
  const workflow = JSON.parse(await readFile(workflowPath, 'utf8'));
  for (const phaseId of workflow.phaseOrder) {
    const phase = workflow.phases[phaseId];
    phase.status = 'approved';
    const artifact = path.join(root, 'singularity/work-items/MOB-200', phase.requiredArtifact.path);
    await mkdir(path.dirname(artifact), { recursive: true });
    await writeFile(artifact, `# ${phase.label}\n\nApproved governed evidence for ${phaseId}.\n`);
  }
  workflow.currentPhase = null;
  workflow.status = 'complete';
  workflow.lineage.submissions = [{
    packetSha256: 'a'.repeat(64),
    phase: 'conformance',
    generation: 1,
    submittedAt: '2026-07-26T00:00:00.000Z'
  }];
  const contextPath = path.join(root, 'singularity/story-context/MOB-200/story-specification.md');
  await mkdir(path.dirname(contextPath), { recursive: true });
  await writeFile(contextPath, '# Story specification\n\nDeliver the approved login behavior.\n');
  const { createHash } = await import('node:crypto');
  const context = await readFile(contextPath);
  const contextSha256 = createHash('sha256').update(context).digest('hex');
  const seedPath = path.join(root, 'singularity/seeds/MOB-200.yml');
  await mkdir(path.dirname(seedPath), { recursive: true });
  await writeFile(seedPath, YAML.stringify({
    version: 1,
    initiative: { id: 'MOB-100' },
    story: { workId: 'MOB-200', jiraKey: 'MOB-200', planId: 'STORY-001' },
    governedContext: [{
      id: 'story-specification',
      path: 'singularity/story-context/MOB-200/story-specification.md',
      sha256: contextSha256,
      bytes: context.length
    }]
  }));
  await writeFile(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'Complete governed Story']);
  git(root, ['push']);

  const result = flow(root, ['finalize']);
  assert.match(result.stdout, /finalized for Product Owner review/);
  const finalized = JSON.parse(await readFile(workflowPath, 'utf8'));
  assert.equal(finalized.lineage.deliveryStatus, 'finalized_for_review');
  const record = finalized.lineage.finalizations.at(-1);
  assert.equal(record.reviewPacketSha256, 'a'.repeat(64));
  assert.match(record.packetSha256, /^[a-f0-9]{64}$/);
  const packet = JSON.parse(await readFile(path.join(root, record.path), 'utf8'));
  assert.equal(packet.governedContext[0].verifiedSha256, contextSha256);
  assert.equal(packet.finalizedAt, workflow.workItem.createdAt);
  assert.match(
    git(root, ['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'refs/heads/MOB-200']).stdout,
    new RegExp(record.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  );
});
