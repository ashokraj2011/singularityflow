/**
 * Whether SFlow's Copilot hooks ran in the chat a command runs in, and when they did not, why and the one fix.
 *
 * VS Code's agent host (client `vscode-agent-host`, VS Code 1.147 with Copilot runtime 1.0.111) runs no command hook
 * at all in a chat whose folder VS Code opened through a link: on macOS /tmp/x is /private/tmp/x. SFlow's plugin hooks
 * and the repository's own .github/hooks are both skipped, nothing is logged, and the chat otherwise works, so SFlow's
 * turn boundary and change guard are off while everything looks fine. Probes on 2026-11-25 with VS Code's own runtime
 * and a local stand-in model: the same plugin and folder ran every hook when the folder was given by its real path,
 * and none through a link once the host granted the folder its trust, as VS Code does for a trusted window. Copilot
 * CLI 1.0.115 ran them from a link too.
 *
 *   noteHookSession        SFlow's prompt hook and guard leave one small file per chat they see (copilot-hook-sessions.mjs)
 *   copilotChatHookGap     a command run by a Copilot chat (which carries COPILOT_AGENT_SESSION_ID) in a chat no SFlow
 *                          hook saw: what is off, why, and the command that fixes it; null when nothing is wrong
 *   vscodeLinkedOpenings   the VS Code windows that opened a folder through a link (vscode-linked-openings.mjs)
 *   linkedTerminalFolder   the folder a terminal stands in, when its shell reached it through a link (PWD)
 *
 * Node built-ins only; never Git, network or a child process. Every reader fails quietly: a check that cannot read
 * says nothing rather than something wrong.
 */
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copilotHome } from './copilot-home.mjs';
import { copilotModeFile, readCopilotMode } from './copilot-mode.mjs';
import { hookSessionSeen, latestHookAt } from './copilot-hook-sessions.mjs';
import { linkedFolderNotice, shellPath } from './linked-folder-notice.mjs';
import { GENERIC_INTENT, stopAdvice } from './step-advice.mjs';
import { vscodeLinkedOpenings } from './vscode-linked-openings.mjs';

export { HOOK_SESSIONS_DIRECTORY, hookSessionsDirectory, noteHookSession } from './copilot-hook-sessions.mjs';
export { linkedFolderNotice, shellPath };
export { vscodeLinkedOpenings, vscodeUserDataDirectories } from './vscode-linked-openings.mjs';

// Any SFlow hook within this long: a sub-agent's call can carry an id other than the one its hooks name.
const RECENT_HOOK_MS = 30_000;
export const VSCODE_AGENT_HOST_CLIENT = 'vscode-agent-host';

const validId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256
  && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;

function small(file, limit = 64 * 1024) {
  try {
    const stat = statSync(file);
    return stat.isFile() && stat.size <= limit ? readFileSync(file, 'utf8') : null;
  } catch { return null; }
}

function real(target) {
  try { return realpathSync.native(target); } catch { return null; }
}

