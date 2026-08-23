import path from 'node:path';
import { SingularityFlowError } from './util.mjs';

export const EXTERNAL_MODEL_POLICIES = Object.freeze(['never', 'required', 'unknown']);
export const QUALITY_COMMAND_KINDS = Object.freeze([
  'test', 'compile', 'lint', 'format', 'static-analysis', 'security', 'other'
]);
export const QUALITY_COMMAND_REQUIREMENTS = Object.freeze(['required', 'advisory']);
export const TEST_RESULT_ADAPTERS = Object.freeze([
  'junit-xml', 'jest-json', 'vitest-json', 'playwright-json', 'go-test-json',
  'dotnet-trx', 'cargo-json', 'sflow-test-result-v1'
]);

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
  const workingDirectory = value.workingDirectory == null
    ? null
    : relativePath(value.workingDirectory, `qualityCommands[${index}].workingDirectory`, { allowDot: true });
  const affectedRoots = value.affectedRoots == null ? [] : value.affectedRoots;
  if (!Array.isArray(affectedRoots) || affectedRoots.some((root) => typeof root !== 'string')) {
    throw new SingularityFlowError(`qualityCommands[${index}].affectedRoots must be an array of repository-relative paths.`);
  }
  const normalizedRoots = [...new Set(affectedRoots.map((root) => relativePath(root, `qualityCommands[${index}].affectedRoots`, { allowDot: true })))];
  let result = null;
  if (value.result != null) {
    if (!value.result || typeof value.result !== 'object' || Array.isArray(value.result)) {
      throw new SingularityFlowError(`qualityCommands[${index}].result must be an object.`);
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
    result = {
      adapter: value.result.adapter,
      path: relativePath(value.result.path, `qualityCommands[${index}].result.path`),
      minimumDiscovered,
      minimumPassed
    };
  }
  return {
    id, command, argv, modelPolicy, requirement, timeoutMs,
    ...(value.kind != null ? { kind } : {}),
    ...(value.workingDirectory != null ? { workingDirectory } : {}),
    ...(value.affectedRoots != null ? { affectedRoots: normalizedRoots } : {}),
    ...(value.result != null ? { result } : {})
  };
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
  return { ...normalized, action, reason: `Quality command '${normalized.id}' has unknown external-model behavior and was not run while model mode is disabled.` };
}
