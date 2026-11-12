/**
 * A result the host never showed is handed to the agent by the post-tool hook [office, 2026-11-12].
 *
 * VS Code 1.144 ran `/sf-session`'s `session open --for-agent --json` twice: once its terminal tool showed
 * nothing, once only "exit code 1", and asking it for the output said "no active terminal instance". The agent
 * stopped and asked the person for the error. 143 of 192 skills never told it how to read the result again
 * (`result last`), and a terminal that shows nothing would show `result last` nothing as well.
 *
 * The CLI keeps every `--for-agent` result machine-locally (agent-result-keeper.mjs). So after a shell call
 * that ran an SFlow `--for-agent` command whose response does not carry its result, the post-tool hook (and the
 * failed-tool hook) adds that kept result to the agent's context: the bounded view the command printed, kept
 * beside it (agent-output.mjs builds it once, in the command; this module never loads it, which also keeps it
 * out of the VS Code bundles). Still running, it names the read that waits; interrupted, the read that says where
 * it left things. Every skill and a plain chat get it, on both hosts, with no skill text. It runs no command.
 */
import { lastAgentResult } from './agent-result-keeper.mjs';

const SHELL_TOOLS = new Set(['bash', 'powershell', 'shell', 'run_in_terminal', 'execute', 'exec_command']);
// An SFlow result the host did show: its agent view, a refusal, or a kept result read again.
const SHOWN = /\\*"(?:act|resultType|remediationPlan|keptResult)\\*"\s*:/u;
// Older than this, a kept result of the same command is not this call's.
const RECENT_MS = 15 * 60 * 1000;
// A kept result without its view is given whole only up to an agent view's size (agent-output.mjs).
const MAX_WHOLE = 7_500;

/** The SFlow commands a payload's shell calls ran, each with its folder. */
function sflowShellCalls(payload) {
  const raw = payload.toolCalls ?? [{ name: payload.toolName ?? payload.tool_name, args: payload.toolArgs ?? payload.tool_input }];
  const found = [];
  for (const call of Array.isArray(raw) ? raw.slice(0, 16) : []) {
    let args = call?.args ?? call?.toolArgs ?? call?.tool_input ?? call?.arguments ?? call?.input ?? {};
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = { command: args }; } }
    const name = String(call?.name ?? call?.toolName ?? call?.tool_name ?? '').toLowerCase().split(/[.:]|__/u).at(-1);
    const line = typeof args?.command === 'string' ? args.command : typeof args?.input === 'string' ? args.input : null;
    if (!SHELL_TOOLS.has(name) || !line) continue;
    const command = line.match(/(?:^|[\s;&|(])((?:singularity-flow|sflow)\s+[^;&|\n]+)/u)?.[1]?.trim();
    if (command && /(?:^|\s)--for-agent(?:\s|=|$)/u.test(command)) found.push({ command, cwd: typeof args.cwd === 'string' ? args.cwd : payload.cwd });
  }
  return found;
}

/** What the host returned for the call, as text (Copilot CLI `toolResult`, VS Code `tool_response`, a failure's error). */
function responseText(payload) {
  const response = payload.toolResult ?? payload.tool_result ?? payload.tool_response ?? payload.toolResponse ?? payload.error ?? payload.tool_error ?? '';
  // Copilot CLI wraps the text in its own `{ resultType, textResultForLlm }`: only the text is what the agent saw.
  if (typeof response?.textResultForLlm === 'string') return response.textResultForLlm;
  try { return typeof response === 'string' ? response : JSON.stringify(response); } catch { return ''; }
}

const words = (command) => command.replace(/^(?:singularity-flow|sflow)\s+/u, '').split(/\s+/u).filter((word) => word && !word.startsWith('-')).join(' ');

/**
 * The context to add after `payload`'s tool call, or null: when it ran an SFlow `--for-agent` command and its
 * response carries no SFlow result, that command's kept result (or how to read it when it is still running).
 */
export async function unreadResultContext(payload = {}, { env = process.env, now = Date.now() } = {}) {
  if (SHOWN.test(responseText(payload))) return null;
  for (const { command, cwd } of sflowShellCalls(payload)) {
    const found = await lastAgentResult({ cwd: cwd ?? process.cwd(), env, command, wait: 0 }).catch(() => null);
    const asked = words(command);
    if (found?.status === 'running') {
      return `SFlow: your terminal did not show the result of \`${command}\`; it is still running. Read its result with `
        + `\`singularity-flow result last --wait --command "${asked}" --for-agent --json\`. Never run it again, and never ask the person for its output.`;
    }
    if (found?.status === 'interrupted') {
      const { safeReadFor } = await import('./commands/result.mjs');
      return `SFlow: \`${command}\` ended without a result (interrupted or killed). Read where it left things with \`${safeReadFor(command)}\` `
        + 'before running it once more; never ask the person for its output.';
    }
    if (found?.status !== 'kept' || now - Date.parse(found.kept.finishedAt) > RECENT_MS) continue;
    // The view the agent was shown when the command printed it; an older kept result has only its whole output.
    const whole = String(found.kept.output ?? '');
    const view = typeof found.kept.view === 'string' ? found.kept.view
      : whole.length <= MAX_WHOLE ? whole : null;
    if (!view) {
      return `SFlow: your terminal did not show the result of \`${command}\`. Read it with \`singularity-flow result last --command "${asked}" --for-agent --json\`; `
        + 'never run the command again, and never ask the person for its output.';
    }
    return `SFlow: your terminal did not show the result of \`${command}\`. SFlow kept it (finished ${found.kept.finishedAt}); `
      + `it follows, exactly as that command returned it. Act on it as its result: never run the command again, and never ask the person for its output.\n${String(view).trimEnd()}`;
  }
  return null;
}

/** A hook answer with `context` added to whatever it already says to the agent. */
export function withUnreadResult(answer, context) {
  if (!context) return answer ?? {};
  const given = answer && typeof answer === 'object' ? answer : {};
  return { ...given, additionalContext: given.additionalContext ? `${given.additionalContext}\n\n${context}` : context };
}