/** The host Copilot names for a session (`client_name` in its session-state workspace.yaml), or null. */
export function copilotChatClient(sessionId, env = process.env) {
  const id = validId(sessionId);
  if (!id || id.includes('/') || id.includes('\\') || id === '.' || id === '..') return null;
  const state = env.SINGULARITY_FLOW_COPILOT_SESSION_STATE
    ? path.resolve(env.SINGULARITY_FLOW_COPILOT_SESSION_STATE) : path.join(copilotHome({ env }), 'session-state');
  const text = small(path.join(state, id, 'workspace.yaml'));
  const match = text && /^client_name:\s*["']?([A-Za-z0-9._-]{1,64})["']?\s*$/mu.exec(text);
  return match ? match[1] : null;
}

/** Whether SFlow's hooks are meant to run for `folder`: the plugin's launcher is recorded, or the repository carries its own. */
function hooksExpected(folder, env) {
  const marker = path.join(path.dirname(copilotModeFile(env)), 'copilot-plugin');
  const root = small(marker, 4096)?.split(/\r?\n/u)[0]?.trim();
  if (root && path.isAbsolute(root) && small(path.join(root, 'hook-launcher.sh'), 1024 * 1024) !== null) return true;
  for (let directory = folder ? path.resolve(folder) : null, depth = 0; directory && depth < 64; depth += 1) {
    try { if (lstatSync(path.join(directory, '.github', 'hooks', 'sflow.json')).isFile()) return true; } catch { /* keep looking */ }
    try { if (lstatSync(path.join(directory, '.git'))) return false; } catch { /* not the top yet */ }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return false;
}

/** The folder a shell stands in as it reached it (PWD), when that is a link to `cwd`; null otherwise. */
export function linkedTerminalFolder({ env = process.env, cwd = process.cwd() } = {}) {
  const logical = typeof env.PWD === 'string' && path.isAbsolute(env.PWD) ? path.resolve(env.PWD) : null;
  const physical = real(cwd);
  if (!logical || !physical || logical === physical || real(logical) !== physical) return null;
  return { opened: logical, real: physical };
}

/**
 * A command run by a Copilot chat (COPILOT_AGENT_SESSION_ID) in a chat none of SFlow's hooks saw, or null: outside a
 * chat, paused, hooks seen, not expected here, or SINGULARITY_FLOW_COPILOT_HOOK_CHECK=off.
 */
export function copilotChatHookGap({ env = process.env, cwd = process.cwd(), root = null, now = Date.now(),
  platform = process.platform, home = os.homedir() } = {}) {
  try {
    const sessionId = validId(env.COPILOT_AGENT_SESSION_ID);
    if (!sessionId || env.SINGULARITY_FLOW_COPILOT_HOOK_CHECK === 'off') return null;
    if (hookSessionSeen(sessionId, env)) return null;
    const latest = latestHookAt(env);
    if (latest !== null && now - latest >= 0 && now - latest < RECENT_HOOK_MS) return null;
    if (readCopilotMode(copilotModeFile(env, home)).paused) return null;
    const folder = root ?? cwd;
    if (!hooksExpected(folder, env)) return null;
    const client = copilotChatClient(sessionId, env);
    const headline = 'SFlow\'s guard is off in this chat: Copilot ran none of SFlow\'s hooks here, so SFlow recorded no turn and checks no change.';
    const vscode = client === VSCODE_AGENT_HOST_CLIENT || /vscode/iu.test(client ?? '');
    const linked = vscode ? vscodeLinkedOpenings(folder, { env, home, platform })[0] ?? null : null;
    if (linked) {
      const notice = linkedFolderNotice(linked, platform);
      return { code: 'SFLOW_HOOKS_OFF', sessionId, client, ...notice, message: `${headline} ${notice.because}` };
    }
    // The way on is the step advice's hooks line (step-advice.mjs), so every surface that shows this stop says the same.
    const fix = vscode
      ? `${stopAdvice(GENERIC_INTENT, 'hooks')} If it happens again, run singularity-flow doctor in VS Code's terminal.`
      : 'Start a new chat; if it happens again, run singularity-flow doctor.';
    return { code: 'SFLOW_HOOKS_OFF', sessionId, client, cause: 'hooks-not-run', command: 'singularity-flow doctor',
      because: `${client ? `This Copilot host (${client})` : 'This Copilot host'} did not run them.`, fix,
      message: `${headline} ${client ? `This Copilot host (${client})` : 'This Copilot host'} did not run them.` };
  } catch { return null; }
}

/** The one line a chat's agent and its person read; an agent is told to stop there. */
export function hookGapLine(gap) {
  return `${gap.code}: ${gap.message} Fix: ${gap.fix}`;
}

/** What a skill's first command tells the agent when the chat's hooks did not run. */
export function hookGapAgentInstruction(gap) {
  return `${hookGapLine(gap)} Tell the person exactly this, with the fix, then stop: run no other SFlow command and make no change for SFlow in this chat.`;
}

/** The act every --for-agent result leads with in such a chat: say it and end the turn (agent-output.mjs). */
export function hookGapAct(gap) {
  return { state: 'end-turn', said: hookGapAgentInstruction(gap), do: null };
}

let processGap;
/** This command's answer, worked out at most once: root dispatch, a skill's pause read and the agent view share it. */
export function processChatHookGap() {
  if (processGap === undefined) processGap = copilotChatHookGap();
  return processGap;
}

/** Root dispatch's line on stderr, once, for a command a chat runs where the hooks never saw it. */
export function sayHookGap() {
  const gap = processChatHookGap();
  if (gap) process.stderr.write(`${hookGapLine(gap)}\n`);
  return gap;
}
