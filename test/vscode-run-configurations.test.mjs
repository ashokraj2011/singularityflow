/**
 * IDE-style run configurations in VS Code: arguments per environment, Start (debug) with a loopback
 * attach, and "Suggest from run configurations". [docs/SPEC-RUN-AND-TEST-v1.md, amendment, milestone 8]
 *
 * The fixtures have the shapes the amendment gives `app plan --json` (arguments, debug), `app status
 * --json` (debug) and `app suggest --json`. Everything here is pure: no `vscode`, no process, no shell.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (name) => path.join(root, 'apps', 'vscode', 'src', name);
const model = await import(source('views/run-and-test-model.ts'));
const { runAndTestHtml, RUN_AND_TEST_SCRIPT } = await import(source('views/run-and-test-page.ts'));
const suggest = await import(source('views/run-suggestions-model.ts'));
const { runSuggestionsHtml, RUN_SUGGESTIONS_SCRIPT } = await import(source('views/run-suggestions-page.ts'));
const { commandClass } = await import(source('cli/client.ts'));

const SHA = `sha256:${'a'.repeat(64)}`;
const DEBUG_SHA = `sha256:${'d'.repeat(64)}`;
const capability = { id: 'payments-web', name: 'Payments web', kind: 'delivery', delivery: true, repository: 'payments-web', repositories: ['payments-web'], children: [] };
const MAVEN = ['./mvnw', '-q', 'spring-boot:run'];
const DEV = ['-Dspring-boot.run.profiles=dev'];
const QA = ['-Dspring-boot.run.profiles=qa', '-Dspring-boot.run.jvmArguments=-Xmx2g'];
const JDWP = '-Dspring-boot.run.jvmArguments=-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:5005';
const apiEntry = (overrides = {}) => ({
  capability: 'payments-web', repository: 'payments-web', id: 'api', argv: MAVEN, workingDirectory: 'services/api',
  url: 'http://127.0.0.1:8080/', ready: { http: '/actuator/health', timeoutMs: 180000 },
  environments: [
    { name: 'dev', status: 'bound', default: true, argv: [...MAVEN, ...DEV], debugArgv: [...MAVEN, ...DEV, JDWP] },
    { name: 'qa', status: 'bound', default: false, argv: [...MAVEN, ...QA] }
  ],
  arguments: { dev: DEV, qa: QA },
  debug: { runtime: 'java', port: 5005, suspend: false, commandSha256: DEBUG_SHA },
  commandSha256: SHA, ...overrides
});
const status = (overrides = {}) => ({ id: 'api', declared: true, started: true, ready: false, url: 'http://127.0.0.1:8080/', pid: 4242,
  environment: 'dev', debug: { runtime: 'java', port: 5005, listening: true }, ...overrides });

test('app plan carries each environment\'s arguments and resolved argv, and the debug block with its own identity', () => {
  const { entries, dropped } = model.appPlanFrom({ resultType: 'sflow-app-plan', capability: 'payments-web', entries: [apiEntry()] });
  assert.deepEqual(dropped, []);
  const [entry] = entries;
  assert.deepEqual(entry.arguments, { dev: DEV, qa: QA });
  assert.deepEqual(model.resolvedArgv(entry, 'dev'), [...MAVEN, ...DEV]);
  assert.deepEqual(model.resolvedArgv(entry, 'qa'), [...MAVEN, ...QA]);
  assert.deepEqual(model.resolvedArgv(entry, null), MAVEN);
  assert.deepEqual(entry.debug, { runtime: 'java', port: 5005, suspend: false, commandSha256: DEBUG_SHA,
    argv: { dev: [...MAVEN, ...DEV, JDWP] }, defaultArgv: null, environment: {} });
  assert.deepEqual(model.resolvedDebugArgv(entry.debug, 'dev'), [...MAVEN, ...DEV, JDWP]);
  assert.equal(model.resolvedDebugArgv(entry.debug, 'qa'), null, 'a debug launch the engine did not resolve is not invented');

  // Without resolved argv, the amendment's rule: argv, then that environment's arguments.
  const bare = model.appPlanFrom([apiEntry({ environments: [{ name: 'dev', status: 'bound', default: true }, { name: 'qa', status: 'bound' }],
    arguments: { dev: DEV, qa: QA, prod: ['-x'] } })]).entries[0];
  assert.deepEqual(model.resolvedArgv(bare, 'qa'), [...MAVEN, ...QA]);
  assert.deepEqual(Object.keys(bare.arguments), ['dev', 'qa'], 'arguments for an environment the entry does not allow are not shown');

  // A debug block VS Code cannot start exactly is not offered, and says why; the plain start still is.
  for (const [debug, issue] of [
    [{ runtime: 'java', port: 5005 }, /own command identity/],
    [{ runtime: 'ruby', port: 1, commandSha256: DEBUG_SHA }, /not one VS Code attaches to/],
    [{ runtime: 'node', port: 99999, commandSha256: DEBUG_SHA }, /not a TCP port/]
  ]) {
    const parsed = model.appPlanFrom([apiEntry({ debug })]).entries[0];
    assert.equal(parsed.debug, null);
    assert.match(parsed.debugIssue, issue);
  }
  const variables = model.appPlanFrom([apiEntry({ debug: { runtime: 'node', port: 9229, commandSha256: DEBUG_SHA,
    environment: { NODE_OPTIONS: '--inspect=127.0.0.1:9229', DB_PASSWORD: 'x', JAVA_TOOL_OPTIONS: 'bad\u0007' } } })]).entries[0];
  assert.deepEqual(variables.debug.environment, { NODE_OPTIONS: '--inspect=127.0.0.1:9229' }, 'only the three debug variables, never anything else');
  assert.equal(model.appPlanFrom([apiEntry({ debug: { runtime: 'dotnet', port: 5005, commandSha256: DEBUG_SHA } })]).entries[0].debug.port, null);
});

test('app status reports the debugger: runtime, port and listening, only for a live process', () => {
  assert.deepEqual(model.appStatusFrom({ entries: [status(), status({ id: 'web', started: false, debug: { runtime: 'node', port: 9229, listening: true } }),
    status({ id: 'bad', debug: { port: '5005', listening: 'yes' } })] }).map((entry) => entry.debug), [
    { runtime: 'java', port: 5005, listening: true },
    { runtime: 'node', port: 9229, listening: false },
    { runtime: null, port: null, listening: false }
  ]);
});

test('each runtime gets its exact loopback attach configuration; .NET attaches by pid', () => {
  const name = 'api · payments-web (Singularity Flow)';
  assert.equal(model.debugSessionName('payments-web', 'api'), name);
  assert.deepEqual(model.debugAttachConfiguration('java', name, { port: 5005 }), { type: 'java', request: 'attach', name, hostName: '127.0.0.1', port: 5005 });
  assert.deepEqual(model.debugAttachConfiguration('python', name, { port: 5678 }), { type: 'debugpy', request: 'attach', name, connect: { host: '127.0.0.1', port: 5678 } });
  assert.deepEqual(model.debugAttachConfiguration('node', name, { port: 9229 }), { type: 'node', request: 'attach', name, address: '127.0.0.1', port: 9229 });
  assert.deepEqual(model.debugAttachConfiguration('go', name, { port: 2345 }), { type: 'go', request: 'attach', name, mode: 'remote', host: '127.0.0.1', port: 2345 });
  assert.deepEqual(model.debugAttachConfiguration('dotnet', name, { port: 5005, pid: 4242 }), { type: 'coreclr', request: 'attach', name, processId: 4242 });
  for (const [runtime, target] of [['java', {}], ['node', { port: 0 }], ['go', { port: 70000 }], ['python', { port: 5678.5 }], ['dotnet', { port: 5005 }], ['dotnet', { pid: -1 }]]) {
    assert.equal(model.debugAttachConfiguration(runtime, name, target), null, `${runtime} ${JSON.stringify(target)}`);
  }

  // The port is the one app status reports, else the plan's; the host is always loopback.
  const entry = model.appPlanFrom([apiEntry()]).entries[0];
  const [live] = model.appStatusFrom([status({ debug: { runtime: 'java', port: 5007, listening: true } })]);
  const plan = model.debugAttachPlan(entry, live);
  assert.deepEqual(plan, { configuration: { type: 'java', request: 'attach', name, hostName: '127.0.0.1', port: 5007 },
    extension: { id: 'vscjava.vscode-java-debug', name: 'Debugger for Java' }, where: 'with its debugger listening at 127.0.0.1:5007' });
  assert.match(model.debugAttachPlan(entry, model.appStatusFrom([status({ debug: { listening: false } })])[0]).error, /has no debugger listening/);
  assert.match(model.debugAttachPlan(entry, undefined).error, /has no debugger listening/);
  assert.match(model.debugAttachPlan(entry, model.appStatusFrom([status({ debug: { runtime: 'node', port: 9229, listening: true } })])[0]).error,
    /running with the node debugger, but singularity\/capabilities\.yml now declares java\. Stop it and start it again\./);
  const dotnet = model.appPlanFrom([apiEntry({ debug: { runtime: 'dotnet', commandSha256: DEBUG_SHA } })]).entries[0];
  assert.deepEqual(model.debugAttachPlan(dotnet, model.appStatusFrom([status({ debug: null })])[0]).configuration, { type: 'coreclr', request: 'attach', name, processId: 4242 });
  assert.equal(model.debuggerReady(dotnet.debug, model.appStatusFrom([status({ pid: null, debug: null })])[0]), false);
});

test('a missing debugger extension is named, and the application is said to keep running', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(model.DEBUGGER_EXTENSIONS).map(([runtime, extension]) => [runtime, extension?.id ?? null])), {
    java: 'vscjava.vscode-java-debug', python: 'ms-python.debugpy', node: null, go: 'golang.go', dotnet: 'ms-dotnettools.csharp'
  });
  assert.equal(model.missingDebuggerMessage('api', 'java', 'with its debugger listening at 127.0.0.1:5005'),
    'api is running with its debugger listening at 127.0.0.1:5005, but VS Code has no Java debugger to attach with. Install the Debugger for Java extension (vscjava.vscode-java-debug), then choose Attach debugger. api keeps running; Stop ends it.');
  assert.match(model.missingDebuggerMessage('worker', 'dotnet', 'as process 4242'), /Install the C# extension \(ms-dotnettools\.csharp\)/);
  assert.match(model.missingDebuggerMessage('cli', 'python', 'x'), /Python Debugger extension \(ms-python\.debugpy\)/);
  assert.match(model.missingDebuggerMessage('svc', 'go', 'x'), /Go extension \(golang\.go\)/);
});

test('Start (debug) runs `app start … --debug --expect-command <debug identity>` and confirms on that identity', () => {
  assert.deepEqual(model.appStartArgv('payments-web', 'api', 'dev', DEBUG_SHA, true),
    ['app', 'start', 'api', '--capability', 'payments-web', '--environment', 'dev', '--debug', '--expect-command', DEBUG_SHA]);
  assert.deepEqual(model.appStartArgv('payments-web', 'api', null, null, true), ['app', 'start', 'api', '--capability', 'payments-web', '--debug']);
  const entry = model.appPlanFrom([apiEntry()]).entries[0];
  const request = model.debugStartConfirmationRequest(entry, 'dev');
  assert.equal(request.title, 'Start api with its debugger for payments-web');
  for (const line of [
    `Command: ${JSON.stringify([...MAVEN, ...DEV, JDWP])}`, `Arguments for dev: ${JSON.stringify(DEV)}`,
    'Debugger: Java debugger at 127.0.0.1:5005',
    'VS Code attaches once app status says the debugger listens, on 127.0.0.1 at the port app status reports: {"type":"java","request":"attach","name":"api · payments-web (Singularity Flow)","hostName":"127.0.0.1","port":5005}',
    `Command identity: ${DEBUG_SHA}`,
    `singularity-flow app start api --capability payments-web --environment dev --debug --expect-command ${DEBUG_SHA}`,
    'Ending the debug session leaves api running; Stop ends it.'
  ]) assert.ok(request.detail.includes(line), line);
  assert.doesNotMatch(request.detail, new RegExp(SHA), 'the plain start\'s identity is not what this confirms');
  const qa = model.debugStartConfirmationRequest(entry, 'qa');
  assert.ok(qa.detail.includes(`Command: ${JSON.stringify([...MAVEN, ...QA])}, with the debugger the engine adds for java`));
  const suspended = model.appPlanFrom([apiEntry({ debug: { runtime: 'node', port: 9229, suspend: true, commandSha256: DEBUG_SHA,
    environment: { NODE_OPTIONS: '--inspect-brk=127.0.0.1:9229' } } })]).entries[0];
  const node = model.debugStartConfirmationRequest(suspended, 'dev').detail;
  assert.ok(node.includes('Set for this process only: NODE_OPTIONS=--inspect-brk=127.0.0.1:9229'));
  assert.ok(node.includes('Node.js debugger at 127.0.0.1:9229, waiting for the debugger before it runs'));
  assert.ok(node.includes(', after the debugger attaches'));
  // The plain start's confirmation shows the argv the chosen environment runs.
  assert.ok(model.startConfirmationRequest(entry, 'qa').detail.includes(`Command: ${JSON.stringify([...MAVEN, ...QA])}\nArguments for qa: ${JSON.stringify(QA)}`));
});

test('each start row shows the argv its environment runs, every environment\'s arguments, and the debug controls', () => {
  const plan = model.appPlanFrom([apiEntry(), { ...apiEntry({ id: 'web', debug: undefined, arguments: undefined }),
    environments: [{ name: 'dev', status: 'bound', default: true }] }]).entries;
  let view = model.buildRunAndTestView(capability, 'here', { plan, status: [], environment: 'qa' });
  let html = runAndTestHtml(view);
  assert.match(html, /data-rt-entry="api"[\s\S]*<small class="muted rt-command">\.\/mvnw -q spring-boot:run -Dspring-boot\.run\.profiles=qa -Dspring-boot\.run\.jvmArguments=-Xmx2g<\/small>/);
  assert.match(html, /<span data-rt-arguments="dev">dev: <code>-Dspring-boot\.run\.profiles=dev<\/code><\/span><br><span data-rt-arguments="qa" data-rt-current>qa \(this run\): <code>/);
  assert.match(html, /debug: Java debugger at 127\.0\.0\.1:5005/);
  assert.match(html, /data-rt="debug" data-rt-capability="payments-web" data-rt-entry="api">[\s\S]*Start \(debug\)/);
  assert.match(html, /data-rt="attach" data-rt-capability="payments-web" data-rt-entry="api" disabled>Attach debugger/);
  assert.doesNotMatch(html.slice(html.indexOf('data-rt-entry="web"')), /data-rt="debug"/, 'no debug button for an entry without a debug block');
  assert.match(html, /data-rt="suggest" data-rt-capability="payments-web">Suggest from run configurations/);

  assert.match(runAndTestHtml(model.buildRunAndTestView(capability, 'here', { plan, status: [], tasks: { api: { running: true, debug: true } } })),
    /data-rt-state="starting">[\s\S]*waiting for the debugger to listen, then until HTTP \/actuator\/health answers below 500 within 180 s/);

  // Running with its debugger listening: Attach is offered, Start (debug) is not.
  view = model.buildRunAndTestView(capability, 'here', { plan, status: model.appStatusFrom([status()]), tasks: { api: { running: true, debug: true } } });
  html = runAndTestHtml(view);
  assert.match(html, /<small class="rt-listening">Debugger listening at 127\.0\.0\.1:5005<\/small>/);
  assert.match(html, /data-rt="debug" data-rt-capability="payments-web" data-rt-entry="api" disabled/);
  assert.match(html, /data-rt="attach" data-rt-capability="payments-web" data-rt-entry="api">Attach debugger/);
  assert.match(html, /rt-command">\.\/mvnw -q spring-boot:run -Dspring-boot\.run\.profiles=dev</, 'a running entry shows the environment it runs in');

  const noted = model.buildRunAndTestView(capability, 'here', { plan: model.appPlanFrom([apiEntry({ debug: { runtime: 'java' } })]).entries });
  assert.match(runAndTestHtml(noted), /Start \(debug\) is not offered: the engine did not give the debug start its own command identity\./);

  // The section script posts the new actions like the others.
  const listeners = {};
  const posted = [];
  new Function('document', 'vscode', RUN_AND_TEST_SCRIPT)({ addEventListener: (type, listener) => { (listeners[type] ??= []).push(listener); } },
    { postMessage: (message) => posted.push(message) });
  const element = (dataset) => ({ dataset, closest: (query) => (query === '[data-rt]' ? element(dataset) : null) });
  for (const dataset of [{ rt: 'debug', rtCapability: 'payments-web', rtEntry: 'api' }, { rt: 'suggest', rtCapability: 'payments-web' }]) {
    for (const listener of listeners.click) listener({ target: element(dataset), preventDefault() {} });
  }
  assert.deepEqual(posted.map((message) => [message.action, message.entry]), [['debug', 'api'], ['suggest', '']]);
});

/** `app suggest --json` as the amendment gives it, with what an engine bug could leak. */
const suggestion = (overrides = {}) => ({
  source: { kind: 'intellij', file: '.run/Api.run.xml', name: 'Api (dev)' },
  start: { id: 'api', argv: MAVEN, workingDirectory: 'services/api', url: 'http://127.0.0.1:8080/',
    ready: { http: '/actuator/health', timeoutMs: 180000 }, environments: ['dev', 'qa'], arguments: { dev: DEV, qa: QA },
    debug: { runtime: 'java', port: 5005 } },
  environmentNames: [{ name: 'SPRING_PROFILES_ACTIVE', kind: 'flag', default: 'dev' }, { name: 'DB_PASSWORD', kind: 'secret', default: 'hunter2-db' },
    { name: 'DATABASE_URL', kind: 'endpoint', default: 'postgres://127.0.0.1:5432/app' }, { name: 'API_TOKEN', kind: 'flag', default: 'tok-123456' },
    { name: 'BILLING_URL', kind: 'endpoint', default: 'https://user:pw@billing.local/' }],
  notes: ['IntelliJ computes the classpath; this runs through the Maven wrapper instead.'],
  ...overrides
});
const suggestions = () => ({
  resultType: 'sflow-app-suggestions', capability: 'payments-web',
  suggestions: [
    suggestion(),
    suggestion({ source: { kind: 'webstorm', file: 'package.json', name: 'dev' }, start: { id: 'web', argv: ['npm', 'run', 'dev'], workingDirectory: 'apps/web',
      url: 'http://127.0.0.1:5173/', ready: { log: 'ready in', timeoutMs: 90000 }, debug: { runtime: 'node', port: 9229, suspend: false } }, environmentNames: [], notes: [] }),
    suggestion({ source: { kind: 'vscode', file: '.vscode/launch.json', name: 'Worker' }, start: { id: 'worker', argv: ['node', 'worker.js', '--db-password=hunter2-db'] }, environmentNames: [], notes: [] }),
    suggestion({ source: { kind: 'rider', file: '../outside/x.run.xml', name: 'Outside' }, start: { id: 'outside', argv: ['dotnet', 'run'], workingDirectory: '../elsewhere' } }),
    suggestion({ source: { kind: 'detected', file: 'go.mod' }, start: { id: 'bad', argv: [] } })
  ],
  applicationDraft: 'start: []\n',
  environmentsDraft: 'environments:\n  dev:\n    requires:\n      - { name: DB_PASSWORD, kind: secret }\n      - { name: SPRING_PROFILES_ACTIVE, kind: flag, default: dev }\n'
});

