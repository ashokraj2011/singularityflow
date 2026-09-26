import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { openGitDraftStore, draftDeletePlan, WCA_GIT_DRAFT_LIMITS } from '../src/wca-git-drafts.mjs';
import { issueActionAuthorization } from '../src/action-authorization.mjs';
import { withIsolatedGitObjectRepository, writeExactGitObjectCommit, pushIsolatedGitDraftCommit, resolveGitCommitIdentity, exactFileAtObject, exactTreePathsAtObject, identity } from '../src/git.mjs';
import { parseEnvironmentDeclaration } from '../src/environment-declaration.mjs';
import { canonicalJson, recordSha256 } from '../src/records.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { createHash, randomUUID } from 'node:crypto';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
async function fixture(t, { format = 'sha1' } = {}) {
  // This private local Git fixture is not a provider-account witness and must not query a
  // contributor's unrelated gh account merely to exercise local action-token bindings.
  const identityEnvironment = { NODE_ENV: process.env.NODE_ENV, SINGULARITY_FLOW_TEST_IDENTITY: process.env.SINGULARITY_FLOW_TEST_IDENTITY };
  process.env.NODE_ENV = 'test'; process.env.SINGULARITY_FLOW_TEST_IDENTITY = 'WCA Local Fixture Actor';
  t.after(() => {
    for (const [key, value] of Object.entries(identityEnvironment)) value === undefined ? delete process.env[key] : process.env[key] = value;
  });
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-wca-git-drafts-test-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const remote = path.join(parent, 'authority.git');
  const first = path.join(parent, 'first'); const second = path.join(parent, 'second');
  await mkdir(first);
  git(parent, 'init', '--bare', `--object-format=${format}`, remote);
  git(first, 'init', '-b', 'main', `--object-format=${format}`);
  git(first, 'config', 'user.name', 'Draft Client One');
  git(first, 'config', 'user.email', 'draft.one@example.test');
  await writeFile(path.join(first, 'application.txt'), 'application untouched\n');
  git(first, 'add', '.'); git(first, 'commit', '-m', 'application and approved configuration');
  git(first, 'branch', 'sflow/config'); git(first, 'remote', 'add', 'origin', remote);
  git(first, 'push', 'origin', 'main', 'sflow/config');
  git(parent, 'clone', '--branch', 'main', remote, second);
  git(second, 'config', 'user.name', 'Draft Client Two');
  git(second, 'config', 'user.email', 'draft.two@example.test');
  // Unrelated staged contributor content is a strict invariant, not just an empty-index check.
  for (const root of [first, second]) {
    await writeFile(path.join(root, 'staged.txt'), `${path.basename(root)} staged bytes\n`);
    git(root, 'add', 'staged.txt');
  }
  const before = async (root) => ({
    head: git(root, 'rev-parse', 'HEAD'), refs: git(root, 'for-each-ref', '--format=%(refname) %(objectname)'),
    status: git(root, 'status', '--porcelain=v1'), index: await readFile(path.join(root, '.git', 'index'))
  });
  const firstBefore = await before(first); const secondBefore = await before(second);
  const approvedRefs = git(parent, '--git-dir', remote, 'show-ref', '--heads');
  const stores = [first, second].map((root) => openGitDraftStore({ root, remote, workspaceId: 'commerce' }));
  return { parent, remote, first, second, stores, before, firstBefore, secondBefore, approvedRefs };
}
const createRequest = (operationId = 'create-one') => ({
  draftId: 'WFD-ABC123', displayName: 'Incomplete service change', expectedHead: null,
  payload: { stages: [{ id: 'implement', skill: null }], unresolved: ['implement.skill'], source: 'not: valid: yaml:' },
  assets: [{ path: '.github/skills/proposed/SKILL.md', content: '# inert skill\nNo command is executed.\n' }, { path: 'binary.dat', content: Buffer.from([0, 255, 10, 42]) }],
  operationId
});
function code(expected) { return (error) => error.code === expected; }

