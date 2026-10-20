/**
 * IntelliJ-style run configurations in VS Code: the status bar run widget, the Run view and the
 * Testing view, as pure models. [docs/SPEC-RUN-AND-TEST-v1.md, IntelliJ amendment, milestone 13]
 *
 * The fixtures have the shapes `app plan --json` (with the amendment's optional `type` and `name`),
 * `app status --json`, `tests plan --json` and `tests summary --json` give. Nothing here imports
 * `vscode`, starts a process or reads the machine; the host tests drive the same code in the bundle.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (name) => path.join(root, 'apps', 'vscode', 'src', name);
const runModel = await import(source('views/run-and-test-model.ts'));
const summaryModel = await import(source('views/test-summary-model.ts'));
const model = await import(source('views/run-widget-model.ts'));
const manifest = JSON.parse(await readFile(path.join(root, 'apps', 'vscode', 'package.json'), 'utf8'));

const SHA = `sha256:${'a'.repeat(64)}`;
const SHA2 = `sha256:${'b'.repeat(64)}`;
const MAVEN = ['./mvnw', '-q', 'spring-boot:run'];
const typed = (overrides = {}) => ({
  capability: 'payments-web', repository: 'payments-web', id: 'api', name: 'Api', type: 'spring-boot',
  argv: MAVEN, workingDirectory: 'services/api', url: 'http://127.0.0.1:8080/', ready: { http: '/actuator/health', timeoutMs: 180000 },
  environments: [
    { name: 'dev', status: 'bound', default: true, resolved: { argv: [...MAVEN, '-Dspring-boot.run.profiles=dev'], envNames: ['DB_PASSWORD'], beforeLaunch: [] } },
    { name: 'qa', status: 'unbound', default: false, resolved: { argv: [...MAVEN, '-Dspring-boot.run.profiles=qa', '-Dspring-boot.run.jvmArguments=-Xmx2g -Dx=a b'] } }
  ],
  commandSha256: SHA,
  debug: { runtime: 'java', port: 5005, suspend: false, address: '127.0.0.1:5005', argv: [...MAVEN], environmentNames: [], notes: [] },
  ...overrides
});
const plain = (overrides = {}) => ({
  capability: 'payments-web', repository: 'payments-web', id: 'web', argv: ['npm', 'run', 'dev'], workingDirectory: 'apps/web',
  url: 'http://127.0.0.1:5173/', ready: { http: '/', timeoutMs: 90000 }, environments: [], commandSha256: SHA2, ...overrides
});
const status = (overrides = {}) => ({ id: 'api', declared: true, started: true, ready: true, url: 'http://127.0.0.1:8080/', pid: 4242,
  environment: 'qa', debug: null, ...overrides });
const reading = (overrides = {}) => ({
  capability: 'payments-web', name: 'Payments web', plan: runModel.appPlanFrom({ entries: [typed(), plain()] }).entries,
  status: [], tasks: {}, debugging: new Set(), chosen: 'dev', ...overrides
});

test('app plan carries a typed configuration\'s name and type, and reads its resolved argv per environment', () => {
  const { entries, dropped } = runModel.appPlanFrom({ resultType: 'sflow-app-plan', entries: [typed(), plain(),
    typed({ id: 'only-resolved', argv: undefined, name: 'x\u0007', type: 'Spring Boot' })] });
  assert.deepEqual(dropped, []);
  const [api, web, resolvedOnly] = entries;
  assert.deepEqual([api.name, api.type, web.name, web.type], ['Api', 'spring-boot', null, null], 'both are optional');
  assert.deepEqual(runModel.resolvedArgv(api, 'qa').slice(-1), ['-Dspring-boot.run.jvmArguments=-Xmx2g -Dx=a b'], 'resolved.argv wins over argv + arguments');
  assert.deepEqual(resolvedOnly.argv, [...MAVEN, '-Dspring-boot.run.profiles=dev'], 'a typed entry with only its resolved argv still runs exactly');
  assert.equal(resolvedOnly.name, null, 'a name with a control character is not shown');
  assert.equal(resolvedOnly.type, null, 'a type that is not an engine type name is not shown');
  const plan = runModel.testPlanFrom({ commands: [{ id: 'module-tests', kind: 'test', adapter: 'junit-xml', argv: ['npm', 'test'], environments: [], commandSha256: SHA }] });
  assert.equal(plan[0].adapter, 'junit-xml');
});

test('a configuration\'s state is app status plus this window\'s task: stopped, starting, ready, debugging, failed', () => {
  const { configurationState } = model;
  assert.equal(configurationState(undefined, undefined), 'stopped');
  assert.equal(configurationState(status({ declared: false, started: false, ready: false }), undefined), 'stopped');
  assert.equal(configurationState(undefined, { running: true }), 'starting');
  assert.equal(configurationState(status({ ready: false }), undefined), 'starting', 'started elsewhere, not answering yet');
  assert.equal(configurationState(status(), undefined), 'ready');
  assert.equal(configurationState(status(), { running: true, debug: true }, true), 'debugging');
  assert.equal(configurationState(status({ ready: false, debug: { runtime: 'java', port: 5005, listening: true } }), { running: true, debug: true }, true), 'debugging',
    'a suspended JVM listens before it answers');
  assert.equal(configurationState(undefined, { running: true, debug: true }, true), 'starting', 'not listening yet');
  assert.equal(configurationState(undefined, { running: false, exitCode: 1 }), 'failed');
  assert.equal(configurationState(undefined, { running: false, exitCode: 0 }), 'stopped');
  assert.equal(configurationState(undefined, { running: false, exitCode: null }), 'stopped', 'a stop the person asked for is not a failure');
});

test('configurations: the name, type, environment and the engine\'s command line for that environment', () => {
  const [api, web] = model.runConfigurations([reading()]);
  assert.deepEqual([api.key, api.name, api.type, api.state, api.environment, api.debuggable], ['payments-web/api', 'Api', 'spring-boot', 'stopped', 'dev', true]);
  assert.equal(api.commandLine, './mvnw -q spring-boot:run -Dspring-boot.run.profiles=dev');
  assert.deepEqual([web.name, web.type, web.environment, web.debuggable, web.commandLine], ['web', 'command', null, false, 'npm run dev']);
  // Running: the environment it was started in, and its URL and pid.
  const [running] = model.runConfigurations([reading({ status: [status()], chosen: 'dev' })]);
  assert.deepEqual([running.state, running.environment, running.url, running.pid], ['ready', 'qa', 'http://127.0.0.1:8080/', 4242]);
  assert.equal(running.commandLine, "./mvnw -q spring-boot:run -Dspring-boot.run.profiles=qa '-Dspring-boot.run.jvmArguments=-Xmx2g -Dx=a b'");
  assert.equal(model.commandLine(['echo', "it's", '$HOME']), "echo 'it'\\''s' '$HOME'", 'POSIX quoting: copied, never run');
  const [failed] = model.runConfigurations([reading({ tasks: { api: { running: false, exitCode: 3 } } })]);
  assert.deepEqual([failed.state, failed.exitCode], ['failed', 3]);
  const [debugging] = model.runConfigurations([reading({ status: [status({ debug: { runtime: 'java', port: 5005, listening: true } })], debugging: new Set(['api']) })]);
  assert.deepEqual([debugging.state, debugging.listening], ['debugging', '127.0.0.1:5005']);
  const [elsewhere] = model.runConfigurations([reading({ status: [status({ url: 'http://example.com/' })] })]);
  assert.equal(elsewhere.url, 'http://127.0.0.1:8080/', 'a URL that is not loopback is never offered; the declared one is');
});

test('the widget selection is remembered per capability, and falls back when its configuration is gone', () => {
  const configurations = model.runConfigurations([reading(), reading({ capability: 'admin', name: 'Admin', plan: runModel.appPlanFrom([plain({ capability: 'admin', id: 'ui' })]).entries })]);
  assert.equal(model.selectedConfiguration([], null), null);
  assert.equal(model.selectedConfiguration(configurations, null).key, 'payments-web/api', 'nothing remembered: the first');
  assert.equal(model.selectedConfiguration(configurations, { capability: 'payments-web', entries: { 'payments-web': 'web' } }).key, 'payments-web/web');
  assert.equal(model.selectedConfiguration(configurations, { capability: 'admin', entries: {} }).key, 'admin/ui');
  assert.equal(model.selectedConfiguration(configurations, { capability: 'payments-web', entries: { 'payments-web': 'gone' } }).key, 'payments-web/api');
  assert.equal(model.selectedConfiguration(configurations, { capability: 'removed', entries: {} }).key, 'payments-web/api');
  const remembered = model.rememberSelection({ capability: null, entries: { admin: 'ui' } }, configurations[1]);
  assert.deepEqual(remembered, { capability: 'payments-web', entries: { admin: 'ui', 'payments-web': 'web' } });
  assert.deepEqual(model.selectionFrom({ capability: 7, entries: { a: 'b', c: 3 } }), { capability: null, entries: { a: 'b' } });
  assert.deepEqual(model.selectionFrom(undefined), { capability: null, entries: {} });
});

test('the run widget: `$(play) Api · dev`, then Run and Debug, which become Rerun and Stop once started', () => {
  const [stopped, web] = model.runConfigurations([reading()]);
  const idle = model.widgetSpec(stopped);
  assert.equal(idle.configuration.text, '$(play) Api · dev');
  assert.equal(idle.configuration.command, 'singularityFlow.selectRunConfiguration');
  assert.match(idle.configuration.tooltip, /^Api \(spring-boot\) · Payments web\nNot running\nEnvironment: dev\nCommand line: \.\/mvnw -q spring-boot:run -Dspring-boot\.run\.profiles=dev/);
  assert.deepEqual([idle.primary.text, idle.primary.tooltip, idle.primary.command], ['$(play)', 'Run Api · dev', 'singularityFlow.runSelectedConfiguration']);
  assert.deepEqual([idle.debug.text, idle.debug.command], ['$(debug-alt)', 'singularityFlow.debugSelectedConfiguration']);
  assert.equal(idle.stop, null);
  assert.equal(model.widgetSpec(web).debug, null, 'no debug block, no Debug');
  assert.equal(model.widgetSpec(web).configuration.text, '$(play) web', 'no environment, no separator');
  for (const [state, glyph] of [[{ tasks: { api: { running: true } } }, '$(loading~spin)'], [{ status: [status()] }, '$(vm-running)'],
    [{ status: [status({ debug: { runtime: 'java', port: 5005, listening: true } })], debugging: new Set(['api']) }, '$(debug-alt)']]) {
    const [running] = model.runConfigurations([reading(state)]);
    const spec = model.widgetSpec(running);
    assert.ok(spec.configuration.text.startsWith(`${glyph} Api · `), spec.configuration.text);
    assert.deepEqual([spec.primary.text, spec.primary.command, spec.stop.text, spec.stop.command, spec.debug],
      ['$(debug-restart)', 'singularityFlow.rerunSelectedConfiguration', '$(debug-stop)', 'singularityFlow.stopRunningConfiguration', null]);
  }
  const [failed] = model.runConfigurations([reading({ tasks: { api: { running: false, exitCode: 2 } } })]);
  assert.equal(model.widgetSpec(failed).configuration.text, '$(error) Api · dev');
  assert.match(model.widgetSpec(failed).configuration.tooltip, /Stopped with an error · exit code 2/);
  assert.equal(model.widgetSpec(failed).primary.command, 'singularityFlow.runSelectedConfiguration');
});

test('the widget quick pick lists configurations with type icons and state, the environments, and Edit Configurations…', () => {
  const configurations = model.runConfigurations([reading({ status: [status({ id: 'web', url: 'http://127.0.0.1:5173/', environment: null })] })]);
  const entries = model.quickPickEntries(configurations, configurations[0]);
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.label]), [
    ['configuration', '$(server-environment) Api'], ['configuration', '$(terminal) web'],
    ['separator', 'Environment · Api'], ['environment', '$(check) dev'], ['environment', '$(circle-large-outline) qa'],
    ['separator', ''], ['edit', '$(gear) Edit Configurations…']
  ]);
  assert.deepEqual([entries[0].description, entries[0].detail], ['spring-boot · selected', 'Not running · dev · http://127.0.0.1:8080/']);
  assert.deepEqual([entries[1].description, entries[1].detail], ['command', 'Ready · http://127.0.0.1:5173/']);
  assert.equal(entries[3].description, 'bound');
  assert.equal(entries[3].detail, undefined);
  assert.equal(entries[4].description, 'not bound');
  assert.equal(entries[4].detail, 'Bind its values with your own secret helper: singularity-flow env bind qa --stdin', 'a value is never asked for');
  const several = model.quickPickEntries(model.runConfigurations([reading(), reading({ capability: 'admin', name: 'Admin', plan: runModel.appPlanFrom([plain({ capability: 'admin', id: 'ui' })]).entries })]), null);
  assert.equal(several.find((entry) => entry.kind === 'configuration' && entry.key === 'admin/ui').description, 'command · Admin', 'capability named when several');
  assert.equal(several.some((entry) => entry.kind === 'environment'), false, 'nothing selected: no environment list');
  assert.equal(model.typeIcon('no-such-type'), 'play-circle');
});

/** The Run view's inline actions for a context value, evaluated the way VS Code evaluates package.json. */
function inlineActions(contextValue) {
  return manifest.contributes.menus['view/item/context']
    .filter((entry) => entry.group.startsWith('inline'))
    .filter((entry) => {
      const [, pattern] = /viewItem =~ \/(.+)\/$/.exec(entry.when);
      return entry.when.startsWith('view == singularityFlow.run && ') && new RegExp(pattern).test(contextValue);
    })
    .map((entry) => entry.command.replace('singularityFlow.', ''));
}

