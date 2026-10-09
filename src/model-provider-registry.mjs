import { SingularityFlowError } from './util.mjs';
import { invokeCopilotCli, openCopilotSession } from './model-providers/copilot-cli.mjs';

const providers = Object.freeze({ 'copilot-cli': invokeCopilotCli });
// Providers that can keep one session open for several prompts (see createModelSession).
const sessions = Object.freeze({ 'copilot-cli': openCopilotSession });

export function modelProvider(id) {
  const provider = providers[id];
  if (!provider) throw new SingularityFlowError(`Unknown model provider '${id}'.`, { code: 'MODEL_PROVIDER_UNKNOWN' });
  return provider;
}

export function modelProviderIds() { return Object.keys(providers); }

/** The session opener for a provider, or null when it runs every prompt in its own process. */
export function modelProviderSession(id) { return sessions[id] ?? null; }
