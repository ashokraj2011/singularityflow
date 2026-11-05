import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { cloneStartOptions, storyCloneDraft } from '../src/story-clone.mjs';
import { readStoryClone } from '../src/story-clone.mjs';
import { createSessionListingFixture } from '../scripts/session-listing-benchmark.mjs';
import { appendLedgerIntent, createLedgerIntent } from '../src/ledger.mjs';
import { mkdir } from 'node:fs/promises';
import { resolveOperation } from '../src/command-registry.mjs';
import { copilotCommandForCommand } from '../src/copilot-guidance.mjs';

const commit = 'a'.repeat(40);
const original = { workItem: { id: 'SOURCE-1', title: 'Original', workType: 'custom-flow', branch: 'feature/source',
  baseBranch: 'main', repositoryBases: [{ repositoryId: 'api', baseBranch: 'main', baseCommit: commit },
    { repositoryId: 'web', baseBranch: 'develop', baseCommit: commit }] },
  phases: { testing: { approvals: [{ human: 'Original reviewer' }], generation: 9 } }, decisions: [{ accepted: true }] };

test('a clone is editable manual input, with no original lifecycle, tracker identity or approval authority', () => {
  const source = { type: 'jira', id: '100', key: 'SOURCE-1', url: 'https://issues.example.test/SOURCE-1',
    title: 'Invoice export', description: 'Export selected invoices.', acceptanceCriteria: ['Export CSV.', 'Reject unauthorized access.'],
    desiredOutcome: 'Faster reconciliation', user: 'Analyst', scope: { in: ['Current filters'], out: ['Scheduling'] },
    constraints: ['Keep authorization'], dependencies: ['Search API'], notes: 'Keep column order.', epicId: 'EPIC-1',
    attachments: [{ id: 'private', url: 'https://issues.example.test/private' }] };
  const before = structuredClone({ original, source });
  const draft = storyCloneDraft(original, source, { commit, documents: [{ name: 'Requirements', store: 'local' }] });
  assert.equal(draft.request.type, 'manual');
  for (const field of ['id', 'key', 'stableId', 'url', 'rawRef', 'fetchedAt', 'epicId']) assert.equal(draft.request[field], null);
  assert.equal(draft.request.desiredOutcome, source.desiredOutcome);
  assert.deepEqual(draft.request.scope, source.scope);
  assert.match(draft.request.acceptanceCriteria, /Reject unauthorized access/);
  assert.match(draft.request.notes, /Request copied from Story SOURCE-1/);
  assert.equal(draft.request.attachments, undefined);
  assert.equal(draft.phases, undefined);
  assert.equal(draft.decisions, undefined);
  assert.deepEqual(draft.documents, [{ name: 'Requirements', store: 'local' }]);
  assert.deepEqual({ original, source }, before);
});

test('multi-repository defaults copy branch choices, while new intake can override them', () => {
  const draft = storyCloneDraft(original, { title: 'Request' }, { commit });
  const defaults = cloneStartOptions(draft, {});
  assert.deepEqual(defaults['from-branch'], ['api=main', 'web=develop']);
  assert.equal(defaults['work-type'], 'custom-flow');
  const chosen = cloneStartOptions(draft, { 'from-branch': ['api=release', 'web=trunk'], 'work-type': 'another-flow' });
  assert.deepEqual(chosen['from-branch'], ['api=release', 'web=trunk']);
  assert.equal(chosen['work-type'], 'another-flow');
  assert.equal(cloneStartOptions(draft, { base: 'release' })['from-branch'], undefined);
});

test('copied specification selections and reference repositories are re-resolved, without their execution records', () => {
  const workflow = { ...original, resolution: { referenceRepositories: [{ id: 'api', repository: 'https://example.test/api.git',
    requestedBranch: 'trunk', commit, localPath: '/old-machine/api' }] } };
  const source = { title: 'Request', specification: [{ revision: 'SPEC-EXPORT@3', clauses: [
    { anchor: '[SPEC-EXPORT:REQ-001]', text: 'Export CSV.' }, { anchor: '[SPEC-EXPORT:AC-001]', text: 'Download a file.' }
  ], decisions: [{ accepted: true }] }] };
  const draft = storyCloneDraft(workflow, source, { commit });
  const options = cloneStartOptions(draft, {});
  assert.deepEqual(options.spec, ['SPEC-EXPORT@3=REQ-001,AC-001']);
  assert.deepEqual(options['reference-repository'], ['api=https://example.test/api.git']);
  assert.deepEqual(options['reference-branch'], ['api=trunk']);
  assert.equal(draft.request.specification, undefined, 'start must re-read and validate this library revision');
  assert.doesNotMatch(JSON.stringify(draft), /old-machine|"accepted":true/);
});