test('Run view rows: state icon, environment and URL, and the inline actions each state offers', () => {
  const rows = (state) => model.runConfigurations([reading(state)]).map(model.configurationRow);
  const [stopped, plainStopped] = rows({});
  assert.deepEqual([stopped.label, stopped.description, stopped.icon, stopped.color], ['Api', 'dev · http://127.0.0.1:8080/', 'circle-large-outline', null]);
  assert.equal(stopped.contextValue, 'sflow.runConfiguration.stopped.debuggable');
  assert.deepEqual(inlineActions(stopped.contextValue), ['runConfiguration', 'debugConfiguration', 'showConfigurationLog']);
  assert.deepEqual([plainStopped.description, plainStopped.contextValue], ['no environment · http://127.0.0.1:5173/', 'sflow.runConfiguration.stopped']);
  assert.deepEqual(inlineActions(plainStopped.contextValue), ['runConfiguration', 'showConfigurationLog']);
  const [starting] = rows({ tasks: { api: { running: true } } });
  assert.deepEqual([starting.icon, starting.contextValue], ['loading~spin', 'sflow.runConfiguration.starting']);
  assert.deepEqual(inlineActions(starting.contextValue), ['stopConfiguration', 'showConfigurationLog']);
  const [ready] = rows({ status: [status()] });
  assert.deepEqual([ready.icon, ready.color, ready.contextValue, ready.description], ['pass-filled', 'testing.iconPassed', 'sflow.runConfiguration.ready.browsable', 'qa · http://127.0.0.1:8080/']);
  assert.deepEqual(inlineActions(ready.contextValue), ['stopConfiguration', 'openConfigurationInBrowser', 'showConfigurationLog']);
  const [debugging] = rows({ status: [status({ debug: { runtime: 'java', port: 5005, listening: true } })], debugging: new Set(['api']) });
  assert.deepEqual([debugging.icon, debugging.contextValue], ['debug-alt', 'sflow.runConfiguration.debugging.browsable']);
  assert.deepEqual(inlineActions(debugging.contextValue), ['stopConfiguration', 'openConfigurationInBrowser', 'showConfigurationLog']);
  const [failed] = rows({ tasks: { api: { running: false, exitCode: 1 } } });
  assert.deepEqual([failed.icon, failed.color, failed.contextValue], ['error', 'testing.iconFailed', 'sflow.runConfiguration.failed.debuggable']);
  assert.deepEqual(inlineActions(failed.contextValue), ['runConfiguration', 'debugConfiguration', 'showConfigurationLog']);
  // The context menu: Edit, Copy command line and Run in environment on every stopped row.
  const menu = manifest.contributes.menus['view/item/context'].filter((entry) => !entry.group.startsWith('inline')
    && new RegExp(/viewItem =~ \/(.+)\/$/.exec(entry.when)[1]).test(stopped.contextValue)).map((entry) => entry.command.replace('singularityFlow.', ''));
  assert.deepEqual(menu, ['runConfiguration', 'debugConfiguration', 'runConfigurationInEnvironment', 'showConfigurationLog', 'editConfiguration', 'copyConfigurationCommandLine']);
  assert.deepEqual(manifest.contributes.keybindings, undefined, 'no default keybindings: IntelliJ\'s macOS ones clash with VS Code\'s');
});

