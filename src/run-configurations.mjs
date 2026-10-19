/**
 * Typed run configurations [RUN amendment "IntelliJ-style run configurations" §1].
 *
 * A start entry with a `type` other than `command` is built from its own fields, the way IntelliJ,
 * PyCharm, WebStorm, GoLand and Rider build a run configuration: a Spring Boot entry names its main
 * class, VM options, program arguments and profiles; a Python entry its script or module and its
 * interpreter. This module checks those fields (every error located at its field), detects what the
 * checkout provides (a Maven or Gradle wrapper, a project interpreter, a lock file), and resolves an
 * entry, per environment, to what app start runs: an argv, the variables set for the application
 * process only, the before-launch steps, and the private files a run needs (a Gradle init script
 * that carries VM options, profiles and a main class to the JavaExec task).
 *
 * Precedence, per environment: `perEnvironment.<ENV>` fields replace the base fields (a list
 * replaces the whole list), its `env` merges into the base `env` by name (the environment's value
 * wins) and its `beforeLaunch` replaces the base steps; then that environment's `arguments` are
 * appended last to the resolved command line. Values bound for the environment (environments.yml)
 * win over a literal `env` value of the same name.
 *
 * Paths in fields (jar, script, manage, project, a repository interpreter, a Go file or directory)
 * are repository-relative like workingDirectory, without `..`; the command line names them from the
 * working directory.
 *
 * Plain `argv` entries are type `command`: they resolve to argv plus that environment's arguments,
 * exactly as before, and their command identity is unchanged. capabilities.mjs checks the fields
 * every entry shares; it does not import this module, so the lifecycle commands and the VS Code
 * bundles do not carry it. It is loaded where the application block is read for app and tests
 * commands, by capability set|edit --application-file and by app config preview.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { resolveDebugLaunch } from './application-debug.mjs';
import {
  applicationArguments, applicationDebug, applicationStartArgv, applicationStartCommandSha256, debuggerListeners, normalizeCapabilityApplication
} from './capabilities.mjs';
import { declarableEnvironmentVariable } from './environment-declaration.mjs';
import { recordSha256 } from './records.mjs';
import { classifyVariable, looksSecretValue } from './secret-looking.mjs';
import { SingularityFlowError } from './util.mjs';

const CONTROL = /[\u0000-\u001f\u007f]/u;
const ENVIRONMENT_ID = /^(?=.{1,64}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const SHARED_KEYS = Object.freeze(['id', 'name', 'type', 'repository', 'workingDirectory', 'url', 'ready', 'environments', 'arguments', 'debug',
  'env', 'beforeLaunch', 'perEnvironment']);
const STEP_KEYS = Object.freeze(['argv', 'workingDirectory', 'timeoutMs']);
export const BEFORE_LAUNCH_TIMEOUT_MS = Object.freeze({ minimum: 1_000, maximum: 1_800_000, default: 600_000 });
const SECRET_OPTION_NAME = /pass(?:word|wd|phrase)?|secret|token|credential|api[-_.]?key|private[-_.]?key|access[-_.]?key/iu;
const HOSTS = Object.freeze(['127.0.0.1', 'localhost', '::1']);
/** The placeholder a private file's directory has where no run record exists (the hash, a suggestion). */
export const PRIVATE_DIRECTORY_PLACEHOLDER = '<private>';

/**
 * Each type's fields, by kind, and the runtime its debugger is. A kind is an enum (a list of
 * values) or one of the checks below. `required` fields must be set in the base or in every
 * environment's override.
 */
export const RUN_CONFIGURATION_TYPES = Object.freeze({
  'spring-boot': { runtime: 'java', fields: { launcher: ['maven', 'gradle'], mainClass: 'javaClass', vmOptions: 'arguments', programArguments: 'arguments', activeProfiles: 'names' } },
  jar: { runtime: 'java', required: ['jar'], fields: { jar: 'path', vmOptions: 'arguments', programArguments: 'arguments' } },
  application: { runtime: 'java', fields: { launcher: ['maven-exec', 'gradle-run'], mainClass: 'javaClass', vmOptions: 'arguments', programArguments: 'arguments' } },
  maven: { runtime: 'java', required: ['goals'], fields: { goals: 'goals', profiles: 'names', properties: 'properties', arguments: 'arguments' } },
  gradle: { runtime: 'java', required: ['tasks'], fields: { tasks: 'goals', properties: 'properties', arguments: 'arguments' } },
  python: { runtime: 'python', fields: { script: 'path', module: 'pythonModule', interpreter: 'executable', interpreterOptions: 'arguments', parameters: 'arguments' } },
  django: { runtime: 'python', fields: { manage: 'path', host: 'host', port: 'port', settings: 'pythonModule', noReload: 'boolean', interpreter: 'executable', interpreterOptions: 'arguments', parameters: 'arguments' } },
  fastapi: { runtime: 'python', required: ['app'], fields: { app: 'asgiApp', host: 'host', port: 'port', reload: 'boolean', interpreter: 'executable', interpreterOptions: 'arguments', parameters: 'arguments' } },
  flask: { runtime: 'python', required: ['app'], fields: { app: 'flaskApp', host: 'host', port: 'port', reload: 'boolean', interpreter: 'executable', interpreterOptions: 'arguments', parameters: 'arguments' } },
  node: { runtime: 'node', required: ['script'], fields: { script: 'path', nodeOptions: 'arguments', applicationParameters: 'arguments', nodeInterpreter: 'executable' } },
  npm: { runtime: 'node', required: ['script'], fields: { packageManager: ['npm', 'pnpm', 'yarn'], script: 'word', arguments: 'arguments' } },
  go: { runtime: 'go', fields: { kind: ['package', 'file', 'directory'], target: 'goTarget', goToolArguments: 'arguments', programArguments: 'arguments' } },
  dotnet: { runtime: 'dotnet', fields: { project: 'path', launchProfile: 'text', configuration: 'word', arguments: 'arguments' } },
  command: { runtime: null, required: ['argv'], fields: { argv: 'argv' } }
});
export const RUN_CONFIGURATION_TYPE_NAMES = Object.freeze(Object.keys(RUN_CONFIGURATION_TYPES));

