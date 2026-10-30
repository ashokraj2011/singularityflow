/**
 * Transactional configuration drafts (SDA M3; SDA-AC-003, SDA-AC-005): a save survives a crash, two
 * processes saving at once both land, a proposal removes only the drafts it holds, a repeated
 * operation returns its first draft and a changed one is refused, and the drafts file of earlier
 * builds migrates once, resuming without duplicates when interrupted.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  authorChange, defaultDraftOperationId, describeChange, draftsDirectory, legacyDraftsPath, proposeDrafts, readDrafts,
  settleDrafts, withSavedDrafts
} from '../src/configuration-drafts.mjs';
import { SingularityFlowError } from '../src/util.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

const MODULE = new URL('../src/configuration-drafts.mjs', import.meta.url).href;
const SET = 'sflow-studio-change-set@1';
const AUTHORITY = { kind: 'approved-configuration-ref', ref: 'refs/remotes/origin/sflow/config', commit: 'b'.repeat(40) };

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-drafts-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return root;
}

const skill = (id) => ({ op: 'skill.create', id, label: id, description: `The ${id} skill.`, instructions: `Do ${id}.` });
const save = (root, change, extra = {}) => authorChange(root, { schema: SET, changes: [change] }, {
  subject: change.id, message: 'm',
  apply: async () => assert.fail('a draft save applies nothing'),
  check: async (set, options) => {
    assert.deepEqual(options, { refreshAuthority: false }, 'a save asks no remote');
    return { plan: { valid: true, summary: set.changes.map(describeChange), warnings: [] }, source: AUTHORITY };
  },
  ...extra
});

/** Save one change from another Node process; `crashAt` kills it at that point, `delay` slows its check. */
function childSave(root, change, { crashAt = null, delay = 0, operationId = null } = {}) {
  const code = `
    const { authorChange } = await import(${JSON.stringify(MODULE)});
    const [root, change, delay, operationId, authority] = JSON.parse(process.argv[1]);
    const result = await authorChange(root, { schema: ${JSON.stringify(SET)}, changes: [change] }, {
      subject: change.id, message: 'm', operationId,
      apply: async () => { throw new Error('a draft save applies nothing'); },
      check: async (set) => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return { plan: { valid: true, summary: set.changes.map((entry) => entry.id), warnings: [] }, source: authority };
      }
    });
    process.stdout.write(JSON.stringify(result));`;
  return childRun(code, [root, change, delay, operationId, AUTHORITY], crashAt);
}

function childRun(code, input, crashAt = null) {
  const env = { ...process.env, NODE_ENV: 'test' };
  delete env.SINGULARITY_FLOW_TEST_CRASH_AT;
  if (crashAt) env.SINGULARITY_FLOW_TEST_CRASH_AT = crashAt;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(input)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), childTimeout(60_000));
    child.on('error', reject);
    child.on('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }); });
  });
}

const storeNames = async (root) => (await readdir(draftsDirectory(root))).sort();

test('a save killed between writing and publishing leaves no draft or a whole one; the next save lands and sweeps the orphan (SDA-AC-003)', async t => {
  const root = await repository(t);
  await save(root, skill('first'));
  const crashed = await childSave(root, skill('second'), { crashAt: 'configuration-draft-publish' });
  assert.equal(crashed.signal, 'SIGKILL', `${crashed.stdout}\n${crashed.stderr}`);
  const names = await storeNames(root);
  assert.equal(names.filter((name) => name.endsWith('.tmp')).length, 1, `the crash left its temporary file: ${names}`);
  for (const name of names.filter((entry) => /^cdr-[0-9a-f]{24}\.json$/u.test(entry))) {
    JSON.parse(await readFile(path.join(draftsDirectory(root), name), 'utf8'));
  }
  assert.deepEqual((await readDrafts(root)).changes.map((entry) => entry.change.id), ['first'], 'the crashed draft is absent, the earlier one whole');
  // The dead process still owns the lock directory; the next save reclaims it, saves, and removes the orphan.
  const retried = await save(root, skill('second'));
  assert.equal(retried.saved, 'new');
  assert.deepEqual((await readDrafts(root)).changes.map((entry) => entry.change.id), ['first', 'second']);
  assert.deepEqual((await storeNames(root)).filter((name) => name.endsWith('.tmp')), []);
});

test('two processes saving at the same time both land, each checked against the other (SDA §9)', async t => {
  const root = await repository(t);
  const results = await Promise.all([
    childSave(root, skill('alpha'), { delay: 150 }),
    childSave(root, skill('beta'), { delay: 150 }),
    childSave(root, skill('gamma'), { delay: 150 })
  ]);
  for (const result of results) assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const drafts = await readDrafts(root);
  const order = drafts.changes.map((entry) => entry.change.id);
  assert.deepEqual([...order].sort(), ['alpha', 'beta', 'gamma']);
  assert.equal(new Set(drafts.changes.map((entry) => entry.sequence)).size, 3, 'each draft has its own place in the order');
  // A save whose drafts changed after its check is checked again: each landed draft was checked on top
  // of exactly the drafts saved before it.
  for (const result of results.map((entry) => JSON.parse(entry.stdout))) {
    const id = drafts.changes.find((entry) => entry.draftId === result.drafts.ids[0]).change.id;
    assert.deepEqual(result.summary, order.slice(0, order.indexOf(id) + 1));
  }
});

