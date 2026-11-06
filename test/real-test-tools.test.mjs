/**
 * The real tools, where they are installed: SFlow's own command for each, run the way a gate runs it
 * (argv, no shell, the gate's environment), with its report read by SFlow's own reader and classifier.
 * Reports written by hand hid a SwiftPM report no repository could pass with, a pytest run with no
 * tests read as invalid XML, and Playwright messages whose quote of the test's source read as an
 * assertion. A tool that is not installed is a visible skip that says so.
 *
 * Vitest and Playwright have no global home: point SINGULARITY_FLOW_TEST_NODE_TOOLS at a folder whose
 * node_modules holds vitest and @playwright/test. Maven runs offline against the developer's own
 * local repository; it never downloads anything for this.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveAffectedModule, testReceiptPassing } from '../src/code-delivery-tests.mjs';
import { runQualityCommand } from '../src/quality-command-runner.mjs';
import { inspectRepositoryTestSetup } from '../src/repository-test-setup.mjs';
import { moduleTestCommands } from '../src/test-module-markers.mjs';
import { gateTestEnvironment } from '../src/test-run-environment.mjs';
import { recordTestAttempt } from '../src/verification/attempts.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const REPORT_ON_STDOUT = new Set(['go-test-json', 'node-tap', 'karma-text', 'cargo-json']);
const CHECKOUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_TOOLS = [process.env.SINGULARITY_FLOW_TEST_NODE_TOOLS, CHECKOUT].filter(Boolean)
  .map((folder) => path.join(folder, 'node_modules'));
const LANE = slowLane({ timeout: 600_000 });
// Release verification forbids skipped tests, and no machine is required to have every one of these tools.
const absent = (t, why) => (process.env.SINGULARITY_FLOW_RELEASE_FAIL_ON_SKIPPED_TEST_FILES === '1' ? t.diagnostic(why) : t.skip(why));

const answers = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: childTimeout(30_000), env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  return !result.error && result.status === 0;
};
const installedModules = (...binaries) => NODE_TOOLS.find((folder) => binaries.every((binary) => existsSync(path.join(folder, '.bin', binary)))) ?? null;

async function repository(t, files, { modules = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-real-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
  for (const [relative, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  }
  if (modules) await symlink(modules, path.join(root, 'node_modules'), 'dir');
  return root;
}

/** One run as a gate makes it, then the attempt recorded from it, with the report, counts and cause. */
async function gateRun(root, command, { env = {}, changedPaths = [] } = {}) {
  const directory = path.join(root, command.workingDirectory);
  const report = path.join(directory, command.result.path);
  await rm(report, { recursive: true, force: true }); // a gate clears what an earlier run left
  await mkdir(path.dirname(report), { recursive: true });
  const { NODE_TEST_CONTEXT: _context, ...inherited } = process.env;
  const environment = { ...gateTestEnvironment({ ...inherited, ...env }, { declared: command.env ?? null }).environment };
  if (command.result.adapter === 'playwright-json') environment.PLAYWRIGHT_JSON_OUTPUT_FILE = report;
  const startedAt = new Date().toISOString();
  const run = await runQualityCommand(command.argv[0], command.argv.slice(1), { cwd: directory, env: environment, timeoutMs: childTimeout(150_000),
    stdoutFile: REPORT_ON_STDOUT.has(command.result.adapter) ? report : null });
  const status = run.timedOut || run.error ? 'blocked' : run.status === 0 ? 'passed' : 'failed';
  const check = { id: command.id, status, exitCode: run.status ?? null, signal: run.signal ?? null, timedOut: run.timedOut === true, startedAt, completedAt: new Date().toISOString(),
    sourceCommit: 'a'.repeat(40), sourceTreeSha256: 'b'.repeat(64), resultIsolated: true, stdout: String(run.stdout ?? ''), stderr: run.error ? `Unable to run quality command: ${run.error.message}` : String(run.stderr ?? '') };
  const recorded = await recordTestAttempt(root, 'singularity/work-items/REAL-1', { command, check, purpose: 'preflight', workId: 'REAL-1', phaseId: 'code', generation: 1,
    delivery: { sourcePaths: changedPaths, testPaths: [] } });
  return { ...recorded, output: `${check.stderr}\n${check.stdout}` };
}

const commandFor = async (root, changedPath) => moduleTestCommands(root, await resolveAffectedModule(root, changedPath));
const names = ({ attempt }) => attempt.occurrences.map((occurrence) => [occurrence.name, occurrence.outcome]).sort();

