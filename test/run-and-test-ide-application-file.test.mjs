import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { readApplicationFile } from '../src/capability-application-file.mjs';

const CLI = path.resolve('bin/singularity-flow.mjs');
const APPLICATION = {
  start: [{
    id: 'api', argv: ['./mvnw', '-q', 'spring-boot:run'], url: 'http://127.0.0.1:8080/', ready: { http: '/actuator/health', timeoutMs: 180_000 },
    environments: ['dev', 'qa'], arguments: { dev: ['-Dspring-boot.run.profiles=dev'], qa: ['-Dspring-boot.run.profiles=qa'] },
    debug: { runtime: 'java', port: 5005 }
  }]
};

function git(cwd, args, env) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout;
}

test('readApplicationFile reads the block or a file holding application:, bounded, and refuses anything else', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sflow-application-file-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'block.yml'), YAML.stringify(APPLICATION));
  await writeFile(path.join(directory, 'wrapped.json'), JSON.stringify({ application: APPLICATION }));
  await writeFile(path.join(directory, 'huge.yml'), `start: []\n# ${'x'.repeat(300 * 1024)}\n`);
  await writeFile(path.join(directory, 'scalar.yml'), 'just text\n');
  assert.deepEqual(readApplicationFile('block.yml', { cwd: directory }), APPLICATION);
  assert.deepEqual(readApplicationFile(path.join(directory, 'wrapped.json')), APPLICATION);
  assert.equal(readApplicationFile(''), null, 'an empty FILE removes the block');
  const refused = (file, pattern) => assert.throws(() => readApplicationFile(file, { cwd: directory }),
    (error) => error.code === 'CAPABILITY_APPLICATION_FILE_INVALID' && pattern.test(error.message) && /Nothing was written\.$/u.test(error.message));
  refused('huge.yml', /larger than 256 KiB/u);
  refused('scalar.yml', /must hold the application block/u);
  refused('missing.yml', /does not exist/u);
  refused('.', /not a directory|regular file/u);
});

test('capability edit --lead --application-file proposes the block on a review branch, validated first', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'sflow-application-proposal-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = {
    ...process.env, SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Proposal Tester',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'proposal-tester@example.invalid'
  };
  const remotes = {};
  for (const name of ['platform', 'service']) {
    remotes[name] = path.join(base, `${name}.git`);
    git(base, ['init', '-q', '-b', 'main', '--bare', remotes[name]], env);
    const seed = path.join(base, `${name}-seed`);
    git(base, ['init', '-q', '-b', 'main', seed], env);
    await writeFile(path.join(seed, 'README.md'), `# ${name}\n`);
    git(seed, ['add', '-A'], env);
    git(seed, ['commit', '-qm', 'Initial'], env);
    git(seed, ['push', '-q', remotes[name], 'main:main'], env);
  }
  const sflow = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: base, encoding: 'utf8', env, timeout: 120_000 });
  const mapped = sflow(['capability', 'map', 'service', '--lead', remotes.platform, '--kind', 'delivery', '--repository', remotes.service, '--json']);
  assert.equal(mapped.status, 0, mapped.stderr);
  const mapping = JSON.parse(mapped.stdout);
  // The reviewer's merge, as the organisation suites simulate it.
  const review = path.join(base, 'review');
  git(base, ['clone', '-q', '--no-local', remotes.platform, review], env);
  git(review, ['fetch', '-q', 'origin', mapping.branch], env);
  git(review, ['switch', '-q', mapping.baseBranch], env);
  git(review, ['merge', '--ff-only', `origin/${mapping.branch}`], env);
  git(review, ['push', '-q', 'origin', `HEAD:${mapping.baseBranch}`], env);

  const invalid = path.join(base, 'invalid.yml');
  await writeFile(invalid, YAML.stringify({ start: [{ ...APPLICATION.start[0], arguments: { uat: ['-x'] } }] }));
  const branchesBefore = git(remotes.platform, ['for-each-ref', '--format=%(refname)'], env);
  const refused = sflow(['capability', 'edit', 'service', '--lead', remotes.platform, '--application-file', invalid, '--mode', 'set', '--json']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr + refused.stdout, /arguments\.uat names an environment the entry does not list/u);
  assert.equal(git(remotes.platform, ['for-each-ref', '--format=%(refname)'], env), branchesBefore, 'a refused block proposes nothing');

  const file = path.join(base, 'application.yml');
  await writeFile(file, YAML.stringify(APPLICATION));
  const edited = sflow(['capability', 'edit', 'service', '--lead', remotes.platform, '--application-file', file, '--mode', 'set', '--json']);
  assert.equal(edited.status, 0, edited.stderr);
  const proposal = JSON.parse(edited.stdout);
  const proposed = YAML.parse(git(remotes.platform, ['show', `${proposal.branch}:singularity/capabilities.yml`], env));
  assert.deepEqual(proposed.capabilities.service.application, APPLICATION);
  const approved = YAML.parse(git(remotes.platform, ['show', `${proposal.baseBranch}:singularity/capabilities.yml`], env));
  assert.equal(Object.hasOwn(approved.capabilities.service, 'application'), false, 'the approved map is unchanged until review');
});
