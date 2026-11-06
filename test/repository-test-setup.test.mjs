import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { inspectRepositoryTestSetup } from '../src/repository-test-setup.mjs';
import { resolveOperation } from '../src/command-registry.mjs';
import { skillForCommandLine } from '../src/command-skills.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-test-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('test setup reads a runner without executing scripts or manufacturing a baseline', async t => {
  const root = await fixture(t);
  const manifest = JSON.stringify({ scripts: { test: 'node --test test/*.test.mjs' } });
  await writeFile(path.join(root, 'package.json'), manifest);
  const before = await readdir(root);
  const result = await inspectRepositoryTestSetup(root);
  assert.equal(result.status, 'suggestions-available');
  assert.equal(result.testsExecuted, false);
  assert.equal(result.baseline, 'not-observed');
  assert.equal(result.suggestions[0].result.adapter, 'node-tap');
  assert.deepEqual(await readdir(root), before);
  assert.equal(await readFile(path.join(root, 'package.json'), 'utf8'), manifest);
});

test('nested applications are inspected explicitly, never by recursive monorepo scanning', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'apps', 'client'), { recursive: true });
  await writeFile(path.join(root, 'apps', 'client', 'package.json'), JSON.stringify({ scripts: { test: 'ng test' }, devDependencies: { karma: '6.4.4' } }));
  const defaultResult = await inspectRepositoryTestSetup(root);
  assert.equal(defaultResult.status, 'pending-configuration');
  const result = await inspectRepositoryTestSetup(root, { sourceRoots: ['apps/client'] });
  assert.equal(result.suggestions[0].workingDirectory, 'apps/client');
  assert.equal(result.suggestions[0].result.adapter, 'karma-text');
  assert.deepEqual(result.suggestions[0].affectedRoots, ['apps/client']);
});

test('a module lists its unit command and the separate Playwright run publication adds beside it', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'apps', 'web'), { recursive: true });
  await writeFile(path.join(root, 'apps', 'web', 'package.json'), JSON.stringify({
    scripts: { test: 'vitest run', 'test:e2e': 'playwright test' }, devDependencies: { '@playwright/test': '^1.0.0' }
  }));
  const result = await inspectRepositoryTestSetup(root, { sourceRoots: ['apps/web'] });
  assert.deepEqual(result.suggestions.map(entry => [entry.id, entry.workingDirectory, entry.result.adapter]), [
    ['apps/web-node-tests', 'apps/web', 'vitest-json'], ['apps/web-playwright-tests', 'apps/web', 'playwright-json']
  ]);
});

test('empty repositories, unsupported scripts and ambiguous modules return pending suggestions', async t => {
  const root = await fixture(t);
  assert.equal((await inspectRepositoryTestSetup(root)).status, 'pending-configuration');
  await mkdir(path.join(root, 'app'));
  await writeFile(path.join(root, 'app', 'package.json'), JSON.stringify({ scripts: { test: 'custom-tool test' } }));
  await writeFile(path.join(root, 'app', 'pom.xml'), '<project/>');
  const result = await inspectRepositoryTestSetup(root, { sourceRoots: ['app'] });
  assert.equal(result.diagnostics[0].code, 'TEST_MODULE_AMBIGUOUS');
  assert.equal(result.testsExecuted, false);
});

test('inspection rejects escaping, glob, missing and symlinked module scopes', async t => {
  const root = await fixture(t);
  for (const scope of ['../other', '/tmp', 'C:/other', 'app/*', 'app\\client', 'app/../other']) {
    await assert.rejects(inspectRepositoryTestSetup(root, { sourceRoots: [scope] }));
  }
  await assert.rejects(inspectRepositoryTestSetup(root, { sourceRoots: Array(21).fill('.') }));
  await assert.rejects(inspectRepositoryTestSetup(root, { sourceRoots: ['missing'] }));
  await symlink(os.tmpdir(), path.join(root, 'outside'), 'dir');
  await assert.rejects(inspectRepositoryTestSetup(root, { sourceRoots: ['outside'] }), { code: 'REPOSITORY_PATH_UNSAFE' });
});

test('Windows suggestions use portable wrapper arguments without executing the wrapper', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'pom.xml'), '<project/>');
  await writeFile(path.join(root, 'mvnw.cmd'), '@echo SHOULD_NOT_RUN');
  const result = await inspectRepositoryTestSetup(root, { platform: 'win32' });
  assert.deepEqual(result.suggestions[0].argv, ['.\\mvnw.cmd', 'test']);
});