async function terminalDelete({ root, remote, reviewRemote = remote, request, mutateAfterStart = false }) {
  const settings = { root, remote, reviewRemote, request, mutateAfterStart };
  const childCode = `
    import {openGitDraftStore,draftDeletePlan} from ${JSON.stringify(new URL('../src/wca-git-drafts.mjs', import.meta.url).href)};
    import {captureTerminalActionAuthorization} from ${JSON.stringify(new URL('../src/action-authorization.mjs', import.meta.url).href)};
    const settings=${JSON.stringify(settings)};
    try {
      const store=openGitDraftStore({root:settings.root,remote:settings.remote,workspaceId:'commerce'});
      const selected=await store.readRevision({draftId:settings.request.draftId});
      const review=draftDeletePlan({remote:settings.reviewRemote,workspaceId:'commerce',draftId:settings.request.draftId,expectedHead:settings.request.expectedHead,epoch:settings.request.epoch,revisionSha256:selected.record.revisionSha256});
      const grant=await captureTerminalActionAuthorization(settings.root,review.plan,review.action,{label:'Delete draft'});
      const deleting={...settings.request,confirmation:grant.token};
      const pending=store.delete(deleting);
      if(settings.mutateAfterStart) Object.assign(deleting,{draftId:'WFD-MUTATE1',operationId:'mutated-delete',expectedHead:null,epoch:2,confirmation:'mutated-confirmation'});
      const result=await pending;
      console.log('WCA_FIXTURE_RESULT:'+JSON.stringify({ok:true,result}));
    } catch(error) { console.log('WCA_FIXTURE_RESULT:'+JSON.stringify({ok:false,error:{code:error.code,message:error.message}})); }
  `;
  const script = `set timeout 20\nspawn -noecho $env(SF_WCA_DRAFT_TEST_NODE) --input-type=module -e $env(SF_WCA_DRAFT_TEST_CODE)\nexpect {\n -exact {Type Delete draft} { send -- "Delete draft\\r" }\n timeout { exit 124 }\n eof { exit 125 }\n}\nexpect { eof {} timeout { exit 124 } }\nset result [wait]\nexit [lindex $result 3]\n`;
  const observed = await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/expect', ['-c', script], { env: { ...process.env, SF_WCA_DRAFT_TEST_NODE: process.execPath, SF_WCA_DRAFT_TEST_CODE: childCode }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let diagnostics = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Terminal fixture timed out.')); }, 25_000);
    child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { diagnostics += chunk; });
    child.on('error', reject); child.on('close', (status) => { clearTimeout(timeout); resolve({ status, output, diagnostics }); });
  });
  assert.equal(observed.status, 0, `${observed.output}\n${observed.diagnostics}`);
  const captured = `${observed.output}\n${observed.diagnostics}`;
  const result = captured.match(/WCA_FIXTURE_RESULT:(\{[^\r\n]+\})/u);
  assert.ok(result, captured);
  return JSON.parse(result[1]);
}
const TERMINAL_FIXTURE_UNAVAILABLE = process.platform !== 'darwin' || !existsSync('/usr/bin/expect');

test('Git DraftStore cross-machine create/read/history retains exact incomplete payload and inert assets without moving application/config refs or indexes', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.stores[1].list(), { head: null, drafts: [], nextCursor: null });
  const created = await f.stores[0].create(createRequest());
  assert.equal(created.status, 'shared-acknowledged');
  assert.equal(created.record.revision, 1);
  assert.equal(created.operationHead, created.head);
  const read = await f.stores[1].readRevision({ draftId: 'WFD-ABC123' });
  assert.deepEqual(read.payload, createRequest().payload);
  assert.deepEqual(read.assets.map((asset) => [asset.path, asset.content]), createRequest().assets.map((asset) => [asset.path, Buffer.from(asset.content)]));
  assert.equal(read.head, created.head);
  assert.equal((await f.stores[1].history({ draftId: 'WFD-ABC123' })).revisions.length, 1);
  assert.equal((await f.stores[1].list()).drafts[0].draftId, 'WFD-ABC123');
  assert.deepEqual(await f.before(f.first), f.firstBefore);
  assert.deepEqual(await f.before(f.second), f.secondBefore);
  const refs = git(f.parent, '--git-dir', f.remote, 'show-ref', '--heads').split('\n');
  assert.deepEqual(refs.filter((line) => !line.endsWith(' refs/heads/sflow/drafts/commerce')).join('\n'), f.approvedRefs);
  const tree = git(f.parent, '--git-dir', f.remote, 'ls-tree', '-r', '--name-only', created.head).split('\n');
  assert.ok(tree.every((file) => file === 'state.json' || /^assets\/[a-f0-9]{64}$/u.test(file)));
  assert.equal(f.stores[0].capability.authorization, 'native-provider-repository-acl');
  assert.equal(f.stores[0].capability.activation, false);
});

