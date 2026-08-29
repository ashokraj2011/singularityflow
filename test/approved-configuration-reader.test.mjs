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

async function stateMirrorFixture({ mismatchedDigestPath = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-approved-reader-'));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Approved Reader Tester'], { cwd: root });
  run('git', ['config', 'user.email', 'approved-reader@example.test'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# Application\n');
  run('git', ['add', 'README.md'], { cwd: root });
  run('git', ['commit', '-qm', 'application'], { cwd: root });
  const sourceCommit = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();

  run('git', ['switch', '-q', '-c', 'state'], { cwd: root });
  for (const [relative, bytes] of Object.entries(CONTENT)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), bytes);
  }
  const files = Object.fromEntries(
    Object.entries(CONTENT).map(([relative, bytes]) => [relative, sha256(bytes)])
  );
  if (mismatchedDigestPath) files[mismatchedDigestPath] = '0'.repeat(64);
  const manifest = {
    format: 'singularity-flow-configuration-mirror/v2',
    layout: 'canonical-paths',
    source: { branch: 'sflow/config', commit: sourceCommit },
    files
  };
  await mkdir(path.join(root, 'configuration'), { recursive: true });
  await writeFile(
    path.join(root, 'configuration/manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  run('git', ['add', '-A'], { cwd: root });
  run('git', ['commit', '-qm', 'verified state mirror'], { cwd: root });
  run('git', ['switch', '-q', 'main'], { cwd: root });
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
  const root = await stateMirrorFixture();
  try {
    const selected = await readMountedFiles(root, { selectPaths: SELECTED_PATHS });
    assert.equal(selected.authority.kind, 'verified-state-mirror');
    assert.deepEqual(selected.files, [...SELECTED_PATHS].sort());

    const full = await readMountedFiles(root);
    assert.equal(full.authority.kind, 'verified-state-mirror');
    assert.deepEqual(full.files, Object.keys(CONTENT).sort(),
      'callers that omit selectPaths still receive the complete approved configuration');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('selected state reads verify only selected digests while full reads retain complete verification', async () => {
  const root = await stateMirrorFixture({ mismatchedDigestPath: UNRELATED_PATH });
  try {
    const selectedBytes = await withApprovedConfigurationRead(root, async () => readFile(
      path.join(configurationReadRoot(root), AUTHORITY_PATH), 'utf8'
    ), {
      preferAuthority: true,
      refreshAuthority: false,
      selectPaths: SELECTED_PATHS
    });
    assert.equal(selectedBytes, CONTENT[AUTHORITY_PATH]);

    await assert.rejects(
      () => readMountedFiles(root),
      (error) => {
        assert.equal(error?.code, 'STATE_CONFIGURATION_MIRROR_INVALID', error?.stack);
        assert.match(error.message, new RegExp(UNRELATED_PATH.replaceAll('/', '\\/')));
        return true;
      },
      'a full caller must still verify every manifest digest'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('selected approved-configuration reads fail closed on a requested digest mismatch', async () => {
  const root = await stateMirrorFixture({ mismatchedDigestPath: AUTHORITY_PATH });
  try {
    await assert.rejects(
      () => readMountedFiles(root, { selectPaths: SELECTED_PATHS }),
      (error) => {
        assert.equal(error?.code, 'STATE_CONFIGURATION_MIRROR_INVALID', error?.stack);
        assert.match(error.message, new RegExp(AUTHORITY_PATH.replaceAll('/', '\\/')));
        return true;
      }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('selected approved-configuration reads fail closed on repository escapes', async () => {
  const root = await stateMirrorFixture();
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
