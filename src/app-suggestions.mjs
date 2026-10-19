/**
 * `app suggest`: start entries drafted from the IDE run configurations people already use, and from
 * the platform's own markers where no IDE configuration covers a directory [RUN amendment §3].
 *
 * A read. IDE-only launches become terminal-runnable build-tool launches with their options carried
 * over; configurations that differ only by environment become one entry with `arguments` per
 * declared environment; variables become environments.yml names. Secret values are never copied:
 * a variable whose name or value looks secret becomes a `secret` name with no value, a secret
 * argument is removed from argv (and named as a secret instead), and before anything is returned
 * every string is checked once more against every secret value seen. Nothing is written.
 */
import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import { APPLICATION_DEBUG_DEFAULT_PORTS, normalizeCapabilityApplication } from './capabilities.mjs';
import { declarableEnvironmentVariable, ENVIRONMENT_IDENTIFIER } from './environment-declaration.mjs';
import { insideRoot, parseJsonc, posixRelative, readRunConfigurationSources, splitCommandLine } from './app-suggestion-sources.mjs';

export const APP_SUGGESTIONS_RESULT = 'sflow-app-suggestions';
const SECRET_NAME = /pass|secret|token|key|credential|private|auth/iu;
const TIMEOUTS = Object.freeze({ java: 180_000, python: 60_000, node: 90_000, go: 120_000, dotnet: 120_000 });
const ENVIRONMENT_SYNONYMS = Object.freeze({
  development: ['dev', 'development'], develop: ['dev'], dev: ['dev', 'development'], local: ['local'], localhost: ['local'], qa: ['qa', 'test'], test: ['test', 'qa'], testing: ['test', 'qa'], uat: ['uat'], staging: ['staging', 'stage'],
  stage: ['stage', 'staging'], preprod: ['preprod', 'staging'], production: ['prod', 'production'], prod: ['prod', 'production'],
  integration: ['int', 'integration'], int: ['int', 'integration'], sit: ['sit'], perf: ['perf']
});
const ENVIRONMENT_VARIABLES = new Set(['SPRING_PROFILES_ACTIVE', 'ASPNETCORE_ENVIRONMENT', 'DOTNET_ENVIRONMENT', 'APP_ENV', 'ENV', 'ENVIRONMENT',
  'FLASK_ENV', 'GO_ENV', 'RAILS_ENV', 'STAGE']);

// ---------------------------------------------------------------------------------------------
// Secrets

function entropy(value) {
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) { const p = count / value.length; bits -= p * Math.log2(p); }
  return bits;
}

/** Whether a value reads like a credential: a JWT, a cloud key, a URL with userinfo, or a long random token. */
export function looksSecretValue(raw) {
  const value = String(raw ?? '').trim();
  if (value.length < 8) return false;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value)) return true;
  if (/(?:^|[^A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u.test(value)) return true;
  if (/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/u.test(value)) return true;
  if (/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bsk_(?:live|test)_[A-Za-z0-9]{10,}|\bAIza[0-9A-Za-z_-]{30,}/u.test(value)) return true;
  if (/[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/iu.test(value)) return true;
  if (/[?&;](?:[^=&\s]*(?:pass|secret|token|key|credential|auth|signature|sig))[^=&\s]*=/iu.test(value)) return true;
  for (const piece of value.split(/[\s,;]+/u)) {
    if (piece.length < 20 || !/^[A-Za-z0-9+/=_\-.~]+$/u.test(piece)) continue;
    // A dotted name such as a Java class (com.example.shop.Api2Main) is an identifier, not a token,
    // and so is an option with a value (-Dfile.encoding=UTF-8); base64 padding only ends a token.
    if (/^(?:[a-z][a-z0-9]*\.)+[A-Za-z_$][\w$]*$/u.test(piece) || /=[^=]/u.test(piece)) continue;
    if (/^[0-9a-f]{32,}$/iu.test(piece)) return true;
    const upper = /[A-Z]/u.test(piece);
    const lower = /[a-z]/u.test(piece);
    const digit = /\d/u.test(piece);
    const score = entropy(piece);
    if ((upper && lower && digit && score >= 3.5) || ((upper || lower) && digit && score >= 4.2)) return true;
  }
  return false;
}

export function looksSecretName(name) {
  return SECRET_NAME.test(String(name ?? ''));
}

/** A variable as environments.yml would declare it: a secret has a name only. */
export function classifyVariable(name, rawValue, { reference = false } = {}, secrets = new Set()) {
  const value = String(rawValue ?? '');
  if (looksSecretName(name) || looksSecretValue(value)) {
    if (value.length >= 4) secrets.add(value);
    return { name, kind: 'secret' };
  }
  if (reference || !value) return { name, kind: 'flag' };
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && value.length <= 2_048) {
      return { name, kind: 'endpoint', value };
    }
  } catch { /* not a URL */ }
  if (value.length > 256 || value.includes('\u0000')) return { name, kind: 'flag' };
  return { name, kind: 'flag', default: value };
}

