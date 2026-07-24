import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertJiraConnectionPolicy, assertJiraIssuePolicy, assertJiraProjectPolicy,
  discoverJiraConnection, getIssueHierarchy, jiraRequest, listEpicStories,
  listWorkspaceAnchors, normalizeJiraConnection, searchIssues
} from '../src/jira.mjs';
import { normalizeJiraPolicy } from '../src/initiative-config.mjs';
import {
  assertJiraWriteOperationPolicy, buildJiraBreakdownDraft, previewJiraAdoption
} from '../src/jira-initiative.mjs';
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
      assert.equal(init.redirect, 'error');
      return calls === 1 ? response({ message: 'slow down' }, 429, { 'retry-after': '0' }) : response({ name: 'developer' });
    }
  });
  assert.equal(result.payload.name, 'developer');
  assert.deepEqual(Object.keys(result), ['payload']);
  assert.doesNotMatch(JSON.stringify(result), /pat-secret/);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [0]);
});

test('Jira request pins credentials to the configured API base and rejects absolute targets', async () => {
  let calls = 0;
  await assert.rejects(
    () => jiraRequest('https://attacker.example/collect', {
      connection: {
        baseUrl: 'https://jira.example.com',
        deployment: 'data-center',
        token: 'pat-secret',
        authMode: 'pat'
      },
      fetchImpl: async () => {
        calls += 1;
        return response({});
      }
    }),
    /relative Jira API path/
  );
  await assert.rejects(
    () => jiraRequest('//attacker.example/collect', {
      connection: {
        baseUrl: 'https://jira.example.com',
        deployment: 'data-center',
        token: 'pat-secret',
        authMode: 'pat'
      },
      fetchImpl: async () => {
        calls += 1;
        return response({});
      }
    }),
    /relative Jira API path/
  );
  await assert.rejects(
    () => jiraRequest('/../collect', {
      connection: {
        baseUrl: 'https://office.atlassian.net',
        cloudId: 'cloud-123',
        email: 'developer@example.com',
        token: 'api-secret'
      },
      fetchImpl: async () => {
        calls += 1;
        return response({});
      }
    }),
    /escapes the configured Jira API base/
  );
  assert.equal(calls, 0);
});

test('Jira request aborts a stalled connection check with an explicit timeout', async () => {
  let calls = 0;
  await assert.rejects(
    () => jiraRequest('/rest/api/2/myself', {
      connection: {
        baseUrl: 'https://jira.example.com',
        deployment: 'data-center',
        token: 'pat-secret',
        authMode: 'pat'
      },
      requestTimeoutMs: 10,
      maxRetries: 0,
      fetchImpl: async (_url, init) => {
        calls += 1;
        return new Promise((_resolve, reject) => {
          const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (init.signal.aborted) abort();
          else init.signal.addEventListener('abort', abort, { once: true });
        });
      }
    }),
    (error) => error?.category === 'timeout' && /10 milliseconds/.test(error.message)
  );
  assert.equal(calls, 1);
});

test('Jira request timeout covers a response body that stalls after headers', async () => {
  const stalled = jiraRequest('/rest/api/2/myself', {
    connection: {
      baseUrl: 'https://jira.example.com',
      deployment: 'data-center',
      token: 'pat-secret',
      authMode: 'pat'
    },
    requestTimeoutMs: 10,
    maxRetries: 0,
    fetchImpl: async (_url, init) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: () => new Promise((_resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (init.signal.aborted) abort();
        else init.signal.addEventListener('abort', abort, { once: true });
      })
    })
  });
  await assert.rejects(
    Promise.race([
      stalled,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Jira response body did not time out.')), 100))
    ]),
    (error) => error?.category === 'timeout' && /10 milliseconds/.test(error.message)
  );
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

