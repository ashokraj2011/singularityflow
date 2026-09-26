import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CONFIGURATION_BRANCH, ensureConfigurationBranch, inspectApprovedSkillPackage,
  loadStoryConfigurationSnapshot
} from '../src/configuration-branch.mjs';
import { run } from '../src/util.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-skp-approved-bytes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const remote = path.join(root, 'authority.git');
  run('git', ['init', '-q', '-b', 'main', source], { cwd: root });
  run('git', ['config', 'user.name', 'SKP Tester'], { cwd: source });
  run('git', ['config', 'user.email', 'skp@example.com'], { cwd: source });
  await writeFile(path.join(source, 'README.md'), '# Application\n');
  run('git', ['add', '-A'], { cwd: source });
  run('git', ['commit', '-qm', 'application'], { cwd: source });
  run('git', ['clone', '-q', '--bare', source, remote], { cwd: root });
  await ensureConfigurationBranch(remote);
  const publisher = path.join(root, 'publisher');
  run('git', ['clone', '-q', '-b', CONFIGURATION_BRANCH, remote, publisher], { cwd: root });
  run('git', ['config', 'user.name', 'SKP Publisher'], { cwd: publisher });
  run('git', ['config', 'user.email', 'publisher@example.com'], { cwd: publisher });
  const skill = path.join(publisher, 'singularity/skills/exact');
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), '# Exact skill\n');
  return { root, remote, publisher, skill };
}

function publish(value) {
  run('git', ['add', '-A'], { cwd: value.publisher });
  run('git', ['commit', '-qm', 'approve skill tree'], { cwd: value.publisher });
  run('git', ['push', '-q', 'origin', CONFIGURATION_BRANCH], { cwd: value.publisher });
  return run('git', ['rev-parse', 'HEAD'], { cwd: value.publisher }).stdout.trim();
}

function authority(value, commit) {
  return { remote: value.remote, branch: CONFIGURATION_BRANCH, commit, source: 'configuration' };
}

test('approved skill snapshot and package digest use raw Git blobs across checkout conversions', async (t) => {
  const value = await fixture(t);
  await mkdir(path.join(value.skill, 'references'), { recursive: true });
  await writeFile(path.join(value.skill, 'references', 'guide.md'), 'Line one\nLine two\n');
  await writeFile(path.join(value.publisher, '.gitattributes'),
    'singularity/skills/exact/*.md text eol=crlf\n'
    + 'singularity/skills/exact/references/*.md text eol=crlf\n');
  const commit = publish(value);
  const rawEntry = Buffer.from(run('git', ['show', 'HEAD:singularity/skills/exact/SKILL.md'], {
    cwd: value.publisher, encoding: 'buffer'
  }).stdout);
  const rawReference = Buffer.from(run('git', [
    'show', 'HEAD:singularity/skills/exact/references/guide.md'
  ], { cwd: value.publisher, encoding: 'buffer' }).stdout);
  const converted = path.join(value.root, 'converted');
  run('git', ['clone', '-q', '-b', CONFIGURATION_BRANCH, value.remote, converted], { cwd: value.root });
  assert.match(await readFile(path.join(converted, 'singularity/skills/exact/SKILL.md'), 'utf8'), /\r\n/u,
    'the fixture must exercise Git checkout conversion');

  const snapshot = await loadStoryConfigurationSnapshot(authority(value, commit));
  const entry = snapshot.assets.find((item) => item.relative === 'singularity/skills/exact/SKILL.md');
  const reference = snapshot.assets.find((item) =>
    item.relative === 'singularity/skills/exact/references/guide.md');
  assert.deepEqual(entry.contents, rawEntry);
  assert.deepEqual(reference.contents, rawReference);
  assert.equal(entry.sha256, createHash('sha256').update(rawEntry).digest('hex'));
  const inspected = await inspectApprovedSkillPackage(snapshot, 'exact');
  assert.deepEqual(inspected.contents.get('SKILL.md'), rawEntry);
  assert.deepEqual(inspected.contents.get('references/guide.md'), rawReference);
  assert.equal(inspected.manifest.files.find((item) => item.path === 'SKILL.md').sha256,
    `sha256:${entry.sha256}`);
});

test('approved skill blob reads ignore ambient Git repository selectors', async (t) => {
  const value = await fixture(t);
  const commit = publish(value);
  const snapshot = await loadStoryConfigurationSnapshot(authority(value, commit), {
    env: { ...process.env, GIT_DIR: path.join(value.root, 'source', '.git'),
      GIT_WORK_TREE: path.join(value.root, 'source'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(value.root, 'source', '.git', 'objects') }
  });
  const inspected = await inspectApprovedSkillPackage(snapshot, 'exact');
  assert.equal(inspected.contents.get('SKILL.md').toString('utf8'), '# Exact skill\n');
  assert.equal(snapshot.sourceCommit, commit);
});

test('approved skill snapshot rejects a Git symlink that the filesystem walk would omit', async (t) => {
  const value = await fixture(t);
  await mkdir(path.join(value.skill, 'references'), { recursive: true });
  await symlink('../SKILL.md', path.join(value.skill, 'references', 'linked.md'));
  const commit = publish(value);
  await assert.rejects(loadStoryConfigurationSnapshot(authority(value, commit)), {
    code: 'CONFIGURATION_ASSET_NOT_REGULAR'
  });
});

test('approved skill snapshot rejects a Git submodule entry', async (t) => {
  const value = await fixture(t);
  run('git', ['add', '-A'], { cwd: value.publisher });
  const commitObject = run('git', ['rev-parse', 'HEAD'], { cwd: value.publisher }).stdout.trim();
  run('git', ['update-index', '--add', '--cacheinfo', `160000,${commitObject},singularity/skills/exact/nested`], {
    cwd: value.publisher
  });
  run('git', ['commit', '-qm', 'approve skill with gitlink'], { cwd: value.publisher });
  run('git', ['push', '-q', 'origin', CONFIGURATION_BRANCH], { cwd: value.publisher });
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: value.publisher }).stdout.trim();
  await assert.rejects(loadStoryConfigurationSnapshot(authority(value, commit)), {
    code: 'CONFIGURATION_ASSET_NOT_REGULAR'
  });
});

test('approved skill snapshot rejects tree paths excluded by configuration traversal', async (t) => {
  const value = await fixture(t);
  await writeFile(path.join(value.skill, 'bad:name.md'), 'omitted by the portable path policy\n');
  const commit = publish(value);
  await assert.rejects(loadStoryConfigurationSnapshot(authority(value, commit)), {
    code: 'SKP_PATH_REFUSED'
  });
});
