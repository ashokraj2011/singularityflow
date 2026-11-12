/**
 * What an older VS Code cannot do for SFlow, said once and plainly (owner, 2026-11-12: an office runs VS Code 1.114).
 * A warning only: the extension still activates and `engines.vscode` is unchanged; updating VS Code is the fix.
 *
 * What the code and its hosts show:
 *   - Agent plugins (`chat.plugins.enabled`) and chat hooks arrived as previews around VS Code 1.109 to 1.110: before
 *     them SFlow's Copilot plugin (its /sf- skills, its agents and its guard) does not load in VS Code's chat at all.
 *   - A plugin's hooks get their own folder (PLUGIN_ROOT) only from 1.141 (microsoft/vscode#338967): before it every
 *     hook runs the plugin folder `singularity-flow plugin install` recorded (src/copilot-hook-commands.mjs), and with
 *     that record missing or naming a removed copy every tool call in an SFlow chat is refused.
 *   - SFlow is verified live on 1.145: picking a chat model for @sflow (1.142), terminals in a window with no folder
 *     (1.143) and the answer to a question asked in the chat (1.145) were read from those versions.
 */
export const VSCODE_PLUGIN_ROOT_VERSION = '1.141.0';
const VSCODE_PLUGINS_VERSION = '1.110.0';
const VSCODE_VERIFIED_VERSION = '1.145';

/** [major, minor, patch] of a VS Code version ("1.114.2", "1.141.0-insider"), or null. */
function parts(version) {
  const match = /^\s*(\d+)\.(\d+)(?:\.(\d+))?/u.exec(String(version ?? ''));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

function older(version, than) {
  const [a, b] = [parts(version), parts(than)];
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] < b[index];
  return false;
}

/**
 * What does not work on a VS Code older than 1.141, in a person's words, and the fix; null for 1.141 and later, or for
 * a version that cannot be read.
 */
export function vscodeVersionLimits(version) {
  if (!parts(version) || !older(version, VSCODE_PLUGIN_ROOT_VERSION)) return null;
  const limits = [older(version, VSCODE_PLUGINS_VERSION)
    ? 'Copilot agent plugins and chat hooks are not available yet, so SFlow\'s /sf- skills, its agents and its guard do not load in the chat; the SFlow panels and Copilot CLI still work.'
    : 'Copilot agent plugins are still a preview (setting chat.plugins.enabled): SFlow\'s /sf- skills, agents and guard load only with it on.',
  'Chat hooks are not told where SFlow\'s plugin is. They use the folder singularity-flow plugin install recorded, so after every SFlow update run singularity-flow plugin install and reload VS Code, or every tool call in an SFlow chat is refused.',
  `SFlow is checked on VS Code ${VSCODE_VERIFIED_VERSION}; older versions are not.`];
  const shown = String(version).trim();
  return { version: shown, limits,
    summary: `VS Code ${shown} is older than 1.141, so parts of SFlow's Copilot chat do not work here. Update VS Code, then reload the window.`,
    fix: 'Update VS Code (Code > Check for Updates; Help > Check for Updates on Windows and Linux), then reload the window.' };
}

/** The same, as one warning to show: null when there is nothing to warn about. */
export function vscodeVersionWarning(version) {
  const found = vscodeVersionLimits(version);
  return found ? [`VS Code ${found.version} is older than 1.141, which SFlow's Copilot plugin needs to work fully. On this version:`,
    ...found.limits.map((limit) => `- ${limit}`), `Fix: ${found.fix}`].join('\n') : null;
}

/**
 * The VS Code version this command can see: VS Code's own terminal names it (TERM_PROGRAM, TERM_PROGRAM_VERSION),
 * else the `code` command reports it, as `reinstall` finds VS Code; null when neither does.
 */
export function vscodeEditorVersion({ env = process.env, exists, execute } = {}) {
  if (env.TERM_PROGRAM === 'vscode' && parts(env.TERM_PROGRAM_VERSION)) return String(env.TERM_PROGRAM_VERSION).trim();
  if (!exists?.('code') || !execute) return null;
  try {
    const result = execute('code', ['--version'], { allowFailure: true, timeoutMs: 10_000 });
    const first = String(result?.stdout ?? '').split(/\r?\n/u)[0]?.trim();
    return result?.status === 0 && parts(first) ? first : null;
  } catch { return null; }
}
