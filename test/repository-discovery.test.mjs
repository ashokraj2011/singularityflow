import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  prepareRepositorySelection, repositoryCatalog, repositoryProviders
} from '../src/repositories/catalog.mjs';
import { executeGitHubGraphql } from '../src/repositories/github-provider.mjs';
import {
  readProviderCache, recordRepositoryDiscoveryAudit
} from '../src/repositories/store.mjs';
import { repositoryContinuationCommand } from '../src/commands/repositories.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-rds-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'workspace.json'), JSON.stringify({
    repositories: {
      alpha: { url: 'https://github.example/acme/alpha.git' },
      beta: { url: 'https://github.example/acme/beta.git' }
    }
  }));
  const workspaceFile = path.join(root, 'workspaces.json');
  await writeFile(workspaceFile, JSON.stringify({
    schemaVersion: 1,
    workspaces: [{ id: 'fixture', path: workspace }]
  }));
  const leadFile = path.join(root, 'leads.json');
  await writeFile(leadFile, JSON.stringify({ schemaVersion: 1, leads: [] }));
  return {
    root,
    localOptions: { workspaceFile, leadFile },
    storeOptions: { env: { SINGULARITY_FLOW_REPOSITORY_CATALOG: path.join(root, 'catalog') } }
  };
}

function fakeGraphql(responder, observed = {}) {
  return (_executable, args, options) => {
    observed.args = args;
    observed.environment = options.env;
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    const chunks = [];
    child.stdin.on('data', (chunk) => chunks.push(chunk));
    child.stdin.on('finish', () => {
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      observed.requests ??= [];
      observed.requests.push(request);
      queueMicrotask(async () => {
        child.stdout.end(JSON.stringify(await responder(request)));
        child.stderr.end();
        child.emit('close', 0);
      });
    });
    return child;
  };
}

const launch = {
  executable: '/approved/gh', physicalExecutable: '/approved/gh',
  arguments: (args) => args, spawnOptions: {}
};

function githubNode(overrides = {}) {
  return {
    id: 'R_123', name: 'alpha', nameWithOwner: 'acme/alpha',
    url: 'https://github.example/acme/alpha',
    sshUrl: 'git@github.example:acme/alpha.git',
    visibility: 'PRIVATE', viewerPermission: 'WRITE', isArchived: false, isFork: false,
    defaultBranchRef: { name: 'main' }, ...overrides
  };
}

test('provider descriptors and known catalog reads do not execute Git or a provider', async (t) => {
  const isolated = await fixture(t);
  let spawned = false;
  const providers = repositoryProviders({
    providerOptions: { spawnCommand() { spawned = true; throw new Error('must not run'); } }
  });
  assert.equal(providers.authenticationChecked, false);
  assert.equal(spawned, false);
  const first = await repositoryCatalog({ scope: 'known', limit: 1 }, {
    ...isolated,
    providerOptions: { spawnCommand() { spawned = true; throw new Error('must not run'); } }
  });
  assert.equal(spawned, false);
  assert.equal(first.repositories.length, 1);
  assert.ok(first.repositories[0].selectionRef.startsWith('rdssel_'));
  assert.equal(first.enumeration, 'more');
  const second = await repositoryCatalog({
    scope: 'known', limit: 1, cursor: first.nextCursor
  }, isolated);
  assert.equal(second.repositories.length, 1);
  assert.notEqual(second.repositories[0].recordRef, first.repositories[0].recordRef);
  assert.equal(second.enumeration, 'exhausted');
  assert.equal(second.nextCursor, null);
  const replay = await repositoryCatalog({
    scope: 'known', limit: 1, cursor: first.nextCursor
  }, isolated);
  assert.deepEqual(replay, second, 'the same cursor replays its sealed page exactly');
});