function argumentProblem(value, { minimum = 0, maximum = 64 } = {}) {
  if (typeof value === 'string') return 'must be a list of arguments, not a shell string; no shell runs it.';
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum
      || value.some((entry) => typeof entry !== 'string' || !entry || entry.length > 4_096 || CONTROL.test(entry))) {
    return `must be a list of ${minimum ? `${minimum} to ` : 'at most '}${maximum} non-empty strings without control characters.`;
  }
  return null;
}

function repositoryPathProblem(value) {
  if (typeof value !== 'string' || !value || value.length > 1_024 || CONTROL.test(value) || value.includes('\\') || value.startsWith('/')
      || /^[A-Za-z]:/u.test(value) || value.split('/').includes('..') || value.startsWith('-')) {
    return 'must be a repository-relative path without \'..\'.';
  }
  return null;
}

const KINDS = Object.freeze({
  arguments: (value) => argumentProblem(value),
  argv: (value) => argumentProblem(value, { minimum: 1, maximum: 256 }),
  goals: (value) => (Array.isArray(value) && value.length >= 1 && value.length <= 32
    && value.every((entry) => typeof entry === 'string' && /^[^\s-][^\s]{0,255}$/u.test(entry) && !CONTROL.test(entry))
    ? null : 'must list 1 to 32 goals or tasks, each one word that does not start with -; options go in arguments.'),
  names: (value) => (Array.isArray(value) && value.length <= 32 && value.every((entry) => typeof entry === 'string' && /^[A-Za-z0-9][\w.-]{0,63}$/u.test(entry))
    ? null : 'must be a list of at most 32 names (letters, digits, ., _ and -).'),
  properties: (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 64) return 'must map at most 64 property names to values.';
    for (const [name, entry] of Object.entries(value)) {
      if (!/^[A-Za-z_][\w.-]{0,127}$/u.test(name)) return `names '${name}', which is not a property name.`;
      if (!['string', 'number', 'boolean'].includes(typeof entry) || String(entry).length > 4_096 || CONTROL.test(String(entry))) {
        return `.${name} must be text, a number or true/false, without control characters.`;
      }
    }
    return null;
  },
  path: repositoryPathProblem,
  executable: (value) => (typeof value === 'string' && /^[A-Za-z0-9][\w.+-]{0,63}$/u.test(value) ? null
    : typeof value === 'string' && value.includes('/') && !repositoryPathProblem(value) ? null
      : 'must name a command on PATH (such as python3) or a repository-relative path; an interpreter outside the repository is machine-specific.'),
  javaClass: (value) => (typeof value === 'string' && value.length <= 512 && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u.test(value)
    ? null : 'must be a Java class name such as com.example.api.ApiApplication.'),
  pythonModule: (value) => (typeof value === 'string' && value.length <= 256 && /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/u.test(value)
    ? null : 'must be a Python module name such as app.main.'),
  asgiApp: (value) => (typeof value === 'string' && value.length <= 256 && /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/u.test(value)
    ? null : 'must be module:attribute, such as app.main:app.'),
  flaskApp: (value) => (typeof value === 'string' && value.length <= 256
    && /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?::[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\(\))?)?$/u.test(value)
    ? null : 'must be a module, module:attribute or module:factory(), such as app:create_app().'),
  host: (value) => (HOSTS.includes(value) ? null : 'must be 127.0.0.1, localhost or ::1: a local run listens on loopback only.'),
  port: (value) => (Number.isInteger(value) && value >= 1 && value <= 65_535 ? null : 'must be a port number from 1 to 65535.'),
  boolean: (value) => (typeof value === 'boolean' ? null : 'must be true or false.'),
  word: (value) => (typeof value === 'string' && /^[^\s-][^\s]{0,255}$/u.test(value) && !CONTROL.test(value)
    ? null : 'must be one word that does not start with -.'),
  text: (value) => (typeof value === 'string' && value.length <= 256 && /^[^\s-]/u.test(value) && !CONTROL.test(value)
    ? null : 'must be text of at most 256 characters that does not start with - or a space.'),
  goTarget: (value) => (typeof value === 'string' && /^[^\s-][^\s]{0,1023}$/u.test(value) && !CONTROL.test(value)
    ? null : 'must be a Go package, file or directory that does not start with -.')
});

function kindProblem(kind, value) {
  if (Array.isArray(kind)) return kind.includes(value) ? null : `must be one of: ${kind.join(', ')}.`;
  return KINDS[kind](value);
}

/** A list argument that carries a secret: a value that looks like one, or name=value with a secret name. */
function secretArgument(token) {
  const text = String(token);
  const assignment = text.match(/^-{0,2}D?([A-Za-z_][\w.-]*)=(.*)$/su);
  const value = assignment ? assignment[2] : text;
  // ${NAME} or $NAME reads the value from the environment at run time; it is not the value.
  if (/^\$\{[A-Za-z_][\w.-]*\}$|^\$[A-Za-z_]\w*$/u.test(value)) return false;
  return (assignment && SECRET_OPTION_NAME.test(assignment[1]) && value.length > 0) || looksSecretValue(value);
}

const SECRET_WORDS = 'looks like it carries a secret; capabilities.yml never holds one. Declare it as a secret in singularity/environments.yml, bind it with env bind <ENV> --stdin, and read it from the environment.';

function checkFields(type, fields, at, problems) {
  const definition = RUN_CONFIGURATION_TYPES[type];
  for (const [name, value] of Object.entries(fields)) {
    const kind = definition.fields[name];
    if (!kind) continue;
    const problem = kindProblem(kind, value);
    if (problem) { problems.push({ field: `${at}${name}`, message: problem }); continue; }
    const tokens = kind === 'arguments' || kind === 'argv' ? value
      : kind === 'properties' ? Object.entries(value).map(([key, entry]) => `-D${key}=${entry}`) : [];
    const secret = tokens.findIndex(secretArgument);
    if (secret !== -1) problems.push({ field: `${at}${name}${kind === 'properties' ? '' : `[${secret}]`}`, message: SECRET_WORDS });
    const { refusals } = debuggerListeners(tokens);
    if (refusals.length) problems.push({ field: `${at}${name}`, message: refusals[0] });
  }
}

