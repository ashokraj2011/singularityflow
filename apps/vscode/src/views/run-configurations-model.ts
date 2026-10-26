/**
 * The Run/Debug Configurations editor, as VS Code models it. [docs/SPEC-RUN-AND-TEST-v1.md, IntelliJ
 * amendment §2, milestone 12]
 *
 * A capability's `application.start` entries are typed run configurations (spring-boot, jar,
 * application, maven, gradle, python, django, fastapi, flask, node, npm, go, dotnet, command). The
 * editor works on a draft of the whole `application` block, as `app plan --json` reports it under
 * `application` (the block as singularity/capabilities.yml holds it). Each edit is one field of one
 * configuration, on Base or on one environment's `perEnvironment` override. What is written is the
 * whole block: every entry the person did not change exactly as it was declared, `tests` and any
 * other key exactly as declared, and the changed entries in a fixed key order.
 *
 * Secrets never enter the draft. An environment variable whose name or value looks like a secret,
 * or an argument that carries one, is refused with the `env bind` guidance, by the engine's own rule
 * (`app suggest`, src/app-suggestions.mjs: looksSecretName / looksSecretValue). The draft is all the
 * page state and webview state ever hold.
 *
 * The engine owns resolution: `app config preview --application-file FILE --json` returns each
 * configuration's command line per environment, or the located errors, and this module only reads it.
 *
 * Pure on purpose (no `vscode` import), so the tests pin every field, draft, block and argv.
 */
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import type { ReviewConfirmationRequest } from './review-confirmation-page.ts';
import { DEBUG_RUNTIMES, displayCommand, environmentsFrom, loopbackUrl, unwrapResult, type DebugRuntime, type EnvironmentChoice } from './run-and-test-model.ts';
import {
  applicationWriteArgv, checkedEnvironmentsDraft, maskedArgv, repositoryRelative, SOURCE_WORDS, TEMPORARY_FILE_WORDS, type ApplicationRoute
} from './run-suggestions-model.ts';

type Entry = Record<string, unknown>;

const CAPABILITY = /^[a-z0-9][a-z0-9-]*$/;
const START_ID = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENVIRONMENT = /^(?=.{1,64}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const VARIABLE = /^[A-Z][A-Z0-9_]{0,127}$/;
const PROPERTY = /^[A-Za-z_][\w.-]{0,127}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_LIST = 256;

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const record = (value: unknown): Entry | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Entry : null;
const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)) as T);