test('app suggest is read field by field: no secret value, no path outside the repository, no command it cannot run', () => {
  assert.equal(commandClass(['app', 'suggest', '--capability', 'payments-web', '--json']), 'read', 'a read, never cached');
  assert.deepEqual(suggest.appSuggestArgv('payments-web'), ['app', 'suggest', '--capability', 'payments-web', '--json']);
  assert.throws(() => suggest.appSuggestArgv('--x'), /invalid/);
  const set = suggest.suggestionsFrom({ resultType: 'command-result', data: suggestions() });
  assert.equal(set.capability, 'payments-web');
  assert.deepEqual(set.suggestions.map((item) => item.start.id), ['api', 'web', 'worker']);
  assert.deepEqual(set.dropped, ['Outside: its working directory "../elsewhere" is outside the repository', 'bad: it has no command VS Code can run exactly']);
  const [api, web, worker] = set.suggestions;
  assert.deepEqual(api.source, { kind: 'intellij', words: 'IntelliJ IDEA', file: '.run/Api.run.xml', name: 'Api (dev)' });
  assert.deepEqual(api.environmentNames, [
    { name: 'SPRING_PROFILES_ACTIVE', kind: 'flag', default: 'dev' },
    { name: 'DB_PASSWORD', kind: 'secret', default: null },
    { name: 'DATABASE_URL', kind: 'endpoint', default: 'postgres://127.0.0.1:5432/app' },
    { name: 'API_TOKEN', kind: 'secret', default: null },
    { name: 'BILLING_URL', kind: 'endpoint', default: null }
  ], 'a secret (or secret-looking) name never has a value, and an endpoint never carries credentials');
  assert.deepEqual(web.start.debug, { runtime: 'node', port: 9229, suspend: false });
  assert.equal(web.start.ready.log, 'ready in');
  assert.equal(api.refusal, null);
  assert.match(worker.refusal, /looks like it carries the value of db-password/);
  assert.deepEqual(suggest.maskedArgv(worker.start.argv), ['node', 'worker.js', '--db-password=[hidden]']);
  assert.deepEqual(suggest.maskedArgv(['run', '--token', 'abc', '-Dapp.secret=s3', '--key=${KEY}', 'PASSWORD=x']),
    ['run', '--token', '[hidden]', '-Dapp.secret=[hidden]', '--key=${KEY}', 'PASSWORD=[hidden]'], 'a placeholder is a reference, not a value');
  assert.equal(suggest.suggestionsFrom({ resultType: 'something-else', capability: 'x' }), null);
  assert.equal(suggest.repositoryRelative('/etc/passwd'), null);
  assert.equal(suggest.repositoryRelative('C:\\x'), null);
  assert.equal(suggest.repositoryRelative('a\\b'), 'a/b');

  // The engine's environments.yml additions are shown only when no secret in them carries a value.
  assert.deepEqual(suggest.checkedEnvironmentsDraft(suggestions().environmentsDraft), { draft: suggestions().environmentsDraft, note: null });
  for (const leaked of ['environments:\n  dev:\n    requires:\n      - { name: DB_PASSWORD, kind: secret, value: hunter2-db }\n',
    'environments:\n  dev:\n    requires:\n      - { name: API_TOKEN, kind: flag, default: tok-123456 }\n']) {
    const checked = suggest.checkedEnvironmentsDraft(leaked);
    assert.equal(checked.draft, null);
    assert.match(checked.note, /give a value for (DB_PASSWORD|API_TOKEN), which is a secret/);
    assert.doesNotMatch(checked.note, /hunter2|tok-123456/);
  }
  assert.match(suggest.checkedEnvironmentsDraft('a: [').note, /could not read them as YAML/);
  const hidden = suggest.suggestionsFrom({ ...suggestions(), environmentsDraft: 'environments:\n  qa:\n    requires:\n      - { name: DB_PASSWORD, kind: secret, default: hunter2-db }\n' });
  assert.equal(hidden.environmentsDraft, null);
  const page = runSuggestionsHtml({ capability: 'payments-web', set: hidden, selection: suggest.defaultSelection(hidden), problems: { rows: {}, general: null },
    declaredIds: [], busy: false, error: null, notice: null });
  assert.match(page, /The suggested singularity\/environments\.yml additions are not shown/);
  assert.doesNotMatch(page, /hunter2|data-sg-copy/);
});

