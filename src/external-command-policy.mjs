import path from 'node:path';
import { SingularityFlowError } from './util.mjs';
import { declarableEnvironmentVariable, ENVIRONMENT_DECLARATION_PATH, ENVIRONMENT_IDENTIFIER, looksSecretName } from './environment-declaration.mjs';

export const EXTERNAL_MODEL_POLICIES = Object.freeze(['never', 'required', 'unknown']);
export const QUALITY_COMMAND_KINDS = Object.freeze([
  'test', 'compile', 'lint', 'format', 'static-analysis', 'security', 'other'
]);
export const QUALITY_COMMAND_REQUIREMENTS = Object.freeze(['required', 'advisory']);
export const ENVIRONMENT_ID_PATTERN = ENVIRONMENT_IDENTIFIER;
export const TEST_RESULT_ADAPTERS = Object.freeze([
  'junit-xml', 'jest-json', 'vitest-json', 'playwright-json', 'go-test-json', 'node-tap',
  'karma-text', 'dotnet-trx', 'cargo-json', 'sflow-test-result-v1', 'mocha-json'
]);
/**
 * The kinds whose command reports findings rather than tests [CQF:REQ-041], and the readers their
 * `result.adapter` may name (src/findings/readers/). Such a command may also name
 * `gate: { failOn: [severities] }`: the severities of a new-code finding that count against it.
 */
export const FINDING_COMMAND_KINDS = Object.freeze(['lint', 'static-analysis', 'security']);
/**
 * The dependency audits' readers [CQF:REQ-050]: they run only when the Story changed a manifest or
 * lockfile, and a finding is new code when the Story added the package or changed its version.
 */
export const DEPENDENCY_AUDIT_ADAPTERS = Object.freeze(['npm-audit', 'pnpm-audit', 'pip-audit', 'osv-scanner', 'dependency-check']);
export const FINDING_RESULT_ADAPTERS = Object.freeze(['eslint-json', 'sarif', 'sonarqube', ...DEPENDENCY_AUDIT_ADAPTERS]);
// npm and pnpm write their audit only to standard output; SFlow writes it to the report path.
const STDOUT_ONLY_ADAPTERS = new Set(['npm-audit', 'pnpm-audit']);
export const FINDING_GATE_SEVERITIES = Object.freeze(['blocker', 'critical', 'high', 'medium', 'low', 'info']);
// What counts when a command names no gate: the severities a person would hold a change for.
export const DEFAULT_FINDING_GATE = Object.freeze({ failOn: Object.freeze(['blocker', 'critical', 'high']) });

/** Whether a normalized command reports findings through a reader, so the findings loop reads it. */
export function findingCommand(command) {
  return FINDING_COMMAND_KINDS.includes(command?.kind) && FINDING_RESULT_ADAPTERS.includes(command?.result?.adapter);
}

/**
 * The source languages a test command can be scoped to (code-delivery-tests.mjs reads them in this
 * order). A command's optional `ecosystem` makes it evidence only for that language's source and files
 * of no language below its roots, as an inferred command is; a test setup suggestion carries its own.
 * An older engine ignores it, like any key unknown here, and covers every file below the roots.
 */
export const TEST_COMMAND_ECOSYSTEMS = Object.freeze(['node', 'python', 'jvm', 'dotnet', 'go', 'rust', 'swift', 'ruby', 'php', 'dart']);

/**
 * The level a test command runs at [RTC:REQ-001]. A step chooses repository tests by level
 * (`testLevels`), so a level is part of the command; one without a level is `other`. An older engine
 * ignores it, like any key unknown here.
 */
export const TEST_COMMAND_LEVELS = Object.freeze(['unit', 'component', 'integration', 'e2e', 'other']);

/**
 * Why a literal value holds a credential, or null [RTC:REQ-011]: a URL with userinfo (`user:pass@`), or
 * one whose query names a secret-looking parameter. workflow.yml never holds a secret, so such a URL
 * belongs in environments.yml and is bound on each machine.
 */
export function literalUrlCredential(value) {
  const text = String(value ?? '').trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(text)) return null;
  let url;
  try { url = new URL(text); } catch { return /^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]*@/iu.test(text) ? 'a user name or password in the URL' : null; }
  if (url.username || url.password) return 'a user name or password in the URL';
  const named = [...url.searchParams.keys()].find((name) => looksSecretName(name));
  return named ? `the query parameter '${named}'` : null;
}