test('clone preview is read-only, creation is model-free mutation, and Copilot keeps both identifiers', () => {
  for (const preview of [false, true]) {
    const operation = resolveOperation({ requestedCommand: 'story', positionals: ['story', 'clone', 'OLD-1', 'NEW-2'],
      options: preview ? { preview: true } : {} });
    assert.equal(operation.classification, preview ? 'read' : 'mutation');
    assert.equal(operation.modelPolicy, 'never');
  }
  assert.equal(copilotCommandForCommand('singularity-flow story clone OLD-1 NEW-2'), '/sf-start NEW-2 --clone-from OLD-1');
});

test('remote-only clone follows its state pointer and fetches only the selected source branch', async t => {
  const f = await createSessionListingFixture(); t.after(f.cleanup);
  const id = 'REMOTE-CLONE', branch = 'team/custom-source';
  const state = { schemaVersion: 11, workItem: { id, title: 'Remote request', branch, workType: 'feature', baseBranch: 'main',
    createdAt: '2026-11-03T00:00:00Z', createdBy: { name: 'Fixture' } },
    lineage: { canonicalBranch: branch }, status: 'in_progress', currentPhase: 'intake', phaseOrder: ['intake'],
    phases: { intake: { id: 'intake', label: 'Intake', status: 'in_progress', generation: 0, artifacts: [], checks: [], approvals: [],
      approvalPolicy: { minimum: 1, authorities: ['quality-reviewers'] }, requiredArtifact: { path: 'intake.md' } } },
    resolution: { phases: [{ id: 'intake', label: 'Intake' }] }, history: [] };
  f.git(f.source, 'switch', '--quiet', '-c', branch, 'main');
  const directory = path.join(f.source, f.definition.workItemRoot, id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'workflow.json'), JSON.stringify(state));
  await writeFile(path.join(directory, 'source.json'), JSON.stringify({ type: 'manual', title: 'Remote request', description: 'Clone this input.' }));
  f.git(f.source, 'add', '.'); f.git(f.source, 'commit', '--quiet', '-m', 'Retain remote Story');
  f.git(f.source, 'push', '--quiet', 'origin', branch);
  const revision = f.git(f.source, 'rev-parse', 'HEAD');
  await appendLedgerIntent(f.source, { ...f.definition.ledger, pinTransport: 'none' }, createLedgerIntent({
    eventType: 'binding', capabilityId: 'fixture', actor: { name: 'Fixture', email: 'fixture@example.test' },
    subject: { kind: 'story', workId: id, branch }
  }), revision);
  f.git(f.original, 'fetch', '--quiet', 'origin', 'refs/heads/state:refs/remotes/origin/state');
  const unrelated = f.git(f.remote, 'rev-parse', 'refs/heads/main');
  for (let n = 0; n < 20; n++) f.git(f.remote, 'update-ref', `refs/heads/unrelated-${n}`, unrelated);
  const before = f.git(f.original, 'rev-parse', 'HEAD');
  const draft = await readStoryClone(f.original, id);
  assert.equal(draft.source.commit, revision);
  assert.equal(draft.source.branch, branch);
  assert.equal(draft.request.description, 'Clone this input.');
  assert.equal(f.git(f.original, 'rev-parse', 'HEAD'), before);
  const tracked = f.git(f.original, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin');
  assert.doesNotMatch(tracked, /unrelated-/);
});

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin/singularity-flow.mjs');
function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 180000,
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Clone fixture',
      SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }) } });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
const flow = (root, args, options) => run(process.execPath, [bin, ...args], root, options);

