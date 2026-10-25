/**
 * Ecosystems `[TCE:REQ-070]`: SFlow finds the right test command for common setups.
 *
 * A Node package declares several test commands (unit, end-to-end, component), reached through
 * `npm run` references and `&&` chains; a .NET product is tested by the test projects that reference
 * it; a Maven module with the failsafe plugin runs `verify`; Python projects without pyproject.toml,
 * and uv and poetry ones, run pytest, whose JUnit results name each test; Android device tests and
 * Xcode are proposed with the fields a person supplies; cargo reports read libtest's JSON lines.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import {
  inferModuleTestCommand, isTestSourceName, parseTestResult, persistedOccurrences, replayTestReports, resolveAffectedModule,
  TEST_SETUP_COMMAND, testCommandCoversPath
} from '../src/code-delivery-tests.mjs';
import { inferRepositoryTestCommands, resolveDeliveryQualityCommands } from '../src/delivery-evidence.mjs';
import { discoverDeclarations, joinWitness, profileForCommand } from '../src/verification/adapters.mjs';
import { witnessResult } from '../src/verification/witness-results.mjs';
import { moduleTestCommands } from '../src/test-module-markers.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin/singularity-flow.mjs');
const ENV = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Ecosystem Tester',
  SINGULARITY_FLOW_AGENT_OUTPUT: 'full' };
delete ENV.NODE_TEST_CONTEXT;

async function repository(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-tce-ecosystems-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [relative, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), typeof contents === 'string' ? contents : JSON.stringify(contents));
  }
  return root;
}

const node = (root = '.') => ({ root, system: 'node', manifest: 'package.json' });
const shape = (commands) => commands.map((command) => [command.id, command.argv.join(' '), command.result.adapter, command.result.path]);
const codePhase = (deliveryEvidence, qualityCommands = []) => ({ id: 'implement', generationPolicy: { task: 'code' }, qualityCommands, deliveryEvidence });
const gate = async (root, sourcePaths, testPaths = []) => (await resolveDeliveryQualityCommands(root, codePhase({ sourcePaths, configurationPaths: [], testPaths })))
  .map((command) => ({ ...command, provenance: 'inferred' }));

test('Node: Create React App, Angular with Jest or Karma, mocha, nested and chained scripts reach the runner itself', async (t) => {
  const cases = {
    'Create React App': [{ scripts: { start: 'react-scripts start', test: 'react-scripts test' }, dependencies: { 'react-scripts': '5.0.1' } },
      ['.-node-tests', 'npm test -- --watchAll=false --json --outputFile .sflow/results/node-tests.json', 'jest-json', '.sflow/results/node-tests.json']],
    'a test script that only runs test:unit': [{ scripts: { test: 'npm run test:unit', 'test:unit': 'vitest run' } },
      ['.-node-tests', 'npm run test:unit -- --reporter=json --outputFile=.sflow/results/node-tests.json', 'vitest-json', '.sflow/results/node-tests.json']],
    'jest && npm run lint': [{ scripts: { test: 'jest && npm run lint', lint: 'eslint .' } },
      ['.-node-tests', 'npx --no-install jest --json --outputFile .sflow/results/node-tests.json', 'jest-json', '.sflow/results/node-tests.json']],
    'cross-env inside a chain': [{ scripts: { test: 'cross-env NODE_ENV=test jest --coverage && npm run lint', lint: 'eslint .' } },
      ['.-node-tests', 'npx --no-install cross-env NODE_ENV=test jest --coverage --json --outputFile .sflow/results/node-tests.json', 'jest-json', '.sflow/results/node-tests.json']],
    'mocha with tests': [{ scripts: { test: "mocha 'test/**/*.spec.js'" } },
      ['.-node-tests', 'npm test -- --reporter json --reporter-option output=.sflow/results/node-tests.json', 'mocha-json', '.sflow/results/node-tests.json']],
    'mocha with its JUnit reporter installed': [{ scripts: { test: 'mocha --reporter spec' }, devDependencies: { 'mocha-junit-reporter': '2.2.1' } },
      ['.-node-tests', 'npx --no-install mocha --reporter mocha-junit-reporter --reporter-options mochaFile=.sflow/results/node-tests.xml', 'junit-xml', '.sflow/results/node-tests.xml']]
  };
  for (const [name, [manifest, expected]] of Object.entries(cases)) {
    const root = await repository(t, { 'package.json': manifest });
    assert.deepEqual(shape(await moduleTestCommands(root, node())), [expected], name);
  }
  const angular = (builder, dependencies) => ({ 'package.json': { scripts: { test: 'ng test' }, devDependencies: dependencies },
    'angular.json': { version: 1, projects: { shop: { architect: { test: { builder } } } } } });
  const jest = await repository(t, angular('@angular-builders/jest:run', { '@angular-builders/jest': '17.0.0', jest: '29.7.0' }));
  assert.deepEqual(shape(await moduleTestCommands(jest, node())),
    [['angular-tests', 'npm test -- --json --outputFile=.sflow/results/node-tests.json', 'jest-json', '.sflow/results/node-tests.json']]);
  const karma = await repository(t, angular('@angular-devkit/build-angular:karma', { karma: '6.4.0' }));
  assert.deepEqual(shape(await moduleTestCommands(karma, node())),
    [['angular-tests', 'npm test -- --watch=false --browsers=ChromeHeadless --no-progress', 'karma-text', '.sflow/results/node-tests.karma.txt']]);
  // A builder SFlow has no report for is not guessed.
  const other = await repository(t, angular('@angular-devkit/build-angular:jest', { jest: '29.7.0' }));
  assert.deepEqual(await moduleTestCommands(other, node()), []);
  // Watching, interactive and listing scripts are never a gate's command; a package with only test:unit gets it.
  const only = await repository(t, { 'package.json': { scripts: { 'test:unit': 'jest', 'test:watch': 'jest --watch', 'test:e2e': 'playwright test', 'e2e:ui': 'playwright test --ui' },
    devDependencies: { '@playwright/test': '1.48.0' } } });
  assert.deepEqual(shape(await moduleTestCommands(only, node())), [
    ['.-node-tests', 'npm run test:unit -- --json --outputFile .sflow/results/node-tests.json', 'jest-json', '.sflow/results/node-tests.json'],
    ['playwright-tests', 'npm run test:e2e -- --reporter=json', 'playwright-json', '.sflow/results/playwright-tests.json']]);
  // The whole-repository inference and readiness use the same rule.
  assert.deepEqual((await inferRepositoryTestCommands(only)).map((command) => command.id), ['node-tests', 'playwright-tests']);
  assert.deepEqual((await inferRepositoryTestCommands(only, { unitOnly: true })).map((command) => command.argv.join(' ')),
    ['npm run test:unit -- --json --outputFile .sflow/results/node-tests.json']);
});