const WEB_URL = /\b(?:https?|wss?):\/\/[^\s'"`<>()]+/giu;
const HOST_NAME = /^(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.?|\[[0-9a-f:.]+\])$/u;
const localHost = (host) => host === 'localhost' || /\.(?:localhost|test)$/u.test(host)
  || /^127(?:\.\d{1,3}){3}$/u.test(host) || ['0.0.0.0', '[::1]', '[::]'].includes(host);

/**
 * The deployed hosts a command's env, argv or shell text targets [PHR:REQ-007], item 8: http(s)/ws(s) URLs whose
 * host is not this machine (localhost, 127.0.0.1, [::1], *.localhost, *.test). As `host[:port]` only, so no user
 * name, password or query is ever shown; a placeholder (`$HOST`) is no host.
 */
export function literalDeployedHosts(command) {
  const texts = [...Object.values(command?.env ?? {}), ...(Array.isArray(command?.argv) ? command.argv : []),
    ...(typeof command?.command === 'string' ? [command.command] : [])];
  const hosts = new Set();
  for (const [match] of texts.flatMap((text) => [...String(text ?? '').matchAll(WEB_URL)])) {
    let url;
    try { url = new URL(match); } catch { continue; }
    const host = url.hostname.toLowerCase().replace(/\.$/u, '');
    if (HOST_NAME.test(url.hostname.toLowerCase()) && !localHost(host)) hosts.add(url.port ? `${host}:${url.port}` : host);
  }
  return [...hosts];
}

/**
 * A command's literal `env` [TCE]: unreserved UPPER_CASE names, none secret-like (environments.yml holds
 * those), short values, in name order. An older engine ignores it, like any key unknown here.
 */
function normalizeCommandEnv(value, index) {
  const at = `qualityCommands[${index}].env`;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 64) {
    throw new SingularityFlowError(`${at} must map at most 64 names to literal values.`, { code: 'QUALITY_COMMAND_ENV_INVALID' });
  }
  const entries = Object.keys(value).sort().map((name) => {
    const raw = value[name];
    const secret = looksSecretName(name);
    // `_X` is checked as `X_X`: the reserved rule is environments.yml's, whose names start with a letter.
    if (secret || !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(name) || !declarableEnvironmentVariable(name.replace(/^_/u, 'X_'))
        || !['string', 'number', 'boolean'].includes(typeof raw)
        || String(raw).length > 4_096 || /[\u0000-\u001f\u007f]/u.test(String(raw))) {
      throw new SingularityFlowError(secret ? `${at}.${name} names a secret: declare it in ${ENVIRONMENT_DECLARATION_PATH}, never in workflow.yml.`
        : `${at}.${name} must be an unreserved UPPER_CASE name (not PATH, HOME, NODE_*, GIT_*) with short literal text.`,
      { code: secret ? 'QUALITY_COMMAND_ENV_SECRET' : 'QUALITY_COMMAND_ENV_INVALID' });
    }
    const credential = literalUrlCredential(raw);
    if (credential) {
      throw new SingularityFlowError(`${at}.${name} holds a credential (${credential}). Declare ${name} in ${ENVIRONMENT_DECLARATION_PATH} `
        + '(an endpoint or secret), bind it on each machine, and name that environment on the command instead.',
      { code: 'QUALITY_COMMAND_ENV_SECRET' });
    }
    return [name, String(raw)];
  });
  return entries.length ? Object.fromEntries(entries) : null;
}

/** Every run merges a command's `env` here: after the base environment, before bound values; any case of a name is replaced. */
export function withCommandLiteralEnvironment(environment, { env } = {}) {
  const names = new Set(Object.keys(env ?? {}).map((name) => name.toUpperCase()));
  if (!names.size) return environment;
  return Object.assign(Object.fromEntries(Object.entries(environment).filter(([key]) => !names.has(key.toUpperCase()))), env);
}