test('the person keeps and renames suggestions; the draft is exactly the kept entries, and problems are named', () => {
  const set = suggest.suggestionsFrom(suggestions());
  const selection = suggest.defaultSelection(set);
  assert.deepEqual(selection, [{ index: 0, keep: true, id: 'api' }, { index: 1, keep: true, id: 'web' }, { index: 2, keep: false, id: 'worker' }],
    'a suggestion that cannot be kept starts unticked');
  assert.deepEqual(suggest.selectionProblems(set, selection, []), { rows: {}, general: null });
  const problems = suggest.selectionProblems(set, [{ index: 0, keep: true, id: 'Api' }, { index: 1, keep: true, id: 'web' }, { index: 2, keep: true, id: 'worker' }], ['web']);
  assert.match(problems.rows[0], /lower-case kebab case/);
  assert.match(problems.rows[1], /web is already a start entry of payments-web/);
  assert.match(problems.rows[2], /cannot be kept as written/);
  assert.match(suggest.selectionProblems(set, [{ index: 0, keep: true, id: 'one' }, { index: 1, keep: true, id: 'one' }], []).rows[1], /both called one/);
  assert.equal(suggest.selectionProblems(set, [], []).general, 'Keep at least one suggestion to propose it.');
  // The page names only suggestions it was shown; anything else is ignored.
  assert.deepEqual(suggest.selectionFrom([{ index: 1, keep: true, id: ' web-dev ' }, { index: 9, keep: true, id: 'x' }, 'junk'], set),
    [{ index: 0, keep: false, id: 'api' }, { index: 1, keep: true, id: 'web-dev' }, { index: 2, keep: false, id: 'worker' }]);

  const kept = suggest.keptStarts(set, [{ index: 0, keep: true, id: 'api' }, { index: 1, keep: true, id: 'web-dev' }, { index: 2, keep: false, id: 'worker' }]);
  const draft = suggest.applicationDraftYaml(kept.map((item) => item.start));
  assert.equal(draft, [
    'start:',
    '  - id: api',
    '    argv: [./mvnw, -q, spring-boot:run]',
    '    workingDirectory: services/api',
    '    url: http://127.0.0.1:8080/',
    '    ready:',
    '      http: /actuator/health',
    '      timeoutMs: 180000',
    '    environments: [dev, qa]',
    '    arguments:',
    '      dev: [-Dspring-boot.run.profiles=dev]',
    '      qa: [-Dspring-boot.run.profiles=qa, -Dspring-boot.run.jvmArguments=-Xmx2g]',
    '    debug:',
    '      runtime: java',
    '      port: 5005',
    '  - id: web-dev',
    '    argv: [npm, run, dev]',
    '    workingDirectory: apps/web',
    '    url: http://127.0.0.1:5173/',
    '    ready:',
    '      log: ready in',
    '      timeoutMs: 90000',
    '    debug:',
    '      runtime: node',
    '      port: 9229',
    '      suspend: false',
    ''
  ].join('\n'));
  assert.deepEqual(YAML.parse(draft).start.map((entry) => entry.id), ['api', 'web-dev']);
  assert.deepEqual(YAML.parse(draft).start[0].arguments, { dev: DEV, qa: QA });
  assert.doesNotMatch(draft, /hunter2|tok-123456|user:pw/);
  // Arguments for an environment the suggestion did not list still make it one of its environments.
  const derived = suggest.suggestionsFrom({ resultType: 'sflow-app-suggestions', capability: 'payments-web',
    suggestions: [suggestion({ start: { id: 'api', argv: MAVEN, arguments: { qa: QA } } })] });
  assert.deepEqual(derived.suggestions[0].start.environments, ['qa']);
});

