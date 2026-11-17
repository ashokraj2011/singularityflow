import os from 'node:os';
import path from 'node:path';

/**
 * Copilot's own home, as Copilot finds it: COPILOT_HOME when set, else ~/.copilot. Its sessions, logs, settings, MCP
 * configuration, plugins and skills live there. Every SFlow reader of them takes the folder from here, so SFlow and
 * the person's Copilot never look in two homes. test/copilot-home.test.mjs holds that line.
 */
export function copilotHome({ env = process.env, homeDirectory = os.homedir() } = {}) {
  return path.resolve(String(env.COPILOT_HOME ?? '').trim() || path.join(homeDirectory, '.copilot'));
}

/** What a Copilot launch that passes only listed variables keeps, so the Copilot it starts finds the same home. */
export const COPILOT_HOME_ENVIRONMENT = Object.freeze(['COPILOT_HOME']);
