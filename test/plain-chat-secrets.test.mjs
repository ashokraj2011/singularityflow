/**
 * A plain Copilot chat is refused a file that holds secrets, in a repository that uses SFlow, unless the
 * capability that owns the file says `allow` (docs/SPEC-ENVIRONMENT-FILES-v2.md, "Plain chats").
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';

import { foldCapabilityPolicy, validateCapabilities } from '../src/capabilities.mjs';
import { initializeDefinition } from '../src/config.mjs';
import { environmentFilesToolGuard, plainChatEnvironmentFilesGuard } from '../src/copilot-environment-files-guard.mjs';
import { repositoryToolGuard } from '../src/copilot-repository-boundary.mjs';
import { proposeProgressiveCapabilityChange } from '../src/organisation.mjs';
import { removeTemporaryTree, run } from '../src/util.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { git, repository, writeFiles } from './helpers/environment-files-fixture.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const pluginRoot = path.join(packageRoot, 'plugin');
const VALUE = 'password: Xq7mP2vL9sT4kR8w\n';
const read = (cwd, file) => ({ cwd, toolName: 'view', toolArgs: { path: file } });
const refused = (decision) => decision?.permissionDecision === 'deny';

async function sflowRepository(t, files = {}) {
  const repo = await repository(t, { declaration: null, files: { 'singularity/workflow.yml': 'version: 2\n', ...files } });
  await writeFiles(repo.root, { '.env': 'TOKEN=abc\n', 'application.yml': VALUE, 'clean.yml': 'name: shop\n' });
  return repo;
}

test('a plain chat is refused what a /sf- turn is refused, and reads the rest', async (t) => {
  const repo = await sflowRepository(t);
  const guard = (toolName, toolArgs) => plainChatEnvironmentFilesGuard({ cwd: repo.root, toolName, toolArgs }, { env: repo.env });
  for (const [toolName, toolArgs] of [
    ['view', { path: '.env' }], ['read_file', { filePath: path.join(repo.root, '.env') }],
    ['bash', { command: 'cat .env' }], ['run_in_terminal', { command: 'source .env' }],
    ['view', { path: 'application.yml' }], ['bash', { command: 'cat application.yml' }],
    ['edit', { path: 'application.yml', old_str: 'a', new_str: 'b' }]
  ]) {
    assert.ok(refused(await guard(toolName, toolArgs)), `${toolName} ${JSON.stringify(toolArgs)}`);
    assert.ok(refused(await environmentFilesToolGuard({ cwd: repo.root, toolName, toolArgs }, { env: repo.env })), 'and the turn guard agrees');
  }
  for (const [toolName, toolArgs] of [['view', { path: 'clean.yml' }], ['view', { path: 'README.md' }], ['bash', { command: 'cat clean.yml' }],
    ['bash', { command: 'echo .env' }], ['view', { path: '.env.example' }]]) {
    assert.equal(await guard(toolName, toolArgs), null, `${toolName} ${JSON.stringify(toolArgs)}`);
  }
});

test('a repository that does not use SFlow, and a file in no repository, are not SFlow\'s to judge', async (t) => {
  const repo = await repository(t, { declaration: null, files: { '.env': 'TOKEN=abc\n', 'application.yml': VALUE } });
  git(repo.root, ['rm', '-q', '--cached', '.env']);
  const guard = (cwd, file) => plainChatEnvironmentFilesGuard(read(cwd, file), { env: repo.env });
  assert.equal(await guard(repo.root, '.env'), null);
  assert.equal(await guard(repo.root, 'application.yml'), null);
  const loose = path.join(repo.base, 'loose');
  await writeFiles(loose, { '.env': 'TOKEN=abc\n' });
  assert.equal(await guard(loose, '.env'), null);

  const managed = await sflowRepository(t);
  assert.equal(await guard(managed.root, path.join(loose, '.env')), null, 'named from an SFlow repository, it is still outside one');
  assert.ok(refused(await guard(loose, path.join(managed.root, '.env'))), 'and a chat elsewhere is refused the SFlow repository\'s');
  assert.ok(refused(await plainChatEnvironmentFilesGuard({ cwd: repo.root, toolCalls: [
    { name: 'view', args: { path: '.env' } }, { name: 'view', args: { path: path.join(managed.root, '.env') } }
  ] }, { env: repo.env })), 'a batch is judged call by call, past the one that is excused');
});

for (const [name, marker] of [
  ['a workflow', ['singularity/workflow.yml', 'version: 2\n']], ['a capability map', ['singularity/capabilities.yml', 'version: 1\ncapabilities: {}\n']],
  ['SFlow\'s private folder', ['.git/singularity-flow/note', 'x']], ['a configuration branch', ['.git/refs/remotes/origin/sflow/config', '0'.repeat(40)]],
  ['a packed configuration branch', ['.git/packed-refs', `${'0'.repeat(40)} refs/remotes/origin/sflow/config\n`]]
]) test(`${name} marks a clone as using SFlow`, async (t) => {
  const repo = await repository(t, { declaration: null });
  await writeFiles(repo.root, { '.env': 'TOKEN=abc\n', [marker[0]]: marker[1] });
  assert.ok(refused(await plainChatEnvironmentFilesGuard(read(repo.root, '.env'), { env: repo.env })));
});

test('a folder that happens to be called singularity does not', async (t) => {
  const repo = await repository(t, { declaration: null, files: { 'singularity/README.md': 'a physics note\n' } });
  await writeFiles(repo.root, { '.env': 'TOKEN=abc\n' });
  assert.equal(await plainChatEnvironmentFilesGuard(read(repo.root, '.env'), { env: repo.env }), null);
});

test('the capability is asked only for a call that would be refused, with the path it owns', async (t) => {
  const repo = await sflowRepository(t);
  await writeFiles(repo.root, { 'services/pay/.env': 'TOKEN=abc\n' });
  const asked = [];
  const policyFor = async (root, subject) => { asked.push([root, subject]); return subject.startsWith('services/pay/') ? 'allow' : 'refuse'; };
  const guard = (file) => plainChatEnvironmentFilesGuard(read(repo.root, file), { env: repo.env, policyFor });
  assert.equal(await guard('clean.yml'), null);
  assert.deepEqual(asked, [], 'an ordinary call reads no capability');
  assert.equal(await guard('services/pay/.env'), null, 'allowed where the capability says so');
  assert.deepEqual(asked, [[repo.root, 'services/pay/.env']]);
  assert.ok(refused(await guard('.env')), 'and refused beside it');
});

test('a declared file, and what SFlow holds for it, are refused in any repository the chat stands in', async (t) => {
  const repo = await repository(t, { files: { 'apps/web/.env.dev.example': 'A=1\n' } });
  assert.equal(repo.json(['env', 'files', 'create', 'dev', 'apps/web/.env.dev', '--from-template']).status, 0);
  const location = repo.json(['env', 'files', 'path', 'dev', 'apps/web/.env.dev']).value.location;
  for (const file of ['apps/web/.env.dev', location]) {
    assert.ok(refused(await plainChatEnvironmentFilesGuard(read(repo.root, file), { env: repo.env })), file);
    assert.equal(await plainChatEnvironmentFilesGuard(read(repo.root, file), { env: repo.env, policyFor: async () => 'allow' }), null, `${file}, once allowed`);
  }
  const command = { cwd: repo.root, toolName: 'bash', toolArgs: { command: 'singularity-flow env files link dev .env --to /tmp/x.env' } };
  assert.ok(refused(await plainChatEnvironmentFilesGuard(command, { env: repo.env })));
  assert.equal(await plainChatEnvironmentFilesGuard(command, { env: repo.env, policyFor: async () => 'allow' }), null);
});

test('the runtime guard: refused in a plain chat, left alone while paused, and a person\'s step comes first', async (t) => {
  const repo = await sflowRepository(t);
  const mode = path.join(repo.base, 'state', 'mode.json');
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = mode;
  t.after(() => { if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE; else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous; });
  const payload = { sessionId: 'plain', ...read(repo.root, '.env') };
  const decision = await repositoryToolGuard(payload);
  assert.ok(refused(decision));
  assert.match(decision.permissionDecisionReason, /^ENVIRONMENT_FILE_PRIVATE/u);
  assert.deepEqual(await repositoryToolGuard({ sessionId: 'plain', ...read(repo.root, 'clean.yml') }), {});
  const step = await repositoryToolGuard({ sessionId: 'plain', cwd: repo.root, toolName: 'bash', toolArgs: { command: 'singularity-flow approve specification --yes' } });
  assert.doesNotMatch(step.permissionDecisionReason ?? '', /^ENVIRONMENT_FILE_PRIVATE/u);

  const result = repo.sflow(['pause', 'on', '--json'], { env: { ...repo.env, SINGULARITY_FLOW_COPILOT_MODE_FILE: mode } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await repositoryToolGuard(payload), {}, 'a paused machine is native Copilot');
});

test('folding only tightens: a child may refuse, and may not allow under a parent that refuses', () => {
  assert.deepEqual(foldCapabilityPolicy({}, {}).plainChatSecrets, undefined, 'unset stays unset, so a pinned policy digest does not move');
  assert.equal(foldCapabilityPolicy({}, { plainChatSecrets: 'allow' }).plainChatSecrets, 'allow');
  assert.equal(foldCapabilityPolicy({ plainChatSecrets: 'allow' }, {}).plainChatSecrets, 'allow');
  assert.equal(foldCapabilityPolicy({ plainChatSecrets: 'allow' }, { plainChatSecrets: 'refuse' }).plainChatSecrets, 'refuse');
  assert.throws(() => foldCapabilityPolicy({ plainChatSecrets: 'refuse' }, { plainChatSecrets: 'allow' }), { code: 'CAPABILITY_POLICY_LOOSENED' });
  assert.throws(() => foldCapabilityPolicy({}, { plainChatSecrets: 'off' }), { code: 'CAPABILITY_POLICY_INVALID' });
  const map = (top, bottom) => ({ version: 1, capabilities: {
    top: { kind: 'collection', parent: null, policy: top },
    middle: { kind: 'collection', parent: 'top', policy: {} },
    bottom: { kind: 'collection', parent: 'middle', policy: bottom } } });
  assert.throws(() => validateCapabilities(map({ plainChatSecrets: 'refuse' }, { plainChatSecrets: 'allow' })),
    (error) => error.code === 'CAPABILITY_POLICY_LOOSENED' && error.details.capabilityId === 'bottom' && error.details.ancestorId === 'top' && error.details.field === 'plainChatSecrets');
  assert.doesNotThrow(() => validateCapabilities(map({}, { plainChatSecrets: 'allow' })));
  assert.doesNotThrow(() => validateCapabilities(map({ plainChatSecrets: 'allow' }, { plainChatSecrets: 'refuse' })));
  assert.throws(() => validateCapabilities(map({ localIntegrationEvidence: 'off' }, { localIntegrationEvidence: 'allowed' })),
    (error) => error.code === 'CAPABILITY_POLICY_LOOSENED' && error.details.field === 'localIntegrationEvidence', 'the older field folds the same way');
});

async function reviewedRepository(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-plain-chat-'));
  t.after(() => removeTemporaryTree(base));
  const bare = path.join(base, 'platform.git');
  run('git', ['init', '-q', '-b', 'main', '--bare', bare], { cwd: base });
  const seed = path.join(base, 'seed');
  run('git', ['init', '-q', '-b', 'main', seed], { cwd: base });
  run('git', ['config', 'user.email', 'a@b.com'], { cwd: seed });
  run('git', ['config', 'user.name', 'A B'], { cwd: seed });
  await writeFile(path.join(seed, 'README.md'), '# platform\n');
  run('git', ['add', '-A'], { cwd: seed });
  run('git', ['commit', '-qm', 'Initial'], { cwd: seed });
  run('git', ['push', '-q', bare, 'main:main'], { cwd: seed });
  return { base, bare };
}

async function mergeProposal(remote, proposal) {
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-plain-chat-review-'));
  try {
    run('git', ['clone', '-q', '--no-local', remote, checkout]);
    run('git', ['config', 'user.email', 'reviewer@example.com'], { cwd: checkout });
    run('git', ['config', 'user.name', 'Review User'], { cwd: checkout });
    run('git', ['fetch', '-q', 'origin', proposal.branch], { cwd: checkout });
    run('git', ['switch', '-q', proposal.baseBranch], { cwd: checkout });
    run('git', ['merge', '--ff-only', `origin/${proposal.branch}`], { cwd: checkout });
    run('git', ['push', '-q', 'origin', `HEAD:${proposal.baseBranch}`], { cwd: checkout });
  } finally { await rm(checkout, { recursive: true, force: true }); }
}

test('a capability allows plain chats through a reviewed proposal, for what it owns, and a local edit changes nothing', async (t) => {
  const org = await reviewedRepository(t);
  const lead = process.env.SINGULARITY_FLOW_LEAD_REGISTRY;
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = path.join(org.base, 'leads.json');
  t.after(() => { if (lead === undefined) delete process.env.SINGULARITY_FLOW_LEAD_REGISTRY; else process.env.SINGULARITY_FLOW_LEAD_REGISTRY = lead; });
  await mergeProposal(org.bare, await proposeProgressiveCapabilityChange(org.bare, {
    operation: 'add', capabilityId: 'payments', name: 'Payments', ownership: 'services/payments/**'
  }));

  const chat = path.join(org.base, 'chat');
  run('git', ['clone', '-q', '--no-local', org.bare, chat]);
  await writeFiles(chat, { '.env': 'TOKEN=abc\n', 'services/payments/.env': 'TOKEN=abc\n', 'services/other/.env': 'TOKEN=abc\n' });
  const env = { ...process.env, SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(org.base, 'state', 'workspaces.json') };
  const guard = (file) => plainChatEnvironmentFilesGuard(read(chat, file), { env });
  for (const file of ['.env', 'services/payments/.env', 'services/other/.env']) assert.ok(refused(await guard(file)), `${file}, by default`);

  const proposal = await proposeProgressiveCapabilityChange(org.bare, {
    operation: 'plain-chat', capabilityId: 'payments', plainChatSecrets: 'allow'
  });
  assert.equal(proposal.reviewRequired, true);
  assert.equal(proposal.receipt.parameters.plainChatSecrets, 'allow');
  const proposed = YAML.parse(run('git', ['show', `${proposal.commit}:singularity/capabilities.yml`], { cwd: org.bare }).stdout);
  assert.equal(proposed.capabilities.payments.policy.plainChatSecrets, 'allow');
  run('git', ['fetch', '-q', 'origin'], { cwd: chat });
  assert.ok(refused(await guard('services/payments/.env')), 'a proposal changes nothing until it is reviewed');

  await mergeProposal(org.bare, proposal);
  run('git', ['fetch', '-q', 'origin'], { cwd: chat });
  assert.equal(await guard('services/payments/.env'), null, 'once approved and fetched, the capability\'s own files are read');
  assert.ok(refused(await guard('services/other/.env')), 'and only those');
  assert.ok(refused(await guard('.env')));

  await writeFiles(chat, { 'singularity/capabilities.yml': YAML.stringify({ version: 1, capabilities: { 'repository-root': { kind: 'delivery', repository: 'x', policy: { plainChatSecrets: 'allow' } } } }) });
  assert.ok(refused(await guard('.env')), 'an edit in the checkout does not stand in for the approved map');
  await rm(path.join(chat, 'singularity'), { recursive: true, force: true });

  const inherited = await proposeProgressiveCapabilityChange(org.bare, { operation: 'plain-chat', capabilityId: 'payments', plainChatSecrets: null });
  assert.equal(YAML.parse(run('git', ['show', `${inherited.commit}:singularity/capabilities.yml`], { cwd: org.bare }).stdout)
    .capabilities.payments.policy?.plainChatSecrets, undefined, 'inherit takes the capability\'s own value out');
  await mergeProposal(org.bare, inherited);
  run('git', ['fetch', '-q', 'origin'], { cwd: chat });
  assert.ok(refused(await guard('services/payments/.env')));
});

test('a broken map leaves the refusal standing', async (t) => {
  const repo = await sflowRepository(t, { 'singularity/capabilities.yml': 'version: 1\ncapabilities:\n  a: { kind: nonsense, policy: { plainChatSecrets: allow } }\n' });
  git(repo.root, ['add', '-A']);
  assert.ok(refused(await plainChatEnvironmentFilesGuard(read(repo.root, 'application.yml'), { env: repo.env })));
});

test('a repository with only a working-tree map can allow by editing it through capability set', async (t) => {
  const repo = await sflowRepository(t, { 'singularity/capabilities.yml': 'version: 1\ncapabilities:\n  shop: { kind: delivery, repository: shop, parent: null }\n' });
  const environment = { ...repo.env, HOME: repo.base, SINGULARITY_FLOW_HOME: path.join(repo.base, 'home') };
  const set = (value) => repo.sflow(['capability', 'set', 'shop', '--plain-chat-secrets', value, '--json'], { env: environment });
  assert.equal(set('allow').status, 0);
  assert.equal(YAML.parse(readFileSync(path.join(repo.root, 'singularity/capabilities.yml'), 'utf8')).capabilities.shop.policy.plainChatSecrets, 'allow');
  assert.equal(await plainChatEnvironmentFilesGuard(read(repo.root, '.env'), { env: repo.env }), null);
  assert.equal(set('inherit').status, 0);
  assert.equal(YAML.parse(readFileSync(path.join(repo.root, 'singularity/capabilities.yml'), 'utf8')).capabilities.shop.policy?.plainChatSecrets, undefined);
  assert.ok(refused(await plainChatEnvironmentFilesGuard(read(repo.root, '.env'), { env: repo.env })));
  const wrong = set('maybe');
  assert.notEqual(wrong.status, 0);
  assert.match(`${wrong.stdout}${wrong.stderr}`, /--plain-chat-secrets must be inherit, refuse, or allow/u);
  await rm(path.join(repo.root, 'singularity/workflow.yml'));
  await initializeDefinition(repo.root);
  const shown = () => repo.json(['capability', 'show', '.'], { env: environment });
  assert.equal(shown().value.plainChatSecrets, 'refuse');
  await writeFile(path.join(repo.root, 'singularity/capabilities.yml'),
    'version: 1\ncapabilities:\n  shop: { kind: delivery, repository: shop, parent: null, policy: { plainChatSecrets: allow } }\n');
  assert.equal(shown().value.plainChatSecrets, 'allow');
  assert.match(repo.sflow(['capability', 'show', '.'], { env: environment }).stdout, /Secrets in a plain Copilot chat:\n {2}allowed by this capability/u);
});

test('a repository set up through the front door can be configured on its implicit capability, and the proposal activates', async (t) => {
  const org = await reviewedRepository(t);
  const machine = path.join(org.base, 'machine');
  const env = { ...process.env, HOME: machine, SINGULARITY_FLOW_HOME: path.join(machine, 'sflow'), SINGULARITY_FLOW_NO_MODEL: '1', GIT_TERMINAL_PROMPT: '0',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(machine, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(machine, 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(machine, 'leads.json'),
    GIT_AUTHOR_NAME: 'A B', GIT_AUTHOR_EMAIL: 'a@b.com', GIT_COMMITTER_NAME: 'A B', GIT_COMMITTER_EMAIL: 'a@b.com' };
  await mkdir(machine, { recursive: true });
  const chat = path.join(org.base, 'chat');
  run('git', ['clone', '-q', '--no-local', org.bare, chat]);
  const sflow = (...args) => {
    const result = spawnSync(process.execPath, [path.join(packageRoot, 'bin/singularity-flow.mjs'), ...args, '--json'], { cwd: chat, env, encoding: 'utf8', timeout: childTimeout(180_000) });
    return { status: result.status, value: JSON.parse(result.stdout || '{}'), stderr: result.stderr };
  };
  const plan = sflow('capability', 'onboard', org.bare, '--dry-run');
  assert.equal(sflow('capability', 'onboard', org.bare, '--confirm-plan', plan.value.planId).status, 0);
  run('git', ['fetch', '-q', 'origin'], { cwd: chat });
  await writeFiles(chat, { '.env': 'TOKEN=abc\n' });
  const guard = () => plainChatEnvironmentFilesGuard(read(chat, '.env'), { env });
  assert.ok(refused(await guard()), 'an onboarded clone uses SFlow, with its configuration only on sflow/config');
  assert.equal(sflow('capability', 'show', '.').value.plainChatSecrets, 'refuse', 'and capability show reads it from there');

  const proposal = sflow('capability', 'plain-chat', 'repository-root', '--secrets', 'allow', '--lead', org.bare);
  assert.equal(proposal.status, 0, JSON.stringify(proposal.value.error));
  assert.equal(proposal.value.materialized, true);
  const declared = YAML.parse(run('git', ['show', `${proposal.value.commit}:singularity/portfolio.yml`], { cwd: org.bare }).stdout).repositories.platform;
  assert.equal(declared.url, org.bare, 'materializing declares the repository the map now names');
  assert.equal(declared.defaultBranch, 'main');
  const activated = sflow('capability', 'activate', proposal.value.branch, '--lead', org.bare, '--confirm', proposal.value.commit, '--acknowledge-unprotected');
  assert.equal(activated.status, 0, JSON.stringify(activated.value.error));
  run('git', ['fetch', '-q', 'origin'], { cwd: chat });
  assert.equal(await guard(), null);
  assert.equal(sflow('capability', 'show', '.').value.plainChatSecrets, 'allow');

  const auto = sflow('capability', 'auto', 'repository-root', '--eligibility', 'disabled', '--lead', org.bare);
  assert.equal(auto.status, 0, 'the sibling policy command is a registered subcommand too');
  const autoActivated = sflow('capability', 'activate', auto.value.branch, '--lead', org.bare, '--confirm', auto.value.commit, '--acknowledge-unprotected');
  assert.equal(autoActivated.status, 0, JSON.stringify(autoActivated.value.error));
  const wrong = sflow('capability', 'plain-chat', 'repository-root', '--secrets', 'sometimes', '--lead', org.bare);
  assert.equal(wrong.value.error.code, 'CAPABILITY_POLICY_INVALID');
});

// With no turn recorded, what starts Node decides what the runtime ever sees.
const SENT_TO_NODE = ['.env', 'apps/web/.env.dev', '.ENV', '.envrc', 'prod.env', 'application.yml', 'application-dev.YAML', 'a/b.properties', 'x.toml', 'x.ini', 'x.cfg', 'x.conf',
  'appsettings.json', 'config.local.json', 'id.pem', 'server.key', 'store.p12', 'store.pfx', 'store.jks', 'x.keystore', 'secrets/notes.txt', 'db-credentials.txt'];
const LEFT_ALONE = ['src/App.jsx', 'README.md', 'docs/notes.txt', 'Makefile'];
const LEFT_ALONE_COMMANDS = ['echo process.env.HOME', 'node -e Object.keys(a)', 'res.json(body)', 'config.init()', 'ls -la'];

async function launcherHost(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-plain-chat-launcher-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'host-bin');
  await mkdir(bin);
  const started = path.join(directory, 'node-started');
  await writeFile(path.join(bin, 'node'), `#!/bin/sh\necho started >> '${started}'\ncat >/dev/null\necho '{}'\n`, { mode: 0o755 });
  await symlink(path.join(packageRoot, 'bin/singularity-flow.mjs'), path.join(bin, 'singularity-flow'));
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(directory, 'mode.json'),
    SINGULARITY_FLOW_ENGINE_HOME: path.join(directory, 'no engine') };
  const starts = () => (existsSync(started) ? readFileSync(started, 'utf8').split('\n').filter(Boolean).length : 0);
  return { directory, env, starts };
}

function assertRoutes(host, launch) {
  const sends = (input) => { const before = host.starts(); launch(input); return host.starts() > before; };
  const call = (toolName, toolArgs) => JSON.stringify({ sessionId: 'plain', cwd: host.directory, toolName, toolArgs });
  for (const file of SENT_TO_NODE) {
    assert.ok(sends(call('view', { path: file })), `${file} goes to Node`);
    assert.ok(sends(call('bash', { command: `cat ${file}` })), `cat ${file} goes to Node`);
  }
  for (const file of LEFT_ALONE) assert.ok(!sends(call('view', { path: file })), `${file} starts no Node`);
  for (const command of LEFT_ALONE_COMMANDS) assert.ok(!sends(call('bash', { command })), `${command} starts no Node`);
  assert.ok(!sends(JSON.stringify({ sessionId: 'plain', cwd: '/work/my.yml/.env/secret', toolName: 'view', toolArgs: { path: 'README.md' } })), 'the session\'s folder is not read');
  assert.ok(sends(JSON.stringify({ toolCalls: [{ name: 'view', args: { path: 'README.md' } }, { name: 'view', args: { path: '.env' } }] })), 'a batch');
  assert.ok(sends('{"toolName":"view","toolArgs":{"path":"\\u002eenv"}}'), 'an escaped spelling');
}

test('the bash launcher starts Node for a call that may name a private file, and for no other', { skip: process.platform === 'win32' }, async (t) => {
  const host = await launcherHost(t);
  assertRoutes(host, (input) => {
    const result = spawnSync('/bin/bash', [path.join(pluginRoot, 'hook-launcher.sh'), 'boundary-guard'], { cwd: host.directory, env: host.env, input, encoding: 'utf8', timeout: childTimeout(30_000) });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
  });
});

test('the PowerShell launcher agrees', {
  skip: (process.platform === 'win32' || spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', '1'], { encoding: 'utf8', timeout: childTimeout(15_000) }).status !== 0) && 'PowerShell host unavailable'
}, async (t) => {
  const host = await launcherHost(t);
  const script = path.join(pluginRoot, 'hook-launcher.ps1');
  const pwsh = (process.env.PATH ?? '').split(path.delimiter).map((directory) => path.join(directory, 'pwsh')).find((file) => existsSync(file));
  assertRoutes(host, (input) => {
    const result = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `& '${script}' boundary-guard`],
      { cwd: host.directory, env: host.env, input, encoding: 'utf8', timeout: childTimeout(60_000) });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1)), {});
  });
});