test('a draft saved while a proposal is made survives it, and so does one saved while Studio settles', async t => {
  const root = await repository(t);
  await save(root, skill('one'));
  await save(root, skill('two'));
  const proposed = await proposeDrafts(root, { apply: async (set) => {
    assert.deepEqual(set.changes.map((change) => change.id), ['one', 'two']);
    const meanwhile = await childSave(root, skill('three'));
    assert.equal(meanwhile.status, 0, meanwhile.stderr);
    return { reviewRequired: true, branch: 'sflow/config-change/workflow/x', commit: 'c'.repeat(40), files: [] };
  } });
  assert.equal(proposed.drafts.pending, 1);
  const after = await readDrafts(root);
  assert.deepEqual(after.changes.map((entry) => entry.change.id), ['three'], 'the proposal removed exactly the drafts it holds');
  assert.equal(after.proposed.draftIds.length, 2);
  assert.deepEqual(after.proposed.changes, ['New skill one (one)', 'New skill two (two)']);

  const studio = await withSavedDrafts(root, { schema: SET, changes: [] });
  assert.deepEqual(studio.included, ['New skill three (three)']);
  await save(root, skill('four'));
  await settleDrafts(root, { valid: true, written: ['x'] }, studio);
  assert.deepEqual((await readDrafts(root)).changes.map((entry) => entry.change.id), ['four']);
});

test('a repeated operation returns its first draft; another change under that operation is refused (SDA-AC-005)', async t => {
  const root = await repository(t);
  const first = await save(root, skill('review'), { operationId: 'op-1' });
  assert.equal(first.saved, 'new');
  const again = await save(root, skill('review'), { operationId: 'op-1' });
  assert.equal(again.saved, 'existing');
  assert.deepEqual(again.drafts.ids, first.drafts.ids);
  await assert.rejects(save(root, { ...skill('review'), description: 'Other bytes.' }, { operationId: 'op-1' }),
    (error) => error.code === 'CONFIGURATION_DRAFT_OPERATION_REUSED' && error.outcomeClass === 'OPERATION_ID_REUSE'
      && error.details.draftId === first.drafts.ids[0]);
  await assert.rejects(save(root, skill('x'), { operationId: '-bad id' }), (error) => error.code === 'CONFIGURATION_DRAFT_OPERATION_INVALID');
  // Without an operation ID, the same command twice is one operation.
  const plain = await save(root, skill('other'));
  assert.equal((await save(root, skill('other'))).saved, 'existing');
  const drafts = await readDrafts(root);
  assert.deepEqual(drafts.changes.map((entry) => entry.operationId), ['op-1', defaultDraftOperationId(skill('other'))]);
  assert.equal(drafts.changes[1].draftId, plain.drafts.ids[0]);
  // The same operation from another process, at the same time, is still one draft.
  const racing = await Promise.all([childSave(root, skill('race'), { operationId: 'op-race', delay: 100 }),
    childSave(root, skill('race'), { operationId: 'op-race', delay: 100 })]);
  for (const result of racing) assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(racing.map((result) => JSON.parse(result.stdout).saved).sort(), ['existing', 'new']);
  assert.equal((await readDrafts(root)).changes.filter((entry) => entry.operationId === 'op-race').length, 1);
});

test('the drafts file of earlier builds migrates once, and an interrupted migration resumes without duplicates', async t => {
  const root = await repository(t);
  const legacy = { schema: 'sflow-configuration-drafts@1', proposed: { branch: 'sflow/config-change/workflow/old', commit: null, at: '2026-10-01T00:00:00.000Z', changes: ['Old'] },
    changes: ['a', 'b', 'c'].map((id, index) => ({ addedAt: `2026-10-0${index + 2}T00:00:00.000Z`, description: describeChange(skill(id)), change: skill(id) })) };
  const bytes = `${JSON.stringify(legacy, null, 2)}\n`;
  await mkdir(path.dirname(legacyDraftsPath(root)), { recursive: true });
  await writeFile(legacyDraftsPath(root), bytes);
  const interrupted = await childRun(`
    const { readDrafts } = await import(${JSON.stringify(MODULE)});
    await readDrafts(JSON.parse(process.argv[1]));`, root, 'configuration-draft-migration');
  assert.equal(interrupted.signal, 'SIGKILL', interrupted.stderr);
  assert.equal(await readFile(legacyDraftsPath(root), 'utf8'), bytes, 'the old file stays until every draft is migrated');
  assert.equal((await storeNames(root)).filter((name) => name.startsWith('cdr-')).length, 1);

  const migrated = await readDrafts(root);
  assert.deepEqual(migrated.changes.map((entry) => [entry.change.id, entry.addedAt, entry.checkedAgainst, entry.state]), [
    ['a', '2026-10-02T00:00:00.000Z', null, 'saved-local'], ['b', '2026-10-03T00:00:00.000Z', null, 'saved-local'],
    ['c', '2026-10-04T00:00:00.000Z', null, 'saved-local']]);
  assert.deepEqual(migrated.changes.map((entry) => entry.operationId), ['a', 'b', 'c'].map((id) => defaultDraftOperationId(skill(id))));
  assert.equal(migrated.proposed.branch, 'sflow/config-change/workflow/old');
  await assert.rejects(readFile(legacyDraftsPath(root)), { code: 'ENOENT' });
  assert.equal(await readFile(`${legacyDraftsPath(root)}.migrated-v2`, 'utf8'), bytes, 'kept, never deleted');
  assert.deepEqual((await readDrafts(root)).changes.map((entry) => entry.draftId), migrated.changes.map((entry) => entry.draftId));
  // Retrying a command saved before the upgrade is the same operation as its migrated draft.
  assert.equal((await save(root, skill('b'))).saved, 'existing');
});

