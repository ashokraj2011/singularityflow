import { SingularityFlowError } from './util.mjs';
import { invokeCopilotCli } from './model-providers/copilot-cli.mjs';

const providers = Object.freeze({ 'copilot-cli': invokeCopilotCli });

export function modelProvider(id) {
  const provider = providers[id];
  if (!provider) throw new SingularityFlowError(`Unknown model provider '${id}'.`, { code: 'MODEL_PROVIDER_UNKNOWN' });
  return provider;
}

export function modelProviderIds() { return Object.keys(providers); }