test('the new CLI inspection is model-free, read-only and has a packaged Copilot equivalent', async t => {
  const root = await fixture(t);
  const git = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
  assert.equal(git.status, 0);
  const binary = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [binary, 'capability', 'test-setup', '--json'], {
    cwd: root, encoding: 'utf8', timeout: childTimeout(30000),
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_PROMPT_LOG: 'off' }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).baseline, 'not-observed');
  assert.equal(skillForCommandLine('singularity-flow capability test-setup --json'), 'sf-test-setup');
  const operation = resolveOperation({ requestedCommand: 'capability', positionals: ['capability', 'test-setup'], options: {} });
  assert.equal(operation.classification, 'read');
  assert.equal(operation.modelPolicy, 'never');
});

// An office Copilot turn got only "invalid structured test configuration" and the generic recover plan,
// so it could not tell what was wrong and went looking for the CLI's source (2026-10-29).
test('a proposed test command that is not runnable names the field and the inspection that lists runnable ones', async () => {
  const { planTestCommandProposal } = await import('../src/test-setup-proposal.mjs');
  const { refusalRemediationPlan } = await import('../src/refusal-remediation.mjs');
  const command = { id: 'unit', kind: 'test', argv: ['npm', 'test'], workingDirectory: '.', affectedRoots: ['.'],
    result: { adapter: 'mystery', path: 'reports/unit.xml' } };
  const refused = await planTestCommandProposal(process.cwd(), { step: 'implementation', command }).then(() => null, (error) => error);
  assert.equal(refused?.code, 'TEST_SETUP_COMMAND_INVALID');
  assert.match(refused.message, /^Test command 'unit' cannot be proposed: the command\.result\.adapter must be /u);
  assert.doesNotMatch(refused.message, /invalid structured test configuration/u);
  assert.equal(refused.details.nextAction, 'singularity-flow capability test-setup --json');
  const plan = refusalRemediationPlan(refused, ['capability', 'test-setup', '--step', 'implementation', '--id', 'unit']);
  assert.deepEqual(plan.steps.map((entry) => entry.command)[0], 'singularity-flow capability test-setup --json');
});

// An office repository's server and client Jest suites refused the gate's guess, and the inspection the
// refusal names refused with the same error, so nothing could be proposed (2026-10-29).
test('two runners with different configurations are each suggested; the gate still guesses neither', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'client'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'split', private: true, scripts: {
    'test-server': 'jest --config "./jest.config.ts" --detectOpenHandles',
    'test-client': 'jest --config "./client/jest.config.ts" --detectOpenHandles',
    'test-unit': 'npm run test-server && npm run test-client'
  }, devDependencies: { jest: '29.7.0' } }));
  await writeFile(path.join(root, 'package-lock.json'), '{}');
  await writeFile(path.join(root, 'jest.config.ts'), "export default { roots: ['<rootDir>/server'] };\n");
  await writeFile(path.join(root, 'client', 'jest.config.ts'), 'export default {};\n');
  const inspection = await inspectRepositoryTestSetup(root);
  assert.equal(inspection.status, 'suggestions-available');
  const byId = Object.fromEntries(inspection.suggestions.map((entry) => [entry.id, entry]));
  assert.deepEqual(Object.keys(byId).sort(), ['test-client-tests', 'test-server-tests']);
  assert.notEqual(byId['test-server-tests'].result.path, byId['test-client-tests'].result.path, 'each writes its own report');
  assert.ok(byId['test-server-tests'].argv.includes(byId['test-server-tests'].result.path));
  assert.ok(inspection.diagnostics.some((entry) => entry.code === 'TEST_MODULE_AMBIGUOUS' && /A step may run several/u.test(entry.message)));
  // A written command naming one of them is completed from that script alone.
  const { inferModuleTestCommand } = await import('../src/code-delivery-tests.mjs');
  const server = await inferModuleTestCommand(root, { root: '.', system: 'node', manifest: 'package.json' }, { nodeScript: 'test-server' });
  assert.deepEqual(server.argv.slice(0, 3), ['npm', 'run', 'test-server']);
  // The gate's own inference still never picks one.
  await assert.rejects(inferModuleTestCommand(root, { root: '.', system: 'node', manifest: 'package.json' }), { code: 'TEST_MODULE_AMBIGUOUS' });
});

