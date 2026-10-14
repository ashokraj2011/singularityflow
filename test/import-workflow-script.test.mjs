/**
 * `import-workflow.sh <bundle.json>`: one workflow bundle in, the workflow live, no review step.
 *
 * The script reads fields of the CLI's JSON answers (status, planSha256, destinationAuthority,
 * branch, commit, pushed), so a renamed field would break it silently. This runs it for real.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { initializeDefinition } from '../src/config.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(packageRoot, 'import-workflow.sh');

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('one bundle path imports the workflow and activates it; running it again changes nothing',
  { skip: process.platform === 'win32' && 'the script is for a POSIX shell' }, async (t) => {
    const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-import-script-')));
    t.after(() => rm(base, { recursive: true, force: true }));
    // This checkout's CLI, ahead of any installed copy on PATH.
    const shims = path.join(base, 'bin');
    await mkdir(shims);
    await writeFile(path.join(shims, 'singularity-flow'),
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(packageRoot, 'bin', 'singularity-flow.mjs'))} "$@"\n`);
    await chmod(path.join(shims, 'singularity-flow'), 0o755);
    const env = {
      ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1',
      PATH: `${shims}${path.delimiter}${process.env.PATH}`,
      SINGULARITY_FLOW_TEST_IDENTITY: 'Import Script Test',
      SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(base, 'outbox'),
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active-workspace.json'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json')
    };
    const repository = async (name) => {
      const root = path.join(base, name);
      await mkdir(root);
      await initializeDefinition(root);
      git(root, 'init', '-q', '-b', 'main');
      git(root, 'config', 'user.name', 'Import Script Test');
      git(root, 'config', 'user.email', 'import-script@example.test');
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
    const bundle = path.join(base, 'portable-feature.json');
    const exported = spawnSync(process.execPath, [path.join(packageRoot, 'bin', 'singularity-flow.mjs'),
      'workflow', 'export', '--workflow', 'portable-feature', '--out', bundle], { cwd: source, encoding: 'utf8', env });
    assert.equal(exported.status, 0, exported.stderr);

    const run = () => spawnSync('bash', [script, bundle], { cwd: root, encoding: 'utf8', env });
    const first = run();
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    assert.match(first.stdout, /Done: portable-feature is active/u);
    const approved = YAML.parse(git(root, '--git-dir', remote, 'show', 'sflow/config:singularity/workflow.yml'));
    assert.equal(approved.workTypes['portable-feature']?.label, 'Portable feature', 'merged into the approved configuration');
    assert.equal(git(root, 'status', '--porcelain'), '', 'the checkout itself was not edited');

    const again = run();
    assert.equal(again.status, 0, `${again.stdout}\n${again.stderr}`);
    assert.match(again.stdout, /Nothing to import/u);

    const usage = spawnSync('bash', [script], { cwd: root, encoding: 'utf8', env });
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /Usage: .*<workflow-bundle\.json>/u);

    // Run from a repository that is not set up (the Singularity Flow checkout itself, say), it used
    // to report only "singularity/workflow.yml does not exist".
    const plain = path.join(base, 'plain');
    await mkdir(plain);
    git(plain, 'init', '-q', '-b', 'main');
    git(plain, '-c', 'user.name=Import Script Test', '-c', 'user.email=import-script@example.test',
      'commit', '-q', '--allow-empty', '-m', 'empty');
    const elsewhere = spawnSync('bash', [script, bundle], { cwd: plain, encoding: 'utf8', env });
    assert.equal(elsewhere.status, 1);
    assert.match(elsewhere.stderr, /not set up for Singularity Flow/u);
    assert.match(elsewhere.stderr, /cd into your project's repository/u);
  });