function relativePath(value, label, { allowDot = false } = {}) {
  const proposed = String(value ?? '').replaceAll('\\', '/');
  const normalized = proposed.replace(/^\.\//, '').replace(/\/$/, '');
  const collapsed = normalized ? path.posix.normalize(normalized) : normalized;
  if ((!collapsed && !allowDot) || normalized.split('/').includes('..')
      || collapsed === '..' || collapsed.startsWith('../')
      || collapsed.startsWith('/') || /^[A-Za-z]:\//.test(collapsed)) {
    throw new SingularityFlowError(`${label} must be repository-relative.`);
  }
  return collapsed || '.';
}

/** The coverage report forms a test command's `coverage` may name [CQF:REQ-030]. */
export const COVERAGE_REPORT_FORMATS = Object.freeze(['lcov', 'cobertura', 'jacoco', 'istanbul-json']);

/**
 * A test command's coverage report [CQF:REQ-030]: where the command already writes it, below its
 * folder, and in which form. SFlow reads it and never adds a flag to write it. An older engine
 * ignores it, like any key unknown here.
 */
function normalizeCoverage(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !['format', 'path'].includes(key))
      || !COVERAGE_REPORT_FORMATS.includes(value.format)) {
    throw new SingularityFlowError(`qualityCommands[${index}].coverage must be { format: ${COVERAGE_REPORT_FORMATS.join(' | ')}, path }.`,
      { code: 'QUALITY_COMMAND_COVERAGE_INVALID' });
  }
  return { format: value.format, path: relativePath(value.path, `qualityCommands[${index}].coverage.path`) };
}