test('the Run view lists one capability\'s configurations directly, several under their capability, and says what it could not read', () => {
  const one = model.runConfigurations([reading()]);
  assert.deepEqual(model.runTreeRoots(one, [{ id: 'payments-web', name: 'Payments web', note: null }]).map((node) => node.id), ['run:payments-web/api', 'run:payments-web/web']);
  const admin = reading({ capability: 'admin', name: 'Admin', plan: runModel.appPlanFrom([plain({ capability: 'admin', id: 'ui' })]).entries,
    status: [status({ id: 'ui', url: 'http://127.0.0.1:5173/', environment: null })] });
  const both = model.runConfigurations([reading(), admin]);
  const roots = model.runTreeRoots(both, [{ id: 'payments-web', name: 'Payments web', note: null }, { id: 'admin', name: 'Admin', note: null },
    { id: 'billing', name: 'Billing', note: 'The start entries could not be read: offline' }]);
  assert.deepEqual(roots.map((node) => [node.kind, node.label, node.description ?? null]), [
    ['capability', 'Payments web', '2 configurations'], ['capability', 'Admin', '1 configuration · 1 running'],
    ['message', 'The start entries could not be read: offline', null]
  ]);
  assert.deepEqual(model.capabilityChildren(both, 'admin').map((node) => node.key), ['admin/ui']);
});