test('GitHub provider uses fixed stdin GraphQL, strips ambient tokens, and validates nodes', async () => {
  const observed = {};
  const result = await executeGitHubGraphql({
    host: 'github.example', query: 'query Fixed { viewer { id } }', operationName: 'Fixed'
  }, {
    launch,
    environment: { PATH: '/approved', GH_TOKEN: 'must-not-cross', DEBUG: 'must-not-cross' },
    spawnCommand: fakeGraphql(() => ({ data: { viewer: { id: 'V_1' } } }), observed)
  });
  assert.equal(result.envelope.data.viewer.id, 'V_1');
  assert.deepEqual(observed.args, ['api', 'graphql', '--hostname', 'github.example', '--method', 'POST', '--input', '-']);
  assert.equal(observed.environment.GH_TOKEN, undefined);
  assert.equal(observed.environment.DEBUG, undefined);
  assert.equal(JSON.stringify(observed.args).includes('query Fixed'), false);
  assert.equal(observed.requests[0].operationName, 'Fixed');
});

test('provider selection is opaque and revalidates viewer, native identity, and locator', async (t) => {
  const isolated = await fixture(t);
  const observed = {};
  const providerOptions = {
    launch,
    environment: { PATH: '/approved' },
    spawnCommand: fakeGraphql((request) => request.operationName === 'RdsRepositoryById'
      ? {
          data: { viewer: { id: 'V_1', login: 'developer' }, node: githubNode(),
            rateLimit: { cost: 1, remaining: 99, resetAt: '2026-09-10T12:00:00Z' } }
        }
      : {
          data: { viewer: { id: 'V_1', login: 'developer', repositories: {
            nodes: [githubNode()], pageInfo: { hasNextPage: false, endCursor: null }
          } }, rateLimit: { cost: 1, remaining: 99, resetAt: '2026-09-10T12:00:00Z' } }
        }, observed)
  };
  const page = await repositoryCatalog({
    scope: 'provider', host: 'github.example', audience: 'native', limit: 10
  }, { ...isolated, providerOptions });
  assert.equal(page.repositories.length, 1);
  assert.equal(page.repositories[0].locators.https, 'https://github.example/acme/alpha.git');
  const prepared = await prepareRepositorySelection(
    page.repositories[0].selectionRef, 'inspect', { ...isolated, providerOptions }
  );
  assert.equal(prepared.status, 'ready');
  assert.equal(prepared.locator, 'https://github.example/acme/alpha.git');
  assert.deepEqual(prepared.effects, {
    mapped: false, cloned: false, workspaceCreated: false, proposalCreated: false
  });
  assert.deepEqual(observed.requests.map((request) => request.operationName), [
    'RdsAffiliatedRepositories', 'RdsRepositoryById'
  ]);
});

test('model projection keeps local-known rows bounded and withholds provider repository names', async (t) => {
  const isolated = await fixture(t);
  const providerOptions = {
    launch,
    environment: { PATH: '/approved' },
    spawnCommand: fakeGraphql(() => ({
      data: { viewer: { id: 'V_1', login: 'developer', repositories: {
        nodes: [githubNode()], pageInfo: { hasNextPage: false, endCursor: null }
      } }, rateLimit: { cost: 1, remaining: 99, resetAt: '2026-09-10T12:00:00Z' } }
    }))
  };
  const known = await repositoryCatalog({ scope: 'known', audience: 'model', limit: 10 }, isolated);
  assert.equal(known.repositories.length, 2);
  const provider = await repositoryCatalog({
    scope: 'provider', host: 'github.example', audience: 'model', limit: 10
  }, { ...isolated, providerOptions });
  assert.equal(provider.repositories.length, 0);
  assert.equal(provider.delivery.withheld, 1);
  assert.equal(provider.request.providerDisclosure, 'withheld');
  assert.ok(provider.reasons.includes('REPOSITORY_DISCLOSURE_REFUSED'));
  assert.doesNotMatch(JSON.stringify(provider), /acme\/alpha/);
  const disclosed = await repositoryCatalog({
    scope: 'provider', host: 'github.example', audience: 'model', limit: 10,
    discloseProviderResults: true
  }, { ...isolated, providerOptions });
  assert.equal(disclosed.request.providerDisclosure, 'explicit');
  assert.equal(disclosed.repositories[0].display.nameWithOwner, 'acme/alpha');
  assert.equal(disclosed.delivery.privateOrInternal, 1);
});

