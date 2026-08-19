import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  appendJournalEvent, captureCommandOutcome, dailyReturnContext, deleteAllJournal, journalDoctor,
  journalToday, localWorkJournalRoot, observeRepository, previousJournalDate, readJournalEvents,
  readJournalSettings, updateJournalSettings
} from '../src/local-work-journal.mjs';
import { run } from '../src/util.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-journal-'));
  const root = path.join(base, 'repository');
  const env = { ...process.env, SINGULARITY_FLOW_LOCAL_JOURNAL: path.join(base, 'machine-state', 'journal') };
  await import('node:fs/promises').then(({ mkdir }) => mkdir(root, { recursive: true }));
  run('git', ['init', '-q'], { cwd: root });
  run('git', ['config', 'user.name', 'Journal Tester'], { cwd: root });
  run('git', ['config', 'user.email', 'journal@example.test'], { cwd: root });
  await writeFile(path.join(root, 'tracked.txt'), 'first\n');
  run('git', ['add', 'tracked.txt'], { cwd: root });
  run('git', ['commit', '-qm', 'initial'], { cwd: root });
  return { base, root, env };
}

test('journal events are bounded, integrity checked, deduplicated and local only', async (t) => {
  const { base, env } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const input = {
    workspaceId: 'workspace-one', repositoryId: 'payments', workId: 'WRK-19',
    kind: 'test-result', summaryCode: 'journal.test-result', at: '2026-08-19T08:00:00.000Z',
    facts: { outcome: 'passed', count: 7, token: 'must-not-be-stored', command: 'must-not-be-stored' }
  };
  const first = await appendJournalEvent(input, { env });
  const duplicate = await appendJournalEvent(input, { env });
  assert.equal(first.stored, true);
  assert.equal(duplicate.reason, 'duplicate');
  assert.equal(JSON.stringify(first), JSON.stringify(first).replaceAll('must-not-be-stored', ''),
    'unknown or secret-shaped facts never enter the event');
  assert.equal(first.event.privacy.remoteSync, 'never');
  assert.match(first.event.integrity.sha256, /^[a-f0-9]{64}$/);

  const read = await readJournalEvents('workspace-one', '2026-08-19', { env });
  assert.equal(read.events.length, 1);
  const file = path.join(localWorkJournalRoot(env), 'workspaces', read.workspaceKey, 'events', '2026-08-19.jsonl');
  await writeFile(file, `${(await readFile(file, 'utf8')).replace('"count":7', '"count":8')}`);
  const tampered = await readJournalEvents('workspace-one', '2026-08-19', { env });
  assert.equal(tampered.events.length, 0);
  assert.deepEqual(tampered.malformed, [1]);
});

test('repository refresh observes only local Git state and does not write Git objects', async (t) => {
  const { base, root, env } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  await writeFile(path.join(root, 'tracked.txt'), 'dirty bytes\n');
  await writeFile(path.join(root, 'staged.txt'), 'staged bytes\n');
  run('git', ['add', 'staged.txt'], { cwd: root });
  const before = run('git', ['count-objects', '-v'], { cwd: root }).stdout;
  const captured = await observeRepository(root, {
    workspaceId: 'workspace-one', repositoryId: 'payments', workId: 'WRK-19'
  }, { env });
  const after = run('git', ['count-objects', '-v'], { cwd: root }).stdout;
  assert.equal(captured.event.facts.dirty, true);
  assert.equal(captured.event.facts.stagedPaths, 1);
  assert.equal(captured.event.facts.remoteEvidence, 'not-confirmed');
  assert.equal(after, before, 'a private read does not populate the repository object database');

  const today = await journalToday('workspace-one', { env });
  assert.equal(today.privacy.localOnly, true);
  assert.equal(today.privacy.remoteSync, 'never');
  assert.ok(today.attention.some((entry) => /changed path/.test(entry.text)));
});

test('journal controls are deterministic and all-history deletion preserves settings', async (t) => {
  const { base, env } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const defaults = await readJournalSettings({ env });
  assert.equal(defaults.mode, 'workspace-facts');
  assert.equal(defaults.retentionDays, 30);
  const paused = await updateJournalSettings({ paused: true, retentionDays: 14, timeZone: 'Asia/Kolkata' }, { env });
  assert.equal(paused.paused, true);
  const skipped = await appendJournalEvent({
    workspaceId: 'workspace-one', repositoryId: 'payments', kind: 'checkpoint', summaryCode: 'journal.checkpoint'
  }, { env });
  assert.equal(skipped.reason, 'capture-disabled');
  const doctor = await journalDoctor({ env });
  assert.equal(doctor.resultType, 'local-work-journal-doctor');
  assert.equal('root' in doctor, false, 'diagnostics do not expose an unrestricted local path');
  await deleteAllJournal({ env });
  const retained = await readJournalSettings({ env });
  assert.equal(retained.retentionDays, 14);
});