const summary = (overrides = {}) => summaryModel.testSummaryFrom({
  resultType: 'sflow-test-summary', schemaVersion: 1,
  scope: { kind: 'capability', capability: 'payments-web', workId: null, phase: null },
  run: { id: 'RUN-7', evidenceClass: 'local-preview', label: 'Local preview, not evidence', environment: 'dev', countsForStep: false,
    startedAt: '2026-10-20T10:00:00Z', commit: 'abc1234def5678', uncommittedChanges: true, ranBy: 'tester@example.com' },
  totals: { discovered: 5, passed: 2, failed: 1, skipped: 1, flaky: 1, durationMs: 50 },
  commands: [
    { id: 'module-tests', kind: 'test', adapter: 'junit-xml', status: 'failed', exitCode: 1, tests: { discovered: 4, passed: 2, failed: 1, skipped: 1 }, perCase: true, note: null },
    { id: 'lint', kind: 'test', adapter: 'exit-code', status: 'passed', exitCode: 0, tests: {}, perCase: false, note: 'This exit-code report gives totals only.' },
    { id: 'integration-tests', kind: 'test', adapter: 'exit-code', status: 'blocked', exitCode: null, tests: {}, perCase: false, note: 'qa is not bound on this computer.' }
  ],
  cases: [
    { command: 'module-tests', suite: 'Cart', name: 'adds an item', file: 'src/cart.test.js', line: 12, outcome: 'passed', durationMs: 5, clauses: ['W-1:AC-001'] },
    { command: 'module-tests', suite: 'Cart', name: 'removes an item', file: 'src/cart.test.js', line: 30, outcome: 'failed', durationMs: 35, clauses: [],
      message: 'expected 1 to equal 0' },
    { command: 'module-tests', suite: 'Cart', name: 'removes an item', file: './src/cart.test.js', line: 41, outcome: 'flaky', durationMs: 9, clauses: [] },
    { command: 'module-tests', suite: null, name: 'outside', file: '../../etc/passwd', line: 1, outcome: 'skipped', durationMs: null, clauses: [] },
    { command: 'module-tests', suite: null, name: 'no file', file: null, line: null, outcome: 'failed', durationMs: 2, clauses: [] }
  ],
  truncated: false, untagged: 3, history: [], ...overrides
});

