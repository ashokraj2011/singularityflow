/**
 * IDE-style run configurations in VS Code: arguments per environment, Start (debug) with a loopback
 * attach, and "Suggest from run configurations". [docs/SPEC-RUN-AND-TEST-v1.md, amendment, milestone 8]
 *
 * The fixtures have the shapes the engine gives `app plan --json` (arguments, debug), `app status
 * --json` (debug) and `app suggest --json`; the last test reads the real engine's answers for the
 * engine's own IDE fixture repository. Everything else is pure: no `vscode`, no process, no shell.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
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
const capability = { id: 'payments-web', name: 'Payments web', kind: 'delivery', delivery: true, repository: 'payments-web', repositories: ['payments-web'], children: [] };
const MAVEN = ['./mvnw', '-q', 'spring-boot:run'];
const DEV = ['-Dspring-boot.run.profiles=dev'];
const QA = ['-Dspring-boot.run.profiles=qa', '-Dspring-boot.run.jvmArguments=-Xmx2g'];
const JDWP = '-Dspring-boot.run.jvmArguments=-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:5005';
/** `app plan --json` for an entry with arguments and a debug block, as the engine answers it. */
const apiEntry = (overrides = {}) => ({
  capability: 'payments-web', repository: 'payments-web', id: 'api', argv: MAVEN, workingDirectory: 'services/api',
  url: 'http://127.0.0.1:8080/', ready: { http: '/actuator/health', timeoutMs: 180000 },
  environments: [
    { name: 'dev', status: 'bound', default: true, argv: [...MAVEN, ...DEV], debug: { argv: [...MAVEN, ...DEV, JDWP], environmentNames: [] } },
    { name: 'qa', status: 'bound', default: false, argv: [...MAVEN, ...QA],
      debug: { refusal: { code: 'APP_DEBUG_ALREADY_CONFIGURED', message: 'The qa arguments already start a debugger. Nothing ran.' } } }
  ],
  commandSha256: SHA,
  arguments: { dev: DEV, qa: QA },
  debug: { runtime: 'java', port: 5005, suspend: false, address: '127.0.0.1:5005', launcher: 'maven-spring-boot',
    argv: [...MAVEN, ...DEV, JDWP], environmentNames: [], notes: [] },
  ...overrides
});
const status = (overrides = {}) => ({ id: 'api', declared: true, started: true, ready: false, url: 'http://127.0.0.1:8080/', pid: 4242,
  startedAt: '2026-10-20T10:00:00Z', environment: 'dev', commandSha256: SHA, recordedCommandSha256: SHA,
  debug: { runtime: 'java', port: 5005, listening: true }, ...overrides });

test('app plan carries each environment\'s arguments, resolved argv and debug launch, or the engine\'s refusal', () => {
  const { entries, dropped } = model.appPlanFrom({ resultType: 'sflow-app-plan', capability: 'payments-web', entries: [apiEntry()] });
  assert.deepEqual(dropped, []);
  const [entry] = entries;
  assert.deepEqual(entry.arguments, { dev: DEV, qa: QA });
  assert.deepEqual(model.resolvedArgv(entry, 'dev'), [...MAVEN, ...DEV]);
  assert.deepEqual(model.resolvedArgv(entry, 'qa'), [...MAVEN, ...QA]);
  assert.deepEqual(model.resolvedArgv(entry, null), MAVEN);
  assert.equal(entry.debugIssue, null);
  assert.equal(entry.debug.runtime, 'java');
  assert.equal(entry.debug.port, 5005);
  assert.equal(entry.debug.launcher, 'maven-spring-boot');
  assert.deepEqual(model.debugLaunch(entry.debug, 'dev'), { argv: [...MAVEN, ...DEV, JDWP], environmentNames: [], refusal: null });
  assert.deepEqual(model.debugLaunch(entry.debug, 'qa').refusal, { code: 'APP_DEBUG_ALREADY_CONFIGURED', message: 'The qa arguments already start a debugger. Nothing ran.' });
  assert.deepEqual(model.debugLaunch(entry.debug, null).argv, [...MAVEN, ...DEV, JDWP], 'without an environment, the block itself');
  assert.equal(model.debugConfirmationKey(entry), `${SHA}:debug`, 'a debug start has no identity of its own; it is confirmed apart');

  // Without resolved argv, the amendment's rule: argv, then that environment's arguments.
  const bare = model.appPlanFrom([apiEntry({ environments: [{ name: 'dev', status: 'bound', default: true }, { name: 'qa', status: 'bound' }],
    arguments: { dev: DEV, qa: QA, prod: ['-x'] } })]).entries[0];
  assert.deepEqual(model.resolvedArgv(bare, 'qa'), [...MAVEN, ...QA]);
  assert.deepEqual(Object.keys(bare.arguments), ['dev', 'qa'], 'arguments for an environment the entry does not allow are not shown');

  // A debug block VS Code cannot attach to is not offered, and says why; the plain start still is.
  for (const [debug, issue] of [[{ runtime: 'ruby', port: 1 }, /not one VS Code attaches to/], [{ runtime: 'node', port: 99999 }, /not a TCP port/]]) {
    const parsed = model.appPlanFrom([apiEntry({ debug })]).entries[0];
    assert.equal(parsed.debug, null);
    assert.match(parsed.debugIssue, issue);
  }
  const npm = model.appPlanFrom([apiEntry({ environments: [], arguments: undefined, debug: { runtime: 'node', port: 9229, suspend: false, address: '127.0.0.1:9229',
    launcher: 'npm-script', argv: ['npm', 'run', 'dev'], environmentNames: ['npm_config_node_options', 'bad name'], notes: ['npm passes --inspect to the Node process.'] } })]).entries[0];
  assert.deepEqual(npm.debug.environmentNames, ['npm_config_node_options'], 'variable names only, never a value');
  assert.deepEqual(npm.debug.notes, ['npm passes --inspect to the Node process.']);
  const dotnet = model.appPlanFrom([apiEntry({ debug: { runtime: 'dotnet', port: null, suspend: false, address: null, launcher: 'dotnet', argv: ['dotnet', 'run'], environmentNames: [], notes: [] } })]).entries[0];
  assert.equal(dotnet.debug.port, null);
});

