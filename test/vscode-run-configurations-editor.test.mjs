/**
 * The Run/Debug Configurations editor in VS Code. [docs/SPEC-RUN-AND-TEST-v1.md, IntelliJ amendment §2,
 * milestone 12]
 *
 * The fixtures have the amendment's shapes: typed start entries in `app plan --json` (`application`,
 * the declared block, and `entries[].environments[].resolved`), `app config preview --json` (per entry
 * and environment, the resolved command line or the located errors) and typed `app suggest --json`.
 * Everything here is pure: no `vscode`, no process, no shell. The secret rule is pinned to the
 * engine's own (src/app-suggestions.mjs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (name) => pathToFileURL(path.join(root, 'apps', 'vscode', 'src', name)).href;
const model = await import(source('views/run-configurations-model.ts'));
const pageModule = await import(source('views/run-configurations-page.ts'));
const { commandClass } = await import(source('cli/client.ts'));
const { runAndTestHtml } = await import(source('views/run-and-test-page.ts'));
const runAndTest = await import(source('views/run-and-test-model.ts'));
const engine = await import(pathToFileURL(path.join(root, 'src', 'app-suggestions.mjs')).href);
const { declarableEnvironmentVariable } = await import(pathToFileURL(path.join(root, 'src', 'environment-declaration.mjs')).href);
const { FAKE_SECRETS } = await import(pathToFileURL(path.join(root, 'test', 'helpers', 'ide-run-configurations.mjs')).href);

const SHA = `sha256:${'a'.repeat(64)}`;
const WEB = { id: 'web', argv: ['npm', 'run', 'dev'], workingDirectory: 'apps/web', url: 'http://127.0.0.1:5173/', ready: { http: '/', timeoutMs: 1000 } };
const API = {
  id: 'api', name: 'Api', type: 'spring-boot', launcher: 'maven', mainClass: 'com.example.api.ApiApplication',
  vmOptions: ['-Xmx1g', '-Dfile.encoding=UTF-8'], programArguments: ['--server.port=8080'], activeProfiles: ['dev'],
  workingDirectory: 'services/api', env: { FEATURE_FLAGS: 'a,b' }, beforeLaunch: [{ argv: ['../../mvnw', '-q', 'compile'] }],
  perEnvironment: { qa: { activeProfiles: ['qa'], vmOptions: ['-Xmx2g'] } }, environments: ['dev', 'qa'],
  url: 'http://127.0.0.1:8080/', ready: { http: '/actuator/health', timeoutMs: 180000 }, debug: { port: 5005 }
};
const TESTS = [{ use: 'module-tests' }, { use: 'integration-tests', environments: ['dev', 'qa'] }];
const MAVEN_DEV = ['./mvnw', '-q', 'spring-boot:run', '-Dspring-boot.run.main-class=com.example.api.ApiApplication',
  '-Dspring-boot.run.jvmArguments=-Xmx1g -Dfile.encoding=UTF-8', '-Dspring-boot.run.arguments=--server.port=8080', '-Dspring-boot.run.profiles=dev'];

/** `app plan --capability payments-web --json` for a typed entry, as the amendment describes it. */
const plan = (application = { start: [WEB, API], tests: TESTS }) => ({
  resultType: 'sflow-app-plan', capability: 'payments-web', application,
  entries: [
    { capability: 'payments-web', repository: 'payments-web', ...WEB, environments: [], commandSha256: SHA },
    { capability: 'payments-web', repository: 'payments-web', ...API, argv: MAVEN_DEV, commandSha256: SHA,
      environments: [
        { name: 'dev', status: 'bound', default: true, resolved: { argv: MAVEN_DEV, envNames: ['FEATURE_FLAGS', 'DB_PASSWORD', 'DATABASE_URL'], beforeLaunch: [['../../mvnw', '-q', 'compile']] } },
        { name: 'qa', status: 'unbound', default: false, resolved: { argv: [...MAVEN_DEV.slice(0, -1), '-Dspring-boot.run.profiles=qa'], envNames: ['FEATURE_FLAGS', 'DB_PASSWORD'], beforeLaunch: [] } }
      ] }
  ]
});

const declared = (raw = plan()) => model.declaredFromPlan(raw);
const draftOf = (raw = plan()) => { const { block } = declared(raw); return { block, draft: model.draftFrom('payments-web', block) }; };
const entryOf = (draft, id) => draft.configurations.find((item) => item.entry.id === id).entry;
const withEntry = (draft, id, entry) => ({ ...draft, configurations: draft.configurations.map((item) => item.entry.id === id ? { ...item, entry } : item) });

test('every type in the amendment has its fields, how it runs, and a template with a loopback URL, readiness and its debug port', () => {
  const fields = Object.fromEntries(Object.entries(model.TYPE_SPECS).map(([type, spec]) => [type, spec.fields.map((field) => field.key)]));
  assert.deepEqual(fields, {
    'spring-boot': ['launcher', 'mainClass', 'vmOptions', 'programArguments', 'activeProfiles'],
    jar: ['jar', 'vmOptions', 'programArguments'],
    application: ['launcher', 'mainClass', 'vmOptions', 'programArguments'],
    maven: ['goals', 'profiles', 'properties', 'arguments'],
    gradle: ['tasks', 'properties', 'arguments'],
    python: ['script', 'module', 'interpreter', 'interpreterOptions', 'parameters'],
    django: ['manage', 'host', 'port', 'settings'],
    fastapi: ['app', 'port', 'reload'],
    flask: ['app', 'port', 'reload'],
    node: ['script', 'nodeOptions', 'applicationParameters', 'nodeInterpreter'],
    npm: ['packageManager', 'script', 'arguments'],
    go: ['kind', 'target', 'goToolArguments', 'programArguments'],
    dotnet: ['project', 'launchProfile', 'configuration', 'arguments'],
    command: ['argv']
  });
  assert.deepEqual([...model.CONFIGURATION_TYPES], Object.keys(model.TYPE_SPECS));
  assert.deepEqual(model.TYPE_SPECS['spring-boot'].fields[0].options, ['maven', 'gradle']);
  assert.deepEqual(model.TYPE_SPECS.application.fields[0].options, ['maven-exec', 'gradle-run']);
  assert.deepEqual(model.TYPE_SPECS.npm.fields[0].options, ['npm', 'pnpm', 'yarn']);
  assert.deepEqual(model.TYPE_SPECS.go.fields[0].options, ['package', 'file', 'directory']);
  assert.deepEqual(model.TYPE_SPECS.django.fields[1].options, ['127.0.0.1', 'localhost', '::1'], 'a host is loopback only');
  for (const type of model.CONFIGURATION_TYPES) {
    const entry = model.templateEntry(type, { ids: [], names: [] });
    assert.ok(runAndTest.loopbackUrl(entry.url), `${type} template URL`);
    assert.ok(entry.ready.http?.startsWith('/') && entry.ready.timeoutMs >= 1000, `${type} template readiness`);
    assert.equal(entry.type, type === 'command' ? undefined : type, 'a command entry is the plain argv form');
    assert.equal(model.typeOf(entry), type);
    const runtime = model.runtimeOf(entry);
    assert.equal(entry.debug?.port, runtime && runtime !== 'dotnet' ? model.DEFAULT_DEBUG_PORTS[runtime] : undefined, `${type} debug port`);
    assert.ok(model.TYPE_SPECS[type].runsAs.length > 10);
    for (const field of model.TYPE_SPECS[type].fields) if (field.required) assert.notEqual(entry[field.key], undefined, `${type}.${field.key} is filled in`);
  }
  assert.deepEqual(model.overridableFields('spring-boot'), ['launcher', 'mainClass', 'vmOptions', 'programArguments', 'activeProfiles', 'workingDirectory', 'env', 'beforeLaunch']);
  assert.deepEqual(model.overridableFields('command'), ['appended', 'workingDirectory', 'env', 'beforeLaunch']);
});

