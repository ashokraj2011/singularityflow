import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { FAKE_SECRETS, ideRepository } from './helpers/ide-run-configurations.mjs';

const CLI = path.resolve('bin/singularity-flow.mjs');
const cli = (root, args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', timeout: 60_000 });
const json = (root, args) => {
  const result = cli(root, args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
const byId = (result, id) => {
  const found = result.suggestions.find((suggestion) => suggestion.start.id === id);
  assert.ok(found, `no suggestion '${id}' in ${result.suggestions.map((suggestion) => suggestion.start.id).join(', ')}`);
  return found;
};

/** PyCharm's FastAPI run configuration, as PyCharm Professional writes it. */
const PYCHARM_FASTAPI = `<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="Rates API" type="Python.FastAPI">
    <option name="file" value="$PROJECT_DIR$/services/rates/rates/api.py" />
    <module name="rates" />
    <option name="ENV_FILES" value="" />
    <option name="INTERPRETER_OPTIONS" value="" />
    <option name="PARENT_ENVS" value="true" />
    <envs>
      <env name="PYTHONUNBUFFERED" value="1" />
      <env name="RATES_SOURCE" value="http://127.0.0.1:9100/feed" />
    </envs>
    <option name="SDK_HOME" value="$PROJECT_DIR$/.venv/bin/python" />
    <option name="WORKING_DIRECTORY" value="$PROJECT_DIR$/services/rates" />
    <option name="IS_MODULE_SDK" value="false" />
    <option name="ADD_CONTENT_ROOTS" value="true" />
    <option name="ADD_SOURCE_ROOTS" value="true" />
    <option name="uvicornParameters" value="--reload --host 0.0.0.0 --port 8040 --log-level debug" />
    <option name="launchJavascriptDebuger" value="false" />
    <method v="2" />
  </configuration>
</component>
`;

/** A VS Code launch.json that starts an npm script through runtimeExecutable, with the script's own arguments. */
const CONSOLE_LAUNCH = `{
  "version": "0.2.0",
  "configurations": [
    { "name": "Console", "type": "node", "request": "launch", "cwd": "\${workspaceFolder}", "runtimeExecutable": "npm",
      "runtimeArgs": ["run", "dev", "--", "--port", "4300"] },
  ]
}
`;

const EXTRA = {
  '.run/Rates API.run.xml': PYCHARM_FASTAPI,
  'services/rates/rates/__init__.py': '',
  'services/rates/rates/api.py': 'from fastapi import FastAPI\n\nrates_app = FastAPI(title="rates")\n',
  'apps/console/.vscode/launch.json': CONSOLE_LAUNCH,
  'apps/console/package.json': JSON.stringify({ scripts: { dev: 'vite' } })
};

test('typed sources become typed entries that read back as the person wrote them', async (t) => {
  const { root } = await ideRepository(t, { extra: EXTRA });
  const result = json(root, ['app', 'suggest', '--json']);
  // IntelliJ Spring Boot, one configuration per environment: one spring-boot entry, the qa profile as an override.
  const api = byId(result, 'api');
  assert.deepEqual(api.configuration, {
    id: 'api', name: 'Api', type: 'spring-boot', launcher: 'maven', mainClass: 'com.example.shop.api.ApiApplication',
    vmOptions: ['-Xmx1g', '-Dfile.encoding=UTF-8'], programArguments: ['--server.port=8081', '--feature.flags=a b'], activeProfiles: ['dev'],
    workingDirectory: 'services/api', url: 'http://127.0.0.1:8081/', ready: { http: '/actuator/health', timeoutMs: 180_000 },
    environments: ['dev', 'qa'], perEnvironment: { qa: { activeProfiles: ['qa'] } }, debug: { port: 5005 }
  });
  // IntelliJ Maven and Gradle configurations stay goal and task entries.
  assert.deepEqual(byId(result, 'api-spring-boot-run').configuration, {
    id: 'api-spring-boot-run', name: 'api [spring-boot:run]', type: 'maven', goals: ['spring-boot:run'], profiles: ['local'], properties: { skipTests: 'true' },
    arguments: ['-q'], workingDirectory: 'services/api', url: 'http://127.0.0.1:8081/', ready: { http: '/actuator/health', timeoutMs: 180_000 },
    environments: ['local'], debug: { port: 5005 }
  });
  assert.deepEqual(byId(result, 'web-bootrun').configuration.tasks, ['bootRun']);
  assert.deepEqual(byId(result, 'web-bootrun').configuration.arguments, ['--args=--server.port=8082'], '--debug-jvm is not carried');
  // PyCharm: Python (module), Django server and FastAPI.
  const pricing = byId(result, 'pricing').configuration;
  assert.deepEqual([pricing.type, pricing.module, pricing.interpreter, pricing.parameters],
    ['python', 'uvicorn', '.venv/bin/python', ['app.main:app', '--reload', '--host', '127.0.0.1', '--port', '8000']]);
  const backOffice = byId(result, 'back-office').configuration;
  assert.deepEqual([backOffice.type, backOffice.manage, backOffice.interpreter], ['django', undefined, undefined],
    'the default manage.py, and no interpreter outside the repository');
  const rates = byId(result, 'rates-api');
  assert.equal(rates.source.kind, 'pycharm');
  assert.deepEqual(rates.configuration, {
    id: 'rates-api', name: 'Rates API', type: 'fastapi', app: 'rates.api:rates_app', reload: true, interpreter: '.venv/bin/python',
    parameters: ['--log-level', 'debug'], workingDirectory: 'services/rates', url: 'http://127.0.0.1:8040/', ready: { http: '/', timeoutMs: 60_000 },
    environments: ['local'], debug: { port: 5678 }
  });
  assert.deepEqual(rates.start.argv, ['../../.venv/bin/python', '-m', 'uvicorn', 'rates.api:rates_app', '--host', '127.0.0.1', '--port', '8040', '--reload', '--log-level', 'debug']);
  assert.ok(rates.notes.some((note) => /--host became 127\.0\.0\.1/u.test(note)));
  // WebStorm Node.js and npm; a VS Code npm runtimeExecutable; a VS Code run-script stays a command line.
  assert.deepEqual(byId(result, 'gateway').configuration.script, 'services/gateway/src/server.js');
  assert.deepEqual(byId(result, 'gateway').configuration.nodeOptions, ['--enable-source-maps'], 'its own --inspect is dropped');
  const storefront = byId(result, 'storefront-dev').configuration;
  assert.deepEqual([storefront.type, storefront.script, storefront.arguments, storefront.packageManager], ['npm', 'dev', ['--port', '5174'], undefined]);
  const consoleUi = byId(result, 'console');
  assert.equal(consoleUi.source.kind, 'vscode');
  assert.deepEqual([consoleUi.configuration.type, consoleUi.configuration.packageManager, consoleUi.configuration.script, consoleUi.configuration.arguments],
    ['npm', 'npm', 'dev', ['--port', '4300']]);
  assert.deepEqual(consoleUi.start.argv, ['npm', 'run', 'dev', '--', '--port', '4300']);
  assert.equal(byId(result, 'admin-ui-npm').configuration, undefined, 'npm run-script stays the command line it is');
  // GoLand and Rider / launchSettings.
  assert.deepEqual(byId(result, 'inventory').configuration, {
    id: 'inventory', type: 'go', kind: 'directory', target: 'services/inventory/cmd/inventory', goToolArguments: ['-race'], programArguments: ['-addr', ':9091'],
    workingDirectory: 'services/inventory', url: 'http://127.0.0.1:9091/', ready: { http: '/', timeoutMs: 120_000 }, environments: ['local'], debug: { port: 2345 }
  });
  assert.deepEqual(byId(result, 'billing-http').configuration, {
    id: 'billing-http', name: 'Billing: http', type: 'dotnet', launchProfile: 'http', workingDirectory: 'services/billing', url: 'http://localhost:5080/',
    ready: { http: '/', timeoutMs: 120_000 }, debug: { runtime: 'dotnet' }
  });
  // The draft holds the typed entries; the command-line one stays argv.
  const draft = YAML.parse(result.applicationDraft);
  assert.equal(draft.start.find((entry) => entry.id === 'api').type, 'spring-boot');
  assert.deepEqual(draft.start.find((entry) => entry.id === 'admin-ui-npm').argv, ['npm', 'run-script', 'dev']);
  const text = cli(root, ['app', 'suggest']).stdout;
  assert.match(text, /api \(spring-boot\): \.\.\/\.\.\/mvnw(?:\.cmd)? spring-boot:run/u);
  for (const secret of Object.values(FAKE_SECRETS)) {
    assert.equal(JSON.stringify(result).includes(secret), false, `a secret reached the output: ${secret.slice(0, 4)}…`);
  }
});

test('round trip: each suggested typed entry previews to the command line the IDE configuration implies, and plans the same once written', async (t) => {
  const { root, base } = await ideRepository(t, { extra: EXTRA });
  const result = json(root, ['app', 'suggest', '--json']);
  const file = path.join(base, 'application.yml');
  await writeFile(file, result.applicationDraft);
  const preview = json(root, ['app', 'config', 'preview', '--application-file', file, '--json']);
  assert.equal(preview.valid, true, JSON.stringify(preview.entries.filter((entry) => entry.errors.length)));
  const typed = result.suggestions.filter((suggestion) => suggestion.configuration);
  assert.ok(typed.length >= 15, `${typed.length} typed suggestions`);
  const expected = (suggestion, environment) => [...suggestion.start.argv, ...(environment ? suggestion.start.arguments?.[environment] ?? [] : [])];
  for (const suggestion of typed) {
    const entry = preview.entries.find((candidate) => candidate.id === suggestion.start.id);
    assert.ok(entry, suggestion.start.id);
    for (const environment of entry.environments) {
      assert.deepEqual(environment.resolved.argv, expected(suggestion, environment.name), `${suggestion.start.id} ${environment.name}`);
    }
  }
  // Written through the reviewed local route, app plan resolves the same lines and the same identity preview showed.
  assert.equal(cli(root, ['capability', 'set', 'shop', '--application-file', file]).status, 0);
  const plan = json(root, ['app', 'plan', '--json']);
  for (const suggestion of typed) {
    const planned = plan.entries.find((entry) => entry.id === suggestion.start.id);
    const previewed = preview.entries.find((entry) => entry.id === suggestion.start.id);
    assert.equal(planned.type, suggestion.configuration.type);
    assert.equal(planned.commandSha256, previewed.commandSha256, suggestion.start.id);
    const runs = planned.environments.length ? planned.environments.map((environment) => [environment.name, environment.resolved.argv]) : [[null, planned.resolved.argv]];
    for (const [environment, argv] of runs) assert.deepEqual(argv, expected(suggestion, environment), `${suggestion.start.id} ${environment}`);
  }
  // Suggesting again keeps what is declared: a typed entry already there is not drafted twice.
  const again = json(root, ['app', 'suggest', '--json']);
  assert.ok(byId(again, 'api-2').notes.includes("Already declared as start entry 'api'; the draft keeps that one."));
});