/** Rules between fields, checked on the fields one environment runs with. */
function crossFieldProblems(type, fields, at, entryUrl) {
  const problems = [];
  if (type === 'application' && fields.launcher !== 'gradle-run' && fields.mainClass == null) {
    problems.push({ field: `${at}mainClass`, message: 'is required unless launcher is gradle-run: exec:java runs that class.' });
  }
  if (type === 'python' && (fields.script == null) === (fields.module == null)) {
    problems.push({ field: `${at}${fields.script == null ? 'script' : 'module'}`, message: 'a python entry runs either a script or a module: set exactly one.' });
  }
  if (type === 'go' && ['file', 'directory'].includes(fields.kind) && fields.target != null) {
    const problem = repositoryPathProblem(fields.target);
    if (problem) problems.push({ field: `${at}target`, message: `${problem.replace(/\.$/u, '')} for kind ${fields.kind}.` });
  }
  if (type === 'go' && ['file', 'directory'].includes(fields.kind) && fields.target == null) {
    problems.push({ field: `${at}target`, message: `is required for kind ${fields.kind}.` });
  }
  if (['django', 'fastapi', 'flask'].includes(type) && fields.port != null && Number.isInteger(fields.port)) {
    const url = safeUrl(entryUrl);
    const served = url ? Number(url.port || (url.protocol === 'https:' ? 443 : 80)) : null;
    if (served != null && served !== fields.port) {
      problems.push({ field: `${at}port`, message: `${fields.port} is not the url's port ${served}; readiness asks the url, so make them one port.` });
    }
  }
  return problems;
}

function safeUrl(value) {
  try { return new URL(String(value)); } catch { return null; }
}

function envProblems(value, at) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 64) {
    return [{ field: at.replace(/\.$/u, ''), message: 'must map at most 64 variable names to literal values.' }];
  }
  const problems = [];
  for (const [name, raw] of Object.entries(value)) {
    const field = `${at}${name}`;
    if (!declarableEnvironmentVariable(name)) {
      problems.push({ field, message: 'is not a variable a start entry may set: names are UPPER_CASE, and PATH, HOME, NODE_*, GIT_*, LD_*, DYLD_*, proxy and other reserved names are refused.' });
      continue;
    }
    if (!['string', 'number', 'boolean'].includes(typeof raw) || String(raw).length > 4_096 || CONTROL.test(String(raw))) {
      problems.push({ field, message: 'must be literal text, a number or true/false, without control characters.' });
      continue;
    }
    if (classifyVariable(name, String(raw)).kind === 'secret') { problems.push({ field, message: SECRET_WORDS }); continue; }
    const { refusals } = debuggerListeners([String(raw)]);
    if (refusals.length) problems.push({ field, message: refusals[0] });
  }
  return problems;
}

function stepProblems(value, at) {
  if (!Array.isArray(value) || value.length > 8) return [{ field: at, message: 'must be a list of at most 8 steps, each { argv, workingDirectory?, timeoutMs? }.' }];
  const problems = [];
  for (const [index, step] of value.entries()) {
    const field = `${at}[${index}]`;
    if (!step || typeof step !== 'object' || Array.isArray(step)) { problems.push({ field, message: 'must be an object with argv.' }); continue; }
    const unknown = Object.keys(step).filter((key) => !STEP_KEYS.includes(key)).sort();
    if (unknown.length) problems.push({ field, message: `contains unsupported field(s): ${unknown.join(', ')}.` });
    const argv = argumentProblem(step.argv, { minimum: 1, maximum: 256 });
    if (argv) problems.push({ field: `${field}.argv`, message: argv });
    else {
      const secret = step.argv.findIndex(secretArgument);
      if (secret !== -1) problems.push({ field: `${field}.argv[${secret}]`, message: SECRET_WORDS });
      const { refusals } = debuggerListeners(step.argv);
      if (refusals.length) problems.push({ field: `${field}.argv`, message: refusals[0] });
    }
    if (step.workingDirectory != null && repositoryPathProblem(step.workingDirectory) && step.workingDirectory !== '.') {
      problems.push({ field: `${field}.workingDirectory`, message: 'must be repository-relative without \'..\'.' });
    }
    if (step.timeoutMs != null && (!Number.isInteger(step.timeoutMs) || step.timeoutMs < BEFORE_LAUNCH_TIMEOUT_MS.minimum
        || step.timeoutMs > BEFORE_LAUNCH_TIMEOUT_MS.maximum)) {
      problems.push({ field: `${field}.timeoutMs`, message: 'must be an integer from 1000 to 1800000.' });
    }
  }
  return problems;
}

/** A capabilities.mjs refusal, as `{ field, message }` within one start entry. */
export function locatedApplicationError(error) {
  const match = String(error?.message ?? '').match(/^Capability '[^']*'\.application (?:start\[\d+\](?:\.|:|\s)?)?(\S*?):?\s(.*)$/su);
  if (!match) return { field: '', message: String(error?.message ?? error) };
  const [, field, message] = match;
  return /^(?:must|contains|names|is|takes|declares|listens|may)$/u.test(field) ? { field: '', message: `${field} ${message}` } : { field, message };
}

/**
 * Every problem with the fields capabilities.mjs leaves to this module, located at its field:
 * the type and its fields, name, env, beforeLaunch, perEnvironment, and for a typed entry its
 * arguments and debug block. The shared fields (id, repository, workingDirectory, url, ready,
 * environments) are capabilities.mjs's to check.
 */
