/**
 * Movable workspaces and one repository key (SPEC-SCF stage 5: SCF:REQ-019, REQ-021, REQ-022, D2, D3).
 *
 * The workspaces analysis of 2026-11-15 found these dead ends, each reproduced in a fixture:
 * - WS-3: a deleted Story checkout folder left the Story impossible to open ("the folder no longer exists").
 * - WS-4: a moved or renamed workspace folder left every route a dead end: Git's links are absolute, the registry was
 *   stale, `workspace repair` reported ready, `workspace open` saved a second entry, its own ID was "ambiguous".
 * - WS-5: a brief detached HEAD dropped a Story's index entry for good, so a second clone could open the Story.
 * - WS-6 and CH-F3: another spelling of the same origin (https or ssh, `.git`, a path or file://) stopped the workspace,
 *   and a running Story's approver refresh with APR_AUTHORITY_CHANGED.
 * Each test builds its own fixture: a bare origin, a workspace made by the CLI, and Story checkouts at the places SFlow
 * makes them, with machine state (registry, selection, Story index, confirmation codes) under the test's folder.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { gitRepositoryComparisonKey, sameRepository } from '../src/git-repository-identity.mjs';
import { captureSkillConfigurationAncestry, verifySkillConfigurationAncestry } from '../src/skp-amendment-audit.mjs';
import { lookupStoryCheckouts, readStoryIndex, repositoryKey } from '../src/story-index.mjs';
import {
  prepareStoryWorktree, rollbackStoryWorktree, storyWorktreeForBranch, storyWorktreeLocations, storyWorktreePath
} from '../src/story-worktree.mjs';
import { findWorkspaceMembership } from '../src/workspace-membership.mjs';
import { removeTemporaryTree } from '../src/util.mjs';
import { inventedValue } from './helpers/invented-secrets.mjs';

const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const IDENTITY = ['-c', 'user.name=Repair Tester', '-c', 'user.email=repair.tester@example.invalid'];
// The public host whose ssh and https spellings were already one repository, assembled as src/git-repository-identity.mjs does.
const HUB = ['github', 'com'].join('.');

/** A folder of the test's own, with its own machine state, and helpers that run Git and the CLI there. */
async function sandbox(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-ws-repair-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const machine = path.join(directory, 'machine');
  await mkdir(machine);
  const env = {
    ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_BUNDLE: 'off', SINGULARITY_FLOW_NO_MODEL: '1',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Repair Tester', SINGULARITY_FLOW_AUTOMATIC_CLEANUP: 'off',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(machine, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(machine, 'active-workspace.json'),
    SINGULARITY_FLOW_STORY_INDEX: path.join(machine, 'story-index.json'),
    SINGULARITY_FLOW_CONFIRM_CODES: path.join(machine, 'confirm-codes'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(machine, 'leads.json'),
    SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(machine, 'copilot-mode.json')
  };
  const sh = (command, args, cwd, { allowFailure = false } = {}) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120_000 });
    if (!allowFailure) assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const git = (cwd, ...args) => sh('git', [...IDENTITY, ...args], cwd).stdout.trim();
  const cli = (args, cwd = directory, options = {}) => sh(process.execPath, [CLI, ...args], cwd, options);
  /** A CLI answer as JSON: its value, or its refusal under `error`. */
  const json = (args, cwd = directory) => {
    const result = cli([...args, '--json'], cwd, { allowFailure: true });
    try { return { status: result.status, value: JSON.parse(result.stdout) }; }
    catch { return assert.fail(`not JSON: ${args.join(' ')}\n${result.stdout}\n${result.stderr}`); }
  };
  const registry = async () => JSON.parse(await readFile(env.SINGULARITY_FLOW_WORKSPACE_REGISTRY, 'utf8')).workspaces;
  return { directory, machine, env, sh, git, cli, json, registry };
}

/** A bare origin with one commit on main. */
async function origin(f) {
  const seed = path.join(f.directory, 'seed');
  await mkdir(seed);
  f.git(seed, 'init', '-q', '-b', 'main');
  await writeFile(path.join(seed, 'value.txt'), 'one\n');
  f.git(seed, 'add', '.');
  f.git(seed, 'commit', '-qm', 'Seed');
  const bare = path.join(f.directory, 'origin.git');
  f.git(f.directory, 'init', '-q', '--bare', '-b', 'main', bare);
  f.git(seed, 'push', '-q', bare, 'main:main');
  return bare;
}