test('concurrent continuation reads perform one provider request and replay one sealed page', async (t) => {
  const isolated = await fixture(t);
  const observed = {};
  const providerOptions = {
    launch,
    environment: { PATH: '/approved' },
    spawnCommand: fakeGraphql(async (request) => {
      const after = request.variables?.after;
      if (after) await new Promise((resolve) => setTimeout(resolve, 75));
      const node = after
        ? githubNode({ id: 'R_456', name: 'beta', nameWithOwner: 'acme/beta',
          url: 'https://github.example/acme/beta', sshUrl: 'git@github.example:acme/beta.git' })
        : githubNode();
      return {
        data: { viewer: { id: 'V_1', login: 'developer', repositories: {
          nodes: [node], pageInfo: { hasNextPage: !after, endCursor: after ? null : 'cursor-1' }
        } }, rateLimit: { cost: 1, remaining: 99, resetAt: '2026-09-10T12:00:00Z' } }
      };
    }, observed)
  };
  const first = await repositoryCatalog({
    scope: 'provider', host: 'github.example', audience: 'native', limit: 1
  }, { ...isolated, providerOptions });
  const continuation = {
    scope: 'provider', host: 'github.example', account: first.request.accountBinding,
    audience: 'native', limit: 1, cursor: first.nextCursor
  };
  const [left, right] = await Promise.all([
    repositoryCatalog(continuation, { ...isolated, providerOptions }),
    repositoryCatalog(continuation, { ...isolated, providerOptions })
  ]);
  assert.deepEqual(left, right);
  assert.equal(left.repositories[0].display.nameWithOwner, 'acme/beta');
  assert.equal(observed.requests.length, 2, 'one initial read plus one claimed continuation');
});

test('corrupt provider cache is a safe miss and local audit records are content-free', async (t) => {
  const isolated = await fixture(t);
  await repositoryCatalog({ scope: 'known', limit: 1 }, isolated);
  const key = 'fixture-cache-key';
  const cacheFile = path.join(
    isolated.root, 'catalog', 'cache',
    `${createHash('sha256').update(key).digest('hex')}.json`
  );
  await writeFile(cacheFile, '{not-json', { mode: 0o600 });
  assert.equal(await readProviderCache(key, isolated.storeOptions), null);

  await recordRepositoryDiscoveryAudit({
    surface: 'copilot', operation: 'search', scope: 'provider', provider: 'github',
    host: 'github.secret.example', cacheOutcome: 'miss', enumeration: 'more',
    resultCount: 3, providerRequestCount: 1, latencyMs: 24,
    selectedAction: 'none',
    query: 'private-query-must-not-persist',
    repository: 'secret-owner/secret-repository',
    account: 'secret-user'
  }, isolated.storeOptions);
  const audit = await readFile(path.join(
    isolated.root, 'catalog', 'audit', 'events.jsonl'
  ), 'utf8');
  assert.doesNotMatch(audit, /github\.secret\.example|private-query|secret-owner|secret-user/);
  const record = JSON.parse(audit.trim());
  assert.equal(record.surface, 'copilot');
  assert.match(record.hostFingerprint, /^local-hmac:[a-f0-9]{64}$/);
  assert.equal(record.resultCount, 3);
});

test('search continuation preserves the literal query without enabling shell expansion', () => {
  const page = {
    nextCursor: 'rdsc_next',
    request: {
      scope: 'provider', providerInstanceId: 'github:github.example',
      accountBinding: 'local-hmac:abc', audience: 'terminal', limit: 25,
      offline: false, providerDisclosure: 'not_applicable'
    }
  };
  const posix = repositoryContinuationCommand(page, {
    action: 'search', query: "owner/$(touch unsafe) o'hare", surface: 'copilot', platform: 'darwin'
  });
  assert.equal(posix,
    "singularity-flow repositories search 'owner/$(touch unsafe) o'\"'\"'hare' --scope provider --host github.example --account local-hmac:abc --audience terminal --limit 25 --surface copilot --cursor rdsc_next");
  const powershell = repositoryContinuationCommand(page, {
    action: 'search', query: "owner/$env:USER o'hare", platform: 'win32'
  });
  assert.match(powershell, /^& singularity-flow repositories search 'owner\/\$env:USER o''hare'/);
});