test('Jira connection discovery performs only one bounded retry', async () => {
  let serverAttempts = 0;
  const connection = { baseUrl: 'https://office.atlassian.net', email: 'developer@example.com', token: 'token' };
  await assert.rejects(
    () => discoverJiraConnection({
      connection,
      sleep: async () => {},
      fetchImpl: async (url) => {
        if (url.endsWith('/serverInfo')) {
          serverAttempts += 1;
          throw new Error('network unavailable');
        }
        if (url.endsWith('/myself')) return response({ accountId: 'u-1', displayName: 'Developer' });
        if (url.includes('/project/search')) return response({ values: [] });
        throw new Error(`unexpected ${url}`);
      }
    }),
    (error) => error?.category === 'network' && /network unavailable/.test(error.message)
  );
  assert.equal(serverAttempts, 2);
});

test('Jira issue search paginates Cloud tokens and Data Center offsets without exceeding the requested limit', async () => {
  const issues = Array.from({ length: 120 }, (_, index) => ({
    id: String(index + 1),
    key: `APP-${index + 1}`,
    fields: { summary: `Story ${index + 1}` }
  }));
  const cloudBodies = [];
  const cloud = await searchIssues('project = "APP"', {
    connection: { baseUrl: 'https://office.atlassian.net', email: 'developer@example.com', token: 'token' },
    limit: 120,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      cloudBodies.push(body);
      return body.nextPageToken
        ? response({ issues: issues.slice(100), isLast: true })
        : response({ issues: issues.slice(0, 100), isLast: false, nextPageToken: 'page-2' });
    }
  });
  assert.equal(cloud.length, 120);
  assert.equal(cloudBodies.length, 2);
  assert.equal(cloudBodies[0].maxResults, 100);
  assert.equal(cloudBodies[1].maxResults, 20);
  assert.equal(cloudBodies[1].nextPageToken, 'page-2');

  const dataCenterBodies = [];
  const dataCenter = await searchIssues('project = "APP"', {
    connection: {
      baseUrl: 'https://jira.example.com',
      deployment: 'data-center',
      token: 'pat-secret',
      authMode: 'pat'
    },
    limit: 120,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      dataCenterBodies.push(body);
      const startAt = body.startAt ?? 0;
      return response({
        issues: issues.slice(startAt, startAt + body.maxResults),
        startAt,
        total: issues.length
      });
    }
  });
  assert.equal(dataCenter.length, 120);
  assert.deepEqual(dataCenterBodies.map((body) => [body.startAt, body.maxResults]), [[0, 100], [100, 20]]);
});

test('workspace anchors use Jira hierarchyLevel and hierarchy traversal uses parent', async () => {
  const searches = [];
  const issues = {
    'PORT-1': {
      id: '1', key: 'PORT-1',
      fields: { summary: 'Portfolio outcome', issuetype: { id: '10', name: 'Outcome', hierarchyLevel: 2 }, project: { key: 'PORT' } }
    },
    'PORT-2': {
      id: '2', key: 'PORT-2',
      fields: { summary: 'Payments Epic', issuetype: { id: '11', name: 'Epic', hierarchyLevel: 1 }, project: { key: 'PORT' }, parent: { key: 'PORT-1' } }
    }
  };
  const fetchImpl = async (url, init) => {
    if (url.includes('/createmeta/PORT/issuetypes')) return response({
      issueTypes: [
        { id: '10', name: 'Outcome', hierarchyLevel: 2 },
        { id: '11', name: 'Epic', hierarchyLevel: 1 },
        { id: '12', name: 'Story', hierarchyLevel: 0 }
      ]
    });
    if (url.includes('/issue/PORT-')) {
      const key = url.match(/issue\/(PORT-\d+)/)?.[1];
      return response(issues[key]);
    }
    if (url.endsWith('/search/jql')) {
      const body = JSON.parse(init.body);
      searches.push(body.jql);
      if (body.jql.startsWith('project =')) return response({ issues: Object.values(issues) });
      if (body.jql.startsWith('parent = "PORT-1"')) return response({ issues: [issues['PORT-2']] });
      return response({ issues: [] });
    }
    throw new Error(`unexpected ${url}`);
  };
  const connection = { baseUrl: 'https://office.atlassian.net', email: 'developer@example.com', token: 'token' };
  const anchors = await listWorkspaceAnchors('PORT', { connection, fetchImpl });
  assert.deepEqual(anchors.map((item) => [item.key, item.hierarchyLevel]), [['PORT-1', 2], ['PORT-2', 1]]);
  const hierarchy = await getIssueHierarchy('PORT-1', { connection, fetchImpl });
  assert.equal(hierarchy.anchor.issueType, 'Outcome');
  assert.equal(hierarchy.descendants[0].key, 'PORT-2');
  assert.ok(searches.some((jql) => /^parent = "PORT-1"/.test(jql)));
});