test('a proposal recorded just before a crash hides the drafts it holds, and the next change removes them', async t => {
  const root = await repository(t);
  await save(root, skill('held'));
  const [held] = (await readDrafts(root)).changes;
  const directory = draftsDirectory(root);
  await writeFile(path.join(directory, 'proposed.json'), `${JSON.stringify({ schema: 'sflow-configuration-drafts-proposed@2', revision: 1,
    proposed: { branch: 'sflow/config-change/workflow/y', commit: null, at: 'x', changes: [held.description], draftIds: [held.draftId] } }, null, 2)}\n`);
  assert.deepEqual((await readDrafts(root)).changes, []);
  assert.ok((await storeNames(root)).includes(`${held.draftId}.json`));
  await save(root, skill('next'));
  assert.ok(!(await storeNames(root)).includes(`${held.draftId}.json`));
  assert.deepEqual((await readDrafts(root)).changes.map((entry) => entry.change.id), ['next']);
});

test('once a save learned the repository has an approved configuration, saves ask no remote unless the checkout disagrees (SDA §9)', async t => {
  const unreachable = () => new SingularityFlowError('Cannot reach Story configuration authority.', { code: 'REMOTE_NOT_FOUND', details: { classification: 'remote-not-found' } });
  const scenario = (root, { checkout = true, remote = 'approved' } = {}) => {
    const calls = [];
    const check = async (set, options = {}) => {
      const local = options.refreshAuthority === false;
      calls.push(local ? 'checkout' : 'remote');
      const id = set.changes.at(-1).id;
      if (local) {
        return { source: { kind: 'working-tree', ref: null, commit: null }, plan: checkout ? { valid: true, summary: [id], warnings: [] }
          : { valid: false, problems: [{ message: `There is no skill ${id}.` }], summary: [], warnings: [], files: [] } };
      }
      if (remote === 'offline') throw unreachable();
      return { source: { ...AUTHORITY, ref: 'sflow/config' }, plan: { valid: true, summary: [id], warnings: [] } };
    };
    return { calls, save: (change) => authorChange(root, { schema: SET, changes: [change] }, {
      subject: change.id, message: 'm', check, apply: async () => assert.fail('nothing is written to the working tree') }) };
  };
  const root = await repository(t);
  // Nothing known yet: the approved configuration is asked once, and the answer is remembered.
  const first = scenario(root);
  await first.save(skill('a'));
  assert.deepEqual(first.calls, ['checkout', 'remote']);
  assert.equal((await readDrafts(root)).authority.commit, AUTHORITY.commit);
  // Known: the checkout agrees, so no remote is asked.
  const quiet = scenario(root, { remote: 'offline' });
  assert.equal((await quiet.save(skill('b'))).saved, 'new');
  assert.deepEqual(quiet.calls, ['checkout']);
  // The checkout disagrees (it may predate an approval): the approved configuration decides.
  const asked = scenario(root, { checkout: false });
  await asked.save(skill('c'));
  assert.deepEqual(asked.calls, ['checkout', 'remote']);
  // Disagreeing and offline: saved, with the disagreement as a warning, checked again when proposed.
  const offline = scenario(root, { checkout: false, remote: 'offline' });
  const saved = await offline.save(skill('d'));
  assert.equal(saved.saved, 'new');
  assert.match(saved.warnings[0].message, /could not be reached; this checkout says: There is no skill d\. It is checked again when you propose\./);
  assert.deepEqual((await readDrafts(root)).changes.map((entry) => [entry.change.id, entry.checkedAgainst]), [
    ['a', { commit: AUTHORITY.commit, source: 'sflow/config' }], ['b', { commit: null, source: 'checkout-configuration' }],
    ['c', { commit: AUTHORITY.commit, source: 'sflow/config' }], ['d', { commit: null, source: 'checkout-configuration' }]]);
  // A repository with nothing known and no reachable remote cannot tell a draft from a working-tree edit.
  const fresh = await repository(t);
  await assert.rejects(scenario(fresh, { remote: 'offline' }).save(skill('e')), (error) => error.code === 'REMOTE_NOT_FOUND');
  assert.deepEqual((await readDrafts(fresh)).changes, []);
});