test('the test summary carries a command\'s own totals and a case\'s failure message', () => {
  const parsed = summary();
  assert.deepEqual(parsed.commands[0].counts, { discovered: 4, passed: 2, failed: 1, skipped: 1 });
  assert.equal(parsed.commands[1].counts, null, 'no totals given');
  assert.equal(parsed.cases[1].message, 'expected 1 to equal 0');
  assert.equal(parsed.cases[0].message, null);
  assert.equal(summaryModel.testSummaryFrom({ ...summary(), resultType: 'sflow-test-summary', cases: [{ name: 'x', failure: { message: 'boom' } }], commands: [] }).cases[0].message, 'boom');
});

test('Testing view items: one per test command, its cases with a repository file and line so the editor shows icons', () => {
  const plan = runModel.testPlanFrom({ commands: [
    { id: 'module-tests', kind: 'test', adapter: 'junit-xml', argv: ['npm', 'test', '--', '--reporter=junit'], environments: [], commandSha256: SHA },
    { id: 'lint', kind: 'lint', adapter: null, argv: ['npm', 'run', 'lint'], environments: [], commandSha256: SHA2 }
  ] });
  const commands = model.testCommandItems('payments-web', plan, summary());
  assert.deepEqual(commands.map((item) => [item.id, item.label, item.description, item.tooltip, item.perCase]), [
    ['payments-web/module-tests', 'module-tests', 'junit-xml', 'npm test -- --reporter=junit', true],
    ['payments-web/lint', 'lint', 'lint · exit-code', 'npm run lint', false],
    ['payments-web/integration-tests', 'integration-tests', 'exit-code', null, false]
  ], 'tests plan first; a command only the summary names is still listed');
  assert.deepEqual(model.testCommandItems('payments-web', null, null), []);
  const cases = model.testCaseItems('payments-web', 'module-tests', summary());
  assert.deepEqual(cases.map((item) => [item.id, item.label, item.description, item.file, item.line]), [
    ['["Cart","adds an item"]', 'adds an item', 'Cart', 'src/cart.test.js', 12],
    ['["Cart","removes an item"]', 'removes an item', 'Cart', 'src/cart.test.js', 30],
    ['["Cart","removes an item"]#2', 'removes an item', 'Cart', 'src/cart.test.js', 41],
    ['["","outside"]', 'outside', null, null, 1],
    ['["","no file"]', 'no file', null, null, null]
  ], 'ids are unique among siblings; a file outside the repository gets no location');
  assert.equal(cases[0].tooltip, 'src/cart.test.js:12\nW-1:AC-001');
  assert.ok(cases[0].sortText < cases[1].sortText && cases[1].sortText < cases[2].sortText);
  assert.deepEqual(model.testCaseItems('payments-web', 'lint', summary()), []);
  for (const unsafe of ['/etc/hosts', 'C:\\x\\y.js', 'a/../../b', '..\\x', 'a\u0000b', '', null]) assert.equal(model.safeCaseFile(unsafe), null, String(unsafe));
  assert.equal(model.safeCaseFile('src\\win\\a.test.js'), 'src/win/a.test.js');
});