/** A Story's managed checkout where SFlow makes one, on the Story's branch, which carries its record. */
async function storyCheckout(f, clone, workId, context) {
  const at = (await storyWorktreeLocations(clone, workId, { context })).compact;
  await mkdir(path.dirname(at), { recursive: true });
  f.git(clone, 'worktree', 'add', '-q', '-b', workId, '--', at, 'main');
  await mkdir(path.join(at, 'singularity', 'work-items', workId), { recursive: true });
  await writeFile(path.join(at, 'singularity', 'work-items', workId, 'workflow.json'), `${JSON.stringify({ workItem: { id: workId } })}\n`);
  f.git(at, 'add', '.');
  f.git(at, 'commit', '-qm', `${workId} record`);
  return at;
}

/** A workspace made by the CLI, its repository cloned, with Story checkouts, selected as the active workspace. */
async function workspaceFixture(t, stories = ['ST-1', 'ST-2']) {
  const f = await sandbox(t);
  const bare = await origin(f);
  const created = f.json(['workspace', 'create', '--local', '--id', 'wsa', '--lead', 'application',
    '--repository', `application=${pathToFileURL(bare).href}`, '--base', path.join(f.directory, 'base'), '--confirm', 'wsa']);
  assert.equal(created.status, 0, JSON.stringify(created.value));
  const workspace = created.value.workspace.path;
  assert.equal(f.json(['workspace', 'repair', workspace]).status, 0);
  const clone = path.join(workspace, 'repos', 'application');
  const checkouts = {};
  for (const id of stories) checkouts[id] = await storyCheckout(f, clone, id, { workspacePath: workspace, repositoryId: 'application' });
  f.cli(['workspace', 'use', 'local--wsa', '--json']);
  return { ...f, bare, workspace, clone, checkouts };
}

const route = (refusal) => refusal?.details?.nextAction?.command ?? refusal?.details?.nextAction;

test('one repository key: https or ssh, .git, letter case and a trailing slash name one repository [SCF:REQ-019, WS-6]', async (t) => {
  for (const [left, right] of [
    ['git@git.example.com:Team/App.git', 'https://git.example.com/team/app/'],
    ['ssh://git@git.example.com:2222/team/app', 'https://git.example.com/team/app.git'],
    [`git@${HUB}:team/app.git`, `https://${HUB}/Team/App`],
    ['/srv/git/app.git', 'file:///srv/git/app.git']
  ]) assert.equal(sameRepository(left, right), true, `${left} = ${right}`);
  for (const [left, right] of [
    ['https://git.example.com/team/app', 'https://other.example.com/team/app'],
    ['https://git.example.com/team/app', 'https://git.example.com/team/app-two'],
    [inventedValue('https://person:', 'secret@git.example.com/team/app'), 'https://git.example.com/team/app']
  ]) assert.equal(sameRepository(left, right), false, `${left} != ${right}`);
  // Recorded keys (the Story index, record identities) keep their meaning: only GitHub aliases its protocols there.
  assert.notEqual(gitRepositoryComparisonKey('git@git.example.com:team/app.git'), gitRepositoryComparisonKey('https://git.example.com/team/app'));

  // A workspace clone whose origin is spelled another way still belongs to its workspace (it stopped it before).
  const f = await workspaceFixture(t, []);
  f.git(f.clone, 'remote', 'set-url', 'origin', f.bare);
  assert.equal((await findWorkspaceMembership(f.clone, { workspacePath: f.workspace })).repositoryId, 'application');
  f.git(f.clone, 'remote', 'set-url', 'origin', `${pathToFileURL(f.bare).href}/`);
  assert.equal((await findWorkspaceMembership(f.clone, { workspacePath: f.workspace })).repositoryId, 'application');
  // Another repository is refused with both remotes and the command that points origin back.
  const other = path.join(f.directory, 'other.git');
  f.git(f.directory, 'init', '-q', '--bare', other);
  f.git(f.clone, 'remote', 'set-url', 'origin', other);
  await assert.rejects(findWorkspaceMembership(f.clone, { workspacePath: f.workspace }), (error) => {
    assert.equal(error.code, 'WORKSPACE_REPOSITORY_IDENTITY_MISMATCH');
    assert.equal(error.details.actualRemote, other);
    assert.equal(error.details.expectedRemote, pathToFileURL(f.bare).href);
    assert.match(route(error), /remote set-url origin/u);
    assert.ok(route(error).includes(pathToFileURL(f.bare).href), route(error));
    return true;
  });
});

