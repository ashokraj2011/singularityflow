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
import { statSync } from 'node:fs';
import path from 'node:path';
import { lastAgentResult, noteAgentCall } from './agent-result-keeper.mjs';

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

// Its words without options or their values: a value (a --report-file path) matched no kept command (2026-11-20).
const words = (command) => {
  const kept = [];
  let value = false;
  for (const word of command.replace(/^(?:singularity-flow|sflow)\s+/u, '').split(/\s+/u).filter(Boolean)) {
    if (word.startsWith('-')) { value = !word.includes('='); continue; }
    if (value) { value = false; continue; }
    kept.push(word);
  }
  return kept.join(' ');
};

/**
 * Before the tool call runs (the pre-tool hook): note each SFlow `--for-agent` command it is about to run, so the
 * post-tool hook never hands over a result kept before this call as this call's (agent-result-keeper.mjs).
 */
export function noteAgentCalls(payload = {}, { env = process.env, now = Date.now() } = {}) {
  for (const { command, cwd } of sflowShellCalls(payload)) noteAgentCall(command, { cwd: cwd ?? process.cwd(), env, now });
}

/** The file a command reads by `--report-file` when it changed after `since` (epoch ms): `{ file, at }`, else null. */
function inputChangedAfter(command, cwd, since) {
  const file = command.match(/(?:^|\s)--report-file(?:=|\s+)("[^"]+"|'[^']+'|\S+)/u)?.[1]?.replace(/^["']|["']$/gu, '');
  if (!file || !Number.isFinite(since)) return null;
  try {
    const modified = statSync(path.resolve(cwd, file)).mtimeMs;
    return modified > since ? { file, at: new Date(modified).toISOString() } : null;
  } catch { return null; }
}

// How long the post-tool hook waits, at most, for a noted call's own run to start (its hook has ten seconds).
const ARRIVAL_SECONDS = 3;

/**
 * The context to add after `payload`'s tool call, or null: when it ran an SFlow `--for-agent` command and its
 * response carries no SFlow result, that command's kept result (or how to read it when it is still running).
 * A result kept before this call is an earlier run's, never handed over as this call's [owner, 2026-11-20].
 */
export async function unreadResultContext(payload = {}, { env = process.env, now = Date.now(), arrival = ARRIVAL_SECONDS } = {}) {
  if (SHOWN.test(responseText(payload))) return null;
  for (const { command, cwd } of sflowShellCalls(payload)) {
    const found = await lastAgentResult({ cwd: cwd ?? process.cwd(), env, command, wait: 0, arrival }).catch(() => null);
    const asked = words(command);
    if (found?.status === 'none' && found.since) {
      return `SFlow: your terminal did not show the result of \`${command}\`, and SFlow kept no result of this call (started ${found.since}); `
        + 'a result kept before it is an earlier run\'s, never this one\'s. In the terminal that ran it, read '
        + `\`singularity-flow result last --wait --command "${asked}" --for-agent --json\`: act on it only if its keptResult.startedAt is ${found.since} or later; `
        + 'otherwise the command did not run here, so run it once more. Never ask the person for its output.';
    }
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
    // A file the command reads (--report-file) changed after that run started: the kept result is about other bytes,
    // never this call's (the owner's corrected review packet, 2026-11-20).
    const changed = inputChangedAfter(command, cwd ?? process.cwd(), Date.parse(found.kept.startedAt));
    if (changed) {
      return `SFlow: your terminal did not show the result of \`${command}\`, and the result SFlow kept for it is an earlier run's: `
        + `${changed.file} changed at ${changed.at}, after that run started. In the terminal that ran it, read `
        + `\`singularity-flow result last --wait --command "${asked}" --for-agent --json\`: act on it only if its keptResult.startedAt is ${changed.at} or later; `
        + 'otherwise run the command once more. Never ask the person for its output.';
    }
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
