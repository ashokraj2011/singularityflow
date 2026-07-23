import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  discoverJiraConnection, jiraRequest, listEpicStories, normalizeJiraConnection
} from '../src/jira.mjs';
import { normalizeJiraPolicy } from '../src/initiative-config.mjs';
import { buildJiraBreakdownDraft } from '../src/jira-initiative.mjs';
import { applyJiraWritePlan, createJiraWritePlan } from '../src/jira-initiative.mjs';
import { JiraCredentialStore } from '../apps/desktop/electron/jira-credentials.mjs';
import { initializeDefinition } from '../src/config.mjs';
import { createInitiative, initiativeDir, saveInitiative } from '../src/initiative-state.mjs';
import { run } from '../src/util.mjs';
import YAML from 'yaml';

function response(payload, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => payload == null ? '' : JSON.stringify(payload)
  };
}

test('Jira connections enforce HTTPS and deployment-specific authentication', () => {
  assert.throws(() => normalizeJiraConnection({ baseUrl: 'http://jira.example.com', email: 'a@b.com', token: 'secret' }), /HTTPS/);
  assert.throws(() => normalizeJiraConnection({ baseUrl: 'https://jira.example.com', deployment: 'data-center', email: 'a@b.com', token: 'secret', authMode: 'user-token' }), /Data Center/);
  const cloud = normalizeJiraConnection({ name: 'office', baseUrl: 'https://office.atlassian.net/', email: 'a@b.com', token: 'secret' });
  assert.equal(cloud.baseUrl, 'https://office.atlassian.net');
  assert.equal(cloud.auth.mode, 'user-token');
  const dc = normalizeJiraConnection({ baseUrl: 'https://jira.office.example', deployment: 'data-center', token: 'pat', authMode: 'pat' });
  assert.equal(dc.apiVersion, '2');
  assert.equal(dc.auth.email, null);
});

test('Jira request retries throttling and sends Data Center PAT only as Bearer auth', async () => {
  let calls = 0;
  const waits = [];
  const result = await jiraRequest('/rest/api/2/myself', {
    connection: { baseUrl: 'https://jira.example.com', deployment: 'data-center', token: 'pat-secret', authMode: 'pat' },
    sleep: async (milliseconds) => waits.push(milliseconds),
    fetchImpl: async (url, init) => {
      calls += 1;
      assert.equal(url, 'https://jira.example.com/rest/api/2/myself');
      assert.equal(init.headers.Authorization, 'Bearer pat-secret');
      return calls === 1 ? response({ message: 'slow down' }, 429, { 'retry-after': '0' }) : response({ name: 'developer' });
    }
  });
  assert.equal(result.payload.name, 'developer');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [0]);
});

test('connection discovery and Epic child browsing use safe Jira endpoints', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    if (url.endsWith('/serverInfo')) return response({ version: '10.3', serverTitle: 'Office Jira' });
    if (url.endsWith('/myself')) return response({ accountId: 'u-1', displayName: 'Developer' });
    if (url.includes('/project/search')) return response({ values: [{ id: '10', key: 'APP', name: 'Applications' }] });
    if (url.endsWith('/search/jql')) return response({ issues: [] });
    throw new Error(`unexpected ${url}`);
  };
  const connection = { baseUrl: 'https://office.atlassian.net', email: 'developer@example.com', token: 'token' };
  const discovered = await discoverJiraConnection({ connection, fetchImpl });
  assert.equal(discovered.account.displayName, 'Developer');
  assert.equal(discovered.projects[0].key, 'APP');
  await listEpicStories('APP-42', { connection, fetchImpl });
  const search = seen.find((entry) => entry.url.endsWith('/search/jql'));
  assert.match(JSON.parse(search.init.body).jql, /^\(parent = "APP-42" OR "Epic Link" = "APP-42"\)/);
  await assert.rejects(() => listEpicStories('APP-42" OR project = SECRET', { connection, fetchImpl }), /valid Jira Epic key/);
});