function environmentNameFor(option) {
  return option.replace(/^-+/u, '').replace(/^D(?=[a-z])/u, '').replace(/[^A-Za-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '').toUpperCase();
}

/**
 * Arguments with every secret part removed. `--name=value` or `-Dname=value` parts whose name or
 * value looks secret go (also inside a property such as `-Dspring-boot.run.jvmArguments=…`), as do
 * `--password VALUE` pairs and bare values that look secret. Each removal is named as a secret.
 */
export function withoutSecretArguments(tokens, secrets, notes) {
  const kept = [];
  const names = [];
  let removed = false;
  const remember = (value, name) => {
    removed = true;
    if (String(value).length >= 4) secrets.add(String(value));
    if (name) names.push(name);
  };
  const scrubPart = (part) => {
    const assignment = part.match(/^(-{0,2}D?)([A-Za-z_][\w.-]*)=(.*)$/su);
    if (assignment && (looksSecretName(assignment[2]) || looksSecretValue(assignment[3]))) {
      remember(assignment[3], environmentNameFor(assignment[2]));
      return null;
    }
    if (!assignment && looksSecretValue(part)) { remember(part, null); return null; }
    return part;
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = String(tokens[index]);
    const flag = token.match(/^--?([A-Za-z][\w.-]*)$/u);
    if (flag && looksSecretName(flag[1]) && index + 1 < tokens.length && !String(tokens[index + 1]).startsWith('-')) {
      remember(tokens[index + 1], environmentNameFor(flag[1]));
      index += 1;
      continue;
    }
    const property = token.match(/^(-D[\w.-]+=|--[\w.-]+=)(.*)$/su);
    if (property && /\s/u.test(property[2])) {
      // A property whose value is itself a command line, such as jvmArguments.
      if (looksSecretName(property[1].replace(/^-D|^--|=$/gu, ''))) { remember(property[2], environmentNameFor(property[1].slice(0, -1))); continue; }
      const parts = property[2].split(/\s+/u).filter(Boolean).map(scrubPart).filter((part) => part != null);
      if (parts.length) kept.push(`${property[1]}${parts.join(' ')}`);
      continue;
    }
    const scrubbed = scrubPart(token);
    if (scrubbed != null) kept.push(scrubbed);
  }
  if (removed) {
    notes.push('A secret was removed from the command line; a value given on argv is visible to every process on the machine.'
      + `${names.length ? ` Bind ${[...new Set(names)].join(', ')} with env bind instead, and read it from the environment.` : ''}`);
  }
  return { tokens: kept, secretNames: [...new Set(names)].filter(declarableEnvironmentVariable) };
}

/** Replace every secret value seen anywhere in a returned structure. A last guard; readers already drop them. */
function scrubDeep(value, secrets) {
  const ordered = [...secrets].filter((secret) => secret.length >= 4).sort((left, right) => right.length - left.length);
  const scrub = (text) => ordered.reduce((current, secret) => current.split(secret).join('[redacted]'), text);
  const walk = (node) => {
    if (typeof node === 'string') return scrub(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, entry]) => [scrub(key), walk(entry)]));
    return node;
  };
  return walk(value);
}

// ---------------------------------------------------------------------------------------------
// Translation helpers

function joinArguments(tokens) {
  return tokens.map((token) => (/[\s"]/u.test(token) ? `"${token.replaceAll('"', '\\"')}"` : token)).join(' ');
}

function relativeExecutable(from, absolute) {
  const relative = posixRelative(from, absolute);
  return relative.includes('/') ? relative : `./${relative}`;
}

function relativeTarget(from, absolute) {
  const relative = posixRelative(from, absolute);
  return relative === '.' ? '.' : relative.startsWith('..') ? relative : `./${relative}`;
}

async function nearestDirectory(context, from, names) {
  let directory = from;
  while (insideRoot(context.root, directory)) {
    for (const name of names) {
      if (await context.reader.exists(path.join(directory, name))) return { directory, name };
    }
    if (directory === context.root) break;
    directory = path.dirname(directory);
  }
  return null;
}

async function readText(context, absolute) {
  const key = absolute;
  if (!context.cache.has(key)) context.cache.set(key, await context.reader.text(absolute, { quiet: true }));
  return context.cache.get(key);
}

function portFromArguments(tokens, names) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = String(tokens[index]);
    for (const name of names) {
      if (token === name && /^(?:[^\s:]*:)?\d{2,5}$/u.test(String(tokens[index + 1] ?? ''))) return Number(String(tokens[index + 1]).split(':').pop());
      if (token.startsWith(`${name}=`)) {
        const value = token.slice(name.length + 1).split(':').pop();
        if (/^\d{2,5}$/u.test(value)) return Number(value);
      }
    }
  }
  return null;
}

function variableValue(variables, name) {
  return variables.find((entry) => entry.name === name)?.value ?? null;
}

function loopbackHostArguments(tokens, notes) {
  const result = [...tokens];
  for (let index = 0; index < result.length; index += 1) {
    for (const flag of ['--host', '--hostname', '-H', '--bind']) {
      if (result[index] === flag && ['0.0.0.0', '::', '*', '[::]'].includes(result[index + 1])) {
        result[index + 1] = '127.0.0.1';
        notes.push(`${flag} 0.0.0.0 became ${flag} 127.0.0.1: a local run listens on loopback only.`);
      } else if (result[index].startsWith(`${flag}=0.0.0.0`)) {
        result[index] = result[index].replace('=0.0.0.0', '=127.0.0.1');
        notes.push(`${flag}=0.0.0.0 became ${flag}=127.0.0.1: a local run listens on loopback only.`);
      }
    }
  }
  return result;
}

function urlFor(port, { host = '127.0.0.1', path: prefix = '/', https = false } = {}) {
  const normalized = `/${String(prefix ?? '').replace(/^\/+|\/+$/gu, '')}`.replace(/\/$/u, '');
  return `${https ? 'https' : 'http'}://${host}:${port}${normalized}/`;
}

function debugFor(platform, port = null) {
  if (platform === 'dotnet') return { runtime: 'dotnet' };
  return { runtime: platform, port: port ?? APPLICATION_DEBUG_DEFAULT_PORTS[platform] };
}

// ---------------------------------------------------------------------------------------------
// Platforms

async function springSettings(context, moduleDirectory, { programArguments = [], vmOptions = [], variables = [] } = {}) {
  let port = portFromArguments(programArguments, ['--server.port']) ?? portFromArguments(vmOptions, ['-Dserver.port'])
    ?? (Number(variableValue(variables, 'SERVER_PORT')) || null);
  let contextPath = '';
  let managementPort = null;
  const resources = path.join(moduleDirectory, 'src', 'main', 'resources');
  const properties = await readText(context, path.join(resources, 'application.properties'));
  const placeholder = (value) => String(value ?? '').trim().replace(/^\$\{[^:}]*:([^}]*)\}$/u, '$1');
  if (properties) {
    for (const line of properties.split(/\r?\n/u)) {
      const match = line.match(/^\s*([\w.-]+)\s*[=:]\s*(.*?)\s*$/u);
      if (!match) continue;
      if (match[1] === 'server.port' && port == null && /^\d+$/u.test(placeholder(match[2]))) port = Number(placeholder(match[2]));
      if (match[1] === 'server.servlet.context-path') contextPath = placeholder(match[2]);
      if (match[1] === 'management.server.port') managementPort = placeholder(match[2]);
    }
  }
  for (const name of ['application.yml', 'application.yaml']) {
    const text = await readText(context, path.join(resources, name));
    if (!text) continue;
    try {
      const document = YAML.parse(text.split(/^---$/mu)[0]) ?? {};
      const value = placeholder(document?.server?.port);
      if (port == null && /^\d+$/u.test(value)) port = Number(value);
      if (document?.server?.servlet?.['context-path']) contextPath = placeholder(document.server.servlet['context-path']);
      if (document?.management?.server?.port != null) managementPort = placeholder(document.management.server.port);
    } catch { /* an unreadable YAML file only loses the guess */ }
  }
  const buildFiles = ['pom.xml', 'build.gradle', 'build.gradle.kts'];
  let actuator = false;
  for (const name of buildFiles) {
    if ((await readText(context, path.join(moduleDirectory, name)))?.includes('spring-boot-starter-actuator')) actuator = true;
  }
  const prefix = contextPath && contextPath !== '/' ? contextPath : '';
  const notes = [];
  if (actuator && managementPort) notes.push('Actuator runs on its own management port, so readiness asks the application root instead.');
  return {
    url: urlFor(port ?? 8080, { path: prefix }),
    ready: { http: actuator && !managementPort ? `${prefix.replace(/\/$/u, '')}/actuator/health` : `${prefix.replace(/\/$/u, '') || ''}/`, timeoutMs: TIMEOUTS.java },
    notes: port == null ? [...notes, 'Port 8080 is Spring Boot\'s default; no server.port was found.'] : notes
  };
}

