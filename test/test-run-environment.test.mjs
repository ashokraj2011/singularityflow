import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildTestExecutionReceipt } from '../src/code-delivery-tests.mjs';
import { canonicalJson } from '../src/records.mjs';
import {
  declaredVariablesSha256, gateTestEnvironment, NODE_SELECTION_FLAGS, SELECTION_VARIABLES, testRunEnvironmentRecord
} from '../src/test-run-environment.mjs';
import { runnerFamily, runnerToolchain } from '../src/test-toolchain.mjs';

/**
 * The environment a gate gives a test run [TCE:REQ-030]: CI=1 unless the command declares CI,
 * no inherited variable that changes which tests run, and a record of what shaped the run.
 */
const sha = value => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;

test('a gate run loses every selection variable, keeps JVM and memory options, and runs with CI=1', () => {
  assert.ok(SELECTION_VARIABLES.length >= 10);
  for (const [, reason] of SELECTION_VARIABLES) assert.match(reason, /\w{3,}.*\w{3,}/u, 'each name says why it goes');
  const inherited = Object.freeze({
    PATH: '/bin', CI: 'false', ci: 'no',
    MAVEN_ARGS: '-Dtest=One', MAVEN_CONFIG: '-Dit.test=Two', PYTEST_ADDOPTS: '-k one', PYTEST_PLUGINS: 'deselect',
    TOXENV: 'py311', TOX_SKIP_ENV: 'lint', NOXSESSION: 'unit', npm_config_workspace: 'one', NPM_CONFIG_WORKSPACES: 'true',
    UPDATE_SNAPSHOT: 'all', PWTEST_WATCH: '1', PWTEST_SHARD_WEIGHTS: '1:9',
    CYPRESS_SPEC_PATTERN: 'one.cy.js', CYPRESS_specPattern: 'one.cy.js', CYPRESS_excludeSpecPattern: '**/*', CYPRESS_grepTags: '@smoke',
    MAVEN_OPTS: '-Xmx2g -Dtest=Kept', GRADLE_OPTS: '-Xmx1g', JAVA_TOOL_OPTIONS: '-Xss4m', JDK_JAVA_OPTIONS: '-Xshare:off',
    _JAVA_OPTIONS: '-Xms64m', CYPRESS_RECORD_KEY: 'private', CYPRESS_BASE_URL: 'http://localhost:3000',
    NODE_OPTIONS: '--max-old-space-size=4096 --test-name-pattern "two words" --test_only --test-shard=1/3 --test-skip-pattern=slow --trace-warnings',
    GOFLAGS: '-mod=vendor -run=TestOne -short -test.skip=Slow -count=1'
  });
  const gate = gateTestEnvironment(inherited);
  assert.equal(gate.environment.CI, '1');
  assert.equal(Object.keys(gate.environment).filter(key => key.toUpperCase() === 'CI').length, 1);
  for (const name of ['MAVEN_ARGS', 'MAVEN_CONFIG', 'PYTEST_ADDOPTS', 'PYTEST_PLUGINS', 'TOXENV', 'TOX_SKIP_ENV', 'NOXSESSION',
    'npm_config_workspace', 'NPM_CONFIG_WORKSPACES', 'UPDATE_SNAPSHOT', 'PWTEST_WATCH', 'PWTEST_SHARD_WEIGHTS',
    'CYPRESS_SPEC_PATTERN', 'CYPRESS_specPattern', 'CYPRESS_excludeSpecPattern', 'CYPRESS_grepTags']) {
    assert.equal(gate.environment[name], undefined, name);
  }
  for (const name of ['PATH', 'MAVEN_OPTS', 'GRADLE_OPTS', 'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS',
    'CYPRESS_RECORD_KEY', 'CYPRESS_BASE_URL']) assert.equal(gate.environment[name], inherited[name], `${name} is not selection`);
  assert.equal(gate.environment.NODE_OPTIONS, '--max-old-space-size=4096 --trace-warnings');
  assert.equal(gate.environment.GOFLAGS, '-mod=vendor -count=1');
  assert.deepEqual(gate.removed, [...gate.removed].sort());
  assert.ok(gate.removed.includes('MAVEN_ARGS') && gate.removed.includes('CYPRESS_grepTags'));
  for (const flag of Object.keys(NODE_SELECTION_FLAGS)) assert.ok(gate.removed.includes(`NODE_OPTIONS ${flag}`), flag);
  for (const flag of ['-run', '-short', '-skip']) assert.ok(gate.removed.includes(`GOFLAGS ${flag}`), flag);
  assert.ok(!JSON.stringify(gate.removed).includes('-Dtest=One') && !gate.removed.includes('CI'), 'names only, never values');
  assert.equal(inherited.MAVEN_ARGS, '-Dtest=One', 'the caller environment is never changed');
  // A flag list that held only selection is removed whole.
  assert.equal(gateTestEnvironment({ NODE_OPTIONS: '--test-only', GOFLAGS: '-run=One' }).environment.NODE_OPTIONS, undefined);
  assert.deepEqual(Object.keys(gateTestEnvironment({ NODE_OPTIONS: '--test-only', GOFLAGS: '-run=One' }).environment), ['CI']);
});

