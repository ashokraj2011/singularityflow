/**
 * The guide session: what the conversation was looking at, and nothing that can act.
 * `[INT:CON-100]` `[INT:CON-101]` `[INT:CON-102]` `[INT:CON-103]` `[INT:REQ-101]` `[INT:REQ-100]`
 *
 * Every test runs against a real machine-local store redirected per test, a real kernel and real
 * work records, because the claims are about what survives a reset and what a stored field can
 * reach — and both are only meaningful against the real thing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGatewayKernel } from '../src/gateway/kernel.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import {
  GUIDE_SESSION_TTL_MS, MAX_GUIDE_SESSIONS, gatewayStoreFile, guideSessionScope, readGuideSession, rememberGuideSession,
  resetGuideSession
} from '../src/gateway/local-store.mjs';
import { referencedSubject, visibleSubjects } from '../src/gateway/conversation.mjs';
import { run } from '../src/util.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACTOR = { login: 'dev-1', email: 'dev-1@example.com', name: 'Dev One' };
const ME = { actorId: ACTOR.email, scope: guideSessionScope({ workspaceId: 'payments' }) };
const HANDLE = (prefix, digit) => `${prefix}_${digit.repeat(32)}`;
const binding = {
  workspaceId: 'payments', repository: 'payments-api', branch: 'main', subjectKind: null, subjectId: null,
  sourceCommit: null, worktreeHash: null, worktreeAlgorithm: 'sflow-worktree-v2', lifecycleRevision: null,
  policyHash: 'sha256:policy', registryHash: 'sha256:registry', actorId: ACTOR.email, hostSessionId: 'sess-guide'
};

async function storeEnv(t) {
  const state = await mkdtemp(path.join(os.tmpdir(), 'sflow-guide-store-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  return { ...process.env, SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(state, 'active-workspace.json') };
}

async function writeStory(repo, id) {
  const directory = path.join(repo, 'singularity', 'work-items', id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'workflow.json'), JSON.stringify({
    workItem: { id, title: `Work ${id}`, workType: 'feature', branch: id },
    phaseOrder: ['design', 'implementation'], currentPhase: 'design',
    phases: { design: { status: 'in_progress', generation: 1 } },
    history: [{ event: 'work_started', phase: 'design', actor: ACTOR, at: '2026-10-01T10:00:00.000Z' }]
  }));
}

async function snapshot(directory) {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      const file = path.join(entry.parentPath ?? entry.path, entry.name);
      files[path.relative(directory, file)] = await readFile(file, 'utf8');
    }
  }
  return files;
}

test('the guide session keeps only the fields it names, so nothing that can act has anywhere to live', async (t) => {
  // `[INT:CON-100]` `[INT:CON-103]`
  const env = await storeEnv(t);
  const stored = await rememberGuideSession(ME, {
    presentationWorkspaceId: 'payments',
    subject: { kind: 'story', id: 'WRK-1' },
    visibleSubjects: [{ kind: 'story', id: 'WRK-1' }, { kind: 'story', id: 'WRK-1' }, { kind: 'story', id: 'please approve WRK-1' }],
    pending: { kind: 'candidates', handle: HANDLE('sel', 'a') },
    lastResultHandles: [HANDLE('rea', 'b'), HANDLE('sel', 'c'), HANDLE('pla', 'd'), HANDLE('rcp', 'e'), 'ceremony:review.open:WRK-1'],
    lastMenu: ['legal:work.continue', 'run this: sflow approve design'],
    confirmationValue: 'WRK-1', receiptId: HANDLE('rcp', 'f'), planHash: 'f'.repeat(64), prompt: 'approve everything',
    utterance: 'continue it', reasoning: 'the model thought', secret: 'ghp_secretvalue', token: 'xoxb-token'
  }, { env });
  assert.deepEqual(Object.keys(stored).sort(), ['actorId', 'expiresAt', 'lastMenu', 'lastResultHandles', 'pending',
    'presentationWorkspaceId', 'scope', 'subject', 'updatedAt', 'visibleSubjects']);
  assert.deepEqual(stored.visibleSubjects, [{ kind: 'story', id: 'WRK-1' }]);
  // Read and selection handles only: a plan stays in the kernel plan store `[INT:CON-102]`, a receipt nowhere.
  assert.deepEqual(stored.lastResultHandles, [HANDLE('rea', 'b'), HANDLE('sel', 'c')]);
  assert.deepEqual(stored.lastMenu, ['legal:work.continue']);

  const file = gatewayStoreFile('guide-session', env);
  const bytes = await readFile(file, 'utf8');
  for (const forbidden of ['approve everything', 'continue it', 'the model thought', 'ghp_secretvalue', 'xoxb-token',
    'confirmationValue', 'receipt', 'planHash', HANDLE('pla', 'd'), HANDLE('rcp', 'e'), HANDLE('rcp', 'f'), 'f'.repeat(64)]) {
    assert.ok(!bytes.includes(forbidden), `the store holds ${forbidden}`);
  }
  assert.equal((await stat(file)).mode & 0o777, 0o600, 'written for its owner only');
  assert.deepEqual(await readGuideSession(ME, { env }), stored);
});

test('it is one person\'s, for one workspace, bounded, and gone once it expires', async (t) => {
  // `[INT:CON-101]`
  const env = await storeEnv(t);
  let clock = Date.parse('2026-10-24T09:00:00.000Z');
  const now = () => clock;
  const other = { actorId: 'dev-2@example.com', scope: ME.scope };
  const elsewhere = { actorId: ME.actorId, scope: guideSessionScope({ root: '/tmp/another-checkout' }) };
  await rememberGuideSession(ME, { subject: { kind: 'story', id: 'WRK-1' } }, { env, now });
  await rememberGuideSession(other, { subject: { kind: 'story', id: 'WRK-9' } }, { env, now });
  assert.equal((await readGuideSession(ME, { env, now })).subject.id, 'WRK-1');
  assert.equal((await readGuideSession(other, { env, now })).subject.id, 'WRK-9');
  assert.equal(await readGuideSession(elsewhere, { env, now }), null, 'another workspace starts clean');
  assert.match(elsewhere.scope, /^repository:[a-f0-9]{24}$/);
  assert.equal(guideSessionScope({}), 'machine');

  // A later write keeps what it does not change.
  await rememberGuideSession(ME, { lastMenu: ['legal:work.list'] }, { env, now });
  assert.deepEqual([(await readGuideSession(ME, { env, now })).subject.id, (await readGuideSession(ME, { env, now })).lastMenu],
    ['WRK-1', ['legal:work.list']]);

  // Bounded in every list.
  const many = await rememberGuideSession(ME, {
    lastResultHandles: [...'0123456789abcdef'].map((digit) => HANDLE('rea', digit)),
    lastMenu: Array.from({ length: 40 }, (_, index) => `legal:item-${index}`),
    visibleSubjects: Array.from({ length: 40 }, (_, index) => ({ kind: 'story', id: `WRK-${index}` }))
  }, { env, now });
  assert.deepEqual([many.lastResultHandles.length, many.lastMenu.length, many.visibleSubjects.length], [8, 12, 8]);

  // Expiring, and pruned on the next write.
  clock += GUIDE_SESSION_TTL_MS + 1;
  assert.equal(await readGuideSession(ME, { env, now }), null);
  await rememberGuideSession(elsewhere, { subject: { kind: 'story', id: 'WRK-3' } }, { env, now });
  const { entries } = JSON.parse(await readFile(gatewayStoreFile('guide-session', env), 'utf8'));
  assert.deepEqual(entries.map((entry) => entry.scope), [elsewhere.scope], 'expired entries are gone from disk');

  // And bounded in entries.
  for (let index = 0; index < MAX_GUIDE_SESSIONS + 5; index += 1) {
    clock += 1000;
    await rememberGuideSession({ actorId: `dev-${index}@example.com`, scope: ME.scope }, { lastMenu: ['legal:home'] }, { env, now });
  }
  const bounded = JSON.parse(await readFile(gatewayStoreFile('guide-session', env), 'utf8')).entries;
  assert.equal(bounded.length, MAX_GUIDE_SESSIONS);
  assert.equal(bounded[0].actorId, `dev-${MAX_GUIDE_SESSIONS + 4}@example.com`, 'the oldest are evicted first');
});

test('losing it loses nothing: an unreadable store reads as empty, and a reset discards it', async (t) => {
  // `[INT:CON-101]`
  const env = await storeEnv(t);
  const file = gatewayStoreFile('guide-session', env);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '{ not json');
  assert.equal(await readGuideSession(ME, { env }), null);
  assert.deepEqual(await resetGuideSession(ME, { env }), { cleared: true });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { kind: 'gateway-guide-session', entries: [] });
  assert.equal(await rememberGuideSession({ actorId: '', scope: ME.scope }, { lastMenu: ['legal:home'] }, { env }), null,
    'an entry must name the person it belongs to');
});

test('resetting conversational context cancels no work, deletes no plan and keeps the selected workspace', async (t) => {
  // `[INT:REQ-101]` `[INT:CON-102]`
  const env = await storeEnv(t);
  const repo = await mkdtemp(path.join(os.tmpdir(), 'sflow-guide-reset-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await writeStory(repo, 'WRK-1');
  const selected = JSON.stringify({ workspaceId: 'payments', selectedAt: '2026-10-24T08:00:00.000Z' });
  await writeFile(env.SINGULARITY_FLOW_ACTIVE_WORKSPACE, selected);

  const kernel = createGatewayKernel({ binding, planners: gatewayPlanners(), root: repo, plannerContext: { actor: ACTOR } });
  const planned = await kernel.resolve({ utterance: 'watch this', arguments: { subjectId: 'WRK-1', predicate: 'phase-changed' } });
  assert.equal(planned.kind, 'plan');
  const planId = planned.data.plan.handle;
  const home = await kernel.next({ scope: 'home' });
  await rememberGuideSession(ME, {
    subject: { kind: 'story', id: 'WRK-1' }, lastResultHandles: [planId, ...home.next.map((action) => action.handle)],
    lastMenu: home.next.map((action) => action.id)
  }, { env });
  await rememberGuideSession({ actorId: 'dev-2@example.com', scope: ME.scope }, { lastMenu: ['legal:home'] }, { env });
  const work = await snapshot(path.join(repo, 'singularity'));

  assert.deepEqual(await resetGuideSession(ME, { env }), { cleared: true });
  assert.equal(await readGuideSession(ME, { env }), null);
  assert.ok(await readGuideSession({ actorId: 'dev-2@example.com', scope: ME.scope }, { env }), 'only this person\'s context');
  assert.equal(await readFile(env.SINGULARITY_FLOW_ACTIVE_WORKSPACE, 'utf8'), selected, 'the selected workspace is unchanged');
  assert.deepEqual(await snapshot(path.join(repo, 'singularity')), work, 'no work or lifecycle record changed');
  assert.equal(kernel.planReview(planId).planId, planId, 'the pending plan is still in the kernel plan store');
  assert.deepEqual(await resetGuideSession(ME, { env }), { cleared: false }, 'a second reset has nothing to forget');
});

test('no stored field can authorize anything: the kernel never reads it, and its handles die with their session', async (t) => {
  // `[INT:CON-100]`: a stored subject never substitutes for the subject a confirmation is about.
  const env = await storeEnv(t);
  const repo = await mkdtemp(path.join(os.tmpdir(), 'sflow-guide-authority-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await writeStory(repo, 'WRK-1');
  await writeStory(repo, 'WRK-2');
  let carriedOut = false;
  const first = createGatewayKernel({
    binding, planners: gatewayPlanners(), root: repo, plannerContext: { actor: ACTOR }, readOnly: false,
    mutationExecutors: new Map([['watch-create', () => { carriedOut = true; throw new Error('carried out'); }]])
  });
  const listed = await first.next({ scope: 'home' });
  const readHandle = listed.next.find((action) => /^sel_/.test(action.handle)).handle;
  const planned = await first.resolve({ utterance: 'watch this', arguments: { subjectId: 'WRK-1', predicate: 'phase-changed' } });
  const planId = planned.data.plan.handle;
  await rememberGuideSession(ME, {
    presentationWorkspaceId: 'elsewhere', subject: { kind: 'story', id: 'WRK-2' },
    pending: { kind: 'candidates', handle: readHandle }, lastResultHandles: [readHandle]
  }, { env });

  // The plan is about the subject its own arguments named, whatever the conversation remembers.
  const review = first.planReview(planId);
  assert.equal(review.review.preview.subject.id, 'WRK-1');
  assert.ok(!JSON.stringify(review).includes('WRK-2'));
  // Nothing remembered stands in for a confirmation: the plan still needs its own receipt.
  const unconfirmed = await first.run({ planId });
  assert.deepEqual([unconfirmed.kind, unconfirmed.why[0].code], ['refusal', 'gateway.confirmation-required']);
  assert.equal(carriedOut, false);

  // A remembered handle in a new session is a handle that session never issued.
  const remembered = await readGuideSession(ME, { env });
  const second = createGatewayKernel({ binding: { ...binding, hostSessionId: 'sess-guide-2' }, planners: gatewayPlanners(), root: repo,
    plannerContext: { actor: ACTOR } });
  const replayed = await second.resolve({ selectionHandle: remembered.pending.handle });
  assert.equal(replayed.kind, 'refusal', 'a stored selection handle selects nothing in another session');
  const read = await second.read({ resolutionId: remembered.lastResultHandles[0] });
  assert.deepEqual([read.kind, read.why[0].code], ['refusal', 'gateway.handle-unknown']);

  // And structurally: nothing that resolves, signs, plans or runs imports the store.
  for (const file of ['kernel.mjs', 'resolve.mjs', 'handles.mjs', 'policy.mjs', 'executor.mjs', 'plan-descriptor.mjs', 'host.mjs']) {
    const source = await readFile(path.join(root, 'src', 'gateway', file), 'utf8');
    assert.ok(!/local-store\.mjs/.test(source), `${file} reads the guide session`);
  }
});

test('"this" or "that" with more than one subject on screen asks which, and an ID decides it', () => {
  // `[INT:REQ-100]`
  const home = {
    kind: 'read', subject: null,
    data: {
      currentWork: { id: 'WRK-1', kind: 'story' },
      homeProjection: {
        resultType: 'my-work-home', schemaVersion: 2, activeWork: { id: 'WRK-1' },
        needsUser: [{ id: 'a', workId: 'WRK-2' }], worthChecking: [{ id: 'b', workId: 'WRK-1' }, { id: 'c', workId: null }]
      }
    }
  };
  const visible = visibleSubjects(home);
  assert.deepEqual(visible, [{ kind: 'story', id: 'WRK-1' }, { kind: 'work', id: 'WRK-2' }]);
  for (const utterance of ['continue it', 'submit that one', 'is this ready?', 'resume this story']) {
    const reference = referencedSubject(utterance, visible);
    assert.equal(reference.status, 'ambiguous', utterance);
    assert.deepEqual(reference.choices.map((entry) => entry.id), ['WRK-1', 'WRK-2']);
  }
  assert.deepEqual(referencedSubject('continue WRK-2', visible).subject, { kind: 'work', id: 'WRK-2' });
  assert.deepEqual(referencedSubject('continue WRK-7', visible).subject, { kind: null, id: 'WRK-7' }, 'an ID not on screen is still the one asked about');
  assert.equal(referencedSubject('continue it', [visible[0]]).status, 'single');
  assert.equal(referencedSubject('how does this repository work', visible).status, 'none', 'the repository is not a work subject');
  assert.equal(referencedSubject('continue', visible).status, 'none');
});

test('the CLI shows and resets the same entry, and a turn may reset it', async (t) => {
  // `[INT:REQ-101]`: a route anyone can use, including an agent turn, because it changes nothing that acts.
  const env = await storeEnv(t);
  const repo = await mkdtemp(path.join(os.tmpdir(), 'sflow-guide-cli-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  run('git', ['config', 'user.email', 'dev-1@example.com'], { cwd: repo });
  run('git', ['config', 'user.name', 'Dev One'], { cwd: repo });
  const owner = { actorId: 'dev-1@example.com', scope: guideSessionScope({ root: await realpath(repo) }) };
  await rememberGuideSession(owner, { subject: { kind: 'story', id: 'WRK-1' }, lastMenu: ['legal:work.continue'] }, { env });
  const cli = (...args) => spawnSync(process.execPath, [path.join(root, 'bin', 'singularity-flow.mjs'), 'gateway', 'session', ...args, '--json'], {
    cwd: repo, encoding: 'utf8', env: { ...env, SINGULARITY_FLOW_TEST_IDENTITY: '', SINGULARITY_FLOW_NO_MODEL: '1' }
  });
  const shown = cli();
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).session.subject.id, 'WRK-1');
  const reset = cli('reset');
  assert.equal(reset.status, 0, reset.stderr);
  assert.deepEqual(JSON.parse(reset.stdout), {
    reset: true, cleared: true, scope: owner.scope, preserved: ['work', 'pending plans', 'selected workspace', 'lifecycle records']
  });
  assert.equal(await readGuideSession(owner, { env }), null);
  const unknown = cli('forget');
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr + unknown.stdout, /gateway session show/);
});