test('real pytest: each test by name; a run with no tests reads as no tests; python without pytest is a missing dependency', LANE, async (t) => {
  if (!answers('python3', ['-m', 'pytest', '--version'])) return absent(t, 'python3 has no pytest here');
  const pyproject = '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n';
  const root = await repository(t, { 'pyproject.toml': pyproject, 'src/x.py': 'VALUE = 1\n',
    'tests/test_x.py': 'import pytest\n\ndef test_one():\n    assert 1 == 1\n\n@pytest.mark.skip(reason="no")\ndef test_two():\n    pass\n' });
  const [command] = await commandFor(root, 'src/x.py');
  assert.deepEqual(command.argv.slice(1, 4), ['-B', '-m', 'pytest']);
  const ran = await gateRun(root, command);
  assert.equal(testReceiptPassing(ran.attempt), true, ran.output);
  assert.deepEqual(ran.attempt.tests, { discovered: 2, passed: 1, failed: 0, skipped: 1 });
  assert.deepEqual(names(ran), [['test_one', 'passed'], ['test_two', 'skipped']]);

  const empty = await repository(t, { 'pyproject.toml': pyproject, 'tests/README': 'none yet\n' });
  const [none] = await commandFor(empty, 'src/x.py');
  const collected = await gateRun(empty, none);
  assert.equal(collected.attempt.exitCode, 5, collected.output);
  assert.equal(collected.reportError, null, 'the report of a run with no tests is read');
  assert.deepEqual(collected.attempt.tests, { discovered: 0, passed: 0, failed: 0, skipped: 0 });
  assert.equal(testReceiptPassing(collected.attempt), false);
  assert.deepEqual([collected.attempt.cause.category, collected.attempt.cause.class], ['unknown', 'no-tests']);

  // -S leaves site-packages out, so this is python's own words when pytest is not installed.
  const absent = await gateRun(root, { ...command, argv: ['python3', '-S', ...command.argv.slice(1)] });
  if (absent.output.includes('No module named pytest')) assert.deepEqual([absent.attempt.status, absent.attempt.cause.class], ['failed', 'dependency-missing']);
  else t.diagnostic('python3 -S still finds pytest, so its absence was not run');
});

test('real go test: counts its own report from stdout', LANE, async (t) => {
  if (!answers('go', ['version'])) return absent(t, 'go is not installed');
  const root = await repository(t, { 'go.mod': 'module example.test/real\n\ngo 1.21\n', 'a.go': 'package real\n\nfunc A() int { return 1 }\n',
    'a_test.go': 'package real\n\nimport "testing"\n\nfunc TestA(t *testing.T) { if A() != 1 { t.Fatal() } }\nfunc TestB(t *testing.T) { t.Skip("no") }\n' });
  const [command] = await commandFor(root, 'a.go');
  assert.deepEqual(command.argv, ['go', 'test', '-json', './...']);
  const ran = await gateRun(root, command);
  assert.equal(testReceiptPassing(ran.attempt), true, ran.output);
  assert.deepEqual(ran.attempt.tests, { discovered: 2, passed: 1, failed: 0, skipped: 1 });
});

test('real swift test: the empty companion report SwiftPM writes beside its tests does not refuse the set', LANE, async (t) => {
  if (!answers('swift', ['--version'])) return absent(t, 'swift is not installed');
  const root = await repository(t, { 'Package.swift': '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "X", targets: [.target(name: "X"), .testTarget(name: "XTests", dependencies: ["X"])])\n',
    'Sources/X/A.swift': 'public func a() -> Int { 1 }\n',
    'Tests/XTests/ATests.swift': 'import XCTest\n@testable import X\nfinal class ATests: XCTestCase { func testA() { XCTAssertEqual(a(), 1) } }\n' });
  const [command] = await commandFor(root, 'Sources/X/A.swift');
  const ran = await gateRun(root, command);
  if (/no such module 'XCTest'/u.test(ran.output)) return absent(t, 'this Swift toolchain has no XCTest');
  assert.equal(ran.attempt.exitCode, 0, ran.output);
  assert.equal(ran.reportError, null, 'both reports are read');
  assert.deepEqual(ran.attempt.tests, { discovered: 1, passed: 1, failed: 0, skipped: 0 });
  assert.equal(testReceiptPassing(ran.attempt), true);
  assert.deepEqual(ran.parsed.result.files.map((file) => path.basename(file.sourcePath)).sort(), ['tests-swift-testing.xml', 'tests.xml']);
});