test('Git DraftStore independent clients race the actual remote lease: exactly one save wins and loser is not implicitly merged', async (t) => {
  const f = await fixture(t);
  const created = await f.stores[0].create(createRequest());
  const requests = ['client-one', 'client-two'].map((operationId) => ({ draftId: 'WFD-ABC123', expectedHead: created.head, epoch: 1, operationId, patch: { payload: { chosenBy: operationId, unresolved: ['reviewer'] } } }));
  const results = await Promise.allSettled(f.stores.map((store, index) => store.appendRevision(requests[index])));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const failure = results.find((result) => result.status === 'rejected').reason;
  assert.equal(failure.code, 'WCA_DRAFT_CONFLICT');
  const current = await f.stores[1].readRevision({ draftId: 'WFD-ABC123' });
  assert.equal(current.record.revision, 2);
  const winner = results.findIndex((result) => result.status === 'fulfilled');
  assert.deepEqual(current.payload, requests[winner].patch.payload);
  assert.equal((await f.stores[0].history({ draftId: 'WFD-ABC123' })).revisions.length, 2);
});

test('Git DraftStore create-only CAS prevents two independent clients acquiring an absent draft namespace', async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled(f.stores.map((store, index) => store.create(createRequest(`create-${index}`))));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'WCA_DRAFT_CONFLICT');
  assert.equal((await f.stores[0].list()).drafts.length, 1);
});

test('Git DraftStore lost acknowledgement resolves exact operation and refuses changed request reuse across another machine', async (t) => {
  const f = await fixture(t);
  const uncertain = openGitDraftStore({ root: f.first, remote: f.remote, workspaceId: 'commerce', fault(stage) { if (stage === 'after-cas-before-ack') throw new Error('acknowledgement lost'); } });
  const request = createRequest('lost-ack-create');
  await assert.rejects(uncertain.create(request), /acknowledgement lost/u);
  const status = await f.stores[1].operationStatus({ operationId: request.operationId });
  assert.equal(status.status, 'shared-acknowledged');
  const retry = await f.stores[1].create(request);
  assert.equal(retry.operationHead, status.operationHead);
  assert.equal(retry.record.revisionSha256, status.record.revisionSha256);
  assert.equal((await f.stores[1].history({ draftId: request.draftId })).revisions.length, 1);
  await assert.rejects(f.stores[1].create({ ...request, displayName: 'changed request' }), code('WCA_OPERATION_ID_REUSED'));
  const saved = await f.stores[0].appendRevision({ draftId: request.draftId, expectedHead: status.head, epoch: 1, operationId: 'next-save', patch: { displayName: 'Next checkpoint' } });
  const later = await f.stores[1].operationStatus({ operationId: request.operationId });
  assert.equal(later.head, saved.head);
  assert.equal(later.operationHead, status.head);
  assert.equal((await f.stores[1].create(request)).operationHead, status.head);
});

test('Git DraftStore terminal-reviewed deletion is idempotent, excludes live list and fences stale autosaves and create retries', { skip: TERMINAL_FIXTURE_UNAVAILABLE }, async (t) => {
  const f = await fixture(t);
  const create = createRequest(); const created = await f.stores[0].create(create);
  const request = { draftId: create.draftId, expectedHead: created.head, epoch: 1, operationId: 'delete-one' };
  await assert.rejects(f.stores[1].delete({ ...request, confirmation: true }), code('WCA_NEEDS_HUMAN_INPUT'));
  const review = draftDeletePlan({ remote: f.remote, workspaceId: 'commerce', ...request, revisionSha256: created.record.revisionSha256 });
  const authorization = await issueActionAuthorization(f.second, review.plan, review.action, { confirmation: review.action.actionId });
  await assert.rejects(f.stores[1].delete({ ...request, confirmation: authorization.token }), code('ACTION_TERMINAL_PRESENTATION_REQUIRED'));
  const captured = await terminalDelete({ root: f.second, remote: f.remote, request });
  assert.equal(captured.ok, true, JSON.stringify(captured));
  const deleted = captured.result;
  assert.equal(deleted.tombstone.lifecycleEpoch, 2);
  assert.equal((await f.stores[0].list()).drafts.length, 0);
  const retry = await f.stores[0].delete(request);
  assert.equal(retry.operationHead, deleted.head);
  await assert.rejects(f.stores[0].appendRevision({ draftId: create.draftId, expectedHead: created.head, epoch: 1, operationId: 'late-save', patch: { payload: { late: true } } }), code('WCA_DRAFT_DELETED'));
  await assert.rejects(f.stores[0].create(create), code('WCA_DRAFT_DELETED'));
  await assert.rejects(f.stores[0].readRevision({ draftId: create.draftId }), code('WCA_DRAFT_DELETED'));
  assert.deepEqual((await f.stores[0].readRevision({ draftId: create.draftId, revision: 1 })).payload, create.payload);
  assert.deepEqual(await f.before(f.first), f.firstBefore);
  // Local action authorizations live outside the contributor index; no shared consent is retained.
  assert.deepEqual(await f.before(f.second), f.secondBefore);
});

