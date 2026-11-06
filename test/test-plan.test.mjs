/**
 * The test plan in words and its early checks (src/test-plan.mjs): what SFlow will run and why, and what
 * would otherwise surface at the end of a step. Nothing here runs a test; the real runs that show each
 * check tells the truth are in test/real-test-tools.test.mjs.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { prepublishTestExecutionLines } from '../src/phase-prepublish.mjs';
import { testExecutionHandoff } from '../src/test-execution-handoff.mjs';
import { moduleTestCommands } from '../src/test-module-markers.mjs';
import { describeTestCommand, earlyTestChecks, nodeRangeAccepts, pathCoverage, suitesNotUsed, testPlanText } from '../src/test-plan.mjs';

async function repository(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-test-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
  for (const [relative, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  }
  return root;
}

const manifest = (fields) => JSON.stringify({ name: 'fixture', private: true, type: 'module', ...fields });
// A machine with nothing a check could find by accident: no Node manager, no browsers, no tools.
const bareMachine = async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-test-plan-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { HOME: home, PATH: path.dirname(process.execPath), PLAYWRIGHT_BROWSERS_PATH: path.join(home, 'browsers') };
};
const ids = (checks) => checks.map((entry) => entry.id).sort();
const nodeCommands = (root) => moduleTestCommands(root, { root: '.', system: 'node', manifest: 'package.json', configured: false });

test('a guessed command says where it was found, how its results are read and what it covers', async (t) => {
  const root = await repository(t, { 'package.json': manifest({ scripts: { test: 'vitest run', 'test:e2e': 'playwright test' }, devDependencies: { vitest: '4', '@playwright/test': '1' } }) });
  const [unit, browser] = await nodeCommands(root);
  const unitWords = await describeTestCommand(root, { ...unit, provenance: 'inferred' });
  assert.equal(unitWords.title, 'Tests (Vitest)');
  assert.equal(unitWords.source, 'found');
  assert.equal(unitWords.why, 'Found in package.json scripts.test, which runs vitest run.');
  assert.equal(unitWords.results, 'each-test');
  assert.deepEqual(unitWords.covers, ['.']);
  const browserWords = await describeTestCommand(root, { ...browser, provenance: 'inferred' });
  assert.equal(browserWords.title, 'Browser tests (Playwright)');
  assert.equal(browserWords.level, 'browser');
  assert.match(browserWords.why, /scripts\.test:e2e, which runs playwright test/u);
});

test('a configured command and a person\'s decision say so, and a counts-only report says what that means', async (t) => {
  const root = await repository(t, { 'go.mod': 'module x\n' });
  const command = { id: 'go-tests', kind: 'test', argv: ['go', 'test', '-json', './...'], workingDirectory: '.', affectedRoots: ['.'], result: { adapter: 'go-test-json', path: 'x' } };
  const configured = await describeTestCommand(root, command, { provenance: 'configured' });
  assert.equal(configured.source, 'configured');
  assert.match(configured.why, /workflow\.yml, which a person approved/u);
  assert.equal(configured.results, 'counts');
  assert.match(configured.resultsWords, /counts only/u);
  const decided = await describeTestCommand(root, { ...command, storyDecision: { id: 'TCD-001' } }, { provenance: 'story-decision' });
  assert.equal(decided.source, 'story-decision');
  assert.match(decided.why, /TCD-001/u);
  assert.equal((await describeTestCommand(root, command, { provenance: 'inferred' })).why, 'Found from go.mod.');
});

test('a configured command that hides another declared suite says so, and a runner with no reader is named', async (t) => {
  const root = await repository(t, { 'package.json': manifest({ scripts: { test: 'vitest run', 'test:e2e': 'playwright test' }, devDependencies: { vitest: '4', '@playwright/test': '1' } }) });
  const configured = { id: 'unit', kind: 'test', argv: ['npm', 'test'], workingDirectory: '.', affectedRoots: ['.'], provenance: 'configured', result: { adapter: 'vitest-json', path: 'r.json' } };
  const seen = await suitesNotUsed(root, [configured]);
  assert.deepEqual(seen.map((entry) => [entry.id, entry.runner]), [['playwright-tests', 'Playwright']]);
  assert.match(seen[0].why, /unit is configured for the repository root, so SFlow runs only that/u);
  // A guessed plan hides nothing: everything the module declares runs.
  const guessed = (await nodeCommands(root)).map((command) => ({ ...command, provenance: 'inferred' }));
  assert.deepEqual(await suitesNotUsed(root, guessed), []);
  const ava = await repository(t, { 'package.json': manifest({ scripts: { test: 'ava' }, devDependencies: { ava: '6' } }) });
  const [unread] = await suitesNotUsed(ava, [{ ...configured, argv: ['node', 'x.js'] }]);
  assert.equal(unread.runner, 'ava');
  assert.match(unread.why, /no reader/u);
});

test('each path says which suite covers it, from what changed, else from the plan', async (t) => {
  const root = await repository(t, { 'package.json': manifest({ scripts: { test: 'vitest run' } }) });
  const command = { id: 'unit', kind: 'test', argv: ['npm', 'test'], workingDirectory: '.', affectedRoots: ['web'], provenance: 'configured', result: { adapter: 'vitest-json', path: 'r.json' } };
  const planned = await pathCoverage(root, [command], { planned: ['web/a.js', 'api/b.js'] });
  assert.equal(planned.from, 'planned');
  assert.deepEqual(planned.covered, [{ path: 'web/a.js', command: 'unit' }]);
  assert.deepEqual(planned.uncovered, ['api/b.js']);
  assert.equal((await pathCoverage(root, [command], { changed: ['web/c.js'], planned: ['web/a.js'] })).from, 'changed');
  assert.equal((await pathCoverage(root, [command])).from, null);
});

test('dependencies not installed: the exact install command the lockfile implies', async (t) => {
  const environment = await bareMachine(t);
  const root = await repository(t, { 'package.json': manifest({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '4' } }), 'package-lock.json': '{}' });
  const [check] = await earlyTestChecks(root, await nodeCommands(root), { environment });
  assert.equal(check.id, 'dependencies-not-installed');
  assert.equal(check.command, 'npm ci');
  assert.match(check.words, /not installed in the repository root/u);
  const pnpm = await repository(t, { 'package.json': manifest({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '4' } }), 'pnpm-lock.yaml': '' });
  assert.equal((await earlyTestChecks(pnpm, await nodeCommands(pnpm), { environment }))[0].command, 'pnpm install --frozen-lockfile');
  // Installed, with the runner there: nothing to say.
  const ready = await repository(t, { 'package.json': manifest({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '4' } }), 'node_modules/.bin/vitest': '' });
  assert.deepEqual(await earlyTestChecks(ready, await nodeCommands(ready), { environment }), []);
  // Installed, without this runner, and the package does not ask for it.
  const stale = await repository(t, { 'package.json': manifest({ scripts: { test: 'vitest run' } }), 'node_modules/.bin/other': '' });
  const [missing] = await earlyTestChecks(stale, await nodeCommands(stale), { environment });
  assert.equal(missing.id, 'runner-not-installed');
  assert.match(missing.words, /vitest is not installed/u);
  assert.match(missing.action, /does not depend on vitest/u);
});

test('a plan naming a browser test with no browser runner says so once, and what adding one costs', async (t) => {
  const environment = await bareMachine(t);
  const root = await repository(t, { 'package.json': manifest({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '4' } }), 'node_modules/.bin/vitest': '' });
  const checks = await earlyTestChecks(root, await nodeCommands(root), { environment, planned: ['e2e/binary.spec.js', 'src/a.test.js'] });
  const planned = checks.find((entry) => entry.id === 'planned-runner-missing');
  assert.match(planned.words, /e2e\/binary\.spec\.js, which reads as a browser test, but package\.json has no Playwright or Cypress yet/u);
  assert.match(planned.action, /name them in the plan's supporting files/u);
  // The same plan's spec is also within Vitest's reach once it is written.
  assert.ok(ids(checks).includes('runner-collects-other-tests'));
  const unit = await earlyTestChecks(root, await nodeCommands(root), { environment, planned: ['src/a.test.js'] });
  assert.deepEqual(unit, [], 'a unit test the runner already takes says nothing');
});

test('a runner that would collect a Playwright spec is named before it fails, and a config that keeps them apart says nothing', async (t) => {
  const environment = await bareMachine(t);
  const spec = "import { test } from '@playwright/test';\ntest('x', async () => {});\n";
  const files = { 'package.json': manifest({ scripts: { test: 'vitest run', 'test:e2e': 'playwright test' }, devDependencies: { vitest: '4', '@playwright/test': '1' } }),
    'node_modules/.bin/vitest': '', 'node_modules/.bin/playwright': '', 'e2e/a.spec.js': spec };
  const root = await repository(t, { ...files, 'vite.config.js': "export default { test: { environment: 'node' } };\n" });
  await mkdir(path.join(environment.PLAYWRIGHT_BROWSERS_PATH, 'chromium-1'), { recursive: true });
  const [collected] = await earlyTestChecks(root, await nodeCommands(root), { environment });
  assert.equal(collected.id, 'runner-collects-other-tests');
  assert.match(collected.words, /Vitest would also collect e2e\/a\.spec\.js/u);
  assert.match(collected.action, /test\.include or test\.exclude in vite\.config\.js, and name that file in the plan/u);
  const limited = await repository(t, { ...files, 'vite.config.js': "export default { test: { include: ['src/**/*.test.js'] } };\n" });
  assert.deepEqual(await earlyTestChecks(limited, await nodeCommands(limited), { environment }), []);
  const operand = await repository(t, { ...files, 'package.json': manifest({ scripts: { test: 'vitest run src', 'test:e2e': 'playwright test' }, devDependencies: { vitest: '4', '@playwright/test': '1' } }) });
  assert.deepEqual(await earlyTestChecks(operand, await nodeCommands(operand), { environment }), [], 'a script that names its folder keeps them apart');
});

