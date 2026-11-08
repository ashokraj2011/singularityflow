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
export const FINDING_RESULT_ADAPTERS = Object.freeze(['eslint-json', 'sarif', 'sonarqube']);
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
    ...(value.workingDirectory != null ? { workingDirectory } : {}),
    ...(value.affectedRoots != null ? { affectedRoots: normalizedRoots } : {}),
    ...(value.result != null ? { result } : {}),
    ...(gate ? { gate } : {}),
    ...(sonarqube ? { sonarqube } : {})
  };
}

/**
 * A finding command's report [CQF:REQ-041]. It lives under `.sflow/results/`, SFlow's own transient
 * folder, so SFlow may clear it before each run and it is never application source; a scanner's
 * caches belong there too (ESLint `--cache-location`, `-Dsonar.working.directory`).
 */
function normalizeFindingResult(value, index) {
  const allowed = new Set(['adapter', 'path']);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new SingularityFlowError(`qualityCommands[${index}].result for adapter ${value.adapter} takes only adapter and path, not ${unknown.join(', ')}.`,
      { code: 'QUALITY_COMMAND_FINDING_RESULT_INVALID' });
  }
  const resultPath = relativePath(value.path, `qualityCommands[${index}].result.path`);
  if (!/^(?:.+\/)?\.sflow\/results\/.+/u.test(resultPath)) {
    throw new SingularityFlowError(`qualityCommands[${index}].result.path must be a file under .sflow/results/, such as .sflow/results/eslint.json.`,
      { code: 'QUALITY_COMMAND_FINDING_RESULT_INVALID' });
  }
  return { adapter: value.adapter, path: resultPath };
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