test('real mvn: what setup suggests at a reactor root runs, and its report is read', LANE, async (t) => {
  if (!answers('mvn', ['-v'])) return absent(t, 'mvn is not installed');
  const pom = (extra) => `<?xml version="1.0"?><project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>x</groupId>${extra}</project>`;
  const root = await repository(t, {
    'pom.xml': pom('<artifactId>root</artifactId><version>1</version><packaging>pom</packaging><modules><module>svc</module></modules>'),
    'svc/pom.xml': pom('<artifactId>svc</artifactId><version>1</version><properties><maven.compiler.source>17</maven.compiler.source><maven.compiler.target>17</maven.compiler.target><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties><dependencies><dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>5.10.2</version><scope>test</scope></dependency></dependencies>'),
    'svc/src/main/java/A.java': 'public class A { static int a() { return 1; } }\n',
    'svc/src/test/java/ATest.java': 'import org.junit.jupiter.api.*;\nclass ATest { @Test void a() { Assertions.assertEquals(1, A.a()); } }\n' });
  const { suggestions } = await inspectRepositoryTestSetup(root);
  assert.deepEqual(suggestions.map((command) => [command.id, command.workingDirectory, command.result.path]), [['svc-maven-tests', 'svc', 'target/surefire-reports']]);
  // The suite moves HOME, so name the developer's local repository; offline, it downloads nothing.
  const repositoryPath = path.join(os.userInfo().homedir, '.m2', 'repository');
  const ran = await gateRun(root, suggestions[0], { env: { MAVEN_ARGS: `-o -B -Dmaven.repo.local=${repositoryPath}` } });
  if (ran.attempt.exitCode !== 0 && /offline mode|could not be resolved|Could not resolve/iu.test(ran.output)) return absent(t, 'the local Maven repository lacks surefire or junit-jupiter 5.10.2');
  assert.equal(testReceiptPassing(ran.attempt), true, ran.output);
  assert.deepEqual(ran.attempt.tests, { discovered: 1, passed: 1, failed: 0, skipped: 0 });
  assert.deepEqual(names(ran), [['a', 'passed']], 'surefire names each test');
});

test('real vitest: its own reporter beside SFlow\'s, a run with no test files, and a Playwright spec it collects', LANE, async (t) => {
  const modules = installedModules('vitest');
  if (!modules) return absent(t, 'vitest is not installed: set SINGULARITY_FLOW_TEST_NODE_TOOLS to a folder whose node_modules has it');
  const manifest = (script) => JSON.stringify({ private: true, type: 'module', scripts: { test: script }, devDependencies: { vitest: '4', '@playwright/test': '1' } });
  const passing = "import { test, expect } from 'vitest'\ntest('ok', () => { expect(1).toBe(1) })\n";
  const own = await repository(t, { 'package.json': manifest('vitest run --reporter=verbose'), 'src/a.test.js': passing }, { modules });
  const [command] = await commandFor(own, 'src/a.test.js');
  assert.deepEqual(command.argv.slice(0, 3), ['npm', 'test', '--']);
  const ran = await gateRun(own, command);
  assert.equal(testReceiptPassing(ran.attempt), true, ran.output);
  assert.deepEqual(names(ran), [['ok', 'passed']]);

  const nothing = await repository(t, { 'package.json': manifest('vitest run'), 'src/a.js': 'export default 1\n' }, { modules });
  const [noFiles] = await commandFor(nothing, 'src/a.js');
  const empty = await gateRun(nothing, noFiles);
  assert.equal(testReceiptPassing(empty.attempt), false);
  assert.deepEqual([empty.attempt.exitCode, empty.attempt.cause.class], [1, 'no-tests']);

  const hook = await repository(t, { 'package.json': manifest('vitest run'),
    'src/a.test.js': "import { test, afterAll } from 'vitest'\ntest('ok', () => {})\nafterAll(() => { throw new Error('cleanup broke') })\n" }, { modules });
  const threw = await gateRun(hook, (await commandFor(hook, 'src/a.test.js'))[0]);
  assert.deepEqual([threw.attempt.exitCode, threw.attempt.tests.passed], [1, 1], threw.output);
  assert.equal(testReceiptPassing(threw.attempt), false);
  assert.deepEqual([threw.attempt.cause.category, threw.attempt.cause.class], ['code', 'suite-failure']);

  if (!installedModules('vitest', 'playwright')) return t.diagnostic('@playwright/test is not installed, so Vitest collecting a spec was not run');
  const collide = await repository(t, { 'package.json': manifest('vitest run'), 'src/a.test.js': passing,
    'e2e/a.spec.js': "import { test } from '@playwright/test'\ntest('home', () => {})\n" }, { modules });
  const [unit] = await commandFor(collide, 'src/a.test.js');
  const collided = await gateRun(collide, unit, { changedPaths: ['e2e/a.spec.js'] });
  assert.equal(collided.attempt.exitCode, 1, collided.output);
  assert.deepEqual(collided.attempt.tests, { discovered: 1, passed: 1, failed: 0, skipped: 0 }, 'every counted test passed');
  assert.equal(testReceiptPassing(collided.attempt), false, 'the exit code still fails the run');
  assert.deepEqual([collided.attempt.cause.category, collided.attempt.cause.class, collided.attempt.cause.file], ['code', 'foreign-test-file', 'e2e/a.spec.js']);
});