test('portfolio Jira policy blocks unsafe fields and normalizes legacy write configuration', () => {
  const policy = normalizeJiraPolicy({ enabled: true, deployment: 'cloud', allowedHosts: ['jira.example.com'], write: true, projectKey: 'APP' });
  assert.equal(policy.writeMode, 'approved');
  assert.equal(policy.allowedHosts[0], 'jira.example.com');
  assert.ok(policy.writePolicy.operations.includes('create-story'));
  assert.throws(() => normalizeJiraPolicy({ allowedFields: ['summary', 'status'] }), /governed fields/);
  assert.throws(() => normalizeJiraPolicy({ deployment: 'data-center', authentication: { permitted: ['user-token'] } }), /not supported/);
});

test('Jira runtime policy validates every reused connection, project, and issue key', () => {
  const policy = normalizeJiraPolicy({
    enabled: true,
    deployment: 'cloud',
    allowedHosts: ['office.atlassian.net'],
    allowedProjects: ['APP'],
    authentication: { permitted: ['user-token'] }
  });
  const connection = {
    name: 'corporate-jira',
    deployment: 'cloud',
    baseUrl: 'https://office.atlassian.net',
    email: 'developer@example.com',
    token: 'token',
    authMode: 'user-token'
  };
  assert.equal(assertJiraConnectionPolicy(connection, policy).baseUrl, 'https://office.atlassian.net');
  assert.equal(assertJiraProjectPolicy('app', policy), 'APP');
  assert.equal(assertJiraIssuePolicy('app-42', policy), 'APP-42');
  assert.throws(() => assertJiraConnectionPolicy({ ...connection, baseUrl: 'https://other.atlassian.net' }, policy), /outside the Jira allowlist/);
  assert.throws(() => assertJiraConnectionPolicy({ ...connection, deployment: 'data-center', authMode: 'pat' }, policy), /requires Jira cloud/);
  assert.throws(() => assertJiraProjectPolicy('OTHER', policy), /outside the configured allowedProjects/);
  assert.throws(() => assertJiraIssuePolicy('OTHER-42', policy), /outside the configured allowedProjects/);
});

