import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveGovernedWork } from '../src/commands/goal.mjs';
import { appendLedgerIntent, createLedgerIntent } from '../src/ledger.mjs';
import {
  IDENTITY_SOURCE, definitionLedgerConfig, initiativeIdentityRecords, resolveInitiativeReference
} from '../src/subject-identity-records.mjs';
import { readWorkspace, rememberWorkspace } from '../src/workspace.mjs';
import { run } from '../src/util.mjs';

const LEDGER_ON = Object.freeze({ enabled: true });

function initiativeState(id, branch) {
  return {
    schemaVersion: 1,
    initiative: { id, title: `${id} title`, branch, profile: 'portfolio' },
    status: 'in_progress',
    currentPhase: 'discovery',
    phaseOrder: ['discovery'],
    phases: { discovery: { id: 'discovery', status: 'in_progress' } },
    lineage: { branches: [] }
  };
}

async function repository({ ledger }) {
  // A workspace-shaped layout, so the Goal oracle can resolve the repository it holds.
  const root = path.join(await mkdtemp(path.join(os.tmpdir(), 'sflow-identity-records-')), 'repos', 'app');
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Identity Records'], { cwd: root });
  run('git', ['config', 'user.email', 'identity@example.invalid'], { cwd: root });
  await writeFile(path.join(root, 'singularity/workflow.yml'),
    `version: 2\nworkItemRoot: singularity/work-items\nledger:\n  enabled: ${ledger}\n`);
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-qm', 'configuration'], { cwd: root });
  return root;
}

/** Commit an Initiative's state on its own branch, as `initiative start` leaves it. */
async function initiativeOnBranch(root, id, branch) {
  run('git', ['switch', '-qc', branch, 'main'], { cwd: root });
  const directory = path.join(root, 'singularity/initiatives', id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'state.json'), `${JSON.stringify(initiativeState(id, branch))}\n`);
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-qm', `start ${id}`], { cwd: root });
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
  run('git', ['switch', '-q', 'main'], { cwd: root });
  return commit;
}

/** The ledger entry an Initiative lifecycle publication appends (initiative-state.mjs). */
async function recordInitiative(root, id, branch, commit) {
  await appendLedgerIntent(root, LEDGER_ON, createLedgerIntent({
    eventType: 'binding', capabilityId: `initiative-${id}`,
    subject: { workId: id, profile: 'portfolio', phase: 'discovery', generation: null, branch },
    actor: { name: 'Identity Records', email: 'identity@example.invalid' },
    payload: { lifecycleEvent: { type: 'binding', subject: { kind: 'initiative', id, branch } } }
  }), commit);
}

async function goalContext(t, root) {
  const workspacePath = path.resolve(root, '..', '..');
  const now = new Date().toISOString();
  await writeFile(path.join(workspacePath, 'workspace.json'), JSON.stringify({
    version: 1, id: 'identity-records', name: 'Identity Records', createdAt: now, updatedAt: now,
    anchor: { provider: 'workspace', key: 'identity-records', title: 'Identity Records', fetchedAt: now },
    leadRepository: 'app', capabilities: [],
    repositories: { app: { url: `${root}.git`, path: 'repos/app', defaultBranch: 'main', capabilities: [] } }
  }));
  const previous = process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
  process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = path.join(workspacePath, 'workspaces.json');
  t.after(() => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
    else process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = previous;
  });
  const workspace = await readWorkspace(workspacePath);
  await rememberWorkspace(process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY, workspace);
  return { workspace, selected: { repositoryId: 'app' } };
}

test('identity records come from the ledger chain, newest binding per ID, never from branches', async () => {
  const root = await repository({ ledger: true });
  assert.deepEqual(await definitionLedgerConfig(root), LEDGER_ON);
  assert.deepEqual((await initiativeIdentityRecords(root, LEDGER_ON)).records, [],
    'no state ledger yet means no recorded identity');
  const first = await initiativeOnBranch(root, 'EPIC-1', 'epic/one');
  await recordInitiative(root, 'EPIC-1', 'epic/one', first);
  // An application branch that looks like an Initiative is not an identity.
  await initiativeOnBranch(root, 'EPIC-2', 'EPIC-2');
  const identities = await initiativeIdentityRecords(root, LEDGER_ON);
  assert.equal(identities.source, IDENTITY_SOURCE.LEDGER);
  assert.match(identities.snapshot, /^[0-9a-f]{40,64}$/u);
  assert.deepEqual(identities.records.map((record) => [record.id, record.branch, record.aliases]),
    [['EPIC-1', 'epic/one', ['epic/one']]]);
  assert.equal(identities.records[0].event.publishedCommit, first);
  const off = await initiativeIdentityRecords(root, { enabled: false });
  assert.equal(off.source, IDENTITY_SOURCE.LEDGER_OFF);
  assert.equal(off.records, null);
});

test('a Goal resolves an Initiative at its recorded branch and never adopts an unrecorded one', async (t) => {
  const root = await repository({ ledger: true });
  await recordInitiative(root, 'EPIC-1', 'epic/one', await initiativeOnBranch(root, 'EPIC-1', 'epic/one'));
  await initiativeOnBranch(root, 'EPIC-2', 'EPIC-2');
  const context = await goalContext(t, root);
  const recorded = await resolveGovernedWork(context, {
    reference: 'EPIC-1', kind: 'initiative', repositoryId: 'app', required: false
  });
  assert.equal(recorded.availability, 'available');
  assert.equal(recorded.branch, 'epic/one');
  assert.equal(recorded.title, 'EPIC-1 title');
  const unrecorded = await resolveGovernedWork(context, {
    reference: 'EPIC-2', kind: 'initiative', repositoryId: 'app', required: false
  });
  assert.equal(unrecorded.availability, 'missing');
});

test('with the ledger off a Goal still finds an Initiative on its branch', async (t) => {
  const root = await repository({ ledger: false });
  await initiativeOnBranch(root, 'EPIC-2', 'EPIC-2');
  const context = await goalContext(t, root);
  const found = await resolveGovernedWork(context, {
    reference: 'EPIC-2', kind: 'initiative', repositoryId: 'app', required: false
  });
  assert.equal(found.availability, 'available');
  assert.equal(found.branch, 'EPIC-2');
});

test('an unrecorded reference resolves only to the Initiative this checkout itself holds', async () => {
  const root = await repository({ ledger: true });
  await initiativeOnBranch(root, 'EPIC-3', 'EPIC-3');
  const identities = await initiativeIdentityRecords(root, LEDGER_ON);
  await assert.rejects(() => resolveInitiativeReference(root, identities, 'EPIC-3', { currentBranch: 'main' }),
    { code: 'INITIATIVE_IDENTITY_UNRECORDED' });
  run('git', ['switch', '-q', 'EPIC-3'], { cwd: root });
  const own = await resolveInitiativeReference(root, identities, 'EPIC-3', { currentBranch: 'EPIC-3' });
  assert.deepEqual([own.id, own.branch, own.recorded], ['EPIC-3', 'EPIC-3', false]);
  await assert.rejects(() => resolveInitiativeReference(root, identities, 'EPIC-4', { currentBranch: 'EPIC-3' }),
    { code: 'INITIATIVE_IDENTITY_UNRECORDED' });
});
