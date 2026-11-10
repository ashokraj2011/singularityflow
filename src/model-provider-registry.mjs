import {COPILOT_CLI_PROVIDER_ID} from './model-limits.mjs';
import { SingularityFlowError } from './util.mjs';
import { invokeCopilotCli, openCopilotSession } from './model-providers/copilot-cli.mjs';

const providers = Object.freeze({ [COPILOT_CLI_PROVIDER_ID]: invokeCopilotCli });
// Providers that can keep one session open for several prompts (see createModelSession).
const sessions = Object.freeze({ [COPILOT_CLI_PROVIDER_ID]: openCopilotSession });

export function modelProvider(id) {
  const provider = providers[id];
  if (!provider) throw new SingularityFlowError(`Unknown model provider '${id}'.`, { code: 'MODEL_PROVIDER_UNKNOWN' });
  return provider;
}

export function modelProviderIds() { return Object.keys(providers); }

/** The session opener for a provider, or null when it runs every prompt in its own process. */
export function modelProviderSession(id) { return sessions[id] ?? null; }