test('CLI clones through a fresh isolated start and preserves the original Story byte for byte', { timeout: 180000 }, async t => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-clone-test-'));
  t.after(() => rm(sandbox, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
  const root = path.join(sandbox, 'repo');
  run('git', ['init', '-b', 'main', root], sandbox);
  run('git', ['config', 'user.name', 'Clone Fixture'], root);
  run('git', ['config', 'user.email', 'clone@example.test'], root);
  await writeFile(path.join(root, 'README.md'), '# Clone fixture\n');
  flow(root, ['init']);
  const configFile = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configFile, 'utf8'));
  config.git.publish = 'off'; config.repositoryReadiness.requiredBeforeStory = false;
  await writeFile(configFile, YAML.stringify(config));
  run('git', ['add', '.'], root); run('git', ['commit', '-m', 'Initialize fixture'], root);
  const remote = path.join(sandbox, 'remote.git');
  run('git', ['init', '--bare', '--initial-branch=main', remote], sandbox);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  const request = { title: 'Export invoices', description: 'Export filtered invoices.', user: 'Analyst',
    desiredOutcome: 'Faster reconciliation', scope: { in: ['Current filters'], out: ['Scheduling'] },
    constraints: ['Keep authorization'], acceptanceCriteria: ['Export CSV.', 'Reject unauthorized access.'] };
  const requestFile = path.join(sandbox, 'request.json');
  await writeFile(requestFile, JSON.stringify(request));
  flow(root, ['start', 'ORIGINAL-1', '--story-file', requestFile, '--from-branch', 'main', '--work-type', 'feature']);
  const beforeHead = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const originalPath = path.join(root, 'singularity/work-items/ORIGINAL-1');
  const beforeWorkflow = await readFile(path.join(originalPath, 'workflow.json'));
  const beforeSource = await readFile(path.join(originalPath, 'source.json'));
  const preview = JSON.parse(flow(root, ['story', 'clone', 'ORIGINAL-1', '--preview', '--json']).stdout);
  assert.equal(preview.source.commit, beforeHead);
  assert.equal(preview.request.desiredOutcome, request.desiredOutcome);
  const same = flow(root, ['story', 'clone', 'ORIGINAL-1', 'ORIGINAL-1', '--json'], { allowFailure: true });
  assert.notEqual(same.status, 0); assert.match(same.stdout + same.stderr, /different Story ID/);
  const result = JSON.parse(flow(root, ['story', 'clone', 'ORIGINAL-1', 'COPY-2', '--title', 'Reconciliation export', '--json']).stdout);
  const created = result.data ?? result;
  assert.equal(created.workItem.id, 'COPY-2');
  assert.equal(created.workItem.title, 'Reconciliation export');
  assert.ok(created.repositoryPath && created.repositoryPath !== root);
  const copied = JSON.parse(await readFile(path.join(created.repositoryPath, 'singularity/work-items/COPY-2/workflow.json')));
  const source = JSON.parse(await readFile(path.join(created.repositoryPath, 'singularity/work-items/COPY-2/source.json')));
  assert.equal(copied.currentPhase, copied.phaseOrder[0]);
  assert.ok(Object.values(copied.phases).every(phase => phase.generation === 0 && phase.approvals.length === 0));
  assert.equal(source.desiredOutcome, request.desiredOutcome);
  assert.deepEqual(source.scope, request.scope);
  assert.match(source.acceptanceCriteria, /Reject unauthorized access/);
  assert.equal(run('git', ['rev-parse', 'HEAD'], root).stdout.trim(), beforeHead);
  assert.deepEqual(await readFile(path.join(originalPath, 'workflow.json')), beforeWorkflow);
  assert.deepEqual(await readFile(path.join(originalPath, 'source.json')), beforeSource);
  const changed = flow(root, ['start', 'COPY-3', '--clone-from', 'ORIGINAL-1', '--clone-source-commit', 'b'.repeat(40), '--json'], { allowFailure: true });
  assert.notEqual(changed.status, 0); assert.match(changed.stdout + changed.stderr, /STORY_CLONE_SOURCE_UNAVAILABLE/);
  assert.equal(run('git', ['branch', '--list', 'COPY-3'], root).stdout.trim(), '');
  await writeFile(path.join(root, 'phase-note.md'), 'The original phase continued after clone preview.\n');
  run('git', ['add', 'phase-note.md'], root); run('git', ['commit', '-m', 'Continue original phase'], root);
  const pinned = await readStoryClone(root, 'ORIGINAL-1', { expectedCommit: beforeHead });
  assert.equal(pinned.source.commit, beforeHead, 'phase progress cannot invalidate a committed request snapshot');
  assert.equal(pinned.request.desiredOutcome, request.desiredOutcome);
});