test('templates and copies get an ID and a name nobody else has', () => {
  let { draft } = draftOf();
  ({ draft } = model.addFromTemplate(draft, 'spring-boot'));
  ({ draft } = model.addFromTemplate(draft, 'spring-boot'));
  assert.deepEqual(draft.configurations.map((item) => item.entry.id), ['web', 'api', 'api-2', 'api-3']);
  assert.deepEqual(draft.configurations.slice(2).map((item) => item.entry.name), ['Spring Boot', 'Spring Boot (2)']);
  const copied = model.copyConfiguration(draft, draft.configurations[1].key);
  assert.deepEqual(copied.draft.configurations.map((item) => item.entry.id), ['web', 'api', 'api-copy', 'api-2', 'api-3'], 'a copy sits after its original');
  assert.equal(copied.draft.configurations[2].entry.name, 'Api (copy)');
  assert.equal(copied.draft.configurations[2].origin, null);
  assert.equal(model.uniqueId('Api Server!', ['api-server']), 'api-server-2');
});

test('the secret rule is the engine\'s: names, values and arguments', () => {
  const values = [...Object.values(FAKE_SECRETS), 'a,b', 'UTF-8', 'com.example.shop.Api2Main', '-Dfile.encoding=UTF-8', 'http://127.0.0.1:5432/db',
    'postgres://user:pw@db/x', 'short', '0123456789abcdef0123456789abcdef', 'plain words with spaces', 'https://x.example/?token=1', ''];
  for (const value of values) assert.equal(model.looksSecretValue(value), engine.looksSecretValue(value), `value ${JSON.stringify(value)}`);
  for (const name of ['DB_PASSWORD', 'API_KEY', 'AUTH_HEADER', 'PRIVATE_PEM', 'FEATURE_FLAGS', 'SPRING_PROFILES_ACTIVE', 'MONKEY', 'TOKEN_URL', 'HOST']) {
    assert.equal(model.looksSecretName(name), engine.looksSecretName(name), name);
  }
  for (const name of ['FEATURE_FLAGS', 'PATH', 'NODE_ENV', 'GIT_DIR', 'SINGULARITY_FLOW_X', 'lower', 'HTTP_PROXY', 'APP_MODE']) {
    assert.equal(model.declarableVariable(name), declarableEnvironmentVariable(name), name);
  }
  const argumentLists = [
    ['--server.port=8080'], ['--db-password=x'], ['-Dspring.datasource.password=hunter2'], ['--token', 'abc'], ['--token', '--next'],
    [FAKE_SECRETS.highEntropy], ['-Dspring-boot.run.jvmArguments=-Xmx1g -Dapi.key=zz'], ['-Dspring-boot.run.jvmArguments=-Xmx1g -Xms1g'], ['-Xmx1g'], []
  ];
  for (const tokens of argumentLists) {
    const removed = engine.withoutSecretArguments(tokens, new Set(), []).tokens.length !== tokens.length
      || engine.withoutSecretArguments(tokens, new Set(), []).tokens.join('\u0000') !== tokens.join('\u0000');
    assert.equal(model.secretInArguments(tokens) !== null, removed, JSON.stringify(tokens));
  }
  assert.equal(model.secretInArguments(['-Dspring.datasource.password=hunter2']), 'spring.datasource.password', 'the name, never the value');
  assert.equal(model.secretInArguments([FAKE_SECRETS.highEntropy]), 'a value');
});

test('app plan gives the declared block, each environment\'s binding status and the variable names it resolves', () => {
  const { block, facts, capability } = declared();
  assert.equal(capability, 'payments-web');
  assert.equal(block.known, true);
  assert.deepEqual(block.start, [WEB, API]);
  assert.deepEqual(block.tests, TESTS);
  const api = facts.find((item) => item.id === 'api');
  assert.deepEqual(api.environments.map((choice) => [choice.name, choice.status]), [['dev', 'bound'], ['qa', 'unbound']]);
  assert.deepEqual(api.envNames, { dev: ['FEATURE_FLAGS', 'DB_PASSWORD', 'DATABASE_URL'], qa: ['FEATURE_FLAGS', 'DB_PASSWORD'] });
  // Other keys of the block are kept, and an envelope is read too.
  assert.deepEqual(declared({ resultType: 'command-result', data: plan({ start: [WEB], tests: TESTS, future: { keep: true } }) }).block.other, { future: { keep: true } });
  // An engine without `application`: the entries are rebuilt to look at, but the draft cannot be saved.
  const older = { ...plan(), application: undefined };
  const rebuilt = declared(older);
  assert.equal(rebuilt.block.known, false);
  assert.deepEqual(rebuilt.block.start.map((entry) => entry.id), ['web', 'api']);
  assert.deepEqual(rebuilt.block.start[1].environments, ['dev', 'qa']);
  const draft = model.draftFrom('payments-web', rebuilt.block);
  const { draft: edited } = model.addFromTemplate(draft, 'npm');
  assert.match(model.applyProblem(edited, rebuilt.block, null), /does not report the declared application block in app plan, so writing the whole block could drop its tests/);
});