test('a Testing view request runs whole commands: a case selects its command, and every command runs as "all tests"', () => {
  const all = { 'payments-web': ['module-tests', 'lint', 'integration-tests'], admin: ['ui-tests'] };
  assert.deepEqual(model.testRunPlans(null, [], all), [
    { capability: 'payments-web', commands: [], every: true }, { capability: 'admin', commands: [], every: true }]);
  assert.deepEqual(model.testRunPlans([{ capability: 'payments-web', command: 'lint' }, { capability: 'payments-web', command: 'module-tests' },
    { capability: 'payments-web', command: 'module-tests' }], [], all),
  [{ capability: 'payments-web', commands: ['module-tests', 'lint'], every: false }], 'Rerun Failed Tests: the failed cases\' commands, once each, in plan order');
  assert.deepEqual(model.testRunPlans([{ capability: 'payments-web', command: null }], [{ capability: 'payments-web', command: 'integration-tests' }], all),
    [{ capability: 'payments-web', commands: ['module-tests', 'lint'], every: false }]);
  assert.deepEqual(model.testRunPlans(null, [{ capability: 'admin', command: null }], all), [{ capability: 'payments-web', commands: [], every: true }]);
  assert.deepEqual(model.testRunPlans([{ capability: 'payments-web', command: 'gone' }, { capability: 'removed', command: null }], [], all), []);
});

test('results: each case passed, failed with its message, or skipped; a totals-only command is reported alone', () => {
  assert.deepEqual(['passed', 'flaky', 'failed', 'skipped', 'unknown'].map(model.caseOutcome), ['passed', 'passed', 'failed', 'skipped', 'errored']);
  const parsed = summary();
  assert.equal(model.caseMessage(parsed.cases[1]), 'expected 1 to equal 0');
  assert.match(model.caseMessage(parsed.cases[4]), /^no file failed\. The report gives no message/);
  assert.deepEqual(model.commandOutcome(parsed.commands[0]), { outcome: 'failed', message: '2 passed, 1 failed, 1 skipped of 4' });
  assert.deepEqual(model.commandOutcome(parsed.commands[1]), { outcome: 'passed', message: 'This exit-code report gives totals only.' });
  assert.deepEqual(model.commandOutcome(parsed.commands[2]), { outcome: 'errored', message: 'qa is not bound on this computer.' });
  assert.deepEqual(model.commandOutcome({ ...parsed.commands[1], status: 'failed', note: null, exitCode: 2 }), { outcome: 'failed', message: 'lint failed with exit code 2.' });
  assert.deepEqual(model.runOutputLines(parsed), [
    'Local preview, not evidence [local-preview]',
    'Run RUN-7, environment dev, commit abc1234def56, with uncommitted changes: 2 passed, 1 failed, 1 flaky, 1 skipped of 5.',
    'lint: This exit-code report gives totals only.',
    'integration-tests: qa is not bound on this computer.'
  ], 'the engine\'s label and class lead: the Testing view never calls a local preview evidence');
  const integration = summary({ run: { ...summary().run, evidenceClass: 'local-integration', label: 'Local integration run by dev@example.com, environment `qa`, commit `abc1234`; values never recorded' } });
  assert.match(model.runOutputLines(integration)[0], /^Local integration run by .*values never recorded \[local-integration\]$/);
  assert.deepEqual(model.runOutputLines({ ...parsed, run: null }), ['The engine recorded no test run.']);
});