test('the route follows the capability page: implicit is local, explicit proposes to the authority, and the argv is exact', () => {
  assert.deepEqual(suggest.applicationRoute('implicit', 'https://git.example/lead.git', ['https://git.example/lead.git']), { kind: 'local' });
  assert.deepEqual(suggest.applicationRoute('explicit-managed', 'https://git.example/lead.git', []), { kind: 'proposal', lead: 'https://git.example/lead.git' });
  assert.deepEqual(suggest.applicationRoute('explicit-legacy', null, ['https://git.example/lead.git']), { kind: 'proposal', lead: 'https://git.example/lead.git' });
  assert.deepEqual(suggest.applicationRoute('explicit-legacy', null, []), { kind: 'local' });
  assert.deepEqual(suggest.applicationRoute(null, '', ['a', 'b', 'a']), { kind: 'pick', leads: ['a', 'b'] });
  assert.deepEqual(suggest.applicationWriteArgv({ kind: 'proposal', lead: 'https://git.example/lead.git' }, 'payments-web', '/tmp/sflow-application-x/application.yml'),
    ['capability', 'edit', 'payments-web', '--lead', 'https://git.example/lead.git', '--mode', 'set', '--application-file', '/tmp/sflow-application-x/application.yml', '--json']);
  assert.deepEqual(suggest.applicationWriteArgv({ kind: 'local' }, 'payments-web', '/tmp/f.yml'),
    ['capability', 'set', 'payments-web', '--application-file', '/tmp/f.yml', '--json']);
  assert.throws(() => suggest.applicationWriteArgv({ kind: 'local' }, '--help', '/tmp/f.yml'), /invalid/);
  assert.deepEqual(suggest.applicationWriteOutcome({ kind: 'proposal', lead: 'L' }, { lead: 'L2', branch: 'sflow/config-change/capability/set-payments-web', commit: 'c' }),
    { kind: 'proposal', lead: 'L2', branch: 'sflow/config-change/capability/set-payments-web' });
  assert.deepEqual(suggest.applicationWriteOutcome({ kind: 'proposal', lead: 'L' }, { changed: false }), { kind: 'unchanged' });
  assert.deepEqual(suggest.applicationWriteOutcome({ kind: 'local' }, { path: 'singularity/capabilities.yml' }), { kind: 'local', path: 'singularity/capabilities.yml' });
});