test('no browser downloaded: Playwright says so before its first run', async (t) => {
  const environment = await bareMachine(t);
  const root = await repository(t, { 'package.json': manifest({ scripts: { test: 'playwright test' }, devDependencies: { '@playwright/test': '1' } }), 'node_modules/.bin/playwright': '' });
  const [check] = await earlyTestChecks(root, await nodeCommands(root), { environment });
  assert.equal(check.id, 'browser-not-installed');
  assert.match(check.action, /npx playwright install chromium/u);
  await mkdir(path.join(environment.PLAYWRIGHT_BROWSERS_PATH, 'chromium-1200'), { recursive: true });
  assert.deepEqual(await earlyTestChecks(root, await nodeCommands(root), { environment }), []);
});

test('a Node version: what engines asks for and what the machine would run are compared; a range beyond this reading says nothing', async (t) => {
  assert.equal(nodeRangeAccepts('>=20', '22.1.0'), true);
  assert.equal(nodeRangeAccepts('>=20 <22', '22.1.0'), false);
  assert.equal(nodeRangeAccepts('^22.1', '22.3.0'), true);
  assert.equal(nodeRangeAccepts('^22.1', '23.0.0'), false);
  assert.equal(nodeRangeAccepts('18 || 20.x', '20.5.1'), true);
  assert.equal(nodeRangeAccepts('18 || 20.x', '26.0.0'), false);
  assert.equal(nodeRangeAccepts('~20.5', '20.6.0'), false);
  assert.equal(nodeRangeAccepts('lts/*', '22.0.0'), undefined);
  const environment = await bareMachine(t);
  const running = process.versions.node;
  const root = await repository(t, { 'package.json': manifest({ engines: { node: '<4' }, scripts: { test: 'node --test' } }) });
  const [check] = await earlyTestChecks(root, await nodeCommands(root), { environment });
  assert.equal(check.id, 'node-version');
  assert.match(check.words, new RegExp(`asks for Node <4, and tests here would run on Node ${running.replaceAll('.', '\\.')}`, 'u'));
  assert.match(check.action, /a \.nvmrc in the repository makes SFlow run tests on that version/u);
  const fine = await repository(t, { 'package.json': manifest({ engines: { node: `>=${running.split('.')[0]}` }, scripts: { test: 'node --test' } }) });
  assert.deepEqual(await earlyTestChecks(fine, await nodeCommands(fine), { environment }), []);
  const asks = await repository(t, { 'package.json': manifest({ scripts: { test: 'node --test' } }), '.nvmrc': '4.0.0\n' });
  const [file] = await earlyTestChecks(asks, await nodeCommands(asks), { environment });
  assert.equal(file.id, 'node-version');
  assert.match(file.words, /\.nvmrc asks for Node 4\.0\.0, and no installed Node matches/u);
});