test('Jira write operations are independently constrained by the pinned policy', () => {
  const policy = normalizeJiraPolicy({
    enabled: true,
    allowedProjects: ['APP'],
    writeMode: 'approved',
    write: {
      operations: ['create-epic', 'create-story', 'update-owned-fields', 'add-comment'],
      allowedFields: ['summary', 'description', 'labels']
    }
  });
  assert.doesNotThrow(() => assertJiraWriteOperationPolicy({
    id: 'update-story-STORY-001',
    action: 'update-owned-fields',
    subject: { type: 'story', id: 'STORY-001', jiraKey: 'APP-42' },
    fields: { summary: 'Governed title' }
  }, policy));
  assert.throws(() => assertJiraWriteOperationPolicy({
    id: '../escape',
    action: 'update-owned-fields',
    subject: { type: 'story', id: 'STORY-001', jiraKey: 'APP-42' },
    fields: { summary: 'Unsafe path' }
  }, policy), /safe ID/);
  assert.throws(() => assertJiraWriteOperationPolicy({
    id: 'update-story-STORY-001',
    action: 'update-owned-fields',
    subject: { type: 'story', id: 'STORY-001', jiraKey: 'APP-42' },
    fields: { status: 'Done' }
  }, policy), /outside allowedFields/);
  assert.throws(() => assertJiraWriteOperationPolicy({
    id: 'comment-story-STORY-001',
    action: 'add-comment',
    subject: { type: 'story', id: 'STORY-001', jiraKey: 'APP-42' },
    body: 'Unexpected action'
  }, policy), /not implemented/);
  assert.throws(() => assertJiraWriteOperationPolicy({
    id: 'create-story-STORY-001',
    action: 'create-story',
    subject: { type: 'story', id: 'STORY-001', jiraKey: null },
    parent: { epicId: 'EPIC-001', jiraKey: 'APP-10' },
    issue: { projectKey: 'APP', issueType: 'Story', summary: 'Story', fields: { assignee: 'admin' } }
  }, policy), /unsupported create fields/);
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

test('desktop Jira credential status reports recoverable corruption and reset removes only the encrypted store', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-jira-store-corrupt-'));
  const file = path.join(directory, 'jira.json');
  await writeFile(file, '{not-json');
  const store = new JiraCredentialStore(file, {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'keychain',
    decryptString: () => {
      throw new Error('must not be reached for malformed JSON');
    }
  });
  const status = await store.safeStatus();
  assert.equal(status.connected, false);
  assert.equal(status.recovery.required, true);
  assert.match(status.recovery.message, /could not be read/i);
  await store.reset();
  assert.equal((await store.safeStatus()).connected, false);
});

test('desktop Jira credential status and disconnect can target the repository-configured connection instead of the global active one', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-jira-store-selected-'));
  const file = path.join(directory, 'jira.json');
  const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'keychain',
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString()
  };
  const store = new JiraCredentialStore(file, fakeSafeStorage);
  await store.save({
    name: 'project-a',
    deployment: 'cloud',
    baseUrl: 'https://a.atlassian.net',
    auth: { mode: 'user-token', email: 'a@example.com', token: 'a' }
  });
  await store.save({
    name: 'project-b',
    deployment: 'cloud',
    baseUrl: 'https://b.atlassian.net',
    auth: { mode: 'user-token', email: 'b@example.com', token: 'b' }
  });
  const selected = await store.status('project-a');
  assert.equal(selected.active, 'project-b');
  assert.equal(selected.selected, 'project-a');
  assert.equal(selected.connection.name, 'project-a');
  const disconnected = await store.disconnect('project-a');
  assert.equal(disconnected.connected, false);
  assert.equal(disconnected.selected, 'project-a');
  assert.equal(disconnected.connection, null);
  assert.equal(disconnected.active, 'project-b');
  assert.equal((await store.status()).connection.name, 'project-b');
});

test('concurrent Jira credential saves preserve every named connection', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-jira-store-concurrent-'));
  const file = path.join(directory, 'jira.json');
  const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'keychain',
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString()
  };
  const first = new JiraCredentialStore(file, fakeSafeStorage);
  const second = new JiraCredentialStore(file, fakeSafeStorage);

  await Promise.all([
    first.save({
      name: 'project-a',
      deployment: 'cloud',
      baseUrl: 'https://a.atlassian.net',
      auth: { mode: 'user-token', email: 'a@example.com', token: 'a' }
    }),
    second.save({
      name: 'project-b',
      deployment: 'cloud',
      baseUrl: 'https://b.atlassian.net',
      auth: { mode: 'user-token', email: 'b@example.com', token: 'b' }
    })
  ]);

  const status = await first.status();
  assert.deepEqual(new Set(status.connections.map((connection) => connection.name)), new Set(['project-a', 'project-b']));
  assert.equal((await first.load('project-a')).auth.token, 'a');
  assert.equal((await first.load('project-b')).auth.token, 'b');
});

