import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applicationStartCommandSha256, normalizeCapabilityApplication, validateCapabilities } from '../src/capabilities.mjs';
import { recordSha256 } from '../src/records.mjs';
import {
  gradleRunInitScript, resolveStartCommand, resolveStartDebugLaunch, RUN_CONFIGURATION_TYPE_NAMES, runConfigurationErrors,
  startEntryCommandSha256, typedApplication
} from '../src/run-configurations.mjs';

const PATHS = { runInitScript: '/private/app/api.run.init.gradle' };
const DEBUG_PATHS = { gradleInitScript: '/private/app/api.debug.init.gradle', goBinary: '/private/app/api.debug-bin' };
const JDWP = (port = 5005, suspend = 'n') => `-agentlib:jdwp=transport=dt_socket,server=y,suspend=${suspend},address=127.0.0.1:${port}`;
const base = (fields) => ({ id: 'api', url: 'http://127.0.0.1:8080/', ready: { http: '/' }, ...fields });
const typed = (raw, { root = null, platform = 'darwin' } = {}) => {
  const capability = { kind: 'delivery', repository: 'shop', application: { start: [raw] } };
  return typedApplication('shop', capability.application, normalizeCapabilityApplication('shop', capability), { checkoutRoot: root, platform }).start[0];
};
const line = (entry, environment = null) => resolveStartCommand(entry, environment, { paths: PATHS });
const errors = (raw) => runConfigurationErrors(raw, { capabilityId: 'shop' });

/** A checkout with the files resolution looks for: wrappers, builds, a project interpreter, lock files. */
async function checkout(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'sflow-typed-resolution-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries({
    mvnw: '#!/bin/sh\n', 'services/api/pom.xml': '<project/>', 'services/web/build.gradle.kts': 'plugins {}\n', 'services/web/gradlew': '#!/bin/sh\n',
    '.venv/bin/python': '#!/bin/sh\n', 'apps/ui/pnpm-lock.yaml': '', 'apps/ui/package.json': '{}', 'apps/legacy/yarn.lock': '', 'apps/plain/package.json': '{}'
  })) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
  return root;
}