test('Vitest with a DOM environment on Node 25 or later says what will fail, only where the code uses localStorage', async (t) => {
  const environment = await bareMachine(t);
  const files = { 'package.json': manifest({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '4' } }), 'node_modules/.bin/vitest': '',
    'vite.config.js': "export default { test: { environment: 'jsdom' } };\n" };
  const uses = await repository(t, { ...files, 'src/store.js': "export const read = () => localStorage.getItem('a');\n" });
  const quiet = await repository(t, { ...files, 'src/store.js': 'export const read = () => 1;\n' });
  const checks = await earlyTestChecks(uses, await nodeCommands(uses), { environment });
  if (Number(process.versions.node.split('.')[0]) >= 25) {
    assert.equal(checks[0].id, 'node-version');
    assert.match(checks[0].words, /whose own localStorage stands in front of the DOM environment's/u);
    assert.match(checks[0].action, /Do not stub localStorage/u);
  } else assert.deepEqual(checks, [], 'an earlier Node has no localStorage of its own');
  assert.deepEqual(await earlyTestChecks(quiet, await nodeCommands(quiet), { environment }), []);
});

test('a tool the command starts that is not on PATH is named; wrappers in the repository are not asked for', async (t) => {
  const environment = await bareMachine(t);
  const root = await repository(t, { 'go.mod': 'module x\n' });
  const command = { id: 'go-tests', kind: 'test', argv: ['go', 'test', '-json', './...'], workingDirectory: '.', affectedRoots: ['.'], result: { adapter: 'go-test-json', path: 'x' } };
  const [check] = await earlyTestChecks(root, [command], { environment: { ...environment, PATH: path.join(root, 'none') } });
  assert.equal(check.id, 'tool-not-found');
  assert.match(check.words, /Go \(go\) is not on this machine's PATH/u);
  const maven = { ...command, id: 'maven-tests', argv: ['./mvnw', 'test'], result: { adapter: 'junit-xml', path: 'target' } };
  assert.deepEqual(await earlyTestChecks(root, [maven], { environment: { ...environment, PATH: path.join(root, 'none') } }), []);
});

test('an early check never rejects: an unreadable repository says nothing', async () => {
  const checks = await earlyTestChecks('/nonexistent/sflow', [{ id: 'x', kind: 'test', argv: ['npm', 'test'], workingDirectory: '.', result: { adapter: 'vitest-json', path: 'r' } }], { environment: {} });
  assert.ok(Array.isArray(checks));
});

test('the plan reads as words: each suite, what was seen and not used, and what to do before starting', () => {
  const text = testPlanText({
    scope: { kind: 'story', workId: 'QF-1', phase: 'implement' },
    commands: [{ id: '.-node-tests', argv: ['npm', 'test'], workingDirectory: '.', environments: [], title: 'Tests (Vitest)', why: 'Found in package.json scripts.test, which runs vitest run.', resultsWords: 'Reads each test by name.', coversWords: 'Covers the repository root.' }],
    paths: { from: 'planned', total: 2, covered: [{ path: 'a.js', command: '.-node-tests' }], uncovered: ['api/b.py'] },
    notUsed: [{ argv: ['npm', 'run', 'e2e'], why: 'unit is configured for the repository root, so SFlow runs only that.' }],
    earlyChecks: [{ id: 'dependencies-not-installed', words: 'Dependencies are not installed.', action: 'Run npm ci.' }]
  });
  for (const expected of ['For QF-1 step implement SFlow will run one test suite:', '  Tests (Vitest)', 'npm test, in the repository root', 'Reads each test by name.',
    '2 files the plan names: no suite covers api/b.py.', 'Seen and not used', 'npm run e2e: unit is configured', 'Before you start (none of these stops the step; only the gates refuse)',
    'What to do: Run npm ci.', 'Run: singularity-flow tests run --work-id QF-1 --phase implement']) assert.ok(text.includes(expected), `${expected}\n${text}`);
  const none = testPlanText({ scope: { kind: 'capability', capability: 'app' }, commands: [], stopped: { words: 'No runner.' } });
  assert.match(none, /no test command for capability app yet: No runner\./u);
  assert.match(testPlanText({ scope: { kind: 'story', workId: 'QF-1', phase: 'implement' }, prospective: true, commands: [{ id: 'x', argv: ['go', 'test'], workingDirectory: 'svc' }] }),
    /Once the plan's files change, for QF-1 step implement SFlow will run one test suite:[\s\S]*go test, in svc/u);
});

test('at a code step the handoff points to the early checks, and no longer says no runner change is needed when the plan needs one', () => {
  const planned = { id: 'planned-runner-missing', words: 'The plan names e2e/x.spec.js.', action: 'Name them in the plan.' };
  const held = { status: 'unavailable', reason: 'CODE_DELIVERY_INCOMPLETE', blockedBy: ['CODE_DELIVERY_INCOMPLETE'], commands: [] };
  assert.match(testExecutionHandoff(held).guidance, /No test configuration, amendment or runner change is needed/u);
  const needing = testExecutionHandoff({ ...held, earlyChecks: [planned] }).guidance;
  assert.doesNotMatch(needing, /No test configuration/u, 'bin-opr read this on its first turn while its plan needed Playwright');
  assert.match(needing, /read testExecution\.earlyChecks: one thing found in this checkout/u);
  assert.match(needing, /None of them stops the step/u);
  const ready = testExecutionHandoff({ status: 'not-run', commands: [{ availability: 'ready' }], earlyChecks: [planned, planned] }, { command: 'x' });
  assert.equal(ready.runnerStatus, 'ready', 'a check changes nothing about what the runner is');
  assert.match(ready.guidance, /2 things found/u);
  assert.equal(testExecutionHandoff({ status: 'unavailable', commands: [], earlyChecks: [planned] }).runnerStatus, 'unavailable');
  assert.match(prepublishTestExecutionLines({ status: 'not-run', commands: [], earlyChecks: [planned] }).join('\n'), /Before the tests run: The plan names e2e\/x\.spec\.js\. Name them in the plan\./u);
});