test('form fields edit Base, or one environment\'s override marked "differs from Base"; Use Base takes it away', () => {
  const { draft, block } = draftOf();
  let api = entryOf(draft, 'api');
  assert.deepEqual(model.differsFromBase(api, 'qa'), ['vmOptions', 'activeProfiles']);
  assert.deepEqual(model.differsFromBase(api, 'dev'), []);
  assert.deepEqual(model.effectiveValue(api, 'qa', 'vmOptions'), ['-Xmx2g']);
  assert.deepEqual(model.effectiveValue(api, 'dev', 'vmOptions'), ['-Xmx1g', '-Dfile.encoding=UTF-8']);

  // Base: one argument per line.
  let result = model.editField(api, 'base', 'programArguments', '--server.port=8081\n\n  --debug  \n');
  assert.equal(result.error, null);
  assert.deepEqual(result.entry.programArguments, ['--server.port=8081', '--debug']);
  // dev: an override; the same value as Base is no override; an emptied list is "none here".
  result = model.editField(api, 'dev', 'mainClass', 'com.example.api.DevMain');
  assert.deepEqual(result.entry.perEnvironment.dev, { mainClass: 'com.example.api.DevMain' });
  assert.deepEqual(model.differsFromBase(result.entry, 'dev'), ['mainClass']);
  assert.equal(model.editField(api, 'dev', 'mainClass', 'com.example.api.ApiApplication').entry.perEnvironment.dev, undefined);
  assert.deepEqual(model.editField(api, 'dev', 'vmOptions', '').entry.perEnvironment.dev, { vmOptions: [] });
  api = model.resetToBase(api, 'qa', 'vmOptions');
  assert.deepEqual(api.perEnvironment, { qa: { activeProfiles: ['qa'] } });
  api = model.resetToBase(api, 'qa', 'activeProfiles');
  assert.equal(api.perEnvironment, undefined, 'no empty override is left behind');
  // Only overridable fields, only the entry's own environments.
  assert.match(model.editField(api, 'qa', 'url', 'http://127.0.0.1:1/').error, /set on Base/);
  assert.match(model.editField(api, 'uat', 'mainClass', 'x.Y').error, /uat is not one of this configuration's environments/);

  // Validation by kind.
  assert.match(model.editField(api, 'base', 'launcher', 'ant').error, /Launcher is one of: maven, gradle/);
  assert.match(model.editField(api, 'base', 'workingDirectory', '../outside').error, /inside the repository/);
  assert.equal(model.editField(api, 'base', 'workingDirectory', '').entry.workingDirectory, undefined, 'empty is the repository root');
  assert.match(model.editField(api, 'base', 'url', 'http://0.0.0.0:8080/').error, /127\.0\.0\.1, localhost or \[::1\]/);
  assert.match(model.editField(api, 'base', 'id', 'web', ['web']).error, /already called web/);
  assert.match(model.editField(api, 'base', 'id', 'Not Kebab').error, /lower-case kebab case/);
  assert.equal(model.editField(api, 'base', 'ready.timeout', '90').entry.ready.timeoutMs, 90000);
  assert.match(model.editField(api, 'base', 'ready.timeout', '700').error, /1 to 600 seconds/);
  assert.deepEqual(model.editField(api, 'base', 'ready.kind', 'log').entry.ready, { log: 'ready', timeoutMs: 180000 });
  assert.match(model.editField(api, 'base', 'ready.value', 'health').error, /starts with a single \//);
  assert.equal(model.editField(api, 'base', 'debug.port', '5006').entry.debug.port, 5006);
  assert.match(model.editField(api, 'base', 'debug.port', '70000').error, /TCP port/);
  assert.equal(model.editField(api, 'base', 'debug.suspend', 'true').entry.debug.suspend, true);
  assert.equal(model.editField(api, 'base', 'debug.enabled', 'false').entry.debug, undefined);
  const node = model.templateEntry('node', { ids: [], names: [] });
  assert.deepEqual(model.editField({ ...node, debug: undefined }, 'base', 'debug.enabled', 'true').entry.debug, { port: 9229 }, 'the runtime follows from the type');
  const command = { ...WEB, environments: ['dev', 'qa'] };
  assert.deepEqual(model.editField(command, 'base', 'debug.enabled', 'true').entry.debug, { runtime: 'node', port: 9229 }, 'a command names its debugger');
  assert.deepEqual(model.editField(command, 'qa', 'appended', '--mode\nqa').entry.arguments, { qa: ['--mode', 'qa'] }, 'a command appends arguments per environment');
  assert.match(model.editField(command, 'base', 'appended', '--x').error, /environment's tab/);
  const python = model.templateEntry('python', { ids: [], names: [] });
  const moduleRun = model.editField(python, 'base', 'module', 'app.main').entry;
  assert.equal(moduleRun.script, undefined, 'a script or a module, never both');
  assert.equal(moduleRun.module, 'app.main');
  assert.equal(model.editField(model.templateEntry('django', { ids: [], names: [] }), 'base', 'port', '8001').entry.port, 8001);
  assert.deepEqual(model.editField(model.templateEntry('maven', { ids: [], names: [] }), 'base', 'properties', 'skipTests=true\n-Dmaven.test.skip=false').entry.properties,
    { skipTests: 'true', 'maven.test.skip': 'false' });

  // Environments: removing one removes its overrides, and says so.
  const narrowed = model.editField(entryOf(draft, 'api'), 'base', 'environments', 'dev');
  assert.deepEqual(narrowed.entry.environments, ['dev']);
  assert.equal(narrowed.entry.perEnvironment, undefined);
  assert.match(narrowed.note, /overrides for qa were removed/);
  assert.match(model.editField(api, 'base', 'environments', 'dev, Dev').error, /not an environment ID/);
  // An npm entry keeps its own arguments list when an environment goes.
  const npm = { ...model.templateEntry('npm', { ids: [], names: [] }), arguments: ['--port=5173'], environments: ['dev', 'qa'] };
  assert.deepEqual(model.editField(npm, 'base', 'environments', 'dev').entry.arguments, ['--port=5173']);
  assert.ok(block.known);
});

test('a secret is refused in every field, named but never repeated, with the env bind guidance; the entry stays as it was', () => {
  const { draft } = draftOf();
  const api = entryOf(draft, 'api');
  const maven = model.templateEntry('maven', { ids: [], names: [] });
  const refusals = [
    model.editField(api, 'qa', 'vmOptions', `-Xmx2g\n-Dspring.datasource.password=${FAKE_SECRETS.dbPassword}`),
    model.editField(api, 'base', 'programArguments', `--token\n${FAKE_SECRETS.argumentToken}`),
    model.editField(api, 'base', 'mainClass', FAKE_SECRETS.jwt),
    model.editField(api, 'base', 'beforeLaunch', `curl -H "Authorization=${FAKE_SECRETS.highEntropy}" http://127.0.0.1/`),
    model.editField(maven, 'base', 'properties', `db.password=${FAKE_SECRETS.dbPassword}`),
    model.editEnv(api, 'base', [{ name: 'FEATURE_FLAGS', value: 'a,b' }, { name: 'DB_PASSWORD', value: FAKE_SECRETS.dbPassword }]),
    model.editEnv(api, 'qa', [{ name: 'CACHE_SEED', value: FAKE_SECRETS.awsSecret }]),
    model.editEnv(api, 'base', [{ name: 'SHARED', value: FAKE_SECRETS.highEntropy }])
  ];
  for (const [index, result] of refusals.entries()) {
    assert.ok(result.error, `refusal ${index}`);
    assert.match(result.error, /looks like a secret, so it was not kept\. Secrets are never typed into VS Code: declare it as a secret in singularity\/environments\.yml/);
    assert.match(result.error, /singularity-flow env bind (?:dev|qa|<ENVIRONMENT>) --stdin/);
    assert.equal(result.entry, index === 4 ? maven : api, 'the entry is untouched');
    for (const secret of Object.values(FAKE_SECRETS)) assert.ok(!result.error.includes(secret), `refusal ${index} repeats a value`);
  }
  assert.match(refusals[1].error, /^token looks like a secret/);
  assert.match(refusals[5].error, /^DB_PASSWORD looks like a secret/);
  assert.equal(refusals[5].refusedName, 'DB_PASSWORD');
  assert.match(refusals[6].error, /env bind qa --stdin/, 'an environment tab names its own environment');
  // Reserved and malformed names, and literal non-secret values that are kept.
  assert.match(model.editEnv(api, 'base', [{ name: 'PATH', value: '/x' }]).error, /PATH is reserved/);
  assert.match(model.editEnv(api, 'base', [{ name: 'NODE_ENV', value: 'dev' }]).error, /NODE_ENV is reserved/);
  assert.match(model.editEnv(api, 'base', [{ name: 'lower', value: 'x' }]).error, /not a variable name/);
  assert.match(model.editEnv(api, 'base', [{ name: 'A', value: '1' }, { name: 'A', value: '2' }]).error, /listed twice/);
  assert.deepEqual(model.editEnv(api, 'base', [{ name: 'FEATURE_FLAGS', value: 'a,b,c' }, { name: '', value: '' }]).entry.env, { FEATURE_FLAGS: 'a,b,c' });
  const qa = model.editEnv(api, 'qa', [{ name: 'FEATURE_FLAGS', value: 'a,b' }, { name: 'QA_ONLY', value: 'yes' }]).entry;
  assert.deepEqual(qa.perEnvironment.qa.env, { QA_ONLY: 'yes' }, 'a variable Base already gives is not repeated as an override');
  assert.deepEqual(model.envRows(qa, 'qa'), [{ name: 'QA_ONLY', value: 'yes' }]);
  assert.deepEqual(model.effectiveValue(qa, 'qa', 'env'), { FEATURE_FLAGS: 'a,b', QA_ONLY: 'yes' });
});

test('the written block keeps every untouched entry and the tests exactly as declared; changed entries take a fixed key order', () => {
  // Declared key order is the person's own: an untouched entry keeps it, byte for byte.
  const shuffled = { ready: WEB.ready, url: WEB.url, id: 'web', argv: WEB.argv, workingDirectory: WEB.workingDirectory };
  const { block } = declared(plan({ start: [shuffled, API], tests: TESTS }));
  let draft = model.draftFrom('payments-web', block);
  assert.equal(model.draftDirty(draft, block), false);
  const api = model.editField(entryOf(draft, 'api'), 'qa', 'vmOptions', '-Xmx3g').entry;
  draft = withEntry(draft, 'api', { ...api, extra: 'kept', name: 'Api' });
  assert.equal(model.draftDirty(draft, block), true);
  const written = model.blockFrom(draft, block);
  assert.deepEqual(Object.keys(written.start[0]), ['ready', 'url', 'id', 'argv', 'workingDirectory'], 'untouched: the declared order');
  assert.deepEqual(Object.keys(written.start[1]), ['id', 'name', 'type', 'launcher', 'mainClass', 'vmOptions', 'programArguments', 'activeProfiles',
    'workingDirectory', 'env', 'beforeLaunch', 'perEnvironment', 'environments', 'url', 'ready', 'debug', 'extra']);
  assert.deepEqual(written.start[1].perEnvironment, { qa: { activeProfiles: ['qa'], vmOptions: ['-Xmx3g'] } });
  assert.deepEqual(written.tests, TESTS);
  const yaml = model.applicationBlockYaml(written);
  assert.match(yaml, /^start:\n  - ready:\n      http: \/\n      timeoutMs: 1000\n    url: http:\/\/127\.0\.0\.1:5173\/\n    id: web\n    argv: \[npm, run, dev\]/);
  assert.match(yaml, /    beforeLaunch:\n      - argv: \[\.\.\/\.\.\/mvnw, -q, compile\]\n/, 'a step list is block style, its argv flow style');
  assert.match(yaml, /    perEnvironment:\n      qa:\n        activeProfiles: \[qa\]\n        vmOptions: \[-Xmx3g\]\n/);
  assert.match(yaml, /tests:\n  - use: module-tests\n  - use: integration-tests\n    environments: \[dev, qa\]\n$/);
  assert.deepEqual(YAML.parse(yaml), JSON.parse(JSON.stringify(written)));
  // Remove, reorder: the block follows; nothing else moves.
  const removed = model.removeConfiguration(draft, draft.configurations[0].key);
  assert.deepEqual(model.blockFrom(removed.draft, block).start.map((entry) => entry.id), ['api']);
  assert.equal(removed.key, removed.draft.configurations[0].key);
  const { draft: grown, key } = model.addFromTemplate(model.draftFrom('payments-web', block), 'npm');
  const moved = model.moveConfiguration(grown, key, 'up');
  assert.deepEqual(moved.configurations.map((item) => item.entry.id), ['web', 'api', 'web-2'],
    'a move stays within the type: the npm entry has no other npm entry above it');
  const commandsFirst = model.moveConfiguration(grown, grown.configurations[0].key, 'down');
  assert.deepEqual(commandsFirst.configurations.map((item) => item.entry.id), ['web', 'api', 'web-2'], 'web (a command) has no command below it');
  const changes = model.draftChanges(removed.draft, block);
  assert.deepEqual(changes, { added: [], changed: ['api'], removed: ['web'], kept: [], reordered: false });
});

test('the review page shows the YAML difference of the whole block and the exact command; no secret is in it', () => {
  const { draft, block } = draftOf();
  const api = model.editField(entryOf(draft, 'api'), 'qa', 'vmOptions', '-Xmx3g').entry;
  const { draft: edited } = model.addFromTemplate(withEntry(draft, 'api', api), 'fastapi');
  const proposal = model.configurationsReviewRequest({ capability: 'payments-web', draft: edited, block, route: { kind: 'proposal', lead: 'https://git.example/lead.git' } });
  assert.equal(proposal.title, 'Propose run configurations for payments-web');
  assert.equal(proposal.confirmLabel, 'Propose these run configurations');
  assert.match(proposal.detail, /Added: api-2\nChanged: api\nRemoved: none\nKept as they are: web\nTests already declared, kept as they are: 2\nProposed to: https:\/\/git\.example\/lead\.git/);
  assert.match(proposal.detail, /\n-         vmOptions: \[-Xmx2g\]\n\+         vmOptions: \[-Xmx3g\]\n/);
  assert.match(proposal.detail, /\n\+   - id: api-2\n\+     name: FastAPI\n\+     type: fastapi\n/);
  assert.match(proposal.detail, /\n    - use: module-tests\n/, 'unchanged lines are kept as context');
  assert.match(proposal.detail, /VS Code runs: singularity-flow capability edit payments-web --lead https:\/\/git\.example\/lead\.git --mode set --application-file "<private temporary file>" --json$/);
  const local = model.configurationsReviewRequest({ capability: 'payments-web', draft: edited, block, route: { kind: 'local' } });
  assert.match(local.detail, /Written to: singularity\/capabilities\.yml in this checkout/);
  assert.match(local.detail, /VS Code runs: singularity-flow capability set payments-web --application-file "<private temporary file>" --json$/);
  assert.deepEqual(model.yamlDiff('a\nb\nc\n', 'a\nc\nd\n'), ['  a', '- b', '  c', '+ d']);
  assert.deepEqual(model.yamlDiff('', 'x\n'), ['+ x']);
  assert.equal(model.applyProblem(edited, block, null), null);
  const twins = withEntry(edited, 'api-2', { ...entryOf(edited, 'api-2'), id: 'api' });
  assert.match(model.applyProblem(twins, block, null), /Two configurations are called api/);
  assert.match(model.applyProblem(edited, block, { valid: false, entries: [], errors: [{ index: 1, environment: null, field: 'mainClass', path: null, message: 'x' }] }),
    /Fix the error the command line preview shows first/);
});

test('app config preview is a read of a private file; its answer gives each environment\'s command line and the located errors', () => {
  assert.deepEqual(model.configPreviewArgv('payments-web', '/tmp/x/application.yml'),
    ['app', 'config', 'preview', '--capability', 'payments-web', '--application-file', '/tmp/x/application.yml', '--json']);
  assert.throws(() => model.configPreviewArgv('Bad ID', 'f'), /Capability is invalid/);
  assert.equal(commandClass(['app', 'config', 'preview', '--capability', 'x', '--application-file', 'f', '--json']), 'read');
  assert.equal(commandClass(['app', 'config', 'apply']), 'mutation', 'anything else under app config stays conservative');
  const preview = model.configPreviewFrom({
    resultType: 'sflow-app-config-preview', capability: 'payments-web', valid: false,
    entries: [
      { index: 0, id: 'web', environments: [], resolved: { argv: ['npm', 'run', 'dev'], envNames: [], beforeLaunch: [] } },
      { index: 1, id: 'api', type: 'spring-boot', environments: [
        { name: 'dev', default: true, resolved: { argv: [...MAVEN_DEV, '--db-password=leaked'], envNames: ['FEATURE_FLAGS', 'DB_PASSWORD', 'bad name'], beforeLaunch: [{ argv: ['../../mvnw', '-q', 'compile'] }] } },
        { name: 'qa', errors: [{ path: 'start[1].perEnvironment.qa.vmOptions[0]', message: 'vmOptions[0] has a control character.' }] }
      ], errors: [{ path: 'start[1].mainClass', code: 'APP_FIELD_INVALID', message: 'mainClass must be a Java class name.' }] }
    ],
    errors: [{ path: 'start[0].ready.timeoutMs', message: 'ready.timeoutMs must be from 1000 to 600000.' }, { message: 'The block names no start entry for qa.' }]
  });
  assert.equal(preview.valid, false);
  assert.deepEqual(preview.entries[0].environments, [{ name: null, default: false, argv: ['npm', 'run', 'dev'], commandLine: 'npm run dev', envNames: [], beforeLaunch: [] }]);
  const dev = preview.entries[1].environments[0];
  assert.equal(dev.commandLine.endsWith('--db-password=[hidden]'), true, 'an argument that looks secret is masked');
  assert.match(dev.commandLine, /"-Dspring-boot\.run\.jvmArguments=-Xmx1g -Dfile\.encoding=UTF-8"/, 'an argument with spaces is quoted');
  assert.deepEqual(dev.envNames, ['FEATURE_FLAGS', 'DB_PASSWORD']);
  assert.deepEqual(dev.beforeLaunch, ['../../mvnw -q compile']);
  assert.deepEqual(preview.errors.map(({ index, environment, field }) => [index, environment, field]),
    [[0, null, 'ready.timeout'], [null, null, null], [1, null, 'mainClass'], [1, 'qa', 'vmOptions']]);
  assert.deepEqual(model.errorLocation('start[3].arguments.qa'), { index: 3, environment: 'qa', field: 'appended' });
  assert.deepEqual(model.errorLocation('start[2].env.FOO'), { index: 2, environment: null, field: 'env' });
  assert.deepEqual(model.errorLocation('start[2].debug.port'), { index: 2, environment: null, field: 'debug.port' });
  assert.deepEqual(model.errorLocation('tests[0].use'), { index: null, environment: null, field: null });
  assert.equal(model.configPreviewFrom({ resultType: 'sflow-app-plan' }), null);
  // A refusal carrying located errors (the CLI exits non-zero for an invalid block).
  const refused = model.previewFromRefusal({ schemaVersion: 1, resultType: 'sflow-refusal-plan', status: 'failed',
    error: { code: 'CAPABILITY_APPLICATION_INVALID', message: 'Invalid block.', details: { errors: [{ path: 'start[1].launcher', message: 'launcher must be maven or gradle.' }] } } });
  assert.deepEqual(refused.errors, [{ index: 1, environment: null, field: 'launcher', path: 'start[1].launcher', message: 'launcher must be maven or gradle.' }]);
  assert.equal(model.previewFromRefusal({ error: { code: 'UNKNOWN_SUBCOMMAND', message: 'Unknown app subcommand' } }), null);
});

test('importing typed IDE run configurations takes the engine\'s drafted entry, never a secret value, and gives it a free ID', () => {
  const typed = { id: 'api', name: 'Api (dev)', type: 'spring-boot', launcher: 'maven', activeProfiles: ['dev'], env: { FEATURE_FLAGS: 'x', SESSION_SEED: FAKE_SECRETS.highEntropy },
    url: 'http://127.0.0.1:8080/', ready: { http: '/actuator/health', timeoutMs: 180000 }, debug: { port: 5005 } };
  const answer = {
    resultType: 'sflow-app-suggestions', capability: 'payments-web',
    suggestions: [
      { source: { kind: 'intellij', file: '.run/Api (dev).run.xml', name: 'Api (dev)' }, start: { id: 'api', type: 'spring-boot' },
        environmentNames: [{ name: 'DB_PASSWORD', kind: 'secret' }, { name: 'SPRING_PROFILES_ACTIVE', kind: 'flag', default: 'dev' }], notes: [] },
      { source: { kind: 'webstorm', file: '.run/web.run.xml', name: 'web' }, start: { id: 'web-dev', type: 'npm', packageManager: 'npm', script: 'dev',
        url: 'http://127.0.0.1:5173/', ready: { http: '/' } }, environmentNames: [], notes: [] },
      { source: { kind: 'vscode', file: '.vscode/launch.json', name: 'Leaky' }, start: { id: 'leaky', type: 'node', script: 'x.js', nodeOptions: [`--auth-token=${FAKE_SECRETS.vscodeToken}`] } },
      { source: { kind: 'detected', name: 'Future' }, start: { id: 'future', type: 'quantum' } }
    ],
    applicationDraft: YAML.stringify({ start: [WEB, typed], tests: TESTS }),
    environmentsDraft: 'environments:\n  dev:\n    requires:\n      - { name: DB_PASSWORD, kind: secret }\n'
  };
  const { candidates, environmentsDraft, capability } = model.importCandidatesFrom(answer);
  assert.equal(capability, 'payments-web');
  assert.match(environmentsDraft, /DB_PASSWORD/);
  assert.deepEqual(candidates.map((candidate) => [candidate.label, candidate.description, candidate.detail, Boolean(candidate.entry)]), [
    ['Api (dev)', 'Spring Boot · IntelliJ IDEA', '.run/Api (dev).run.xml', true],
    ['web', 'npm · WebStorm', '.run/web.run.xml', true],
    ['Leaky', 'Node.js · VS Code launch.json', '.vscode/launch.json', false],
    ['Future', 'Detected from the project files', '', false]
  ]);
  const [api, web, leaky, future] = candidates;
  assert.deepEqual(api.entry.env, { FEATURE_FLAGS: 'x' }, 'the drafted entry, with the secret-looking value dropped');
  assert.deepEqual(api.dropped, ['SESSION_SEED']);
  assert.deepEqual(api.secrets, ['DB_PASSWORD']);
  assert.match(leaky.refusal, /looks like it carries the value of auth-token/);
  assert.match(future.refusal, /type "quantum" is not one VS Code edits/);
  const imported = model.importedEntry(api, ['web', 'api']);
  assert.equal(imported.id, 'api-2');
  assert.equal(imported.type, 'spring-boot');
  assert.equal(model.importedEntry(web, ['web']).name, 'web', 'the IDE\'s name when it differs from the ID');
  for (const secret of Object.values(FAKE_SECRETS)) assert.ok(!JSON.stringify(candidates.map((candidate) => candidate.entry)).includes(secret));
});

test('before-launch steps are argv lines: split at spaces, quoted when needed, never a shell', () => {
  assert.deepEqual(model.argvFromLine('../../mvnw -q  compile'), { argv: ['../../mvnw', '-q', 'compile'] });
  assert.deepEqual(model.argvFromLine('echo "a b" \'c d\' "q\\"x" e\\f'), { argv: ['echo', 'a b', 'c d', 'q"x', 'e\\f'] });
  assert.deepEqual(model.argvFromLine('npm run build -- ""'), { argv: ['npm', 'run', 'build', '--', ''] });
  assert.match(model.argvFromLine('echo "open').error, /double quote is not closed/);
  assert.match(model.argvFromLine('   ').error, /empty/);
  for (const argv of [['a b', 'c'], ['x"y', 'z\\'], ['$HOME', '*.js']]) assert.deepEqual(model.argvFromLine(model.lineFromArgv(argv)), { argv });
  const { draft } = draftOf();
  const api = model.editField(entryOf(draft, 'api'), 'base', 'beforeLaunch', '../../mvnw -q compile\nnpm run "build all"').entry;
  assert.deepEqual(api.beforeLaunch, [{ argv: ['../../mvnw', '-q', 'compile'] }, { argv: ['npm', 'run', 'build all'] }]);
  assert.equal(model.beforeLaunchLines(api, 'qa'), '../../mvnw -q compile\nnpm run "build all"');
  assert.deepEqual(model.editField(api, 'qa', 'beforeLaunch', '').entry.perEnvironment.qa.beforeLaunch, [], 'qa runs no steps');
  assert.match(model.editField(api, 'base', 'beforeLaunch', 'ok\necho "x').error, /step 2: a double quote is not closed/);
});

test('a draft the page kept (webview state) is adopted only for the same block and only when it holds no secret', () => {
  const { draft, block } = draftOf();
  const edited = withEntry(draft, 'api', model.editField(entryOf(draft, 'api'), 'base', 'mainClass', 'com.example.Other').entry);
  const saved = JSON.parse(JSON.stringify(model.savedState(edited, edited.configurations[1].key, 'qa')));
  const adopted = model.adoptSavedState(saved, 'payments-web', block);
  assert.equal(entryOf(adopted.draft, 'api').mainClass, 'com.example.Other');
  assert.equal(adopted.selected, edited.configurations[1].key);
  assert.equal(adopted.tab, 'qa');
  assert.equal(model.adoptSavedState(saved, 'other-capability', block), null);
  const moved = declared(plan({ start: [WEB, { ...API, name: 'Api v2' }], tests: TESTS })).block;
  assert.equal(model.adoptSavedState(saved, 'payments-web', moved), null, 'the declared block changed underneath');
  const leaking = JSON.parse(JSON.stringify(saved));
  leaking.configurations[1].entry.env = { DB_PASSWORD: FAKE_SECRETS.dbPassword };
  assert.equal(model.adoptSavedState(leaking, 'payments-web', block), null);
  assert.equal(model.adoptSavedState({ ...saved, configurations: [{ key: 'x', origin: 0, entry: WEB }] }, 'payments-web', block), null);
});

test('an unsaved draft is carried onto a block that changed underneath it', () => {
  const { block } = draftOf();
  let draft = model.draftFrom('payments-web', block);
  draft = withEntry(draft, 'api', model.editField(entryOf(draft, 'api'), 'base', 'mainClass', 'com.example.Mine').entry);
  ({ draft } = model.addFromTemplate(draft, 'go'));
  // Someone else changed web, added worker and declared another test.
  const theirs = declared(plan({ start: [{ ...WEB, workingDirectory: 'apps/site' }, API, { ...WEB, id: 'worker' }], tests: [...TESTS, { use: 'e2e' }] })).block;
  const rebased = model.rebaseDraft(draft, block, theirs);
  assert.equal(rebased.base, model.blockFingerprint(theirs));
  assert.deepEqual(rebased.configurations.map((item) => [item.entry.id, item.origin]), [['web', 0], ['api', 1], ['server', null], ['worker', 2]]);
  assert.equal(entryOf(rebased, 'web').workingDirectory, 'apps/site', 'an entry not edited here takes the version declared now');
  assert.equal(entryOf(rebased, 'api').mainClass, 'com.example.Mine', 'an edit is kept');
  assert.deepEqual(model.blockFrom(rebased, theirs).tests, [...TESTS, { use: 'e2e' }]);
  // An entry removed here stays removed.
  const removed = model.removeConfiguration(model.draftFrom('payments-web', block), 'c1').draft;
  assert.deepEqual(model.rebaseDraft(removed, block, theirs).configurations.map((item) => item.entry.id), ['api', 'worker']);
});

test('the page: grouped list with type icons, toolbar, tabs with override counts, the form, private variables and the command line', () => {
  const { draft, block } = draftOf();
  const { facts } = declared();
  const apiKey = draft.configurations[1].key;
  const preview = model.configPreviewFrom({ resultType: 'sflow-app-config-preview', entries: [
    { index: 0, environments: [], resolved: { argv: ['npm', 'run', 'dev'] } },
    { index: 1, environments: [{ name: 'dev', resolved: { argv: MAVEN_DEV, envNames: ['FEATURE_FLAGS', 'DB_PASSWORD'], beforeLaunch: [['../../mvnw', '-q', 'compile']] } },
      { name: 'qa', resolved: { argv: ['./mvnw', 'spring-boot:run', '-Dspring-boot.run.profiles=qa'] } }] }] });
  const state = (overrides = {}) => ({
    capability: 'payments-web', loading: false, busy: false, error: null, notice: null, draft, block, facts, selected: apiKey, tab: 'base', refused: null,
    preview, previewState: 'idle', previewNote: null, confirmDiscard: false, stale: false, environmentsDraft: null,
    saved: model.savedState(draft, apiKey, 'base'), ...overrides
  });
  let html = pageModule.runConfigurationsHtml(state());
  assert.match(html, /data-cf-group="spring-boot"><div class="cf-group-head"><svg class="ico cf-glyph"[^]*?<\/svg>Spring Boot<\/div>/);
  assert.match(html, /data-cf-group="command">/);
  assert.ok(html.indexOf('data-cf-group="spring-boot"') < html.indexOf('data-cf-group="command"'), 'groups follow the type order');
  assert.match(html, /class="cf-item selected" data-cf-select="c2" aria-current="true">/);
  for (const action of ['copy', 'remove', 'up', 'down', 'import']) assert.match(html, new RegExp(`data-cf-action="${action}"`));
  assert.equal((html.match(/data-cf-add="/g) ?? []).length, 14, 'Add offers a template per type');
  assert.match(html, /role="tab" class="cf-tab active" data-cf-tab="base" aria-selected="true">Base<\/button><button type="button" role="tab" class="cf-tab" data-cf-tab="dev" aria-selected="false">dev <small class="muted">default<\/small><\/button><button type="button" role="tab" class="cf-tab" data-cf-tab="qa" aria-selected="false">qa <small class="muted">not bound<\/small> <span class="cf-badge" title="2 fields differ from Base">2<\/span>/);
  assert.match(html, /<select data-cf-field="launcher" aria-label="Launcher"><option value="maven" selected>maven<\/option><option value="gradle">gradle<\/option><\/select>/);
  assert.match(html, /<textarea data-cf-field="vmOptions" aria-label="VM options" placeholder="-Xmx1g" rows="3" spellcheck="false">-Xmx1g\n-Dfile\.encoding=UTF-8<\/textarea>/);
  assert.match(html, /data-cf-action="browse" data-cf-field="workingDirectory">/);
  assert.match(html, /<input type="text" data-cf-env-name value="FEATURE_FLAGS"[^>]*><\/td>\s*<td><input type="text" data-cf-env-value value="a,b"/);
  assert.match(html, /<code>DB_PASSWORD<\/code>: <strong>bound privately on this computer<\/strong>/);
  assert.match(html, /<code>singularity-flow env bind dev --stdin<\/code> <button type="button" class="secondary compact-action" data-cf-action="copy-bind" data-cf-environment="dev">Copy<\/button>/);
  assert.match(html, /<textarea data-cf-field="beforeLaunch"[^>]*>\.\.\/\.\.\/mvnw -q compile<\/textarea>/);
  assert.match(html, /data-cf-field="ready\.kind"[^]*data-cf-field="ready\.value"[^]*value="\/actuator\/health"[^]*data-cf-field="ready\.timeout"[^]*value="180"/);
  assert.match(html, /<input type="text" data-cf-field="environments" aria-label="Environments" placeholder="dev, qa" value="dev, qa"/);
  assert.match(html, /Offer Debug \(java\)[^]*data-cf-field="debug\.port"[^]*value="5005"[^]*Wait for the debugger before running/);
  assert.match(html, /<h3>Command line<\/h3>[^]*<tr data-cf-preview-env="dev" class="current"><th>dev <small class="muted">default<\/small><\/th>\s*<td><code class="cf-command-line">\.\/mvnw -q spring-boot:run/);
  assert.match(html, /Variables: FEATURE_FLAGS, DB_PASSWORD <span class="muted">\(values never shown\)<\/span><br>Before launch: <code>\.\.\/\.\.\/mvnw -q compile<\/code>/);
  assert.match(html, /<span class="muted" data-cf-clean>No unsaved changes<\/span>[^]*data-cf-action="apply" disabled>Apply…<\/button>/);
  assert.match(html, /<script type="application\/json" id="cf-saved">\{"v":1,"capability":"payments-web"/);

  // The qa tab: overridden fields are marked, Base-only sections are not offered.
  html = pageModule.runConfigurationsHtml(state({ tab: 'qa' }));
  assert.match(html, /data-cf-key="c2" data-cf-current-tab="qa"/);
  assert.match(html, /<textarea data-cf-field="vmOptions"[^>]*>-Xmx2g<\/textarea>[^]*data-cf-region="note-vmOptions"><span class="cf-differs" data-cf-differs="vmOptions">differs from Base<\/span> <button type="button" class="link" data-cf-action="reset-field" data-cf-field="vmOptions">Use Base<\/button>/);
  assert.match(html, /data-cf-region="note-mainClass"><span class="muted cf-same">same as Base<\/span>/);
  assert.match(html, /Also from Base: <code>FEATURE_FLAGS=a,b<\/code>/);
  assert.match(html, /env bind qa --stdin/);
  assert.doesNotMatch(html, /data-cf-field="url"|data-cf-field="debug\.enabled"/);
  assert.match(html, /<tr data-cf-preview-env="qa" class="current">/);

  // A refusal is said under its field; the engine's errors are located; unsaved changes are marked.
  const dirty = withEntry(draft, 'api', model.editField(entryOf(draft, 'api'), 'base', 'mainClass', 'com.example.Other').entry);
  html = pageModule.runConfigurationsHtml(state({ draft: dirty, refused: { key: apiKey, tab: 'base', field: 'env', message: model.secretRefusal('DB_PASSWORD', 'dev') },
    preview: { valid: false, entries: preview.entries, errors: [{ index: 1, environment: null, field: 'mainClass', path: 'start[1].mainClass', message: 'mainClass is not a class.' }] } }));
  assert.match(html, /data-cf-region="note-env"><span class="cf-field-error" role="alert">[^]*DB_PASSWORD looks like a secret, so it was not kept/);
  assert.match(html, /data-cf-region="note-mainClass"><span class="cf-field-error" role="alert" data-cf-engine-error>[^]*mainClass is not a class\./);
  assert.match(html, /<span class="cf-error-mark" title="1 error" data-cf-errors="1">!<\/span>/);
  assert.match(html, /data-cf-select="c2" aria-current="true">[^]*<span class="cf-modified" title="Unsaved changes" data-cf-modified>●<\/span>/);
  assert.match(html, /<span class="cf-dirty" data-cf-dirty>● Unsaved changes<\/span>[^]*Fix the error the command line preview shows first/);
  // Pending and unavailable previews say so.
  assert.match(pageModule.previewRegionHtml(state({ preview: null, previewState: 'pending' })), /Asking the engine how this configuration runs/);
  assert.match(pageModule.previewRegionHtml(state({ previewState: 'unavailable', previewNote: 'This Singularity Flow has no app config preview.' })), /has no app config preview/);
  // Discard asks once more.
  assert.match(pageModule.statusRegionHtml(state({ draft: dirty, confirmDiscard: true })), /Discard every unsaved change\?[^]*data-cf-action="discard-confirm"/);
  // An empty capability, and the JSON kept for the page escapes markup.
  const empty = model.draftFrom('payments-web', { start: [], tests: null, other: {}, known: true });
  assert.match(pageModule.runConfigurationsHtml(state({ draft: empty, block: { start: [], tests: null, other: {}, known: true }, selected: null, saved: model.savedState(empty, null, 'base') })),
    /No run configurations yet/);
  const tricky = withEntry(draft, 'api', { ...entryOf(draft, 'api'), name: '</script><b>' });
  const trickyHtml = pageModule.runConfigurationsHtml(state({ draft: tricky, saved: model.savedState(tricky, apiKey, 'base') }));
  assert.equal(trickyHtml.includes('</script><b>'), false);
  assert.match(trickyHtml, /\\u003c\/script\\u003e\\u003cb\\u003e/);
  for (const secret of Object.values(FAKE_SECRETS)) assert.ok(!trickyHtml.includes(secret));
  assert.doesNotThrow(() => new Function(pageModule.RUN_CONFIGURATIONS_SCRIPT));
});

test('the Run & test section opens the editor, for the capability and for one start entry', () => {
  const capability = { id: 'payments-web', name: 'Payments web', kind: 'delivery', delivery: true, repository: 'payments-web', repositories: ['payments-web'], children: [] };
  const entries = runAndTest.appPlanFrom(plan()).entries;
  const html = runAndTestHtml(runAndTest.buildRunAndTestView(capability, 'here', { plan: entries, status: [], tests: [], lastRun: null }));
  assert.match(html, /data-rt="configurations" data-rt-capability="payments-web">[^<]*<svg[^]*?<\/svg>Edit configurations…<\/button>/);
  assert.match(html, /data-rt="configurations" data-rt-capability="payments-web" data-rt-entry="api" title="Edit this run configuration">/);
});

test('the sticky footer paints above the sticky configuration list, so a narrow editor never shows one through the other', () => {
  // Seen in a real VS Code with the editor in a narrow split: the list (sticky, z-index 2) slid over
  // the footer's status and Discard / Keep editing / Apply / OK row.
  const style = pageModule.RUN_CONFIGURATIONS_STYLE;
  const layer = (selector) => Number(new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')} \\{[^}]*z-index:(\\d+)`).exec(style)?.[1] ?? 0);
  assert.ok(layer('.cf-side') > 0, 'the list is a sticky layer');
  assert.ok(layer('.cf-footer') > layer('.cf-side'), 'the footer is above it');
  assert.match(style, /\.cf-footer \{[^}]*position:sticky[^}]*background:var\(--vscode-editor-background\)/, 'and opaque');
});

test('in a narrow editor the configuration list stacks above the form instead of sliding over it', () => {
  // Seen in a real VS Code with the editor in a narrow split: the single-column layout kept the list
  // sticky and see-through, so the form's fields and Command line showed through its rows.
  const style = pageModule.RUN_CONFIGURATIONS_STYLE;
  const narrow = style.indexOf('@media (max-width:760px) { .cf-layout { grid-template-columns:1fr; } .cf-side { position:static; }');
  assert.ok(narrow > 0, 'one column: the list scrolls away with the page');
  // The override has the same specificity as the sticky rule, so it must come after it to win.
  assert.ok(narrow > style.indexOf('.cf-side { position:sticky;'), 'and it comes after the sticky rule it overrides');
  assert.match(style, /(?:^|\n)\.cf-side \{[^}]*background:var\(--vscode-editor-background\)/, 'and where it is sticky, it is opaque');
});