export function normalizeExternalCommand(value, index = 0) {
  if (typeof value === 'string' && value.trim()) {
    // Legacy string commands are still readable, but they are gates, not optional hints. If their
    // model behavior is unknown while models are disabled, the resulting unavailability blocks
    // submission instead of being mislabeled as a passing validation.
    return {
      id: value.trim(), command: value.trim(), argv: null, modelPolicy: 'unknown',
      requirement: 'required', timeoutMs: null
    };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError(`qualityCommands[${index}] must be a command string or object.`);
  }
  const argv = Array.isArray(value.argv) ? value.argv.map(String) : null;
  const command = typeof value.command === 'string' && value.command.trim() ? value.command.trim() : null;
  if ((!argv?.length && !command) || (argv?.length && command)) {
    throw new SingularityFlowError(`qualityCommands[${index}] must define exactly one of command or argv.`);
  }
  const modelPolicy = value.modelPolicy ?? 'unknown';
  if (!EXTERNAL_MODEL_POLICIES.includes(modelPolicy)) {
    throw new SingularityFlowError(`qualityCommands[${index}].modelPolicy must be ${EXTERNAL_MODEL_POLICIES.join(', ')}.`);
  }
  const id = String(value.id ?? command ?? argv.join(' ')).trim();
  if (!id) throw new SingularityFlowError(`qualityCommands[${index}].id must be non-empty.`);
  const requirement = value.requirement ?? 'required';
  if (!QUALITY_COMMAND_REQUIREMENTS.includes(requirement)) {
    throw new SingularityFlowError(`qualityCommands[${index}].requirement must be ${QUALITY_COMMAND_REQUIREMENTS.join(' or ')}.`);
  }
  const timeoutMs = value.timeoutMs ?? null;
  if (timeoutMs != null && (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 2 * 60 * 60 * 1_000)) {
    throw new SingularityFlowError(`qualityCommands[${index}].timeoutMs must be an integer from 1000 through 7200000.`);
  }
  const kind = value.kind ?? null;
  if (kind != null && !QUALITY_COMMAND_KINDS.includes(kind)) {
    throw new SingularityFlowError(`qualityCommands[${index}].kind must be ${QUALITY_COMMAND_KINDS.join(', ')}.`);
  }
  const environment = value.environment == null ? null : String(value.environment).trim();
  if (environment != null && !ENVIRONMENT_ID_PATTERN.test(environment)) {
    throw new SingularityFlowError(
      `qualityCommands[${index}].environment must be a lower-kebab environment identifier.`
    );
  }
  if (environment != null && command) {
    throw new SingularityFlowError(
      `qualityCommands[${index}] uses environment '${environment}' and must use argv instead of a shell command.`
    );
  }
  const env = value.env == null ? null : normalizeCommandEnv(value.env, index);
  if (value.level != null && !TEST_COMMAND_LEVELS.includes(value.level)) {
    throw new SingularityFlowError(`qualityCommands[${index}].level must be ${TEST_COMMAND_LEVELS.join(', ')}.`,
      { code: 'QUALITY_COMMAND_LEVEL_INVALID' });
  }
  if (value.ecosystem != null && !TEST_COMMAND_ECOSYSTEMS.includes(value.ecosystem)) {
    throw new SingularityFlowError(`qualityCommands[${index}].ecosystem must be ${TEST_COMMAND_ECOSYSTEMS.join(', ')}.`,
      { code: 'QUALITY_COMMAND_ECOSYSTEM_INVALID' });
  }
  const workingDirectory = value.workingDirectory == null
    ? null
    : relativePath(value.workingDirectory, `qualityCommands[${index}].workingDirectory`, { allowDot: true });
  const affectedRoots = value.affectedRoots == null ? [] : value.affectedRoots;
  if (!Array.isArray(affectedRoots) || affectedRoots.some((root) => typeof root !== 'string')) {
    throw new SingularityFlowError(`qualityCommands[${index}].affectedRoots must be an array of repository-relative paths.`);
  }
  const normalizedRoots = [...new Set(affectedRoots.map((root) => relativePath(root, `qualityCommands[${index}].affectedRoots`, { allowDot: true })))];
  let result = null;
  const findingKind = FINDING_COMMAND_KINDS.includes(kind);
  if (value.result != null && findingKind && FINDING_RESULT_ADAPTERS.includes(value.result?.adapter)) {
    result = normalizeFindingResult(value.result, index);
  } else if (value.result != null) {
    if (!value.result || typeof value.result !== 'object' || Array.isArray(value.result)) {
      throw new SingularityFlowError(`qualityCommands[${index}].result must be an object.`);
    }
    if (findingKind && !TEST_RESULT_ADAPTERS.includes(value.result.adapter)) {
      throw new SingularityFlowError(`qualityCommands[${index}].result.adapter must be ${FINDING_RESULT_ADAPTERS.join(', ')} for a ${kind} command.`,
        { code: 'QUALITY_COMMAND_FINDING_ADAPTER_INVALID' });
    }
    if (!TEST_RESULT_ADAPTERS.includes(value.result.adapter)) {
      throw new SingularityFlowError(`qualityCommands[${index}].result.adapter must be ${TEST_RESULT_ADAPTERS.join(', ')}.`);
    }
    const minimumDiscovered = value.result.minimumDiscovered ?? 1;
    if (!Number.isInteger(minimumDiscovered) || minimumDiscovered < 1) {
      throw new SingularityFlowError(`qualityCommands[${index}].result.minimumDiscovered must be a positive integer.`);
    }
    const minimumPassed = value.result.minimumPassed ?? 1;
    if (!Number.isInteger(minimumPassed) || minimumPassed < 1) {
      throw new SingularityFlowError(`qualityCommands[${index}].result.minimumPassed must be a positive integer.`);
    }
    const sourceExtensions = value.result.sourceExtensions ?? [];
    if (!Array.isArray(sourceExtensions) || sourceExtensions.some((extension) =>
      typeof extension !== 'string' || !/^\.[a-z0-9][a-z0-9.+-]{0,15}$/i.test(extension))) {
      throw new SingularityFlowError(`qualityCommands[${index}].result.sourceExtensions must contain file extensions such as '.exs'.`);
    }
    result = {
      adapter: value.result.adapter,
      path: relativePath(value.result.path, `qualityCommands[${index}].result.path`),
      minimumDiscovered,
      minimumPassed,
      sourceExtensions: [...new Set(sourceExtensions.map((extension) => extension.toLowerCase()))]
    };
  }
  if (value.gate != null && !(findingKind && result?.adapter && FINDING_RESULT_ADAPTERS.includes(result.adapter))) {
    throw new SingularityFlowError(`qualityCommands[${index}].gate needs kind lint, static-analysis or security and a finding result adapter.`,
      { code: 'QUALITY_COMMAND_GATE_INVALID' });
  }
  const gate = value.gate == null ? null : normalizeFindingGate(value.gate, index);
  const sonarqube = value.sonarqube == null ? null : normalizeSonarqubeServer(value.sonarqube, index, result);
  return {
    id, command, argv, modelPolicy, requirement, timeoutMs,
    ...(value.kind != null ? { kind } : {}),
    ...(environment != null ? { environment } : {}),
    ...(env ? { env } : {}),
    ...(value.ecosystem != null ? { ecosystem: value.ecosystem } : {}),
    ...(value.level != null ? { level: value.level } : {}),
    ...(value.workingDirectory != null ? { workingDirectory } : {}),
    ...(value.affectedRoots != null ? { affectedRoots: normalizedRoots } : {}),
    ...(value.result != null ? { result } : {}),
    ...(gate ? { gate } : {}),
    ...(sonarqube ? { sonarqube } : {}),
    ...(value.coverage != null ? { coverage: normalizeCoverage(value.coverage, index) } : {})
  };
}

/**
 * A finding command's report [CQF:REQ-041]. It lives under `.sflow/results/`, SFlow's own transient
 * folder, so SFlow may clear it before each run and it is never application source; a scanner's
 * caches belong there too (ESLint `--cache-location`, `-Dsonar.working.directory`). `from: stdout`
 * says the tool prints its report, and SFlow writes what it printed there: npm and pnpm audit only
 * print theirs, so stdout is their default.
 */