export function runConfigurationErrors(raw, { capabilityId = 'capability', index = 0 } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const problems = [];
  const type = raw.type ?? 'command';
  if (typeof type !== 'string' || !RUN_CONFIGURATION_TYPES[type]) {
    return [{ field: 'type', message: `must be one of: ${RUN_CONFIGURATION_TYPE_NAMES.join(', ')}.` }];
  }
  const definition = RUN_CONFIGURATION_TYPES[type];
  const typed = type !== 'command';
  const listArguments = typed && Object.hasOwn(definition.fields, 'arguments') && Array.isArray(raw.arguments);
  if (typed) {
    const unknown = Object.keys(raw).filter((key) => !SHARED_KEYS.includes(key) && !Object.hasOwn(definition.fields, key)).sort();
    if (unknown.includes('argv')) problems.push({ field: 'argv', message: `belongs to type command; a ${type} entry is built from its fields (see app config preview for its command line).` });
    const others = unknown.filter((key) => key !== 'argv');
    if (others.length) problems.push({ field: '', message: `contains field(s) type ${type} does not take: ${others.join(', ')}. It takes: ${Object.keys(definition.fields).join(', ')}.` });
  }
  if (raw.name != null && (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 128 || CONTROL.test(raw.name))) {
    problems.push({ field: 'name', message: 'must be text of 1 to 128 characters on one line.' });
  }
  const environments = Array.isArray(raw.environments) ? raw.environments.filter((entry) => typeof entry === 'string') : [];
  const own = Object.fromEntries(Object.entries(raw).filter(([key]) => typed ? Object.hasOwn(definition.fields, key) && !(key === 'arguments' && !listArguments) : false));
  if (typed) checkFields(type, own, '', problems);
  if (raw.env != null) problems.push(...envProblems(raw.env, 'env.'));
  if (raw.beforeLaunch != null) problems.push(...stepProblems(raw.beforeLaunch, 'beforeLaunch'));
  const overrides = {};
  if (raw.perEnvironment != null) {
    if (!raw.perEnvironment || typeof raw.perEnvironment !== 'object' || Array.isArray(raw.perEnvironment)) {
      problems.push({ field: 'perEnvironment', message: 'must map an environment to the fields it overrides.' });
    } else {
      for (const [environment, override] of Object.entries(raw.perEnvironment)) {
        const at = `perEnvironment.${environment}`;
        if (!ENVIRONMENT_ID.test(environment) || !environments.includes(environment)) {
          problems.push({ field: at, message: `names an environment the entry does not list (environments: ${environments.join(', ') || 'none'}).` });
          continue;
        }
        if (!override || typeof override !== 'object' || Array.isArray(override)) {
          problems.push({ field: at, message: 'must be an object of the fields this environment overrides.' });
          continue;
        }
        const allowed = [...Object.keys(definition.fields), 'env', 'beforeLaunch'];
        const unknown = Object.keys(override).filter((key) => !allowed.includes(key)).sort();
        if (unknown.length) problems.push({ field: at, message: `may override only ${allowed.join(', ')}; not ${unknown.join(', ')}.` });
        const fields = Object.fromEntries(Object.entries(override).filter(([key]) => Object.hasOwn(definition.fields, key)));
        checkFields(type, fields, `${at}.`, problems);
        if (override.env != null) problems.push(...envProblems(override.env, `${at}.env.`));
        if (override.beforeLaunch != null) problems.push(...stepProblems(override.beforeLaunch, `${at}.beforeLaunch`));
        overrides[environment] = fields;
      }
    }
  }
  if (!typed) return problems;
  // Required and cross-field rules hold for what each environment runs (the base when none).
  const located = new Set(problems.map((problem) => problem.field));
  for (const environment of environments.length ? environments : [null]) {
    const fields = { ...own, ...(environment ? overrides[environment] ?? {} : {}) };
    const at = environment && Object.keys(overrides[environment] ?? {}).length ? `perEnvironment.${environment}.` : '';
    const missing = (definition.required ?? []).filter((name) => fields[name] == null).map((name) => ({
      field: name, message: `is required for type ${type}${environments.length > 1 && environment ? ` (environment ${environment} has none)` : ''}.` }));
    for (const problem of [...missing, ...crossFieldProblems(type, fields, at, raw.url)]) {
      if (!located.has(problem.field)) { located.add(problem.field); problems.push(problem); }
    }
  }
  // A typed entry's per-environment arguments map and debug block, checked by the shared rules.
  if (raw.arguments != null && !listArguments) {
    try { applicationArguments(capabilityId, raw.arguments, `start[${index}]`, environments, raw.id); } catch (error) { problems.push(locatedApplicationError(error)); }
  }
  // The debug block's port is compared with the url's, which capabilities.mjs reports when invalid.
  if (raw.debug != null && safeUrl(raw.url)) {
    if (raw.debug && typeof raw.debug === 'object' && raw.debug.runtime != null && raw.debug.runtime !== definition.runtime) {
      problems.push({ field: 'debug.runtime', message: `is ${definition.runtime} for type ${type}; leave it out, the type says it.` });
    } else {
      try { typedDebug(capabilityId, raw, index); } catch (error) { problems.push(locatedApplicationError(error)); }
    }
  }
  return problems;
}

function typedDebug(capabilityId, raw, index) {
  if (raw.debug == null) return null;
  const runtime = RUN_CONFIGURATION_TYPES[raw.type].runtime;
  const debug = raw.debug && typeof raw.debug === 'object' && !Array.isArray(raw.debug) ? { runtime, ...raw.debug } : raw.debug;
  return applicationDebug(capabilityId, debug, `start[${index}]`, raw.id, raw.url);
}

function invalid(capabilityId, index, raw, problems) {
  const [first] = problems;
  return new SingularityFlowError(`Capability '${capabilityId}'.application start[${index}]${first.field ? `.${first.field}` : ''} ${first.message}`
    + (problems.length > 1 ? ` (${problems.length - 1} more; app config preview --application-file lists each)` : ''), {
    code: 'CAPABILITY_APPLICATION_INVALID',
    details: { capabilityId, startId: typeof raw?.id === 'string' ? raw.id : null, field: first.field, errors: problems }
  });
}

/** Refuse a start entry whose own fields are invalid, naming the first error and how many more. */
export function assertRunConfiguration(capabilityId, raw, index) {
  const problems = runConfigurationErrors(raw, { capabilityId, index });
  if (problems.length) throw invalid(capabilityId, index, raw, problems);
}

// ---------------------------------------------------------------------------------------------
// What the checkout provides

/** The nearest of `names` from the working directory up to the checkout root, as a repository path. */
function nearest(checkoutRoot, workingDirectory, names) {
  if (!checkoutRoot) return null;
  let directory = workingDirectory === '.' ? '' : workingDirectory;
  for (;;) {
    for (const name of names) {
      const candidate = directory ? `${directory}/${name}` : name;
      if (existsSync(path.join(checkoutRoot, ...candidate.split('/')))) return candidate;
    }
    if (!directory) return null;
    directory = directory.includes('/') ? directory.slice(0, directory.lastIndexOf('/')) : '';
  }
}

function fromWorkingDirectory(workingDirectory, repositoryPath) {
  return path.posix.relative(workingDirectory === '.' ? '' : workingDirectory, repositoryPath) || '.';
}

/** A repository executable as the working directory runs it: ./mvnw, ../../.venv/bin/python. */
function executableFrom(workingDirectory, repositoryPath) {
  const relative = fromWorkingDirectory(workingDirectory, repositoryPath);
  return relative.includes('/') ? relative : `./${relative}`;
}

