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

/** Rewrite (or, with null, delete) the state ledger entry `pick` selects, as one new commit on the state ref. */
async function damageLedgerEntry(root, pick, rewrite) {
  const names = run('git', ['ls-tree', '-r', '--name-only', 'state', '--', 'ledger/entries'], { cwd: root }).stdout.split('\n').filter(Boolean);
  const file = names.find((name) => pick(JSON.parse(run('git', ['show', `state:${name}`], { cwd: root }).stdout)));
  assert.ok(file, 'the entry to damage exists');
  const worktree = await mkdtemp(path.join(os.tmpdir(), 'sflow-ledger-damage-'));
  run('git', ['worktree', 'add', '-q', '--force', worktree, 'state'], { cwd: root });
  const bytes = rewrite ? rewrite(run('git', ['show', `state:${file}`], { cwd: root }).stdout) : null;
  if (bytes === null) run('git', ['rm', '-q', file], { cwd: worktree });
  else { await writeFile(path.join(worktree, file), bytes); run('git', ['add', file], { cwd: worktree }); }
  run('git', ['commit', '-qm', 'damage one ledger entry'], { cwd: worktree });
  run('git', ['worktree', 'remove', '--force', worktree], { cwd: root });
}

// One bad entry anywhere in the state ledger blocked every Initiative list, resume, goal and local
// Epic ID, with no route (sweep B3).
test('a damaged ledger entry ends the records there: a list serves what it read, and a lookup or allocation it cannot answer names ledger verify', async (t) => {
  const { initiativeIdsTaken, resolveInitiativeIdentity } = await import('../src/subject-identity-records.mjs');
  const { listInitiatives } = await import('../src/initiative-state.mjs');
  const { refusalRemediationPlan } = await import('../src/refusal-remediation.mjs');
  const root = await repository({ ledger: true });
  await recordInitiative(root, 'EPIC-1', 'epic/one', await initiativeOnBranch(root, 'EPIC-1', 'epic/one'));
  await recordInitiative(root, 'EPIC-2', 'epic/two', await initiativeOnBranch(root, 'EPIC-2', 'epic/two'));
  const older = (entry) => entry.subject?.workId === 'EPIC-1';
  await damageLedgerEntry(root, older, (text) => text.replace('"Identity Records"', '"Somebody Else"'));

  const identities = await initiativeIdentityRecords(root, LEDGER_ON);
  assert.deepEqual(identities.records.map((record) => record.id), ['EPIC-2'], 'what the chain held before the damage');
  assert.equal(identities.unreadable.nextAction, 'singularity-flow ledger verify');
  assert.match(identities.unreadable.message, /could not be read: .*corrupt entry/u);
  assert.equal(resolveInitiativeIdentity(identities, 'EPIC-2').branch, 'epic/two');
  assert.throws(() => resolveInitiativeIdentity(identities, 'EPIC-1'),
    (error) => error.code === 'LEDGER_CHAIN_INVALID' && error.details.nextAction === 'singularity-flow ledger verify');
  // The damaged entry still parses: its ID stays taken, so allocation can prove a new one unused.
  assert.deepEqual(initiativeIdsTaken(root, identities).sort(), ['EPIC-1', 'EPIC-2']);

  // A Goal finds the Initiative it can read, and one past the damage is unavailable, not missing.
  const context = await goalContext(t, root);
  assert.equal((await resolveGovernedWork(context, { reference: 'EPIC-2', kind: 'initiative', repositoryId: 'app', required: false })).availability, 'available');
  const past = await resolveGovernedWork(context, { reference: 'EPIC-1', kind: 'initiative', repositoryId: 'app', required: false });
  assert.equal(past.availability, 'unavailable');
  assert.equal(past.diagnostics[0].nextAction, 'singularity-flow ledger verify');

  // The list serves the Initiative it can read and says what it could not.
  const unreadable = [];
  const listed = await listInitiatives(root, { initiativeRoot: 'singularity/initiatives', git: { remote: 'origin' } },
    { ledger: LEDGER_ON, unreadable });
  assert.deepEqual(listed.map((entry) => entry.id), ['EPIC-2']);
  assert.equal(unreadable.length, 1);

  // A missing entry: nothing proves a new ID unused, so allocation refuses and names the read.
  await damageLedgerEntry(root, older, null);
  const missing = await initiativeIdentityRecords(root, LEDGER_ON);
  assert.match(missing.unreadable.message, /missing entry/u);
  let refusal = null;
  try { initiativeIdsTaken(root, missing); } catch (error) { refusal = error; }
  assert.equal(refusal?.code, 'LEDGER_CHAIN_INVALID');
  assert.equal(refusal.details.nextAction, 'singularity-flow ledger verify');
  const plan = refusalRemediationPlan(refusal, ['initiative', 'start', 'Something new']);
  assert.equal(plan.steps[0].command, 'singularity-flow ledger verify');
  assert.ok(plan.steps.every((entry) => !entry.commandRejected), JSON.stringify(plan.steps));
});