test('Node: each runner and level is its own command, found by its runner, and conflicting scripts are refused', async (t) => {
  const levels = await repository(t, {
    'package.json': { scripts: { test: 'vitest', 'e2e:ci': 'playwright test --project=chromium', 'test:ct': 'playwright test -c playwright-ct.config.ts',
      'test:smoke': 'BASE_URL=http://localhost:3000 playwright test --project=chromium --reporter=line', pw: 'npm run e2e:ci' },
    devDependencies: { vitest: '2.1.0', '@playwright/test': '1.48.0', '@playwright/experimental-ct-react': '1.48.0' } },
    'playwright-ct.config.ts': "import { defineConfig } from '@playwright/experimental-ct-react';\nexport default defineConfig({});\n"
  });
  assert.deepEqual(shape(await moduleTestCommands(levels, node())), [
    ['.-node-tests', 'npm test -- --reporter=json --outputFile=.sflow/results/node-tests.json', 'vitest-json', '.sflow/results/node-tests.json'],
    ['playwright-tests', 'npm run e2e:ci -- --reporter=json', 'playwright-json', '.sflow/results/playwright-tests.json'],
    ['playwright-ct-tests', 'npm run test:ct -- --reporter=json', 'playwright-json', '.sflow/results/playwright-ct-tests.json']]);
  // The gate runs all three for the package's changes.
  assert.deepEqual((await gate(levels, ['src/cart.ts'], ['src/cart.test.ts'])).map((command) => command.id), ['.-node-tests', 'playwright-tests', 'playwright-ct-tests']);
  // An environment prefix runs through its own script, where the shell applies it.
  const prefixed = await repository(t, { 'package.json': { scripts: { 'test:smoke': 'BASE_URL=http://localhost:3000 playwright test --config=e2e/smoke.config.ts' },
    devDependencies: { '@playwright/test': '1.48.0' } } });
  assert.deepEqual(shape(await moduleTestCommands(prefixed, node())), [['playwright-tests', 'npm run test:smoke -- --reporter=json', 'playwright-json', '.sflow/results/playwright-tests.json']]);
  // With no script at all, a Playwright config runs directly; a config with another name is named.
  const scriptless = await repository(t, { 'package.json': { devDependencies: { '@playwright/test': '1.48.0' } }, 'playwright.config.ts': 'export default {};\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9\n' });
  assert.deepEqual(shape(await moduleTestCommands(scriptless, node())), [['playwright-tests', 'pnpm exec playwright test --reporter=json', 'playwright-json', '.sflow/results/playwright-tests.json']]);
  const named = await repository(t, { 'package.json': { devDependencies: { '@playwright/test': '1.48.0' } }, 'playwright.e2e.config.ts': 'export default {};\n' });
  assert.deepEqual(shape(await moduleTestCommands(named, node()))[0][1], 'npx --no-install playwright test --config=playwright.e2e.config.ts --reporter=json');
  // Two scripts that run the same runner the same way collapse to one; a narrower run beside the whole one too.
  const duplicate = await repository(t, { 'package.json': { scripts: { 'test:e2e': 'playwright test', 'e2e:ci': 'playwright test --workers=2 --reporter=line',
    'e2e:chromium': 'playwright test --project=chromium' }, devDependencies: { '@playwright/test': '1.48.0' } } });
  assert.deepEqual(shape(await moduleTestCommands(duplicate, node())), [['playwright-tests', 'npm run test:e2e -- --reporter=json', 'playwright-json', '.sflow/results/playwright-tests.json']]);
  // Different configurations, neither the whole of the other: refused with the test-setup route.
  const conflict = await repository(t, { 'package.json': { scripts: { test: 'jest', 'test:e2e': 'playwright test -c e2e/a.config.ts', 'e2e:ci': 'playwright test -c e2e/b.config.ts' },
    devDependencies: { '@playwright/test': '1.48.0' } } });
  await assert.rejects(moduleTestCommands(conflict, node()), (error) => {
    assert.equal(error.code, 'TEST_MODULE_AMBIGUOUS');
    assert.deepEqual(error.details.scripts, ['test:e2e', 'e2e:ci']);
    assert.deepEqual(error.details.nextAction, { command: TEST_SETUP_COMMAND });
    return true;
  });
  // Cypress end-to-end and component runs report through Cypress's JUnit reporter.
  const cypress = await repository(t, { 'package.json': { scripts: { 'cy:run': 'cypress run', 'cy:component': 'cypress run --component', 'cy:open': 'cypress open' },
    devDependencies: { cypress: '13.15.0' } } });
  assert.deepEqual(shape(await moduleTestCommands(cypress, node())), [
    ['cypress-tests', 'npm run cy:run -- --reporter junit --reporter-options mochaFile=.sflow/results/cypress-tests/[hash].xml', 'junit-xml', '.sflow/results/cypress-tests'],
    ['cypress-component-tests', 'npm run cy:component -- --reporter junit --reporter-options mochaFile=.sflow/results/cypress-component-tests/[hash].xml',
      'junit-xml', '.sflow/results/cypress-component-tests']]);
  // A JUnit command run by a package manager covers JavaScript, never Python.
  const [cypressCommand] = await moduleTestCommands(cypress, node());
  assert.equal(testCommandCoversPath({ ...cypressCommand, provenance: 'inferred' }, 'cypress/e2e/cart.cy.js'), true);
  assert.equal(testCommandCoversPath({ ...cypressCommand, provenance: 'inferred' }, 'tools/seed.py'), false);
});

const playwrightReport = (tests) => JSON.stringify({
  config: { rootDir: '/checkout/web/e2e' },
  suites: [{ title: 'cart.spec.ts', file: 'cart.spec.ts', line: 0, column: 0, specs: [], suites: [{ title: 'cart', file: 'cart.spec.ts', line: 3, column: 6,
    specs: tests.map(([title, line, runs]) => ({ title, file: 'cart.spec.ts', line, column: 7, tests: runs.map(([projectName, status, results]) => ({
      projectName, status, results: results.map((result, retry) => ({ status: result, retry, duration: 10 })) })) })) }] }],
  stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 }
});