function normalizeFindingResult(value, index) {
  const allowed = new Set(['adapter', 'path', 'from']);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new SingularityFlowError(`qualityCommands[${index}].result for adapter ${value.adapter} takes only adapter, path and from, not ${unknown.join(', ')}.`,
      { code: 'QUALITY_COMMAND_FINDING_RESULT_INVALID' });
  }
  const resultPath = relativePath(value.path, `qualityCommands[${index}].result.path`);
  if (!/^(?:.+\/)?\.sflow\/results\/.+/u.test(resultPath)) {
    throw new SingularityFlowError(`qualityCommands[${index}].result.path must be a file under .sflow/results/, such as .sflow/results/eslint.json.`,
      { code: 'QUALITY_COMMAND_FINDING_RESULT_INVALID' });
  }
  const from = value.from ?? (STDOUT_ONLY_ADAPTERS.has(value.adapter) ? 'stdout' : 'file');
  if (!['stdout', 'file'].includes(from) || (from === 'file' && STDOUT_ONLY_ADAPTERS.has(value.adapter)) || (from === 'stdout' && value.adapter === 'sonarqube')) {
    throw new SingularityFlowError(`qualityCommands[${index}].result.from is stdout or file; ${value.adapter} ${STDOUT_ONLY_ADAPTERS.has(value.adapter) ? 'prints its report, so it is stdout' : value.adapter === 'sonarqube' ? 'writes report-task.txt, so it is file' : 'may be either'}.`,
      { code: 'QUALITY_COMMAND_FINDING_RESULT_INVALID' });
  }
  return { adapter: value.adapter, path: resultPath, ...(from === 'stdout' ? { from } : {}) };
}

/** Whether a finding command prints its report, for SFlow to write to the report path. */
export function findingReportFromStdout(command) {
  return findingCommand(command) && command.result.from === 'stdout';
}

function normalizeFindingGate(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => key !== 'failOn')
      || !Array.isArray(value.failOn) || value.failOn.some((severity) => !FINDING_GATE_SEVERITIES.includes(severity))) {
    throw new SingularityFlowError(`qualityCommands[${index}].gate must be { failOn: [${FINDING_GATE_SEVERITIES.join(', ')}] }.`,
      { code: 'QUALITY_COMMAND_GATE_INVALID' });
  }
  return { failOn: FINDING_GATE_SEVERITIES.filter((severity) => value.failOn.includes(severity)) };
}

/**
 * Where a SonarQube scanner command analyses [CQF:REQ-048]. It runs once, at submit. `branchAnalysis`
 * says the server supports branch analysis (Developer Edition or above), so the Story branch is
 * analysed under `project`; without it, only a named `scratchProject` is analysed, and never the main
 * project. Its host and token come from the command's environment.
 */
function normalizeSonarqubeServer(value, index, result) {
  const at = `qualityCommands[${index}].sonarqube`;
  const key = /^[A-Za-z0-9_.:-]{1,400}$/u;
  if (!value || typeof value !== 'object' || Array.isArray(value) || result?.adapter !== 'sonarqube'
      || Object.keys(value).some((name) => !['project', 'branchAnalysis', 'scratchProject'].includes(name))
      || !key.test(String(value.project ?? '')) || (value.branchAnalysis != null && typeof value.branchAnalysis !== 'boolean')
      || (value.scratchProject != null && (!key.test(String(value.scratchProject)) || value.scratchProject === value.project))) {
    throw new SingularityFlowError(`${at} must be { project, branchAnalysis?, scratchProject? } on a command whose result adapter is sonarqube; a scratch project is not the main project.`,
      { code: 'QUALITY_COMMAND_SONARQUBE_INVALID' });
  }
  return { project: value.project, branchAnalysis: value.branchAnalysis === true,
    ...(value.scratchProject ? { scratchProject: value.scratchProject } : {}) };
}

export function externalCommandText(value, index = 0) {
  const normalized = normalizeExternalCommand(value, index);
  return normalized.command ?? normalized.argv.join(' ');
}

