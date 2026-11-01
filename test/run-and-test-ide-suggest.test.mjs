import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { classifyVariable, looksSecretValue, withoutSecretArguments } from '../src/app-suggestions.mjs';
import { parseJsonc, resolveIdePath, splitCommandLine } from '../src/app-suggestion-sources.mjs';
import { normalizeCapabilityApplication } from '../src/capabilities.mjs';
import { FAKE_SECRETS, ideRepository, springBootRun } from './helpers/ide-run-configurations.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

const CLI = path.resolve('bin/singularity-flow.mjs');
const cli = (root, args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', timeout: childTimeout(60_000) });
const suggest = (root) => {
  const result = cli(root, ['app', 'suggest', '--json']);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
const byId = (result, id) => {
  const found = result.suggestions.find((suggestion) => suggestion.start.id === id);
  assert.ok(found, `no suggestion '${id}' in ${result.suggestions.map((suggestion) => suggestion.start.id).join(', ')}`);
  return found;
};

test('IntelliJ: Spring Boot configurations per environment become one Maven entry with arguments per environment', async (t) => {
  const { root } = await ideRepository(t);
  const result = suggest(root);
  assert.equal(result.resultType, 'sflow-app-suggestions');
  assert.equal(result.capability, 'shop');
  const api = byId(result, 'api');
  assert.deepEqual(api.source, { kind: 'intellij', file: '.run/Api (dev).run.xml', name: 'Api (dev)' });
  assert.deepEqual(api.variants.map((variant) => [variant.name, variant.environment]), [['Api (dev)', 'dev'], ['Api (qa)', 'qa']]);
  assert.deepEqual(api.start, {
    id: 'api',
    argv: ['../../mvnw', 'spring-boot:run', '-Dspring-boot.run.main-class=com.example.shop.api.ApiApplication',
      '-Dspring-boot.run.jvmArguments=-Xmx1g -Dfile.encoding=UTF-8', '-Dspring-boot.run.arguments=--server.port=8081 "--feature.flags=a b"'],
    workingDirectory: 'services/api', url: 'http://127.0.0.1:8081/', ready: { http: '/actuator/health', timeoutMs: 180_000 },
    environments: ['dev', 'qa'], arguments: { dev: ['-Dspring-boot.run.profiles=dev'], qa: ['-Dspring-boot.run.profiles=qa'] },
    debug: { runtime: 'java', port: 5005 }
  });
  assert.deepEqual(api.environmentNames.filter((entry) => entry.name !== 'CATALOG_URL'), [
    { name: 'DB_PASSWORD', kind: 'secret' },
    { name: 'SPRING_DATASOURCE_URL', kind: 'flag', default: 'jdbc:postgresql://localhost:5432/shop' },
    { name: 'AWS_ACCESS_KEY_ID', kind: 'secret' },
    { name: 'STORAGE_SIGNING', kind: 'secret' },
    { name: 'SPRING_DATASOURCE_PASSWORD', kind: 'secret' }
  ]);
  assert.deepEqual(api.environmentNames.filter((entry) => entry.name === 'CATALOG_URL'), [
    { name: 'CATALOG_URL', kind: 'endpoint', value: 'http://127.0.0.1:9000/dev', environment: 'dev' },
    { name: 'CATALOG_URL', kind: 'endpoint', value: 'http://127.0.0.1:9000/qa', environment: 'qa' }
  ]);
  assert.ok(api.notes.includes('IntelliJ computes the classpath; this runs through the Maven wrapper instead.'));
  assert.ok(api.notes.some((note) => /A secret was removed from the command line.*SPRING_DATASOURCE_PASSWORD/u.test(note)));

  const maven = byId(result, 'api-spring-boot-run');
  assert.deepEqual(maven.start.argv, ['../../mvnw', 'spring-boot:run', '-Plocal', '-DskipTests=true', '-q']);
  assert.deepEqual(maven.environmentNames, [{ name: 'API_TOKEN', kind: 'secret' }, { name: 'LOG_LEVEL', kind: 'flag', default: 'debug' }]);
  assert.ok(maven.notes.some((note) => /Maven VM options run Maven itself/u.test(note)));
  const gradle = byId(result, 'web-bootrun');
  assert.deepEqual(gradle.start.argv, ['./gradlew', 'bootRun', '--args=--server.port=8082']);
  assert.equal(gradle.start.url, 'http://127.0.0.1:8082/');
  assert.equal(gradle.start.ready.http, '/', 'no actuator dependency: readiness asks the root');
  assert.ok(gradle.notes.some((note) => /--debug-jvm was dropped: it binds every interface/u.test(note)));
  const worker = byId(result, 'worker');
  // A typed application entry carries its main class to Gradle's run task through the run's private init script.
  assert.deepEqual(worker.start.argv, ['gradle', '--init-script', worker.start.argv[2], 'run', '--args=--queue orders']);
  assert.match(worker.start.argv[2], /[\\/]singularity-flow[\\/]app[\\/]shop[\\/]worker\.run\.init\.gradle$/u);
  assert.deepEqual(worker.configuration, {
    id: 'worker', name: 'Worker', type: 'application', launcher: 'gradle-run', mainClass: 'com.example.shop.worker.Main',
    programArguments: ['--queue', 'orders'], workingDirectory: 'worker', url: 'http://127.0.0.1:8080/', ready: { http: '/', timeoutMs: 180_000 },
    debug: { port: 5005 }
  });
  assert.equal(worker.start.workingDirectory, 'worker', 'the configuration\'s module directory, found by name');
  assert.ok(worker.notes.some((note) => /own debugger options were dropped/u.test(note)));
  // VS Code's Java configuration takes its Spring profile into the plugin's profiles.
  const catalog = byId(result, 'catalog');
  assert.deepEqual(catalog.source, { kind: 'vscode', file: '.vscode/launch.json', name: 'Catalog (qa)' });
  assert.deepEqual(catalog.start.argv, ['../../mvnw', 'spring-boot:run', '-Dspring-boot.run.main-class=com.example.shop.catalog.CatalogApplication',
    '-Dspring-boot.run.arguments=--server.port=8083', '-Dspring-boot.run.profiles=qa']);
  assert.deepEqual(catalog.start.environments, ['qa']);
});

test('PyCharm, WebStorm, GoLand and Rider configurations translate to terminal launches', async (t) => {
  const { root } = await ideRepository(t);
  const result = suggest(root);
  const pricing = byId(result, 'pricing');
  assert.equal(pricing.source.kind, 'pycharm');
  assert.deepEqual(pricing.start.argv, ['../../.venv/bin/python', '-m', 'uvicorn', 'app.main:app', '--reload', '--host', '127.0.0.1', '--port', '8000']);
  assert.deepEqual(pricing.start.environments, ['dev']);
  assert.deepEqual(pricing.start.debug, { runtime: 'python', port: 5678 });
  assert.deepEqual(pricing.environmentNames, [{ name: 'DATABASE_URL', kind: 'secret' }, { name: 'PRICING_MODE', kind: 'flag', default: 'dev' }]);
  assert.ok(pricing.notes.some((note) => /--host 0\.0\.0\.0 became --host 127\.0\.0\.1/u.test(note)));
  assert.ok(pricing.notes.some((note) => /\.env files are not read/u.test(note)));
  const django = byId(result, 'back-office');
  assert.deepEqual(django.start.argv, ['../../.venv/bin/python', 'manage.py', 'runserver', '127.0.0.1:8001']);
  assert.equal(django.start.url, 'http://127.0.0.1:8001/');
  assert.ok(django.notes.some((note) => /interpreter lies outside the repository and is not copied/u.test(note)));
  assert.ok(django.environmentNames.some((entry) => entry.name === 'SECRET_KEY' && entry.kind === 'secret' && !('default' in entry)));
  const report = byId(result, 'nightly-report');
  assert.deepEqual(report.start.argv, ['.venv/bin/python', '-X', 'dev', 'tools/report.py', '--out', './build/report']);
  assert.ok(report.environmentNames.some((entry) => entry.name === 'TOKEN' && entry.kind === 'secret'));
  assert.ok(report.notes.some((note) => /The URL is a guess/u.test(note)));

  const gateway = byId(result, 'gateway');
  assert.equal(gateway.source.kind, 'webstorm');
  assert.deepEqual(gateway.start.argv, ['node', '--enable-source-maps', 'src/server.js', '--port', '4000']);
  assert.equal(gateway.start.url, 'http://127.0.0.1:4000/');
  assert.deepEqual(gateway.start.debug, { runtime: 'node', port: 9230 }, 'the configuration\'s own inspector port is kept');
  assert.ok(gateway.notes.some((note) => /NODE_ENV is not carried/u.test(note)));
  const storefront = byId(result, 'storefront-dev');
  assert.deepEqual(storefront.start.argv, ['npm', 'run', 'dev', '--', '--port', '5174']);
  assert.equal(storefront.start.url, 'http://localhost:5174/');
  assert.equal(result.suggestions.filter((suggestion) => suggestion.start.workingDirectory === 'apps/storefront').length, 1,
    'the package.json marker of a directory an IDE configuration covers adds nothing');

  const inventory = byId(result, 'inventory');
  assert.equal(inventory.source.kind, 'goland');
  assert.deepEqual(inventory.start.argv, ['go', 'run', '-race', './cmd/inventory', '-addr', ':9091']);
  assert.equal(inventory.start.url, 'http://127.0.0.1:9091/');
  assert.deepEqual(inventory.environmentNames, [{ name: 'INVENTORY_DB_URL', kind: 'secret' }, { name: 'CACHE_TTL', kind: 'flag', default: '30s' }],
    'a URL with userinfo is a secret even without a password');

  const billing = byId(result, 'billing-http');
  assert.equal(billing.source.kind, 'rider');
  assert.deepEqual(billing.start.argv, ['dotnet', 'run', '--launch-profile', 'http']);
  assert.equal(billing.start.url, 'http://localhost:5080/', 'the profile\'s URL comes from launchSettings.json');
  assert.deepEqual(billing.start.debug, { runtime: 'dotnet' });
  assert.ok(billing.notes.some((note) => /Also configured in services\/billing\/Properties\/launchSettings\.json \('http'\)/u.test(note)));
});

test('VS Code launch.json is read with comments and trailing commas; attach and escaping configurations are skipped with a note', async (t) => {
  const { root } = await ideRepository(t);
  const result = suggest(root);
  const search = byId(result, 'search-api');
  assert.deepEqual(search.start.argv, ['../../.venv/bin/python', '-m', 'uvicorn', 'search.main:app', '--port', '8010']);
  assert.equal(search.start.url, 'http://127.0.0.1:8010/');
  const notifier = byId(result, 'notifier');
  assert.deepEqual(notifier.start.argv, ['node', 'services/notifier/index.js', '--port', '4100']);
  assert.deepEqual(notifier.environmentNames, [{ name: 'SMTP_PASSWORD', kind: 'secret' }, { name: 'NOTIFY_FROM', kind: 'flag', default: 'shop@example.test' }]);
  const admin = byId(result, 'admin-ui-npm');
  assert.deepEqual(admin.start.argv, ['npm', 'run-script', 'dev']);
  assert.equal(admin.start.url, 'http://localhost:5175/', 'the port comes from the script the configuration runs');
  const shipping = byId(result, 'shipping');
  assert.deepEqual(shipping.start.argv, ['go', 'run', '-tags', 'dev', '.', '--port', '9092']);
  assert.equal(shipping.start.workingDirectory, 'services/shipping');
  const coreclr = byId(result, 'net-core-launch-web');
  assert.deepEqual(coreclr.start.argv, ['dotnet', 'run']);
  assert.equal(coreclr.start.url, 'http://localhost:5090/');
  assert.deepEqual(result.files.skipped, [
    { file: '.vscode/launch.json', reason: 'configuration \'Attach to Node\' attaches to a running process; nothing to start' },
    { file: '.vscode/launch.json', reason: 'configuration \'Outside\' program points outside the repository' },
    { file: '.vscode/launch.json', reason: 'configuration \'Home\' program uses ${userHome}, which has no meaning outside the IDE' },
    { file: 'services/billing/Properties/launchSettings.json', reason: 'profile \'IIS Express\' runs IISExpress, not the project' }
  ]);
  assert.deepEqual(parseJsonc('{ // c\n "a": "http://x/*y*/", /* b */ "b": [1, 2,], }'), { a: 'http://x/*y*/', b: [1, 2] });
});

test('launchSettings profiles and platform markers fill directories no IDE configuration covers', async (t) => {
  const { root } = await ideRepository(t, { extra: {
    'services/ledger/pom.xml': '<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent><artifactId>ledger</artifactId></project>',
    'services/ledger/src/main/resources/application.yml': 'server:\n  port: ${LEDGER_PORT:8095}\n  servlet:\n    context-path: /ledger\n',
    'services/aggregate/pom.xml': '<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent><packaging>pom</packaging></project>',
    'services/quotes/build.gradle': "plugins {\n  id 'org.springframework.boot' version '3.3.4'\n}\n",
    'services/rates/rates/__init__.py': '',
    'services/rates/rates/api.py': '',
    'services/rates/main.py': 'from fastapi import FastAPI\n\nservice = FastAPI(title="rates")\n',
    'services/wiki/manage.py': 'import django\n',
    'services/tracker/go.mod': 'module example.test/tracker\n',
    'services/tracker/cmd/tracker/main.go': 'package main\nfunc main() {}\n',
    'services/tracker/internal/x.go': 'package internal\n',
    'apps/docs/package.json': JSON.stringify({ scripts: { start: 'next start -p 3100', build: 'next build' } }),
    'services/portal/Portal.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web" />\n',
    'libs/util/package.json': JSON.stringify({ scripts: { build: 'tsc' } })
  } });
  const result = suggest(root);
  const detected = Object.fromEntries(result.suggestions.filter((suggestion) => suggestion.source.kind === 'detected')
    .map((suggestion) => [suggestion.start.id, suggestion.start]));
  assert.deepEqual(detected.ledger.argv, ['../../mvnw', 'spring-boot:run']);
  assert.equal(detected.ledger.url, 'http://127.0.0.1:8095/ledger/');
  assert.equal(detected.ledger.ready.http, '/ledger/');
  assert.deepEqual(detected.quotes.argv, ['gradle', 'bootRun']);
  assert.deepEqual(detected.rates.argv, ['../../.venv/bin/python', '-m', 'uvicorn', 'main:service', '--host', '127.0.0.1', '--port', '8000']);
  assert.deepEqual(detected.wiki.argv, ['../../.venv/bin/python', 'manage.py', 'runserver', '127.0.0.1:8000']);
  assert.deepEqual(detected.tracker.argv, ['go', 'run', './cmd/tracker']);
  assert.equal(detected.tracker.workingDirectory, 'services/tracker');
  assert.deepEqual(detected.docs.argv, ['npm', 'run', 'start']);
  assert.equal(detected.docs.url, 'http://localhost:3100/');
  assert.deepEqual(detected.portal.argv, ['dotnet', 'run']);
  assert.equal(detected.portal.url, 'http://127.0.0.1:5000/');
  assert.equal(detected.aggregate, undefined, 'an aggregator pom runs nothing');
  assert.equal(detected.util, undefined, 'a package with only a build script serves nothing');
  // launchSettings.json profiles are suggested on their own as well (here the http one joined Rider's).
  const https = result.suggestions.find((suggestion) => suggestion.source.kind === 'launch-settings' && suggestion.source.name === 'https');
  assert.deepEqual(https.start.argv, ['dotnet', 'run', '--launch-profile', 'https']);
  assert.equal(https.start.url, 'http://localhost:5080/');
});

test('the output never contains a secret value: not in the JSON, the text, or either draft', async (t) => {
  const { root } = await ideRepository(t);
  const json = cli(root, ['app', 'suggest', '--json']);
  const text = cli(root, ['app', 'suggest']);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(text.status, 0, text.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.ok(parsed.applicationDraft.length > 0 && parsed.environmentsDraft.length > 0);
  // The issued draft's folder is made, since a host's create tool makes no parent folder; the file never is.
  assert.ok((await stat(path.dirname(parsed.draft.applicationFile))).isDirectory());
  await assert.rejects(access(parsed.draft.applicationFile), { code: 'ENOENT' });
  for (const [name, secret] of Object.entries(FAKE_SECRETS)) {
    for (const [surface, output] of [['json', json.stdout], ['text', text.stdout + text.stderr], ['applicationDraft', parsed.applicationDraft],
      ['environmentsDraft', parsed.environmentsDraft]]) {
      assert.equal(output.includes(secret), false, `${name} appears in the ${surface} output`);
      // Not even a long fragment of it.
      assert.equal(output.includes(secret.slice(0, 12)), false, `a fragment of ${name} appears in the ${surface} output`);
    }
  }
  // The last guard never had to replace anything: the readers already dropped every value.
  assert.doesNotMatch(json.stdout, /\[redacted\]/u);
  const environments = YAML.parse(parsed.environmentsDraft);
  for (const requirement of Object.values(environments.environments).flatMap((environment) => environment.requires)) {
    if (requirement.kind === 'secret') assert.deepEqual(Object.keys(requirement).sort(), ['kind', 'name']);
  }
});

test('secret classification: names, JWTs, cloud keys, userinfo URLs and long random tokens are secrets with no value', () => {
  const secrets = new Set();
  const table = [
    ['DB_PASSWORD', 'short', { name: 'DB_PASSWORD', kind: 'secret' }],
    ['GITHUB_TOKEN', 'x', { name: 'GITHUB_TOKEN', kind: 'secret' }],
    ['OAUTH_CLIENT', 'shop', { name: 'OAUTH_CLIENT', kind: 'secret' }],
    ['SIGNING', FAKE_SECRETS.jwt, { name: 'SIGNING', kind: 'secret' }],
    ['CLOUD_ID', FAKE_SECRETS.awsKey, { name: 'CLOUD_ID', kind: 'secret' }],
    ['STORE', FAKE_SECRETS.awsSecret, { name: 'STORE', kind: 'secret' }],
    ['DATABASE_URL', 'postgres://app:pw@db/app', { name: 'DATABASE_URL', kind: 'secret' }],
    ['WEBHOOK', 'https://hooks.example.test/x?sig=abc', { name: 'WEBHOOK', kind: 'secret' }],
    ['RANDOM', FAKE_SECRETS.highEntropy, { name: 'RANDOM', kind: 'secret' }],
    ['HEX', 'a3f5c8e1b9d7024f6a8c3e5b7d9f1a2c', { name: 'HEX', kind: 'secret' }],
    ['API_BASE', 'http://127.0.0.1:8080/api', { name: 'API_BASE', kind: 'endpoint', value: 'http://127.0.0.1:8080/api' }],
    ['MAIN_CLASS', 'com.example.shop.api.ApiApplication', { name: 'MAIN_CLASS', kind: 'flag', default: 'com.example.shop.api.ApiApplication' }],
    ['LOG_DIR', '/var/log/shop/api-service', { name: 'LOG_DIR', kind: 'flag', default: '/var/log/shop/api-service' }],
    ['SPRING_PROFILES_ACTIVE', 'dev', { name: 'SPRING_PROFILES_ACTIVE', kind: 'flag', default: 'dev' }],
    ['QUERY', 'https://x.example.test/a?page=2', { name: 'QUERY', kind: 'flag', default: 'https://x.example.test/a?page=2' }],
    ['FROM_SHELL', '${env:FROM_SHELL}', { name: 'FROM_SHELL', kind: 'flag' }]
  ];
  for (const [name, value, expected] of table) {
    assert.deepEqual(classifyVariable(name, value, { reference: value.startsWith('${env:') }, secrets), expected, name);
  }
  assert.equal(looksSecretValue('com.example.shop.ApiApplication2Main'), false);
  assert.equal(looksSecretValue('-----BEGIN RSA PRIVATE KEY-----\nabc'), true);
  const notes = [];
  const scrubbed = withoutSecretArguments(['--server.port=8081', '--db.password=hunter22', '--api-token', 'tok-12345', '--verbose',
    '-Dspring-boot.run.jvmArguments=-Xmx1g -Dspring.datasource.password=pw-123456 -Dx=1', `--header=${FAKE_SECRETS.jwt}`,
    'postgres://user:pass@db/x', FAKE_SECRETS.highEntropy], secrets, notes);
  assert.deepEqual(scrubbed.tokens, ['--server.port=8081', '--verbose', '-Dspring-boot.run.jvmArguments=-Xmx1g -Dx=1']);
  assert.deepEqual(scrubbed.secretNames, ['DB_PASSWORD', 'API_TOKEN', 'SPRING_DATASOURCE_PASSWORD', 'HEADER']);
  assert.equal(notes.length, 1);
  for (const value of ['hunter22', 'tok-12345', 'pw-123456', FAKE_SECRETS.jwt, FAKE_SECRETS.highEntropy]) assert.ok(secrets.has(value));
  assert.deepEqual(splitCommandLine('-Xmx1g "-Dname=a b" \'c d\' e\\"f'), ['-Xmx1g', '-Dname=a b', 'c d', 'e"f']);
});

test('without declared environments, per-environment variants stay separate entries and the note says what to declare', async (t) => {
  const { root } = await ideRepository(t, { environments: null });
  const result = suggest(root);
  const api = result.suggestions.filter((suggestion) => suggestion.start.workingDirectory === 'services/api' && suggestion.source.name.startsWith('Api ('));
  assert.deepEqual(api.map((suggestion) => suggestion.start.id), ['api-dev', 'api-qa']);
  assert.deepEqual(api.map((suggestion) => suggestion.start.environments), [['dev'], ['qa']]);
  assert.deepEqual(api[0].start.arguments, {});
  assert.ok(api[0].start.argv.includes('-Dspring-boot.run.profiles=dev'));
  const environments = YAML.parse(result.environmentsDraft);
  assert.equal(environments.schemaVersion, 1, 'a repository without environments.yml gets a whole file');
  assert.ok(environments.environments.dev && environments.environments.qa);
});

test('malformed, oversized, linked, unknown and escaping configurations are skipped with a note; nothing else breaks', async (t) => {
  const { root } = await ideRepository(t, { extra: {
    '.run/Broken.run.xml': '<component name="ProjectRunConfigurationManager"><configuration name="x" type="Application"><option name="A" value="1"></component>',
    '.run/Entity.run.xml': '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><component/>',
    '.run/Huge.run.xml': `<component>${' '.repeat(300 * 1024)}</component>`,
    '.run/Docker.run.xml': '<component name="ProjectRunConfigurationManager"><configuration name="Compose" type="docker-deploy" factoryName="docker-compose.yml" /></component>',
    '.run/Escape.run.xml': springBootRun('Escape', 'dev').replace('$PROJECT_DIR$/services/api', '$PROJECT_DIR$/../../etc'),
    '.run/Home.run.xml': springBootRun('Home', 'dev').replace('$PROJECT_DIR$/services/api', '$USER_HOME$/work/api'),
    '.run/Template.run.xml': '<component name="ProjectRunConfigurationManager"><configuration default="true" type="Application" factoryName="Application" /></component>',
    'apps/legacy/.vscode/launch.json': '{ "configurations": [ { "name": "x", ',
    'apps/legacy/index.js': ''
  } });
  await writeFile(path.join(root, 'outside.run.xml'), springBootRun('Linked', 'dev'));
  await symlink(path.join(root, 'outside.run.xml'), path.join(root, '.run', 'Linked.run.xml'));
  const result = suggest(root);
  const reasons = Object.fromEntries(result.files.skipped.filter((entry) => !entry.file.startsWith('.vscode/') && !entry.file.startsWith('services/'))
    .map((entry) => [entry.file, entry.reason]));
  assert.match(reasons['.run/Broken.run.xml'], /not a readable run configuration/u);
  assert.match(reasons['.run/Entity.run.xml'], /DOCTYPE and entity declarations are forbidden/u);
  assert.equal(reasons['.run/Huge.run.xml'], 'larger than 256 KiB');
  assert.match(reasons['.run/Docker.run.xml'], /type docker-deploy, which app suggest does not translate/u);
  assert.equal(reasons['.run/Escape.run.xml'], "configuration 'Escape' working directory points outside the repository");
  assert.equal(reasons['.run/Home.run.xml'], "configuration 'Home' working directory uses $USER_HOME$, which has no meaning outside the IDE");
  assert.equal(reasons['.run/Linked.run.xml'], 'not a regular file (symbolic links are not followed)');
  assert.match(reasons['apps/legacy/.vscode/launch.json'], /not valid JSON with comments/u);
  assert.equal(Object.hasOwn(reasons, '.run/Template.run.xml'), false, 'IDE templates are not configurations');
  assert.ok(byId(result, 'api'), 'the readable configurations are still suggested');
  assert.equal(result.suggestions.some((suggestion) => /Escape|Home|Linked/u.test(suggestion.source.name)), false);
  assert.deepEqual(resolveIdePath('/repo', '$PROJECT_DIR$/../x', { '$PROJECT_DIR$': '/repo' }, '/repo'), { refused: 'points outside the repository' });
  assert.deepEqual(resolveIdePath('/repo', '${workspaceFolder}/a', { '${workspaceFolder}': '/repo' }, '/repo'), { absolute: '/repo/a' });
});

test('a capability that owns part of the repository gets the entries inside its source roots, and its draft keeps what it has', async (t) => {
  const { root } = await ideRepository(t, { capability: { yaml: [
    '    sourceRoots: [services/api]',
    '    application:',
    '      start:',
    '        - id: existing',
    '          argv: [../../mvnw, spring-boot:run, -Plocal, -DskipTests=true, -q]',
    '          workingDirectory: services/api',
    '          url: http://127.0.0.1:8081/',
    '          ready: { http: /actuator/health }',
    '      tests:',
    '        - use: module-tests',
    ''].join('\n') } });
  const result = suggest(root);
  assert.ok(result.suggestions.every((suggestion) => suggestion.start.workingDirectory === 'services/api' || suggestion.start.workingDirectory === '.'));
  assert.ok(result.notes.some((note) => /run outside this capability's source roots and were left out/u.test(note)));
  const maven = result.suggestions.find((suggestion) => suggestion.source.name === 'api [spring-boot:run]');
  assert.ok(maven.notes.includes("Already declared as start entry 'existing'; the draft keeps that one."));
  const draft = YAML.parse(result.applicationDraft);
  assert.equal(draft.start[0].id, 'existing');
  assert.deepEqual(draft.tests, [{ use: 'module-tests' }]);
  assert.equal(draft.start.filter((entry) => entry.workingDirectory === 'services/api').length, 2, 'the existing entry and the grouped Api one');
  normalizeCapabilityApplication('shop', { kind: 'delivery', repository: 'shop', application: draft });
});

test('the draft round-trips: capability set --application-file writes it, validated, and app plan reads it back', async (t) => {
  const { root, base } = await ideRepository(t);
  const result = suggest(root);
  const draftFile = path.join(base, 'application.yml');
  await writeFile(draftFile, result.applicationDraft);
  const before = await readFile(path.join(root, 'singularity', 'capabilities.yml'), 'utf8');
  // An invalid block is refused before anything is written.
  const invalidFile = path.join(base, 'invalid.yml');
  await writeFile(invalidFile, YAML.stringify({ start: [{ id: 'web', argv: 'npm run dev', url: 'http://127.0.0.1:1/', ready: { http: '/' } }] }));
  const invalid = cli(root, ['capability', 'set', 'shop', '--application-file', invalidFile]);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /argv must be a list of arguments, not a shell string/u);
  const notYaml = path.join(base, 'list.yml');
  await writeFile(notYaml, '- a\n- b\n');
  assert.match(cli(root, ['capability', 'set', 'shop', '--application-file', notYaml]).stderr, /must hold the application block.*Nothing was written/su);
  assert.match(cli(root, ['capability', 'set', 'shop', '--application-file', path.join(base, 'missing.yml')]).stderr, /does not exist\. Nothing was written/u);
  assert.equal(await readFile(path.join(root, 'singularity', 'capabilities.yml'), 'utf8'), before);

  const saved = cli(root, ['capability', 'set', 'shop', '--application-file', draftFile, '--json']);
  assert.equal(saved.status, 0, saved.stderr);
  const map = YAML.parse(await readFile(path.join(root, 'singularity', 'capabilities.yml'), 'utf8'));
  assert.deepEqual(map.capabilities.shop.application, YAML.parse(result.applicationDraft));
  assert.ok((await readFile(path.join(root, 'singularity', 'capabilities.yml'), 'utf8')).startsWith('version: 1\ncapabilities:\n  shop:\n    kind: delivery\n'),
    'the rest of the file keeps its layout');
  const plan = JSON.parse(cli(root, ['app', 'plan', 'api', '--json']).stdout).entries[0];
  assert.deepEqual(plan.environments.map((environment) => environment.argv.at(-1)), ['-Dspring-boot.run.profiles=dev', '-Dspring-boot.run.profiles=qa']);
  assert.equal(plan.debug.launcher, 'maven-spring-boot');
  // A file holding `application:` works too, and an empty FILE removes the block.
  await writeFile(draftFile, YAML.stringify({ application: { start: [YAML.parse(result.applicationDraft).start[0]] } }));
  assert.equal(cli(root, ['capability', 'set', 'shop', '--application-file', draftFile]).status, 0);
  assert.equal(YAML.parse(await readFile(path.join(root, 'singularity', 'capabilities.yml'), 'utf8')).capabilities.shop.application.start.length, 1);
  assert.equal(cli(root, ['capability', 'set', 'shop', '--application-file', '']).status, 0);
  assert.equal(Object.hasOwn(YAML.parse(await readFile(path.join(root, 'singularity', 'capabilities.yml'), 'utf8')).capabilities.shop, 'application'), false);
});