test('app status reports the debugger: runtime, port and listening, only for a live process; .NET listens on nothing', () => {
  assert.deepEqual(model.appStatusFrom({ entries: [status(), status({ id: 'web', started: false, debug: { runtime: 'node', port: 9229, listening: true } }),
    status({ id: 'bad', debug: { port: '5005', listening: 'yes' } }), status({ id: 'billing', debug: { runtime: 'dotnet', port: null, listening: null } })] })
    .map((entry) => entry.debug), [
    { runtime: 'java', port: 5005, listening: true },
    { runtime: 'node', port: 9229, listening: false },
    { runtime: null, port: null, listening: false },
    { runtime: 'dotnet', port: null, listening: false }
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
  assert.deepEqual(model.debugAttachPlan(entry, live), { configuration: { type: 'java', request: 'attach', name, hostName: '127.0.0.1', port: 5007 },
    extension: { id: 'vscjava.vscode-java-debug', name: 'Debugger for Java' }, where: 'with its debugger listening at 127.0.0.1:5007' });
  assert.match(model.debugAttachPlan(entry, model.appStatusFrom([status({ debug: { runtime: 'java', port: 5005, listening: false } })])[0]).error, /has no debugger listening/);
  assert.match(model.debugAttachPlan(entry, undefined).error, /has no debugger listening/);
  assert.match(model.debugAttachPlan(entry, model.appStatusFrom([status({ debug: { runtime: 'node', port: 9229, listening: true } })])[0]).error,
    /running with the node debugger, but singularity\/capabilities\.yml now declares java\. Stop it and start it again\./);
  const dotnet = model.appPlanFrom([apiEntry({ debug: { runtime: 'dotnet', port: null, argv: ['dotnet', 'run'], environmentNames: [], notes: [] } })]).entries[0];
  const [dotnetStatus] = model.appStatusFrom([status({ debug: { runtime: 'dotnet', port: null, listening: null } })]);
  assert.deepEqual(model.debugAttachPlan(dotnet, dotnetStatus).configuration, { type: 'coreclr', request: 'attach', name, processId: 4242 });
  assert.equal(model.debuggerReady(dotnet.debug, model.appStatusFrom([status({ pid: null, debug: { runtime: 'dotnet', port: null, listening: null } })])[0]), false);
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

test('Start (debug) runs `app start … --debug --expect-command <commandSha256>` and is confirmed apart from the plain start', () => {
  assert.deepEqual(model.appStartArgv('payments-web', 'api', 'dev', SHA, true),
    ['app', 'start', 'api', '--capability', 'payments-web', '--environment', 'dev', '--debug', '--expect-command', SHA]);
  assert.deepEqual(model.appStartArgv('payments-web', 'api', null, null, true), ['app', 'start', 'api', '--capability', 'payments-web', '--debug']);
  const entry = model.appPlanFrom([apiEntry()]).entries[0];
  const request = model.debugStartConfirmationRequest(entry, 'dev');
  assert.equal(request.title, 'Start api with its debugger for payments-web');
  for (const line of [
    `Command: ${JSON.stringify([...MAVEN, ...DEV, JDWP])}`, `Arguments for dev: ${JSON.stringify(DEV)}`,
    'Debugger: Java debugger at 127.0.0.1:5005',
    'VS Code attaches once app status says the debugger listens, on 127.0.0.1 at the port app status reports: {"type":"java","request":"attach","name":"api · payments-web (Singularity Flow)","hostName":"127.0.0.1","port":5005}',
    `Command identity: ${SHA} (its debug start)`,
    `singularity-flow app start api --capability payments-web --environment dev --debug --expect-command ${SHA}`,
    'Ending the debug session leaves api running; Stop ends it.'
  ]) assert.ok(request.detail.includes(line), line);
  const npm = model.appPlanFrom([apiEntry({ environments: [], arguments: undefined, debug: { runtime: 'node', port: 9229, suspend: true,
    launcher: 'npm-script', argv: ['npm', 'run', 'dev'], environmentNames: ['npm_config_node_options'], notes: ['npm passes --inspect-brk to the Node process.'] } })]).entries[0];
  const node = model.debugStartConfirmationRequest(npm, null).detail;
  assert.ok(node.includes('Command: ["npm","run","dev"]'));
  assert.ok(node.includes('Set for the application only, by the engine: npm_config_node_options'));
  assert.ok(node.includes('Note: npm passes --inspect-brk to the Node process.'));
  assert.ok(node.includes('Node.js debugger at 127.0.0.1:9229, waiting for the debugger before it runs'));
  assert.ok(node.includes(', after the debugger attaches'));
  // The plain start's confirmation shows the argv the chosen environment runs.
  assert.ok(model.startConfirmationRequest(entry, 'qa').detail.includes(`Command: ${JSON.stringify([...MAVEN, ...QA])}\nArguments for qa: ${JSON.stringify(QA)}`));
});

test('each start row shows the argv its environment runs, every environment\'s arguments, and the debug controls', () => {
  const plan = model.appPlanFrom([apiEntry(), { ...apiEntry({ id: 'web', debug: undefined, arguments: undefined }),
    environments: [{ name: 'dev', status: 'bound', default: true }] }]).entries;
  let html = runAndTestHtml(model.buildRunAndTestView(capability, 'here', { plan, status: [], environment: 'dev' }));
  assert.match(html, /data-rt-entry="api"[\s\S]*<small class="muted rt-command">\.\/mvnw -q spring-boot:run -Dspring-boot\.run\.profiles=dev<\/small>/);
  assert.match(html, /<span data-rt-arguments="dev" data-rt-current>dev \(this run\): <code>-Dspring-boot\.run\.profiles=dev<\/code><\/span><br><span data-rt-arguments="qa">qa: <code>/);
  assert.match(html, /debug: Java debugger at 127\.0\.0\.1:5005/);
  assert.match(html, /data-rt="debug" data-rt-capability="payments-web" data-rt-entry="api">[\s\S]*Start \(debug\)/);
  assert.match(html, /data-rt="attach" data-rt-capability="payments-web" data-rt-entry="api" disabled>Attach debugger/);
  assert.doesNotMatch(html.slice(html.indexOf('data-rt-entry="web"')), /data-rt="debug"/, 'no debug button for an entry without a debug block');
  assert.match(html, /data-rt="suggest" data-rt-capability="payments-web">Suggest from run configurations/);

  // In qa the engine would refuse the debug start: the button is off and its message is shown.
  html = runAndTestHtml(model.buildRunAndTestView(capability, 'here', { plan, status: [], environment: 'qa' }));
  assert.match(html, /rt-command">\.\/mvnw -q spring-boot:run -Dspring-boot\.run\.profiles=qa -Dspring-boot\.run\.jvmArguments=-Xmx2g</);
  assert.match(html, /data-rt="debug" data-rt-capability="payments-web" data-rt-entry="api" disabled/);
  assert.match(html, /Start \(debug\) is not available: The qa arguments already start a debugger\. Nothing ran\./);

  assert.match(runAndTestHtml(model.buildRunAndTestView(capability, 'here', { plan, status: [], tasks: { api: { running: true, debug: true } } })),
    /data-rt-state="starting">[\s\S]*waiting for the debugger to listen, then until HTTP \/actuator\/health answers below 500 within 180 s/);

  // Running with its debugger listening: Attach is offered, Start (debug) is not.
  html = runAndTestHtml(model.buildRunAndTestView(capability, 'here', { plan, status: model.appStatusFrom([status()]), tasks: { api: { running: true, debug: true } } }));
  assert.match(html, /<small class="rt-listening">Debugger listening at 127\.0\.0\.1:5005<\/small>/);
  assert.match(html, /data-rt="debug" data-rt-capability="payments-web" data-rt-entry="api" disabled/);
  assert.match(html, /data-rt="attach" data-rt-capability="payments-web" data-rt-entry="api">Attach debugger/);
  assert.match(html, /rt-command">\.\/mvnw -q spring-boot:run -Dspring-boot\.run\.profiles=dev</, 'a running entry shows the environment it runs in');

  const noted = model.buildRunAndTestView(capability, 'here', { plan: model.appPlanFrom([apiEntry({ debug: { runtime: 'ruby' } })]).entries });
  assert.match(runAndTestHtml(noted), /Start \(debug\) is not offered: the debug runtime &quot;ruby&quot; is not one VS Code attaches to\./);

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

/** `app suggest --json` as the engine gives it, with what an engine bug could leak. */
const EXISTING = { id: 'old', argv: ['npm', 'start'], workingDirectory: 'apps/old', url: 'http://127.0.0.1:3000/', ready: { http: '/', timeoutMs: 60000 } };
const API_DRAFT = { id: 'api', argv: MAVEN, workingDirectory: 'services/api', url: 'http://127.0.0.1:8080/', ready: { http: '/actuator/health', timeoutMs: 180000 },
  environments: ['dev', 'qa'], arguments: { dev: DEV, qa: QA }, debug: { runtime: 'java', port: 5005 } };
const WEB_DRAFT = { id: 'web', argv: ['npm', 'run', 'dev'], workingDirectory: 'apps/web', url: 'http://127.0.0.1:5173/', ready: { log: 'ready in', timeoutMs: 90000 },
  debug: { runtime: 'node', port: 9229 } };
const suggestion = (overrides = {}) => ({
  source: { kind: 'intellij', file: '.run/Api (dev).run.xml', name: 'Api (dev)' },
  variants: [{ file: '.run/Api (dev).run.xml', name: 'Api (dev)', environment: 'dev' }, { file: '.run/Api (qa).run.xml', name: 'Api (qa)', environment: 'qa' }],
  start: { ...API_DRAFT, arguments: { dev: DEV, qa: QA } },
  environmentNames: [{ name: 'SPRING_PROFILES_ACTIVE', kind: 'flag', default: 'dev', environment: 'dev' }, { name: 'SPRING_PROFILES_ACTIVE', kind: 'flag', default: 'qa', environment: 'qa' },
    { name: 'SPRING_PROFILES_ACTIVE', kind: 'flag', default: 'dev', environment: 'dev' }, { name: 'DB_PASSWORD', kind: 'secret', default: 'hunter2-db' },
    { name: 'DATABASE_URL', kind: 'endpoint', value: 'http://127.0.0.1:5432/app' }, { name: 'API_TOKEN', kind: 'flag', default: 'tok-123456' },
    { name: 'BILLING_URL', kind: 'endpoint', value: 'https://user:pw@billing.local/' }],
  notes: ['IntelliJ computes the classpath; this runs through the Maven wrapper instead.'],
  ...overrides
});
const draft = (entries, tests = [{ use: 'module-tests' }]) => `# The application block for capability payments-web: existing entries, then the suggested ones.\n${YAML.stringify({ start: entries, tests })}`;
const suggestions = () => ({
  resultType: 'sflow-app-suggestions', capability: 'payments-web', repository: 'payments-web',
  suggestions: [
    suggestion(),
    suggestion({ source: { kind: 'webstorm', file: '.run/web.run.xml', name: 'dev' }, variants: undefined, start: { ...WEB_DRAFT, arguments: {} }, environmentNames: [], notes: [] }),
    suggestion({ source: { kind: 'vscode', file: '.vscode/launch.json', name: 'Worker' }, variants: undefined, start: { id: 'worker', argv: ['node', 'worker.js', '--db-password=hunter2-db'], arguments: {} }, environmentNames: [], notes: [] }),
    suggestion({ source: { kind: 'launch-settings', file: 'services/billing/Properties/launchSettings.json', name: 'http' }, variants: undefined,
      start: { id: 'billing-http', argv: ['dotnet', 'run'], workingDirectory: 'services/billing', arguments: {}, debug: { runtime: 'dotnet' } }, environmentNames: [],
      notes: ["Already declared as start entry 'old'; the draft keeps that one."] }),
    suggestion({ source: { kind: 'rider', file: '../outside/x.run.xml', name: 'Outside' }, start: { id: 'outside', argv: ['dotnet', 'run'], workingDirectory: '../elsewhere' } }),
    suggestion({ source: { kind: 'detected', file: 'go.mod' }, start: { id: 'bad', argv: [] } })
  ],
  applicationDraft: draft([EXISTING, API_DRAFT, WEB_DRAFT, { id: 'worker', argv: ['node', 'worker.js', '--db-password=hunter2-db'] }]),
  environmentsDraft: '# Additions for singularity/environments.yml.\nenvironments:\n  dev:\n    requires:\n      - { name: DB_PASSWORD, kind: secret }\n      - { name: SPRING_PROFILES_ACTIVE, kind: flag, default: dev }\n',
  notes: ['Entries with environments start only when the capability sets policy.localIntegrationEvidence: allowed (a capability proposal).'],
  files: { read: 12, skipped: [{ file: '.vscode/launch.json', reason: "configuration 'Attach to Node' attaches to a running process; nothing to start" }] }
});

test('app suggest is read field by field: no secret value, no path outside the repository, no command it cannot run', () => {
  assert.equal(commandClass(['app', 'suggest', '--capability', 'payments-web', '--json']), 'read', 'a read, never cached');
  assert.deepEqual(suggest.appSuggestArgv('payments-web'), ['app', 'suggest', '--capability', 'payments-web', '--json']);
  assert.throws(() => suggest.appSuggestArgv('--x'), /invalid/);
  const set = suggest.suggestionsFrom({ resultType: 'command-result', data: suggestions() });
  assert.equal(set.capability, 'payments-web');
  assert.equal(set.repository, 'payments-web');
  assert.deepEqual(set.suggestions.map((item) => item.start.id), ['api', 'web', 'worker', 'billing-http']);
  assert.deepEqual(set.dropped, ['Outside: its working directory "../elsewhere" is outside the repository', 'bad: it has no command VS Code can run exactly']);
  assert.deepEqual(set.existing, { start: [EXISTING], tests: [{ use: 'module-tests' }] }, 'what the draft keeps besides the suggestions');
  assert.deepEqual(set.notes, suggestions().notes);
  assert.deepEqual(set.files, suggestions().files);
  const [api, web, worker, billing] = set.suggestions;
  assert.deepEqual(api.source, { kind: 'intellij', words: 'IntelliJ IDEA', file: '.run/Api (dev).run.xml', name: 'Api (dev)' });
  assert.deepEqual(api.variants.map((variant) => variant.environment), ['dev', 'qa']);
  assert.deepEqual(api.draft, API_DRAFT, 'kept exactly as the engine drafted and checked it');
  assert.deepEqual(api.environmentNames, [
    { name: 'SPRING_PROFILES_ACTIVE', kind: 'flag', default: 'dev', environment: 'dev' },
    { name: 'SPRING_PROFILES_ACTIVE', kind: 'flag', default: 'qa', environment: 'qa' },
    { name: 'DB_PASSWORD', kind: 'secret', default: null, environment: null },
    { name: 'DATABASE_URL', kind: 'endpoint', default: 'http://127.0.0.1:5432/app', environment: null },
    { name: 'API_TOKEN', kind: 'secret', default: null, environment: null },
    { name: 'BILLING_URL', kind: 'endpoint', default: null, environment: null }
  ], 'one row per environment a variable differs in (seen in a real VS Code: the qa one was lost); a secret (or secret-looking) name never has a value, and an endpoint never carries credentials');
  assert.deepEqual(web.start.debug, { runtime: 'node', port: 9229 });
  assert.equal(api.refusal, null);
  assert.equal(web.refusal, null);
  assert.match(worker.refusal, /looks like it carries the value of db-password/);
  assert.match(billing.refusal, /left this one out of its application draft/);
  assert.deepEqual(suggest.maskedArgv(worker.start.argv), ['node', 'worker.js', '--db-password=[hidden]']);
  assert.deepEqual(suggest.maskedArgv(['run', '--token', 'abc', '-Dapp.secret=s3', '--key=${KEY}', 'PASSWORD=x']),
    ['run', '--token', '[hidden]', '-Dapp.secret=[hidden]', '--key=${KEY}', 'PASSWORD=[hidden]'], 'a placeholder is a reference, not a value');
  assert.equal(suggest.suggestionsFrom({ resultType: 'something-else', capability: 'x' }), null);
  assert.equal(suggest.repositoryRelative('/etc/passwd'), null);
  assert.equal(suggest.repositoryRelative('C:\\x'), null);
  assert.equal(suggest.repositoryRelative('a\\b'), 'a/b');
  // A draft VS Code cannot read leaves nothing to keep.
  const unreadable = suggest.suggestionsFrom({ ...suggestions(), applicationDraft: 'start: [' });
  assert.equal(unreadable.existing, null);
  assert.ok(unreadable.suggestions.every((item) => /could not be read/.test(item.refusal ?? '') || /looks like/.test(item.refusal ?? '')));

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

test('the person ticks and renames suggestions; the block is the existing one plus exactly the kept entries', () => {
  const set = suggest.suggestionsFrom(suggestions());
  assert.deepEqual(suggest.defaultSelection(set).map((choice) => choice.keep), [false, false, false, false], 'nothing is kept until ticked');
  const selection = [{ index: 0, keep: true, id: 'api' }, { index: 1, keep: true, id: 'web' }, { index: 2, keep: false, id: 'worker' }, { index: 3, keep: false, id: 'billing-http' }];
  assert.deepEqual(suggest.selectionProblems(set, selection, ['old']), { rows: {}, general: null });
  const problems = suggest.selectionProblems(set, [{ index: 0, keep: true, id: 'Api' }, { index: 1, keep: true, id: 'old' }, { index: 2, keep: true, id: 'worker' },
    { index: 3, keep: true, id: 'billing-http' }], ['old']);
  assert.match(problems.rows[0], /lower-case kebab case/);
  assert.match(problems.rows[1], /old is already a start entry of payments-web/);
  assert.match(problems.rows[2], /cannot be kept as written/);
  assert.match(problems.rows[3], /left this one out/);
  assert.match(suggest.selectionProblems(set, [{ index: 0, keep: true, id: 'one' }, { index: 1, keep: true, id: 'one' }], []).rows[1], /both called one/);
  assert.equal(suggest.selectionProblems(set, [], []).general, 'Keep at least one suggestion to propose it.');
  // The page names only suggestions it was shown; anything else is ignored.
  assert.deepEqual(suggest.selectionFrom([{ index: 1, keep: true, id: ' web-dev ' }, { index: 9, keep: true, id: 'x' }, 'junk'], set).map((choice) => [choice.keep, choice.id]),
    [[false, 'api'], [true, 'web-dev'], [false, 'worker'], [false, 'billing-http']]);

  const kept = suggest.keptStarts(set, [{ index: 0, keep: true, id: 'api' }, { index: 1, keep: true, id: 'web-dev' }, { index: 3, keep: true, id: 'billing-http' }]);
  assert.deepEqual(kept.map((item) => item.id), ['api', 'web-dev'], 'a suggestion the engine did not draft is never written');
  const block = suggest.applicationDraftYaml(set.existing, kept.map((item) => item.entry));
  assert.equal(block, [
    'start:',
    '  - id: old',
    '    argv: [npm, start]',
    '    workingDirectory: apps/old',
    '    url: http://127.0.0.1:3000/',
    '    ready:',
    '      http: /',
    '      timeoutMs: 60000',
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
    'tests:',
    '  - use: module-tests',
    ''
  ].join('\n'));
  const parsed = YAML.parse(block);
  assert.deepEqual(parsed.start, [EXISTING, API_DRAFT, { ...WEB_DRAFT, id: 'web-dev' }], 'the whole block replaces the capability\'s, so the existing entry and tests are in it');
  assert.deepEqual(parsed.tests, [{ use: 'module-tests' }]);
  assert.doesNotMatch(block, /hunter2|tok-123456|user:pw/);
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

test('the review page shows the exact block, the environments.yml additions to copy, and the command; never a value', () => {
  const set = suggest.suggestionsFrom(suggestions());
  const kept = suggest.keptStarts(set, [{ index: 0, keep: true, id: 'api' }, { index: 1, keep: true, id: 'web' }]);
  const applicationYaml = suggest.applicationDraftYaml(set.existing, kept.map((item) => item.entry));
  const request = suggest.suggestionReviewRequest({ capability: 'payments-web', kept, route: { kind: 'proposal', lead: 'https://git.example/lead.git' },
    applicationYaml, environmentsDraft: set.environmentsDraft, existing: set.existing });
  assert.equal(request.title, 'Propose start entries for payments-web');
  assert.equal(request.confirmLabel, 'Propose these start entries');
  assert.equal(request.expected, undefined);
  for (const line of ['Start entries added: api (from IntelliJ IDEA, .run/Api (dev).run.xml); web (from WebStorm, .run/web.run.xml)',
    'Start entries already declared, kept as they are: old', 'Tests already declared, kept as they are: 1', 'Proposed to: https://git.example/lead.git',
    `It replaces the capability's whole block; VS Code writes exactly this to a private temporary file, passes it to the command below, then deletes the file:\n${applicationYaml.trimEnd()}\n`,
    'Additions for singularity/environments.yml. VS Code does not write these', set.environmentsDraft.trimEnd(),
    'VS Code runs: singularity-flow capability edit payments-web --lead https://git.example/lead.git --mode set --application-file "<private temporary file>" --json'
  ]) assert.ok(request.detail.includes(line), line);
  const local = suggest.suggestionReviewRequest({ capability: 'payments-web', kept, route: { kind: 'local' }, applicationYaml, environmentsDraft: null,
    existing: { start: [], tests: null } });
  assert.equal(local.confirmLabel, 'Save these start entries');
  assert.match(local.detail, /already declared, kept as they are: none[\s\S]*Written to: singularity\/capabilities\.yml in this checkout[\s\S]*Additions for singularity\/environments\.yml: none suggested\.[\s\S]*capability set payments-web --application-file/);
  for (const text of [request.detail, request.summary, local.detail]) assert.doesNotMatch(text, /hunter2|tok-123456|user:pw/);
});

test('the suggestion page lists sources, variants, commands, arguments, debug and variable names, with no secret value', () => {
  const set = suggest.suggestionsFrom(suggestions());
  const selection = suggest.defaultSelection(set);
  const html = runSuggestionsHtml({ capability: 'payments-web', set, selection, problems: suggest.selectionProblems(set, [{ index: 0, keep: true, id: 'old' }], ['old']),
    declaredIds: ['old'], busy: false, error: null, notice: null });
  assert.match(html, /<input type="checkbox" data-sg-keep="0"> Keep<\/label>[\s\S]*data-sg-id="0" value="api"/);
  assert.match(html, /<span class="pill">IntelliJ IDEA<\/span>\s*<button type="button" class="link" data-sg-open="0">\.run\/Api \(dev\)\.run\.xml<\/button>\s*<span class="muted">Api \(dev\)<\/span>/);
  assert.match(html, /data-sg-problem="0">[\s\S]*old is already a start entry of payments-web/);
  assert.match(html, /One entry from 2 configurations: Api \(dev\) → dev; Api \(qa\) → qa/);
  assert.match(html, /<th>Command<\/th><td><code class="sg-argv">\.\/mvnw -q spring-boot:run<\/code>/);
  assert.match(html, /<tr><td><code>qa<\/code><\/td><td><code class="sg-argv">-Dspring-boot\.run\.profiles=qa -Dspring-boot\.run\.jvmArguments=-Xmx2g<\/code><\/td><\/tr>/);
  assert.match(html, /<tr><th>Debug<\/th><td>java on 127\.0\.0\.1:5005<\/td><\/tr>/);
  assert.match(html, /<tr><th>Environments<\/th><td>dev, qa <small class="muted">\(dev is the default\)<\/small>/);
  assert.match(html, /data-sg-name="SPRING_PROFILES_ACTIVE" data-sg-kind="flag">[\s\S]*<small class="muted">\(dev\)<\/small>[\s\S]*<code>dev<\/code>/);
  assert.match(html, /data-sg-name="SPRING_PROFILES_ACTIVE" data-sg-kind="flag">\s*<td><code>SPRING_PROFILES_ACTIVE<\/code> <small class="muted">\(qa\)<\/small><\/td><td>flag<\/td>\s*<td><code>qa<\/code>/);
  assert.match(html, /data-sg-name="DATABASE_URL" data-sg-kind="endpoint">[\s\S]*<code>http:\/\/127\.0\.0\.1:5432\/app<\/code>/);
  assert.match(html, /data-sg-name="DB_PASSWORD" data-sg-kind="secret">[\s\S]*never copied[\s\S]*no value/);
  assert.match(html, /data-sg-keep="2" disabled>/, 'a suggestion that cannot be kept cannot be ticked');
  assert.match(html, /data-sg-refusal="3">The engine left this one out of its application draft/);
  assert.match(html, /<code class="sg-argv">node worker\.js --db-password=\[hidden\]<\/code>/);
  assert.match(html, /<pre data-sg-environments># Additions for singularity\/environments\.yml\.\nenvironments:/);
  assert.match(html, /data-sg-copy>Copy<\/button>[\s\S]*VS Code does not edit singularity\/environments\.yml/);
  assert.match(html, /Read 12 files\.[\s\S]*Entries with environments start only when[\s\S]*1 configuration not used[\s\S]*<code>\.vscode\/launch\.json<\/code>: configuration &#39;Attach to Node&#39;/);
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

test('VS Code reads the real engine, and the engine takes the block VS Code writes: app plan, status, suggest, capability set', async (t) => {
  const { ideRepository, FAKE_SECRETS } = await import(path.join(root, 'test', 'helpers', 'ide-run-configurations.mjs'));
  const yaml = [
    '    policy: { localIntegrationEvidence: allowed }',
    '    application:',
    '      start:',
    '        - { id: api, argv: [./mvnw, -q, spring-boot:run], workingDirectory: services/api, url: "http://127.0.0.1:8081/",',
    '            ready: { http: /actuator/health, timeoutMs: 180000 }, environments: [dev, qa],',
    '            arguments: { dev: [-Dspring-boot.run.profiles=dev], qa: [-Dspring-boot.run.profiles=qa] }, debug: { runtime: java, port: 5005 } }',
    '        - { id: admin, argv: [yarn, dev], workingDirectory: apps/admin-ui, url: "http://127.0.0.1:5175/", ready: { log: ready, timeoutMs: 60000 }, debug: { runtime: node } }',
    '        - { id: billing, argv: [dotnet, run], workingDirectory: services/billing, url: "http://127.0.0.1:5080/", ready: { http: /, timeoutMs: 120000 }, debug: { runtime: dotnet } }',
    '      tests:',
    '        - { use: module-tests }',
    ''
  ].join('\n');
  const { root: repository } = await ideRepository(t, { capability: { yaml } });
  const cli = (...args) => {
    const result = spawnSync(process.execPath, [path.join(root, 'bin', 'singularity-flow.mjs'), ...args], { cwd: repository, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const { entries, dropped } = model.appPlanFrom(cli('app', 'plan', '--capability', 'shop', '--json'));
  assert.deepEqual(dropped, []);
  const [api, admin, billing] = entries;
  assert.deepEqual(model.resolvedArgv(api, 'qa'), ['./mvnw', '-q', 'spring-boot:run', '-Dspring-boot.run.profiles=qa']);
  assert.equal(api.debug.port, 5005);
  assert.match(model.debugLaunch(api.debug, 'qa').argv.at(-1), /address=127\.0\.0\.1:5005/);
  assert.equal(admin.debug.refusal.code, 'APP_DEBUG_LAUNCHER_UNSUPPORTED');
  assert.equal(billing.debug.port, null);
  const statuses = model.appStatusFrom(cli('app', 'status', '--capability', 'shop', '--json'));
  assert.deepEqual(statuses.map((entry) => entry.debug), [{ runtime: 'java', port: 5005, listening: false }, { runtime: 'node', port: 9229, listening: false },
    { runtime: 'dotnet', port: null, listening: false }]);

  const set = suggest.suggestionsFrom(cli('app', 'suggest', '--capability', 'shop', '--json'));
  assert.ok(set.suggestions.length >= 10, `${set.suggestions.length} suggestions`);
  assert.deepEqual(set.existing.start.map((entry) => entry.id), ['api', 'admin', 'billing']);
  assert.deepEqual(set.existing.tests, [{ use: 'module-tests' }]);
  const keepable = set.suggestions.filter((item) => !item.refusal);
  assert.ok(keepable.length >= 8, 'the engine drafts most of them, and VS Code finds no secret-looking argument in them');
  const merged = set.suggestions.find((item) => item.variants.length === 2);
  assert.deepEqual(merged.variants.map((variant) => variant.environment), ['dev', 'qa']);
  assert.deepEqual(Object.keys(merged.start.arguments), ['dev', 'qa']);
  const selection = set.suggestions.map((item) => ({ index: item.index, keep: !item.refusal, id: item.start.id }));
  assert.deepEqual(suggest.selectionProblems(set, selection, ['api', 'admin', 'billing']), { rows: {}, general: null });
  const block = suggest.applicationDraftYaml(set.existing, suggest.keptStarts(set, selection).map((item) => item.entry));
  assert.deepEqual(YAML.parse(block).start.slice(0, 3).map((entry) => entry.id), ['api', 'admin', 'billing']);
  const html = runSuggestionsHtml({ capability: 'shop', set, selection, problems: { rows: {}, general: null }, declaredIds: [], busy: false, error: null, notice: null });
  for (const secret of Object.values(FAKE_SECRETS)) {
    for (const [where, text] of [['page', html], ['block', block], ['environments', set.environmentsDraft ?? '']]) assert.ok(!text.includes(secret), `${where} carries a fake secret`);
  }

  // The local route: the real `capability set --application-file` takes the file as VS Code writes it.
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-application-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'application.yml');
  await writeFile(file, block, { mode: 0o600, flag: 'wx' });
  cli(...suggest.applicationWriteArgv({ kind: 'local' }, 'shop', file));
  const written = model.appPlanFrom(cli('app', 'plan', '--capability', 'shop', '--json'));
  assert.deepEqual(written.dropped, []);
  assert.deepEqual(written.entries.map((entry) => entry.id), YAML.parse(block).start.map((entry) => entry.id), 'the declared entries, then every kept one');
  const map = YAML.parse(await readFile(path.join(repository, 'singularity', 'capabilities.yml'), 'utf8'));
  assert.deepEqual(map.capabilities.shop.application.tests, [{ use: 'module-tests' }], 'the declared tests survive the whole-block write');
  assert.equal(map.capabilities.shop.policy.localIntegrationEvidence, 'allowed', 'nothing outside the application block changes');
});
