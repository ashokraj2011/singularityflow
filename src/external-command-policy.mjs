import { SingularityFlowError } from './util.mjs';

export const EXTERNAL_MODEL_POLICIES = Object.freeze(['never', 'required', 'unknown']);

export function normalizeExternalCommand(value, index = 0) {
  if (typeof value === 'string' && value.trim()) {
    return { id: value.trim(), command: value.trim(), argv: null, modelPolicy: 'unknown', timeoutMs: null };
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
  const timeoutMs = value.timeoutMs ?? null;
  if (timeoutMs != null && (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 2 * 60 * 60 * 1_000)) {
    throw new SingularityFlowError(`qualityCommands[${index}].timeoutMs must be an integer from 1000 through 7200000.`);
  }
  return { id, command, argv, modelPolicy, timeoutMs };
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