test('the command\'s own environment sets CI and selection variables it declares', () => {
  const gate = gateTestEnvironment({ CI: 'true', MAVEN_ARGS: '-Dtest=One' }, { declared: { CI: 'false', MAVEN_ARGS: '-Pfull' } });
  assert.equal(gate.environment.CI, 'false');
  assert.equal(gate.environment.MAVEN_ARGS, '-Pfull', 'declared, so visible in its definition and recorded');
  assert.deepEqual(gate.removed, ['MAVEN_ARGS'], 'the inherited value was still removed');
});

test('the declared digest covers literal values and bound names, and a secret only by name', async () => {
  assert.equal(declaredVariablesSha256({}), null);
  const bound = { boundNames: ['API_TOKEN', 'BASE_URL'], secretsPresent: ['API_TOKEN'] };
  const environment = { BASE_URL: 'http://localhost:3000', API_TOKEN: 'secret-one' };
  const digest = declaredVariablesSha256({ declared: { LOCALE: 'C' }, environment, bound });
  assert.equal(digest, sha({ literal: { BASE_URL: 'http://localhost:3000', LOCALE: 'C' }, secrets: ['API_TOKEN'] }));
  assert.equal(declaredVariablesSha256({ declared: { LOCALE: 'C' }, environment: { ...environment, API_TOKEN: 'secret-two' }, bound }), digest,
    'a secret value never enters the digest');
  assert.notEqual(declaredVariablesSha256({ declared: { LOCALE: 'C' }, environment: { ...environment, BASE_URL: 'http://other' }, bound }), digest);

  const record = await testRunEnvironmentRecord({ argv: ['node', '--test'] }, {
    environment: { ...process.env, CI: 'secret-ci' }, bound: { boundNames: ['CI'], secretsPresent: ['CI'] }, removed: ['MAVEN_ARGS'] });
  assert.equal(record.ci, '[redacted:CI]');
  assert.deepEqual(record.removed, ['MAVEN_ARGS']);
  assert.ok(!JSON.stringify(record).includes('secret-ci'));
});

test('an attempt records what shaped its run, and an attempt without a record keeps the earlier digest', async () => {
  const command = { id: 'unit', argv: [process.execPath, '--test'], workingDirectory: '.', affectedRoots: ['.'], result: { adapter: 'node-tap', path: '.sflow/results/unit.tap' } };
  const legacy = buildTestExecutionReceipt(command, { status: 'passed', exitCode: 0 }, null, { attemptId: 'TA-1', nonce: 'n' });
  assert.deepEqual(legacy.environment, { platform: process.platform, arch: process.arch, host: `node ${process.versions.node}` });
  assert.equal(legacy.environmentSha256, sha({ platform: process.platform, arch: process.arch }));

  const gate = gateTestEnvironment({ PATH: process.env.PATH, MAVEN_ARGS: '-Dtest=One' });
  gate.observe(command, { environment: gate.environment });
  const check = { status: 'passed', exitCode: 0 };
  await gate.attach(check);
  const attempt = buildTestExecutionReceipt(command, check, null, { attemptId: 'TA-2', nonce: 'n' });
  const { host, ...recorded } = attempt.environment;
  assert.equal(host, `node ${process.versions.node}`);
  assert.deepEqual(recorded, { platform: process.platform, arch: process.arch, ci: '1', removed: ['MAVEN_ARGS'],
    declaredSha256: null, toolchain: { node: process.versions.node } });
  assert.equal(attempt.environmentSha256, sha(recorded));
  assert.equal(check.runEnvironment.ci, '1');
  assert.deepEqual(Object.keys(check), ['status', 'exitCode'], 'the record never enters the check\'s JSON');
});