test('Git DraftStore stale exact delete review and arbitrary/model confirmation never create a tombstone', async (t) => {
  const f = await fixture(t); const created = await f.stores[0].create(createRequest());
  const review = draftDeletePlan({ remote: f.remote, workspaceId: 'commerce', draftId: 'WFD-ABC123', expectedHead: created.head, epoch: 1, revisionSha256: created.record.revisionSha256 });
  const authorization = await issueActionAuthorization(f.first, review.plan, review.action, { confirmation: review.action.actionId });
  await f.stores[1].appendRevision({ draftId: 'WFD-ABC123', expectedHead: created.head, epoch: 1, operationId: 'advance-before-delete', patch: { displayName: 'New review required' } });
  await assert.rejects(f.stores[0].delete({ draftId: 'WFD-ABC123', expectedHead: created.head, epoch: 1, operationId: 'stale-delete', confirmation: authorization.token }), code('WCA_DRAFT_CONFLICT'));
  assert.equal((await f.stores[1].list()).drafts.length, 1);
});

test('Git DraftStore retains semantic no-op without another content revision, supports bounded paging, and blocks unsafe storage before writes', async (t) => {
  const f = await fixture(t); const created = await f.stores[0].create(createRequest());
  const noop = await f.stores[0].appendRevision({ draftId: 'WFD-ABC123', expectedHead: created.head, epoch: 1, operationId: 'no-op', patch: {} });
  assert.equal(noop.record.revisionSha256, created.record.revisionSha256);
  assert.equal((await f.stores[1].history({ draftId: 'WFD-ABC123' })).revisions.length, 1);
  const unsafe = 'gh' + 'p_' + 'Z'.repeat(36);
  await assert.rejects(f.stores[0].appendRevision({ draftId: 'WFD-ABC123', expectedHead: noop.head, epoch: 1, operationId: 'secret-name', patch: { displayName: unsafe } }), code('WCA_DRAFT_CONTENT_BLOCKED'));
  await assert.rejects(f.stores[0].appendRevision({ draftId: 'WFD-ABC123', expectedHead: noop.head, epoch: 1, operationId: 'secret-path', patch: { assets: [{ path: `skills/${unsafe}/SKILL.md`, content: '# safe content' }] } }), code('WCA_DRAFT_CONTENT_BLOCKED'));
  await assert.rejects(f.stores[0].appendRevision({ draftId: 'WFD-ABC123', expectedHead: noop.head, epoch: 1, operationId: unsafe, patch: {} }), code('WCA_DRAFT_CONTENT_BLOCKED'));
  await assert.rejects(f.stores[0].appendRevision({ draftId: 'WFD-ABC123', expectedHead: noop.head, epoch: 1, operationId: 'secret-save', patch: { payload: { source: unsafe } } }), code('WCA_DRAFT_CONTENT_BLOCKED'));
  await assert.rejects(f.stores[0].appendRevision({ draftId: 'WFD-ABC123', expectedHead: noop.head, epoch: 1, operationId: 'token-save', patch: { payload: { confirmationToken: 'opaque-token' } } }), code('WCA_DRAFT_CONTENT_BLOCKED'));
  await assert.rejects(f.stores[0].appendRevision({ draftId: 'WFD-ABC123', expectedHead: noop.head, epoch: 1, operationId: 'huge-save', patch: { payload: { source: 'x'.repeat(WCA_GIT_DRAFT_LIMITS.payloadBytes) } } }), code('WCA_DRAFT_LIMIT'));
  await assert.rejects(f.stores[0].list({ limit: 65 }), code('WCA_DRAFT_INVALID'));
  assert.equal((await f.stores[0].operationStatus({ operationId: 'secret-save' })).status, 'not-found');
  assert.equal((await f.stores[0].list()).head, noop.head);
});