test('portfolio Jira policy blocks unsafe fields and normalizes legacy write configuration', () => {
  const policy = normalizeJiraPolicy({ enabled: true, deployment: 'cloud', allowedHosts: ['jira.example.com'], write: true, projectKey: 'APP' });
  assert.equal(policy.writeMode, 'approved');
  assert.equal(policy.allowedHosts[0], 'jira.example.com');
  assert.ok(policy.writePolicy.operations.includes('create-story'));
  assert.throws(() => normalizeJiraPolicy({ allowedFields: ['summary', 'status'] }), /governed fields/);
  assert.throws(() => normalizeJiraPolicy({ deployment: 'data-center', authentication: { permitted: ['user-token'] } }), /not supported/);
});

test('Jira Epic adoption keeps separate Singularity and Jira IDs and requires repository mapping', () => {
  const portfolio = { repositories: { mobile: {}, api: {} } };
  const epic = { key: 'APP-10', title: 'Mobile onboarding', description: 'Epic' };
  const stories = [
    { key: 'APP-11', title: 'Create API', issueType: 'Story', description: 'API work' },
    { key: 'APP-12', title: 'Build mobile screen', issueType: 'Story', description: 'Mobile work' }
  ];
  const unresolved = buildJiraBreakdownDraft(epic, stories, portfolio);
  assert.equal(unresolved.ready, false);
  assert.deepEqual(unresolved.unresolved.map((item) => item.jiraKey), ['APP-11', 'APP-12']);
  const mapped = buildJiraBreakdownDraft(epic, stories, portfolio, { repositoryMap: { 'APP-11': 'api', 'APP-12': 'mobile' } });
  assert.equal(mapped.ready, true);
  assert.equal(mapped.draft.epics[0].id, 'EPIC-001');
  assert.equal(mapped.draft.epics[0].jiraKey, 'APP-10');
  assert.equal(mapped.draft.epics[0].stories[0].id, 'STORY-001');
  assert.equal(mapped.draft.epics[0].stories[0].jiraKey, 'APP-11');
});

test('desktop Jira credentials are encrypted at rest and public status never returns tokens', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-jira-store-'));
  const file = path.join(directory, 'jira.json');
  const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'keychain',
    encryptString: (value) => Buffer.from(value.split('').reverse().join('')),
    decryptString: (value) => value.toString().split('').reverse().join('')
  };
  const store = new JiraCredentialStore(file, fakeSafeStorage);
  await store.save({
    name: 'corporate-jira',
    deployment: 'cloud',
    baseUrl: 'https://office.atlassian.net',
    auth: { mode: 'user-token', email: 'developer@example.com', token: 'never-plaintext' },
    account: { displayName: 'Developer' }
  });
  const disk = await readFile(file, 'utf8');
  assert.doesNotMatch(disk, /never-plaintext|developer@example\.com/);
  const status = await store.status();
  assert.equal(status.connected, true);
  assert.equal(status.connection.email, 'developer@example.com');
  assert.equal(JSON.stringify(status).includes('never-plaintext'), false);
  assert.equal((await store.load()).auth.token, 'never-plaintext');
  const disconnected = await store.disconnect();
  assert.equal(disconnected.connected, false);
});

test('desktop Jira credential storage fails closed when OS encryption is unavailable', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-jira-store-unavailable-'));
  const store = new JiraCredentialStore(path.join(directory, 'jira.json'), {
    isEncryptionAvailable: () => false
  });
  await assert.rejects(() => store.save({
    name: 'jira',
    auth: { token: 'secret' }
  }), /unavailable/);
});