// A new workspace is a partial clone: fetching the Story's branch brings commits and trees, not files.
// "Could not read the Story to clone" appeared right after mapping, 2026-11-05.
test('a new workspace can clone a Story it has never downloaded, fetching only that Story\'s records', { timeout: 180000 }, async t => {
  const f = await createSessionListingFixture(); t.after(f.cleanup);
  const id = 'REMOTE-CLONE', branch = 'team/custom-source';
  const state = { schemaVersion: 11, workItem: { id, title: 'Remote request', branch, workType: 'feature', baseBranch: 'main',
    createdAt: '2026-11-03T00:00:00Z', createdBy: { name: 'Fixture' } },
    lineage: { canonicalBranch: branch }, status: 'in_progress', currentPhase: 'intake', phaseOrder: ['intake'],
    phases: { intake: { id: 'intake', label: 'Intake', status: 'in_progress', generation: 0, artifacts: [], checks: [], approvals: [],
      approvalPolicy: { minimum: 1, authorities: ['quality-reviewers'] }, requiredArtifact: { path: 'intake.md' } } },
    resolution: { phases: [{ id: 'intake', label: 'Intake' }] }, history: [] };
  f.git(f.source, 'switch', '--quiet', '-c', branch, 'main');
  const directory = path.join(f.source, f.definition.workItemRoot, id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'workflow.json'), JSON.stringify(state));
  await writeFile(path.join(directory, 'source.json'), JSON.stringify({ type: 'manual', title: 'Remote request', description: 'Clone this input.' }));
  await writeFile(path.join(f.source, 'application-only.txt'), 'Nothing about cloning needs this file.\n');
  // A changed definition makes its blob missing too: the first thing the index reads.
  await writeFile(path.join(f.source, 'singularity/workflow.yml'), YAML.stringify({ ...f.definition, description: 'Changed on the Story branch.' }));
  f.git(f.source, 'add', '.'); f.git(f.source, 'commit', '--quiet', '-m', 'Retain remote Story');
  f.git(f.source, 'push', '--quiet', 'origin', branch);
  const revision = f.git(f.source, 'rev-parse', 'HEAD');
  await appendLedgerIntent(f.source, { ...f.definition.ledger, pinTransport: 'none' }, createLedgerIntent({
    eventType: 'binding', capabilityId: 'fixture', actor: { name: 'Fixture', email: 'fixture@example.test' },
    subject: { kind: 'story', workId: id, branch }
  }), revision);
  f.git(f.remote, 'config', 'uploadpack.allowFilter', 'true');
  f.git(f.remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-clone-partial-'));
  t.after(() => rm(sandbox, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
  const clone = path.join(sandbox, 'workspace-clone');
  run('git', ['clone', '--quiet', '--filter=blob:none', '--branch', 'main', `file://${f.remote}`, clone], sandbox);
  run('git', ['config', 'user.name', 'Clone Fixture'], clone);
  run('git', ['config', 'user.email', 'clone@example.test'], clone);
  run('git', ['fetch', '--quiet', 'origin', 'refs/heads/state:refs/remotes/origin/state'], clone);
  run('git', ['archive', 'refs/remotes/origin/state', '-o', path.join(sandbox, 'state.tar')], clone);
  const missing = () => run('git', ['-c', 'fetch.negotiationAlgorithm=noop', 'rev-list', '--objects', '--missing=print', `origin/${branch}`], clone).stdout
    .split('\n').filter(line => line.startsWith('?')).map(line => line.slice(1));
  const blob = (file) => run('git', ['rev-parse', `origin/${branch}:${file}`], clone).stdout.trim();
  const record = `${f.definition.workItemRoot}/${id}`;
  for (const file of ['singularity/workflow.yml', `${record}/workflow.json`, `${record}/source.json`, 'application-only.txt']) {
    assert.ok(missing().includes(blob(file)), `${file} is not here yet`);
  }

  const draft = await readStoryClone(clone, id);
  assert.equal(draft.source.commit, revision);
  assert.equal(draft.request.description, 'Clone this input.');
  const after = missing();
  for (const file of ['singularity/workflow.yml', `${record}/workflow.json`, `${record}/source.json`]) assert.ok(!after.includes(blob(file)), `${file} came down`);
  assert.ok(after.includes(blob('application-only.txt')), 'nothing else is downloaded');

  const preview = JSON.parse(flow(clone, ['story', 'clone', id, '--preview', '--json']).stdout);
  assert.equal(preview.source.commit, revision);
});
