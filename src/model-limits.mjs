// Copilot CLI validates this option before starting either its ACP server or legacy prompt path.
// Current releases refuse values below 30, so the runner and every Copilot transport share one
// reviewed floor without importing a provider implementation across the model boundary.
export const COPILOT_MINIMUM_AI_CREDITS = 30;

// Copilot's reported total includes its own session instructions. Browser Ask observed about
// 13,200 tokens for a 1 KiB request. Keep a total ceiling alongside the tighter SFlow limits
// on prompt bytes, response bytes, tool access and turns.
export const ASK_COPILOT_MAX_TOTAL_TOKENS = 24_576;