test('Jira credential storage rejects incompatible schemas and unsafe connection identifiers', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-jira-store-schema-'));
  const file = path.join(directory, 'jira.json');
  const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'keychain',
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString()
  };
  await writeFile(file, JSON.stringify({
    schemaVersion: 999,
    sealed: Buffer.from(JSON.stringify({ schemaVersion: 999, active: null, connections: {} })).toString('base64')
  }));
  const store = new JiraCredentialStore(file, fakeSafeStorage);
  const status = await store.safeStatus();
  assert.equal(status.connected, false);
  assert.equal(status.recovery.required, true);
  assert.match(status.recovery.message, /could not be read/i);
  await assert.rejects(
    () => new JiraCredentialStore(path.join(directory, 'unsafe.json'), fakeSafeStorage).save({
      name: '__proto__',
      auth: { token: 'secret' }
    }),
    /safe identifier/
  );
});

test('desktop exposes a narrow Jira IPC workspace without renderer credential reads', async () => {
  const main = await readFile(new URL('../apps/desktop/electron/main.mjs', import.meta.url), 'utf8');
  const preload = await readFile(new URL('../apps/desktop/electron/preload.cjs', import.meta.url), 'utf8');
  const app = await readFile(new URL('../apps/desktop/src/App.jsx', import.meta.url), 'utf8');
  assert.match(main, /safeStorage/);
  assert.match(main, /assertTrustedSender\(event\)/);
  assert.match(main, /trustedHandle\('jira:connect'/);
  assert.match(main, /trustedHandle\('jira:write-plan'/);
  assert.match(main, /trustedHandle\('jira:apply'/);
  assert.match(main, /governedJiraConnection/);
  assert.equal((main.match(/jiraCredentialStore\(\)\.load\(policy\.connection\)/g) ?? []).length, 1);
  assert.match(main, /Repository policy requires Jira connection name/);
  assert.match(preload, /connectJira/);
  assert.doesNotMatch(preload, /loadJiraCredential|readJiraToken|getJiraToken/);
  assert.match(app, /function JiraWorkspace/);
  assert.match(app, /Test connection & save securely/);
  assert.match(app, /Generate & commit plan/);
});

test('initiative Jira adoption and write planning reject issue keys outside the immutable project allowlist before network access', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-jira-policy-'));
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
    allowedHosts: ['office.atlassian.net'],
    allowedProjects: ['APP'],
    writeMode: 'preview',
    projectKey: 'APP'
  };
  await writeFile(portfolioPath, YAML.stringify(portfolio));
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'Initialize'], { cwd: root });
  run('git', ['switch', '-c', 'INIT-POLICY'], { cwd: root });
  const created = await createInitiative(root, { id: 'INIT-POLICY', profile: 'initiative-lite' });
  const connection = {
    baseUrl: 'https://office.atlassian.net',
    deployment: 'cloud',
    email: 'owner@example.com',
    token: 'token'
  };
  const noNetwork = async () => {
    throw new Error('policy rejection must happen before Jira is called');
  };
  await assert.rejects(
    () => previewJiraAdoption(root, 'INIT-POLICY', 'OTHER-1', { connection, fetchImpl: noNetwork }),
    /outside the configured allowedProjects/
  );

  await writeFile(path.join(initiativeDir(root, created.portfolio, 'INIT-POLICY'), 'breakdown.yml'), YAML.stringify({
    version: 1,
    initiativeId: 'INIT-POLICY',
    epics: [{
      id: 'EPIC-001',
      jiraKey: 'OTHER-1',
      title: 'External project',
      stories: [{ id: 'STORY-001', title: 'Mobile work', repository: 'mobile' }]
    }]
  }));
  await assert.rejects(
    () => createJiraWritePlan(root, 'INIT-POLICY', { connection, fetchImpl: noNetwork }),
    /outside the configured allowedProjects/
  );
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
  receipt.planSha256 = 'tampered';
  await writeFile(
    path.join(initiativeDir(root, created.portfolio, 'INIT-JIRA'), 'context/jira/receipts/create-story-STORY-001.json'),
    JSON.stringify(receipt, null, 2)
  );
  await assert.rejects(() => applyJiraWritePlan(root, 'INIT-JIRA', {
    planSha256: planned.plan.sha256,
    confirmation: 'INIT-JIRA',
    connection,
    fetchImpl,
    actor: 'owner@example.com'
  }), /does not match the reviewed write plan/);
});