test('Git DraftStore supports the actual SHA-256 authority repository object format without rewriting stored draft identity', async (t) => {
  const f = await fixture(t, { format: 'sha256' });
  const created = await f.stores[0].create(createRequest());
  assert.match(created.head, /^[a-f0-9]{64}$/u);
  const read = await f.stores[1].readRevision({ draftId: 'WFD-ABC123' });
  assert.equal(read.record.revisionSha256, created.record.revisionSha256);
  assert.deepEqual(read.assets.at(-1).content, Buffer.from([0, 255, 10, 42]));
});

test('Git DraftStore ambient Git selectors, replacement refs and hook paths cannot redirect draft objects or alter a contributor repository', async (t) => {
  const f = await fixture(t);
  const ambient = { GIT_DIR: path.join(f.first, '.git'), GIT_INDEX_FILE: path.join(f.first, '.git', 'index'), GIT_NAMESPACE: 'malicious-caller', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: path.join(f.first, '.git', 'hooks') };
  const prior = Object.fromEntries(Object.keys(ambient).map((key) => [key, process.env[key]]));
  Object.assign(process.env, ambient);
  try {
    const created = await f.stores[1].create(createRequest('ambient-safe-create'));
    assert.equal(created.record.revision, 1);
    assert.equal((await f.stores[0].list()).head, created.head);
  } finally {
    for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
  assert.deepEqual(await f.before(f.first), f.firstBefore);
  assert.deepEqual(await f.before(f.second), f.secondBefore);
});

test('Git DraftStore malformed source and names remain inert, while unknown mutation fields and portable path collisions refuse without another acknowledgement', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.stores[0].create({ ...createRequest(), actor: { admin: true } }), code('WCA_DRAFT_INVALID'));
  for (const [key, value] of [['draftId', new String('WFD-ABC123')], ['operationId', new String('boxed-operation')], ['expectedHead', new String('a'.repeat(40))]]) {
    await assert.rejects(f.stores[0].create({ ...createRequest(), [key]: value }), code('WCA_DRAFT_INVALID'));
  }
  await assert.rejects(f.stores[0].create(Object.assign(Object.create({}), createRequest())), code('WCA_DRAFT_INVALID'));
  assert.throws(() => openGitDraftStore({ root: f.first, remote: f.remote, workspaceId: new String('commerce') }), code('WCA_DRAFT_INVALID'));
  await assert.rejects(f.stores[0].create({ ...createRequest(), assets: [{ path: 'Skill.md', content: 'a' }, { path: 'skill.md', content: 'b' }] }), code('WCA_DRAFT_INVALID'));
  await assert.rejects(f.stores[0].create({ ...createRequest(), payload: { text: '\ud800' } }), code('WCA_DRAFT_INVALID'));
  assert.equal((await f.stores[0].list()).head, null);
});

test('existing Git object owner writes literal isolated bytes and refuses approved ref publication or contributor-object writes', async (t) => {
  const f = await fixture(t);
  await assert.rejects(writeExactGitObjectCommit(f.first, { parentCommit: null, files: new Map([['state.json', Buffer.from('{}')]]), commitIdentity: resolveGitCommitIdentity(f.first), message: 'not permitted in contributor objects' }), /live isolated repository/u);
  await withIsolatedGitObjectRepository({ remote: f.remote, expectedCommit: null, objectFormat: 'sha1' }, async (scratch) => {
    const bytes = Buffer.from([0, 255, 13, 10, 42]);
    const commit = await writeExactGitObjectCommit(scratch, { parentCommit: null, files: new Map([['assets/literal', bytes], ['state.json', Buffer.from('{}\n')]]), commitIdentity: resolveGitCommitIdentity(f.first), message: 'literal inert fixture' });
    assert.deepEqual(exactFileAtObject(scratch, commit, 'assets/literal'), bytes);
    await assert.rejects(pushIsolatedGitDraftCommit(scratch, { remote: f.remote, commit, branch: 'sflow/config', expectedRemoteSha: null }), /cannot target application or approved-configuration refs/u);
  });
  assert.deepEqual(await f.before(f.first), f.firstBefore);
  assert.deepEqual(git(f.parent, '--git-dir', f.remote, 'show-ref', '--heads'), f.approvedRefs);
});

