import { SingularityFlowError } from './util.mjs';

const TRUE = new Set(['1', 'true', 'yes', 'on']);

function envDisablesModel(env) {
  return TRUE.has(String(env.SINGULARITY_FLOW_NO_MODEL ?? '').trim().toLowerCase());
}

export function resolveModelMode(argv = [], env = process.env) {
  // Models on for this one run, the person's button when models are off and a test command calls one [owner, 2026-11-28].
  if (argv.includes('--models-on')) {
    if (argv.includes('--no-model')) throw new SingularityFlowError('Choose either --no-model or --models-on, not both.', { code: 'MODEL_MODE_CONFLICT' });
    return Object.freeze({ enabled: true, source: 'run' });
  }
  const noModel = argv.includes('--no-model') || envDisablesModel(env);
  const explicitModel = argv.some((token) => token === '--model' || token.startsWith('--model='));
  if (noModel && explicitModel) {
    throw new SingularityFlowError('Choose either --no-model or --model, not both.', {
      code: 'MODEL_MODE_CONFLICT'
    });
  }
  return Object.freeze({
    enabled: !noModel,
    source: argv.includes('--no-model') ? 'cli' : (envDisablesModel(env) ? 'environment' : 'default')
  });
}

export function stripGlobalModelOptions(argv = []) {
  return argv.filter((token) => token !== '--no-model' && token !== '--models-on');
}