function targetFrom(workingDirectory, repositoryPath) {
  const relative = fromWorkingDirectory(workingDirectory, repositoryPath);
  return relative === '.' || relative.startsWith('../') ? relative : `./${relative}`;
}

/**
 * What the checkout provides for one typed entry: the Maven and Gradle wrappers (else mvn and
 * gradle), the build a Java entry defaults its launcher from, the project interpreter (else python3)
 * and the package manager a lock file names (else npm). Without a checkout of the entry's
 * repository, the defaults.
 */
export function detectRunFacts(checkoutRoot, entry, { platform = process.platform } = {}) {
  const windows = platform === 'win32';
  const at = entry.workingDirectory;
  const runtime = RUN_CONFIGURATION_TYPES[entry.type]?.runtime;
  const facts = {};
  if (runtime === 'java') {
    const maven = nearest(checkoutRoot, at, [windows ? 'mvnw.cmd' : 'mvnw']);
    const gradle = nearest(checkoutRoot, at, [windows ? 'gradlew.bat' : 'gradlew']);
    facts.maven = maven ? executableFrom(at, maven) : 'mvn';
    facts.gradle = gradle ? executableFrom(at, gradle) : 'gradle';
    const build = nearest(checkoutRoot, at, ['pom.xml', 'build.gradle.kts', 'build.gradle']);
    facts.javaBuild = build && !build.endsWith('pom.xml') ? 'gradle' : 'maven';
  } else if (runtime === 'python') {
    const interpreter = nearest(checkoutRoot, at, windows ? ['.venv/Scripts/python.exe', 'venv/Scripts/python.exe']
      : ['.venv/bin/python', 'venv/bin/python']);
    facts.python = interpreter ? executableFrom(at, interpreter) : windows ? 'python' : 'python3';
  } else if (entry.type === 'npm') {
    const lock = nearest(checkoutRoot, at, ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json']);
    facts.packageManager = lock?.endsWith('pnpm-lock.yaml') ? 'pnpm' : lock?.endsWith('yarn.lock') ? 'yarn' : 'npm';
  }
  return Object.freeze(facts);
}

// ---------------------------------------------------------------------------------------------
// Resolution

/** Arguments joined into one property value, quoting the ones that hold spaces or quotes. */
export function joinArguments(tokens) {
  return tokens.map((token) => (/[\s"]/u.test(token) ? `"${token.replaceAll('"', '\\"')}"` : token)).join(' ');
}

const groovy = (value) => `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

/** A private init script giving the JavaExec task(s) the entry's JVM options and main class, and nothing else. */
export function gradleRunInitScript(tasks, { jvmArgs = [], mainClass = null } = {}) {
  return [
    '// Written by singularity-flow app start for one run and kept below the Git common directory.',
    '// It gives the start entry\'s JavaExec task(s) their JVM options and main class, and changes nothing else.',
    'gradle.allprojects { project ->',
    `  project.tasks.withType(JavaExec).matching { it.name in [${tasks.map(groovy).join(', ')}] }.configureEach { task ->`,
    ...(jvmArgs.length ? [`    task.jvmArgs(${jvmArgs.map(groovy).join(', ')})`] : []),
    ...(mainClass ? [`    if (task.hasProperty('mainClass')) { task.mainClass.set(${groovy(mainClass)}) } else { task.main = ${groovy(mainClass)} }`] : []),
    '  }',
    '}',
    ''
  ].join('\n');
}

/** The private files a run of one entry may need, beside its run record. */
export function runConfigurationPaths(directory, startId) {
  const name = `${startId}.run.init.gradle`;
  return Object.freeze({ runInitScript: directory === PRIVATE_DIRECTORY_PLACEHOLDER ? `${directory}/${name}` : path.join(directory, name) });
}

function placeholderPaths(entry) {
  return runConfigurationPaths(PRIVATE_DIRECTORY_PLACEHOLDER, entry.id);
}

function effective(entry, environment) {
  const override = environment ? entry.perEnvironment?.[environment] ?? null : null;
  const { env: overrideEnv = null, beforeLaunch: overrideSteps = null, ...overrideFields } = override ?? {};
  return {
    fields: { ...(entry.type === 'command' ? { argv: entry.argv } : entry.fields), ...overrideFields },
    env: { ...(entry.env ?? {}), ...(overrideEnv ?? {}) },
    beforeLaunch: overrideSteps ?? entry.beforeLaunch ?? []
  };
}

function urlDefaults(entry) {
  const url = safeUrl(entry.url);
  return {
    host: url ? url.hostname.replace(/^\[|\]$/gu, '') : '127.0.0.1',
    port: url ? Number(url.port || (url.protocol === 'https:' ? 443 : 80)) : 8000
  };
}

function gradleJavaExec(entry, facts, paths, task, { jvmArgs, mainClass, programArguments }) {
  const script = paths.runInitScript;
  const needs = jvmArgs.length > 0 || Boolean(mainClass);
  return {
    launcher: 'gradle-java-exec',
    argv: [facts.gradle, ...(needs ? ['--init-script', script] : []), task, ...(programArguments.length ? [`--args=${joinArguments(programArguments)}`] : [])],
    files: needs ? [{ path: script, content: gradleRunInitScript([task], { jvmArgs, mainClass }) }] : []
  };
}

/**
 * The command line one type builds from its fields. `debug` (the loopback agent, inspector flag or
 * debugpy listener) is placed where the type keeps VM, Node or interpreter options; null for none.
 */
function build(entry, fields, facts, paths, debug = null) {
  const at = entry.workingDirectory;
  const relative = (repositoryPath) => fromWorkingDirectory(at, repositoryPath);
  const python = () => (fields.interpreter ? (fields.interpreter.includes('/') ? executableFrom(at, fields.interpreter) : fields.interpreter) : facts.python);
  const listen = debug?.listen ? ['-m', 'debugpy', '--listen', debug.listen] : [];
  const notes = [];
  const vm = [...fields.vmOptions ?? [], ...(debug?.agent ? [debug.agent] : [])];
  const program = fields.programArguments ?? [];
  const { host, port } = { ...urlDefaults(entry), ...(fields.host ? { host: fields.host } : {}), ...(fields.port ? { port: fields.port } : {}) };
  switch (entry.type) {
    case 'command':
      return { launcher: null, argv: [...fields.argv], files: [], appendEnv: {}, notes };
    case 'spring-boot': {
      const profiles = fields.activeProfiles ?? [];
      if ((fields.launcher ?? facts.javaBuild) === 'gradle') {
        return { ...gradleJavaExec(entry, facts, paths, 'bootRun', {
          jvmArgs: [...vm, ...(profiles.length ? [`-Dspring.profiles.active=${profiles.join(',')}`] : [])],
          mainClass: fields.mainClass ?? null, programArguments: program }), appendEnv: {}, notes };
      }
      return {
        launcher: 'maven-spring-boot', files: [], appendEnv: {}, notes,
        argv: [facts.maven, 'spring-boot:run',
          ...(fields.mainClass ? [`-Dspring-boot.run.main-class=${fields.mainClass}`] : []),
          ...(vm.length ? [`-Dspring-boot.run.jvmArguments=${joinArguments(vm)}`] : []),
          ...(program.length ? [`-Dspring-boot.run.arguments=${joinArguments(program)}`] : []),
          ...(profiles.length ? [`-Dspring-boot.run.profiles=${profiles.join(',')}`] : [])]
      };
    }
    case 'jar':
      return { launcher: 'java', argv: ['java', ...vm, '-jar', relative(fields.jar), ...program], files: [], appendEnv: {}, notes };
    case 'application': {
      if ((fields.launcher ?? (facts.javaBuild === 'gradle' ? 'gradle-run' : 'maven-exec')) === 'gradle-run') {
        return { ...gradleJavaExec(entry, facts, paths, 'run', { jvmArgs: vm, mainClass: fields.mainClass ?? null, programArguments: program }), appendEnv: {}, notes };
      }
      // exec:java runs the class inside Maven's own JVM, so its VM options are Maven's: MAVEN_OPTS.
      return {
        launcher: 'maven-exec', files: [], notes, appendEnv: vm.length ? { MAVEN_OPTS: joinArguments(vm) } : {},
        argv: [facts.maven, '-q', 'compile', 'exec:java', `-Dexec.mainClass=${fields.mainClass}`,
          ...(program.length ? [`-Dexec.args=${joinArguments(program)}`] : [])]
      };
    }
    case 'maven':
      return {
        launcher: 'maven', files: [], appendEnv: {}, notes,
        argv: [facts.maven, ...fields.goals, ...(fields.profiles?.length ? [`-P${fields.profiles.join(',')}`] : []),
          ...Object.entries(fields.properties ?? {}).map(([name, value]) => `-D${name}=${value}`), ...fields.arguments ?? []]
      };
    case 'gradle':
      return {
        launcher: 'gradle', files: [], appendEnv: {}, notes,
        argv: [facts.gradle, ...fields.tasks, ...Object.entries(fields.properties ?? {}).map(([name, value]) => `-P${name}=${value}`), ...fields.arguments ?? []]
      };
    case 'python':
      return {
        launcher: 'python', files: [], appendEnv: {}, notes,
        argv: [python(), ...fields.interpreterOptions ?? [], ...listen, ...(fields.module ? ['-m', fields.module] : [relative(fields.script)]), ...fields.parameters ?? []]
      };
    case 'django': {
      const noReload = fields.noReload === true || Boolean(debug);
      if (debug && fields.noReload !== true) notes.push('Django runserver gets --noreload under the debugger, so the code you attach to is the code that serves.');
      return {
        launcher: 'python-django', files: [], appendEnv: {}, notes,
        argv: [python(), ...fields.interpreterOptions ?? [], ...listen, relative(fields.manage ?? (at === '.' ? 'manage.py' : `${at}/manage.py`)), 'runserver',
          host === '::1' ? `[::1]:${port}` : `${host}:${port}`, ...(noReload ? ['--noreload'] : []),
          ...(fields.settings ? [`--settings=${fields.settings}`] : []), ...fields.parameters ?? []]
      };
    }
    case 'fastapi':
    case 'flask': {
      const reload = fields.reload === true && !debug;
      if (debug && fields.reload === true) notes.push(`${entry.type === 'fastapi' ? 'uvicorn' : 'flask'} --reload is left off under the debugger: the reloader would serve from a child process the debugger does not attach to.`);
      const runs = entry.type === 'fastapi' ? ['-m', 'uvicorn', fields.app] : ['-m', 'flask', '--app', fields.app, 'run'];
      return {
        launcher: `python-${entry.type}`, files: [], appendEnv: {}, notes,
        argv: [python(), ...fields.interpreterOptions ?? [], ...listen, ...runs, '--host', host, '--port', String(port),
          ...(reload ? ['--reload'] : []), ...fields.parameters ?? []]
      };
    }
    case 'node': {
      const node = fields.nodeInterpreter ? (fields.nodeInterpreter.includes('/') ? executableFrom(at, fields.nodeInterpreter) : fields.nodeInterpreter) : 'node';
      return {
        launcher: 'node', files: [], appendEnv: {}, notes,
        argv: [node, ...(debug?.inspect ? [debug.inspect] : []), ...fields.nodeOptions ?? [], relative(fields.script), ...fields.applicationParameters ?? []]
      };
    }
    case 'npm': {
      const manager = fields.packageManager ?? facts.packageManager ?? 'npm';
      const passed = fields.arguments ?? [];
      // npm needs -- before a script's own arguments; pnpm and yarn pass what follows the script name.
      return {
        launcher: 'npm', files: [], appendEnv: {}, notes,
        argv: [manager, 'run', fields.script, ...(passed.length ? (manager === 'npm' ? ['--', ...passed] : passed) : [])]
      };
    }
    case 'go': {
      const kind = fields.kind ?? 'package';
      const target = kind === 'package' ? fields.target ?? '.' : targetFrom(at, fields.target);
      return { launcher: 'go', files: [], appendEnv: {}, notes, argv: ['go', 'run', ...fields.goToolArguments ?? [], target, ...program] };
    }
    case 'dotnet': {
      // A project file in the working directory, or the working directory itself, needs no --project.
      const here = fields.project === at || (/\.(?:cs|fs|vb)proj$/u.test(fields.project ?? '') && path.posix.dirname(fields.project) === at);
      const project = fields.project && !here ? ['--project', relative(fields.project)] : [];
      const passed = fields.arguments ?? [];
      return {
        launcher: 'dotnet', files: [], appendEnv: {}, notes,
        argv: ['dotnet', 'run', ...project, ...(fields.launchProfile ? ['--launch-profile', fields.launchProfile] : []),
          ...(fields.configuration ? ['-c', fields.configuration] : []), ...(passed.length ? ['--', ...passed] : [])]
      };
    }
    default:
      throw new SingularityFlowError(`Start entry '${entry.id}' has type ${entry.type}, which this engine does not run.`, { code: 'CAPABILITY_APPLICATION_INVALID' });
  }
}

/**
 * What one start entry runs in one environment (null: without one): argv (with that environment's
 * `arguments` appended last), the literal variables it sets (`env`), the variables appended to an
 * inherited value (`appendEnv`, such as MAVEN_OPTS for exec:java), the before-launch steps, and the
 * private files to write first. Pure, given the facts detected for the entry.
 */
export function resolveStartCommand(entry, environment = null, { paths = null } = {}) {
  const { fields, env, beforeLaunch } = effective(entry, environment);
  const built = build(entry, fields, entry.facts ?? {}, paths ?? placeholderPaths(entry));
  const argv = [...built.argv, ...(environment ? entry.arguments?.[environment] ?? [] : [])];
  const steps = beforeLaunch.map((step) => ({
    argv: [...step.argv], workingDirectory: normalizedDirectory(step.workingDirectory ?? entry.workingDirectory),
    timeoutMs: step.timeoutMs ?? BEFORE_LAUNCH_TIMEOUT_MS.default
  }));
  return {
    launcher: built.launcher, argv, env: { ...env }, appendEnv: { ...built.appendEnv },
    envNames: [...new Set([...Object.keys(env), ...Object.keys(built.appendEnv)])].sort(),
    beforeLaunch: steps, files: built.files, notes: built.notes
  };
}

function normalizedDirectory(value) {
  return String(value).replace(/^\.\/(?=.)/u, '').replace(/\/$/u, '') || '.';
}

/** The shown form of a resolution: what app plan and app config preview print per environment. */
export function shownResolution(command) {
  return { argv: [...command.argv], envNames: [...command.envNames], beforeLaunch: command.beforeLaunch.map((step) => ({ ...step, argv: [...step.argv] })) };
}

/**
 * The identity a person confirms before a start entry first runs. A plain command entry (no env,
 * beforeLaunch or perEnvironment) keeps the identity it always had; any other covers the resolved
 * form of every environment (argv, variables, steps, the private files' content) and the debug block.
 */
export function startEntryCommandSha256(entry) {
  if (!entry.extended) return applicationStartCommandSha256(entry);
  const names = entry.environments.length ? entry.environments : [null];
  return `sha256:${recordSha256({
    repository: entry.repository, workingDirectory: entry.workingDirectory, type: entry.type, environments: [...entry.environments],
    resolved: names.map((name) => {
      const command = resolveStartCommand(entry, name);
      return {
        environment: name, argv: command.argv, env: command.env, appendEnv: command.appendEnv, beforeLaunch: command.beforeLaunch,
        files: command.files.map((file) => ({ name: path.posix.basename(file.path), content: file.content }))
      };
    }),
    ...(entry.debug ? { debug: entry.debug } : {})
  })}`;
}

const INJECTS = new Set(['spring-boot', 'jar', 'application', 'python', 'django', 'fastapi', 'flask', 'node']);

/**
 * The debug start of an entry in one environment. A typed entry's debugger goes where its type keeps
 * the options: the JDWP agent into VM options (Maven jvmArguments, the private Gradle init script, the
 * java line, or MAVEN_OPTS for exec:java), debugpy after the interpreter options, --inspect into Node
 * options. Maven and Gradle goal entries, npm, go and dotnet use application-debug.mjs's launcher
 * rules on the resolved command line; a command entry is read from its argv, as before.
 */
export function resolveStartDebugLaunch(entry, environment = null, { paths = null, debugPaths = null, environment: variables = {}, platform = process.platform } = {}) {
  const command = resolveStartCommand(entry, environment, { paths });
  const typed = INJECTS.has(entry.type);
  return resolveDebugLaunch(entry, {
    argv: command.argv, environmentArguments: environment ? entry.arguments?.[environment] ?? [] : [],
    environment: variables, paths: debugPaths, platform,
    inject: typed ? ({ agent, inspect, listen }) => {
      if (command.launcher === 'maven-exec') {
        const existing = String(variables?.MAVEN_OPTS ?? '').trim();
        return { launcher: 'maven-exec', argv: command.argv, environment: { MAVEN_OPTS: existing ? `${existing} ${agent}` : agent },
          notes: ['exec:java runs the class in Maven\'s own JVM, so MAVEN_OPTS carries the debugger agent for the application process only.'] };
      }
      const { fields } = effective(entry, environment);
      const runtime = RUN_CONFIGURATION_TYPES[entry.type].runtime;
      const debugged = build(entry, fields, entry.facts ?? {}, paths ?? placeholderPaths(entry),
        runtime === 'java' ? { agent } : runtime === 'node' ? { inspect } : { listen });
      return {
        launcher: debugged.launcher, argv: [...debugged.argv, ...(environment ? entry.arguments?.[environment] ?? [] : [])],
        files: debugged.files, notes: debugged.notes, ...(runtime === 'python' ? { requires: { debugpy: [debugged.argv[0]] } } : {})
      };
    } : null
  });
}

// ---------------------------------------------------------------------------------------------
// Entries as app and tests commands read them

/**
 * One validated start entry with its type, name and resolution inputs: the normalized entry from
 * capabilities.mjs, its own fields checked here (refused with the first located error), the facts
 * the checkout provides, and `argv` set to its base command line. `configured`, `extended` and
 * `startsFromArgv` (not enumerable) say whether it uses any typed-configuration field (else app plan
 * shows it exactly as before), whether its identity covers more than argv, and whether argv alone runs it.
 */
export function typedStartEntry(capabilityId, normalized, raw, index, { checkoutRoot = null, platform = process.platform } = {}) {
  assertRunConfiguration(capabilityId, raw, index);
  const type = raw.type ?? 'command';
  const definition = RUN_CONFIGURATION_TYPES[type];
  const typed = type !== 'command';
  const listArguments = typed && Object.hasOwn(definition.fields, 'arguments') && Array.isArray(raw.arguments);
  const fields = typed ? Object.fromEntries(Object.keys(definition.fields).filter((name) => raw[name] != null && !(name === 'arguments' && !listArguments))
    .map((name) => [name, structuredClone(raw[name])])) : null;
  const startArguments = typed && raw.arguments != null && !listArguments
    ? applicationArguments(capabilityId, raw.arguments, `start[${index}]`, normalized.environments, raw.id) : normalized.arguments ?? null;
  const debug = typed ? typedDebug(capabilityId, raw, index) : normalized.debug ?? null;
  const env = raw.env != null ? Object.fromEntries(Object.entries(raw.env).map(([name, value]) => [name, String(value)])) : null;
  const perEnvironment = raw.perEnvironment != null ? structuredClone(raw.perEnvironment) : null;
  for (const override of Object.values(perEnvironment ?? {})) {
    if (override.env) override.env = Object.fromEntries(Object.entries(override.env).map(([name, value]) => [name, String(value)]));
  }
  const entry = {
    ...normalized, name: raw.name ?? normalized.id, type,
    ...(fields ? { fields } : {}), ...(startArguments ? { arguments: startArguments } : {}), ...(debug ? { debug } : {}),
    ...(env ? { env } : {}), ...(raw.beforeLaunch != null ? { beforeLaunch: structuredClone(raw.beforeLaunch) } : {}),
    ...(perEnvironment ? { perEnvironment } : {})
  };
  if (!startArguments) delete entry.arguments;
  if (!debug) delete entry.debug;
  const extended = typed || env != null || raw.beforeLaunch != null || perEnvironment != null;
  Object.defineProperty(entry, 'facts', { value: typed ? detectRunFacts(checkoutRoot, entry, { platform }) : Object.freeze({}), enumerable: false });
  Object.defineProperty(entry, 'extended', { value: extended, enumerable: false });
  Object.defineProperty(entry, 'configured', { value: extended || raw.name != null || raw.type != null, enumerable: false });
  const base = resolveStartCommand(entry, null);
  entry.argv = Object.freeze(typed ? base.argv : [...normalized.argv]);
  Object.defineProperty(entry, 'startsFromArgv', {
    value: !base.envNames.length && !base.beforeLaunch.length && !base.files.length, enumerable: false
  });
  return deepFreeze(entry);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * The application block with every start entry typed: `raw` is the capability's own block as
 * written, `application` the one capabilities.mjs normalized from it. An entry runs here only when
 * this checkout is its repository; elsewhere its facts are the defaults.
 */
export function typedApplication(capabilityId, raw, application, { checkoutRoot = null, repositoryId = null, repositories = [], platform = process.platform } = {}) {
  const start = application.start.map((entry, index) => typedStartEntry(capabilityId, entry, raw?.start?.[index] ?? {}, index, {
    checkoutRoot: repositories.length <= 1 || entry.repository === repositoryId ? checkoutRoot : null, platform
  }));
  return Object.freeze({ ...application, start: Object.freeze(start) });
}

/** What app start runs for an entry in an environment: a plain command entry exactly as before. */
export function startArgvFor(entry, environment = null, { paths = null } = {}) {
  return entry.extended || (entry.type ?? 'command') !== 'command' ? resolveStartCommand(entry, environment, { paths }).argv : applicationStartArgv(entry, environment);
}

// ---------------------------------------------------------------------------------------------
// app config preview

/**
 * A whole application block checked and resolved, as IntelliJ previews a run configuration's
 * command line, without writing anything: per start entry its located errors, or per environment
 * (one null environment when it lists none) the resolved argv, variable names and before-launch
 * steps. Block-level problems (unknown keys, the tests list) are `errors`. `pathsFor(id)` gives the
 * private file paths a run of that entry would use.
 */
export function previewApplication(capabilityId, block, { checkoutRoot = null, repositoryId = null, repositories = [], pathsFor = null, platform = process.platform } = {}) {
  const errors = [];
  const shape = { kind: 'delivery', repositories: repositories.length ? [...repositories] : [repositoryId ?? 'repository'] };
  const unknown = Object.keys(block).filter((key) => !['start', 'tests'].includes(key)).sort();
  if (unknown.length) errors.push({ field: '', message: `contains unsupported field(s): ${unknown.join(', ')}; an application block has start and tests.` });
  if (block.start != null && (!Array.isArray(block.start) || block.start.length > 32)) errors.push({ field: 'start', message: 'must be a list of at most 32 entries.' });
  if (block.tests != null) {
    try { normalizeCapabilityApplication(capabilityId, { ...shape, application: { tests: block.tests } }); } catch (error) {
      const located = locatedApplicationError(error);
      errors.push({ field: located.field || 'tests', message: located.message });
    }
  }
  const seen = new Map();
  const entries = (Array.isArray(block.start) ? block.start.slice(0, 32) : []).map((raw, index) => {
    const id = typeof raw?.id === 'string' ? raw.id : null;
    const type = typeof raw?.type === 'string' ? raw.type : 'command';
    const name = typeof raw?.name === 'string' ? raw.name : id;
    const problems = [];
    let normalized = null;
    try { [normalized] = normalizeCapabilityApplication(capabilityId, { ...shape, application: { start: [raw] } }).start; } catch (error) {
      problems.push(locatedApplicationError(error));
    }
    problems.push(...runConfigurationErrors(raw, { capabilityId, index }));
    if (id != null && seen.has(id)) problems.push({ field: 'id', message: `'${id}' is declared more than once (also start[${seen.get(id)}]).` });
    else if (id != null) seen.set(id, index);
    if (problems.length || !normalized) return { index, id, name, type, errors: problems, environments: [] };
    const entry = typedStartEntry(capabilityId, normalized, raw, index, {
      checkoutRoot: repositories.length <= 1 || normalized.repository === repositoryId ? checkoutRoot : null, platform
    });
    const paths = pathsFor ? pathsFor(entry.id) : null;
    return {
      index, id: entry.id, name: entry.name, type: entry.type, errors: [], commandSha256: startEntryCommandSha256(entry),
      environments: (entry.environments.length ? entry.environments : [null])
        .map((environment) => ({ name: environment, resolved: shownResolution(resolveStartCommand(entry, environment, { paths })) }))
    };
  });
  return { valid: !errors.length && entries.every((entry) => !entry.errors.length), entries, errors };
}
