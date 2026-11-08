import { pathToFileURL } from 'node:url';
/**
 * Run and test from a capability in VS Code: the "Run & test" section, the argv a task runs, the
 * first-run confirmation and the Test summary page. [docs/SPEC-RUN-AND-TEST-v1.md, milestone 4]
 *
 * The fixtures have the shapes the spec gives `app plan --json`, `app status --json` and
 * `tests summary --json`. Everything here is pure: no `vscode`, no process, no shell.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (name) => path.join(root, 'apps', 'vscode', 'src', name);
const model = await import(pathToFileURL(source('views/run-and-test-model.ts')).href);
const { runAndTestHtml, RUN_AND_TEST_SCRIPT } = await import(pathToFileURL(source('views/run-and-test-page.ts')).href);
const summaryModel = await import(pathToFileURL(source('views/test-summary-model.ts')).href);
const { testSummaryHtml, TEST_SUMMARY_SCRIPT } = await import(pathToFileURL(source('views/test-summary-page.ts')).href);
const { bodyHtml, SCRIPT } = await import(pathToFileURL(source('views/capability-page.ts')).href);
const { commandClass } = await import(pathToFileURL(source('cli/client.ts')).href);

const SHA = `sha256:${'a'.repeat(64)}`;
const SHA2 = `sha256:${'b'.repeat(64)}`;
const capability = (overrides = {}) => ({
  id: 'payments-web', name: 'Payments web', kind: 'delivery', delivery: true, repository: 'payments-web',
  repositories: ['payments-web'], children: [], ...overrides
});
const planEntry = (overrides = {}) => ({
  capability: 'payments-web', repository: 'payments-web', id: 'web',
  argv: ['npm', 'run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173'], workingDirectory: 'apps/web',
  url: 'http://127.0.0.1:5173/', ready: { http: '/', timeoutMs: 90000 },
  environments: [{ name: 'dev', status: 'bound', default: true }, { name: 'qa', status: 'unbound', default: false }],
  commandSha256: SHA, ...overrides
});
function summary(overrides = {}) {
  return {
    resultType: 'sflow-test-summary', schemaVersion: 1,
    scope: { kind: 'capability', capability: 'payments-web', workId: null, phase: null },
    run: { id: 'RUN-2', evidenceClass: 'local-preview', label: 'Local preview, not evidence', environment: 'dev', countsForStep: false,
      startedAt: '2026-10-19T10:00:00Z', commit: 'abc1234def5678', uncommittedChanges: true, ranBy: 'ranner@example.com' },
    totals: { discovered: 4, passed: 2, failed: 1, skipped: 1, flaky: 0, durationMs: 1234 },
    commands: [
      { id: 'module-tests', kind: 'test', adapter: 'junit-xml', status: 'failed', exitCode: 1, tests: {}, perCase: true, note: null,
        flaky: { words: 'module-tests is flaky: on the same code and environment TA-1 failed and TA-2 passed', failed: ['TA-1'], passed: ['TA-2'] } },
      { id: 'lint', kind: 'test', adapter: 'exit-code', status: 'passed', exitCode: 0, tests: {}, perCase: false,
        note: 'This report gives totals only. A junit-xml, node-tap, jest-json or vitest-json report would list each test case.' }
    ],
    cases: [
      { command: 'module-tests', suite: 'Cart', name: 'adds an item', file: 'src/cart.test.js', line: 12, outcome: 'passed', durationMs: 5, clauses: ['W-1:AC-001'] },
      { command: 'module-tests', suite: 'Cart', name: 'removes an item', file: 'src/cart.test.js', line: 30, outcome: 'failed', durationMs: 1500, clauses: [],
        message: 'Expected: 1 <item>\nReceived: 2' },
      { command: 'module-tests', suite: 'Cart', name: 'totals', file: 'src/cart.test.js', line: 44, outcome: 'passed', durationMs: 7, clauses: ['W-1:AC-002'] },
      { command: 'module-tests', suite: 'Cart', name: 'skipped one', file: null, line: null, outcome: 'skipped', durationMs: null, clauses: [] }
    ],
    truncated: false, untagged: 2,
    history: [
      { runId: 'RUN-2', at: '2026-10-19T10:00:00Z', evidenceClass: 'local-preview', totals: { discovered: 4, passed: 2, failed: 1, skipped: 1, flaky: 0 } },
      { runId: 'RUN-1', at: '2026-10-18T09:00:00Z', evidenceClass: 'local-preview', environment: 'qa', totals: { discovered: 4, passed: 4, failed: 0, skipped: 0, flaky: 0 } }
    ],
    ...overrides
  };
}

test('app plan|status|suggest, tests summary|plan are reads; app start|stop and tests run execute; VS Code and the CLI agree', async () => {
  const reads = [['app', 'plan', '--capability', 'x', '--json'], ['app', 'plan', '--json'], ['app', 'status', '--capability', 'x', '--json'],
    ['tests', 'summary', '--capability', 'x', '--json'], ['tests', 'summary', '--capability', 'x', '--run=RUN-1', '--json'],
    ['tests', 'plan', '--capability', 'x', '--json'], ['app'], ['app', '--json'], ['tests'], ['tests', '--capability', 'x'],
    ['app', 'suggest', '--capability', 'x', '--json']];
  const executions = [['app', 'start', 'web', '--capability', 'x', '--expect-command', SHA], ['app', 'stop', 'web', '--capability', 'x', '--json'],
    ['tests', 'run', '--capability', 'x', '--expect-command', SHA], ['tests', 'run', '--capability', 'x', '--command', 'a', '--environment', 'qa'],
    ['app', 'start', 'web', '--capability', 'x', '--environment', 'dev', '--debug', '--expect-command', SHA]];
  for (const args of reads) assert.equal(commandClass(args), 'read', args.join(' '));
  for (const args of executions) assert.equal(commandClass(args), 'mutation', args.join(' '));
  assert.equal(commandClass(['app', 'unknown']), 'mutation', 'an unknown subcommand stays conservative');
  const { resolveOperation } = await import(pathToFileURL(path.join(root, 'src', 'command-registry.mjs')).href);
  const { parseArgs } = await import(pathToFileURL(path.join(root, 'src', 'util.mjs')).href);
  const engine = (args) => resolveOperation({ requestedCommand: args[0], ...parseArgs(args) }).classification;
  for (const args of [...reads, ...executions]) assert.equal(commandClass(args), engine(args), `engine and VS Code: ${args.join(' ')}`);
});

test('the client never reuses an app or tests answer from its read cache', async () => {
  const { readFile } = await import('node:fs/promises');
  const client = await readFile(source('cli/client.ts'), 'utf8');
  const cacheable = client.slice(client.indexOf('function cacheableRead'), client.indexOf('export function commandClass'));
  const check = new Function('enabledBooleanOption', `return (${cacheable.trim().replace('args: string[]', 'args').replace('): boolean', ')')});`)(() => false);
  for (const command of ['app', 'tests', 'decisions', 'outcome', 'app-review']) assert.equal(check([command, '--json']), false, `${command} must be read now`);
});

test('app plan is read from its array or envelope; an entry VS Code cannot run exactly is left out', () => {
  const good = planEntry();
  for (const raw of [[good], { entries: [good] }, { resultType: 'command-result', data: { entries: [good] } }, good]) {
    const { entries, dropped } = model.appPlanFrom(raw);
    assert.equal(entries.length, 1);
    assert.deepEqual(dropped, []);
    assert.deepEqual(entries[0].argv, good.argv);
    assert.deepEqual(entries[0].environments.map((choice) => [choice.name, choice.status, choice.default]), [['dev', 'bound', true], ['qa', 'unbound', false]]);
  }
  const { entries, dropped } = model.appPlanFrom([
    planEntry({ id: 'bad-sha', commandSha256: 'nope' }), planEntry({ id: 'ctl', argv: ['npm', 'run\u0007'] }),
    planEntry({ id: '-flag' }), planEntry({ id: 'no-capability', capability: null }), planEntry({ id: 'empty', argv: [] }),
    planEntry({ id: 'legacy', environments: undefined, environment: { name: 'qa', status: 'bound' } })
  ]);
  assert.deepEqual(entries.map((entry) => entry.id), ['legacy']);
  assert.deepEqual(entries[0].environments, [{ name: 'qa', status: 'bound', default: true }]);
  assert.deepEqual(dropped, ['bad-sha', 'ctl', '-flag', 'no-capability', 'empty']);
});

test('app status reads declared, started and ready; ready needs a live process', () => {
  assert.deepEqual(model.appStatusFrom({ entries: [
    { id: 'web', declared: true, started: true, ready: true, url: 'http://127.0.0.1:5173/', pid: 42, environment: 'qa' },
    { id: 'api', declared: true, started: false, ready: true, url: null },
    { id: 'old', declared: false, started: false, ready: false }
  ] }), [
    { id: 'web', declared: true, started: true, ready: true, url: 'http://127.0.0.1:5173/', pid: 42, environment: 'qa', debug: null },
    { id: 'api', declared: true, started: false, ready: false, url: null, pid: null, environment: null, debug: null },
    { id: 'old', declared: false, started: false, ready: false, url: null, pid: null, environment: null, debug: null }
  ]);
});

test('the section belongs to a delivery capability whose repository is this checkout, as Test setup decides', () => {
  assert.equal(model.ownershipOf(capability(), 'payments-web'), 'here');
  assert.equal(model.ownershipOf(capability(), 'other'), 'elsewhere');
  assert.equal(model.ownershipOf(capability(), null), 'unknown-repository');
  assert.equal(model.ownershipOf(capability({ kind: 'collection', delivery: false, repositories: [], repository: null }), 'payments-web'), 'not-delivery');
  assert.equal(model.ownershipOf(capability({ id: 'repository-root', repositories: [], repository: null }), null), 'here', 'the implicit capability is the repository itself');
  const tree = [capability({ id: 'shop', kind: 'collection', delivery: false, repositories: [], repository: null,
    children: [capability(), capability({ id: 'payments-api', repositories: ['api'], repository: 'api' })] })];
  assert.deepEqual(model.capabilitiesHere(tree, 'payments-web').map((node) => node.id), ['payments-web']);
  assert.equal(model.findCapability(tree, 'payments-api')?.id, 'payments-api');
});

test('a start runs `app start <id> --capability <ID> [--environment ENV]` as argv, never a shell string', () => {
  assert.deepEqual(model.appStartArgv('payments-web', 'web', 'qa', SHA),
    ['app', 'start', 'web', '--capability', 'payments-web', '--environment', 'qa', '--expect-command', SHA]);
  assert.deepEqual(model.appStartArgv('payments-web', 'web', null), ['app', 'start', 'web', '--capability', 'payments-web']);
  assert.deepEqual(model.appStopArgv('payments-web', 'web'), ['app', 'stop', 'web', '--capability', 'payments-web', '--json']);
  assert.deepEqual(model.appPlanHereArgv(), ['app', 'plan', '--json']);
  assert.deepEqual(model.testsRunArgv('payments-web', [], 'qa', [SHA, SHA2]),
    ['tests', 'run', '--capability', 'payments-web', '--environment', 'qa', '--expect-command', SHA, '--expect-command', SHA2]);
  assert.throws(() => model.appStartArgv('payments-web', 'web', null, 'not-a-digest'), /invalid/);
  const planned = [{ id: 'a', commandSha256: SHA, environments: [] }, { id: 'b', commandSha256: SHA2, environments: [] }];
  assert.deepEqual(model.plannedIdentities(planned, []), [SHA, SHA2]);
  assert.deepEqual(model.plannedIdentities(planned, ['b']), [SHA2]);
  assert.deepEqual(model.plannedIdentities([{ id: 'a', commandSha256: null, environments: [] }], []), [], 'no identity is claimed for an unplanned command');
  assert.deepEqual(model.appStatusArgv('payments-web'), ['app', 'status', '--capability', 'payments-web', '--json']);
  assert.deepEqual(model.testsRunArgv('payments-web', ['module-tests'], 'dev'),
    ['tests', 'run', '--capability', 'payments-web', '--command', 'module-tests', '--environment', 'dev']);
  for (const bad of [() => model.appStartArgv('payments-web', '--help', null), () => model.appStartArgv('payments-web', 'web', '-x'),
    () => model.testsRunArgv('x;rm', [], null), () => model.testsRunArgv('x', ['a b'], null)]) assert.throws(bad, /invalid/);
  assert.equal(model.displayCommand(['app', 'start', 'web', '--capability', 'payments-web']), 'singularity-flow app start web --capability payments-web');
});

test('the environment is the remembered one when still allowed, else the first listed; tests name one only a command allows', () => {
  const entries = [planEntry()];
  const tests = [{ id: 'integration-tests', kind: 'test', argv: null, workingDirectory: null, commandSha256: SHA2,
    environments: [{ name: 'qa', status: 'unbound', default: true }, { name: 'uat', status: 'bound', default: false }] }];
  const options = model.environmentOptions(entries, tests);
  assert.deepEqual(options.map((choice) => [choice.name, choice.default]), [['dev', true], ['qa', false], ['uat', false]]);
  assert.equal(model.chooseEnvironment(options, 'uat'), 'uat');
  assert.equal(model.chooseEnvironment(options, 'prod'), 'dev', 'a choice no longer allowed falls back to the default');
  assert.equal(model.entryEnvironment(entries[0], 'uat'), 'dev', 'an entry that does not allow the choice runs its own default');
  assert.equal(model.entryEnvironment(entries[0], 'qa'), 'qa');
  assert.equal(model.entryEnvironment({ environments: [] }, 'qa'), null);
  assert.equal(model.testsEnvironment(tests, 'dev'), null);
  assert.equal(model.testsEnvironment(tests, 'uat'), 'uat');
  const both = [...tests, { id: 'module-tests', kind: 'test', argv: null, workingDirectory: null, commandSha256: SHA, environments: [] }];
  assert.equal(model.testsEnvironment(both, 'uat', ['module-tests']), null, 'one command that allows no environment names none');
  assert.equal(model.testsEnvironment(both, 'uat', ['integration-tests']), 'uat');
  assert.equal(model.environmentStatusWords('unbound'), 'not bound');
  assert.equal(model.environmentStatusWords('partial'), 'partly bound');
  assert.equal(model.environmentStatusWords('unavailable'), 'not bound');
  assert.equal(model.environmentStatusWords('undeclared'), 'not declared in singularity/environments.yml');
  const undeclared = model.buildRunAndTestView(capability(), 'here', { plan: model.appPlanFrom([planEntry({ environments: [{ name: 'uat', status: 'undeclared', default: true }] })]).entries });
  assert.equal(undeclared.bind, null, 'binding cannot help an environment environments.yml does not declare');
  assert.equal(model.bindCommand('qa'), 'singularity-flow env bind qa --stdin');
});

test('the first-run confirmation shows exactly what runs and its identity, and no value', () => {
  const entry = model.appPlanFrom([planEntry()]).entries[0];
  const request = model.startConfirmationRequest(entry, 'qa');
  assert.equal(request.title, 'Start web for payments-web');
  assert.equal(request.expected, undefined, 'an acknowledgement, nothing to type');
  assert.equal(request.confirmLabel, 'Run this command');
  for (const line of ['Command: ["npm","run","dev","--","--host","127.0.0.1","--port","5173"]', 'Working directory: apps/web (repository payments-web)',
    'Ready when: HTTP / answers below 500 within 90 s', 'Environment: qa (not bound). Its values go to this process only',
    `Command identity: ${SHA}`, `singularity-flow app start web --capability payments-web --environment qa --expect-command ${SHA}`]) {
    assert.ok(request.detail.includes(line), line);
  }
  const tests = [{ id: 'module-tests', kind: 'test', argv: ['npm', 'test'], workingDirectory: 'apps/web', environments: [], commandSha256: SHA2 }];
  assert.deepEqual(model.testsConfirmationKeys(tests, ['tests', 'run', '--capability', 'payments-web'], []), [SHA2]);
  const fallback = model.testsConfirmationKeys([], ['tests', 'run', '--capability', 'payments-web'], []);
  assert.match(fallback[0], /^vscode-argv:sha256:[a-f0-9]{64}$/, 'an engine without `tests plan` confirms the exact argv');
  assert.notDeepEqual(model.testsConfirmationKeys([], ['tests', 'run', '--capability', 'payments-web', '--command', 'x'], ['x']), fallback);
  assert.match(model.testsConfirmationRequest('payments-web', tests, [], null).detail, /module-tests \(test\): \["npm","test"\]\n  in apps\/web\n  identity sha256:b{64}/);
  // The confirmation says what it found and why, and what a person can do first; nothing there refuses.
  const notes = model.testPlanNotesFrom({ notUsed: [{ why: 'module-tests is configured, so SFlow runs only that.' }], earlyChecks: [{ id: 'dependencies-not-installed', words: 'Dependencies are not installed.', action: 'Run npm ci.' }, { words: '' }] });
  assert.deepEqual(notes, { notUsed: ['module-tests is configured, so SFlow runs only that.'], earlyChecks: [{ words: 'Dependencies are not installed.', action: 'Run npm ci.' }] });
  assert.deepEqual(model.testPlanNotesFrom({ commands: [] }), { notUsed: [], earlyChecks: [] }, 'an older engine has none');
  const worded = model.testPlanFrom({ commands: [{ id: 'module-tests', kind: 'test', argv: ['npm', 'test'], workingDirectory: 'apps/web', commandSha256: SHA2,
    title: 'Tests (Vitest)', why: 'Found in package.json scripts.test, which runs vitest run.', resultsWords: 'Reads each test by name.' }] });
  assert.equal(worded[0].title, 'Tests (Vitest)');
  const detail = model.testsConfirmationRequest('payments-web', worded, [], null, undefined, notes).detail;
  for (const line of ['  Found in package.json scripts.test, which runs vitest run. Reads each test by name.', 'Seen and not used:', 'Before you start (none of these stops the run):', '  Dependencies are not installed.', '  What to do: Run npm ci.']) {
    assert.ok(detail.includes(line), `${line}\n${detail}`);
  }
  assert.deepEqual(model.rememberConfirmed(['a', 'b'], ['b', 'c']), ['a', 'b', 'c']);
  assert.equal(model.rememberConfirmed(Array.from({ length: 250 }, (_, index) => `k${index}`), ['new']).length, 200);
});

test('the section says what each suite runs and why, and what to do before starting', () => {
  const tests = model.testPlanFrom({ commands: [{ id: 'module-tests', kind: 'test', argv: ['npm', 'test'], workingDirectory: '.', commandSha256: SHA2,
    title: 'Browser tests (Playwright)', why: 'Found in package.json scripts.e2e, which runs <playwright>.', resultsWords: 'Reads each test by name.' }] });
  const testNotes = model.testPlanNotesFrom({ notUsed: [{ why: 'unit is configured.' }], earlyChecks: [{ words: 'No browser downloaded.', action: 'Run npx playwright install chromium.' }] });
  const view = model.buildRunAndTestView(capability(), 'here', { tests, testNotes });
  assert.deepEqual(view.testPlan, [{ id: 'module-tests', title: 'Browser tests (Playwright)', why: 'Found in package.json scripts.e2e, which runs <playwright>.', results: 'Reads each test by name.' }]);
  const html = runAndTestHtml(view);
  assert.match(html, /data-rt-suite="module-tests"><strong>Browser tests \(Playwright\)<\/strong>/u);
  assert.ok(html.includes('runs &lt;playwright&gt;.'), 'words from the repository are escaped');
  assert.match(html, /<strong>Seen and not used\.<\/strong> unit is configured\./u);
  assert.match(html, /<strong>Before you start\.<\/strong> No browser downloaded\./u);
  assert.equal(runAndTestHtml(model.buildRunAndTestView(capability(), 'here', { tests: [] })).includes('rt-early'), false);
});

test('the section shows each start entry with its state, the environment picker and the last run', () => {
  const plan = model.appPlanFrom([planEntry(), planEntry({ id: 'api', url: 'http://localhost:8080/', commandSha256: SHA2, environments: [] })]).entries;
  const view = model.buildRunAndTestView(capability(), 'here', {
    plan, status: model.appStatusFrom([{ id: 'web', declared: true, started: true, ready: true, url: 'http://127.0.0.1:5173/', environment: 'qa' }]),
    tasks: { api: { running: false, exitCode: 2 } }, environment: 'qa',
    lastRun: summaryModel.testSummaryFrom(summary())
  });
  const html = runAndTestHtml(view);
  assert.match(html, /data-run-and-test="payments-web"/);
  assert.match(html, /<option value="dev">dev: bound<\/option><option value="qa" selected>qa: not bound<\/option>/);
  assert.match(html, /<code>singularity-flow env bind qa --stdin<\/code>/);
  assert.match(html, /VS Code never asks for, holds or shows a value\./);
  assert.match(html, /data-rt-entry="web" data-rt-state="ready">[\s\S]*Ready<\/span> <small>at http:\/\/127\.0\.0\.1:5173\/<\/small>[\s\S]*environment qa/);
  assert.match(html, /data-rt="start" data-rt-capability="payments-web" data-rt-entry="web" disabled/);
  assert.match(html, /data-rt="open" data-rt-capability="payments-web" data-rt-entry="web">Open in browser/);
  assert.match(html, /data-rt-entry="api" data-rt-state="failed">[\s\S]*Stopped with an error<\/span> <small>exit code 2; its task terminal says why<\/small>/);
  assert.match(html, /data-rt="stop" data-rt-capability="payments-web" data-rt-entry="api" disabled/);
  assert.match(html, /Run all tests[\s\S]*Run module-tests[\s\S]*Run lint/);
  assert.match(html, /<strong>Last run:<\/strong> Local preview · 2 passed, 1 failed, 1 skipped of 4 · environment dev · 2026-10-19T10:00:00Z\s*<button type="button" class="link" data-rt="summary"[^>]*>Open test summary/);
  assert.match(html, /Local preview, not evidence/);
  assert.deepEqual(html.match(/secret[\w ]*/gi), ['secret helper'], 'only the person\'s own secret helper is named; no value is');

  const starting = runAndTestHtml(model.buildRunAndTestView(capability(), 'here', { plan, status: [], tasks: { web: { running: true } }, testsRunning: true }));
  assert.match(starting, /data-rt-entry="web" data-rt-state="starting">[\s\S]*waiting until HTTP \/ answers below 500 within 90 s/);
  assert.match(starting, /data-rt="cancel-tests"/);
  assert.match(starting, /data-rt="tests" data-rt-capability="payments-web" data-rt-command="" disabled/);
  assert.match(runAndTestHtml(model.buildRunAndTestView(capability(), 'here', { plan: [], lastRun: null })),
    /No start entries are declared\. Add application\.start[\s\S]*No test run yet\./);
});