test('Git DraftStore anchors relative filesystem authority before observation and isolated CAS, leaving a second bare repository untouched', async (t) => {
  const f = await fixture(t);
  // This exact basename would previously resolve to the decoy after switching to a /tmp scratch
  // cwd. Both targets are uniquely owned test directories; no pre-existing /tmp path is touched.
  const decoy = await mkdtemp(path.join(os.tmpdir(), 'sflow-wca-drift-decoy-'));
  t.after(() => rm(decoy, { recursive: true, force: true }));
  git(f.parent, 'init', '--bare', decoy);
  const intended = path.join(f.parent, path.basename(decoy));
  git(f.parent, 'clone', '--bare', f.remote, intended);
  const relative = openGitDraftStore({ root: f.first, remote: `../${path.basename(decoy)}`, workspaceId: 'commerce' });
  const created = await relative.create(createRequest('relative-create'));
  const independent = openGitDraftStore({ root: f.second, remote: intended, workspaceId: 'commerce' });
  assert.equal((await independent.list()).head, created.head);
  const state = git(f.parent, '--git-dir', intended, 'rev-parse', 'refs/heads/sflow/drafts/commerce');
  assert.equal(state, created.head);
  assert.equal(git(f.parent, '--git-dir', decoy, 'for-each-ref', '--format=%(refname)'), '');
  await assert.rejects(withIsolatedGitObjectRepository({ remote: `../${path.basename(decoy)}`, expectedCommit: null }, async () => null), /already anchored/u);
});

test('Git DraftStore terminal delete confirmation cannot cross to a second repository cloned at the same draft head', { skip: TERMINAL_FIXTURE_UNAVAILABLE }, async (t) => {
  const f = await fixture(t); const created = await f.stores[0].create(createRequest());
  const secondRemote = path.join(f.parent, 'second-authority.git');
  git(f.parent, 'clone', '--bare', f.remote, secondRemote);
  const otherStore = openGitDraftStore({ root: f.first, remote: secondRemote, workspaceId: 'commerce' });
  const crossed = await terminalDelete({ root: f.first, remote: secondRemote, reviewRemote: f.remote, request: { draftId: 'WFD-ABC123', expectedHead: created.head, epoch: 1, operationId: 'wrong-destination-delete' } });
  assert.equal(crossed.ok, false, JSON.stringify(crossed));
  assert.match(crossed.error.message, /(?:bound|presentation|review|plan)/iu);
  assert.equal((await otherStore.list()).drafts.length, 1);
  assert.equal((await f.stores[1].list()).drafts.length, 1);
});

test('Git DraftStore rejects public issuer tokens and model-constructed local JSON receipts without a directly presented terminal action', async (t) => {
  const f = await fixture(t); const created = await f.stores[0].create(createRequest());
  const review = draftDeletePlan({ remote: f.remote, workspaceId: 'commerce', draftId: 'WFD-ABC123', expectedHead: created.head, epoch: 1, revisionSha256: created.record.revisionSha256 });
  const request = { draftId: 'WFD-ABC123', expectedHead: created.head, epoch: 1, operationId: 'forged-consent-delete' };
  const legacy = await issueActionAuthorization(f.first, review.plan, review.action, { confirmation: review.action.actionId, channel: 'terminal' });
  await assert.rejects(f.stores[0].delete({ ...request, confirmation: legacy.token }), code('ACTION_TERMINAL_PRESENTATION_REQUIRED'));
  const token = randomUUID(); const authorizationId = randomUUID(); const createdAt = new Date().toISOString();
  const forged = {
    schemaVersion: currentSchemaVersion('action-authorization'), kind: 'governed-action-authorization', token, authorizationId,
    questionId: recordSha256({ planId: review.plan.planId, actionId: review.action.actionId, channel: 'terminal' }).slice(0, 24),
    answerReceipt: recordSha256({ token, authorizationId, planHash: review.plan.planHash, actionId: review.action.actionId }),
    planId: review.plan.planId, planHash: review.plan.planHash, actionId: review.action.actionId,
    subject: review.plan.subject, revision: review.plan.revision, actor: identity(f.first), channel: 'terminal',
    assurance: 'configured-local-review', createdAt, expiresAt: new Date(Date.parse(createdAt) + 15 * 60 * 1000).toISOString()
  };
  const directory = path.join(f.first, '.git', 'singularity-flow', 'action-authorizations');
  await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, `${token}.json`), canonicalJson(forged));
  await assert.rejects(f.stores[0].delete({ ...request, confirmation: token }), code('ACTION_TERMINAL_PRESENTATION_REQUIRED'));
  assert.equal((await f.stores[1].list()).head, created.head);
  assert.equal((await f.stores[1].list()).drafts.length, 1);
});

