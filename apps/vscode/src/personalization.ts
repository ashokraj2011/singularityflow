/** Host-local profile bridge. No repository, approval or workflow state is written. */
import { personalizationFromProfile, presentationProfileFile, savePresentationProfile } from '../../../src/personalization.mjs';

export async function synchronizeChatProfile(name: string, environment: NodeJS.ProcessEnv): Promise<boolean> {
  // An explicit blank value suppresses an old mirror and falls back to the active repository's Git name.
  environment.SINGULARITY_FLOW_REPLY_NAME = personalizationFromProfile(name).displayName ?? '';
  try { await savePresentationProfile(name, presentationProfileFile(environment)); return true; }
  catch { return false; } // Personalization must never prevent CLI startup or profile use in this window.
}