test('every type resolves its fields to the command line it runs, finding wrappers, the interpreter and the package manager', async (t) => {
  const root = await checkout(t);
  const table = [
    ['spring-boot (maven wrapper above the module)', { type: 'spring-boot', mainClass: 'com.example.api.ApiApplication', vmOptions: ['-Xmx1g', '-Dfile.encoding=UTF-8'],
      programArguments: ['--server.port=8080', '--greeting=hello world'], activeProfiles: ['dev', 'local'], workingDirectory: 'services/api' },
    ['../../mvnw', 'spring-boot:run', '-Dspring-boot.run.main-class=com.example.api.ApiApplication', '-Dspring-boot.run.jvmArguments=-Xmx1g -Dfile.encoding=UTF-8',
      '-Dspring-boot.run.arguments=--server.port=8080 "--greeting=hello world"', '-Dspring-boot.run.profiles=dev,local']],
    ['spring-boot (gradle by its build, wrapper beside it)', { type: 'spring-boot', programArguments: ['--server.port=8080'], workingDirectory: 'services/web' },
      ['./gradlew', 'bootRun', '--args=--server.port=8080']],
    ['spring-boot (gradle with VM options: the private init script)', { type: 'spring-boot', launcher: 'gradle', vmOptions: ['-Xmx1g'], activeProfiles: ['qa'], workingDirectory: 'services/web' },
      ['./gradlew', '--init-script', PATHS.runInitScript, 'bootRun']],
    ['spring-boot (no checkout: the defaults)', { type: 'spring-boot' }, ['mvn', 'spring-boot:run'], { root: null }],
    ['jar', { type: 'jar', jar: 'services/api/target/api.jar', vmOptions: ['-Xmx512m'], programArguments: ['--port', '8080'], workingDirectory: 'services/api' },
      ['java', '-Xmx512m', '-jar', 'target/api.jar', '--port', '8080']],
    ['application (maven exec:java)', { type: 'application', mainClass: 'com.example.Main', programArguments: ['--queue', 'orders'], workingDirectory: 'services/api' },
      ['../../mvnw', '-q', 'compile', 'exec:java', '-Dexec.mainClass=com.example.Main', '-Dexec.args=--queue orders']],
    ['application (gradle run)', { type: 'application', launcher: 'gradle-run', mainClass: 'com.example.Main', workingDirectory: 'services/web' },
      ['./gradlew', '--init-script', PATHS.runInitScript, 'run']],
    ['maven goals', { type: 'maven', goals: ['clean', 'spring-boot:run'], profiles: ['local', 'h2'], properties: { skipTests: true, 'app.mode': 'dev' }, arguments: ['-q', '-U'] },
      ['./mvnw', 'clean', 'spring-boot:run', '-Plocal,h2', '-DskipTests=true', '-Dapp.mode=dev', '-q', '-U']],
    ['gradle tasks', { type: 'gradle', tasks: [':web:bootRun'], properties: { profile: 'dev' }, arguments: ['--offline'], workingDirectory: 'services/web' },
      ['./gradlew', ':web:bootRun', '-Pprofile=dev', '--offline']],
    ['python script (.venv above the working directory)', { type: 'python', script: 'services/pricing/app.py', interpreterOptions: ['-X', 'dev'], parameters: ['--port', '8080'], workingDirectory: 'services/pricing' },
      ['../../.venv/bin/python', '-X', 'dev', 'app.py', '--port', '8080']],
    ['python module, interpreter named', { type: 'python', module: 'app.main', interpreter: 'python3.12', workingDirectory: 'services/pricing' }, ['python3.12', '-m', 'app.main']],
    ['python, no project interpreter', { type: 'python', module: 'app.main' }, ['python3', '-m', 'app.main'], { root: null }],
    ['python on Windows, no project interpreter', { type: 'python', module: 'app.main' }, ['python', '-m', 'app.main'], { root: null, platform: 'win32' }],
    ['django', { type: 'django', settings: 'shop.settings.dev', noReload: true, workingDirectory: 'services/shop' },
      ['../../.venv/bin/python', 'manage.py', 'runserver', '127.0.0.1:8080', '--noreload', '--settings=shop.settings.dev']],
    ['django on ::1', { type: 'django', url: 'http://[::1]:8001/', manage: 'manage.py' }, ['.venv/bin/python', 'manage.py', 'runserver', '[::1]:8001']],
    ['fastapi', { type: 'fastapi', app: 'app.main:app', reload: true, parameters: ['--log-level', 'debug'], workingDirectory: 'services/pricing' },
      ['../../.venv/bin/python', '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8080', '--reload', '--log-level', 'debug']],
    ['flask', { type: 'flask', app: 'shop:create_app()', url: 'http://localhost:5000/' },
      ['.venv/bin/python', '-m', 'flask', '--app', 'shop:create_app()', 'run', '--host', 'localhost', '--port', '5000']],
    ['node', { type: 'node', script: 'services/gateway/src/server.js', nodeOptions: ['--enable-source-maps'], applicationParameters: ['--port', '4000'], workingDirectory: 'services/gateway' },
      ['node', '--enable-source-maps', 'src/server.js', '--port', '4000']],
    ['node with a repository interpreter', { type: 'node', script: 'server.js', nodeInterpreter: 'tools/node/bin/node' }, ['tools/node/bin/node', 'server.js']],
    ['npm (no lock file: npm, -- before the script\'s arguments)', { type: 'npm', script: 'dev', arguments: ['--port', '5173'], workingDirectory: 'apps/plain' },
      ['npm', 'run', 'dev', '--', '--port', '5173']],
    ['npm (pnpm-lock.yaml: pnpm passes what follows)', { type: 'npm', script: 'dev', arguments: ['--port', '5173'], workingDirectory: 'apps/ui' },
      ['pnpm', 'run', 'dev', '--port', '5173']],
    ['npm (yarn.lock)', { type: 'npm', script: 'start', workingDirectory: 'apps/legacy' }, ['yarn', 'run', 'start']],
    ['npm (named package manager wins)', { type: 'npm', packageManager: 'npm', script: 'dev', workingDirectory: 'apps/ui' }, ['npm', 'run', 'dev']],
    ['go package', { type: 'go', target: './cmd/api', goToolArguments: ['-race'], programArguments: ['-addr', ':9091'] },
      ['go', 'run', '-race', './cmd/api', '-addr', ':9091']],
    ['go directory', { type: 'go', kind: 'directory', target: 'services/inventory/cmd/inventory', workingDirectory: 'services/inventory' },
      ['go', 'run', './cmd/inventory']],
    ['go file', { type: 'go', kind: 'file', target: 'services/inventory/main.go', workingDirectory: 'services/inventory' }, ['go', 'run', './main.go']],
    ['go, the working directory\'s package by default', { type: 'go' }, ['go', 'run', '.']],
    ['dotnet (project in the working directory)', { type: 'dotnet', project: 'services/billing/Billing.csproj', launchProfile: 'http', workingDirectory: 'services/billing' },
      ['dotnet', 'run', '--launch-profile', 'http']],
    ['dotnet (another project)', { type: 'dotnet', project: 'services/billing/Billing.csproj', configuration: 'Release', arguments: ['--urls', 'http://127.0.0.1:8080'] },
      ['dotnet', 'run', '--project', 'services/billing/Billing.csproj', '-c', 'Release', '--', '--urls', 'http://127.0.0.1:8080']],
    ['command', { argv: ['node', 'server.js', '--port', '8080'] }, ['node', 'server.js', '--port', '8080']]
  ];
  const covered = new Set();
  for (const [label, fields, expected, options = {}] of table) {
    const entry = typed(base(fields), { root: Object.hasOwn(options, 'root') ? options.root : root, platform: options.platform ?? 'darwin' });
    assert.deepEqual(line(entry).argv, expected, label);
    covered.add(entry.type);
  }
  assert.deepEqual([...covered].sort(), [...RUN_CONFIGURATION_TYPE_NAMES].sort(), 'the table covers every type');
});