test('Playwright reports each test: retries kept as flaky, every project must pass, a test filtered out is never credited', async (t) => {
  const report = playwrightReport([
    ['adds an item', 5, [['chromium', 'expected', ['passed']], ['firefox', 'expected', ['passed']]]],
    ['removes an item', 9, [['chromium', 'flaky', ['failed', 'passed']], ['firefox', 'expected', ['passed']]]],
    ['empties the cart', 13, [['chromium', 'unexpected', ['failed']], ['firefox', 'expected', ['passed']]]]
  ]).replace('"stats":{"expected":0,"unexpected":0,"flaky":0,"skipped":0}', '"stats":{"expected":4,"unexpected":1,"flaky":1,"skipped":0}');
  const root = await repository(t, { 'web/.sflow/results/playwright-tests.json': report, 'web/e2e/cart.spec.ts': [
    "import { test, expect } from '@playwright/test';", '', "test.describe('cart', () => {", '  // @ac:SHOP-1:AC-001', "  test('adds an item', async () => {});", '',
    '  // @ac:SHOP-1:AC-002', "  test('removes an item', async () => {});", '', '  // @ac:SHOP-1:AC-003', "  test('empties the cart', async () => {});", '',
    '  // @ac:SHOP-1:AC-004', "  test('checks out', async () => {});", '});', ''].join('\n') });
  const command = { id: 'web-playwright-tests', kind: 'test', argv: ['npm', 'run', 'e2e:ci', '--', '--grep', 'cart', '--reporter=json'], workingDirectory: 'web',
    affectedRoots: ['web'], modelPolicy: 'never', result: { adapter: 'playwright-json', path: '.sflow/results/playwright-tests.json', minimumDiscovered: 1 } };
  const parsed = await parseTestResult(root, command);
  assert.deepEqual(parsed.tests, { discovered: 6, passed: 5, failed: 1, skipped: 0 });
  const occurrences = persistedOccurrences(parsed);
  assert.deepEqual(occurrences.find((entry) => entry.name === 'removes an item' && entry.project === 'chromium'),
    { suitePath: ['cart'], name: 'removes an item', file: 'cart.spec.ts', line: 9, project: 'chromium', retries: 1, outcome: 'passed', flaky: true, durationMs: 20 });
  // Replay re-derives the same occurrences from the raw report.
  assert.deepEqual(persistedOccurrences(replayTestReports('playwright-json', parsed.rawReports)), occurrences);
  // Exact: each tagged declaration joins its own occurrences, in every project.
  const profile = profileForCommand(command);
  assert.equal(profile, 'playwright-json-v1');
  const { declarations } = await discoverDeclarations(root, profile, ['web/e2e/cart.spec.ts']);
  const outcome = (name, succeeded = true) => joinWitness(profile, declarations.find((entry) => entry.name === name), occurrences, { completed: true, succeeded }).outcome;
  assert.deepEqual(declarations.map((entry) => [entry.suitePath, entry.name, entry.clauseIds]), [
    [['cart'], 'adds an item', ['SHOP-1:AC-001']], [['cart'], 'removes an item', ['SHOP-1:AC-002']],
    [['cart'], 'empties the cart', ['SHOP-1:AC-003']], [['cart'], 'checks out', ['SHOP-1:AC-004']]]);
  assert.equal(outcome('adds an item'), 'passed');
  assert.equal(outcome('removes an item'), 'flaky', 'a pass on a retry is flaky, not passed');
  assert.equal(outcome('empties the cart'), 'failed', 'a failure in one project fails the test');
  assert.equal(outcome('adds an item', false), 'failed', 'a pass inside a failed run proves nothing');
  // `--grep cart` left 'checks out' out of the run: it has no result, so it verifies nothing.
  assert.equal(outcome('checks out'), 'missing');
  const witness = (declaration) => ({ clauseId: declaration.clauseIds[0], testSource: 'web/e2e/cart.spec.ts', profile, commandId: command.id,
    identity: { framework: declaration.framework, suitePath: declaration.suitePath, name: declaration.name }, line: declaration.line, gaps: [] });
  const attempt = { attemptId: 'a', status: 'failed', exitCode: 1, terminal: true, tests: parsed.tests, occurrences };
  assert.deepEqual(declarations.map((declaration) => witnessResult(witness(declaration), attempt).status), ['failed', 'failed', 'failed', 'failed']);
  const passing = { ...attempt, status: 'passed', exitCode: 0, tests: { discovered: 4, passed: 4, failed: 0, skipped: 0 },
    occurrences: occurrences.filter((entry) => entry.name !== 'empties the cart') };
  assert.deepEqual(declarations.map((declaration) => [declaration.name, witnessResult(witness(declaration), passing).status]), [
    ['adds an item', 'met'], ['removes an item', 'inconclusive'], ['empties the cart', 'missing'], ['checks out', 'missing']]);
});

test('mocha JSON and cargo JSON lines are per-test reports; a cargo suite total that disagrees is refused', async (t) => {
  const mocha = { stats: { suites: 1, tests: 3, passes: 1, pending: 1, failures: 1 },
    passes: [{ title: 'adds', fullTitle: 'cart adds', file: '/checkout/test/cart.spec.js', duration: 3 }],
    failures: [{ title: 'removes', fullTitle: 'cart removes', file: '/checkout/test/cart.spec.js', duration: 1, err: { message: 'expected 1' } }],
    pending: [{ title: 'empties', fullTitle: 'cart empties', file: '/checkout/test/cart.spec.js' }], tests: [] };
  // Real `RUSTC_BOOTSTRAP=1 cargo test -- -Z unstable-options --format json` output (cargo 1.8x): a library suite
  // with an ignored and a failing test, then the doc-test suite.
  const cargo = ['{ "type": "suite", "event": "started", "test_count": 3 }', '{ "type": "test", "event": "started", "name": "tests::adds" }',
    '{ "type": "test", "event": "started", "name": "tests::fails" }', '{ "type": "test", "event": "started", "name": "tests::slow" }',
    '{ "type": "test", "name": "tests::adds", "event": "ok" }', '{ "type": "test", "name": "tests::slow", "event": "ignored" }',
    '{ "type": "test", "name": "tests::fails", "event": "failed", "stdout": "\\nthread \'tests::fails\' panicked at src/lib.rs:6:26:\\nassertion `left == right` failed\\n  left: 2\\n right: 3\\n" }',
    '{ "type": "suite", "event": "failed", "passed": 1, "failed": 1, "ignored": 1, "measured": 0, "filtered_out": 0, "exec_time": 0.000626458 }',
    '{ "type": "suite", "event": "started", "test_count": 1 }', '{ "type": "test", "event": "started", "name": "src/lib.rs - value (line 1)" }',
    '{ "type": "test", "name": "src/lib.rs - value (line 1)", "event": "ok" }',
    '{ "type": "suite", "event": "ok", "passed": 1, "failed": 0, "ignored": 0, "measured": 0, "filtered_out": 0, "exec_time": 0.538628 }',
    // cargo nextest's libtest-json lines carry their binary as well.
    '{"type":"suite","event":"started","test_count":1,"nextest":{"crate":"shop","test_binary":"shop","kind":"lib"}}',
    '{"type":"test","event":"ok","name":"shop::shop$cart::totals","exec_time":0.001}', '{"type":"suite","event":"ok","passed":1,"failed":0,"ignored":0,"measured":0,"filtered_out":0}', ''].join('\n');
  const root = await repository(t, { 'r/mocha.json': mocha, 'r/cargo.jsonl': cargo, 'r/bad.jsonl': cargo.replace('"passed":1,"failed":0', '"passed":2,"failed":0') });
  const command = (adapter, file) => ({ id: adapter, kind: 'test', argv: ['npm', 'test'], workingDirectory: '.', affectedRoots: ['.'], result: { adapter, path: `r/${file}` } });
  const parsedMocha = await parseTestResult(root, command('mocha-json', 'mocha.json'));
  assert.deepEqual(parsedMocha.tests, { discovered: 3, passed: 1, failed: 1, skipped: 1 });
  assert.deepEqual(persistedOccurrences(parsedMocha).map((entry) => [entry.suitePath, entry.name, entry.outcome]),
    [[['cart'], 'adds', 'passed'], [['cart'], 'removes', 'failed'], [['cart'], 'empties', 'skipped']]);
  const parsedCargo = await parseTestResult(root, command('cargo-json', 'cargo.jsonl'));
  assert.deepEqual(parsedCargo.tests, { discovered: 5, passed: 3, failed: 1, skipped: 1 });
  assert.deepEqual(persistedOccurrences(parsedCargo).map((entry) => [entry.name, entry.outcome]), [['tests::adds', 'passed'], ['tests::slow', 'skipped'],
    ['tests::fails', 'failed'], ['src/lib.rs - value (line 1)', 'passed'], ['shop::shop$cart::totals', 'passed']]);
  assert.deepEqual(replayTestReports('cargo-json', parsedCargo.rawReports).tests, parsedCargo.tests);
  await assert.rejects(parseTestResult(root, command('cargo-json', 'bad.jsonl')), (error) => error.code === 'CODE_TEST_RESULT_REQUIRED' && /suite totals differ/u.test(error.message));
});

