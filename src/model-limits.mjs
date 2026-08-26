// Copilot CLI validates this option before starting either its ACP server or legacy prompt path.
// Current releases refuse values below 30, so the runner and every Copilot transport share one
// reviewed floor without importing a provider implementation across the model boundary.
export const COPILOT_MINIMUM_AI_CREDITS = 30;