test('real playwright: bare npx keeps --project, a refused page and a taken port are the environment', LANE, async (t) => {
  const modules = installedModules('playwright');
  if (!modules) return absent(t, '@playwright/test is not installed: set SINGULARITY_FLOW_TEST_NODE_TOOLS to a folder whose node_modules has it');
  const manifest = (script) => JSON.stringify({ private: true, type: 'module', scripts: { 'test:e2e': script }, devDependencies: { '@playwright/test': '1' } });
  const twoProjects = "import { defineConfig } from '@playwright/test'\nexport default defineConfig({ testDir: './e2e', projects: [{ name: 'one' }, { name: 'two' }] })\n";
  const selected = await repository(t, { 'package.json': manifest('npx playwright test --project=one'), 'playwright.config.js': twoProjects,
    'e2e/a.spec.js': "import { test } from '@playwright/test'\ntest('works', () => {})\n" }, { modules });
  const [command] = await commandFor(selected, 'e2e/a.spec.js');
  assert.deepEqual(command.argv, ['npx', '--no-install', 'playwright', 'test', '--project=one', '--reporter=json']);
  const ran = await gateRun(selected, command);
  assert.equal(testReceiptPassing(ran.attempt), true, ran.output);
  assert.equal(ran.attempt.tests.discovered, 1, 'only the project the script selects ran');

  // A port only this test knows, so nothing else on the machine answers or holds it.
  const holder = http.createServer((request, response) => response.end('held'));
  await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { holder.close(resolve); holder.closeAllConnections(); }));
  const { port } = holder.address();
  const taken = await repository(t, { 'package.json': manifest('playwright test'),
    'playwright.config.js': `import { defineConfig } from '@playwright/test'\nexport default defineConfig({ testDir: './e2e', webServer: { command: 'node server.js', url: 'http://127.0.0.1:${port}', reuseExistingServer: false, timeout: 15000 } })\n`,
    'server.js': '', 'e2e/a.spec.js': "import { test } from '@playwright/test'\ntest('works', () => {})\n" }, { modules });
  const inUse = await gateRun(taken, (await commandFor(taken, 'e2e/a.spec.js'))[0]);
  assert.equal(testReceiptPassing(inUse.attempt), false);
  assert.deepEqual([inUse.attempt.cause.category, inUse.attempt.cause.class], ['environment', 'port-in-use'], inUse.output);

  // Nothing listens once the holder closes; an assertion after the refused page must not read as the one that failed.
  await new Promise((resolve) => { holder.close(resolve); holder.closeAllConnections(); });
  const refused = await repository(t, { 'package.json': manifest('playwright test'),
    'playwright.config.js': `import { defineConfig } from '@playwright/test'\nexport default defineConfig({ testDir: './e2e', use: { baseURL: 'http://127.0.0.1:${port}', browserName: 'chromium', headless: true } })\n`,
    'e2e/a.spec.js': "import { test, expect } from '@playwright/test'\ntest('home', async ({ page }) => { await page.goto('/'); await expect(page.locator('h1')).toHaveText('hi') })\n" }, { modules });
  const page = await gateRun(refused, (await commandFor(refused, 'e2e/a.spec.js'))[0]);
  if (page.attempt.cause?.class === 'browser-missing') return t.diagnostic('chromium is not installed for this Playwright, so a refused page was not run');
  assert.equal(testReceiptPassing(page.attempt), false);
  assert.deepEqual([page.attempt.tests.failed, page.attempt.cause.category, page.attempt.cause.class], [1, 'environment', 'service-unreachable'], page.output);
});