test('refresh refuses a journal configured inside the repository', async (t) => {
  const { base, root, env } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  await assert.rejects(() => observeRepository(root, {
    workspaceId: 'workspace-one', repositoryId: 'payments'
  }, { env: { ...env, SINGULARITY_FLOW_LOCAL_JOURNAL: path.join(root, '.journal') } }),
  /outside the repository worktree/);
});

test('journal CLI is rootless and emits the versioned command-result contract', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-journal-cli-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = {
    ...process.env,
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'),
    SINGULARITY_FLOW_LOCAL_JOURNAL: path.join(base, 'journal')
  };
  const invoked = spawnSync(process.execPath, [cli, 'journal', 'doctor', '--json'], {
    cwd: base, env, encoding: 'utf8'
  });
  assert.equal(invoked.status, 0, invoked.stderr);
  const result = JSON.parse(invoked.stdout);
  assert.equal(result.resultType, 'command-result');
  assert.equal(result.operation.id, 'journal.doctor');
  assert.deepEqual(result.effects, {
    stateChanged: false, filesChanged: false, publicationCreated: false, externalSystemsChanged: false
  });
  assert.equal(result.data.healthy, true);
});

test('daily return context keeps a bounded previous calendar day across restart or host changes', async (t) => {
  const { base, env } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  await updateJournalSettings({ timeZone: 'Asia/Kolkata' }, { env });
  await appendJournalEvent({
    workspaceId: 'workspace-one', repositoryId: 'payments', workId: 'WRK-19',
    kind: 'checkpoint', summaryCode: 'journal.checkpoint', at: '2026-08-18T12:00:00.000Z',
    facts: { outcome: 'succeeded', phase: 'implementation' }
  }, { env });
  await appendJournalEvent({
    workspaceId: 'workspace-one', repositoryId: 'payments', workId: 'WRK-19',
    kind: 'work-resumed', summaryCode: 'journal.work-resumed', at: '2026-08-19T04:00:00.000Z',
    facts: { outcome: 'succeeded' }
  }, { env });

  const firstHost = await dailyReturnContext('workspace-one', {
    env, now: new Date('2026-08-19T05:00:00.000Z')
  });
  const secondHost = await dailyReturnContext('workspace-one', {
    env, now: new Date('2026-08-19T05:00:00.000Z')
  });
  assert.equal(firstHost.today.date, '2026-08-19');
  assert.equal(firstHost.yesterday.date, '2026-08-18');
  assert.equal(firstHost.yesterday.summaries[0].workId, 'WRK-19');
  assert.deepEqual(firstHost.today.summaries, secondHost.today.summaries,
    'a new host/model reads the same durable local return facts');
  assert.deepEqual(firstHost.yesterday.summaries, secondHost.yesterday.summaries);
  assert.equal(previousJournalDate('2024-03-01'), '2024-02-29');
  assert.throws(() => previousJournalDate('2026-02-30'), /real calendar date/);
});

test('successful governed command outcomes are captured only for the active repository', async (t) => {
  const { base, root, env: journalEnv } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = {
    ...journalEnv,
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active-workspace.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json')
  };
  await writeFile(env.SINGULARITY_FLOW_ACTIVE_WORKSPACE, `${JSON.stringify({
    schemaVersion: 1, workspaceId: 'workspace-one', workspaceName: 'Payments',
    repositoryId: 'payments', repositoryPath: root, storyId: 'WRK-19'
  })}\n`);

  const captured = await captureCommandOutcome({
    root, operationId: 'submit', positionals: ['submit', 'verification'], options: {},
    result: { subject: { id: 'WRK-19' }, outcome: { status: 'succeeded' } },
    startedAt: '2026-08-19T08:00:00.000Z', env
  });
  assert.equal(captured.stored, true);
  assert.equal(captured.event.kind, 'submitted');
  assert.equal(captured.event.facts.phase, 'verification');
  assert.match(captured.event.correlation, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(captured).includes('submit:2026'), false,
    'the operation correlation is one-way rather than stored as command content');

  const read = await readJournalEvents('workspace-one', '2026-08-19', { env });
  assert.equal(read.events.length, 1);
  assert.equal((await captureCommandOutcome({ root, operationId: 'status', env })).reason,
    'operation-not-captured');
  assert.equal((await captureCommandOutcome({
    root: path.join(base, 'different-repository'), operationId: 'submit', env
  })).reason, 'repository-not-active');
});
