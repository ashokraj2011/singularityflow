import { normalizeExternalCommand } from "./engine-compatibility/node-configuration-path.mjs";
export { EXTERNAL_MODEL_POLICIES, QUALITY_COMMAND_KINDS, QUALITY_COMMAND_REQUIREMENTS, ENVIRONMENT_ID_PATTERN, TEST_RESULT_ADAPTERS, TEST_COMMAND_ECOSYSTEMS, normalizeExternalCommand } from "./engine-compatibility/node-configuration-path.mjs";
import path from 'node:path';

/** Every run merges a command's `env` here: after the base environment, before bound values; any case of a name is replaced. */
export function withCommandLiteralEnvironment(environment, { env } = {}) {
  const names = new Set(Object.keys(env ?? {}).map((name) => name.toUpperCase()));
  if (!names.size) return environment;
  return Object.assign(Object.fromEntries(Object.entries(environment).filter(([key]) => !names.has(key.toUpperCase()))), env);
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