test('.NET: a product project is tested by the test projects that reference it, and refused when none does', async (t) => {
  const testProject = (reference) => `<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />\n`
    + `    <ProjectReference Include="${reference}" />\n  </ItemGroup>\n</Project>\n`;
  const root = await repository(t, {
    'src/App/App.csproj': '<Project Sdk="Microsoft.NET.Sdk" />\n', 'src/App/Cart.cs': 'class Cart {}\n',
    'tests/App.Tests/App.Tests.csproj': testProject('..\\..\\src\\App\\App.csproj'), 'tests/App.Tests/CartTests.cs': 'class CartTests {}\n',
    'tests/Contract/Contract.csproj': testProject('../../src/App/App.csproj'),
    'src/Tools/Tools.csproj': '<Project Sdk="Microsoft.NET.Sdk" />\n', 'src/Tools/Seed.cs': ''
  });
  assert.deepEqual(await resolveAffectedModule(root, 'src/App/Cart.cs'), { root: 'src/App', system: 'dotnet', manifest: 'App.csproj', configured: false });
  const commands = await gate(root, ['src/App/Cart.cs'], ['tests/App.Tests/CartTests.cs']);
  assert.deepEqual(commands.map((command) => [command.id, command.argv.join(' '), command.workingDirectory, command.affectedRoots]), [
    ['tests/App.Tests-dotnet-tests', 'dotnet test App.Tests.csproj --logger trx --results-directory TestResults', 'tests/App.Tests', ['tests/App.Tests', 'src/App']],
    ['tests/Contract-dotnet-tests', 'dotnet test Contract.csproj --logger trx --results-directory TestResults', 'tests/Contract', ['tests/Contract', 'src/App']]]);
  assert.ok(commands.every((command) => testCommandCoversPath(command, 'src/App/Cart.cs')));
  await assert.rejects(gate(root, ['src/Tools/Seed.cs']), (error) => {
    assert.equal(error.code, 'TEST_MODULE_UNCOVERED');
    assert.match(error.message, /src\/Tools\/Tools\.csproj is not a test project and no test project references it/u);
    assert.deepEqual(error.details.nextAction, { command: TEST_SETUP_COMMAND });
    return true;
  });
});

test('Maven: a module with the failsafe plugin runs verify and reads failsafe and surefire reports; *IT names are tests', async (t) => {
  const failsafe = '<project>\n  <modules><module>orders</module></modules>\n</project>\n';
  const module = '<project>\n  <build><plugins><plugin><artifactId>maven-failsafe-plugin</artifactId></plugin></plugins></build>\n</project>\n';
  const junit = (name) => `<testsuite name="${name}" tests="1" failures="0" errors="0" skipped="0"><testcase classname="shop.${name}" name="works"/></testsuite>\n`;
  const root = await repository(t, { 'pom.xml': failsafe, mvnw: '', 'orders/pom.xml': module, 'billing/pom.xml': '<project>\n  <!-- maven-failsafe-plugin -->\n</project>\n',
    'orders/target/surefire-reports/TEST-shop.OrderTest.xml': junit('OrderTest'), 'orders/target/failsafe-reports/TEST-shop.OrderIT.xml': junit('OrderIT'),
    'orders/target/failsafe-reports/failsafe-summary.xml': '<failsafe-summary result="0"><completed>1</completed></failsafe-summary>\n' });
  const [command] = await moduleTestCommands(root, { root: 'orders', system: 'maven', manifest: 'pom.xml' });
  assert.deepEqual([command.argv, command.workingDirectory, command.result.path],
    [['./mvnw', '-pl', 'orders', '-am', 'verify'], '.', 'orders/target/failsafe-reports']);
  const parsed = await parseTestResult(root, command);
  assert.deepEqual(parsed.tests, { discovered: 2, passed: 2, failed: 0, skipped: 0 });
  assert.deepEqual(persistedOccurrences(parsed).map((entry) => entry.className).sort(), ['shop.OrderIT', 'shop.OrderTest']);
  // A module without the plugin keeps `test`; a commented-out plugin is not one.
  assert.deepEqual((await inferModuleTestCommand(root, { root: 'billing', system: 'maven', manifest: 'pom.xml' })).argv.at(-1), 'test');
  for (const name of ['OrderIT.java', 'OrderITCase.java', 'CheckoutIT.kt']) assert.equal(isTestSourceName(name), true, name);
  for (const name of ['AUDIT.java', 'Edit.java']) assert.equal(isTestSourceName(name), false, name);
});

test('Python: requirements-only, nox, uv and poetry projects run pytest, and pytest JUnit names each test', async (t) => {
  const repo = async (files) => repository(t, { 'app.py': 'VALUE = 1\n', ...files });
  const argv = async (root, moduleRoot = '.') => (await inferModuleTestCommand(root, await resolveAffectedModule(root, path.posix.join(moduleRoot, 'app.py')))).argv.join(' ');
  assert.equal(await argv(await repo({ 'requirements.txt': 'pytest\n' })), 'python3 -B -m pytest -p no:cacheprovider --junitxml=.sflow/results/python-tests.xml');
  assert.equal(await argv(await repo({ 'noxfile.py': 'import nox\n' })), 'python3 -B -m pytest -p no:cacheprovider --junitxml=.sflow/results/python-tests.xml');
  assert.equal(await argv(await repo({ 'pyproject.toml': '[project]\nname = "shop"\n', 'uv.lock': 'version = 1\n' })),
    'uv run --locked python -B -m pytest -p no:cacheprovider --junitxml=.sflow/results/python-tests.xml');
  // A uv workspace keeps its lock at the root; a member runs under it.
  assert.equal(await argv(await repo({ 'uv.lock': 'version = 1\n', 'pyproject.toml': '[tool.uv.workspace]\n', 'packages/cart/pyproject.toml': '[project]\nname = "cart"\n',
    'packages/cart/app.py': '' }), 'packages/cart'), 'uv run --locked python -B -m pytest -p no:cacheprovider --junitxml=.sflow/results/python-tests.xml');
  assert.equal(await argv(await repo({ 'pyproject.toml': '[tool.poetry]\nname = "shop"\n', 'poetry.lock': '' })),
    'poetry run python -B -m pytest -p no:cacheprovider --junitxml=.sflow/results/python-tests.xml');
  // The whole-repository inference agrees for a project with no pyproject.toml.
  assert.deepEqual((await inferRepositoryTestCommands(await repo({ 'requirements-dev.txt': 'pytest\n' }))).map((command) => [command.id, command.affectedRoots]), [['python-tests', ['.']]]);
  // An environment.yml that declares dependencies is still a conda build SFlow does not run.
  await assert.rejects(resolveAffectedModule(await repo({ 'environment.yml': 'dependencies:\n  - numpy\n' }), 'app.py'), (error) => error.code === 'TEST_MODULE_UNCOVERED');

  const root = await repository(t, { 'svc/tests/test_cart.py': ['import pytest', '', '# @ac:SHOP-1:AC-001', 'def test_adds():', '    assert True', '',
    '# @ac:SHOP-1:AC-002', "@pytest.mark.parametrize('count', [1, 2])", 'def test_counts(count):', '    assert count', '', 'class TestCheckout:',
    '    # @ac:SHOP-1:AC-003', '    def test_pays(self):', '        assert True', '', '    def helper(self):', '        pass', '', '# @ac:SHOP-1:AC-004', 'def test_filtered():', '    assert True',
    '', '# @ac:SHOP-1:AC-005', 'VALUE = 1', ''].join('\n'),
  'svc/.sflow/results/python-tests.xml': '<testsuites><testsuite name="pytest" tests="4" failures="0" errors="0" skipped="0">'
    + '<testcase classname="tests.test_cart" name="test_adds"/><testcase classname="tests.test_cart" name="test_counts[1]"/>'
    + '<testcase classname="tests.test_cart" name="test_counts[2]"/><testcase classname="tests.test_cart.TestCheckout" name="test_pays"/></testsuite></testsuites>\n' });
  const command = { id: 'svc-python-tests', kind: 'test', argv: ['uv', 'run', '--locked', 'python', '-B', '-m', 'pytest', '-k', 'not filtered', '--junitxml=.sflow/results/python-tests.xml'],
    workingDirectory: 'svc', affectedRoots: ['svc'], result: { adapter: 'junit-xml', path: '.sflow/results/python-tests.xml' } };
  const profile = profileForCommand(command);
  assert.equal(profile, 'pytest-junit-v1');
  const discovered = await discoverDeclarations(root, profile, ['svc/tests/test_cart.py']);
  assert.deepEqual(discovered.declarations.map((entry) => [entry.className, entry.methodName, entry.clauseIds]), [
    ['svc.tests.test_cart', 'test_adds', ['SHOP-1:AC-001']], ['svc.tests.test_cart', 'test_counts', ['SHOP-1:AC-002']],
    ['svc.tests.test_cart.TestCheckout', 'test_pays', ['SHOP-1:AC-003']], ['svc.tests.test_cart', 'test_filtered', ['SHOP-1:AC-004']]]);
  assert.deepEqual(discovered.unattachedTags.map((entry) => entry.clauseIds), [['SHOP-1:AC-005']]);
  const occurrences = persistedOccurrences(await parseTestResult(root, command));
  const run = { completed: true, succeeded: true };
  assert.deepEqual(discovered.declarations.map((declaration) => joinWitness(profile, declaration, occurrences, run).outcome), ['passed', 'passed', 'passed', 'missing'],
    'a pytest test that did not run is never credited');
});

