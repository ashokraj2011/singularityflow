import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const sha = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

test('a test command chosen in /sf-test-setup is previewed, proposed by its digest and activated, from the command line alone', { timeout: 600_000 }, async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-test-setup-proposal-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo'); const remote = path.join(base, 'remote.git');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Setup Tester',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'), SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(base, 'outbox'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Setup Tester', GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'setup.tester@example.invalid' };
  delete env.NODE_TEST_CONTEXT;
  const run = (command, args, { allowFailure = false } = {}) => {
    const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 300_000 });
    if (!allowFailure) assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const json = (...args) => JSON.parse(run(process.execPath, [cli, '--no-model', ...args, '--json']).stdout);
  const refused = (...args) => {
    const result = run(process.execPath, [cli, '--no-model', ...args, '--json'], { allowFailure: true });
    assert.notEqual(result.status, 0, `${args.join(' ')} should be refused`);
    return JSON.parse(result.stdout).error;
  };
  // Runs a printed command line through a shell, as Copilot would: its quoting must hold.
  const shell = (line) => JSON.parse(run('sh', ['-c', `${line.replace(/^singularity-flow /u, `'${process.execPath}' '${cli}' --no-model `)} --json`]).stdout);

  await mkdir(root, { recursive: true });
  run('git', ['init', '-q', '-b', 'main', root]);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'shop', private: true, devDependencies: { nx: '19.8.0' } }));
  await writeFile(path.join(root, 'nx.json'), '{}\n');
  for (const [directory, project] of [['apps/shop', { name: 'shop' }],
    ['apps/shop-e2e', { name: 'shop-e2e', implicitDependencies: ['shop'], targets: { e2e: { executor: '@nx/playwright:playwright' } } }]]) {
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, directory, 'project.json'), JSON.stringify(project));
  }
  run(process.execPath, [cli, '--no-model', 'init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '-A']); run('git', ['commit', '-q', '-m', 'fixture']);
  run('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  run('git', ['remote', 'add', 'origin', remote]); run('git', ['push', '-q', '-u', 'origin', 'main']);
  run('git', ['push', '-q', 'origin', 'HEAD:refs/heads/sflow/config']);
  const before = await readFile(configPath, 'utf8');

  // An inferred suggestion is chosen by its ID; the printed confirmation spells the command out.
  const inspected = json('capability', 'test-setup', '--source-root', 'apps/shop-e2e');
  assert.deepEqual(inspected.suggestions.map((entry) => entry.id), ['apps/shop-e2e-playwright-tests']);
  const suggested = json('capability', 'test-setup', '--step', 'implementation', '--use', 'apps/shop-e2e-playwright-tests', '--source-root', 'apps/shop-e2e');
  assert.deepEqual(suggested.data.problems, []);
  assert.deepEqual(suggested.data.command.affectedRoots, ['apps/shop-e2e', 'apps/shop']);
  assert.equal(suggested.next[0].command, suggested.data.confirmCommand);

  // The office case: the person's own Nx command and the JUnit report their Playwright config writes.
  const office = ['capability', 'test-setup', '--step', 'implementation', '--id', 'shop-e2e-junit',
    '--argv', '["npx","nx","run","shop-e2e:e2e","--skip-nx-cache"]', '--working-directory', '.', '--affected-root', 'apps/shop-e2e',
    '--affected-root', 'apps/shop', '--adapter', 'junit-xml', '--report', 'coverage/e2e/shop-e2e/junit-results.xml'];
  const preview = json(...office);
  assert.deepEqual([preview.data.problems, preview.data.replaces, preview.data.testsExecuted], [[], null, false]);
  assert.match(preview.data.diff, /\+ {6}- id: shop-e2e-junit[\s\S]*\+ {10}- npx[\s\S]*coverage\/e2e\/shop-e2e\/junit-results\.xml/u);
  assert.equal(await readFile(configPath, 'utf8'), before, 'a preview changes nothing');
  assert.equal(refused(...office, '--confirm', sha('stale')).code, 'TEST_SETUP_PLAN_CHANGED');
  assert.equal(refused('capability', 'test-setup', '--step', 'implementation', '--id', 'listed', '--argv', '["npx","playwright","test","--list"]',
    '--working-directory', '.', '--affected-root', '.', '--adapter', 'playwright-json', '--report', 'out.json').code, 'TEST_SETUP_COMMAND_INVALID');
  assert.equal(refused('capability', 'test-setup', '--step', 'implementation', '--id', 'x', '--argv', 'npx nx run',
    '--working-directory', '.', '--affected-root', '.', '--adapter', 'junit-xml', '--report', 'r.xml').code, 'TEST_SETUP_PROPOSAL_USAGE');

  const proposed = shell(preview.data.confirmCommand);
  const branch = proposed.data.branch ?? proposed.data.proposal?.branch;
  assert.match(branch, /^sflow\/config-change\//u);
  const proposedConfig = YAML.parse(run('git', ['--git-dir', remote, 'show', `${branch}:singularity/workflow.yml`]).stdout);
  assert.deepEqual(proposedConfig.phases.implementation.qualityCommands.at(-1), {
    id: 'shop-e2e-junit', kind: 'test', argv: ['npx', 'nx', 'run', 'shop-e2e:e2e', '--skip-nx-cache'],
    workingDirectory: '.', affectedRoots: ['apps/shop-e2e', 'apps/shop'], modelPolicy: 'never',
    result: { adapter: 'junit-xml', path: 'coverage/e2e/shop-e2e/junit-results.xml', minimumDiscovered: 1 }
  });
  assert.equal(await readFile(configPath, 'utf8'), before, 'the application checkout is not changed by a proposal');
  run(process.execPath, [cli, '--no-model', 'workflow', 'activate', branch, '--confirm',
    run('git', ['--git-dir', remote, 'rev-parse', branch]).stdout.trim(), '--acknowledge-unprotected']);
  const approved = YAML.parse(run('git', ['--git-dir', remote, 'show', 'sflow/config:singularity/workflow.yml']).stdout);
  assert.equal(approved.phases.implementation.qualityCommands.at(-1).id, 'shop-e2e-junit');
  // A Story pinned before activation is offered the activated command to adopt; one pinned after is not.
  const { activatedTestCommandsFor } = await import('../src/test-setup-proposal.mjs');
  const pinnedBefore = { workItem: { workType: 'feature' }, resolution: { phases: [{ id: 'implementation', qualityCommands: [] }] } };
  assert.deepEqual((await activatedTestCommandsFor(root, pinnedBefore, 'implementation')).map((entry) => entry.id), ['shop-e2e-junit']);
  const pinnedAfter = { ...pinnedBefore, resolution: { phases: [{ id: 'implementation', qualityCommands: approved.phases.implementation.qualityCommands }] } };
  assert.deepEqual(await activatedTestCommandsFor(root, pinnedAfter, 'implementation'), []);

  // Proposing the same ID again replaces that test command and keeps every other check.
  const again = json(...office.map((value) => (value === 'coverage/e2e/shop-e2e/junit-results.xml' ? 'reports/junit.xml' : value)));
  assert.equal(again.data.replaces.id, 'shop-e2e-junit');
  assert.equal(again.data.kept.includes('shop-e2e-junit'), false);
});