test('Gradle VM options, profiles and a main class reach the JavaExec task through the private init script only', () => {
  const spring = typed(base({ type: 'spring-boot', launcher: 'gradle', vmOptions: ['-Xmx1g', "-Dquote=it's"], activeProfiles: ['dev'], mainClass: 'com.example.Api' }));
  const resolved = line(spring);
  assert.deepEqual(resolved.files, [{ path: PATHS.runInitScript, content: gradleRunInitScript(['bootRun'], {
    jvmArgs: ['-Xmx1g', "-Dquote=it's", '-Dspring.profiles.active=dev'], mainClass: 'com.example.Api' }) }]);
  assert.match(resolved.files[0].content, /withType\(JavaExec\)\.matching \{ it\.name in \['bootRun'\] \}/u);
  assert.match(resolved.files[0].content, /task\.jvmArgs\('-Xmx1g', '-Dquote=it\\'s', '-Dspring\.profiles\.active=dev'\)/u);
  assert.match(resolved.files[0].content, /task\.mainClass\.set\('com\.example\.Api'\)/u);
  // Nothing to carry, no script.
  assert.deepEqual(line(typed(base({ type: 'spring-boot', launcher: 'gradle' }))).files, []);
  // exec:java runs in Maven's own JVM: the VM options are appended to MAVEN_OPTS for the application only.
  const exec = line(typed(base({ type: 'application', launcher: 'maven-exec', mainClass: 'com.example.Main', vmOptions: ['-Xmx256m', '-Da=b c'] })));
  assert.deepEqual(exec.appendEnv, { MAVEN_OPTS: '-Xmx256m "-Da=b c"' });
  assert.deepEqual(exec.envNames, ['MAVEN_OPTS']);
});

test('precedence: perEnvironment fields replace, env merges by name, beforeLaunch replaces, arguments come last', () => {
  const entry = typed(base({
    type: 'spring-boot', launcher: 'maven', vmOptions: ['-Xmx1g'], activeProfiles: ['dev'], environments: ['dev', 'qa', 'uat'],
    env: { FEATURE_FLAGS: 'a,b', REGION: 'eu' }, beforeLaunch: [{ argv: ['./mvnw', '-q', 'compile'] }],
    perEnvironment: { qa: { activeProfiles: ['qa'], vmOptions: ['-Xmx2g'], env: { REGION: 'us' }, beforeLaunch: [{ argv: ['./seed.sh'], timeoutMs: 5_000 }] } },
    arguments: { qa: ['-Dspring-boot.run.fork=false'], uat: ['-X'] }
  }));
  const dev = line(entry, 'dev');
  const qa = line(entry, 'qa');
  const uat = line(entry, 'uat');
  assert.deepEqual(dev.argv, ['mvn', 'spring-boot:run', '-Dspring-boot.run.jvmArguments=-Xmx1g', '-Dspring-boot.run.profiles=dev']);
  assert.deepEqual(qa.argv, ['mvn', 'spring-boot:run', '-Dspring-boot.run.jvmArguments=-Xmx2g', '-Dspring-boot.run.profiles=qa', '-Dspring-boot.run.fork=false']);
  assert.deepEqual(uat.argv, [...dev.argv, '-X']);
  assert.deepEqual(dev.env, { FEATURE_FLAGS: 'a,b', REGION: 'eu' });
  assert.deepEqual(qa.env, { FEATURE_FLAGS: 'a,b', REGION: 'us' });
  assert.deepEqual(dev.beforeLaunch, [{ argv: ['./mvnw', '-q', 'compile'], workingDirectory: '.', timeoutMs: 600_000 }]);
  assert.deepEqual(qa.beforeLaunch, [{ argv: ['./seed.sh'], workingDirectory: '.', timeoutMs: 5_000 }]);
  assert.deepEqual(qa.envNames, ['FEATURE_FLAGS', 'REGION']);
  // A command entry overrides argv per environment the same way, and keeps arguments last.
  const command = typed(base({ argv: ['node', 'server.js'], environments: ['dev', 'qa'], perEnvironment: { qa: { argv: ['node', 'server.js', '--qa'] } }, arguments: { qa: ['--seed'] } }));
  assert.deepEqual(line(command, 'dev').argv, ['node', 'server.js']);
  assert.deepEqual(line(command, 'qa').argv, ['node', 'server.js', '--qa', '--seed']);
});

test('a plain command entry resolves and is identified exactly as before, with or without a name', () => {
  const raw = base({ argv: ['./mvnw', '-q', 'spring-boot:run'], workingDirectory: 'services/api', environments: ['dev', 'qa'], arguments: { qa: ['-Dspring-boot.run.profiles=qa'] } });
  const plain = typed(raw);
  const capability = { kind: 'delivery', repository: 'shop', application: { start: [raw] } };
  const before = normalizeCapabilityApplication('shop', capability).start[0];
  assert.equal(startEntryCommandSha256(plain), applicationStartCommandSha256(before));
  assert.equal(startEntryCommandSha256(typed({ ...raw, name: 'Api' })), applicationStartCommandSha256(before), 'a name is display only');
  assert.equal(startEntryCommandSha256(typed({ ...raw, type: 'command' })), applicationStartCommandSha256(before));
  assert.equal(plain.type, 'command');
  assert.equal(plain.name, 'api');
  assert.deepEqual(plain.argv, ['./mvnw', '-q', 'spring-boot:run']);
  assert.deepEqual(line(plain, 'qa'), {
    launcher: null, argv: ['./mvnw', '-q', 'spring-boot:run', '-Dspring-boot.run.profiles=qa'], env: {}, appendEnv: {}, envNames: [], beforeLaunch: [], files: [], notes: []
  });
  // The pre-amendment identity, written out.
  const noArguments = typed(base({ argv: ['node', 'server.js'] }));
  assert.equal(startEntryCommandSha256(noArguments), `sha256:${recordSha256({ repository: 'shop', workingDirectory: '.', argv: ['node', 'server.js'], environments: [] })}`);
  assert.equal(noArguments.startsFromArgv, true);
});

test('the command identity covers every resolved field, the variables, the steps and the private files', async (t) => {
  const root = await checkout(t);
  const spring = (extra) => typed(base({ type: 'spring-boot', launcher: 'gradle', workingDirectory: 'services/web', environments: ['dev'], ...extra }), { root });
  const hashes = [
    spring({}), spring({ vmOptions: ['-Xmx1g'] }), spring({ vmOptions: ['-Xmx2g'] }), spring({ activeProfiles: ['dev'] }),
    spring({ env: { FLAG: 'on' } }), spring({ beforeLaunch: [{ argv: ['./gradlew', 'classes'] }] }), spring({ perEnvironment: { dev: { programArguments: ['--x'] } } }),
    spring({ debug: { port: 5006 } })
  ].map(startEntryCommandSha256);
  assert.equal(new Set(hashes).size, hashes.length, 'each change asks for confirmation again');
  assert.equal(startEntryCommandSha256(spring({ vmOptions: ['-Xmx1g'] })), hashes[1], 'and the same entry is the same identity');
  // The private path is a placeholder in the identity, so every worktree of the repository confirms the same one.
  assert.equal(startEntryCommandSha256(spring({ vmOptions: ['-Xmx1g'] })), startEntryCommandSha256(typed(base({
    type: 'spring-boot', launcher: 'gradle', workingDirectory: 'services/web', environments: ['dev'], vmOptions: ['-Xmx1g'] }), { root })));
  // What the checkout provides is part of what runs: without the wrapper the command line, and its identity, differ.
  assert.notEqual(startEntryCommandSha256(typed(base({ type: 'spring-boot', launcher: 'gradle', workingDirectory: 'services/web' }), { root })),
    startEntryCommandSha256(typed(base({ type: 'spring-boot', launcher: 'gradle', workingDirectory: 'services/web' }), { root: null })));
  assert.equal(spring({ vmOptions: ['-Xmx1g'] }).startsFromArgv, false, 'an init script is more than argv: readiness does not smoke-start it');
  assert.equal(spring({}).startsFromArgv, true);
});

test('validation locates every error at its field', () => {
  const located = (raw) => errors(base(raw)).map((problem) => `${problem.field}: ${problem.message}`);
  const has = (raw, pattern) => assert.ok(located(raw).some((entry) => pattern.test(entry)), `${JSON.stringify(raw)} → ${located(raw).join(' | ')}`);
  has({ type: 'tomcat' }, /^type: must be one of: spring-boot, jar, application, maven, gradle, python, django, fastapi, flask, node, npm, go, dotnet, command\./u);
  has({ type: 'jar' }, /^jar: is required for type jar\./u);
  has({ type: 'jar', jar: '../outside.jar' }, /^jar: must be a repository-relative path without '\.\.'\./u);
  has({ type: 'jar', jar: '/opt/app.jar' }, /^jar: must be a repository-relative path/u);
  has({ type: 'spring-boot', argv: ['java'] }, /^argv: belongs to type command; a spring-boot entry is built from its fields/u);
  has({ type: 'spring-boot', goals: ['x'] }, /^: contains field\(s\) type spring-boot does not take: goals\. It takes: launcher, mainClass, vmOptions, programArguments, activeProfiles\./u);
  has({ type: 'spring-boot', launcher: 'ant' }, /^launcher: must be one of: maven, gradle\./u);
  has({ type: 'spring-boot', mainClass: 'not a class' }, /^mainClass: must be a Java class name/u);
  has({ type: 'spring-boot', vmOptions: '-Xmx1g -Dx=y' }, /^vmOptions: must be a list of arguments, not a shell string; no shell runs it\./u);
  has({ type: 'spring-boot', vmOptions: ['ok', 'bad\nline'] }, /^vmOptions: must be a list of at most 64 non-empty strings without control characters\./u);
  has({ type: 'spring-boot', activeProfiles: ['dev qa'] }, /^activeProfiles: must be a list of at most 32 names/u);
  has({ type: 'application' }, /^mainClass: is required unless launcher is gradle-run/u);
  has({ type: 'maven', goals: ['-q'] }, /^goals: must list 1 to 32 goals or tasks, each one word that does not start with -/u);
  has({ type: 'maven', goals: ['package'], properties: { 'bad key': 'x' } }, /^properties: names 'bad key'/u);
  has({ type: 'python' }, /^script: a python entry runs either a script or a module: set exactly one\./u);
  has({ type: 'python', script: 'a.py', module: 'a' }, /^module: a python entry runs either a script or a module/u);
  has({ type: 'python', module: 'app', interpreter: '/usr/local/bin/python3' }, /^interpreter: must name a command on PATH \(such as python3\) or a repository-relative path/u);
  has({ type: 'django', host: '0.0.0.0' }, /^host: must be 127\.0\.0\.1, localhost or ::1: a local run listens on loopback only\./u);
  has({ type: 'django', port: 8001 }, /^port: 8001 is not the url's port 8080; readiness asks the url, so make them one port\./u);
  has({ type: 'fastapi', app: 'main' }, /^app: must be module:attribute, such as app\.main:app\./u);
  has({ type: 'npm', script: '--x' }, /^script: must be one word that does not start with -\./u);
  has({ type: 'npm' }, /^script: is required for type npm\./u);
  has({ type: 'go', kind: 'file' }, /^target: is required for kind file\./u);
  has({ type: 'go', kind: 'directory', target: '../x' }, /^target: must be a repository-relative path without '\.\.' for kind directory\./u);
  has({ type: 'node', script: 'server.js', nodeOptions: ['--inspect=0.0.0.0:9229'] }, /^nodeOptions: --inspect=0\.0\.0\.0:9229 listens on '0\.0\.0\.0'; a debugger listens on 127\.0\.0\.1 only\./u);
  has({ type: 'spring-boot', vmOptions: ['-agentlib:jdwp=transport=dt_socket,server=y,address=*:5005'] }, /^vmOptions: .*listens on '\*'/u);
  has({ type: 'spring-boot', debug: { runtime: 'node' } }, /^debug\.runtime: is java for type spring-boot; leave it out, the type says it\./u);
  has({ type: 'spring-boot', debug: { port: 80 } }, /^debug\.port: must be an integer from 1024 to 65535\./u);
  has({ type: 'dotnet', debug: { port: 5005 } }, /^debug: dotnet has no debugger listener/u);
  has({ type: 'spring-boot', arguments: ['-x'] }, /^arguments: must map an environment to the arguments appended for it\./u);
  has({ type: 'npm', script: 'dev', arguments: { qa: ['-x'] } }, /^arguments\.qa: names an environment the entry does not list/u);
  has({ name: '' }, /^name: must be text of 1 to 128 characters on one line\./u);
  has({ type: 'spring-boot', environments: ['dev'], perEnvironment: { qa: {} } }, /^perEnvironment\.qa: names an environment the entry does not list \(environments: dev\)\./u);
  has({ type: 'spring-boot', environments: ['dev'], perEnvironment: { dev: { url: 'http://127.0.0.1:1/' } } }, /^perEnvironment\.dev: may override only launcher, mainClass, vmOptions, programArguments, activeProfiles, env, beforeLaunch; not url\./u);
  has({ type: 'spring-boot', environments: ['dev'], perEnvironment: { dev: { vmOptions: 'x' } } }, /^perEnvironment\.dev\.vmOptions: must be a list of arguments, not a shell string/u);
  has({ argv: ['node'], environments: ['dev'], perEnvironment: { dev: { argv: [] } } }, /^perEnvironment\.dev\.argv: must be a list of 1 to 256 non-empty strings/u);
  has({ type: 'jar', environments: ['dev', 'qa'], perEnvironment: { dev: { jar: 'a.jar' } } }, /^jar: is required for type jar \(environment qa has none\)\./u);
  has({ beforeLaunch: [{ argv: 'make build' }] }, /^beforeLaunch\[0\]\.argv: must be a list of arguments, not a shell string/u);
  has({ beforeLaunch: [{ argv: ['make'], shell: true }] }, /^beforeLaunch\[0\]: contains unsupported field\(s\): shell\./u);
  has({ beforeLaunch: [{ argv: ['make'], timeoutMs: 1 }] }, /^beforeLaunch\[0\]\.timeoutMs: must be an integer from 1000 to 1800000\./u);
  has({ beforeLaunch: [{ argv: ['make'], workingDirectory: '../up' }] }, /^beforeLaunch\[0\]\.workingDirectory: must be repository-relative/u);
  has({ beforeLaunch: Array.from({ length: 9 }, () => ({ argv: ['x'] })) }, /^beforeLaunch: must be a list of at most 8 steps/u);
  // Several errors are listed together, each at its own field.
  assert.deepEqual(errors(base({ type: 'jar', vmOptions: 'x', launcher: 'maven' })).map((problem) => problem.field), ['', 'vmOptions', 'jar']);
  // A valid typed entry and a valid command entry have no errors.
  assert.deepEqual(errors(base({ type: 'fastapi', app: 'app.main:app', env: { LOG_LEVEL: 'debug', WORKERS: 2, CACHE: true } })), []);
  assert.deepEqual(errors(base({ argv: ['node', 'server.js'] })), []);
});

test('env and argument fields refuse reserved variables and anything that looks like a secret; nothing secret is stored', () => {
  const fields = (raw) => errors(base(raw)).map((problem) => problem.field);
  for (const name of ['PATH', 'HOME', 'NODE_OPTIONS', 'NODE_ENV', 'GIT_DIR', 'LD_PRELOAD', 'DYLD_LIBRARY_PATH', 'HTTPS_PROXY', 'SINGULARITY_FLOW_X', 'lower_case']) {
    assert.deepEqual(fields({ env: { [name]: 'x' } }), [`env.${name}`], name);
  }
  assert.match(errors(base({ env: { PATH: '/bin' } }))[0].message, /reserved names are refused/u);
  const secretWords = /looks like it carries a secret; capabilities\.yml never holds one\. Declare it as a secret in singularity\/environments\.yml, bind it with env bind/u;
  for (const [name, value] of [['DB_PASSWORD', 'x'], ['API_TOKEN', 'abc'], ['STRIPE', 'sk_live_51Habcdefghijklmnop'], ['UPSTREAM', 'https://user:pw@example.test/'],
    ['SESSION', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLWZha2UtMTIz'], ['KEY_ID', 'AKIAIOSFODNN7EXAMPLE']]) {
    const [problem] = errors(base({ env: { [name]: value } }));
    assert.equal(problem.field, `env.${name}`);
    assert.match(problem.message, secretWords);
  }
  assert.deepEqual(fields({ env: { JAVA_TOOL_OPTIONS: '-agentlib:jdwp=transport=dt_socket,server=y,address=0.0.0.0:5005' } }), ['env.JAVA_TOOL_OPTIONS']);
  for (const token of ['-Dspring.datasource.password=Fake-Db-Passw0rd-1729', '--api-key=abc', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLWZha2UtMTIz']) {
    const [problem] = errors(base({ type: 'spring-boot', vmOptions: ['-Xmx1g', token] }));
    assert.equal(problem.field, 'vmOptions[1]', token);
    assert.match(problem.message, secretWords);
  }
  assert.equal(errors(base({ type: 'maven', goals: ['package'], properties: { 'db.password': 'hunter2' } }))[0].field, 'properties');
  assert.equal(errors(base({ beforeLaunch: [{ argv: ['./seed.sh', '--token=abc123'] }] }))[0].field, 'beforeLaunch[0].argv[1]');
  // A reference read from the environment at run time is not the value, and ordinary options are not secrets.
  assert.deepEqual(errors(base({ type: 'spring-boot', vmOptions: ['-Dspring.datasource.password=${DB_PASSWORD}', '-Djavax.net.ssl.keyStore=resources/dev/keystore.jks',
    '-Dfile.encoding=UTF-8'], env: { LOG_LEVEL: 'debug', FEATURE_FLAGS: 'a,b' } })), []);
});

test('capabilities.mjs checks only the shared shape of a typed entry; its own fields are checked where the block is read', () => {
  const map = (entry) => ({ version: 1, capabilities: { shop: { kind: 'delivery', repository: 'shop', application: { start: [entry] } } } });
  // A typed entry's own fields pass the cheap check, so the lifecycle commands never load the typed module.
  assert.doesNotThrow(() => validateCapabilities(map(base({ type: 'spring-boot', vmOptions: ['-Xmx1g'], perEnvironment: {} }))));
  // Its shared fields are still checked there.
  assert.throws(() => validateCapabilities(map(base({ type: 'spring-boot', url: 'http://10.0.0.4:8080/' }))), /must be on the loopback host/u);
  assert.throws(() => validateCapabilities(map({ ...base({ type: 'npm' }), id: 'Bad Id' })), /id must be lower-kebab-case/u);
  // A command entry stays a closed shape, now with the typed-configuration fields every entry may take.
  assert.throws(() => validateCapabilities(map(base({ argv: ['node'], vmOptions: ['-Xmx1g'] }))), /unsupported field\(s\): vmOptions/u);
  assert.doesNotThrow(() => validateCapabilities(map(base({ argv: ['node'], name: 'Web', type: 'command', env: { A: 'b' }, beforeLaunch: [], perEnvironment: {} }))));
  // Read for app and tests commands, a typed entry with an invalid field is refused at its field, naming how many more.
  assert.throws(() => typed(base({ type: 'jar', vmOptions: 'x' })), (error) => error.code === 'CAPABILITY_APPLICATION_INVALID'
    && /^Capability 'shop'\.application start\[0\]\.vmOptions must be a list of arguments, not a shell string; no shell runs it\. \(1 more; app config preview --application-file lists each\)$/u.test(error.message)
    && error.details.errors.length === 2);
});

test('debug injection follows the type: where its VM, interpreter or Node options go', async (t) => {
  const root = await checkout(t);
  const debug = (raw, environment = null, variables = {}) => resolveStartDebugLaunch(typed(base(raw), { root }), environment, {
    paths: PATHS, debugPaths: DEBUG_PATHS, environment: variables, platform: 'darwin' });
  const maven = debug({ type: 'spring-boot', launcher: 'maven', vmOptions: ['-Xmx1g'], workingDirectory: 'services/api', debug: {} });
  assert.equal(maven.launcher, 'maven-spring-boot');
  assert.deepEqual(maven.argv, ['../../mvnw', 'spring-boot:run', `-Dspring-boot.run.jvmArguments=-Xmx1g ${JDWP()}`]);
  assert.equal(maven.runtime, 'java');
  assert.equal(maven.address, '127.0.0.1:5005');
  const gradle = debug({ type: 'spring-boot', launcher: 'gradle', workingDirectory: 'services/web', debug: { port: 5006, suspend: true } });
  assert.deepEqual(gradle.argv, ['./gradlew', '--init-script', PATHS.runInitScript, 'bootRun']);
  assert.deepEqual(gradle.files, [{ path: PATHS.runInitScript, content: gradleRunInitScript(['bootRun'], { jvmArgs: [JDWP(5006, 'y')] }) }]);
  assert.deepEqual(debug({ type: 'jar', jar: 'app.jar', vmOptions: ['-Xmx1g'], debug: {} }).argv, ['java', '-Xmx1g', JDWP(), '-jar', 'app.jar']);
  const exec = debug({ type: 'application', mainClass: 'com.example.Main', vmOptions: ['-Xmx256m'], debug: {} }, null, { MAVEN_OPTS: '-Xmx256m' });
  assert.equal(exec.launcher, 'maven-exec');
  assert.deepEqual(exec.environment, { MAVEN_OPTS: `-Xmx256m ${JDWP()}` });
  assert.deepEqual(exec.environmentNames, ['MAVEN_OPTS']);
  const gradleRun = debug({ type: 'application', launcher: 'gradle-run', workingDirectory: 'services/web', debug: {} });
  assert.deepEqual(gradleRun.argv, ['./gradlew', '--init-script', PATHS.runInitScript, 'run']);
  assert.match(gradleRun.files[0].content, /task\.jvmArgs\('-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127\.0\.0\.1:5005'\)/u);
  // Goal and task entries keep application-debug's launcher rules on their command line.
  assert.deepEqual(debug({ type: 'maven', goals: ['spring-boot:run'], debug: {} }).argv, ['./mvnw', 'spring-boot:run', `-Dspring-boot.run.jvmArguments=${JDWP()}`]);
  assert.deepEqual(debug({ type: 'gradle', tasks: ['bootRun'], workingDirectory: 'services/web', debug: {} }).argv,
    ['./gradlew', '--init-script', DEBUG_PATHS.gradleInitScript, 'bootRun']);
  const listen = ['-m', 'debugpy', '--listen', '127.0.0.1:5678'];
  const python = debug({ type: 'python', module: 'app.main', interpreterOptions: ['-X', 'dev'], workingDirectory: 'services/pricing', debug: {} });
  assert.deepEqual(python.argv, ['../../.venv/bin/python', '-X', 'dev', ...listen, '-m', 'app.main']);
  assert.deepEqual(python.requires, { debugpy: ['../../.venv/bin/python'] }, 'debugpy is checked in the interpreter that runs the application');
  const django = debug({ type: 'django', debug: {} });
  assert.deepEqual(django.argv, ['.venv/bin/python', ...listen, 'manage.py', 'runserver', '127.0.0.1:8080', '--noreload']);
  assert.match(django.notes.join(' '), /--noreload under the debugger/u);
  const fastapi = debug({ type: 'fastapi', app: 'app.main:app', reload: true, debug: { port: 5679 } });
  assert.deepEqual(fastapi.argv, ['.venv/bin/python', '-m', 'debugpy', '--listen', '127.0.0.1:5679', '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8080']);
  assert.match(fastapi.notes.join(' '), /--reload is left off under the debugger/u);
  assert.deepEqual(debug({ type: 'flask', app: 'shop', debug: {} }).argv.slice(0, 7), ['.venv/bin/python', ...listen, '-m', 'flask']);
  assert.deepEqual(debug({ type: 'node', script: 'server.js', nodeOptions: ['--enable-source-maps'], nodeInterpreter: 'node20', debug: { suspend: true } }).argv,
    ['node20', '--inspect-brk=127.0.0.1:9229', '--enable-source-maps', 'server.js']);
  const npm = debug({ type: 'npm', script: 'dev', workingDirectory: 'apps/plain', debug: {} });
  assert.deepEqual([npm.argv, npm.environment], [['npm', 'run', 'dev'], { npm_config_node_options: '--inspect=127.0.0.1:9229' }]);
  assert.throws(() => debug({ type: 'npm', script: 'dev', workingDirectory: 'apps/legacy', debug: {} }), { code: 'APP_DEBUG_LAUNCHER_UNSUPPORTED' });
  const go = debug({ type: 'go', target: './cmd/api', programArguments: ['-addr', ':9091'], debug: {} });
  assert.deepEqual(go.argv, ['dlv', 'debug', './cmd/api', '--headless', '--listen=127.0.0.1:2345', '--api-version=2', '--accept-multiclient', '--continue',
    `--output=${DEBUG_PATHS.goBinary}`, '--', '-addr', ':9091']);
  const dotnet = debug({ type: 'dotnet', debug: {} });
  assert.deepEqual([dotnet.argv, dotnet.port, dotnet.address], [['dotnet', 'run'], null, null]);
  // A debugger already in the fields is refused, and an explicit debug.argv still replaces the injection.
  assert.throws(() => debug({ type: 'spring-boot', vmOptions: [JDWP(5005)], debug: {} }), { code: 'APP_DEBUG_ALREADY_CONFIGURED' });
  assert.deepEqual(debug({ type: 'node', script: 'server.js', debug: { argv: ['node', '--inspect=127.0.0.1:9333', 'server.js'], port: 9333 } }).argv,
    ['node', '--inspect=127.0.0.1:9333', 'server.js']);
  // Per environment: the overrides first, then the injection.
  const perEnvironment = debug({ type: 'spring-boot', launcher: 'maven', environments: ['dev', 'qa'], vmOptions: ['-Xmx1g'], perEnvironment: { qa: { vmOptions: ['-Xmx2g'] } },
    arguments: { qa: ['-Dspring-boot.run.fork=false'] }, debug: {} }, 'qa');
  assert.deepEqual(perEnvironment.argv, ['./mvnw', 'spring-boot:run', `-Dspring-boot.run.jvmArguments=-Xmx2g ${JDWP()}`, '-Dspring-boot.run.fork=false']);
});
