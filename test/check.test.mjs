import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isModelRoutingSource, portableCheckPath, sourceReferenceGrepArgs } from '../scripts/check-path-policy.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('reference lint catches new source before staging while excluding ignored output', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-check-references-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = args => spawnSync('git', args, { cwd: directory, encoding: 'utf8', timeout: childTimeout(10_000) });
  assert.equal(git(['init', '--quiet']).status, 0);
  const marker = 'forbidden-fixture-reference';
  await writeFile(path.join(directory, '.gitignore'), 'generated/\n');
  await writeFile(path.join(directory, 'tracked.mjs'), '// clean source\n');
  assert.equal(git(['add', '.gitignore', 'tracked.mjs']).status, 0);
  await mkdir(path.join(directory, 'generated'));
  await writeFile(path.join(directory, 'generated', 'ignored.mjs'), marker);
  const scan = () => git(sourceReferenceGrepArgs(marker));
  assert.equal(scan().status, 1, 'ignored build/dependency output stays excluded');
  await writeFile(path.join(directory, 'new-test.mjs'), `// ${marker}\n`);
  const untracked = scan();
  assert.equal(untracked.status, 0, untracked.stderr);
  assert.match(untracked.stdout, /new-test\.mjs:1:/, 'a new untracked file must not bypass the reference lint');
  assert.equal(git(['add', 'new-test.mjs']).status, 0);
  assert.equal(scan().status, 0, 'staged source remains covered');
  await writeFile(path.join(directory, 'new-test.mjs'), '// clean source\n');
  assert.equal(scan().status, 1, 'the lint evaluates current working-tree source');
  await writeFile(path.join(directory, 'tracked.mjs'), `// ${marker}\n`);
  assert.match(scan().stdout, /tracked\.mjs:1:/, 'modified tracked source remains covered');
  await writeFile(path.join(directory, 'tracked.mjs'), '// clean source\n');
  await writeFile(path.join(directory, 'binary.dat'), Buffer.from(`\0${marker}`));
  assert.match(scan().stdout, /binary\.dat/, 'binary files cannot bypass the existing reference policy');
});

test('model-name routing source selection is identical for POSIX and Windows paths', () => {
  const cases = [
    ['plugin/skills/sflow-plan/SKILL.md', true],
    ['templates/workflow.yml', true],
    ['templates/agents/developer.agent.md', true],
    ['src/command-registry.mjs', true],
    ['templates/modelTiers.yml', false],
    ['test/model-tiers.test.mjs', false],
    ['docs/model-routing.md', false]
  ];
  for (const [relative, expected] of cases) {
    assert.equal(isModelRoutingSource(relative), expected, relative);
    const windows = relative.replaceAll('/', '\\');
    assert.equal(isModelRoutingSource(windows), expected, windows);
    assert.equal(portableCheckPath(windows), relative, windows);
  }
});

/**
 * The check's source privacy scan builds its personal terms from whoever runs it: the Git user
 * name and email it reads, and the home directory's name (scripts/documentation-privacy.mjs).
 * A test of what the check reads must not depend on that, or a runner whose identity happens to
 * be ordinary words ("Suite Tester" in a home called suitehome) fails on a clean tree. Give the
 * check an explicit identity and home that the policy itself classifies as a fixture, as CI's bot
 * identity is. Command-scope Git configuration is read after every configuration file, so neither
 * the runner's global nor the checkout's local identity can take its place.
 */
async function neutralIdentityEnvironment(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-check-identity-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'fixture');
  await mkdir(home);
  const inherited = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? '', 10);
  const first = Number.isInteger(inherited) && inherited > 0 ? inherited : 0;
  const identity = [['user.name', 'Check fixture'], ['user.email', 'check-fixture@example.invalid']];
  return {
    ...process.env, HOME: home, USERPROFILE: home,
    GIT_CONFIG_COUNT: String(first + identity.length),
    ...Object.fromEntries(identity.flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${first + index}`, key], [`GIT_CONFIG_VALUE_${first + index}`, value]
    ]))
  };
}

test('deterministic check ignores generated files excluded by Git', async t => {
  const env = await neutralIdentityEnvironment(t);
  const directory = path.join(root, 'coverage', 'ignored-check-probe');
  const probe = path.join(directory, 'invalid-generated-file.mjs');
  await mkdir(directory, { recursive: true });
  await writeFile(probe, 'this is intentionally invalid generated JavaScript\n');
  try {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/check.mjs')], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /invalid-generated-file/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the generated operation catalog is current and has one canonical final newline', async () => {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/generate-operation-catalog.mjs')], {
    cwd: root, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const catalog = await readFile(path.join(root, 'docs', 'OPERATION-MODEL-POLICY.md'), 'utf8');
  assert.ok(catalog.endsWith('\n'));
  assert.ok(!catalog.endsWith('\n\n'), 'generated catalogs must not create a trailing blank line');
});
