/**
 * A file named on the command line is the file where the person ran the command. `[UXH]`
 *
 * Outside a repository the CLI moves into the selected workspace's checkout before a command runs,
 * so `workflow import team.json`, run from the folder holding the bundle, refused with "Workflow
 * bundle does not exist: <repository>/team.json". And the preview's "Apply it" line dropped
 * `--propose`, so running it changed only this checkout's files and the import never reached review.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { initializeDefinition } from '../src/config.mjs';
import { commandLineFile } from '../src/util.mjs';

const executable = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'singularity-flow.mjs');

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('a named file is read where the person is, else under the root; written there only from outside', async (t) => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-cli-paths-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const outside = path.join(base, 'downloads');
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(outside, 'here.json'), '{}');
  await writeFile(path.join(root, 'rooted.json'), '{}');
  const previous = globalThis.__SINGULARITY_FLOW_INVOCATION_DIRECTORY;
  t.after(() => { globalThis.__SINGULARITY_FLOW_INVOCATION_DIRECTORY = previous; });

  globalThis.__SINGULARITY_FLOW_INVOCATION_DIRECTORY = outside;
  assert.equal(commandLineFile(root, 'here.json', { reads: true }), path.join(outside, 'here.json'));
  assert.equal(commandLineFile(root, 'rooted.json', { reads: true }), path.join(root, 'rooted.json'), 'a path that only exists under the root still works');
  assert.equal(commandLineFile(root, 'missing.json', { reads: true }), path.join(outside, 'missing.json'), 'a refusal names where the person looked');
  assert.equal(commandLineFile(root, 'out.json'), path.join(outside, 'out.json'), 'from outside, a written file lands where the person is');

  globalThis.__SINGULARITY_FLOW_INVOCATION_DIRECTORY = path.join(root, 'docs');
  assert.equal(commandLineFile(root, 'out.json'), path.join(root, 'out.json'), 'inside the repository, written files keep their old place');
  assert.equal(commandLineFile(root, 'rooted.json', { reads: true }), path.join(root, 'rooted.json'));
  assert.equal(commandLineFile(root, path.join(outside, 'here.json'), { reads: true }), path.join(outside, 'here.json'), 'an absolute path is itself');
});

test('workflow import and export from a folder outside the selected workspace use that folder', async (t) => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-cli-paths-flow-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = {
    ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Command Line Paths Test',
    SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(base, 'outbox'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active-workspace.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json')
  };
  const flow = (cwd, ...args) => spawnSync(process.execPath, [executable, ...args], { cwd, encoding: 'utf8', env });
  const repository = async (name) => {
    const root = path.join(base, name);
    await mkdir(root);
    await initializeDefinition(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Command Line Paths Test');
    git(root, 'config', 'user.email', 'paths@example.test');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'initialize workflow configuration');
    return root;
  };
  const source = await repository('source');
  const root = await repository('destination');
  const remote = path.join(base, 'destination.git');
  git(base, 'init', '-q', '--bare', '--initial-branch=main', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', 'origin', 'HEAD:refs/heads/main', 'HEAD:refs/heads/sflow/config');
  git(root, 'fetch', '-q', 'origin');
  const configuration = YAML.parse(await readFile(path.join(source, 'singularity/workflow.yml'), 'utf8'));
  configuration.workTypes['portable-feature'] = { ...structuredClone(configuration.workTypes.feature), label: 'Portable feature' };
  await writeFile(path.join(source, 'singularity/workflow.yml'), YAML.stringify(configuration));

  const downloads = path.join(base, 'downloads');
  await mkdir(downloads);
  const exported = flow(source, 'workflow', 'export', '--workflow', 'portable-feature', '--out', path.join(downloads, 'team.json'));
  assert.equal(exported.status, 0, exported.stderr);
  for (const args of [['workspace', 'adopt', root, '--id', 'paths', '--name', 'Paths', '--base', path.join(base, 'workspaces'), '--confirm', 'paths'], ['workspace', 'use', 'paths']]) {
    const result = flow(root, ...args);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }

  const preview = flow(downloads, 'workflow', 'import', 'team.json', '--dry-run', '--propose');
  assert.equal(preview.status, 0, preview.stderr || preview.stdout);
  const apply = /^ {2}Apply it: singularity-flow (.+)$/mu.exec(preview.stdout)?.[1];
  assert.ok(apply?.endsWith(' --propose'), `the apply line keeps --propose: ${apply}`);
  const plain = flow(downloads, 'workflow', 'import', 'team.json', '--dry-run');
  assert.doesNotMatch(/Apply it: .*$/mu.exec(plain.stdout)?.[0] ?? '', /--propose/u, 'a preview without --propose prints none');

  const imported = flow(downloads, ...apply.split(' '));
  assert.equal(imported.status, 0, imported.stderr || imported.stdout);
  assert.match(imported.stdout, /Workflow configuration proposal (?:published|saved locally)/u);
  assert.equal(git(root, 'status', '--porcelain'), '', 'the checkout was not changed; the import went to review');

  const out = flow(downloads, 'workflow', 'export', '--workflow', 'feature', '--out', 'feature.json');
  assert.equal(out.status, 0, out.stderr);
  assert.ok(existsSync(path.join(downloads, 'feature.json')));
  assert.equal(existsSync(path.join(root, 'feature.json')), false, 'nothing was written into the workspace checkout');
});