test('collections and other repositories show nothing new; an unknown repository shows only how to open it', () => {
  assert.equal(runAndTestHtml(model.buildRunAndTestView(capability(), 'elsewhere', {})), '');
  assert.equal(runAndTestHtml(model.buildRunAndTestView(capability({ kind: 'collection' }), 'not-delivery', {})), '');
  const hint = runAndTestHtml(model.buildRunAndTestView(capability(), 'unknown-repository', {}));
  assert.match(hint, /Open this capability's repository from Workspaces to run it here/);
  assert.doesNotMatch(hint, /data-rt="start"|data-rt="tests"/);
  // The capability page places the section beside Test setup, only through the host's section.
  const page = bodyHtml([capability()], 'payments-web', null, undefined, 'explicit-legacy', {}, (id) => `<section data-probe="${id}"></section>`);
  assert.match(page, /data-test-setup="payments-web"[\s\S]*<section data-probe="payments-web"><\/section>/);
  assert.doesNotMatch(bodyHtml([capability()], 'payments-web', null, undefined, 'explicit-legacy', {}), /data-probe/);
  assert.match(bodyHtml([capability()], 'payments-web', null, undefined, 'explicit-managed', {}, (id) => `<i data-probe="${id}"></i>`), /data-probe="payments-web"/);
});

test('the section script posts only what the markup names, and the page scripts parse', () => {
  assert.doesNotThrow(() => new Function(SCRIPT));
  assert.doesNotThrow(() => new Function(TEST_SUMMARY_SCRIPT));
  const listeners = {};
  const posted = [];
  const document = { addEventListener: (type, listener) => { (listeners[type] ??= []).push(listener); } };
  new Function('document', 'vscode', RUN_AND_TEST_SCRIPT)(document, { postMessage: (message) => posted.push(message) });
  const element = (selector, dataset, extra = {}) => ({ dataset, ...extra, closest: (query) => (query === selector ? element(selector, dataset, extra) : null) });
  const click = (target) => { for (const listener of listeners.click) listener({ target, preventDefault() {} }); };
  click(element('[data-rt]', { rt: 'start', rtCapability: 'payments-web', rtEntry: 'web' }));
  click(element('[data-rt]', { rt: 'tests', rtCapability: 'payments-web', rtCommand: 'module-tests' }, { disabled: true }));
  for (const listener of listeners.change) listener({ target: element('[data-rt-picker]', { rtCapability: 'payments-web' }, { value: 'qa' }) });
  assert.deepEqual(posted, [
    { type: 'run-and-test', action: 'start', capability: 'payments-web', entry: 'web', command: '', environment: '' },
    { type: 'run-and-test', action: 'environment', capability: 'payments-web', environment: 'qa' }
  ], 'a disabled button posts nothing');
});

test('loopback URLs only: no other host, no credentials, query or fragment', () => {
  assert.equal(model.loopbackUrl('http://127.0.0.1:5173/'), 'http://127.0.0.1:5173/');
  assert.equal(model.loopbackUrl('https://localhost/app'), 'https://localhost/app');
  assert.equal(model.loopbackUrl('http://[::1]:3000/'), 'http://[::1]:3000/');
  for (const bad of ['http://example.com/', 'file:///etc/passwd', 'http://user:pw@127.0.0.1/', 'http://127.0.0.1/?q=1', 'http://127.0.0.1/#x', 'javascript:alert(1)', '', null]) {
    assert.equal(model.loopbackUrl(bad), null, String(bad));
  }
});

test('tests summary argv names the capability or the Story step, and optionally one run', () => {
  assert.deepEqual(summaryModel.testsSummaryArgv({ kind: 'capability', capability: 'payments-web' }), ['tests', 'summary', '--capability', 'payments-web', '--json']);
  assert.deepEqual(summaryModel.testsSummaryArgv({ kind: 'story', workId: 'PAY-12', phase: 'implementation' }, 'TA-7'),
    ['tests', 'summary', '--work-id', 'PAY-12', '--phase', 'implementation', '--run=TA-7', '--json'], 'one token: --run is a boolean flag elsewhere');
  assert.deepEqual(summaryModel.testsSummaryArgv({ kind: 'story', workId: 'PAY-12', phase: null }), ['tests', 'summary', '--work-id', 'PAY-12', '--json']);
  assert.throws(() => summaryModel.testsSummaryArgv({ kind: 'capability', capability: '--x' }), /invalid/);
  assert.throws(() => summaryModel.testsSummaryArgv({ kind: 'story', workId: 'PAY-12', phase: null }, '-r'), /invalid/);
});

test('the test summary page shows totals, each command\'s cases, file links, tags, and per-case notes', () => {
  const parsed = summaryModel.testSummaryFrom({ resultType: 'command-result', data: summary({ truncated: true }) });
  assert.equal(parsed.cases.length, 4);
  assert.equal(summaryModel.testSummaryFrom({ resultType: 'something-else' }), null);
  const view = summaryModel.buildTestSummaryView(parsed, { target: { kind: 'capability', capability: 'payments-web' } });
  const html = testSummaryHtml(view);
  assert.match(html, /<strong>4<\/strong><span>discovered<\/span>[\s\S]*<strong>2<\/strong><span>passed<\/span>[\s\S]*<strong>1<\/strong><span>failed<\/span>/);
  assert.match(html, /data-ts-command="module-tests" data-per-case="true"/);
  assert.match(html, /<button type="button" class="link" data-ts-open="src\/cart\.test\.js" data-ts-line="30">src\/cart\.test\.js:30<\/button>/);
  assert.match(html, /<code class="ts-tag">W-1:AC-001<\/code>/);
  assert.match(html, /data-ts-outcome="failed">[\s\S]*1\.5 s[\s\S]*<span class="muted">untagged<\/span>/);
  // A failed case's message, escaped and kept on its lines; other cases show none [CQF:REQ-014].
  assert.match(html, /<th>Message<\/th>/);
  assert.match(html, /<td class="ts-message"><pre data-ts-message>Expected: 1 &lt;item&gt;\nReceived: 2<\/pre><\/td>/);
  assert.equal(html.match(/data-ts-message/g).length, 1);
  assert.equal(view.commands[0].rows.find((entry) => entry.outcome === 'passed').message, null);
  // A command whose runs disagree is marked flaky, in the engine's words [CQF:REQ-013].
  assert.match(html, /data-ts-command="module-tests"[\s\S]*<span class="pill wait" data-ts-flaky>flaky<\/span>[\s\S]*data-ts-flaky-note="module-tests">module-tests is flaky: on the same code and environment TA-1 failed and TA-2 passed\. It refuses nothing\./);
  assert.equal(html.match(/data-ts-flaky>/g).length, 1, 'only that command');
  assert.match(html, /data-ts-command="lint" data-per-case="false">[\s\S]*A junit-xml, node-tap, jest-json or vitest-json report would list each test case\./);
  assert.match(html, /The list stops at 5,000 test cases/);
  assert.match(html, /<option value="RUN-2" selected title="Local preview, not evidence">Local preview · environment dev · 2026-10-19T10:00:00Z · 2 passed, 1 failed, 1 skipped of 4<\/option>/);
  assert.match(html, /<option value="RUN-1">Local preview · environment qa · 2026-10-18T09:00:00Z · 4 passed of 4<\/option>/);
  assert.match(html, /<p class="ts-label">Local preview, not evidence<\/p>/);
  assert.match(html, /commit abc1234def56 · with uncommitted changes · ran by ranner@example\.com/);
  assert.match(html, /4 of 4 test cases shown\./);
  assert.deepEqual([...summaryModel.caseFiles(parsed)], ['src/cart.test.js']);
});

test('"failed only" and "untagged" filter the cases, alone and together', () => {
  const parsed = summaryModel.testSummaryFrom(summary());
  const names = (filters) => summaryModel.filterCases(parsed.cases, filters).map((entry) => entry.name);
  assert.deepEqual(names({ failedOnly: true, untagged: false }), ['removes an item']);
  assert.deepEqual(names({ failedOnly: false, untagged: true }), ['removes an item', 'skipped one']);
  assert.deepEqual(names({ failedOnly: true, untagged: true }), ['removes an item']);
  const html = testSummaryHtml(summaryModel.buildTestSummaryView(parsed, { target: { kind: 'capability', capability: 'payments-web' }, filters: { failedOnly: true, untagged: false } }));
  assert.match(html, /data-ts-filter="failedOnly" checked/);
  assert.match(html, /1 of 4 test cases shown\./);
  assert.match(html, /1 of 4 shown\./);
  assert.doesNotMatch(html, /adds an item/);
});

test('each run is labelled by its evidence class and environment; a run that does not count for the step says so', () => {
  const story = summaryModel.testSummaryFrom(summary({
    scope: { kind: 'story', capability: 'payments-web', workId: 'PAY-12', phase: 'implementation' },
    run: { id: 'TA-3', evidenceClass: 'local-integration', environment: 'dev', countsForStep: false, startedAt: '2026-10-19T11:00:00Z',
      label: 'Local integration run by ranner@example.com, environment `dev`, commit `abc1234`; values never recorded; does not count for this step: it requires `qa`',
      commit: 'abc1234', uncommittedChanges: false, ranBy: 'ranner@example.com' },
    history: [{ runId: 'TA-2', at: '2026-10-18T11:00:00Z', evidenceClass: 'governed', environment: null, totals: { discovered: 3, passed: 3 } }]
  }));
  const html = testSummaryHtml(summaryModel.buildTestSummaryView(story, { target: { kind: 'story', workId: 'PAY-12', phase: 'implementation' } }));
  // A Story step's failed run offers the question; a capability has no base, and a passing run has nothing to ask.
  assert.match(html, /data-ts-base-run/u);
  assert.deepEqual(summaryModel.testsBaseArgv({ kind: 'story', workId: 'PAY-12', phase: 'implementation' }), ['tests', 'base', '--work-id', 'PAY-12', '--phase', 'implementation', '--json']);
  assert.doesNotMatch(testSummaryHtml(summaryModel.buildTestSummaryView(story, { target: { kind: 'capability', capability: 'payments-web' } })), /data-ts-base-run/u);
  const passing = { ...story, commands: story.commands.map((command) => ({ ...command, status: 'passed' })) };
  assert.doesNotMatch(testSummaryHtml(summaryModel.buildTestSummaryView(passing, { target: { kind: 'story', workId: 'PAY-12', phase: 'implementation' } })), /data-ts-base-run/u);
  const answer = summaryModel.testBaseFrom({ resultType: 'sflow-test-base', baseCommit: 'a'.repeat(40), results: [{ commandId: 'module-tests', verdict: 'fails-on-base', reused: true, words: 'Every failure here also fails without this change.' }] });
  const answered = testSummaryHtml(summaryModel.buildTestSummaryView(story, { target: { kind: 'story', workId: 'PAY-12', phase: 'implementation' }, base: { answer } }));
  assert.match(answered, /data-ts-base-result="module-tests"[\s\S]*already run on this base[\s\S]*Every failure here also fails without this change\./u);
  assert.match(testSummaryHtml(summaryModel.buildTestSummaryView(story, { target: { kind: 'story', workId: 'PAY-12', phase: 'implementation' }, base: { busy: true } })), /data-ts-base-run disabled[\s\S]*Running on the base commit/u);
  assert.equal(summaryModel.testBaseFrom({ resultType: 'other' }), null);
  assert.equal(commandClass(['tests', 'base', '--work-id', 'PAY-12', '--json']), 'mutation', 'it runs repository code, so it is never a read');
  assert.match(TEST_SUMMARY_SCRIPT, /summary\.base/u);
  assert.match(html, /Test summary · PAY-12 · implementation/);
  assert.match(html, /<span class="pill ok">Local integration run<\/span>\s*<span class="pill">environment dev<\/span>/);
  assert.match(html, /data-counts-for-step="false">Local integration run by ranner@example\.com, environment `dev`[^<]*does not count for this step: it requires `qa`/);
  assert.match(html, /<option value="TA-3" selected title="Local integration run by [^"]*">Local integration run · environment dev ·/, 'the shown run is in the picker even when history leaves it out');
  assert.match(html, /<option value="TA-2">Step run \(publish or submit\) · 2026-10-18T11:00:00Z · 3 passed of 3<\/option>/);
  const counted = summaryModel.buildTestSummaryView(summaryModel.testSummaryFrom(summary({ run: { ...summary().run, countsForStep: true } })),
    { target: { kind: 'capability', capability: 'payments-web' } });
  assert.equal(counted.run.countsNote, null);
  assert.equal(summaryModel.evidenceClassLabel('governed'), 'Step run (publish or submit)');
});

test('a command the engine did not run is named with its reason, on the section and the summary', () => {
  const refusal = "Test command 'integration-tests' needs environment 'qa', which is not bound on this computer. Bind it with singularity-flow env bind qa --stdin.";
  const blocked = summaryModel.testSummaryFrom(summary({
    commands: [
      { id: 'module-tests', kind: 'test', adapter: 'node-tap', status: 'passed', exitCode: 0, tests: {}, perCase: true, note: null, environment: null, countsForStep: false },
      { id: 'integration-tests', kind: 'test', adapter: 'node-tap', status: 'blocked', exitCode: null, tests: {}, perCase: false, note: refusal, environment: 'qa', countsForStep: false }
    ],
    cases: [{ command: 'module-tests', suite: null, name: null, file: 'test/a.test.mjs', line: 3, outcome: 'passed', durationMs: 1, clauses: [] }]
  }));
  assert.equal(blocked.cases[0].name, '(unnamed test case)', 'a case without a name is still listed');
  assert.equal(blocked.commands[1].environment, 'qa');
  const section = runAndTestHtml(model.buildRunAndTestView(capability(), 'here', { plan: [], lastRun: blocked }));
  assert.ok(section.includes(`<strong>Not run.</strong> integration-tests (qa): ${refusal.replaceAll("'", '&#39;')}`));
  const page = testSummaryHtml(summaryModel.buildTestSummaryView(blocked, { target: { kind: 'capability', capability: 'payments-web' } }));
  assert.match(page, /data-ts-command="integration-tests" data-per-case="false">[\s\S]*<span class="pill wait">blocked<\/span>[\s\S]*environment qa[\s\S]*is not bound on this computer/);
  // A command's label is shown only when it differs from the run's.
  const labelled = summaryModel.buildTestSummaryView(summaryModel.testSummaryFrom(summary({
    commands: [{ id: 'module-tests', status: 'passed', perCase: true, label: 'Local preview, not evidence' }, { id: 'lint', status: 'passed', perCase: false, label: 'Run by publication' }]
  })), { target: { kind: 'capability', capability: 'payments-web' } });
  assert.deepEqual(labelled.commands.map((command) => command.label), [null, 'Run by publication']);
});

test('a start in an environment that cannot run is refused before anything opens, with what to do about it', () => {
  const entry = model.appPlanFrom([planEntry({ environments: [{ name: 'dev', status: 'bound', default: true }, { name: 'qa', status: 'unbound' },
    { name: 'uat', status: 'undeclared' }, { name: 'old', status: 'unknown' }] })]).entries[0];
  assert.equal(model.startRefusal(entry, 'dev'), null);
  assert.equal(model.startRefusal(entry, null), null);
  assert.equal(model.startRefusal(entry, 'old'), null, 'a status the engine did not report is left to the engine');
  assert.equal(model.startRefusal(entry, 'qa'),
    'web was not started: environment qa is not bound on this computer. Bind its values with your own secret helper, on standard input: singularity-flow env bind qa --stdin');
  assert.match(model.startRefusal(entry, 'uat'), /^web was not started: environment uat is not declared in singularity\/environments\.yml\./);
});

test('a capability\'s local run has no step to count for; the summary says nothing about one', () => {
  const capabilityView = summaryModel.buildTestSummaryView(summaryModel.testSummaryFrom(summary()), { target: { kind: 'capability', capability: 'payments-web' } });
  assert.equal(capabilityView.run.countsForStep, false);
  assert.equal(capabilityView.run.countsNote, null);
  assert.doesNotMatch(testSummaryHtml(capabilityView), /data-counts-for-step/);
  assert.equal(summaryModel.formatDuration(0.4), '<1 ms');
  assert.equal(summaryModel.formatDuration(0), '<1 ms');
  assert.equal(summaryModel.formatDuration(5), '5 ms');
});