/** JSON with sorted keys: two values are the same configuration when these are equal. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = record(value);
  if (object) return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);

// ---------------------------------------------------------------------------------------------
// Secrets: the engine's rule (src/app-suggestions.mjs), ported exactly; a test pins the parity.

const SECRET_NAME = /pass|secret|token|key|credential|private|auth/i;

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) { const p = count / value.length; bits -= p * Math.log2(p); }
  return bits;
}

export const looksSecretName = (name: unknown): boolean => SECRET_NAME.test(String(name ?? ''));

/** A JWT, a cloud key, a URL with userinfo, a private key or a long random token. */
export function looksSecretValue(raw: unknown): boolean {
  const value = String(raw ?? '').trim();
  if (value.length < 8) return false;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) return true;
  if (/(?:^|[^A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(value)) return true;
  if (/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/.test(value)) return true;
  if (/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bsk_(?:live|test)_[A-Za-z0-9]{10,}|\bAIza[0-9A-Za-z_-]{30,}/.test(value)) return true;
  if (/[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/i.test(value)) return true;
  if (/[?&;](?:[^=&\s]*(?:pass|secret|token|key|credential|auth|signature|sig))[^=&\s]*=/i.test(value)) return true;
  for (const piece of value.split(/[\s,;]+/)) {
    if (piece.length < 20 || !/^[A-Za-z0-9+/=_\-.~]+$/.test(piece)) continue;
    if (/^(?:[a-z][a-z0-9]*\.)+[A-Za-z_$][\w$]*$/.test(piece) || /=[^=]/.test(piece)) continue;
    if (/^[0-9a-f]{32,}$/i.test(piece)) return true;
    const upper = /[A-Z]/.test(piece);
    const lower = /[a-z]/.test(piece);
    const digit = /\d/.test(piece);
    const score = entropy(piece);
    if ((upper && lower && digit && score >= 3.5) || ((upper || lower) && digit && score >= 4.2)) return true;
  }
  return false;
}

/**
 * The first argument part that would carry a secret, as the engine's withoutSecretArguments finds
 * it: `--name=value` or `-Dname=value` whose name or value looks secret (also inside a property
 * whose value is itself a command line), `--password VALUE`, or a bare value that looks secret.
 * Only the name is returned ('a value' for a bare one), never the value.
 */
export function secretInArguments(tokens: readonly string[]): string | null {
  const part = (piece: string): string | null => {
    const assignment = /^(-{0,2}D?)([A-Za-z_][\w.-]*)=(.*)$/s.exec(piece);
    if (assignment && (looksSecretName(assignment[2]) || looksSecretValue(assignment[3]))) return assignment[2]!;
    return !assignment && looksSecretValue(piece) ? 'a value' : null;
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = String(tokens[index]);
    const flag = /^--?([A-Za-z][\w.-]*)$/.exec(token);
    if (flag && looksSecretName(flag[1]) && index + 1 < tokens.length && !String(tokens[index + 1]).startsWith('-')) return flag[1]!;
    const property = /^(-D[\w.-]+=|--[\w.-]+=)(.*)$/s.exec(token);
    if (property && /\s/.test(property[2]!)) {
      const name = property[1]!.replace(/^-D|^--|=$/g, '');
      if (looksSecretName(name)) return name;
      const found = property[2]!.split(/\s+/).filter(Boolean).map(part).find(Boolean);
      if (found) return found;
      continue;
    }
    const found = part(token);
    if (found) return found;
  }
  return null;
}

const RESERVED_VARIABLES = new Set(['PATH', 'NODE_OPTIONS', 'NODE_PATH', 'HOME', 'SHELL', 'COMSPEC', 'PATHEXT', 'SYSTEMROOT', 'USERPROFILE',
  'TMP', 'TEMP', 'SSH_AUTH_SOCK', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']);
const RESERVED_PREFIXES = ['GIT_', 'LD_', 'DYLD_', 'NODE_', 'NPM_CONFIG_', 'SINGULARITY_FLOW_'];

/** Whether a variable may be set in `env`: UPPER_CASE and not reserved (environments.yml's own rule). */
export const declarableVariable = (name: string): boolean =>
  VARIABLE.test(name) && !RESERVED_VARIABLES.has(name) && !RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix));

export const bindWords = (environment: string | null): string => `singularity-flow env bind ${environment ?? '<ENVIRONMENT>'} --stdin`;

/** What the form says instead of keeping a secret. It names the variable, never the value. */
export function secretRefusal(name: string, environment: string | null): string {
  const what = name === 'a value' ? 'A value here looks like a secret' : `${name} looks like a secret`;
  return `${what}, so it was not kept. Secrets are never typed into VS Code: declare it as a secret in singularity/environments.yml and bind it privately on this computer with your own secret helper, on standard input: ${bindWords(environment)}`;
}

// ---------------------------------------------------------------------------------------------
// Types and their fields (the amendment's table)

export const CONFIGURATION_TYPES = ['spring-boot', 'jar', 'application', 'maven', 'gradle', 'python', 'django', 'fastapi', 'flask',
  'node', 'npm', 'go', 'dotnet', 'command'] as const;
export type ConfigurationType = typeof CONFIGURATION_TYPES[number];

export type FieldKind = 'text' | 'path' | 'list' | 'select' | 'port' | 'boolean' | 'properties';
export interface FieldSpec {
  key: string;
  label: string;
  kind: FieldKind;
  options?: readonly string[];
  placeholder?: string;
  help?: string;
  required?: boolean;
}

export type TypeGlyph = 'leaf' | 'java' | 'maven' | 'gradle' | 'python' | 'web' | 'node' | 'npm' | 'go' | 'dotnet' | 'terminal';

export interface TypeSpec {
  type: ConfigurationType;
  label: string;
  glyph: TypeGlyph;
  /** The debugger runtime the type implies; `command` names its own. */
  runtime: DebugRuntime | null;
  /** How the engine runs it, as the amendment's table says. */
  runsAs: string;
  fields: readonly FieldSpec[];
  /** A new configuration of this type: sensible defaults, loopback URL, readiness and debug port. */
  template: Entry;
}

const LINES = 'One per line.';
const vmOptions: FieldSpec = { key: 'vmOptions', label: 'VM options', kind: 'list', placeholder: '-Xmx1g', help: `${LINES} Passed to the JVM.` };
const programArguments: FieldSpec = { key: 'programArguments', label: 'Program arguments', kind: 'list', placeholder: '--server.port=8080', help: LINES };
const properties: FieldSpec = { key: 'properties', label: 'Properties', kind: 'properties', placeholder: 'skipTests=true', help: 'One NAME=value per line; passed as -DNAME=value.' };
const port = (fallback: number): FieldSpec => ({ key: 'port', label: 'Port', kind: 'port', placeholder: String(fallback) });
const ready = (http: string, timeoutMs: number): Entry => ({ http, timeoutMs });
const url = (portNumber: number): string => `http://127.0.0.1:${portNumber}/`;

export const TYPE_SPECS: Readonly<Record<ConfigurationType, TypeSpec>> = Object.freeze({
  'spring-boot': {
    type: 'spring-boot', label: 'Spring Boot', glyph: 'leaf', runtime: 'java',
    runsAs: 'Maven spring-boot:run or Gradle bootRun, through the project wrapper',
    fields: [
      { key: 'launcher', label: 'Launcher', kind: 'select', options: ['maven', 'gradle'], required: true },
      { key: 'mainClass', label: 'Main class', kind: 'text', placeholder: 'com.example.api.ApiApplication', help: 'Optional: needed when the project has several.' },
      vmOptions, programArguments,
      { key: 'activeProfiles', label: 'Active profiles', kind: 'list', placeholder: 'dev', help: LINES }
    ],
    template: { launcher: 'maven', url: url(8080), ready: ready('/actuator/health', 180_000), debug: { port: 5005 } }
  },
  jar: {
    type: 'jar', label: 'JAR Application', glyph: 'java', runtime: 'java', runsAs: 'java <VM options> -jar <jar> <program arguments>',
    fields: [{ key: 'jar', label: 'Path to JAR', kind: 'path', placeholder: 'target/app.jar', required: true }, vmOptions, programArguments],
    template: { jar: 'target/app.jar', url: url(8080), ready: ready('/', 120_000), debug: { port: 5005 } }
  },
  application: {
    type: 'application', label: 'Application', glyph: 'java', runtime: 'java', runsAs: 'Maven exec:java with the main class, or the Gradle run task',
    fields: [
      { key: 'launcher', label: 'Launcher', kind: 'select', options: ['maven-exec', 'gradle-run'], required: true },
      { key: 'mainClass', label: 'Main class', kind: 'text', placeholder: 'com.example.Main', required: true }, vmOptions, programArguments
    ],
    template: { launcher: 'maven-exec', mainClass: 'com.example.Main', url: url(8080), ready: ready('/', 120_000), debug: { port: 5005 } }
  },
  maven: {
    type: 'maven', label: 'Maven', glyph: 'maven', runtime: 'java', runsAs: 'the Maven wrapper when present, else mvn',
    fields: [
      { key: 'goals', label: 'Goals', kind: 'list', placeholder: 'spring-boot:run', help: LINES, required: true },
      { key: 'profiles', label: 'Profiles', kind: 'list', placeholder: 'dev', help: `${LINES} Passed as -P.` },
      properties,
      { key: 'arguments', label: 'Command-line arguments', kind: 'list', placeholder: '-q', help: LINES }
    ],
    template: { goals: ['spring-boot:run'], url: url(8080), ready: ready('/', 180_000), debug: { port: 5005 } }
  },
  gradle: {
    type: 'gradle', label: 'Gradle', glyph: 'gradle', runtime: 'java', runsAs: 'the Gradle wrapper when present, else gradle',
    fields: [
      { key: 'tasks', label: 'Tasks', kind: 'list', placeholder: 'bootRun', help: LINES, required: true },
      properties,
      { key: 'arguments', label: 'Arguments', kind: 'list', placeholder: '--console=plain', help: LINES }
    ],
    template: { tasks: ['run'], url: url(8080), ready: ready('/', 180_000), debug: { port: 5005 } }
  },
  python: {
    type: 'python', label: 'Python', glyph: 'python', runtime: 'python',
    runsAs: '<interpreter> <interpreter options> <script | -m module> <parameters>',
    fields: [
      { key: 'script', label: 'Script path', kind: 'path', placeholder: 'main.py', help: 'Set the script or the module, not both.' },
      { key: 'module', label: 'Module name', kind: 'text', placeholder: 'app.main' },
      { key: 'interpreter', label: 'Python interpreter', kind: 'path', placeholder: '.venv/bin/python', help: 'Defaults to .venv/bin/python, then python3.' },
      { key: 'interpreterOptions', label: 'Interpreter options', kind: 'list', placeholder: '-X dev', help: LINES },
      { key: 'parameters', label: 'Parameters', kind: 'list', help: LINES }
    ],
    template: { script: 'main.py', url: url(8000), ready: ready('/', 60_000), debug: { port: 5678 } }
  },
  django: {
    type: 'django', label: 'Django Server', glyph: 'web', runtime: 'python', runsAs: '<python> manage.py runserver 127.0.0.1:<port>',
    fields: [
      { key: 'manage', label: 'manage.py', kind: 'path', placeholder: 'manage.py', required: true },
      { key: 'host', label: 'Host', kind: 'select', options: ['127.0.0.1', 'localhost', '::1'], help: 'Loopback only.' },
      port(8000),
      { key: 'settings', label: 'Settings module', kind: 'text', placeholder: 'mysite.settings.dev', help: 'Passed as --settings when set.' }
    ],
    template: { manage: 'manage.py', port: 8000, url: url(8000), ready: ready('/', 60_000), debug: { port: 5678 } }
  },
  fastapi: {
    type: 'fastapi', label: 'FastAPI', glyph: 'web', runtime: 'python', runsAs: '<python> -m uvicorn <app> --host 127.0.0.1 --port <port>',
    fields: [{ key: 'app', label: 'Application', kind: 'text', placeholder: 'main:app', help: 'module:attribute', required: true }, port(8000),
      { key: 'reload', label: 'Reload on change', kind: 'boolean' }],
    template: { app: 'main:app', port: 8000, url: url(8000), ready: ready('/docs', 60_000), debug: { port: 5678 } }
  },
  flask: {
    type: 'flask', label: 'Flask Server', glyph: 'web', runtime: 'python', runsAs: 'flask --app <app> run --host 127.0.0.1',
    fields: [{ key: 'app', label: 'Application', kind: 'text', placeholder: 'app:app', help: 'module:attribute', required: true }, port(5000),
      { key: 'reload', label: 'Reload on change', kind: 'boolean' }],
    template: { app: 'app:app', port: 5000, url: url(5000), ready: ready('/', 60_000), debug: { port: 5678 } }
  },
  node: {
    type: 'node', label: 'Node.js', glyph: 'node', runtime: 'node', runsAs: 'node <Node options> <script> <application parameters>',
    fields: [
      { key: 'script', label: 'JavaScript file', kind: 'path', placeholder: 'server.js', required: true },
      { key: 'nodeOptions', label: 'Node options', kind: 'list', placeholder: '--enable-source-maps', help: LINES },
      { key: 'applicationParameters', label: 'Application parameters', kind: 'list', help: LINES },
      { key: 'nodeInterpreter', label: 'Node interpreter', kind: 'path', placeholder: 'node', help: 'Defaults to node on PATH.' }
    ],
    template: { script: 'server.js', url: url(3000), ready: ready('/', 90_000), debug: { port: 9229 } }
  },
  npm: {
    type: 'npm', label: 'npm', glyph: 'npm', runtime: 'node', runsAs: '<package manager> run <script> -- <arguments>',
    fields: [
      { key: 'packageManager', label: 'Package manager', kind: 'select', options: ['npm', 'pnpm', 'yarn'], required: true },
      { key: 'script', label: 'Script', kind: 'text', placeholder: 'dev', required: true },
      { key: 'arguments', label: 'Arguments', kind: 'list', placeholder: '--port=5173', help: `${LINES} Passed after --.` }
    ],
    template: { packageManager: 'npm', script: 'dev', url: url(5173), ready: ready('/', 90_000), debug: { port: 9229 } }
  },
  go: {
    type: 'go', label: 'Go Build', glyph: 'go', runtime: 'go', runsAs: 'go run <go tool arguments> <target> <program arguments>',
    fields: [
      { key: 'kind', label: 'Run kind', kind: 'select', options: ['package', 'file', 'directory'], required: true },
      { key: 'target', label: 'Package, file or directory', kind: 'text', placeholder: './cmd/server', required: true },
      { key: 'goToolArguments', label: 'Go tool arguments', kind: 'list', placeholder: '-race', help: LINES },
      programArguments
    ],
    template: { kind: 'package', target: '.', url: url(8080), ready: ready('/', 120_000), debug: { port: 2345 } }
  },
  dotnet: {
    type: 'dotnet', label: '.NET Project', glyph: 'dotnet', runtime: 'dotnet',
    runsAs: 'dotnet run --project <project> [--launch-profile …] [-c …] -- <arguments>',
    fields: [
      { key: 'project', label: 'Project', kind: 'path', placeholder: 'src/Api/Api.csproj', required: true },
      { key: 'launchProfile', label: 'Launch profile', kind: 'text', placeholder: 'Development' },
      { key: 'configuration', label: 'Configuration', kind: 'text', placeholder: 'Debug' },
      { key: 'arguments', label: 'Arguments', kind: 'list', help: `${LINES} Passed after --.` }
    ],
    template: { project: 'src/Api/Api.csproj', url: url(5000), ready: ready('/', 120_000) }
  },
  command: {
    type: 'command', label: 'Command', glyph: 'terminal', runtime: null, runsAs: 'the command line as written',
    fields: [{ key: 'argv', label: 'Command', kind: 'list', placeholder: 'npm', help: 'One argument per line, the program first. No shell: nothing is expanded.', required: true }],
    template: { argv: ['npm', 'run', 'dev'], url: url(5173), ready: ready('/', 90_000) }
  }
});

const TEMPLATE_IDS: Record<ConfigurationType, string> = {
  'spring-boot': 'api', jar: 'app', application: 'main', maven: 'maven', gradle: 'gradle', python: 'python', django: 'web', fastapi: 'api',
  flask: 'web', node: 'server', npm: 'web', go: 'server', dotnet: 'api', command: 'app'
};

export const DEFAULT_DEBUG_PORTS: Readonly<Record<string, number>> = Object.freeze({ java: 5005, python: 5678, node: 9229, go: 2345 });

/** The entry's type: `type` when it is one VS Code knows, `command` for a plain argv entry; null otherwise. */
export function typeOf(entry: Entry): ConfigurationType | null {
  if (entry.type === undefined) return 'command';
  return (CONFIGURATION_TYPES as readonly string[]).includes(String(entry.type)) ? entry.type as ConfigurationType : null;
}

/** The debugger runtime: the type's, or for `command` its own `debug.runtime`. */
export function runtimeOf(entry: Entry): DebugRuntime | null {
  const type = typeOf(entry);
  if (type && type !== 'command') return TYPE_SPECS[type].runtime;
  const named = text(record(entry.debug)?.runtime);
  return named && (DEBUG_RUNTIMES as readonly string[]).includes(named) ? named as DebugRuntime : null;
}

/**
 * Fields an environment tab overrides (`perEnvironment.<env>.<field>`). A `command` entry instead
 * appends `arguments.<env>` to its argv (the earlier amendment's form); the form calls that field
 * `appended`, because typed entries have list fields called `arguments` of their own.
 */
export function overridableFields(type: ConfigurationType): string[] {
  if (type === 'command') return ['appended', 'workingDirectory', 'env', 'beforeLaunch'];
  return [...TYPE_SPECS[type].fields.map((field) => field.key), 'workingDirectory', 'env', 'beforeLaunch'];
}

/** A unique lower-kebab ID from a wish: `api`, then `api-2`, `api-3`, … */
export function uniqueId(wish: string, taken: readonly string[]): string {
  const base = (wish.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app').slice(0, 56);
  if (!taken.includes(base)) return base;
  for (let suffix = 2; ; suffix += 1) if (!taken.includes(`${base}-${suffix}`)) return `${base}-${suffix}`;
}

/** A new configuration from the type's template, with an ID and a name nobody else has. */
export function templateEntry(type: ConfigurationType, taken: { ids: readonly string[]; names: readonly string[] }): Entry {
  const spec = TYPE_SPECS[type];
  let name = spec.label;
  for (let suffix = 2; taken.names.includes(name); suffix += 1) name = `${spec.label} (${suffix})`;
  return { id: uniqueId(TEMPLATE_IDS[type], taken.ids), name, ...(type === 'command' ? {} : { type }), ...clone(spec.template) };
}

// ---------------------------------------------------------------------------------------------
// The declared block and the draft

/** The capability's `application` block as declared, and whether the engine reported it. */
export interface DeclaredBlock {
  start: Entry[];
  tests: unknown[] | null;
  /** Any other key of the block, kept exactly. */
  other: Entry;
  /** False when `app plan` did not report the block: the editor shows the plan but cannot save. */
  known: boolean;
}

/** What `app plan` says about one entry that the form shows beside it: binding status and variable names. */
export interface PlanFacts {
  id: string;
  environments: EnvironmentChoice[];
  /** Per environment: the variable names the process gets (`resolved.envNames`); values never. */
  envNames: Record<string, string[]>;
}

const PLAN_KEYS = ['dependsOn', 'id', 'name', 'type', 'repository', 'argv', 'workingDirectory', 'url', 'ready', 'arguments', 'debug', 'env', 'beforeLaunch', 'perEnvironment',
  ...new Set(Object.values(TYPE_SPECS).flatMap((spec) => spec.fields.map((field) => field.key)))];

/**
 * `app plan --capability <ID> --json`: the declared block under `application` (start and tests, as
 * singularity/capabilities.yml holds them), and from `entries[]` each entry's environments with
 * their binding status and the variable names each environment resolves (`resolved.envNames`). An
 * engine that does not report `application` gives entries rebuilt from `entries[]`, marked unknown.
 */
export function declaredFromPlan(raw: unknown): { capability: string | null; block: DeclaredBlock; facts: PlanFacts[] } {
  const answer = record(unwrapResult(raw)) ?? {};
  const entries = (Array.isArray(answer.entries) ? answer.entries : []).flatMap((item) => record(item) ? [record(item)!] : []);
  const facts = entries.flatMap((entry): PlanFacts[] => {
    const id = text(entry.id);
    if (!id || !START_ID.test(id)) return [];
    const envNames: Record<string, string[]> = {};
    for (const item of Array.isArray(entry.environments) ? entry.environments : []) {
      const environment = record(item);
      const name = text(environment?.name);
      const names = record(environment?.resolved)?.envNames;
      if (name && ENVIRONMENT.test(name) && Array.isArray(names)) envNames[name] = names.filter((value): value is string => typeof value === 'string' && VARIABLE.test(value));
    }
    return [{ id, environments: environmentsFrom(entry), envNames }];
  });
  const application = record(answer.application);
  const capability = text(answer.capability) && CAPABILITY.test(String(answer.capability)) ? String(answer.capability) : null;
  if (application && (application.start === undefined || Array.isArray(application.start))) {
    const { start, tests, ...other } = application;
    return {
      capability, facts,
      block: { start: (Array.isArray(start) ? start : []).flatMap((entry) => record(entry) ? [clone(record(entry)!)] : []),
        tests: Array.isArray(tests) ? clone(tests) : null, other: clone(other), known: true }
    };
  }
  const rebuilt = entries.map((entry) => {
    const declared: Entry = {};
    for (const key of PLAN_KEYS) if (entry[key] !== undefined && entry[key] !== null) declared[key] = clone(entry[key]);
    const names = environmentsFrom(entry).map((choice) => choice.name);
    if (names.length) declared.environments = names;
    return declared;
  });
  return { capability, facts, block: { start: rebuilt, tests: null, other: {}, known: false } };
}

/** One configuration being edited: `origin` is its index in the declared block, null for a new one. */
export interface DraftConfiguration { key: string; origin: number | null; entry: Entry }

export interface EditorDraft {
  capability: string;
  /** The fingerprint of the declared block this draft started from. */
  base: string;
  configurations: DraftConfiguration[];
  next: number;
}

/** The fingerprint of a declared block: a changed singularity/capabilities.yml gives another. */
export const blockFingerprint = (block: DeclaredBlock): string =>
  `sha256:${createHash('sha256').update(canonical({ start: block.start, tests: block.tests, other: block.other })).digest('hex')}`;

export function draftFrom(capability: string, block: DeclaredBlock): EditorDraft {
  return {
    capability, base: blockFingerprint(block), next: block.start.length + 1,
    configurations: block.start.map((entry, index) => ({ key: `c${index + 1}`, origin: index, entry: clone(entry) }))
  };
}

/** Whether a configuration differs from what is declared (a new one always does). */
export function isModified(configuration: DraftConfiguration, block: DeclaredBlock): boolean {
  const original = configuration.origin === null ? undefined : block.start[configuration.origin];
  return !original || !same(configuration.entry, original);
}

/** The order an edited entry is written in: identity, type fields, then where, run, debug; unknown keys last. */
export function orderedEntry(entry: Entry): Entry {
  const type = typeOf(entry);
  const typeKeys = type ? TYPE_SPECS[type].fields.map((field) => field.key) : [];
  const order = ['dependsOn', 'id', 'name', 'type', 'repository', ...typeKeys, 'argv', 'workingDirectory', 'env', 'beforeLaunch', 'perEnvironment', 'environments',
    'arguments', 'url', 'ready', 'debug'];
  const ordered: Entry = {};
  for (const key of order) if (entry[key] !== undefined) ordered[key] = entry[key];
  for (const [key, value] of Object.entries(entry)) if (!(key in ordered) && value !== undefined) ordered[key] = value;
  return ordered;
}

/**
 * The whole application block the draft writes: each unchanged entry exactly as declared, each
 * changed or new one in the written order, then `tests` and every other declared key as they were.
 */
export function blockFrom(draft: EditorDraft, block: DeclaredBlock): Entry {
  const start = draft.configurations.map((configuration) => isModified(configuration, block)
    ? orderedEntry(clone(configuration.entry)) : clone(block.start[configuration.origin!]!));
  return { start, ...(block.tests ? { tests: clone(block.tests) } : {}), ...clone(block.other) };
}

export const declaredBlockValue = (block: DeclaredBlock): Entry =>
  ({ start: clone(block.start), ...(block.tests ? { tests: clone(block.tests) } : {}), ...clone(block.other) });

/** Unsaved: the block the draft writes is not the block declared. */
export const draftDirty = (draft: EditorDraft, block: DeclaredBlock): boolean => !same(blockFrom(draft, block), declaredBlockValue(block));

/**
 * An unsaved draft carried onto a declared block that changed underneath it (another save, a pull):
 * an entry the person did not change takes the version declared now, or goes when it went; an entry
 * they changed keeps their edit; one they removed stays removed; a new one declared since is added.
 */
export function rebaseDraft(draft: EditorDraft, from: DeclaredBlock, to: DeclaredBlock): EditorDraft {
  const declaredNow = new Map(to.start.map((entry, index) => [String(entry.id ?? ''), index]));
  const referenced = new Set(draft.configurations.map((configuration) => configuration.origin).filter((origin): origin is number => origin !== null));
  const removed = new Set(from.start.filter((_entry, index) => !referenced.has(index)).map((entry) => String(entry.id ?? '')));
  const used = new Set<number>();
  const configurations: DraftConfiguration[] = [];
  for (const configuration of draft.configurations) {
    if (configuration.origin === null) { configurations.push(configuration); continue; }
    const now = declaredNow.get(String(from.start[configuration.origin]?.id ?? ''));
    const free = now !== undefined && !used.has(now) ? now : undefined;
    if (free !== undefined) used.add(free);
    if (!isModified(configuration, from)) {
      if (free !== undefined) configurations.push({ key: configuration.key, origin: free, entry: clone(to.start[free]!) });
    } else configurations.push({ ...configuration, origin: free ?? null });
  }
  let next = draft.next;
  to.start.forEach((entry, index) => {
    if (!used.has(index) && !removed.has(String(entry.id ?? ''))) configurations.push({ key: `c${next++}`, origin: index, entry: clone(entry) });
  });
  return { ...draft, base: blockFingerprint(to), configurations, next };
}

/** The block as YAML, as both the review page and the private file show it; short lists in flow style. */
export function applicationBlockYaml(block: Entry): string {
  const document = new YAML.Document(block);
  YAML.visit(document, { Seq(_key, node, path) { if (path.length > 3 && node.items.every((item) => !YAML.isCollection(item))) node.flow = true; } });
  return document.toString({ lineWidth: 0, flowCollectionPadding: false });
}

// ---------------------------------------------------------------------------------------------
// Editing one field

export type Tab = 'base' | string;
export interface EditResult { entry: Entry; error: string | null; note?: string | null }

const overrides = (entry: Entry, environment: string): Entry => record(record(entry.perEnvironment)?.[environment]) ?? {};

/** The value a field has in a tab: the environment's override when there is one, else Base's. */
export function effectiveValue(entry: Entry, tab: Tab, field: string): unknown {
  if (field === 'appended') return tab === 'base' ? undefined : record(entry.arguments)?.[tab];
  if (tab === 'base') return entry[field];
  const own = overrides(entry, tab);
  if (field === 'env') return { ...(record(entry.env) ?? {}), ...(record(own.env) ?? {}) };
  return own[field] !== undefined ? own[field] : entry[field];
}

/** The fields an environment overrides, in the form's order: what "differs from Base" marks. */
export function differsFromBase(entry: Entry, environment: string): string[] {
  const type = typeOf(entry) ?? 'command';
  const own = overrides(entry, environment);
  return overridableFields(type).filter((field) => field === 'appended'
    ? record(entry.arguments)?.[environment] !== undefined : own[field] !== undefined);
}

function linesOf(raw: string): string[] {
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function parseList(raw: string, label: string): { value?: string[]; error?: string } {
  const lines = linesOf(raw);
  if (lines.some((line) => CONTROL.test(line))) return { error: `${label} cannot hold control characters.` };
  if (lines.length > MAX_LIST) return { error: `${label} holds at most ${MAX_LIST} lines.` };
  return lines.length ? { value: lines } : {};
}

function parseProperties(raw: string): { value?: Entry; error?: string; secret?: string } {
  const value: Entry = {};
  for (const line of linesOf(raw)) {
    const at = line.indexOf('=');
    const name = (at < 0 ? line : line.slice(0, at)).trim().replace(/^-D/, '');
    const given = at < 0 ? '' : line.slice(at + 1).trim();
    if (!PROPERTY.test(name)) return { error: `Properties are NAME=value lines; ${JSON.stringify(name)} is not a property name.` };
    if (CONTROL.test(given)) return { error: 'Properties cannot hold control characters.' };
    if (looksSecretName(name) || looksSecretValue(given)) return { secret: name };
    value[name] = given;
  }
  return Object.keys(value).length ? { value } : {};
}

const MAX_TEXT = 1_024;

/**
 * A field's value from the page (always a string; a checkbox sends 'true' or 'false'), checked by
 * its kind. `value: undefined` clears the field.
 */
export function parseFieldValue(spec: FieldSpec, raw: string, environment: string | null): { value?: unknown; error?: string } {
  const value = raw.trim();
  switch (spec.kind) {
    case 'list': {
      const parsed = parseList(raw, spec.label);
      if (parsed.error || !parsed.value) return parsed;
      const secret = secretInArguments(parsed.value);
      return secret ? { error: secretRefusal(secret, environment) } : parsed;
    }
    case 'properties': {
      const parsed = parseProperties(raw);
      return parsed.secret ? { error: secretRefusal(parsed.secret, environment) } : parsed;
    }
    case 'select':
      if (!value) return spec.required ? { error: `Choose a ${spec.label.toLowerCase()}.` } : {};
      return spec.options?.includes(value) ? { value } : { error: `${spec.label} is one of: ${spec.options?.join(', ')}.` };
    case 'port':
      if (!value) return {};
      return /^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65_535 ? { value: Number(value) } : { error: `${spec.label} is a TCP port from 1 to 65535.` };
    case 'boolean':
      return value === 'true' ? { value: true } : {};
    case 'path':
      if (!value) return {};
      if (CONTROL.test(value) || value.length > MAX_TEXT) return { error: `${spec.label} must be one line.` };
      return repositoryRelative(value) ? { value: repositoryRelative(value)! } : { error: `${spec.label} must be inside the repository: a relative path without "..".` };
    default:
      if (!value) return {};
      if (CONTROL.test(value) || value.length > MAX_TEXT) return { error: `${spec.label} must be one line of at most ${MAX_TEXT} characters.` };
      return looksSecretValue(value) ? { error: secretRefusal('a value', environment) } : { value };
  }
}

function withOverride(entry: Entry, environment: string, field: string, value: unknown): Entry {
  const next = clone(entry);
  const all = { ...(record(next.perEnvironment) ?? {}) };
  const own = { ...(record(all[environment]) ?? {}) };
  if (value === undefined) delete own[field]; else own[field] = value;
  if (Object.keys(own).length) all[environment] = own; else delete all[environment];
  if (Object.keys(all).length) next.perEnvironment = all; else delete next.perEnvironment;
  return next;
}

function withField(entry: Entry, field: string, value: unknown): Entry {
  const next = clone(entry);
  if (value === undefined) delete next[field]; else next[field] = value;
  return next;
}

/** Store a value on Base, or as an environment's override; an override equal to Base is no override. */
function store(entry: Entry, tab: Tab, field: string, value: unknown, kind: FieldKind | 'env' | 'steps'): Entry {
  if (field === 'appended') {
    const all = { ...(record(entry.arguments) ?? {}) };
    if (value === undefined) delete all[tab]; else all[tab] = value;
    return withField(entry, 'arguments', Object.keys(all).length ? all : undefined);
  }
  if (tab === 'base') return withField(entry, field, value);
  const base = entry[field];
  // An emptied list on an environment whose Base has one is "none here", not "same as Base".
  const stored = value === undefined && (kind === 'list' || kind === 'steps') && Array.isArray(base) && base.length ? [] : value;
  return withOverride(entry, tab, field, stored !== undefined && same(stored, base) ? undefined : stored);
}

/** Remove an environment's override of one field: it uses Base's value again. */
export function resetToBase(entry: Entry, environment: string, field: string): Entry {
  if (field === 'appended') return store(entry, environment, 'appended', undefined, 'list');
  return withOverride(entry, environment, field, undefined);
}

const specOf = (type: ConfigurationType, field: string): FieldSpec | undefined => TYPE_SPECS[type].fields.find((spec) => spec.key === field);
const COMMON_SPECS: Record<string, FieldSpec> = {
  name: { key: 'name', label: 'Name', kind: 'text' },
  repository: { key: 'repository', label: 'Repository', kind: 'text' },
  workingDirectory: { key: 'workingDirectory', label: 'Working directory', kind: 'path' },
  dependsOn: { key: 'dependsOn', label: 'Required services', kind: 'list' },
  appended: { key: 'appended', label: 'Arguments appended in this environment', kind: 'list' }
};

/** The environment a refusal's `env bind` names: the tab's, else the entry's default one. */
const bindEnvironment = (entry: Entry, tab: Tab): string | null =>
  tab !== 'base' ? tab : (Array.isArray(entry.environments) && typeof entry.environments[0] === 'string' ? entry.environments[0] : null);

/**
 * One field edit from the page. `taken` is every other configuration's ID. A refused value leaves the
 * entry as it was and is never kept anywhere: the error names the field, never the value.
 */
export function editField(entry: Entry, tab: Tab, field: string, raw: string, taken: readonly string[] = []): EditResult {
  const type = typeOf(entry) ?? 'command';
  const environment = bindEnvironment(entry, tab);
  const keep = (error: string): EditResult => ({ entry, error });
  if (tab !== 'base' && !overridableFields(type).includes(field)) return keep(`${field} is set on Base, for every environment.`);
  if (tab !== 'base' && !(Array.isArray(entry.environments) && entry.environments.includes(tab))) return keep(`${tab} is not one of this configuration's environments.`);
  if (field === 'appended' && tab === 'base') return keep('Arguments appended per environment are set on an environment\'s tab.');
  const value = raw.trim();
  switch (field) {
    case 'id':
      if (!START_ID.test(value)) return keep('An ID is lower-case kebab case of at most 64 characters, for example api or web-dev.');
      if (taken.includes(value)) return keep(`Another configuration is already called ${value}. Choose another ID.`);
      return { entry: withField(entry, 'id', value), error: null };
    case 'environments': {
      const names = value.split(/[\s,]+/).filter(Boolean);
      const wrong = names.find((name) => !ENVIRONMENT.test(name));
      if (wrong) return keep(`${JSON.stringify(wrong)} is not an environment ID: lower-case kebab case, as singularity/environments.yml names them.`);
      if (new Set(names).size !== names.length) return keep('An environment is listed twice.');
      if (names.length > 16) return keep('A configuration names at most 16 environments.');
      let next = withField(entry, 'environments', names.length ? names : undefined);
      const removed = [...new Set([...Object.keys(record(entry.perEnvironment) ?? {}), ...Object.keys(record(entry.arguments) ?? {})])]
        .filter((name) => !names.includes(name));
      for (const name of removed) {
        const all = { ...(record(next.perEnvironment) ?? {}) };
        delete all[name];
        next = withField(next, 'perEnvironment', Object.keys(all).length ? all : undefined);
        // `arguments` is the per-environment map only on a command entry; a typed entry's is its own list.
        if (record(next.arguments)) {
          const appended = { ...record(next.arguments)! };
          delete appended[name];
          next = withField(next, 'arguments', Object.keys(appended).length ? appended : undefined);
        }
      }
      return { entry: next, error: null, note: removed.length ? `The overrides for ${removed.join(', ')} were removed with ${removed.length === 1 ? 'that environment' : 'those environments'}.` : null };
    }
    case 'url': {
      if (!value) return { entry: withField(entry, 'url', undefined), error: null };
      return loopbackUrl(value) && !CONTROL.test(value) ? { entry: withField(entry, 'url', value), error: null }
        : keep('The URL is http or https on 127.0.0.1, localhost or [::1], with no credentials, query or fragment.');
    }
    case 'ready.kind': {
      const current = record(entry.ready) ?? {};
      if (value !== 'http' && value !== 'log') return keep('Ready is an HTTP path or a line in the output.');
      const { http: _http, log: _log, ...rest } = current;
      return { entry: withField(entry, 'ready', { ...(value === 'http' ? { http: '/' } : { log: 'ready' }), ...rest }), error: null };
    }
    case 'ready.value': {
      const current = record(entry.ready) ?? {};
      const kind = current.log !== undefined ? 'log' : 'http';
      if (kind === 'http' && !(value.startsWith('/') && !value.startsWith('//') && !CONTROL.test(value) && !/[\\#]/.test(value))) {
        return keep('The readiness path starts with a single /, for example /actuator/health.');
      }
      if (kind === 'log' && (!value || value.length > 200 || CONTROL.test(value))) return keep('The ready text is one line of 1 to 200 characters.');
      const { http: _http, log: _log, ...rest } = current;
      return { entry: withField(entry, 'ready', { [kind]: value, ...rest }), error: null };
    }
    case 'ready.timeout': {
      const current = { ...(record(entry.ready) ?? { http: '/' }) };
      if (!value) { delete current.timeoutMs; return { entry: withField(entry, 'ready', current), error: null }; }
      if (!/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > 600) return keep('The readiness timeout is from 1 to 600 seconds.');
      return { entry: withField(entry, 'ready', { ...current, timeoutMs: Number(value) * 1000 }), error: null };
    }
    case 'debug.enabled': {
      if (value !== 'true') return { entry: withField(entry, 'debug', undefined), error: null };
      if (record(entry.debug)) return { entry, error: null };
      const runtime = type === 'command' ? guessedRuntime(entry) : TYPE_SPECS[type].runtime;
      return { entry: withField(entry, 'debug', { ...(type === 'command' ? { runtime } : {}),
        ...(runtime && DEFAULT_DEBUG_PORTS[runtime] ? { port: DEFAULT_DEBUG_PORTS[runtime] } : {}) }), error: null };
    }
    case 'debug.port': case 'debug.suspend': case 'debug.runtime': {
      const debug = { ...(record(entry.debug) ?? {}) };
      if (field === 'debug.port') {
        const parsed = parseFieldValue({ key: 'port', label: 'Debug port', kind: 'port' }, value, environment);
        if (parsed.error) return keep(parsed.error);
        if (parsed.value === undefined) delete debug.port; else debug.port = parsed.value;
      } else if (field === 'debug.suspend') {
        if (value === 'true') debug.suspend = true; else delete debug.suspend;
      } else {
        if (type !== 'command') return keep('The debugger follows from the type.');
        if (!(DEBUG_RUNTIMES as readonly string[]).includes(value)) return keep(`The debugger is one of: ${DEBUG_RUNTIMES.join(', ')}.`);
        debug.runtime = value;
        if (value === 'dotnet') delete debug.port;
      }
      return { entry: withField(entry, 'debug', debug), error: null };
    }
    case 'dependsOn': {
      if (tab !== 'base') return keep('Services are selected on Base.');
      const services = linesOf(raw);
      if (services.some(id => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id) || !taken.includes(id) || id === entry.id)) return keep('Choose other declared start-entry IDs, one per line.');
      return { entry: withField(entry, 'dependsOn', services.length ? [...new Set(services)] : undefined), error: null };
    }
    case 'beforeLaunch': {
      const steps: Entry[] = [];
      const previous = Array.isArray(effectiveValue(entry, tab, 'beforeLaunch')) ? effectiveValue(entry, tab, 'beforeLaunch') as unknown[] : [];
      for (const [index, line] of linesOf(raw).entries()) {
        const parsed = argvFromLine(line);
        if ('error' in parsed) return keep(`Before launch, step ${index + 1}: ${parsed.error}`);
        const secret = secretInArguments(parsed.argv);
        if (secret) return keep(secretRefusal(secret, environment));
        steps.push({ ...(record(previous[index]) ?? {}), argv: parsed.argv });
      }
      return { entry: store(entry, tab, 'beforeLaunch', steps.length ? steps : undefined, 'steps'), error: null };
    }
    case 'name':
      if (value.length > 128 || CONTROL.test(value)) return keep('The name is one line of at most 128 characters.');
      return { entry: withField(entry, 'name', value || undefined), error: null };
    default: {
      const spec = specOf(type, field) ?? COMMON_SPECS[field];
      if (!spec) return keep(`${field} is not a field of a ${TYPE_SPECS[type].label} configuration.`);
      const parsed = parseFieldValue(spec, raw, environment);
      if (parsed.error) return keep(parsed.error);
      let next = store(entry, tab, field, parsed.value, spec.kind);
      // Python runs a script or a module, never both: setting one clears the other on the same tab.
      if (type === 'python' && (field === 'script' || field === 'module') && parsed.value !== undefined) {
        next = tab === 'base' ? withField(next, field === 'script' ? 'module' : 'script', undefined)
          : withOverride(next, tab, field === 'script' ? 'module' : 'script', undefined);
      }
      return { entry: next, error: null };
    }
  }
}

function guessedRuntime(entry: Entry): DebugRuntime {
  const program = String((Array.isArray(entry.argv) ? entry.argv[0] : '') ?? '').split('/').pop() ?? '';
  if (/^(?:python\d*(?:\.\d+)?|uvicorn|flask|django-admin)$/.test(program)) return 'python';
  if (/^(?:node|npm|npx|pnpm|yarn)$/.test(program)) return 'node';
  if (program === 'go') return 'go';
  if (program === 'dotnet') return 'dotnet';
  return 'java';
}

/** One row of the environment variables table, as the page sends it. */
export interface EnvRow { name: string; value: string }

/**
 * The table's literal, non-secret variables, on Base or as an environment's own. A name or value that
 * looks secret, a reserved name, or a repeated one is refused, and the entry stays as it was.
 */
export function editEnv(entry: Entry, tab: Tab, rows: readonly EnvRow[]): EditResult & { refusedName?: string } {
  const environment = bindEnvironment(entry, tab);
  if (tab !== 'base' && !(Array.isArray(entry.environments) && entry.environments.includes(tab))) return { entry, error: `${tab} is not one of this configuration's environments.` };
  const env: Entry = {};
  for (const row of rows) {
    const name = row.name.trim();
    const value = row.value;
    if (!name && !value.trim()) continue;
    if (!name) return { entry, error: 'Every variable needs a name.' };
    if (looksSecretName(name) || looksSecretValue(value)) return { entry, error: secretRefusal(name, environment), refusedName: name };
    if (!VARIABLE.test(name)) return { entry, error: `${name} is not a variable name: UPPER_CASE letters, digits and _.` };
    if (!declarableVariable(name)) return { entry, error: `${name} is reserved: Singularity Flow and the platform set it. Choose another name.` };
    if (CONTROL.test(value) || value.length > 4_096) return { entry, error: `The value of ${name} must be one line of at most 4,096 characters.` };
    if (name in env) return { entry, error: `${name} is listed twice.` };
    env[name] = value;
  }
  const value = Object.keys(env).length ? env : undefined;
  if (tab === 'base') return { entry: withField(entry, 'env', value), error: null };
  // An environment's own variables: those Base does not already give the same value.
  const base = record(entry.env) ?? {};
  const own = value ? Object.fromEntries(Object.entries(value).filter(([name, given]) => base[name] !== given)) : {};
  return { entry: withOverride(entry, tab, 'env', Object.keys(own).length ? own : undefined), error: null };
}

/** The literal variables a tab shows as its own rows; Base's are listed separately on an environment tab. */
export function envRows(entry: Entry, tab: Tab): EnvRow[] {
  const own = tab === 'base' ? record(entry.env) : record(overrides(entry, tab).env);
  return Object.entries(own ?? {}).map(([name, value]) => ({ name, value: String(value ?? '') }));
}

// ---------------------------------------------------------------------------------------------
// Before-launch lines: argv without a shell

/**
 * One line into argv: arguments split at whitespace; "double quotes" (with \" and \\) and 'single
 * quotes' group. Nothing is expanded: there is no shell.
 */
export function argvFromLine(line: string): { argv: string[] } | { error: string } {
  if (CONTROL.test(line.replace(/\t/g, ' '))) return { error: 'a step cannot hold control characters.' };
  const argv: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | '\'' | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (quote === '"' && character === '\\' && (line[index + 1] === '"' || line[index + 1] === '\\')) { current += line[index + 1]; index += 1; continue; }
    if (quote) { if (character === quote) quote = null; else current += character; continue; }
    if (character === '"' || character === '\'') { quote = character; started = true; continue; }
    if (/\s/.test(character)) { if (started) argv.push(current); current = ''; started = false; continue; }
    current += character; started = true;
  }
  if (quote) return { error: `a ${quote === '"' ? 'double' : 'single'} quote is not closed.` };
  if (started) argv.push(current);
  return argv.length ? { argv } : { error: 'a step is empty.' };
}

/** argv as one line the person can read and edit back: an argument with spaces or quotes is quoted. */
export function lineFromArgv(argv: readonly string[]): string {
  return argv.map((part) => /^[\w@%+=:,./~[\]-]+$/.test(part) ? part : `"${part.replace(/[\\"]/g, (match) => `\\${match}`)}"`).join(' ');
}

/** The before-launch steps of a tab, one line each. */
export function beforeLaunchLines(entry: Entry, tab: Tab): string {
  const steps = effectiveValue(entry, tab, 'beforeLaunch');
  return (Array.isArray(steps) ? steps : []).map((step) => {
    const argv = record(step)?.argv;
    return Array.isArray(argv) ? lineFromArgv(argv.map(String)) : '';
  }).filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------------------------
// The list: add, copy, remove, move

const ids = (draft: EditorDraft, except: string | null = null): string[] =>
  draft.configurations.filter((configuration) => configuration.key !== except).map((configuration) => String(configuration.entry.id ?? ''));

export function addConfiguration(draft: EditorDraft, entry: Entry): { draft: EditorDraft; key: string } {
  const key = `c${draft.next}`;
  return { key, draft: { ...draft, next: draft.next + 1, configurations: [...draft.configurations, { key, origin: null, entry }] } };
}

export function addFromTemplate(draft: EditorDraft, type: ConfigurationType): { draft: EditorDraft; key: string } {
  return addConfiguration(draft, templateEntry(type, { ids: ids(draft), names: draft.configurations.map((item) => String(item.entry.name ?? item.entry.id ?? '')) }));
}

/** A copy right after the original, with its own ID and "(copy)" in its name. */
export function copyConfiguration(draft: EditorDraft, key: string): { draft: EditorDraft; key: string } | null {
  const at = draft.configurations.findIndex((configuration) => configuration.key === key);
  if (at < 0) return null;
  const source = draft.configurations[at]!.entry;
  const entry = clone(source);
  entry.id = uniqueId(`${String(source.id ?? 'app')}-copy`, ids(draft));
  entry.name = `${String(source.name ?? source.id ?? 'Configuration')} (copy)`;
  const copyKey = `c${draft.next}`;
  const configurations = [...draft.configurations];
  configurations.splice(at + 1, 0, { key: copyKey, origin: null, entry });
  return { key: copyKey, draft: { ...draft, next: draft.next + 1, configurations } };
}

/** Remove one; the selection moves to its neighbour. */
export function removeConfiguration(draft: EditorDraft, key: string): { draft: EditorDraft; key: string | null } {
  const at = draft.configurations.findIndex((configuration) => configuration.key === key);
  if (at < 0) return { draft, key: null };
  const configurations = draft.configurations.filter((configuration) => configuration.key !== key);
  return { draft: { ...draft, configurations }, key: configurations[Math.min(at, configurations.length - 1)]?.key ?? null };
}

/** Move up or down among the configurations of the same type, as the list groups them. */
export function moveConfiguration(draft: EditorDraft, key: string, direction: 'up' | 'down'): EditorDraft {
  const at = draft.configurations.findIndex((configuration) => configuration.key === key);
  if (at < 0) return draft;
  const type = typeOf(draft.configurations[at]!.entry);
  const step = direction === 'up' ? -1 : 1;
  let other = at + step;
  while (other >= 0 && other < draft.configurations.length && typeOf(draft.configurations[other]!.entry) !== type) other += step;
  if (other < 0 || other >= draft.configurations.length) return draft;
  const configurations = [...draft.configurations];
  [configurations[at], configurations[other]] = [configurations[other]!, configurations[at]!];
  return { ...draft, configurations };
}

export const otherIds = ids;

// ---------------------------------------------------------------------------------------------
// Keeping a draft across reloads of the page (webview state): only what the draft already holds

export interface SavedEditorState { v: 1; capability: string; base: string; selected: string | null; tab: Tab; configurations: DraftConfiguration[]; next: number }

export function savedState(draft: EditorDraft, selected: string | null, tab: Tab): SavedEditorState {
  return { v: 1, capability: draft.capability, base: draft.base, selected, tab, configurations: clone(draft.configurations), next: draft.next };
}

/**
 * A draft the page kept (webview state), adopted only for the same capability and the same declared
 * block, and only after every entry passes the same checks a new one does; anything else is null.
 */
export function adoptSavedState(raw: unknown, capability: string, block: DeclaredBlock): { draft: EditorDraft; selected: string | null; tab: Tab } | null {
  const saved = record(raw);
  if (!saved || saved.v !== 1 || saved.capability !== capability || saved.base !== blockFingerprint(block) || !Array.isArray(saved.configurations)) return null;
  const configurations: DraftConfiguration[] = [];
  for (const item of saved.configurations) {
    const configuration = record(item);
    const key = text(configuration?.key);
    const origin = configuration?.origin === null ? null
      : typeof configuration?.origin === 'number' && Number.isInteger(configuration.origin) && block.start[configuration.origin] ? configuration.origin : undefined;
    const entry = record(configuration?.entry);
    if (!key || !/^c\d{1,6}$/.test(key) || origin === undefined || !entry || configurations.some((other) => other.key === key)) return null;
    const checked = sanitizedEntry(entry);
    if (checked.refusal || checked.dropped.length) return null;
    configurations.push({ key, origin, entry: clone(entry) });
  }
  const next = typeof saved.next === 'number' && Number.isInteger(saved.next) && saved.next > 0 && saved.next < 1_000_000 ? saved.next : configurations.length + 1;
  const selected = text(saved.selected) && configurations.some((configuration) => configuration.key === saved.selected) ? String(saved.selected) : configurations[0]?.key ?? null;
  const tab = typeof saved.tab === 'string' ? saved.tab : 'base';
  return { draft: { capability, base: String(saved.base), configurations, next }, selected, tab };
}

const hasControl = (value: unknown): boolean => typeof value === 'string' ? CONTROL.test(value)
  : Array.isArray(value) ? value.some(hasControl) : record(value) ? Object.entries(record(value)!).some(([key, item]) => CONTROL.test(key) || hasControl(item)) : false;

/**
 * An entry from outside the form (an import, a kept page state): it must have an ID and a known type,
 * and no secret value anywhere. A secret-looking `env` value is dropped (its name is reported); a
 * secret in an argument list refuses the entry, as it cannot be kept as written.
 */
export function sanitizedEntry(raw: Entry): { entry: Entry; dropped: string[]; refusal: string | null } {
  const entry = clone(raw);
  const dropped: string[] = [];
  const id = text(entry.id);
  if (!id || !START_ID.test(id)) return { entry, dropped, refusal: 'It has no lower-kebab ID.' };
  if (!typeOf(entry)) return { entry, dropped, refusal: `Its type ${JSON.stringify(entry.type)} is not one VS Code edits.` };
  if (hasControl(entry)) return { entry, dropped, refusal: 'It holds control characters.' };
  const scrubEnv = (container: Entry) => {
    const env = record(container.env);
    if (!env) return;
    for (const [name, value] of Object.entries(env)) {
      if (looksSecretName(name) || looksSecretValue(value)) { delete env[name]; dropped.push(name); }
    }
    if (!Object.keys(env).length) delete container.env;
  };
  scrubEnv(entry);
  for (const own of Object.values(record(entry.perEnvironment) ?? {})) if (record(own)) scrubEnv(record(own)!);
  const lists: unknown[] = [];
  const collect = (container: Entry) => {
    for (const [key, value] of Object.entries(container)) {
      if (key === 'env' || key === 'perEnvironment' || key === 'environments') continue;
      if (Array.isArray(value) && value.every((item) => typeof item === 'string')) lists.push(value);
      if (key === 'beforeLaunch' && Array.isArray(value)) for (const step of value) lists.push(record(step)?.argv ?? []);
      if (key === 'arguments' && record(value)) lists.push(...Object.values(record(value)!));
      if (key === 'properties' && record(value)) lists.push(Object.entries(record(value)!).map(([name, given]) => `-D${name}=${String(given)}`));
    }
  };
  collect(entry);
  for (const own of Object.values(record(entry.perEnvironment) ?? {})) if (record(own)) collect(record(own)!);
  for (const list of lists) {
    const secret = Array.isArray(list) ? secretInArguments(list.map(String)) : null;
    if (secret) return { entry, dropped, refusal: `An argument looks like it carries ${secret === 'a value' ? 'a secret value' : `the value of ${secret}`}; it cannot be kept as written.` };
  }
  return { entry, dropped, refusal: null };
}

// ---------------------------------------------------------------------------------------------
// Import from IDE run configurations (`app suggest --json`, typed)

export interface ImportCandidate {
  index: number;
  label: string;
  description: string;
  detail: string;
  entry: Entry | null;
  refusal: string | null;
  /** Variables whose values were dropped as secrets: bound privately with env bind instead. */
  dropped: string[];
  secrets: string[];
}

/**
 * `app suggest --capability <ID> --json`, typed: each suggestion's entry as the engine drafted it in
 * `applicationDraft` (validated there), else its `start`. An entry that is not a typed configuration
 * VS Code edits, or that carries a secret in an argument, is listed with why and cannot be picked.
 */
export function importCandidatesFrom(raw: unknown): { capability: string | null; candidates: ImportCandidate[]; environmentsDraft: string | null; environmentsNote: string | null } {
  const answer = record(unwrapResult(raw)) ?? {};
  if (answer.resultType !== undefined && answer.resultType !== 'sflow-app-suggestions') return { capability: null, candidates: [], environmentsDraft: null, environmentsNote: null };
  let drafted: Entry[] = [];
  if (typeof answer.applicationDraft === 'string' && answer.applicationDraft.trim()) {
    try { drafted = (record(YAML.parse(answer.applicationDraft))?.start as unknown[] ?? []).flatMap((entry) => record(entry) ? [record(entry)!] : []); } catch { drafted = []; }
  }
  const candidates = (Array.isArray(answer.suggestions) ? answer.suggestions : []).flatMap((item, index): ImportCandidate[] => {
    const suggestion = record(item);
    const start = record(suggestion?.start);
    if (!suggestion || !start) return [];
    const source = record(suggestion.source) ?? {};
    const own = drafted.find((entry) => entry.id === start.id) ?? start;
    const { entry, dropped, refusal } = sanitizedEntry(own);
    const type = typeOf(entry);
    const name = text(source.name) && !CONTROL.test(String(source.name)) ? String(source.name) : null;
    const secrets = (Array.isArray(suggestion.environmentNames) ? suggestion.environmentNames : []).flatMap((value) => {
      const variable = record(value);
      return variable && typeof variable.name === 'string' && VARIABLE.test(variable.name) && (variable.kind === 'secret' || looksSecretName(variable.name)) ? [variable.name] : [];
    });
    return [{
      index, label: name ?? String(start.id ?? `suggestion ${index + 1}`),
      description: [type ? TYPE_SPECS[type].label : null, SOURCE_WORDS[String(source.kind ?? 'detected')] ?? null].filter(Boolean).join(' · '),
      detail: repositoryRelative(source.file) ?? '', entry: refusal ? null : entry, refusal, dropped, secrets: [...new Set(secrets)]
    }];
  });
  const checked = checkedEnvironmentsDraft(typeof answer.environmentsDraft === 'string' && answer.environmentsDraft.trim() ? answer.environmentsDraft : null);
  return { capability: text(answer.capability), candidates, environmentsDraft: checked.draft, environmentsNote: checked.note };
}

/** An imported entry: a free ID, and a name when the IDE gave one. */
export function importedEntry(candidate: ImportCandidate, taken: readonly string[]): Entry {
  const entry = clone(candidate.entry ?? {});
  entry.id = uniqueId(String(entry.id ?? candidate.label), taken);
  if (entry.name === undefined && candidate.label !== entry.id) entry.name = candidate.label;
  return entry;
}

// ---------------------------------------------------------------------------------------------
// `app config preview --application-file FILE --json`

export interface PreviewEnvironment {
  name: string | null;
  default: boolean;
  argv: string[] | null;
  /** The command line to show: masked where an argument looks secret. */
  commandLine: string | null;
  envNames: string[];
  beforeLaunch: string[];
}

export interface PreviewError { index: number | null; environment: string | null; field: string | null; path: string | null; message: string }
export interface ConfigPreview { valid: boolean; entries: Array<{ index: number; id: string | null; environments: PreviewEnvironment[] }>; errors: PreviewError[] }

/** `app config preview --capability <ID> --application-file <FILE> --json`: a read; nothing is written. */
export function configPreviewArgv(capability: string, file: string): string[] {
  if (!CAPABILITY.test(capability)) throw new Error(`Capability is invalid: ${capability}`);
  return ['app', 'config', 'preview', '--capability', capability, '--application-file', file, '--json'];
}

/** An error location: `start[2].perEnvironment.qa.vmOptions[1]`, `start[0].ready.http`, `start[1].env.FOO`. */
export function errorLocation(path: string): { index: number | null; environment: string | null; field: string | null } {
  const match = /^(?:application\.)?start\[(\d+)\](?:\.(.*))?$/.exec(path.trim());
  if (!match) return { index: null, environment: null, field: null };
  const index = Number(match[1]);
  const rest = (match[2] ?? '').split('.').filter(Boolean);
  const head = (part: string | undefined) => part?.replace(/\[\d+\]$/, '') ?? null;
  if (rest[0] === 'perEnvironment' && rest[1]) return { index, environment: rest[1], field: head(rest[2]) };
  if (rest[0] === 'arguments' && rest[1]) return { index, environment: head(rest[1]), field: 'appended' };
  if (rest[0] === 'ready' && rest[1]) return { index, environment: null, field: rest[1] === 'timeoutMs' ? 'ready.timeout' : 'ready.value' };
  if (rest[0] === 'debug' && rest[1]) return { index, environment: null, field: `debug.${head(rest[1])}` };
  return { index, environment: null, field: head(rest[0]) };
}

function previewErrors(value: unknown, index: number | null = null): PreviewError[] {
  return (Array.isArray(value) ? value : []).flatMap((item): PreviewError[] => {
    const error = record(item);
    const message = text(error?.message) ?? (typeof item === 'string' ? item : null);
    if (!message || CONTROL.test(message.replace(/\n/g, ' '))) return [];
    const path = text(error?.path);
    const located = path ? errorLocation(path) : { index: null, environment: null, field: null };
    const environment = text(error?.environment) && ENVIRONMENT.test(String(error!.environment)) ? String(error!.environment) : located.environment;
    return [{ index: located.index ?? index, environment, field: text(error?.field) ?? located.field, path, message }];
  });
}

const commandLine = (argv: string[]): string => lineFromArgv(maskedArgv(argv));

/** The engine's preview, read field by field; the shape the amendment gives ("per entry and environment"). */
export function configPreviewFrom(raw: unknown): ConfigPreview | null {
  const answer = record(unwrapResult(raw));
  if (!answer || answer.resultType !== undefined && answer.resultType !== 'sflow-app-config-preview') return null;
  const errors = previewErrors(answer.errors);
  const entries = (Array.isArray(answer.entries) ? answer.entries : []).flatMap((item, position) => {
    const entry = record(item);
    if (!entry) return [];
    const index = typeof entry.index === 'number' && Number.isInteger(entry.index) ? entry.index : position;
    errors.push(...previewErrors(entry.errors, index));
    const listed = Array.isArray(entry.environments) && entry.environments.length ? entry.environments : [{ name: null, resolved: entry.resolved }];
    const environments = listed.flatMap((value): PreviewEnvironment[] => {
      const environment = record(value);
      if (!environment) return [];
      const name = text(environment.name) && ENVIRONMENT.test(String(environment.name)) ? String(environment.name) : null;
      errors.push(...previewErrors(environment.errors, index).map((error) => ({ ...error, environment: error.environment ?? name })));
      const resolved = record(environment.resolved) ?? environment;
      const argv = Array.isArray(resolved.argv) && resolved.argv.length && resolved.argv.every((part) => typeof part === 'string' && !CONTROL.test(part)) ? resolved.argv as string[] : null;
      const steps = (Array.isArray(resolved.beforeLaunch) ? resolved.beforeLaunch : []).flatMap((step) => {
        const list = Array.isArray(step) ? step : record(step)?.argv;
        return Array.isArray(list) && list.every((part) => typeof part === 'string' && !CONTROL.test(part)) ? [commandLine(list as string[])] : [];
      });
      return [{
        name, default: environment.default === true, argv, commandLine: argv ? commandLine(argv) : null,
        envNames: (Array.isArray(resolved.envNames) ? resolved.envNames : []).filter((value): value is string => typeof value === 'string' && VARIABLE.test(value)),
        beforeLaunch: steps
      }];
    });
    return [{ index, id: text(entry.id), environments }];
  });
  return { valid: answer.valid === false ? false : !errors.length, entries, errors };
}

/**
 * A refused preview (the CLI exits non-zero for an invalid block): its located errors when the
 * refusal carries them (`error.details.errors`, or `errors`), else null and the message is shown.
 */
export function previewFromRefusal(result: unknown): ConfigPreview | null {
  const answer = record(result);
  const details = record(record(answer?.error)?.details);
  const errors = previewErrors(details?.errors ?? answer?.errors);
  if (!errors.length) return answer && Array.isArray(answer.entries) ? configPreviewFrom(answer) : null;
  return { valid: false, entries: [], errors };
}

// ---------------------------------------------------------------------------------------------
// Review and write

/** A line diff of two YAML texts: '  ' kept, '- ' removed, '+ ' added. Every line is shown. */
export function yamlDiff(before: string, after: string): string[] {
  const a = before.replace(/\n$/, '').split('\n');
  const b = after.replace(/\n$/, '').split('\n');
  if (!before.trim()) return b.map((line) => `+ ${line}`);
  if (a.length * b.length > 4_000_000) return [...a.map((line) => `- ${line}`), ...b.map((line) => `+ ${line}`)];
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  }
  const lines: string[] = [];
  let i = 0; let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { lines.push(`  ${a[i]}`); i += 1; j += 1; }
    else if (i < a.length && (j >= b.length || table[i + 1]![j]! >= table[i]![j + 1]!)) { lines.push(`- ${a[i]}`); i += 1; }
    else { lines.push(`+ ${b[j]}`); j += 1; }
  }
  return lines;
}

/** What changed, entry by entry: added, changed, removed, kept, and whether the order moved. */
export function draftChanges(draft: EditorDraft, block: DeclaredBlock): { added: string[]; changed: string[]; removed: string[]; kept: string[]; reordered: boolean } {
  const label = (entry: Entry) => String(entry.id ?? '?');
  const origins = draft.configurations.map((configuration) => configuration.origin).filter((origin): origin is number => origin !== null);
  return {
    added: draft.configurations.filter((configuration) => configuration.origin === null).map((configuration) => label(configuration.entry)),
    changed: draft.configurations.filter((configuration) => configuration.origin !== null && isModified(configuration, block)).map((configuration) => label(configuration.entry)),
    removed: block.start.filter((_entry, index) => !origins.includes(index)).map(label),
    kept: draft.configurations.filter((configuration) => configuration.origin !== null && !isModified(configuration, block)).map((configuration) => label(configuration.entry)),
    reordered: origins.some((origin, index) => index > 0 && origin < origins[index - 1]!)
  };
}

/** The review page: what changes, the YAML diff of the whole block, and the exact command. */
export function configurationsReviewRequest(input: { capability: string; draft: EditorDraft; block: DeclaredBlock; route: ApplicationRoute }): ReviewConfirmationRequest {
  const { capability, draft, block, route } = input;
  const before = applicationBlockYaml(declaredBlockValue(block));
  const after = applicationBlockYaml(blockFrom(draft, block));
  const changes = draftChanges(draft, block);
  const list = (values: string[]) => values.length ? values.join(', ') : 'none';
  return {
    title: route.kind === 'proposal' ? `Propose run configurations for ${capability}` : `Save run configurations for ${capability}`,
    summary: route.kind === 'proposal'
      ? 'The capability\'s application block becomes the block below, through a reviewed capability proposal. Its review page shows the resulting singularity/capabilities.yml before anything is approved.'
      : route.kind === 'personal' ? 'Save personal start settings for this checkout only. Team configuration and the pinned test selection stay unchanged.'
      : 'The capability\'s application block in singularity/capabilities.yml in this checkout becomes the block below, as a local authoring change: nothing is proposed or committed.',
    detail: [
      `Capability: ${capability}`,
      `Added: ${list(changes.added)}`,
      `Changed: ${list(changes.changed)}`,
      `Removed: ${list(changes.removed)}`,
      `Kept as they are: ${list(changes.kept)}${changes.reordered ? ' (the order changed)' : ''}`,
      `Tests already declared, kept as they are: ${block.tests ? block.tests.length : 'none'}`,
      route.kind === 'proposal' ? `Proposed to: ${route.lead}` : route.kind === 'personal' ? 'Written to: this checkout’s private run settings on this laptop' : 'Written to: singularity/capabilities.yml in this checkout',
      'Secrets are not in this block: they are names in singularity/environments.yml, bound privately on each computer with singularity-flow env bind <ENVIRONMENT> --stdin.',
      '',
      route.kind === 'personal' ? 'Changes to personal start settings (- removed, + added). Only start entries are saved privately for this checkout; tests are checked for consistency and stay unchanged.' : 'Application block, as a difference from what is declared now (- removed, + added). The whole block is written: VS Code writes the new block to a private temporary file, passes it to the command below, then deletes the file.',
      ...yamlDiff(before, after),
      '',
      `VS Code runs: ${displayCommand(applicationWriteArgv(route, capability, TEMPORARY_FILE_WORDS))}`
    ].join('\n'),
    confirmLabel: route.kind === 'proposal' ? 'Propose these run configurations' : 'Save these run configurations'
  };
}

/** Why the draft cannot be written as it stands, before any review; null when it can. */
export function applyProblem(draft: EditorDraft, block: DeclaredBlock, preview: ConfigPreview | null): string | null {
  if (!block.known) return 'This Singularity Flow does not report the declared application block in app plan, so writing the whole block could drop its tests. Update Singularity Flow to save run configurations here.';
  const seen = new Set<string>();
  for (const configuration of draft.configurations) {
    const id = String(configuration.entry.id ?? '');
    if (!START_ID.test(id)) return 'Every configuration needs a lower-kebab ID.';
    if (seen.has(id)) return `Two configurations are called ${id}. Give each its own ID.`;
    seen.add(id);
  }
  if (draft.configurations.length > 32) return 'A capability declares at most 32 run configurations.';
  if (preview && preview.errors.length) return `Fix the ${preview.errors.length === 1 ? 'error' : `${preview.errors.length} errors`} the command line preview shows first.`;
  return null;
}