export function evaluateExternalCommandForModelMode(value, {
  modelEnabled = true,
  unknownStrictness = 'warn',
  index = 0
} = {}) {
  const normalized = normalizeExternalCommand(value, index);
  if (modelEnabled || normalized.modelPolicy === 'never') return { ...normalized, action: 'run', reason: null };
  if (normalized.modelPolicy === 'required') {
    return { ...normalized, action: 'block', reason: `Quality command '${normalized.id}' requires an external model while model mode is disabled.` };
  }
  const action = unknownStrictness === 'block' ? 'block' : 'skip';
  // Skipping is a model-mode decision, not a broken runner: name the two ways it runs again.
  return { ...normalized, action, reason: `Quality command '${normalized.id}' has unknown external-model behavior (it declares no modelPolicy) and was not run while model mode is disabled. `
    + 'Rerun with the model enabled, or have configuration declare modelPolicy: never for it.' };
}

/*
 * The repository's test commands [RTC]: one `tests:` list at the top of singularity/workflow.yml, owned
 * by no workflow and no step. A repository has as many as it needs (per module, runner or level), and
 * every step that runs tests gets them when it is resolved, unless it has test commands of its own. A
 * step that wants fewer names levels (`testLevels`) or IDs (`testIds`); with both, a command runs when
 * its level or its ID is listed.
 *
 * The commands enter a Story's resolution as configured commands, so a Story keeps the ones it started
 * with [SPK:CON-039]. A configuration without `tests:` resolves exactly as before.
 */
const repositoryTestsInvalid = (message, code = 'REPOSITORY_TESTS_INVALID') => new SingularityFlowError(message, { code });

/** A test command's level; one without a level is `other`. */
export const testCommandLevel = (command) => command?.level ?? 'other';

/**
 * The `tests:` list as written, after checking each has a step's test-command contract and a unique
 * ID. Empty when the repository has none. The written entries are what resolution copies, so a
 * repository test reaches a step exactly as a step's own command would.
 */
export function repositoryTestCommands(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw repositoryTestsInvalid('tests must be a list of test commands.');
  const ids = new Set();
  value.forEach((entry, index) => {
    let command;
    try { command = normalizeExternalCommand(entry, index); }
    catch (error) { throw repositoryTestsInvalid(error.message.replace(/^qualityCommands\[/u, 'tests['), error.code ?? 'REPOSITORY_TESTS_INVALID'); }
    if (command.kind !== 'test' || !command.argv?.length || !command.workingDirectory || !command.affectedRoots?.length || !command.result) {
      throw repositoryTestsInvalid(`tests[${index}] must declare kind: test, argv, workingDirectory, affectedRoots, and a result adapter.`);
    }
    if (ids.has(command.id)) throw repositoryTestsInvalid(`tests has two commands called '${command.id}'; each repository test needs its own ID.`);
    ids.add(command.id);
  });
  return value;
}

/**
 * A step's choice among the repository's tests, checked against them: `testLevels` and `testIds` are
 * lists of unique names, an ID must be one `tests:` holds and a level one some repository test has.
 */
export function assertRepositoryTestSelection(step, tests, label) {
  for (const field of ['testLevels', 'testIds']) {
    const values = step?.[field];
    if (values == null) continue;
    if (!Array.isArray(values) || !values.length || values.some((value) => typeof value !== 'string' || !value.trim())
        || new Set(values).size !== values.length) {
      throw repositoryTestsInvalid(`${label} ${field} must be a non-empty list of unique names.`);
    }
  }
  for (const level of step?.testLevels ?? []) {
    if (!TEST_COMMAND_LEVELS.includes(level)) throw repositoryTestsInvalid(`${label} testLevels names '${level}'; a level is ${TEST_COMMAND_LEVELS.join(', ')}.`);
    if (!tests.some((command) => testCommandLevel(command) === level)) {
      throw repositoryTestsInvalid(`${label} testLevels names '${level}', but no repository test in tests has that level.`);
    }
  }
  for (const id of step?.testIds ?? []) {
    if (!tests.some((command) => command.id === id)) throw repositoryTestsInvalid(`${label} testIds names '${id}', which tests does not hold.`);
  }
}

/** The repository tests a step runs: every one, or those whose level or ID it names. */
export function selectedRepositoryTests(step, tests) {
  const levels = step?.testLevels ?? null;
  const ids = step?.testIds ?? null;
  if (!levels && !ids) return tests;
  return tests.filter((command) => (levels ?? []).includes(testCommandLevel(command)) || (ids ?? []).includes(command.id));
}

/** Whether a step's own checks (its own, or its workflow's override) include a test command. */
export function hasOwnTestCommand(step) {
  return (step?.qualityCommands ?? []).some((command) => command && typeof command === 'object' && command.kind === 'test');
}