test('the test script itself is suggested when two scripts are ambiguous, not only the other one', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run --config a.config.ts', 'test:b': 'vitest run --config b.config.ts' }, devDependencies: { vitest: '4.0.0' } }));
  await writeFile(path.join(root, 'package-lock.json'), '{}');
  const inspection = await inspectRepositoryTestSetup(root);
  assert.deepEqual(inspection.suggestions.map((entry) => [entry.id, entry.argv.slice(0, 3)]), [['test-tests', ['npm', 'test', '--']], ['test:b-tests', ['npm', 'run', 'test:b']]]);
  assert.notEqual(inspection.suggestions[0].result.path, inspection.suggestions[1].result.path, 'each writes its own report');
  assert.ok(inspection.diagnostics.some((entry) => entry.code === 'TEST_MODULE_AMBIGUOUS'));
  // The gate still guesses neither.
  const { inferModuleTestCommand } = await import('../src/code-delivery-tests.mjs');
  await assert.rejects(inferModuleTestCommand(root, { root: '.', system: 'node', manifest: 'package.json' }), { code: 'TEST_MODULE_AMBIGUOUS' });
});

test('a root with two build systems suggests each one\'s command, and an accepted one covers only its own language', async t => {
  const { testCommandCoversPath } = await import('../src/code-delivery-tests.mjs');
  const { normalizeExternalCommand } = await import('../src/external-command-policy.mjs');
  const root = await fixture(t);
  await writeFile(path.join(root, 'pom.xml'), '<project/>');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test test/*.test.mjs' } }));
  const result = await inspectRepositoryTestSetup(root);
  assert.deepEqual(result.suggestions.map(entry => [entry.id, entry.argv[0], entry.ecosystem]), [['maven-tests', 'mvn', 'jvm'], ['node-tests', 'npm', 'node']]);
  assert.deepEqual(result.diagnostics.find(entry => entry.code === 'TEST_ROOT_BUILD_SYSTEMS')?.systems, ['maven', 'node']);
  // Accepted as offered (configured, affectedRoots ['.']), Maven is evidence for Java, never for the JavaScript beside it.
  const maven = { ...normalizeExternalCommand(result.suggestions[0]), provenance: 'configured' };
  assert.deepEqual([maven.affectedRoots, maven.ecosystem], [['.'], 'jvm']);
  assert.equal(testCommandCoversPath(maven, 'src/main/java/com/acme/Cart.java'), true);
  assert.equal(testCommandCoversPath(maven, 'src/app.js'), false);
  assert.equal(testCommandCoversPath(maven, 'README.md'), true, 'files of no language stay covered');
  // A command written without one, as every older record is, keeps covering every file below its roots.
  const { ecosystem: _scope, ...written } = maven;
  assert.equal(testCommandCoversPath(written, 'src/app.js'), true);
  assert.throws(() => normalizeExternalCommand({ ...result.suggestions[0], ecosystem: 'cobol' }), { code: 'QUALITY_COMMAND_ECOSYSTEM_INVALID' });
});

test('one build system at the root keeps its single command and its whole-repository name', async t => {
  for (const [files, expected] of [[{ 'pom.xml': '<project/>' }, ['maven-tests']],
    [{ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) }, ['node-tests']],
    [{ 'pom.xml': '<project/>', 'package.json': JSON.stringify({ name: 'tooling', devDependencies: { husky: '9.0.0' } }) }, ['maven-tests']]]) {
    const root = await fixture(t);
    for (const [name, text] of Object.entries(files)) await writeFile(path.join(root, name), text);
    const result = await inspectRepositoryTestSetup(root);
    assert.deepEqual(result.suggestions.map(entry => entry.id), expected, Object.keys(files).join(' + '));
    assert.equal(result.diagnostics.some(entry => entry.code === 'TEST_ROOT_BUILD_SYSTEMS'), false, 'a tooling package.json is no second suite');
  }
});

test('a Maven reactor root suggests what the gate runs for each module, never a report path no run writes', async t => {
  const { moduleTestCommands } = await import('../src/test-module-markers.mjs');
  const { resolveAffectedModule } = await import('../src/code-delivery-tests.mjs');
  for (const [wrapper, argv, directory, report] of [
    [true, ['./mvnw', '-pl', 'svc', '-am', 'test'], '.', 'svc/target/surefire-reports'],
    [false, ['mvn', 'test'], 'svc', 'target/surefire-reports']
  ]) {
    const root = await fixture(t);
    const module = (name) => `<project><artifactId>${name}</artifactId></project>`;
    await mkdir(path.join(root, 'svc', 'src', 'test', 'java'), { recursive: true });
    await mkdir(path.join(root, 'group', 'nested', 'src', 'test', 'java'), { recursive: true });
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await writeFile(path.join(root, 'pom.xml'), '<project><packaging>pom</packaging><modules><module>svc</module><module>docs</module><module>group</module></modules></project>');
    await writeFile(path.join(root, 'svc', 'pom.xml'), module('svc'));
    await writeFile(path.join(root, 'docs', 'pom.xml'), module('docs'));
    await writeFile(path.join(root, 'group', 'pom.xml'), '<project><packaging>pom</packaging><modules><module>nested</module></modules></project>');
    await writeFile(path.join(root, 'group', 'nested', 'pom.xml'), module('nested'));
    if (wrapper) await writeFile(path.join(root, 'mvnw'), '');
    const { suggestions, status } = await inspectRepositoryTestSetup(root);
    assert.equal(status, 'suggestions-available');
    assert.deepEqual(suggestions.map(entry => entry.id), ['svc-maven-tests', 'group/nested-maven-tests'], 'a module with no tests has nothing to run');
    const svc = suggestions[0];
    assert.deepEqual([svc.argv, svc.workingDirectory, svc.result.path, svc.affectedRoots, svc.ecosystem], [argv, directory, report, ['svc'], 'jvm']);
    // The gate's answer for a change in that module, which is what setup is suggesting.
    const [gate] = await moduleTestCommands(root, await resolveAffectedModule(root, 'svc/src/main/java/A.java'));
    assert.deepEqual([svc.id, svc.argv, svc.workingDirectory, svc.result], [gate.id, gate.argv, gate.workingDirectory, gate.result]);
  }
});

test('a Maven reactor named as the module directory is read the same way; a plain project keeps its command', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'group', 'nested', 'src', 'test', 'java'), { recursive: true });
  await writeFile(path.join(root, 'group', 'pom.xml'), '<project><modules><module>nested</module></modules></project>');
  await writeFile(path.join(root, 'group', 'nested', 'pom.xml'), '<project/>');
  const { suggestions } = await inspectRepositoryTestSetup(root, { sourceRoots: ['group'] });
  assert.deepEqual(suggestions.map(entry => [entry.argv, entry.workingDirectory, entry.result.path]), [[['mvn', 'test'], 'group/nested', 'target/surefire-reports']]);
  const plain = await fixture(t);
  await writeFile(path.join(plain, 'pom.xml'), '<project><!-- <modules><module>old</module></modules> --></project>');
  assert.deepEqual((await inspectRepositoryTestSetup(plain)).suggestions.map(entry => [entry.id, entry.result.path]), [['maven-tests', 'target/surefire-reports']]);
});

test('a malformed package.json is named with where its JSON breaks, and never hides the build beside it', async t => {
  const { moduleTestCommands } = await import('../src/test-module-markers.mjs');
  const root = await fixture(t);
  await writeFile(path.join(root, 'package.json'), '{ "scripts": { "test": "jest", }');
  await assert.rejects(moduleTestCommands(root, { root: '.', system: 'node', manifest: 'package.json' }), (error) => {
    assert.equal(error.code, 'TEST_MANIFEST_INVALID');
    assert.equal(error.details.path, 'package.json');
    assert.ok(Number.isInteger(error.details.position), 'the parser\'s position is kept');
    assert.match(error.message, /^package\.json is not valid JSON \(.+\), so no test command can be inferred from it\. Fix the JSON in package\.json, then run the command again\.$/u);
    return true;
  });
  assert.deepEqual((await inspectRepositoryTestSetup(root)).diagnostics.map(entry => entry.code), ['TEST_MANIFEST_INVALID']);
  await writeFile(path.join(root, 'pom.xml'), '<project/>');
  const beside = await inspectRepositoryTestSetup(root);
  assert.deepEqual(beside.suggestions.map(entry => entry.id), ['maven-tests']);
  assert.deepEqual(beside.diagnostics.map(entry => [entry.system ?? null, entry.code]), [['node', 'TEST_MANIFEST_INVALID'], [null, 'TEST_ROOT_BUILD_SYSTEMS']]);
});