const ANDROID_APP = 'plugins {\n  alias(libs.plugins.android.application)\n  alias(libs.plugins.kotlin.android)\n}\nandroid { namespace = "shop" }\n';

/** A directory of fake launchers (`name` → POSIX shell body) to put first on PATH. */
async function launchers(t, scripts) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-tce-bin-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(scripts)) {
    await writeFile(path.join(directory, name), `#!/bin/sh\n${body}\n`);
    await chmod(path.join(directory, name), 0o755);
  }
  const env = { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}` };
  delete env.ANDROID_HOME;
  delete env.ANDROID_SDK_ROOT;
  return env;
}
const ADB_DEVICE = 'printf "List of devices attached\\nemulator-5554\\tdevice\\n\\n"';
const ADB_NONE = 'printf "List of devices attached\\nemulator-5554\\toffline\\n\\n"';

test('Android: a variant\'s unit tests and, with src/androidTest, its connected device tests; Kotlin belongs to Gradle', async (t) => {
  const root = await repository(t, { 'package.json': { private: true, scripts: { test: 'jest' } }, 'android/settings.gradle.kts': 'include(":app")\n', 'android/gradlew': '',
    'android/app/build.gradle.kts': ANDROID_APP, 'android/app/src/main/kotlin/shop/Cart.kt': '', 'android/app/src/test/kotlin/shop/CartTest.kt': '',
    'android/app/src/androidTest/kotlin/shop/CartScreenTest.kt': '', 'tools/Seed.kt': '' });
  const commands = await gate(root, ['android/app/src/main/kotlin/shop/Cart.kt'],
    ['android/app/src/test/kotlin/shop/CartTest.kt', 'android/app/src/androidTest/kotlin/shop/CartScreenTest.kt']);
  assert.deepEqual(commands.map((command) => [command.id, command.argv.join(' '), command.workingDirectory, command.result.path]), [
    ['android/app-gradle-tests', './gradlew :app:testDebugUnitTest', 'android', 'app/build/test-results/testDebugUnitTest'],
    ['android/app-android-connected-tests', './gradlew :app:connectedDebugAndroidTest', 'android', 'app/build/outputs/androidTest-results/connected']]);
  const [unit, connected] = commands;
  // A change under src/main is covered by both; a device test only by the connected run.
  assert.deepEqual([unit, connected].map((command) => testCommandCoversPath(command, 'android/app/src/main/kotlin/shop/Cart.kt')), [true, true]);
  assert.deepEqual([unit, connected].map((command) => testCommandCoversPath(command, 'android/app/src/androidTest/kotlin/shop/CartScreenTest.kt')), [false, true]);
  assert.equal(profileForCommand(unit), 'junit5-gradle-v2', 'Gradle JUnit reports name each test');
  // Kotlin is the Gradle ecosystem's: a root package.json's jest is never evidence for it.
  const [jest] = await gate(root, ['src/value.ts']);
  assert.equal(testCommandCoversPath(jest, 'tools/Seed.kt'), false);
  assert.equal(isTestSourceName('CartTest.kt'), true);
  // Without src/androidTest there is only the unit run.
  await rm(path.join(root, 'android/app/src/androidTest'), { recursive: true });
  assert.deepEqual((await gate(root, ['android/app/src/main/kotlin/shop/Cart.kt'])).map((command) => command.id), ['android/app-gradle-tests']);
});

test('Android: flavors, managed devices and Kotlin multiplatform are proposed; Xcode names its scheme and destination', async (t) => {
  const app = (build, extra = {}) => repository(t, { 'settings.gradle': "include ':app'\n", gradlew: '', 'app/build.gradle': build, 'app/src/main/java/shop/Cart.kt': '', ...extra });
  const refusal = async (root, code) => {
    let caught;
    await assert.rejects(moduleTestCommands(root, await resolveAffectedModule(root, 'app/src/main/java/shop/Cart.kt')), (error) => { caught = error; return error.code === code; });
    assert.deepEqual(caught.details.nextAction, { command: TEST_SETUP_COMMAND });
    return caught.details.proposal;
  };
  const flavors = await refusal(await app("plugins { id 'com.android.application' }\nandroid {\n  flavorDimensions 'tier'\n  productFlavors {\n    free { dimension 'tier' }\n"
    + "    paid { dimension 'tier'; buildConfigField 'String', 'TIER', '\"paid\"' }\n  }\n}\n"), 'GRADLE_TEST_TARGET_REQUIRED');
  assert.deepEqual([flavors.argv, flavors.missing, flavors.choices], [['./gradlew', ':app:testFreeDebugUnitTest'], ['variant'], ['freeDebug', 'paidDebug']]);
  const managed = await refusal(await app("plugins { id 'com.android.library' }\nandroid {\n  testOptions {\n    managedDevices {\n      devices {\n"
    + "        pixel6api34(com.android.build.api.dsl.ManagedVirtualDevice) { device = 'Pixel 6'; apiLevel = 34 }\n      }\n    }\n  }\n}\n",
  { 'app/src/androidTest/java/shop/CartScreenTest.kt': '' }), 'TEST_MODULE_UNCOVERED');
  assert.deepEqual([managed.argv, managed.missing, managed.choices], [['./gradlew', ':app:pixel6api34DebugAndroidTest'], ['device'], ['pixel6api34']]);
  const multiplatform = await refusal(await app('plugins { kotlin("multiplatform") }\nkotlin { jvm() }\n'), 'GRADLE_TEST_TARGET_REQUIRED');
  assert.deepEqual([multiplatform.argv, multiplatform.choices], [['./gradlew', ':app:jvmTest'], ['jvm', 'all']]);
  const xcode = await repository(t, { 'ios/Shop.xcodeproj/project.pbxproj': '// !$*UTF8*$!\n', 'ios/Shop/Cart.swift': '' });
  await assert.rejects(resolveAffectedModule(xcode, 'ios/Shop/Cart.swift'), (error) => {
    assert.match(error.message, /an Xcode project, whose tests need a scheme and a destination.*supply its scheme, destination, result\.path/u);
    assert.deepEqual(error.details.proposal.argv, ['xcodebuild', 'test', '-project', 'Shop.xcodeproj', '-scheme', '<scheme>', '-destination', '<destination>']);
    return true;
  });
  // capability test-setup offers the proposals through the real CLI.
  const root = await app("plugins { id 'com.android.application' }\nandroid { productFlavors { free {} } }\n", { 'ios/Shop.xcodeproj/project.pbxproj': '// !$*UTF8*$!\n' });
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
  const inspected = spawnSync(process.execPath, [CLI, '--no-model', 'capability', 'test-setup', '--source-root', 'ios', '--source-root', 'app', '--json'],
    { cwd: root, encoding: 'utf8', env: ENV, timeout: childTimeout(120_000) });
  assert.deepEqual(JSON.parse(inspected.stdout).diagnostics.map((entry) => [entry.path, entry.code, entry.proposal?.missing]),
    [['ios', 'TEST_MODULE_UNCOVERED', ['scheme', 'destination', 'result.path']], ['app', 'GRADLE_TEST_TARGET_REQUIRED', ['variant']]], inspected.stdout);
});

test('a connected Android run starts only while adb lists a device; otherwise it is blocked with ANDROID_DEVICE_UNAVAILABLE', async (t) => {
  const root = await repository(t, {});
  const ran = path.join(root, 'gradlew-ran');
  await writeFile(path.join(root, 'gradlew'), `#!/bin/sh\ntouch '${ran}'\n`);
  await chmod(path.join(root, 'gradlew'), 0o755);
  const { androidDeviceUnavailable } = await import('../src/test-module-markers.mjs');
  const { runQualityCommand } = await import('../src/quality-command-runner.mjs');
  assert.equal(await androidDeviceUnavailable(await launchers(t, { adb: ADB_DEVICE })), null);
  for (const env of [await launchers(t, { adb: ADB_NONE }), { ...process.env, PATH: '/nonexistent', ANDROID_HOME: '/nonexistent' }]) {
    const result = await runQualityCommand('./gradlew', [':app:connectedDebugAndroidTest'], { cwd: root, env, timeoutMs: 30_000 });
    assert.equal(result.error.code, 'ANDROID_DEVICE_UNAVAILABLE');
    assert.match(result.error.message, /^ANDROID_DEVICE_UNAVAILABLE: no Android device or emulator is attached.*emulator -avd <name>.*never starts an emulator/u);
    await assert.rejects(readFile(ran), { code: 'ENOENT' }, 'the connected run was never started');
  }
  // ANDROID_HOME's platform-tools adb is preferred to PATH's.
  const sdk = await repository(t, {});
  await mkdir(path.join(sdk, 'platform-tools'));
  await writeFile(path.join(sdk, 'platform-tools/adb'), `#!/bin/sh\n${ADB_DEVICE}\n`);
  await chmod(path.join(sdk, 'platform-tools/adb'), 0o755);
  assert.equal(await androidDeviceUnavailable({ ...await launchers(t, { adb: ADB_NONE }), ANDROID_HOME: sdk }), null);
  const unit = await runQualityCommand('./gradlew', [':app:testDebugUnitTest'], { cwd: root, env: { ...process.env, ANDROID_HOME: '/nonexistent' }, timeoutMs: 30_000 });
  assert.equal(unit.status, 0, 'a unit run needs no device');
  assert.equal((await readFile(ran, 'utf8')), '');
});