test('the review page shows the exact YAML, the environments.yml additions to copy, and the command; never a value', () => {
  const set = suggest.suggestionsFrom(suggestions());
  const kept = suggest.keptStarts(set, suggest.defaultSelection(set));
  const applicationYaml = suggest.applicationDraftYaml(kept.map((item) => item.start));
  const request = suggest.suggestionReviewRequest({ capability: 'payments-web', kept, route: { kind: 'proposal', lead: 'https://git.example/lead.git' },
    applicationYaml, environmentsDraft: set.environmentsDraft, declaredIds: ['old'] });
  assert.equal(request.title, 'Propose start entries for payments-web');
  assert.equal(request.confirmLabel, 'Propose these start entries');
  assert.equal(request.expected, undefined);
  for (const line of ['Start entries added: api (from IntelliJ IDEA, .run/Api.run.xml); web (from WebStorm, package.json)',
    'Start entries already declared, kept as they are: old', 'Proposed to: https://git.example/lead.git',
    `then deletes the file:\n${applicationYaml.trimEnd()}\n`, 'Additions for singularity/environments.yml. VS Code does not write these',
    set.environmentsDraft.trimEnd(),
    'VS Code runs: singularity-flow capability edit payments-web --lead https://git.example/lead.git --mode set --application-file "<private temporary file>" --json'
  ]) assert.ok(request.detail.includes(line), line);
  const local = suggest.suggestionReviewRequest({ capability: 'payments-web', kept, route: { kind: 'local' }, applicationYaml, environmentsDraft: null, declaredIds: [] });
  assert.equal(local.confirmLabel, 'Save these start entries');
  assert.match(local.detail, /Written to: singularity\/capabilities\.yml in this checkout[\s\S]*Additions for singularity\/environments\.yml: none suggested\.[\s\S]*capability set payments-web --application-file/);
  for (const text of [request.detail, request.summary, local.detail]) assert.doesNotMatch(text, /hunter2|tok-123456|user:pw/);
});