test('Git DraftStore approved environment-local exclusions apply to POSIX/Windows aliases before any shared write', async (t) => {
  const f = await fixture(t);
  const declaration = parseEnvironmentDeclaration(Buffer.from(JSON.stringify({ schemaVersion: 1, environments: { qa: { requires: [{ name: 'QA_TOKEN', kind: 'secret' }], localFiles: ['runtime/*.local.json'] } }, checks: {}, neverCommit: ['.env*'] })));
  const store = openGitDraftStore({ root: f.first, remote: f.remote, workspaceId: 'commerce', environmentDeclaration: declaration });
  for (const assetPath of ['.env', '.ENV.local.', 'runtime/qa.local.json', 'RUNTIME/QA.LOCAL.JSON.', '/tmp/.env', 'C:\\private\\qa.local.json']) {
    await assert.rejects(store.create({ ...createRequest('environment-path'), assets: [{ path: assetPath, content: 'names-only but not shareable' }] }), (error) => ['WCA_DRAFT_CONTENT_BLOCKED', 'WCA_DRAFT_INVALID'].includes(error.code));
  }
  assert.equal((await store.list()).head, null);
});

test('Git DraftStore refuses tampered missing and unclaimed retained blobs before acknowledging another write', async (t) => {
  const f = await fixture(t); const created = await f.stores[0].create(createRequest());
  const tampered = await withIsolatedGitObjectRepository({ remote: f.remote, expectedCommit: created.head }, async (scratch) => {
    const files = new Map(exactTreePathsAtObject(scratch, created.head).map((file) => [file, exactFileAtObject(scratch, created.head, file, { maximumBytes: 32 * 1024 * 1024 })]));
    const unclaimed = Buffer.from('unclaimed inert bytes');
    files.set(`assets/${createHash('sha256').update(unclaimed).digest('hex')}`, unclaimed);
    const commit = await writeExactGitObjectCommit(scratch, { parentCommit: created.head, files, commitIdentity: resolveGitCommitIdentity(f.first), message: 'malformed test closure' });
    assert.equal((await pushIsolatedGitDraftCommit(scratch, { remote: f.remote, commit, branch: 'sflow/drafts/commerce', expectedRemoteSha: created.head })).status, 0);
    return commit;
  });
  await assert.rejects(f.stores[1].list(), /unclaimed bytes/u);
  await assert.rejects(f.stores[1].appendRevision({ draftId: 'WFD-ABC123', expectedHead: tampered, epoch: 1, operationId: 'unsafe-closure-save', patch: { displayName: 'Must not acknowledge this' } }), /unclaimed bytes/u);
  assert.equal(git(f.parent, '--git-dir', f.remote, 'rev-parse', 'refs/heads/sflow/drafts/commerce'), tampered);
  const missing = await withIsolatedGitObjectRepository({ remote: f.remote, expectedCommit: tampered }, async (scratch) => {
    const files = new Map(exactTreePathsAtObject(scratch, tampered).filter((file) => file !== `assets/${created.record.content.payloadSha256.slice(7)}`).map((file) => [file, exactFileAtObject(scratch, tampered, file, { maximumBytes: 32 * 1024 * 1024 })]));
    const commit = await writeExactGitObjectCommit(scratch, { parentCommit: tampered, files, commitIdentity: resolveGitCommitIdentity(f.first), message: 'missing test payload closure' });
    assert.equal((await pushIsolatedGitDraftCommit(scratch, { remote: f.remote, commit, branch: 'sflow/drafts/commerce', expectedRemoteSha: tampered })).status, 0);
    return commit;
  });
  await assert.rejects(f.stores[1].readRevision({ draftId: 'WFD-ABC123' }), code('WCA_DRAFT_ASSET_MISSING'));
  assert.equal(git(f.parent, '--git-dir', f.remote, 'rev-parse', 'refs/heads/sflow/drafts/commerce'), missing);
});