async function translateJava(context, launch, notes) {
  const tool = async (directory, wrapper, fallback) => {
    const found = await nearestDirectory(context, directory, [wrapper]);
    return found ? relativeExecutable(directory, path.join(found.directory, wrapper)) : fallback;
  };
  if (launch.mode === 'maven') {
    const directory = launch.workingDirectory;
    const argv = [await tool(directory, 'mvnw', 'mvn'), ...launch.goals,
      ...(launch.profiles.length ? [`-P${launch.profiles.join(',')}`] : []),
      ...Object.entries(launch.properties).map(([key, value]) => `-D${key}=${value}`), ...launch.options];
    if (!launch.goals.length) return { refused: 'runs no Maven goal' };
    const spring = launch.goals.some((goal) => /spring-boot(?:-maven-plugin)?(?::[\w.-]+)?:run$/u.test(goal));
    const settings = spring ? await springSettings(context, directory, { variables: launch.variables })
      : { url: urlFor(8080), ready: { http: '/', timeoutMs: TIMEOUTS.java }, notes: ['The URL is a guess; set the port the application serves on.'] };
    notes.push(...settings.notes);
    return { argv, workingDirectory: directory, url: settings.url, ready: settings.ready };
  }
  if (launch.mode === 'gradle') {
    const directory = launch.workingDirectory;
    if (!launch.tasks.length) return { refused: 'runs no Gradle task' };
    const argv = [await tool(directory, 'gradlew', 'gradle'), ...launch.tasks, ...launch.arguments.filter((token) => token !== '--debug-jvm')];
    if (launch.arguments.includes('--debug-jvm')) notes.push('--debug-jvm was dropped: it binds every interface; app start --debug adds a loopback debugger instead.');
    const spring = launch.tasks.some((task) => task.endsWith('bootRun'));
    const passed = launch.arguments.filter((token) => token.startsWith('--args=')).flatMap((token) => splitCommandLine(token.slice('--args='.length)));
    const settings = spring ? await springSettings(context, directory, { programArguments: passed, variables: launch.variables })
      : { url: urlFor(8080), ready: { http: '/', timeoutMs: TIMEOUTS.java }, notes: ['The URL is a guess; set the port the application serves on.'] };
    notes.push(...settings.notes);
    return { argv, workingDirectory: directory, url: settings.url, ready: settings.ready };
  }
  // An IntelliJ Application or Spring Boot configuration: IntelliJ computes the classpath, so the
  // terminal runs the module's own build instead.
  const ide = launch.sourceKind === 'vscode' ? 'VS Code\'s Java extension' : 'IntelliJ';
  const buildNames = ['pom.xml', 'build.gradle.kts', 'build.gradle'];
  // The configuration's module, when a build directory carries its name, else the nearest build.
  const moduleName = String(launch.module ?? '').replace(/\.main$/u, '');
  const moduleBuild = moduleName ? context.markers.find((marker) => buildNames.includes(path.basename(marker))
    && path.basename(path.dirname(marker)) === moduleName) : null;
  const build = moduleBuild ? { directory: path.dirname(moduleBuild), name: path.basename(moduleBuild) }
    : await nearestDirectory(context, launch.workingDirectory, buildNames);
  if (!build) return { refused: `has no Maven or Gradle build to run it from a terminal (${ide} computes its classpath)` };
  const directory = build.directory;
  const maven = build.name === 'pom.xml';
  const buildText = await readText(context, path.join(directory, build.name)) ?? '';
  const spring = launch.mode === 'spring-boot' || /spring-boot/u.test(buildText);
  const debuggerOptions = launch.vmOptions.filter((token) => /^-agentlib:jdwp|^-Xrunjdwp|^-Xdebug$/u.test(token));
  if (debuggerOptions.length) notes.push('The configuration\'s own debugger options were dropped; app start --debug adds a loopback one.');
  const profiles = [...launch.profiles];
  const vm = launch.vmOptions.filter((token) => {
    if (debuggerOptions.includes(token)) return false;
    const profile = token.match(/^-Dspring\.profiles\.active=(.+)$/u);
    if (profile) profiles.push(...profile[1].split(',').filter(Boolean));
    return !profile;
  });
  const programArguments = launch.programArguments;
  let argv;
  if (spring && maven) {
    argv = [await tool(directory, 'mvnw', 'mvn'), 'spring-boot:run',
      ...(launch.mainClass ? [`-Dspring-boot.run.main-class=${launch.mainClass}`] : []),
      ...(vm.length ? [`-Dspring-boot.run.jvmArguments=${joinArguments(vm)}`] : []),
      ...(programArguments.length ? [`-Dspring-boot.run.arguments=${joinArguments(programArguments)}`] : []),
      ...(profiles.length ? [`-Dspring-boot.run.profiles=${profiles.join(',')}`] : [])];
  } else if (spring) {
    const passed = [...programArguments, ...(profiles.length ? [`--spring.profiles.active=${profiles.join(',')}`] : [])];
    argv = [await tool(directory, 'gradlew', 'gradle'), 'bootRun', ...(passed.length ? [`--args=${joinArguments(passed)}`] : [])];
    if (vm.length) notes.push('Gradle\'s bootRun takes JVM options only from the build (bootRun { jvmArgs … }); the configuration\'s VM options are not carried.');
  } else if (maven) {
    if (!launch.mainClass) return { refused: 'names no main class' };
    argv = [await tool(directory, 'mvnw', 'mvn'), '-q', 'compile', 'exec:java', `-Dexec.mainClass=${launch.mainClass}`,
      ...(programArguments.length ? [`-Dexec.args=${joinArguments(programArguments)}`] : [])];
    if (vm.length) notes.push('exec:java runs in Maven\'s own JVM; set the VM options in MAVEN_OPTS.');
  } else {
    argv = [await tool(directory, 'gradlew', 'gradle'), 'run', ...(programArguments.length ? [`--args=${joinArguments(programArguments)}`] : [])];
    notes.push(`gradle run needs the application plugin with mainClass ${launch.mainClass ?? 'set'}.`);
    if (vm.length) notes.push('Gradle\'s run task takes JVM options only from the build; the configuration\'s VM options are not carried.');
  }
  const wrapper = /mvnw|gradlew/u.test(argv[0]);
  notes.unshift(`${ide} computes the classpath; this runs through ${wrapper ? `the ${maven ? 'Maven' : 'Gradle'} wrapper` : maven ? 'Maven' : 'Gradle'} instead.`);
  if (path.resolve(launch.workingDirectory) !== path.resolve(directory)) {
    notes.push(`It runs in the module directory ${posixRelative(context.root, directory)}, not the configuration's working directory.`);
  }
  const settings = spring ? await springSettings(context, directory, { programArguments, vmOptions: vm, variables: launch.variables })
    : { url: urlFor(8080), ready: { http: '/', timeoutMs: TIMEOUTS.java }, notes: ['The URL is a guess; set the port the application serves on.'] };
  notes.push(...settings.notes);
  return { argv, workingDirectory: directory, url: settings.url, ready: settings.ready };
}