test('capability test-setup suggests every runner a package declares, through the real CLI', async (t) => {
  const root = await repository(t, {
    'web/package.json': { scripts: { test: 'react-scripts test', 'e2e:ci': 'playwright test --project=chromium' },
      dependencies: { 'react-scripts': '5.0.1' }, devDependencies: { '@playwright/test': '1.48.0' } },
    'dotnet/src/App/App.csproj': '<Project Sdk="Microsoft.NET.Sdk" />\n',
    'dotnet/tests/App.Tests/App.Tests.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="..\\..\\src\\App\\App.csproj" /></ItemGroup></Project>\n',
    'svc/requirements.txt': 'pytest\n', 'svc/poetry.lock': '', 'svc/pyproject.toml': '[tool.poetry]\nname = "svc"\n'
  });
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
  const result = spawnSync(process.execPath, [CLI, '--no-model', 'capability', 'test-setup', '--source-root', 'web', '--source-root', 'dotnet/src/App',
    '--source-root', 'svc', '--json'], { cwd: root, encoding: 'utf8', env: ENV, timeout: childTimeout(120_000) });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).suggestions.map((entry) => [entry.id, entry.argv.join(' '), entry.workingDirectory]), [
    ['web-node-tests', 'npm test -- --watchAll=false --json --outputFile .sflow/results/node-tests.json', 'web'],
    ['web-playwright-tests', 'npm run e2e:ci -- --reporter=json', 'web'],
    ['dotnet/tests/App.Tests-dotnet-tests', 'dotnet test App.Tests.csproj --logger trx --results-directory TestResults', 'dotnet/tests/App.Tests'],
    ['svc-python-tests', 'poetry run python -B -m pytest -p no:cacheprovider --junitxml=.sflow/results/python-tests.xml', 'svc']]);
});

/**
 * A classic-delivery Story at its implementation step, planned for one criterion. `env` is the CLI's
 * (fake launchers first on PATH); `configure` edits the workflow before the first commit.
 */