test('desktop exposes a narrow Jira IPC workspace without renderer credential reads', async () => {
  const main = await readFile(new URL('../apps/desktop/electron/main.mjs', import.meta.url), 'utf8');
  const preload = await readFile(new URL('../apps/desktop/electron/preload.cjs', import.meta.url), 'utf8');
  const app = await readFile(new URL('../apps/desktop/src/App.jsx', import.meta.url), 'utf8');
  assert.match(main, /safeStorage/);
  assert.match(main, /assertTrustedSender\(event\)/);
  assert.match(main, /ipcMain\.handle\('jira:connect'/);
  assert.match(main, /ipcMain\.handle\('jira:write-plan'/);
  assert.match(main, /ipcMain\.handle\('jira:apply'/);
  assert.match(preload, /connectJira/);
  assert.doesNotMatch(preload, /loadJiraCredential|readJiraToken|getJiraToken/);
  assert.match(app, /function JiraWorkspace/);
  assert.match(app, /Test connection & save securely/);
  assert.match(app, /Generate & commit plan/);
});

test('governed Jira write plan creates Epic then child story and persists receipts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-jira-plan-'));
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Initiative Owner'], { cwd: root });
  run('git', ['config', 'user.email', 'owner@example.com'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# Lead\n');
  await initializeDefinition(root);
  const portfolioPath = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioPath, 'utf8'));
  for (const authority of Object.values(portfolio.approvalAuthorities)) authority.members = [{ name: 'Owner', email: 'owner@example.com' }];
  portfolio.repositories = { mobile: { url: 'https://git.example.com/mobile.git', defaultBranch: 'main', required: true } };
  portfolio.jira = {
    enabled: true,
    connection: 'corporate-jira',
    deployment: 'cloud',
    writeMode: 'approved',
    projectKey: 'APP',
    epicIssueType: 'Epic',
    storyIssueType: 'Story'
  };
  await writeFile(portfolioPath, YAML.stringify(portfolio));
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'Initialize'], { cwd: root });
  run('git', ['switch', '-c', 'INIT-JIRA'], { cwd: root });
  const created = await createInitiative(root, { id: 'INIT-JIRA', profile: 'initiative-lite' });
  created.initiative.phases.define.status = 'approved';
  created.initiative.phases.plan.status = 'approved';
  created.initiative.phases.build.status = 'in_progress';
  created.initiative.currentPhase = 'build';
  await saveInitiative(root, created.portfolio, created.initiative);
  await writeFile(path.join(initiativeDir(root, created.portfolio, 'INIT-JIRA'), 'breakdown.yml'), YAML.stringify({
    version: 1,
    initiativeId: 'INIT-JIRA',
    epics: [{
      id: 'EPIC-001',
      title: 'Mobile onboarding',
      stories: [{ id: 'STORY-001', title: 'Build mobile screen', repository: 'mobile' }]
    }]
  }));
  const connection = { baseUrl: 'https://office.atlassian.net', email: 'owner@example.com', token: 'token' };
  const planned = await createJiraWritePlan(root, 'INIT-JIRA', { connection, fetchImpl: async () => { throw new Error('write-plan creation should not call Jira for new issues'); } });
  assert.deepEqual(planned.plan.operations.map((operation) => operation.action), ['create-epic', 'create-story']);
  let sequence = 100;
  const bodies = [];
  const fetchImpl = async (url, init) => {
    if (url.includes('/mypermissions?')) return response({ permissions: {
      CREATE_ISSUES: { name: 'Create Issues', havePermission: true },
      EDIT_ISSUES: { name: 'Edit Issues', havePermission: true }
    } });
    if (url.endsWith('/search/jql') && init.method === 'POST') return response({ issues: [] });
    if (url.endsWith('/issue') && init.method === 'POST') {
      bodies.push(JSON.parse(init.body));
      return response({ id: String(sequence), key: `APP-${sequence++}` });
    }
    throw new Error(`unexpected ${url}`);
  };
  const applied = await applyJiraWritePlan(root, 'INIT-JIRA', {
    planSha256: planned.plan.sha256,
    confirmation: 'INIT-JIRA',
    connection,
    fetchImpl,
    actor: 'owner@example.com'
  });
  assert.deepEqual(applied.results.map((receipt) => receipt.jiraKey), ['APP-100', 'APP-101']);
  assert.equal(bodies[1].fields.parent.key, 'APP-100');
  const breakdown = YAML.parse(await readFile(path.join(initiativeDir(root, created.portfolio, 'INIT-JIRA'), 'breakdown.yml'), 'utf8'));
  assert.equal(breakdown.epics[0].jiraKey, 'APP-100');
  assert.equal(breakdown.epics[0].stories[0].jiraKey, 'APP-101');
  const receipt = JSON.parse(await readFile(path.join(initiativeDir(root, created.portfolio, 'INIT-JIRA'), 'context/jira/receipts/create-story-STORY-001.json'), 'utf8'));
  assert.equal(receipt.planSha256, planned.plan.sha256);
  assert.equal(receipt.actor, 'owner@example.com');
});