test('a running Story\'s configuration ancestry is proven from another spelling of its authority [SCF:REQ-019, CH-F3]', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-ws-repair-authority-')));
  t.after(() => removeTemporaryTree(root));
  const git = (...args) => {
    const result = spawnSync('git', [...IDENTITY, ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  await writeFile(path.join(root, 'configuration.txt'), 'one\n');
  git('add', '-A'); git('commit', '-qm', 'one');
  const ancestorCommit = git('rev-parse', 'HEAD');
  await writeFile(path.join(root, 'configuration.txt'), 'two\n');
  git('add', '-A'); git('commit', '-qm', 'two');
  const descendantCommit = git('rev-parse', 'HEAD');
  // The Story recorded its authority as a path; this laptop reaches the same repository as a file:// URL.
  const prior = { repository: root, commit: ancestorCommit };
  const snapshot = Object.freeze({ authority: Object.freeze({ remote: pathToFileURL(root).href }), sourceCommit: descendantCommit });
  const proof = await captureSkillConfigurationAncestry(snapshot, prior);
  assert.equal(proof.repository, root, 'the proof names the repository as the Story recorded it');
  assert.equal(verifySkillConfigurationAncestry(proof, { repository: root, ancestorCommit, descendantCommit }), true);
  // Another repository is still refused.
  await assert.rejects(captureSkillConfigurationAncestry({ authority: { remote: path.join(root, 'elsewhere.git') }, sourceCommit: descendantCommit }, prior),
    { code: 'SKP_AMENDMENT_ANCESTRY_INVALID' });
});

test('a Story checkout on a detached HEAD keeps its index entry, so no second clone opens the Story [WS-5]', async (t) => {
  const f = await workspaceFixture(t, ['ST-1']);
  const checkout = await realpath(f.checkouts['ST-1']);
  const commonDir = await realpath(path.join(f.clone, '.git'));
  const url = pathToFileURL(f.bare).href;
  const entry = { workId: 'ST-1', title: 'Value', repository: { key: await repositoryKey(url, commonDir), url, id: 'application' },
    workspace: { id: 'local--wsa', name: 'wsa', path: f.workspace }, checkoutPath: checkout, commonDir, branch: 'ST-1',
    workflowPath: 'singularity/work-items/ST-1/workflow.json', aliases: ['ST-1'], recordedBy: 'test', updatedAt: new Date().toISOString() };
  await writeFile(f.env.SINGULARITY_FLOW_STORY_INDEX, `${JSON.stringify({ schemaVersion: 1, kind: 'story-index', updatedAt: null, backfill: null, entries: [entry] })}\n`);
  f.git(checkout, 'checkout', '-q', '--detach');
  const found = await lookupStoryCheckouts('ST-1', { env: f.env, backfill: false });
  assert.equal(found.valid.length, 1, 'a detached HEAD is still the Story\'s checkout');
  assert.equal((await readStoryIndex({ env: f.env })).entries.length, 1, 'the entry is kept');
  const listed = f.json(['workspace', 'stories']);
  assert.equal(listed.value.stories[0]?.detachedHead, true, JSON.stringify(listed.value));
  // Another branch checked out there is no longer the Story's checkout.
  f.git(checkout, 'checkout', '-q', '-b', 'elsewhere');
  assert.equal((await lookupStoryCheckouts('ST-1', { env: f.env, backfill: false })).valid.length, 0);
});

test('a moved workspace: every route names workspace repair, which previews, then re-links and re-saves it [SCF:REQ-022, WS-4]', async (t) => {
  const f = await workspaceFixture(t);
  const moved = `${f.workspace}-moved`;
  await rename(f.workspace, moved);
  const clone = path.join(moved, 'repos', 'application');
  const checkout = path.join(moved, path.relative(f.workspace, f.checkouts['ST-1']));
  assert.notEqual(f.sh('git', ['status'], checkout, { allowFailure: true }).status, 0, 'Git lost the moved checkout');
  const repair = `singularity-flow workspace repair ${JSON.stringify(moved)}`;

  // Every route names the one repair.
  const status = f.json(['workspace', 'status'], moved);
  assert.equal(status.value.error.code, 'WORKSPACE_NOT_SAVED_HERE');
  assert.equal(route(status.value.error), repair);
  for (const args of [['workspace', 'use', moved], ['workspace', 'open', moved]]) {
    const refused = f.json(args);
    assert.equal(refused.value.error.code, 'WORKSPACE_MOVED', JSON.stringify(refused.value));
    assert.equal(route(refused.value.error), repair);
  }
  assert.equal((await f.registry()).filter((entry) => entry.id === 'local--wsa').length, 1, 'open did not save a second entry');
  assert.throws(() => storyWorktreeForBranch(clone, 'ST-1'), (error) => {
    assert.equal(error.code, 'STORY_CHECKOUT_MISSING');
    assert.equal(route(error), repair);
    return true;
  });
  const inCheckout = f.json(['status'], checkout);
  assert.equal(inCheckout.value.error.code, 'ACTIVE_WORKSPACE_MOVED', JSON.stringify(inCheckout.value));
  assert.equal(route(inCheckout.value.error), repair);

  // The preview changes nothing.
  const before = await readFile(f.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY, 'utf8');
  const preview = f.json(['workspace', 'repair'], moved);
  assert.equal(preview.status, 0, JSON.stringify(preview.value));
  const plan = preview.value.links.plan;
  assert.equal(preview.value.links.status, 'preview');
  assert.equal(plan.registration.movedFrom, f.workspace);
  assert.deepEqual(plan.clones[0].relink.map((entry) => entry.branch).sort(), ['ST-1', 'ST-2']);
  assert.equal(plan.selection.to, moved);
  assert.equal(await readFile(f.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY, 'utf8'), before);
  assert.notEqual(f.sh('git', ['status'], checkout, { allowFailure: true }).status, 0);
  assert.equal(preview.value.links.confirmCommand, `${repair} --confirm ${plan.planId}`);
  assert.ok(preview.value.links.lines.includes('Repair plan (nothing has changed yet):'), 'VS Code shows the words the terminal prints');

  // A confirmation that is not the previewed plan changes nothing.
  const stale = f.json(['workspace', 'repair', moved, '--confirm', 'wsr-0123456789abcdef0123456789abcdef']);
  assert.equal(stale.value.error.code, 'WORKSPACE_REPAIR_PLAN_CHANGED');

  const applied = f.json(['workspace', 'repair', moved, '--confirm', plan.planId]);
  assert.equal(applied.status, 0, JSON.stringify(applied.value));
  assert.equal(applied.value.links.relinked.length, 2);
  assert.equal(f.git(checkout, 'branch', '--show-current'), 'ST-1');
  assert.ok(f.git(clone, 'worktree', 'list', '--porcelain').includes(`worktree ${checkout}`));
  assert.deepEqual((await f.registry()).filter((entry) => entry.id === 'local--wsa').map((entry) => entry.path), [moved]);
  assert.equal(JSON.parse(await readFile(f.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE, 'utf8')).workspacePath, moved);
  assert.equal(f.json(['workspace', 'repair', moved]).value.links.status, 'nothing-to-repair');
  assert.equal(f.json(['workspace', 'use', 'local--wsa']).status, 0, 'its own ID is not ambiguous');
  assert.equal(storyWorktreeForBranch(clone, 'ST-1').repositoryPath, checkout);
});

test('a deleted Story checkout is made again from its branch, and repair waits on work it would lose [SCF:REQ-022, WS-3]', async (t) => {
  const f = await workspaceFixture(t, ['ST-1', 'ST-2', 'ST-3']);
  const entryOf = async (checkout) => {
    for (const name of await readdir(path.join(f.clone, '.git', 'worktrees'))) {
      const recorded = (await readFile(path.join(f.clone, '.git', 'worktrees', name, 'gitdir'), 'utf8')).trim();
      if (path.dirname(recorded) === checkout) return path.join(f.clone, '.git', 'worktrees', name);
    }
    return assert.fail(`no entry for ${checkout}`);
  };
  // ST-1 has a saved SFlow record under its Git folder; ST-2 is on a commit only it holds; ST-3 has a file in its index.
  const one = await entryOf(f.checkouts['ST-1']);
  await mkdir(path.join(one, 'singularity-flow', 'choices'), { recursive: true });
  await writeFile(path.join(one, 'singularity-flow', 'choices', 'answer.json'), '{"answer":"kept"}\n');
  f.git(f.checkouts['ST-2'], 'checkout', '-q', '--detach');
  await writeFile(path.join(f.checkouts['ST-2'], 'only-here.txt'), 'only here\n');
  f.git(f.checkouts['ST-2'], 'add', 'only-here.txt');
  f.git(f.checkouts['ST-2'], 'commit', '-qm', 'Only on a detached HEAD');
  const lonely = f.git(f.checkouts['ST-2'], 'rev-parse', 'HEAD');
  const three = await entryOf(f.checkouts['ST-3']);
  await writeFile(path.join(f.checkouts['ST-3'], 'staged.txt'), 'staged\n');
  f.git(f.checkouts['ST-3'], 'add', 'staged.txt');
  for (const id of ['ST-1', 'ST-2', 'ST-3']) await rm(f.checkouts[id], { recursive: true, force: true });

  const repair = `singularity-flow workspace repair ${JSON.stringify(f.workspace)}`;
  assert.throws(() => storyWorktreeForBranch(f.clone, 'ST-1'), (error) => error.code === 'STORY_CHECKOUT_MISSING' && route(error) === repair);

  // Repair waits on the commit only ST-2 held and the file ST-3 had added, naming the command that saves each.
  let preview = f.json(['workspace', 'repair', f.workspace]);
  assert.equal(preview.value.links.status, 'blocked');
  const codes = Object.fromEntries(preview.value.links.plan.refusals.map((refusal) => [refusal.code, refusal]));
  assert.match(codes.WORKSPACE_REPAIR_WOULD_LOSE_COMMIT.command, new RegExp(`branch rescue-\\S+ ${lonely}$`, 'u'));
  assert.deepEqual(codes.WORKSPACE_REPAIR_WOULD_LOSE_STAGED.files, ['staged.txt']);
  const blocked = f.json(['workspace', 'repair', f.workspace, '--confirm', preview.value.links.plan.planId]);
  assert.ok(['WORKSPACE_REPAIR_WOULD_LOSE_COMMIT', 'WORKSPACE_REPAIR_WOULD_LOSE_STAGED'].includes(blocked.value.error.code), JSON.stringify(blocked.value));
  assert.ok(existsSync(one), 'nothing was forgotten');

  // Saving them as the refusals say lets repair go on.
  f.git(f.clone, 'branch', 'rescue-st-2', lonely);
  f.sh('git', ['--git-dir', three, 'diff', '--cached', '--binary'], f.clone);
  f.sh('git', ['--git-dir', three, 'read-tree', 'HEAD'], f.clone);
  preview = f.json(['workspace', 'repair', f.workspace]);
  assert.equal(preview.value.links.status, 'preview', JSON.stringify(preview.value.links.plan.refusals));
  const [clone] = preview.value.links.plan.clones;
  assert.deepEqual(clone.recreate.map((entry) => entry.workId).sort(), ['ST-1', 'ST-3']);
  assert.deepEqual(clone.forget.map((entry) => entry.commit), [lonely], 'the detached checkout is forgotten; its commit has a branch');

  const applied = f.json(['workspace', 'repair', f.workspace, '--confirm', preview.value.links.plan.planId]);
  assert.equal(applied.status, 0, JSON.stringify(applied.value));
  const remade = applied.value.links.recreated.find((entry) => entry.workId === 'ST-1');
  assert.equal(remade.at, (await storyWorktreeLocations(f.clone, 'ST-1', { context: { workspacePath: f.workspace, repositoryId: 'application' } })).compact);
  assert.equal(f.git(remade.at, 'branch', '--show-current'), 'ST-1');
  assert.ok(existsSync(path.join(remade.at, 'singularity', 'work-items', 'ST-1', 'workflow.json')), 'the branch\'s commits are there');
  assert.equal(await readFile(path.join(remade.savedRecordsAt, 'choices', 'answer.json'), 'utf8'), '{"answer":"kept"}\n',
    'SFlow\'s saved record moved to the new checkout');
  assert.equal(storyWorktreeForBranch(f.clone, 'ST-1').repositoryPath, remade.at);
  assert.equal(f.json(['workspace', 'repair', f.workspace]).value.links.status, 'nothing-to-repair');
});

test('a clone in no workspace keeps Story checkouts beside it, finds older ones, and is repaired after a move [SCF D3, REQ-022]', async (t) => {
  const f = await sandbox(t);
  const bare = await origin(f);
  const clone = path.join(f.directory, 'code', 'app');
  await mkdir(path.dirname(clone), { recursive: true });
  f.git(f.directory, 'clone', '-q', bare, clone);
  const at = await storyWorktreePath(clone, 'LONE-1');
  assert.equal(path.dirname(at), `${clone}.stories`, 'beside the clone, never in a parent .singularity-flow');
  const prepared = await prepareStoryWorktree(clone, 'LONE-1', { base: 'main' });
  assert.equal(await realpath(prepared.repositoryPath), await realpath(at));
  assert.equal(rollbackStoryWorktree(prepared).removed, true);
  // A checkout an earlier build made in <parent>/.singularity-flow/story-worktrees is resumed, not duplicated.
  const { previous } = await storyWorktreeLocations(clone, 'LONE-2', { context: null });
  await mkdir(path.dirname(previous), { recursive: true });
  f.git(clone, 'worktree', 'add', '-q', '-b', 'LONE-2', '--', previous, 'main');
  const resumed = await prepareStoryWorktree(clone, 'LONE-2', { base: 'main' });
  assert.equal(resumed.resumed, true);
  assert.equal(await realpath(resumed.repositoryPath), await realpath(previous));

  // The clone moves; its Story checkouts stay. Repair, given the clone, re-links them after its preview.
  const story = await storyCheckout(f, clone, 'LONE-3', null);
  const movedClone = path.join(f.directory, 'code', 'app-renamed');
  await rename(clone, movedClone);
  assert.notEqual(f.sh('git', ['status'], story, { allowFailure: true }).status, 0);
  const preview = f.json(['workspace', 'repair', movedClone]);
  assert.equal(preview.status, 0, JSON.stringify(preview.value));
  assert.equal(preview.value.links.plan.mode, 'clone');
  assert.ok(preview.value.links.plan.clones[0].relink.some((entry) => entry.to === story));
  const applied = f.json(['workspace', 'repair', movedClone, '--confirm', preview.value.links.plan.planId]);
  assert.equal(applied.status, 0, JSON.stringify(applied.value));
  assert.equal(f.git(story, 'branch', '--show-current'), 'LONE-3');
});

test('a workspace ID is never ambiguous, copies are named by folder, and prune forgets folders that are gone [SCF:REQ-022]', async (t) => {
  const f = await workspaceFixture(t, []);
  const copy = path.join(f.directory, 'copy', 'wsa');
  await mkdir(path.dirname(copy), { recursive: true });
  f.sh('cp', ['-R', f.workspace, copy], f.directory);
  assert.equal(f.json(['workspace', 'open', copy]).status, 0, 'a copy, whose original is still there, is saved');
  const both = f.json(['workspace', 'use', 'local--wsa']);
  assert.equal(both.value.error.code, 'WORKSPACE_REFERENCE_AMBIGUOUS');
  assert.ok(both.value.error.message.includes(copy) && both.value.error.message.includes(f.workspace), both.value.error.message);
  // The original goes; the same ID saved twice with one folder gone is a move, and repair is its route.
  await rename(f.workspace, `${f.workspace}-gone`);
  const twice = f.json(['workspace', 'use', 'local--wsa']);
  assert.equal(twice.value.error.code, 'WORKSPACE_MOVED');
  assert.equal(route(twice.value.error), `singularity-flow workspace repair ${JSON.stringify(copy)}`);
  const pruned = f.json(['workspace', 'prune']);
  assert.deepEqual(pruned.value.missing.map((entry) => entry.path), [f.workspace]);
  assert.deepEqual((await f.registry()).map((entry) => entry.path), [copy]);
  assert.equal(f.json(['workspace', 'use', 'local--wsa']).status, 0);
});