async function pythonInterpreter(context, launch, directory, notes) {
  if (launch.interpreter) return relativeExecutable(directory, launch.interpreter);
  for (const base of [directory, context.root]) {
    for (const candidate of ['.venv/bin/python', 'venv/bin/python', '.venv/Scripts/python.exe', 'venv/Scripts/python.exe']) {
      if (await context.reader.exists(path.join(base, candidate))) return relativeExecutable(directory, path.join(base, candidate));
    }
  }
  notes.push('No project interpreter was found in the repository, so the entry runs python3; name the project\'s interpreter in argv if it is another.');
  return 'python3';
}

function pythonPort(tokens, module, variables) {
  const port = portFromArguments(tokens, ['--port', '-p', '--server.port', '--bind', '-b']);
  if (port) return port;
  if (Number(variableValue(variables, 'PORT'))) return Number(variableValue(variables, 'PORT'));
  return module === 'flask' ? 5000 : module === 'streamlit' ? 8501 : 8000;
}

async function translatePython(context, launch, notes) {
  const directory = launch.workingDirectory;
  const python = await pythonInterpreter(context, launch, directory, notes);
  if (launch.mode === 'django') {
    const manage = await nearestDirectory(context, directory, ['manage.py']);
    if (!manage) return { refused: 'is a Django server with no manage.py in or above its working directory' };
    if (launch.customCommand) notes.push(`The configuration's custom run command '${launch.customCommand}' was replaced by runserver.`);
    const port = /^\d+$/u.test(launch.port) ? Number(launch.port) : 8000;
    if (['0.0.0.0', '::', '*'].includes(launch.host)) notes.push(`Host ${launch.host} became 127.0.0.1: a local run listens on loopback only.`);
    return {
      argv: [python, ...launch.interpreterOptions, relativeTarget(directory, path.join(manage.directory, 'manage.py')).replace(/^\.\//u, ''), 'runserver',
        `127.0.0.1:${port}`, ...(launch.noReload ? ['--noreload'] : []), ...launch.additional],
      workingDirectory: directory, url: urlFor(port), ready: { http: '/', timeoutMs: TIMEOUTS.python }
    };
  }
  const parameters = loopbackHostArguments(launch.parameters, notes);
  const argv = launch.mode === 'module'
    ? [python, ...launch.interpreterOptions, '-m', launch.module, ...parameters]
    : [python, ...launch.interpreterOptions, posixRelative(directory, launch.script), ...parameters];
  let port = pythonPort(parameters, launch.module, launch.variables ?? []);
  const serves = launch.mode === 'module' ? ['uvicorn', 'flask', 'fastapi', 'hypercorn', 'gunicorn', 'streamlit', 'django'].includes(launch.module)
    : /(?:^|\/)manage\.py$/u.test(launch.script ?? '');
  if (!serves && !portFromArguments(parameters, ['--port', '-p'])) notes.push('The URL is a guess; set the port the application serves on.');
  const runserver = parameters.indexOf('runserver');
  if (runserver !== -1) {
    const address = parameters[runserver + 1] ?? '';
    const match = address.match(/(?:^|:)(\d{2,5})$/u);
    if (match) port = Number(match[1]);
  }
  return { argv, workingDirectory: directory, url: urlFor(port), ready: { http: '/', timeoutMs: TIMEOUTS.python } };
}

const NODE_TOOL_PORTS = [[/\bvite\b|svelte-kit|\bvitest --ui\b/u, 5173], [/\bng serve\b|\bng\s+s\b/u, 4200], [/\bastro\b/u, 4321],
  [/webpack(?:-dev-server| serve)/u, 8080], [/\bnext\b|\bnuxt\b|react-scripts|\bremix\b|\bnest start\b/u, 3000]];

async function nodeSettings(context, directory, scriptText, tokens, variables) {
  const port = portFromArguments([...tokens, ...String(scriptText ?? '').split(/\s+/u)], ['--port', '-p'])
    ?? (Number(variableValue(variables, 'PORT')) || null);
  const tool = NODE_TOOL_PORTS.find(([pattern]) => pattern.test(String(scriptText ?? '')));
  // Dev servers such as Vite bind localhost, which may be ::1 only; the probe resolves it either way.
  const host = tool ? 'localhost' : '127.0.0.1';
  return { url: urlFor(port ?? tool?.[1] ?? 3000, { host }), ready: { http: '/', timeoutMs: TIMEOUTS.node } };
}

async function packageManager(context, directory) {
  for (const [file, manager] of [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['package-lock.json', 'npm']]) {
    if (await nearestDirectory(context, directory, [file])) return manager;
  }
  return 'npm';
}

async function translateNode(context, launch, notes) {
  const directory = launch.workingDirectory;
  if (launch.mode === 'node') {
    const nodeOptions = launch.nodeOptions.filter((token) => !/^--inspect|^--debug/u.test(token));
    let debugPort = null;
    for (const token of launch.nodeOptions) {
      const match = token.match(/^--inspect(?:-brk|-wait)?=(?:[^:]*:)?(\d+)$/u);
      if (match) debugPort = Number(match[1]);
    }
    if (nodeOptions.length !== launch.nodeOptions.length) notes.push('The configuration\'s own --inspect was dropped; app start --debug adds a loopback one.');
    const argv = ['node', ...nodeOptions, posixRelative(directory, launch.script), ...launch.arguments];
    return { argv, workingDirectory: directory, debugPort, ...await nodeSettings(context, directory, '', launch.arguments, launch.variables ?? []) };
  }
  if (launch.mode === 'executable') {
    const command = launch.executableIsPath ? relativeExecutable(directory, launch.executable) : launch.executable;
    let scriptText = launch.arguments.join(' ');
    const runs = launch.arguments.findIndex((token) => token === 'run' || token === 'run-script');
    if (['npm', 'pnpm', 'yarn'].includes(command) && runs !== -1) {
      try { scriptText = JSON.parse(await readText(context, path.join(directory, 'package.json')) ?? '{}')?.scripts?.[launch.arguments[runs + 1]] ?? scriptText; } catch { /* only the guess is lost */ }
    }
    return { argv: [command, ...launch.arguments], workingDirectory: directory, ...await nodeSettings(context, directory, scriptText, launch.arguments, launch.variables ?? []) };
  }
  if (!launch.script && launch.command === 'run') return { refused: 'names no npm script' };
  if (!['run', 'start', 'run-script'].includes(launch.command)) return { refused: `runs npm ${launch.command}, not a script that serves` };
  const manager = ['npm', 'pnpm', 'yarn'].includes(launch.packageManager) ? launch.packageManager : await packageManager(context, directory);
  const script = launch.command === 'start' ? 'start' : launch.script;
  let scriptText = '';
  try { scriptText = JSON.parse(await readText(context, path.join(directory, 'package.json')) ?? '{}')?.scripts?.[script] ?? ''; } catch { /* only the guess is lost */ }
  if (manager === 'yarn') notes.push('app start --debug cannot add a debugger to yarn (it runs on Node itself); switch the entry to npm run or give debug.argv.');
  return {
    argv: [manager, 'run', script, ...launch.arguments], workingDirectory: directory,
    ...await nodeSettings(context, directory, scriptText, launch.arguments, launch.variables ?? [])
  };
}

async function translateGo(context, launch, notes) {
  let directory = launch.workingDirectory;
  if (launch.target.path) {
    const module = await nearestDirectory(context, (await context.reader.isDirectory(launch.target.path)) ? launch.target.path : path.dirname(launch.target.path), ['go.mod', 'go.work']);
    if (module && !insideRoot(module.directory, directory)) {
      directory = module.directory;
      notes.push(`It runs from the Go module at ${posixRelative(context.root, directory)}, where go run can build it.`);
    }
  }
  const target = launch.target.path ? relativeTarget(directory, launch.target.path) : launch.target.package;
  const port = portFromArguments(launch.arguments, ['-port', '--port', '-addr', '--addr', '-listen', '--listen'])
    ?? (Number(variableValue(launch.variables ?? [], 'PORT')) || 8080);
  return {
    argv: ['go', 'run', ...launch.goFlags, target, ...launch.arguments], workingDirectory: directory,
    url: urlFor(port), ready: { http: '/', timeoutMs: TIMEOUTS.go }
  };
}

function dotnetUrl(applicationUrl, variables, tokens) {
  const candidates = String(applicationUrl ?? variableValue(variables, 'ASPNETCORE_URLS') ?? '').split(/[;,]/u).map((entry) => entry.trim()).filter(Boolean);
  const urlsArgument = tokens.indexOf('--urls');
  if (urlsArgument !== -1 && tokens[urlsArgument + 1]) candidates.unshift(...tokens[urlsArgument + 1].split(/[;,]/u));
  const parsed = candidates.map((entry) => entry.replace(/^(https?:\/\/)(?:\*|\+|0\.0\.0\.0|\[::\])(?=[:/]|$)/u, '$1127.0.0.1')).map((entry) => {
    try { return new URL(entry); } catch { return null; }
  }).filter((url) => url && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol));
  const chosen = parsed.find((url) => url.protocol === 'http:') ?? parsed[0];
  return chosen ? `${chosen.protocol}//${chosen.host}/` : urlFor(5000);
}

