import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { withApprovedConfigurationRead } from '../src/approved-configuration-reader.mjs';
import { configurationReadRoot } from '../src/configuration-read-scope.mjs';
import { run } from '../src/util.mjs';

const WORKFLOW_PATH = 'singularity/workflow.yml';
const AUTHORITY_PATH = `singularity/sgos/program-authorities/sha256-${'a'.repeat(64)}.json`;
const UNRELATED_PATH = 'singularity/templates/unrelated.md';
const SELECTED_PATHS = [WORKFLOW_PATH, AUTHORITY_PATH];

const CONTENT = Object.freeze({
  [WORKFLOW_PATH]: 'version: 1\n',
  [AUTHORITY_PATH]: '{"approved":true}\n',
  [UNRELATED_PATH]: '# Unrelated approved template\n'
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function listFiles(root, relative = '') {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files.sort();
}

async function applicationRepository(requestedRoot = null) {
  const root = requestedRoot ?? await mkdtemp(path.join(os.tmpdir(), 'sflow-approved-reader-'));
  if (requestedRoot) await mkdir(root, { recursive: true });
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Approved Reader Tester'], { cwd: root });
  run('git', ['config', 'user.email', 'approved-reader@example.test'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# Application\n');
  run('git', ['add', 'README.md'], { cwd: root });
  run('git', ['commit', '-qm', 'application'], { cwd: root });
  return root;
}

async function commitBranch(root, branch, content, message) {
  run('git', ['switch', '-q', '--orphan', branch], { cwd: root });
  for (const [relative, bytes] of Object.entries(content)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), bytes);
  }
  run('git', ['add', '-A'], { cwd: root });
  run('git', ['commit', '-qm', message], { cwd: root });
  run('git', ['switch', '-q', 'main'], { cwd: root });
}

/** An application checkout with an approved sflow/config head holding CONTENT. */
async function approvedFixture({ root: requestedRoot = null } = {}) {
  const root = await applicationRepository(requestedRoot);
  await commitBranch(root, 'sflow/config', CONTENT, 'approved configuration');
  return root;
}

/** The `state` branch's configuration copy, self-consistent manifest and all, with no sflow/config. */
async function stateMirrorFixture() {
  const root = await applicationRepository();
  const sourceCommit = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
  const manifest = {
    format: 'singularity-flow-configuration-mirror/v2',
    layout: 'canonical-paths',
    source: { branch: 'sflow/config', commit: sourceCommit },
    files: Object.fromEntries(Object.entries(CONTENT).map(([relative, bytes]) => [relative, sha256(bytes)]))
  };
  await commitBranch(root, 'state', { ...CONTENT, 'configuration/manifest.json': `${JSON.stringify(manifest, null, 2)}\n` },
    'state mirror');
  return root;
}

async function readMountedFiles(root, options = {}) {
  return withApprovedConfigurationRead(root, async (authority) => ({
    authority,
    files: await listFiles(configurationReadRoot(root))
  }), {
    preferAuthority: true,
    refreshAuthority: false,
    ...options
  });
}

test('selected approved-configuration reads materialize only workflow and requested authority bytes', async () => {
  const root = await approvedFixture();
  try {
    const selected = await readMountedFiles(root, { selectPaths: SELECTED_PATHS });
    assert.equal(selected.authority.kind, 'approved-configuration-ref');
    assert.deepEqual(selected.files, [...SELECTED_PATHS].sort());

    const full = await readMountedFiles(root);
    assert.equal(full.authority.kind, 'approved-configuration-ref');
    assert.deepEqual(full.files, Object.keys(CONTENT).sort(),
      'callers that omit selectPaths still receive the complete approved configuration');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The configuration-history analysis's F1 (CH-F1, SCF:REQ-001): with sflow/config missing, a contributor's ordinary push
// to `state` (a self-consistent manifest) governed new work. The copy is never read as configuration.
test('the state branch\'s configuration copy is never read as configuration [SCF:REQ-001, CH-F1]', async () => {
  const root = await stateMirrorFixture();
  try {
    assert.equal(await withApprovedConfigurationRead(root, async (authority) => authority, {
      preferAuthority: true, refreshAuthority: false
    }), null, 'no approved authority: the copy is not one');
    await mkdir(path.join(root, 'singularity'), { recursive: true });
    await writeFile(path.join(root, WORKFLOW_PATH), 'version: 1\n# this checkout\n');
    const read = await withApprovedConfigurationRead(root, async (authority) => ({
      authority, workflow: await readFile(path.join(configurationReadRoot(root), WORKFLOW_PATH), 'utf8').catch(() => null)
    }), { refreshAuthority: false });
    assert.equal(read.authority.kind, 'working-tree', 'a repository with no sflow/config keeps its own files');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('outside a Story checkout an approved read uses sflow/config, not the checkout\'s singularity/ files [SCF:REQ-001]', async () => {
  const root = await approvedFixture();
  try {
    await mkdir(path.join(root, 'singularity'), { recursive: true });
    await writeFile(path.join(root, WORKFLOW_PATH), 'version: 1\n# a stale copy in the application checkout\n');
    const outside = await withApprovedConfigurationRead(root, async (authority) => ({
      authority, workflow: await readFile(path.join(configurationReadRoot(root), WORKFLOW_PATH), 'utf8')
    }), { refreshAuthority: false });
    assert.equal(outside.authority.kind, 'approved-configuration-ref');
    assert.equal(outside.workflow, CONTENT[WORKFLOW_PATH]);
    // A Story checkout's pinned copy is its configuration.
    await writeFile(path.join(root, 'singularity', 'configuration-source.json'), '{}\n');
    const pinned = await withApprovedConfigurationRead(root, async (authority) => authority, { refreshAuthority: false });
    assert.equal(pinned.kind, 'working-tree');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('selected approved-configuration reads fail closed on repository escapes', async () => {
  const root = await approvedFixture();
  let callbackCalled = false;
  try {
    await assert.rejects(
      () => withApprovedConfigurationRead(root, () => {
        callbackCalled = true;
      }, {
        preferAuthority: true,
        refreshAuthority: false,
        selectPaths: [WORKFLOW_PATH, '../outside.json']
      }),
      (error) => {
        assert.equal(error?.code, 'APPROVED_CONFIGURATION_SELECTION_INVALID', error?.stack);
        return true;
      }
    );
    assert.equal(callbackCalled, false, 'an invalid selection is rejected before mounting the read scope');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('nested approved reads reuse one authority and enforce a narrower selected-path view', async () => {
  const root = await approvedFixture();
  try {
    // If the nested reader attempted another online authority observation this deliberately invalid
    // remote would fail the test. The outer verified scope is the operation's one authority read.
    run('git', ['remote', 'add', 'origin', path.join(root, 'missing-authority.git')], { cwd: root });
    const result = await withApprovedConfigurationRead(root, async (outerAuthority) => {
      assert.deepEqual(await listFiles(configurationReadRoot(root)), Object.keys(CONTENT).sort());
      return withApprovedConfigurationRead(root, async (innerAuthority) => ({
        outerAuthority,
        innerAuthority,
        files: await listFiles(configurationReadRoot(root))
      }), {
        preferAuthority: true,
        selectPaths: SELECTED_PATHS
      });
    }, {
      preferAuthority: true,
      refreshAuthority: false
    });
    assert.equal(result.innerAuthority.commit, result.outerAuthority.commit);
    assert.deepEqual(result.files, [...SELECTED_PATHS].sort(),
      'a nested selected-path read must not see unrelated files from the outer full scope');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a positively absent workspace authority never falls through to a stale local configuration head', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-absent-authority-workspace-'));
  const root = await approvedFixture({ root: path.join(base, 'repos/application') });
  const authority = path.join(base, 'empty-authority.git');
  const selection = path.join(base, 'active-workspace.json');
  const registry = path.join(base, 'workspaces.json');
  const previousSelection = process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
  const previousRegistry = process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
  try {
    run('git', ['init', '--bare', '-q', authority], { cwd: base });
    run('git', ['remote', 'add', 'origin', authority], { cwd: root });
    const workspace = {
      version: 1,
      id: 'local--absent-authority',
      name: 'Absent Authority',
      anchor: { provider: 'workspace', siteId: 'local', key: 'absent-authority', title: 'Absent Authority' },
      leadRepository: 'application',
      capabilityAuthority: { url: authority },
      repositories: {
        application: {
          id: 'application', url: authority, defaultBranch: 'main', required: true,
          path: path.relative(base, root), capabilities: [],
          clone: { mode: 'full', sparseCone: [], fallback: 'refuse' }
        }
      },
      capabilities: [],
      directories: { repositories: 'repos', documents: 'documents', logs: 'logs', jiraCache: 'cache/jira' },
      createdAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:00.000Z'
    };
    await writeFile(path.join(base, 'workspace.json'), `${JSON.stringify(workspace, null, 2)}\n`);
    await writeFile(selection, `${JSON.stringify({
      schemaVersion: 1,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspacePath: base,
      anchorKey: workspace.anchor.key,
      repositoryId: 'application',
      repositoryPath: root,
      canonicalRepositoryPath: root,
      checkoutPath: root,
      repositoryState: 'ready',
      branch: 'main',
      capabilities: [],
      repositoryCapabilities: [],
      storyId: null,
      selectedAt: '2026-08-31T00:00:00.000Z'
    }, null, 2)}\n`);
    await writeFile(registry, `${JSON.stringify({ schemaVersion: 1, workspaces: [] }, null, 2)}\n`);
    process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = selection;
    process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = registry;

    const selected = await withApprovedConfigurationRead(root, async (selectedAuthority) => selectedAuthority, {
      preferAuthority: true,
      refreshAuthority: true
    });
    assert.equal(selected, null,
      'the stale local configuration head must not substitute for an explicitly configured authority that is absent');
  } finally {
    if (previousSelection == null) delete process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
    else process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = previousSelection;
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
    else process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = previousRegistry;
    await rm(base, { recursive: true, force: true });
  }
});

test('an unreadable configured remote fails closed instead of selecting a stale local head', async () => {
  const root = await approvedFixture();
  const previousSelection = process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
  const previousRegistry = process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
  try {
    process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = path.join(root, 'no-active-workspace.json');
    process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = path.join(root, 'no-workspace-registry.json');
    run('git', ['remote', 'add', 'origin', path.join(root, 'authority.git')], { cwd: root });
    run('git', ['config', '--unset-all', 'remote.origin.url'], { cwd: root, allowFailure: true });
    await assert.rejects(
      () => withApprovedConfigurationRead(root, () => null, {
        preferAuthority: true,
        refreshAuthority: true
      }),
      (error) => {
        assert.match(error?.code ?? '', /^(?:STORY_CONFIGURATION_AUTHORITY_UNAVAILABLE|REMOTE_)/,
          error?.stack);
        return true;
      }
    );
  } finally {
    if (previousSelection == null) delete process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
    else process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = previousSelection;
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
    else process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = previousRegistry;
    await rm(root, { recursive: true, force: true });
  }
});