async function implementationStory(t, W, { files, expected, tests, env, configure = () => {} }) {
  const AC = `${W}:AC-001`;
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-tce-ecosystem-story-'));
  const remote = `${root}.git`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(remote, { recursive: true, force: true })]));
  const run = (command, args) => spawnSync(command, args, { cwd: root, encoding: 'utf8', env, timeout: childTimeout(240_000) });
  const must = (command, args) => {
    const result = run(command, args);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const sflow = (...args) => must(process.execPath, [CLI, '--no-model', ...args]);
  const write = async (relative, contents, mode) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), typeof contents === 'string' ? contents : JSON.stringify(contents));
    if (mode) await chmod(path.join(root, relative), mode);
  };
  must('git', ['init', '-q', '-b', 'main']);
  must('git', ['config', 'user.name', 'Ecosystem Tester']);
  must('git', ['config', 'user.email', 'ecosystem@example.test']);
  for (const [relative, contents] of Object.entries(files)) await write(relative, ...[contents].flat());
  sflow('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  configure(config);
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']);
  must('git', ['commit', '-qm', 'Initialize the ecosystem fixture']);
  must('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  must('git', ['remote', 'add', 'origin', remote]);
  must('git', ['push', '-q', '-u', 'origin', 'main']);
  sflow('start', W, '--from-branch', 'main', '--work-type', 'classic-delivery', '--title', 'Change the value', '--description', 'Return 2.');
  const item = path.join(root, 'singularity/work-items', W);
  sflow('prepare', 'intake');
  const list = (paths) => paths.map((entry) => `\`${entry}\``).join(', ');
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), [`# ${W} — intake`, '', '## Request and outcome', '',
    'Return the approved value 2 from every module that holds it.', '', '## Scope and constraints', '',
    'Change only the value modules and their tests.', '', '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|',
    `| [${AC}] | Every module's value equals 2. |`, '', '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests | Fulfillment |', '|---|---|---|---|', `| \`${AC}\` | ${list(expected)} | ${list(tests)} | modified |`, '',
    '## Initial evidence', '', 'The baseline modules and tests at the pinned main revision.', ''].join('\n'));
  sflow('wm', 'compose', '--phase', 'intake');
  sflow('clarification', 'record', 'intake', '--question', 'Is 2 the approved value?', '--answer', 'Yes.');
  sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  sflow('submit', 'intake');
  sflow('approve', 'intake', '--yes');
  sflow('prepare', 'implementation');
  const summary = path.join(item, 'artifacts/implementation/implementation-summary.md');
  await writeFile(summary, (await readFile(summary, 'utf8')).replace(/TODO:[^\n]*/gu, 'Every value module returns the approved value.'));
  const json = (...args) => {
    const result = run(process.execPath, [CLI, '--no-model', ...args, '--json']);
    return { status: result.status, body: JSON.parse(result.stdout), text: result.stdout + result.stderr };
  };
  const attempts = async () => {
    const directory = path.join(item, 'context/code-delivery/tests/attempts/implementation');
    return Promise.all((await readdir(directory)).sort().map(async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8'))));
  };
  return { root, AC, item, write, must, json, attempts,
    publish: () => json('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place') };
}

// Fake launchers that refuse any invocation but the one the inference should produce, then write the report it names.
const NODE_BIN = (body) => [`#!${process.execPath}`, "const { mkdirSync, writeFileSync } = require('node:fs');", "const path = require('node:path');",
  'const args = process.argv.slice(2);', "const write = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };", body, ''].join('\n');
const REACT_SCRIPTS = NODE_BIN(["if (args[0] !== 'test' || !args.includes('--watchAll=false') || !args.includes('--json')) { console.error('react-scripts would watch'); process.exit(4); }",
  "write(args[args.indexOf('--outputFile') + 1], JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0,",
  "  testResults: [{ assertionResults: [{ ancestorTitles: ['value'], title: 'returns the approved value', fullName: 'value returns the approved value', status: 'passed', duration: 2 }] }] }));"].join('\n'));
const PLAYWRIGHT = NODE_BIN(["if (args[0] !== 'test' || !args.includes('--project=chromium') || !args.includes('--reporter=json') || !process.env.PLAYWRIGHT_JSON_OUTPUT_FILE) process.exit(5);",
  "const file = 'value.spec.ts';",
  "write(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify({ suites: [{ title: file, file, specs: [], suites: [{ title: 'value', file, line: 3, specs: [{ title: 'shows the approved value', file, line: 5,",
  "  tests: [{ projectName: 'chromium', status: 'expected', results: [{ status: 'passed', duration: 30 }] }] }] }] }], stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 } }));"].join('\n'));
const junit = (classname, name) => `<testsuite name="${classname}" tests="1" failures="0" errors="0" skipped="0"><testcase classname="${classname}" name="${name}"/></testsuite>`;
const FAKES = {
  // dotnet test on a project that is not a test project runs nothing and writes no TRX, as the real one does.
  dotnet: ['case "$2" in *Tests.csproj) ;; *) echo "No test is available in $2"; exit 0;; esac', 'mkdir -p TestResults',
    `printf '%s' '<TestRun><ResultSummary outcome="Completed"><Counters total="1" executed="1" passed="1" failed="0" error="0" timeout="0" aborted="0" inconclusive="0" passedButRunAborted="0" notRunnable="0" notExecuted="0" disconnected="0" warning="0" completed="0" inProgress="0" pending="0" /></ResultSummary></TestRun>' > TestResults/sflow.trx`].join('\n'),
  mvn: ['mkdir -p target/surefire-reports', `printf '%s' '${junit('shop.OrdersTest', 'totals')}' > target/surefire-reports/TEST-shop.OrdersTest.xml`,
    'if [ "$1" = verify ]; then mkdir -p target/failsafe-reports', `  printf '%s' '${junit('shop.OrdersIT', 'placesAnOrder')}' > target/failsafe-reports/TEST-shop.OrdersIT.xml`,
    "  printf '%s' '<failsafe-summary result=\"0\"><completed>1</completed></failsafe-summary>' > target/failsafe-reports/failsafe-summary.xml; fi"].join('\n'),
  uv: ['[ "$1 $2 $3" = "run --locked python" ] || exit 6', 'for argument in "$@"; do case "$argument" in --junitxml=*) report="${argument#--junitxml=}";; esac; done',
    'mkdir -p "$(dirname "$report")"', `printf '%s' '<testsuites>${junit('tests.test_app', 'test_value')}</testsuites>' > "$report"`].join('\n'),
  cargo: ['[ "$*" = "test -- -Z unstable-options --format json" ] || exit 7', `printf '%s\\n' '{ "type": "suite", "event": "started", "test_count": 1 }' \\
  '{ "type": "test", "event": "started", "name": "tests::value" }' '{ "type": "test", "name": "tests::value", "event": "ok" }' \\
  '{ "type": "suite", "event": "ok", "passed": 1, "failed": 0, "ignored": 0, "measured": 0, "filtered_out": 0, "exec_time": 0.001 }'`].join('\n'),
  // A device is attached once the test creates the flag file the adb fake names.
  adb: 'if [ -f "$SFLOW_TEST_DEVICE_FLAG" ]; then ' + ADB_DEVICE + '; else ' + ADB_NONE + '; fi'
};
const GRADLEW = ['#!/bin/sh', 'case "$1" in', `  :app:testDebugUnitTest) mkdir -p app/build/test-results/testDebugUnitTest; printf '%s' '${junit('shop.CartTest', 'totals')}' > app/build/test-results/testDebugUnitTest/TEST-shop.CartTest.xml;;`,
  `  :app:connectedDebugAndroidTest) mkdir -p app/build/outputs/androidTest-results/connected/debug; printf '%s' '${junit('shop.CartScreenTest', 'showsCart')}' > "app/build/outputs/androidTest-results/connected/debug/TEST-emulator-5554 - app-.xml";;`,
  '  *) exit 8;;', 'esac', ''].join('\n');

const tagged = (AC, comment, line) => `${comment} @clause:${AC} returns the approved value\n${line}`;
const POLYGLOT = {
  '.gitignore': 'node_modules/\n.sflow/\nTestResults/\ntarget/\nbuild/\n',
  'web/package.json': { private: true, scripts: { test: 'react-scripts test', 'e2e:ci': 'playwright test --project=chromium' },
    dependencies: { 'react-scripts': '5.0.1' }, devDependencies: { '@playwright/test': '1.48.0' } },
  'web/node_modules/.bin/react-scripts': [REACT_SCRIPTS, 0o755], 'web/node_modules/.bin/playwright': [PLAYWRIGHT, 0o755],
  'web/src/value.js': 'exports.value = 1;\n',
  'web/src/value.test.js': "const { value } = require('./value');\ndescribe('value', () => {\n  test('returns the approved value', () => expect(value).toBe(1));\n});\n",
  'web/e2e/value.spec.ts': "import { test, expect } from '@playwright/test';\n\ntest.describe('value', () => {\n  test('shows the approved value', async () => {});\n});\n",
  'dotnet/src/App/App.csproj': '<Project Sdk="Microsoft.NET.Sdk" />\n', 'dotnet/src/App/Value.cs': 'public static class Value { public const int Current = 1; }\n',
  'dotnet/tests/App.Tests/App.Tests.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="..\\..\\src\\App\\App.csproj" /></ItemGroup></Project>\n',
  'orders/pom.xml': '<project>\n  <build><plugins><plugin><artifactId>maven-failsafe-plugin</artifactId></plugin></plugins></build>\n</project>\n',
  'orders/src/main/java/shop/Orders.java': 'package shop;\nfinal class Orders { static final int VALUE = 1; }\n',
  'svc/pyproject.toml': '[project]\nname = "svc"\n', 'svc/uv.lock': 'version = 1\n', 'svc/app.py': 'VALUE = 1\n',
  'svc/tests/test_app.py': 'from app import VALUE\n\ndef test_value():\n    assert VALUE == 1\n',
  'android/settings.gradle.kts': 'include(":app")\n', 'android/gradlew': [GRADLEW, 0o755], 'android/app/build.gradle.kts': ANDROID_APP,
  'android/app/src/main/kotlin/shop/Cart.kt': 'package shop\nconst val VALUE = 1\n', 'android/app/src/androidTest/kotlin/shop/CartScreenTest.kt': 'package shop\nclass CartScreenTest\n',
  'crate/Cargo.toml': '[package]\nname = "shop"\nversion = "0.1.0"\n', 'crate/src/lib.rs': 'pub const VALUE: i32 = 1;\n'
};
const CARGO_COMMAND = { id: 'crate-cargo-tests', kind: 'test', argv: ['cargo', 'test', '--', '-Z', 'unstable-options', '--format', 'json'], workingDirectory: 'crate',
  affectedRoots: ['crate'], modelPolicy: 'never', result: { adapter: 'cargo-json', path: '.sflow/results/cargo.jsonl', minimumDiscovered: 1 } };

test('a polyglot Story publishes and submits with each ecosystem\'s own runner, report and per-test evidence',
  { ...slowLane({ timeout: 600_000 }), skip: process.platform === 'win32' ? 'POSIX launcher fixtures' : slowLane().skip }, async (t) => {
    const W = 'TCE-7';
    const fakes = await launchers(t, FAKES);
    const flag = path.join(path.dirname(fakes.PATH.split(path.delimiter)[0]), `${path.basename(fakes.PATH.split(path.delimiter)[0])}-device`);
    t.after(() => rm(flag, { force: true }));
    const story = await implementationStory(t, W, {
      files: POLYGLOT, env: { ...ENV, PATH: fakes.PATH, ANDROID_HOME: '', ANDROID_SDK_ROOT: '', SFLOW_TEST_DEVICE_FLAG: flag },
      configure: (config) => { config.phases.implementation.qualityCommands = [CARGO_COMMAND]; },
      expected: ['web/src/value.js', 'dotnet/src/App/Value.cs', 'orders/src/main/java/shop/Orders.java', 'svc/app.py', 'android/app/src/main/kotlin/shop/Cart.kt', 'crate/src/lib.rs'],
      tests: ['web/src/value.test.js', 'web/e2e/value.spec.ts', 'svc/tests/test_app.py']
    });
    const { AC } = story;
    await story.write('web/src/value.js', tagged(AC, '//', 'exports.value = 2;\n'));
    await story.write('web/src/value.test.js', `const { value } = require('./value');\ndescribe('value', () => {\n  // @ac:${AC}\n  test('returns the approved value', () => expect(value).toBe(2));\n});\n`);
    await story.write('web/e2e/value.spec.ts', `import { test, expect } from '@playwright/test';\n\ntest.describe('value', () => {\n  // @ac:${AC}\n  test('shows the approved value', async () => {});\n});\n`);
    await story.write('dotnet/src/App/Value.cs', tagged(AC, '//', 'public static class Value { public const int Current = 2; }\n'));
    await story.write('orders/src/main/java/shop/Orders.java', tagged(AC, '//', 'package shop;\nfinal class Orders { static final int VALUE = 2; }\n'));
    await story.write('svc/app.py', tagged(AC, '#', 'VALUE = 2\n'));
    await story.write('svc/tests/test_app.py', `from app import VALUE\n\n# @ac:${AC}\ndef test_value():\n    assert VALUE == 2\n`);
    await story.write('android/app/src/main/kotlin/shop/Cart.kt', tagged(AC, '//', 'package shop\nconst val VALUE = 2\n'));
    await story.write('crate/src/lib.rs', tagged(AC, '//', 'pub const VALUE: i32 = 2;\n'));
    // The inferred commands publication will run (the configured cargo command is the workflow's own).
    const argv = { [CARGO_COMMAND.id]: CARGO_COMMAND.argv.join(' '), ...Object.fromEntries(story.json('phase', 'prepublish', 'implementation').body.testExecution.commands
      .filter((entry) => entry.argv).map((entry) => [entry.id, entry.argv.join(' ')])) };
    // With no device attached the connected Android run never starts, and publication says why.
    const blocked = story.publish();
    assert.notEqual(blocked.status, 0, blocked.text);
    assert.match(blocked.text, /ANDROID_DEVICE_UNAVAILABLE: no Android device or emulator is attached/u);
    await assert.rejects(readFile(path.join(story.root, 'android/app/build/outputs/androidTest-results/connected/debug/TEST-emulator-5554 - app-.xml')),
      { code: 'ENOENT' }, 'the connected run never started');
    await writeFile(flag, '');
    const published = story.publish();
    assert.equal(published.status, 0, published.text);
    const passed = Object.fromEntries((await story.attempts()).filter((attempt) => attempt.status === 'passed')
      .map((attempt) => [attempt.commandId, [argv[attempt.commandId], attempt.adapter, attempt.occurrences.map((entry) => entry.name).sort()]]));
    assert.deepEqual(passed, {
      'web-node-tests': ['npm test -- --watchAll=false --json --outputFile .sflow/results/node-tests.json', 'jest-json', ['returns the approved value']],
      'web-playwright-tests': ['npm run e2e:ci -- --reporter=json', 'playwright-json', ['shows the approved value']],
      'dotnet/tests/App.Tests-dotnet-tests': ['dotnet test App.Tests.csproj --logger trx --results-directory TestResults', 'dotnet-trx', []],
      'orders-maven-tests': ['mvn verify', 'junit-xml', ['placesAnOrder', 'totals']],
      'svc-python-tests': ['uv run --locked python -B -m pytest -p no:cacheprovider --junitxml=.sflow/results/python-tests.xml', 'junit-xml', ['test_value']],
      'android/app-gradle-tests': ['./gradlew :app:testDebugUnitTest', 'junit-xml', ['totals']],
      'android/app-android-connected-tests': ['./gradlew :app:connectedDebugAndroidTest', 'junit-xml', ['showsCart']],
      'crate-cargo-tests': ['cargo test -- -Z unstable-options --format json', 'cargo-json', ['tests::value']]
    });
    // Submission judges each tagged test against its own runner's attempt: Jest, Playwright and pytest name each test.
    story.must(process.execPath, [CLI, '--no-model', 'submit', 'implementation']);
    const receipt = JSON.parse(await readFile(path.join(story.item, 'context/code-delivery/implementation-gen1.json'), 'utf8'));
    assert.deepEqual(receipt.traceability.witnesses.map((witness) => [witness.testSource, witness.profile, witness.commandId, witness.exact]).sort(), [
      ['svc/tests/test_app.py', 'pytest-junit-v1', 'svc-python-tests', true],
      ['web/e2e/value.spec.ts', 'playwright-json-v1', 'web-playwright-tests', true],
      ['web/src/value.test.js', 'jest-static-v2', 'web-node-tests', true]]);
    assert.deepEqual(receipt.traceability.bindings.map((binding) => [binding.testSource, binding.commandId]).sort(), [
      ['svc/tests/test_app.py', 'svc-python-tests'], ['web/e2e/value.spec.ts', 'web-playwright-tests'], ['web/src/value.test.js', 'web-node-tests']]);
  });