async function translateDotnet(context, launch, notes) {
  let projectDirectory = launch.project ? path.dirname(launch.project) : launch.projectDirectory ?? null;
  if (!projectDirectory && launch.projectFrom) {
    let directory = path.dirname(launch.projectFrom);
    while (insideRoot(context.root, directory) && !projectDirectory) {
      const entries = await readdir(directory).catch(() => []);
      if (entries.some((name) => name.endsWith('.csproj'))) projectDirectory = directory;
      else if (directory === context.root) break;
      else directory = path.dirname(directory);
    }
    if (!projectDirectory) return { refused: 'runs a built program with no .csproj above it' };
    notes.push('The configuration runs the built DLL; the entry builds and runs the project with dotnet run instead.');
  }
  const directory = launch.workingDirectory && launch.project ? launch.workingDirectory : projectDirectory;
  const project = path.resolve(directory) !== path.resolve(projectDirectory) ? ['--project', posixRelative(directory, launch.project ?? projectDirectory)] : [];
  const argv = ['dotnet', 'run', ...project, ...(launch.launchProfile ? ['--launch-profile', launch.launchProfile] : []),
    ...(launch.arguments.length ? ['--', ...launch.arguments] : [])];
  let applicationUrl = launch.applicationUrl;
  if (!applicationUrl && launch.launchSettings && launch.launchProfile) {
    try { applicationUrl = parseJsonc(await readText(context, launch.launchSettings) ?? '{}')?.profiles?.[launch.launchProfile]?.applicationUrl ?? null; } catch { /* only the guess is lost */ }
  }
  return { argv, workingDirectory: directory, url: dotnetUrl(applicationUrl, launch.variables ?? [], launch.arguments), ready: { http: '/', timeoutMs: TIMEOUTS.dotnet } };
}