test('the suggestion page lists sources, commands, arguments, debug and variable names, with no secret value', () => {
  const set = suggest.suggestionsFrom(suggestions());
  const selection = suggest.defaultSelection(set);
  const html = runSuggestionsHtml({ capability: 'payments-web', set, selection, problems: suggest.selectionProblems(set, selection, ['old']),
    declaredIds: ['old'], busy: false, error: null, notice: null });
  assert.match(html, /<input type="checkbox" data-sg-keep="0" checked> Keep<\/label>[\s\S]*data-sg-id="0" value="api"/);
  assert.match(html, /<span class="pill">IntelliJ IDEA<\/span>\s*<button type="button" class="link" data-sg-open="0">\.run\/Api\.run\.xml<\/button>\s*<span class="muted">Api \(dev\)<\/span>/);
  assert.match(html, /<th>Command<\/th><td><code class="sg-argv">\.\/mvnw -q spring-boot:run<\/code>/);
  assert.match(html, /<tr><td><code>qa<\/code><\/td><td><code class="sg-argv">-Dspring-boot\.run\.profiles=qa -Dspring-boot\.run\.jvmArguments=-Xmx2g<\/code><\/td><\/tr>/);
  assert.match(html, /<tr><th>Debug<\/th><td>java on 127\.0\.0\.1:5005<\/td><\/tr>/);
  assert.match(html, /<tr><th>Environments<\/th><td>dev, qa <small class="muted">\(dev is the default\)<\/small>/);
  assert.match(html, /data-sg-name="SPRING_PROFILES_ACTIVE" data-sg-kind="flag">[\s\S]*<code>dev<\/code>/);
  assert.match(html, /data-sg-name="DB_PASSWORD" data-sg-kind="secret">[\s\S]*never copied[\s\S]*no value/);
  assert.match(html, /data-sg-keep="2" disabled>/, 'a suggestion that cannot be kept cannot be ticked');
  assert.match(html, /<code class="sg-argv">node worker\.js --db-password=\[hidden\]<\/code>/);
  assert.match(html, /<pre data-sg-environments>environments:/);
  assert.match(html, /data-sg-copy>Copy<\/button>[\s\S]*VS Code does not edit singularity\/environments\.yml/);
  assert.match(html, /payments-web already declares: <code>old<\/code>/);
  assert.match(html, /Not offered, because VS Code cannot write them exactly:[\s\S]*outside the repository/);
  assert.match(html, /data-sg-review>Review and propose…/);
  assert.doesNotMatch(html, /hunter2|tok-123456|user:pw/, 'no secret value reaches the page');

  // The script sends every card's tick and ID on Review.
  const listeners = {};
  const posted = [];
  const cards = [0, 1].map((index) => ({ dataset: { sgIndex: String(index) },
    querySelector: (query) => query === '[data-sg-keep]' ? { checked: index === 1 } : { value: index ? 'web-dev' : 'api' } }));
  const document = { addEventListener: (type, listener) => { (listeners[type] ??= []).push(listener); }, querySelectorAll: () => cards };
  new Function('window', 'document', RUN_SUGGESTIONS_SCRIPT)({ __sfVscode: { postMessage: (message) => posted.push(message) } }, document);
  const review = { dataset: { sgReview: '' }, closest: () => review };
  for (const listener of listeners.click) listener({ target: review, preventDefault() {} });
  assert.deepEqual(posted, [{ type: 'suggest.review', selection: [{ index: 0, keep: false, id: 'api' }, { index: 1, keep: true, id: 'web-dev' }] }]);
});
