import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { serveAskProvider } from '../src/ask/shared-provider-server.mjs';
import { PROVIDER_ROUTE, repositoryScope, RETENTION_MS } from '../src/ask/shared-contract.mjs';
import { argvAllowed } from '../src/copilot-mutation-guard.mjs';
import { revisionDirectory } from '../src/spec-library/ids.mjs';
import { revisionFiles } from '../src/spec-library/library.mjs';
import { isolatedTestEnvironment } from '../scripts/test-machine-state.mjs';
import { CLI, JOURNEY_IDENTITY, journeyRepository } from './helpers/route-follower.mjs';

const call = promisify(execFile);
const SPEC = 'SPEC-PORTABLE-FIXTURE';
const STORY = 'PORTABLE-STORY';
const STORY_FILE = 'singularity/work-items/' + STORY + '/workflow.json';
const SPEC_CONTENT = '# Current specification\n\nKeep a private receipt. [' + SPEC + ':REQ-001]\n';
const hashToken = token => createHash('sha256').update(token).digest('hex');
const binding = value => ['--conversation=' + value.conversation.id, '--revision=' + value.conversation.revision];
const resume = value => ['--resume', '--conversation=' + value.conversation.id];

const file = async (absolute, value) => {
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
};

async function fixture(t) {
  const repo = await journeyRepository(t);
  const serverFile = path.join(repo.base, 'provider.json');
  const providerStore = path.join(repo.base, 'provider-data');
  const tokenA = randomBytes(32).toString('base64url');
  const tokenB = randomBytes(32).toString('base64url');
  const tokenOther = randomBytes(32).toString('base64url');
  const grant = (token, owner = 'operator') => ({ tokenSha256: hashToken(token), owner, workspace: 'test-workspace', repository: repo.remote });
  let clock = Date.now();
  const grants = [grant(tokenA), grant(tokenB), grant(tokenOther, 'other-operator')];
  const configure = async (authority = grants, port = 0) => file(serverFile, { schemaVersion: 1, name: 'portable-fixture', port, directory: providerStore, grants: authority });
  await configure();
  let service = await serveAskProvider(serverFile, { now: () => clock });
  t.after(() => service.close());
  const endpoint = () => 'http://127.0.0.1:' + service.port;
  async function clientConfiguration(env, token, { workspace = 'test-workspace', provider = 'portable-fixture' } = {}) {
    const grantPath = env.SINGULARITY_FLOW_ASK_PROVIDER_CONFIG + '.token';
    await file(grantPath, token + '\n');
    await file(env.SINGULARITY_FLOW_ASK_PROVIDER_CONFIG, { schemaVersion: 1, bindings: [
      { provider, workspace, endpoint: endpoint(), tokenFile: grantPath, repository: repo.remote }
    ] });
  }
  await clientConfiguration(repo.env, tokenA);
  const rootB = path.join(repo.base, 'second-checkout');
  const envB = isolatedTestEnvironment(path.join(repo.base, 'second-device'), repo.env);
  const execute = (root, env) => async (command, ...args) => {
    const result = await call(process.execPath, [CLI, ...command, ...args, '--for-person', '--no-model', '--json'],
      { cwd: root, env, encoding: 'utf8', timeout: 40_000, maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(result.stdout);
  };
  const commandA = execute(repo.root, repo.env);
  const commandB = execute(rootB, envB);
  return { repo, rootB, envB, providerStore, serverFile, configure, grants, advanceClock: () => { clock += RETENTION_MS + 1; },
    restart: async () => { const port = service.port; await service.close(); await configure(grants, port); service = await serveAskProvider(serverFile, { now: () => clock }); },
    connectB: async () => { repo.must('git', ['clone', '-q', repo.remote, rootB], { cwd: repo.base }); await clientConfiguration(envB, tokenB); },
    configureB: (options, bearer = tokenB) => clientConfiguration(envB, bearer, options),
    useOtherOwner: () => clientConfiguration(envB, tokenOther),
    gitB: (...args) => repo.must('git', args, { cwd: rootB, environment: envB }).trim(),
    async providerRequest(operation, fields) {
      return fetch(endpoint() + PROVIDER_ROUTE, { method: 'POST', headers: {
        'content-type': 'application/json', authorization: 'Bearer ' + tokenB
      }, body: JSON.stringify({ operation, provider: 'portable-fixture', workspace: 'test-workspace',
        repository: repositoryScope(repo.remote), ...fields }) });
    },
    commandA, commandB, askA: (...args) => commandA(['ask'], ...args), askB: (...args) => commandB(['ask'], ...args) };
}

async function publish(repo) {
  repo.git('switch', '-qc', 'state');
  const revision = revisionFiles({ specId: SPEC, revision: 1, reviewState: 'reviewed', operationId: 'portable-fixture',
    actor: JOURNEY_IDENTITY, recordedAt: '2026-11-05T10:15:00Z',
    head: { sequence: 1, snapshotSha256: 'sha256:' + 'a'.repeat(64), draft: {
      title: 'Reviewed portable specification', kind: 'business', spec: SPEC_CONTENT, gaps: [], research: []
    } }, report: { counts: { d: 0, a: 0, h: 0 }, blocking: [] } });
  for (const [name, bytes] of Object.entries(revision.files)) await repo.write(revisionDirectory(SPEC, 1) + '/' + name, bytes);
  repo.git('add', '-A');
  repo.git('commit', '-qm', 'Publish a specification for both checkouts');
  repo.git('push', '-q', '-u', 'origin', 'state');
  const commit = repo.git('rev-parse', 'HEAD');
  repo.git('switch', '-q', 'main');
  return { revision: SPEC + '@1', stateCommit: commit, manifestSha256: revision.manifestSha256 ??
    'sha256:' + createHash('sha256').update(revision.files['manifest.json']).digest('hex') };
}

function story(title, status, specification) {
  return JSON.stringify({ schemaVersion: 1, status, currentPhase: 'intake', phaseOrder: ['intake'],
    phases: { intake: { id: 'intake', status: 'in_progress', generation: 0 } },
    workItem: { id: STORY, title, branch: 'main', source: { specification: [specification] } } });
}

async function providerFiles(root) {
  const names = await readdir(root, { recursive: true });
  return names.filter(name => name.endsWith('.json')).map(name => path.join(root, name));
}

test('R5 reopens only authorized evidence, preserves result order and issues checkout-bound handles', { timeout: 60_000 }, async t => {
  const { repo, askA, askB, connectB, useOtherOwner, configureB, configure, grants, providerStore, gitB } = await fixture(t);
  const pin = await publish(repo);
  await repo.write(STORY_FILE, story('Published title', 'in_progress', pin));
  repo.git('add', STORY_FILE);
  repo.git('commit', '-qm', 'Retain the published work record');
  repo.git('push', '-q', 'origin', 'main');
  await connectB();

  const publicWork = await askA('story ' + STORY, '--remember', '--portable');
  assert.equal(publicWork.work?.title, 'Published title', JSON.stringify(publicWork));
  await repo.write(STORY_FILE, story('MACHINE_LOCAL_TITLE_CANARY', 'in_progress', pin));
  const saved = await askA('spec used for story ' + STORY, '--remember', '--portable');
  assert.equal(saved.conversation?.portability, 'shared-provider', JSON.stringify(saved));
  assert.equal(saved.savedResults[0].title, 'MACHINE_LOCAL_TITLE_CANARY');
  assert.equal(saved.savedResults[1].title, 'Reviewed portable specification');
  const local = await askA('--evidence=' + saved.links[0], ...binding(saved));
  assert.equal(local.evidence?.title, 'MACHINE_LOCAL_TITLE_CANARY', JSON.stringify(local));
  const remote = await askB(...resume(saved));
  assert.deepEqual(remote.savedResults.map(row => row.availability), ['local-only', 'available']);
  assert.equal(remote.links[0], remote.conversation.selectedId);
  assert.notEqual(remote.links[0], local.conversation.selectedId);
  assert.equal(remote.conversation.revision, local.conversation.revision);
  assert.equal(remote.savedResults[1].title, saved.savedResults[1].title);
  assert.doesNotMatch(JSON.stringify(remote), /MACHINE_LOCAL_TITLE_CANARY/);
  const deniedHandle = await askB('--evidence=' + local.conversation.selectedId, ...binding(remote));
  assert.equal(deniedHandle.diagnostics[0].code, 'ASK_SELECTION_UNAVAILABLE');
  const localOnly = await askB('--evidence=' + remote.links[0], ...binding(remote));
  assert.equal(localOnly.diagnostics[0].code, 'ASK_EVIDENCE_LOCAL_ONLY');
  const spec = await askB('--evidence=' + remote.links[1], ...binding(remote));
  assert.equal(spec.evidence.revision, pin.stateCommit);
  assert.equal(spec.evidence.content, SPEC_CONTENT);

  const bytes = (await Promise.all((await providerFiles(providerStore)).map(name => readFile(name, 'utf8')))).join('\n');
  assert.doesNotMatch(bytes, /MACHINE_LOCAL_TITLE_CANARY|Keep a private receipt|askp1\.|spec used for story/);
  assert.ok(!bytes.includes(repo.root));
  const providerRecord = (await Promise.all((await providerFiles(providerStore)).map(name => readFile(name, 'utf8').then(JSON.parse))))
    .find(item => item.id === saved.conversation.id);
  assert.deepEqual(providerRecord.result.refs[0].ref, { kind: 'local' });
  assert.ok(!bytes.includes(saved.links[0]));

  await useOtherOwner();
  const other = await askB(...resume(saved));
  assert.equal(other.diagnostics[0].code, 'ASK_CONVERSATION_UNAVAILABLE');
  await configureB({ workspace: 'wrong-workspace' });
  assert.equal((await askB(...resume(saved))).diagnostics[0].code, 'ASK_PROVIDER_ACCESS_DENIED');
  await configureB({});
  await configure([grants[0], grants[2]]);
  assert.equal((await askB(...resume(saved))).diagnostics[0].code, 'ASK_PROVIDER_ACCESS_DENIED');
  await configure(grants);
  gitB('remote', 'set-url', 'origin', path.join(repo.base, 'different-repository.git'));
  assert.equal((await askB(...resume(saved))).diagnostics[0].code, 'ASK_PROVIDER_NOT_CONFIGURED');
  gitB('remote', 'set-url', 'origin', repo.remote);

  await repo.write(STORY_FILE, story('Updated published title', 'completed', pin));
  repo.git('add', STORY_FILE);
  repo.git('commit', '-qm', 'Update the work owner with a current state');
  repo.git('push', '-q', 'origin', 'main');
  const updated = await askB(...resume(publicWork));
  assert.equal(updated.work.title, 'Updated published title');
  assert.equal(updated.work.workStatus, 'completed');
  const original = await askB('--evidence=' + updated.links[0], ...binding(updated));
  assert.equal(original.evidence.title, 'Published title');
  const statusNow = await askB('what is its status now', ...binding(original));
  assert.equal(statusNow.work.workStatus, 'completed', JSON.stringify(statusNow));

  repo.git('switch', '-q', 'state');
  repo.git('rm', '-rq', revisionDirectory(SPEC, 1));
  repo.git('commit', '-qm', 'Withdraw the exact revision');
  repo.git('push', '-q', 'origin', 'state');
  repo.git('switch', '-q', 'main');
  const withdrawn = await askB(...resume(saved));
  assert.deepEqual(withdrawn.savedResults.map(row => row.availability), ['local-only', 'unavailable']);
  assert.doesNotMatch(JSON.stringify(withdrawn), /Reviewed portable specification|Keep a private receipt/);
  assert.equal((await askB('--evidence=' + withdrawn.links[1], ...binding(withdrawn))).status, 'unavailable');
});

test('R5 accepts one competing selection, survives provider restarts and enforces forget and retention', { timeout: 70_000 }, async t => {
  const { repo, askA, askB, connectB, advanceClock, providerStore, restart } = await fixture(t);
  for (const subject of ['Published alpha', 'Published beta', 'Published gamma']) {
    repo.git('commit', '--allow-empty', '-qm', subject);
  }
  repo.git('push', '-q', 'origin', 'main');
  const persistent = await askA('commits from 2000-01-01 to 2099-12-31 on main', '--portable', '--remember');
  assert.ok(persistent.history?.rows.length >= 3, JSON.stringify(persistent));
  await connectB();
  const copy = await askB('--resume', '--portable');
  assert.equal(copy.conversation.id, persistent.conversation.id);
  assert.deepEqual(copy.history.rows.map(row => row.commit), persistent.history.rows.map(row => row.commit));
  assert.notDeepEqual(copy.links, persistent.links);

  const replies = await Promise.all([
    askA('--select=' + persistent.links[0], ...binding(persistent)),
    askB('--select=' + copy.links[1], ...binding(copy))
  ]);
  const winner = replies.find(result => result.status === 'resolved');
  const conflict = replies.find(result => result.status === 'conflict');
  assert.equal(winner?.conversation.revision, 2, JSON.stringify(replies));
  assert.deepEqual(conflict?.currentConversation, { conversationId: copy.conversation.id, contextRevision: 2 });
  await restart();
  const resumed = await askB(...resume(copy));
  assert.equal(resumed.conversation.selectedId, resumed.links[persistent.history.rows.findIndex(row => row.commit === winner.evidence.revision)]);
  assert.equal((await askB('--forget', ...binding(copy))).status, 'conflict');
  assert.equal((await askB('--forget', ...binding(resumed))).kind, 'forgotten');
  assert.equal((await askA(...resume(persistent))).status, 'unavailable');
  assert.equal((await providerFiles(providerStore)).length, 0);

  const expiring = await askA('commits from 2000-01-01 to 2099-12-31 on main', '--portable', '--remember');
  advanceClock();
  assert.equal((await askB(...resume(expiring))).status, 'unavailable');
  await restart();
  assert.equal((await askA(...resume(expiring))).status, 'unavailable');
  assert.equal((await providerFiles(providerStore)).length, 0);
  assert.ok(repo.git('ls-remote', 'origin', 'refs/heads/main'));
});

test('R5 preserves the one task admission and reopens a published Story on the second device', { timeout: 90_000 }, async t => {
  const { repo, askA, askB, commandA, commandB, connectB, providerStore, providerRequest } = await fixture(t);
  await publish(repo);
  const selected = await askA(SPEC, '--portable', '--remember');
  assert.equal(selected.specifications[0].reference, SPEC + '@1');
  await connectB();
  const second = await askB(...resume(selected));
  const prepare = show => [...binding(show), '--request=fix receipt retention', '--kind=fix', '--clause=' + SPEC + ':REQ-001'];
  const handoff = ['work', 'handoff'];
  const races = await Promise.allSettled([commandA(handoff, ...prepare(selected)), commandB(handoff, ...prepare(second))]);
  const winner = races.findIndex(item => item.status === 'fulfilled');
  const loser = races.findIndex(item => item.status === 'rejected');
  assert.notEqual(winner, -1, JSON.stringify(races));
  assert.notEqual(loser, -1, JSON.stringify(races));
  assert.match(races[loser].reason.stdout, /ASK_CONVERSATION_CONFLICT/u);
  const plan = races[winner].value;
  const [owner, other] = winner === 0 ? [commandA, commandB] : [commandB, commandA];
  const [askOwner, askOther] = winner === 0 ? [askA, askB] : [askB, askA];

  const localOnly = await askOther(...resume(selected));
  assert.equal(localOnly.conversation.taskAvailability, 'local-only');
  assert.ok(localOnly.diagnostics.some(entry => entry.code === 'ASK_TASK_LOCAL_ONLY'));
  assert.doesNotMatch(JSON.stringify(localOnly), new RegExp(plan.id));
  const raw = await providerRequest('read', { id: localOnly.conversation.id, expected: localOnly.conversation.revision });
  assert.equal(raw.status, 200);
  const { result, selected: selectedRef, reads, explanationUsed } = (await raw.json()).value;
  const reset = await providerRequest('update', { id: localOnly.conversation.id, expected: localOnly.conversation.revision,
    context: { result, selected: selectedRef, reads, explanationUsed } });
  assert.equal(reset.status, 409);
  assert.equal((await reset.json()).error.code, 'ASK_TASK_BINDING_CONFLICT');
  await assert.rejects(other(handoff, ...prepare(localOnly)), error => /ASK_TASK_LOCAL_ONLY/u.test(error.stdout));
  assert.equal(repo.git('ls-remote', '--heads', 'origin', 'TASK-*'), '');
  const started = await owner(handoff, plan.id, '--start');
  assert.equal(started.status, 'accepted', JSON.stringify(started));
  assert.equal(started.sharedTask, 'published', JSON.stringify(started));
  assert.equal((await owner(handoff, plan.id, '--start')).workId, started.workId);
  assert.equal(repo.git('ls-remote', '--heads', 'origin', 'TASK-*').split('\n').length, 1);

  const remoteStatus = await askOther(...resume(selected));
  assert.equal(remoteStatus.task.workId, started.workId, JSON.stringify(remoteStatus));
  assert.equal(remoteStatus.conversation.taskAvailability, 'published');
  assert.equal(remoteStatus.task.id, undefined);
  const bytes = (await Promise.all((await providerFiles(providerStore)).map(file => readFile(file, 'utf8')))).join('\n');
  assert.ok(!bytes.includes(plan.id));
  assert.ok(!bytes.includes('fix receipt retention'));
  assert.equal((await askOther('--forget', ...binding(remoteStatus))).kind, 'forgotten');
  assert.equal((await askOwner(...resume(selected))).status, 'unavailable');
  assert.equal((await owner(handoff, plan.id)).status, 'accepted');
});

test('R5 browser opts in and presents unavailable local evidence in order on the second device', { timeout: 65_000 }, async t => {
  const { repo, rootB, envB, connectB } = await fixture(t);
  await connectB();
  const pin = await publish(repo);
  await repo.write(STORY_FILE, story('UNPUBLISHED_BROWSER_TITLE', 'in_progress', pin));
  const [{ chromium }, { startService }, { control }] = await Promise.all([
    import('playwright-core'), import('../src/local-ui/server.mjs'), import('../src/local-ui/client.mjs')
  ]);
  const service = await startService({ directory: path.join(repo.base, 'browser') });
  t.after(() => service.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  async function open(root, environment) {
    const launch = await control(service.descriptor, 'bootstrap', { root, clientId: randomBytes(16).toString('hex'), environment });
    const page = await browser.newPage();
    await page.goto(launch.url);
    await page.getByRole('link', { name: 'Ask SFlow', exact: true }).click();
    return page;
  }
  const origin = await open(repo.root, repo.env);
  const save = origin.getByRole('checkbox', { name: 'Save across devices' });
  assert.equal(await save.isChecked(), false);
  await save.check();
  const query = origin.getByRole('searchbox', { name: 'Ask a question' });
  await query.fill('spec used for story ' + STORY);
  await query.press('Enter');
  await origin.getByText('UNPUBLISHED_BROWSER_TITLE', { exact: false }).first().waitFor();
  await origin.close();

  const receiver = await open(rootB, envB);
  await receiver.getByRole('button', { name: 'Resume across devices' }).click();
  const ordered = receiver.locator('.ask-history-rows > li');
  await ordered.first().waitFor();
  assert.match(await ordered.nth(0).textContent(), /Available on the original device/u);
  assert.match(await ordered.nth(1).textContent(), /Reviewed portable specification/u);
  assert.equal(await receiver.getByText('UNPUBLISHED_BROWSER_TITLE', { exact: false }).count(), 0);
  await ordered.nth(1).getByRole('button', { name: 'View evidence' }).click();
  await receiver.getByRole('region', { name: 'Evidence and explanation' }).getByText('Keep a private receipt.', { exact: false }).waitFor();
});

test('R5 provider CLI prints readiness before waiting and is a person-host operation', { timeout: 20_000 }, async t => {
  const { repo, serverFile } = await fixture(t);
  const args = [CLI, 'ask', 'provider', 'serve', '--config=' + serverFile, '--json'];
  assert.equal(argvAllowed(args, 'authoring', {}), false);
  assert.equal(argvAllowed([CLI, 'ask', '--resume', '--portable'], 'authoring', {}), false);
  const child = spawn(process.execPath, args, { cwd: repo.base, env: repo.env, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exited = once(child, 'exit');
  const stdout = createInterface({ input: child.stdout });
  const result = await Promise.race([once(stdout, 'line').then(([line]) => JSON.parse(line)),
    exited.then(([code]) => assert.fail('Provider stopped before ready: ' + code))]);
  assert.equal(result.resultType, 'sflow-ask-provider');
  assert.equal(result.status, 'ready');
  assert.ok(result.port > 0);
  child.kill('SIGTERM');
  assert.deepEqual(await exited, [0, null]);
});