test('the run widget, the Run view and the Testing view stay out of activation and out of the extension bundle', async () => {
  const extension = await readFile(source('extension.ts'), 'utf8');
  assert.doesNotMatch(extension, /^import(?!\s+type\b)[^\n]*['"]\.\/views\/run-(?:widget|testing|and-test)[\w-]*\.ts['"]/m,
    'the run widget must load from the lazy panels runtime');
  const runtime = await readFile(source('lazy-panels-runtime.ts'), 'utf8');
  assert.match(runtime, /export \{ RunWidget \} from '\.\/views\/run-widget\.ts'/);
  // The window's check is a read of the capability map file: no CLI command decides it.
  const gate = extension.slice(extension.indexOf('refreshRunWidget = () =>'), extension.indexOf('.catch((error) => output.appendLine(`Run configurations'));
  assert.match(gate, /readFile\(file, 'utf8'\)/);
  assert.doesNotMatch(gate, /client\.run|runText|lazyPanels\(\)/, 'nothing runs or loads before the file says there is an application');
  assert.ok(gate.indexOf("map.mode !== 'implicit'") < gate.indexOf('readFile('), 'an implicit capability map is not even read');
  assert.ok(gate.indexOf('if (!key) return runView?.hide()') < gate.indexOf('runWidget().refresh()'));
  for (const id of Object.values(model.RUN_WIDGET_COMMANDS)) {
    assert.ok(manifest.contributes.commands.some((entry) => entry.command === id), `${id} is contributed`);
    assert.ok(manifest.contributes.menus.commandPalette.some((entry) => entry.command === id && entry.when === 'singularityFlow.runConfigurations'),
      `${id} is in the palette while there is a run configuration`);
  }
  assert.equal(manifest.contributes.commands.find((entry) => entry.command === 'singularityFlow.runSelectedConfiguration').title, 'Run Selected Configuration');
  assert.equal(manifest.contributes.commands.find((entry) => entry.command === 'singularityFlow.runSelectedConfiguration').category, 'Singularity Flow');
});

test('the real engine\'s app plan and app status become run configurations, rows and widget text', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { ideRepository } = await import(path.join(root, 'test', 'helpers', 'ide-run-configurations.mjs'));
  const yaml = [
    '    application:',
    '      start:',
    '        - { id: api, argv: [./mvnw, -q, spring-boot:run], workingDirectory: services/api, url: "http://127.0.0.1:8081/",',
    '            ready: { http: /actuator/health, timeoutMs: 180000 }, environments: [dev, qa],',
    '            arguments: { dev: [-Dspring-boot.run.profiles=dev], qa: [-Dspring-boot.run.profiles=qa] }, debug: { runtime: java, port: 5005 } }',
    '        - { id: storefront, argv: [npm, run, dev], workingDirectory: apps/storefront, url: "http://127.0.0.1:5173/", ready: { log: ready, timeoutMs: 60000 } }',
    ''
  ].join('\n');
  const { root: repository } = await ideRepository(t, { capability: { yaml } });
  const cli = (...args) => {
    const result = spawnSync(process.execPath, [path.join(root, 'bin', 'singularity-flow.mjs'), ...args], { cwd: repository, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const { entries, dropped } = runModel.appPlanFrom(cli('app', 'plan', '--capability', 'shop', '--json'));
  assert.deepEqual(dropped, []);
  const configurations = model.runConfigurations([{ capability: 'shop', name: 'shop', plan: entries,
    status: runModel.appStatusFrom(cli('app', 'status', '--capability', 'shop', '--json')), tasks: {}, debugging: new Set(), chosen: 'qa' }]);
  assert.deepEqual(configurations.map((item) => [item.key, item.name, item.state, item.environment, item.debuggable, item.commandLine]), [
    ['shop/api', entries[0].name ?? 'api', 'stopped', 'qa', true, './mvnw -q spring-boot:run -Dspring-boot.run.profiles=qa'],
    ['shop/storefront', entries[1].name ?? 'storefront', 'stopped', null, false, 'npm run dev']
  ]);
  assert.match(model.widgetSpec(configurations[0]).configuration.text, /^\$\(play\) .+ · qa$/);
  assert.deepEqual(configurations.map((item) => model.configurationRow(item).contextValue),
    ['sflow.runConfiguration.stopped.debuggable', 'sflow.runConfiguration.stopped']);
});

test('a typed entry\'s confirmation shows its before-launch steps, the variables it sets, and every environment it covers', () => {
  // Seen in a real VS Code: the page showed only the command line, while app start also ran the
  // before-launch step and set FEATURE_FLAGS, and the one confirmation also let qa run unseen.
  const api = {
    capability: 'shop', repository: 'shop', id: 'api', name: 'Api', type: 'node', argv: ['node', 'server/api.mjs', '--label', 'base'],
    workingDirectory: '.', url: 'http://127.0.0.1:8091/', ready: { http: '/health', timeoutMs: 30000 }, commandSha256: SHA,
    resolved: { argv: ['node', 'server/api.mjs', '--label', 'base'], envNames: ['FEATURE_FLAGS'], beforeLaunch: [{ argv: ['node', 'scripts/prepare.mjs'], workingDirectory: '.' }] },
    environments: [
      { name: 'dev', status: 'bound', default: true, resolved: { argv: ['node', 'server/api.mjs', '--label', 'dev'], envNames: ['FEATURE_FLAGS'],
        beforeLaunch: [{ argv: ['node', 'scripts/prepare.mjs'], workingDirectory: '.' }] } },
      { name: 'qa', status: 'bound', default: false, resolved: { argv: ['node', 'server/api.mjs', '--label', 'qa'], envNames: ['FEATURE_FLAGS', 'QA_ONLY'],
        beforeLaunch: [{ argv: ['node', 'scripts/prepare.mjs', '--qa'], workingDirectory: 'tools' }, { argv: ['node', 'scripts/seed.mjs'], workingDirectory: '.' }] } }
    ],
    debug: { runtime: 'node', port: 9231, suspend: false, argv: ['node', '--inspect=127.0.0.1:9231', 'server/api.mjs'], environmentNames: [], notes: [] }
  };
  const { entries, dropped } = runModel.appPlanFrom({ entries: [api] });
  assert.deepEqual(dropped, []);
  const [entry] = entries;
  assert.deepEqual(runModel.launchDetail(entry, 'qa'), { beforeLaunch: [{ argv: ['node', 'scripts/prepare.mjs', '--qa'], workingDirectory: 'tools' },
    { argv: ['node', 'scripts/seed.mjs'], workingDirectory: '.' }], envNames: ['FEATURE_FLAGS', 'QA_ONLY'] });
  assert.deepEqual(runModel.launchDetail(entry, null).envNames, ['FEATURE_FLAGS'], 'without an environment, the entry\'s own');
  const request = runModel.startConfirmationRequest(entry, 'dev');
  assert.equal(request.title, 'Start Api for shop');
  assert.ok(request.detail.includes([
    'Start entry: api (Api, node)',
    'Command: ["node","server/api.mjs","--label","dev"]',
    'Before launch, step 1 of 1: ["node","scripts/prepare.mjs"]',
    'Sets for the application only: FEATURE_FLAGS'
  ].join('\n')), request.detail);
  assert.ok(request.detail.includes([
    'This confirmation also covers its other environment:',
    '  qa: ["node","server/api.mjs","--label","qa"]',
    '    Before launch, step 1 of 2: ["node","scripts/prepare.mjs","--qa"] in tools',
    '    Before launch, step 2 of 2: ["node","scripts/seed.mjs"]',
    '    Sets for the application only: FEATURE_FLAGS, QA_ONLY'
  ].join('\n')), request.detail);
  const debug = runModel.debugStartConfirmationRequest(entry, 'qa').detail;
  assert.match(debug, /Before launch, step 2 of 2: \["node","scripts\/seed.mjs"\]/);
  assert.match(debug, /This confirmation also covers its other environment:\n {2}dev: \["node","--inspect=127\.0\.0\.1:9231","server\/api\.mjs"\]/);
  // An entry without environments or launch details reads exactly as before.
  const plainRequest = runModel.startConfirmationRequest(runModel.appPlanFrom([plain()]).entries[0], null).detail;
  assert.doesNotMatch(plainRequest, /Before launch|Sets for the application|also covers/);
  // A step VS Code cannot show exactly would run unseen: the entry is not offered at all.
  const hidden = runModel.appPlanFrom({ entries: [{ ...api, id: 'hidden', resolved: { ...api.resolved, beforeLaunch: [{ argv: 'npm ci' }] } }] });
  assert.deepEqual([hidden.entries.length, hidden.dropped], [0, ['hidden']]);
  const bare = runModel.appPlanFrom({ entries: [{ ...api, id: 'bare', environments: [], resolved: { ...api.resolved, beforeLaunch: [['node', 'x.mjs']] } }] }).entries[0];
  assert.deepEqual(runModel.launchDetail(bare, null).beforeLaunch, [{ argv: ['node', 'x.mjs'], workingDirectory: null }], 'a bare argv list is a step too');
});

test('a start in an environment is refused before its task opens while the capability keeps values from local processes', () => {
  // Seen in a real VS Code: with policy.localIntegrationEvidence off, Run opened a task that failed with
  // "exit code 1"; only the task terminal said why. tests plan reports the same folded policy.
  assert.equal(runModel.localIntegrationPolicy({ resultType: 'sflow-test-plan', localIntegrationEvidence: 'off', commands: [] }), 'off');
  assert.equal(runModel.localIntegrationPolicy({ resultType: 'command-result', data: { localIntegrationEvidence: 'allowed', commands: [] } }), 'allowed');
  assert.equal(runModel.localIntegrationPolicy({ commands: [] }), null, 'an engine that does not say leaves it to the engine');
  assert.equal(runModel.localIntegrationPolicy({ localIntegrationEvidence: 'maybe' }), null);
  const [entry] = runModel.appPlanFrom({ entries: [typed()] }).entries;
  assert.equal(runModel.startRefusal(entry, 'dev', 'off'),
    'api was not started: it needs environment dev, whose values are given to a local process only when capability payments-web sets '
    + 'policy.localIntegrationEvidence to allowed. It is off. Change it through a capability proposal; nothing ran.');
  assert.match(runModel.startRefusal(entry, 'qa', 'off'), /needs environment qa/, 'checked before the binding, as the engine does');
  assert.equal(runModel.startRefusal(entry, 'dev', 'allowed'), null);
  assert.equal(runModel.startRefusal(entry, 'dev', null), null);
  assert.equal(runModel.startRefusal(entry, null, 'off'), null, 'an entry without environments reads no values');
  assert.match(runModel.startRefusal(entry, 'qa', 'allowed'), /environment qa is not bound/);
});