test('Git DraftStore snapshots create/save request identity, operation, epoch, payload and asset bytes before remote awaits', async (t) => {
  const f = await fixture(t);
  const original = { draftId: 'WFD-ORIGIN1', displayName: 'Original draft', expectedHead: null, payload: { source: 'original' }, assets: [{ path: 'source.txt', content: Buffer.from('original asset') }], operationId: 'capture-one' };
  const input = { ...original, payload: { ...original.payload }, assets: [{ path: 'source.txt', content: Buffer.from('original asset') }] };
  const pending = f.stores[0].create(input);
  input.draftId = 'WFD-MUTATE1'; input.operationId = 'mutated-operation'; input.expectedHead = 'b'.repeat(40);
  input.displayName = 'Mutated display'; input.payload.source = 'mutated source'; input.assets[0].path = 'mutated.txt'; input.assets[0].content.fill(0x78);
  const created = await pending;
  assert.equal(created.record.draftId, original.draftId);
  assert.equal(created.operationId, original.operationId);
  assert.equal(created.record.displayName, original.displayName);
  const read = await f.stores[1].readRevision({ draftId: original.draftId });
  assert.deepEqual(read.payload, original.payload);
  assert.deepEqual(read.assets, original.assets);
  await assert.rejects(f.stores[1].readRevision({ draftId: 'WFD-MUTATE1' }), code('WCA_DRAFT_NOT_FOUND'));
  assert.equal((await f.stores[1].operationStatus({ operationId: 'mutated-operation' })).status, 'not-found');
  const replay = await f.stores[1].create(original);
  assert.equal(replay.replayed, true); assert.equal(replay.record.draftId, original.draftId);
  const save = { draftId: original.draftId, expectedHead: created.head, epoch: 1, operationId: 'capture-save', patch: { displayName: 'Saved original', payload: { source: 'saved original' }, assets: [{ path: 'saved.txt', content: Buffer.from('saved bytes') }] } };
  const saveReplay = { ...save, patch: { displayName: 'Saved original', payload: { source: 'saved original' }, assets: [{ path: 'saved.txt', content: Buffer.from('saved bytes') }] } };
  const pendingSave = f.stores[0].appendRevision(save);
  save.draftId = 'WFD-MUTATE1'; save.operationId = 'mutated-save'; save.epoch = 2; save.expectedHead = null;
  save.patch.displayName = 'Changed after capture'; save.patch.payload.source = 'changed'; save.patch.assets[0].content.fill(0x79);
  const saved = await pendingSave;
  assert.equal(saved.record.draftId, original.draftId); assert.equal(saved.operationId, 'capture-save');
  assert.equal(saved.record.displayName, 'Saved original'); assert.equal(saved.record.lifecycleEpoch, 1);
  const current = await f.stores[1].readRevision({ draftId: original.draftId });
  assert.deepEqual(current.payload, saveReplay.patch.payload); assert.deepEqual(current.assets, saveReplay.patch.assets);
  assert.equal((await f.stores[1].appendRevision(saveReplay)).record.revisionSha256, saved.record.revisionSha256);
  assert.equal((await f.stores[1].operationStatus({ operationId: 'mutated-save' })).status, 'not-found');
});

test('Git DraftStore snapshots deletion identity and live terminal confirmation before remote awaits', { skip: TERMINAL_FIXTURE_UNAVAILABLE }, async (t) => {
  const f = await fixture(t); const created = await f.stores[0].create(createRequest());
  const request = { draftId: 'WFD-ABC123', expectedHead: created.head, epoch: 1, operationId: 'capture-delete' };
  const captured = await terminalDelete({ root: f.second, remote: f.remote, request, mutateAfterStart: true });
  assert.equal(captured.ok, true, JSON.stringify(captured));
  assert.equal(captured.result.operationId, request.operationId);
  assert.equal(captured.result.tombstone.draftId, request.draftId);
  assert.equal(captured.result.tombstone.operationId, request.operationId);
  assert.equal((await f.stores[0].operationStatus({ operationId: 'mutated-delete' })).status, 'not-found');
  await assert.rejects(f.stores[0].readRevision({ draftId: 'WFD-MUTATE1' }), code('WCA_DRAFT_NOT_FOUND'));
  const retry = await f.stores[0].delete(request);
  assert.equal(retry.replayed, true); assert.equal(retry.operationHead, captured.result.head);
});