// ---------------------------------------------------------------------------------------------
// Platform markers, for directories no IDE configuration covers

async function detectMarkers(context, files) {
  const launches = [];
  const add = (file, name, launch, notes = []) => launches.push({
    source: { kind: 'detected', file: posixRelative(context.root, file), name }, launch, variables: [], notes,
    idHint: path.basename(launch.platform === 'go' && launch.target?.path ? launch.target.path : launch.workingDirectory) || 'app'
  });
  const mains = [];
  for (const file of files) {
    const directory = path.dirname(file);
    const base = path.basename(file);
    if (base === 'package.json') {
      let document;
      try { document = JSON.parse(await readText(context, file) ?? 'null'); } catch { context.reader.skip(file, 'not valid JSON'); continue; }
      const script = ['dev', 'start', 'serve'].find((name) => typeof document?.scripts?.[name] === 'string');
      if (script) add(file, `npm ${script}`, { platform: 'node', mode: 'package-script', packageManager: null, command: 'run', script, arguments: [], workingDirectory: directory });
    } else if (base === 'pom.xml') {
      const text = await readText(context, file) ?? '';
      if (/spring-boot-maven-plugin|spring-boot-starter-parent/u.test(text) && !/<packaging>\s*pom\s*<\/packaging>/u.test(text)) {
        add(file, 'Spring Boot (Maven)', { platform: 'java', mode: 'maven', goals: ['spring-boot:run'], profiles: [], properties: {}, options: [], workingDirectory: directory });
      }
    } else if (base === 'build.gradle' || base === 'build.gradle.kts') {
      const text = await readText(context, file) ?? '';
      if (/org\.springframework\.boot/u.test(text) && !/org\.springframework\.boot['")\s]*(?:version\s*['"(][^\n]*)?\bapply\s*\(?\s*false/u.test(text)) add(file, 'Spring Boot (Gradle)', { platform: 'java', mode: 'gradle', tasks: ['bootRun'], arguments: [], workingDirectory: directory });
    } else if (base === 'manage.py') {
      add(file, 'Django runserver', { platform: 'python', mode: 'django', interpreter: null, interpreterOptions: [], host: '', port: '8000', noReload: false, additional: [], workingDirectory: directory });
    } else if (['main.py', 'app.py', 'asgi.py'].includes(base)) {
      const text = await readText(context, file) ?? '';
      const assignment = text.match(/^([A-Za-z_]\w*)\s*(?::\s*\w+\s*)?=\s*FastAPI\(/mu);
      if (!assignment) continue;
      let packageRoot = directory;
      while (packageRoot !== context.root && await context.reader.exists(path.join(packageRoot, '__init__.py'))) packageRoot = path.dirname(packageRoot);
      const module = posixRelative(packageRoot, file).replace(/\.py$/u, '').split('/').join('.');
      add(file, 'FastAPI (uvicorn)', { platform: 'python', mode: 'module', interpreter: null, interpreterOptions: [], module: 'uvicorn',
        script: null, parameters: [`${module}:${assignment[1]}`, '--host', '127.0.0.1', '--port', '8000'], workingDirectory: packageRoot });
    } else if (base === 'main.go') {
      if (/^package main\b/mu.test(await readText(context, file) ?? '')) mains.push(file);
    } else if (base.endsWith('.csproj')) {
      const text = await readText(context, file) ?? '';
      const hasSettings = context.launchSettingsFiles.some((settings) => path.dirname(path.dirname(settings)) === directory);
      if (/Sdk="Microsoft\.NET\.Sdk\.Web"/u.test(text) && !hasSettings) {
        add(file, 'ASP.NET Core', { platform: 'dotnet', project: file, launchProfile: null, arguments: [], workingDirectory: directory },
          ['No launchSettings.json; the URL is ASP.NET Core\'s default.']);
      }
    }
  }
  for (const file of mains) {
    const module = await nearestDirectory(context, path.dirname(file), ['go.mod']);
    if (!module) continue;
    add(file, `go run ${relativeTarget(module.directory, path.dirname(file))}`, {
      platform: 'go', target: { path: path.dirname(file) }, goFlags: [], arguments: [], workingDirectory: module.directory
    }, ['The port is a guess (8080, or PORT); set the one the program serves on.']);
  }
  return launches;
}

// ---------------------------------------------------------------------------------------------
// Composition

function environmentWords(candidate) {
  const words = [];
  const name = candidate.source.name ?? '';
  for (const match of name.matchAll(/[([]([^)\]]+)[)\]]/gu)) words.push(match[1]);
  const tail = name.match(/(?:\s*[-–:]\s*|_)([A-Za-z][\w]*)\s*$/u);
  if (tail) words.push(tail[1]);
  words.push(...(candidate.launch.profiles ?? []));
  for (const variable of candidate.variables) {
    if (ENVIRONMENT_VARIABLES.has(variable.name) && variable.value) words.push(variable.value.split(',')[0]);
    if (variable.name === 'DJANGO_SETTINGS_MODULE' && variable.value) words.push(variable.value.split('.').pop());
  }
  return words.map((word) => word.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')).filter(Boolean);
}

function declaredEnvironmentFor(words, declared) {
  for (const word of words) {
    if (declared.includes(word)) return word;
    for (const synonym of ENVIRONMENT_SYNONYMS[word] ?? []) if (declared.includes(synonym)) return synonym;
  }
  return null;
}

function proposedEnvironmentFor(words) {
  for (const word of words) {
    const mapped = ENVIRONMENT_SYNONYMS[word]?.[0] ?? null;
    if (mapped && ENVIRONMENT_IDENTIFIER.test(mapped)) return mapped;
  }
  return null;
}

function baseName(candidate) {
  let name = String(candidate.source.name ?? '');
  for (const word of candidate.environmentWords) {
    name = name.replace(new RegExp(`\\s*[([]\\s*${word.replaceAll('-', '[- ]')}\\s*[)\\]]`, 'iu'), '')
      .replace(new RegExp(`(?:\\s*[-–:]\\s*|_)${word.replaceAll('-', '[- ]')}\\s*$`, 'iu'), '');
  }
  return name.trim() || candidate.platform;
}

function entryId(name, taken) {
  let id = String(name).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 60).replace(/-+$/u, '');
  if (!id || !/^[a-z0-9]/u.test(id)) id = 'app';
  let candidate = id;
  for (let suffix = 2; taken.has(candidate); suffix += 1) candidate = `${id}-${suffix}`;
  taken.add(candidate);
  return candidate;
}

function commonPrefix(lists) {
  const [first, ...rest] = lists;
  let length = first.length;
  for (const list of rest) {
    let index = 0;
    while (index < length && index < list.length && list[index] === first[index]) index += 1;
    length = index;
  }
  return first.slice(0, length);
}

/** Configurations of one application that differ only by environment become one entry. */
function groupCandidates(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    const key = [candidate.platform, candidate.workingDirectory, candidate.argv[0], baseName(candidate).toLowerCase()].join('\u0000');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  const result = [];
  for (const members of groups.values()) {
    const environments = members.map((member) => member.declaredEnvironment);
    const mergeable = members.length > 1 && environments.every(Boolean) && new Set(environments).size === members.length
      && members.every((member) => member.url === members[0].url && JSON.stringify(member.ready) === JSON.stringify(members[0].ready));
    if (!mergeable) { result.push(...members.map((member) => ({ members: [member] }))); continue; }
    const prefix = commonPrefix(members.map((member) => member.argv));
    const tails = members.map((member) => member.argv.slice(prefix.length));
    if (!prefix.length || tails.some((tail) => tail.length > 64)) { result.push(...members.map((member) => ({ members: [member] }))); continue; }
    result.push({ members, prefix, tails });
  }
  return result;
}

function namesFor(group) {
  const items = [];
  const byName = new Map();
  for (const member of group.members) {
    for (const variable of member.classified) {
      if (!byName.has(variable.name)) byName.set(variable.name, []);
      byName.get(variable.name).push({ environment: member.environment, variable });
    }
  }
  for (const entries of byName.values()) {
    const same = entries.length === group.members.length && entries.every((entry) => JSON.stringify(entry.variable) === JSON.stringify(entries[0].variable));
    if (same || group.members.length === 1) items.push({ ...entries[0].variable });
    else for (const entry of entries) items.push({ ...entry.variable, ...(entry.environment ? { environment: entry.environment } : {}) });
  }
  return items;
}

function draftYaml(header, value) {
  return `${header.map((line) => `# ${line}`).join('\n')}\n${YAML.stringify(value, { lineWidth: 0 })}`;
}

/**
 * Suggestions for one capability from the checkout at `root`. `existing` is the capability's raw
 * application block, kept in the draft so `capability set --application-file` replaces nothing.
 */
export async function suggestApplication(root, { capabilityId, capability = null, repositoryId = null, repositories = [], declaration = null, policy = null } = {}) {
  const read = await readRunConfigurationSources(root);
  const secrets = new Set();
  const context = { root: read.root, reader: read.reader, cache: new Map(), launchSettingsFiles: read.launchSettingsFiles, markers: read.markers };
  const declared = Object.keys(declaration?.environments ?? {});
  const notes = [];
  const candidates = [];
  const translate = async (configuration) => {
    const own = [...configuration.notes];
    const launch = { ...configuration.launch, variables: configuration.variables, sourceKind: configuration.source.kind };
    const translated = launch.platform === 'java' ? await translateJava(context, launch, own)
      : launch.platform === 'python' ? await translatePython(context, launch, own)
        : launch.platform === 'node' ? await translateNode(context, launch, own)
          : launch.platform === 'go' ? await translateGo(context, launch, own)
            : await translateDotnet(context, launch, own);
    if (translated.refused) { context.reader.skip(path.join(context.root, configuration.source.file), `'${configuration.source.name}' ${translated.refused}`); return null; }
    const workingDirectory = path.resolve(translated.workingDirectory);
    let real = workingDirectory;
    try { real = await realpath(workingDirectory); } catch {
      context.reader.skip(path.join(context.root, configuration.source.file), `'${configuration.source.name}' runs in ${posixRelative(context.root, workingDirectory)}, which does not exist`);
      return null;
    }
    if (!insideRoot(context.root, real)) {
      context.reader.skip(path.join(context.root, configuration.source.file), `'${configuration.source.name}' runs in a directory outside the repository`);
      return null;
    }
    const scrubbed = withoutSecretArguments(translated.argv, secrets, own);
    if (scrubbed.tokens.some((token) => /\$[A-Z_]+\$|\$\{[^}]+\}/u.test(token))) own.push('An argument still names an IDE variable ($…$ or ${…}); replace it with its value.');
    const classified = [];
    for (const variable of configuration.variables) {
      if (!declarableEnvironmentVariable(variable.name)) {
        if (looksSecretName(variable.name) || looksSecretValue(variable.value)) secrets.add(String(variable.value));
        own.push(`${variable.name} is not carried: environments.yml cannot declare it (a reserved or non UPPER_CASE name).`);
        continue;
      }
      classified.push(classifyVariable(variable.name, variable.value, { reference: variable.reference }, secrets));
    }
    for (const name of scrubbed.secretNames) if (!classified.some((entry) => entry.name === name)) classified.push({ name, kind: 'secret' });
    const candidate = {
      source: configuration.source, platform: launch.platform, launch, variables: configuration.variables, classified,
      argv: scrubbed.tokens, workingDirectory: posixRelative(context.root, real), url: translated.url, ready: translated.ready,
      debug: debugFor(launch.platform, translated.debugPort ?? null), notes: own, idHint: configuration.idHint ?? null
    };
    candidate.environmentWords = environmentWords(candidate);
    candidate.declaredEnvironment = declaredEnvironmentFor(candidate.environmentWords, declared);
    return candidate;
  };
  for (const configuration of read.launches) {
    const candidate = await translate(configuration);
    if (candidate) candidates.push(candidate);
  }
  const covered = new Set(candidates.map((candidate) => candidate.workingDirectory));
  for (const configuration of await detectMarkers(context, read.markers)) {
    const candidate = await translate(configuration);
    if (candidate && !covered.has(candidate.workingDirectory)) candidates.push(candidate);
  }
  // A capability that owns part of the repository gets the entries that run inside its roots.
  const roots = (capability?.sourceRoots ?? []).map((entry) => String(entry).replace(/\/\*\*$/u, '').replace(/\/$/u, '')).filter((entry) => entry && entry !== '.');
  const within = (inner, outer) => outer === '.' || inner === outer || inner.startsWith(`${outer}/`);
  const scoped = roots.length
    ? candidates.filter((candidate) => roots.some((rootPath) => within(candidate.workingDirectory, rootPath) || within(rootPath, candidate.workingDirectory)))
    : candidates;
  if (scoped.length !== candidates.length) notes.push(`${candidates.length - scoped.length} configuration(s) run outside this capability's source roots and were left out.`);

  const existingStart = Array.isArray(capability?.application?.start) ? capability.application.start : [];
  const taken = new Set(existingStart.map((entry) => entry?.id).filter(Boolean));
  const suggestions = [];
  const draftEntries = [];
  const additions = {};
  const multiple = repositories.length > 1;
  // The same launch configured twice (a Rider profile and its launchSettings.json) is one entry.
  const unique = [];
  for (const candidate of scoped) {
    const twin = unique.find((other) => other.workingDirectory === candidate.workingDirectory && JSON.stringify(other.argv) === JSON.stringify(candidate.argv));
    if (twin) twin.notes.push(`Also configured in ${candidate.source.file} ('${candidate.source.name}').`);
    else unique.push(candidate);
  }
  for (const group of groupCandidates(unique)) {
    const [first] = group.members;
    const merged = group.members.length > 1;
    const own = [...new Set(group.members.flatMap((member) => member.notes))];
    let environments = [];
    if (merged) environments = group.members.map((member) => member.declaredEnvironment);
    else if (first.declaredEnvironment) environments = [first.declaredEnvironment];
    else if (first.classified.length) {
      const proposed = proposedEnvironmentFor(first.environmentWords) ?? 'local';
      environments = [proposed];
      own.push(`Its variables need an environment: declare ${proposed} in singularity/environments.yml (see environmentsDraft).`);
    } else if (first.environmentWords.length && proposedEnvironmentFor(first.environmentWords) && declared.length === 0) {
      own.push('Declare its environments in singularity/environments.yml and suggest again to get one entry with arguments per environment.');
    }
    for (const [index, member] of group.members.entries()) member.environment = environments[merged ? index : 0] ?? null;
    const startArguments = merged ? Object.fromEntries(group.members.map((member, index) => [member.environment, group.tails[index]])
      .filter(([, tail]) => tail.length)) : {};
    const id = entryId(first.idHint ?? (merged || first.declaredEnvironment ? baseName(first) : first.source.name ?? first.platform), taken);
    const start = {
      id, ...(multiple && repositoryId ? { repository: repositoryId } : {}), argv: merged ? [...group.prefix] : [...first.argv],
      workingDirectory: first.workingDirectory, url: first.url, ready: { ...first.ready },
      ...(environments.length ? { environments } : {}), arguments: startArguments, debug: { ...first.debug }
    };
    const draft = { ...start };
    if (!Object.keys(startArguments).length) delete draft.arguments;
    const duplicate = existingStart.find((entry) => JSON.stringify(entry?.argv) === JSON.stringify(start.argv)
      && (entry?.workingDirectory ?? '.') === start.workingDirectory);
    if (duplicate) own.push(`Already declared as start entry '${duplicate.id}'; the draft keeps that one.`);
    else {
      try {
        normalizeCapabilityApplication(capabilityId, { kind: 'delivery', repositories: repositories.length ? repositories : [repositoryId ?? 'repository'],
          application: { start: [draft] } });
        draftEntries.push(draft);
      } catch (error) {
        own.push(`Not in the draft: ${error.message}`);
      }
    }
    const environmentNames = namesFor(group);
    for (const member of group.members) {
      if (!member.environment) continue;
      const already = new Set((declaration?.environments?.[member.environment]?.requires ?? []).map((entry) => entry.name));
      for (const variable of member.classified) {
        if (already.has(variable.name)) continue;
        additions[member.environment] ??= new Map();
        if (!additions[member.environment].has(variable.name)) additions[member.environment].set(variable.name, variable);
      }
    }
    suggestions.push({
      source: { ...first.source },
      ...(merged ? { variants: group.members.map((member) => ({ file: member.source.file, name: member.source.name, environment: member.environment })) } : {}),
      start, environmentNames, notes: own
    });
  }

  const tests = capability?.application?.tests;
  const applicationValue = { start: [...existingStart, ...draftEntries], ...(Array.isArray(tests) && tests.length ? { tests } : {}) };
  const applicationDraft = draftEntries.length
    ? draftYaml([`The application block for capability ${capabilityId}: existing entries, then the suggested ones.`,
      `Review it, save it to a file and run: singularity-flow capability set ${capabilityId} --application-file <FILE>`,
      `(or capability edit ${capabilityId} --lead <URL> --application-file <FILE> --mode set for a proposal).`], applicationValue)
    : '';
  const environmentAdditions = Object.fromEntries(Object.entries(additions)
    .map(([environment, map]) => [environment, { requires: [...map.values()] }]).filter(([, value]) => value.requires.length));
  const environmentsDraft = Object.keys(environmentAdditions).length
    ? draftYaml(['Additions for singularity/environments.yml; propose them through the configuration proposal.',
      'Secrets are names only: bind each value yourself, from your own secret helper, with env bind <ENV> --stdin.'],
    declared.length ? { environments: environmentAdditions } : { schemaVersion: 1, environments: environmentAdditions })
    : '';
  if (policy?.localIntegrationEvidence !== 'allowed' && suggestions.some((suggestion) => suggestion.start.environments?.length)) {
    notes.push('Entries with environments start only when the capability sets policy.localIntegrationEvidence: allowed (a capability proposal).');
  }
  if (read.reader.truncated) notes.push(`Reading stopped at ${read.reader.filesRead} files or the directory limit; some configurations may be missing.`);
  if (!suggestions.length) notes.push('No IDE run configuration or platform marker produced a start entry.');
  const result = {
    resultType: APP_SUGGESTIONS_RESULT, capability: capabilityId, repository: repositoryId,
    suggestions, applicationDraft, environmentsDraft, notes,
    files: { read: read.reader.filesRead, skipped: read.reader.skipped }
  };
  return scrubDeep(result, secrets);
}

export { parseJsonc };