test('toolchain versions come from the runner family, cheaply, once per process', async (t) => {
  assert.deepEqual([['npm', 'test'], ['./mvnw', 'test'], ['gradlew.bat', 'test'], ['pytest'], ['uv', 'run', 'pytest'], ['go', 'test'],
    ['dotnet', 'test'], ['npx', 'playwright', 'test'], ['java', '-jar'], ['make', 'test']].map(argv => runnerFamily({ argv })),
  ['node', 'maven', 'gradle', 'python', 'python', 'go', 'dotnet', 'node', 'java', null]);
  assert.equal(runnerFamily({ argv: ['./run-tests'], result: { adapter: 'go-test-json' } }), 'go');
  if (process.platform === 'win32') return;
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-toolchain-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  // Executables that would say they ran: a version must come from the files beside them.
  const ran = path.join(base, 'ran');
  const tool = async (relative, extra = {}) => {
    const file = path.join(base, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `#!/bin/sh\necho "$0" >> "${ran}"\nexit 1\n`);
    await chmod(file, 0o755);
    for (const [name, content] of Object.entries(extra)) await writeFile(path.join(path.dirname(path.dirname(file)), name), content);
  };
  await tool('go/bin/go', { VERSION: 'go1.23.4\ntime 2024-12-03\n' });
  await tool('jdk/bin/java', { release: 'IMPLEMENTOR="x"\nJAVA_VERSION="21.0.5"\n' });
  await tool('maven/bin/mvn');
  await mkdir(path.join(base, 'maven/lib'));
  await writeFile(path.join(base, 'maven/lib/maven-core-3.9.9.jar'), '');
  await tool('npm-home/bin/npm-cli.js');
  await writeFile(path.join(base, 'npm-home/package.json'), JSON.stringify({ name: 'npm', version: '10.9.2' }));
  const project = path.join(base, 'project');
  await mkdir(path.join(project, '.mvn/wrapper'), { recursive: true });
  await writeFile(path.join(project, '.mvn/wrapper/maven-wrapper.properties'),
    'distributionUrl=https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.8.8/apache-maven-3.8.8-bin.zip\n');
  await mkdir(path.join(project, 'gradle/wrapper'), { recursive: true });
  await writeFile(path.join(project, 'gradle/wrapper/gradle-wrapper.properties'),
    'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.11.1-bin.zip\n');
  await mkdir(path.join(project, 'node_modules/@playwright/test'), { recursive: true });
  await writeFile(path.join(project, 'node_modules/@playwright/test/package.json'), JSON.stringify({ name: '@playwright/test', version: '1.49.1' }));
  await mkdir(path.join(base, 'bin'));
  const { symlink } = await import('node:fs/promises');
  await symlink(path.join(base, 'npm-home/bin/npm-cli.js'), path.join(base, 'bin/npm'));
  await symlink(process.execPath, path.join(base, 'bin/node'));
  const environment = { PATH: [path.join(base, 'bin'), path.join(base, 'go/bin'), path.join(base, 'jdk/bin'), path.join(base, 'maven/bin')].join(path.delimiter) };
  const context = { cwd: project, environment };
  assert.deepEqual(await runnerToolchain({ argv: ['go', 'test', './...'] }, context), { go: '1.23.4' });
  assert.deepEqual(await runnerToolchain({ argv: ['mvn', 'test'] }, context), { java: '21.0.5', maven: '3.9.9' });
  assert.deepEqual(await runnerToolchain({ argv: ['./mvnw', 'verify'] }, context), { java: '21.0.5', maven: '3.8.8' });
  assert.deepEqual(await runnerToolchain({ argv: ['./gradlew', 'test'] }, context), { gradle: '8.11.1', java: '21.0.5' });
  assert.deepEqual(await runnerToolchain({ argv: ['npm', 'exec', 'playwright', 'test'], result: { adapter: 'playwright-json' } }, context),
    { node: process.versions.node, npm: '10.9.2', playwright: '1.49.1' });
  assert.deepEqual(await runnerToolchain({ argv: ['make', 'test'] }, context), {});
  assert.equal(await readFile(ran, 'utf8').catch(() => ''), '', 'no probe started a tool that a file could answer for');
  // A version no file answers for is asked once; an answer that is not a version is null.
  await rm(path.join(base, 'go/VERSION'));
  const other = { cwd: base, environment };
  assert.deepEqual(await runnerToolchain({ argv: ['go', 'test'] }, other), { go: null });
  assert.deepEqual(await runnerToolchain({ argv: ['go', 'vet'] }, other), { go: null });
  assert.equal((await readFile(ran, 'utf8')).trim().split('\n').length, 1, 'asked once per process');
});
