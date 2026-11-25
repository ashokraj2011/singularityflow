/**
 * What SFlow says about a folder VS Code opened through a link, where VS Code's Copilot chat runs no hooks at all, so
 * SFlow's turn boundary and change guard are off (copilot-chat-hooks.mjs found it and says how). One wording for the
 * chat, doctor and the VS Code window, and the window's own checks. `node:path` only: VS Code's extension loads it, and
 * passes its folders and file checks in.
 */
import path from 'node:path';

/** A path for the person's shell: quoted only when it needs it. */
export function shellPath(value, platform = process.platform) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value;
  return platform === 'win32' ? `"${value.replaceAll('"', '""')}"` : `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** What is off and the one fix, for `{ opened, real }`: the folder as VS Code opened it, and its real path. */
export function linkedFolderNotice({ opened, real }, platform = process.platform) {
  const command = `code ${shellPath(real, platform)}`;
  return {
    cause: 'linked-folder', opened, real, command,
    because: `VS Code opened this folder as ${opened}, a link to ${real}, and VS Code's Copilot chat runs no hooks in a folder opened through a link.`,
    fix: `Open the folder at its real path, then start a new chat there: ${command}`
  };
}

const sameSpelling = (a, b, caseInsensitive) => (caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * The folders whose real path differs from the path VS Code opened them by, as `{ opened, real }`. A difference of
 * letter case alone is not a link where the file system ignores case (macOS and Windows by default), and a folder that
 * cannot be resolved is left out.
 */
export async function linkedFolders(opened, realpath, caseInsensitive = process.platform !== 'linux') {
  const found = [];
  for (const folder of opened) {
    const resolved = path.resolve(folder);
    const real = await realpath(resolved).catch(() => null);
    if (!real || sameSpelling(real, resolved, caseInsensitive)) continue;
    found.push({ opened: resolved, real });
  }
  return found;
}

/** Whether SFlow guards this folder: it carries SFlow's configuration or the repository's own Copilot hooks. */
export async function usesSflowFolder(folder, exists) {
  for (const relative of [path.join('.github', 'hooks', 'sflow.json'), 'singularity']) {
    if (await exists(path.join(folder, relative))) return true;
  }
  return false;
}

/**
 * What a VS Code window says about one linked folder: the status bar's text and tooltip, the warning and its one button.
 * A window of several folders cannot become one folder in place, so there the real one opens in a window of its own.
 */
export function linkedFolderPrompt(linked, { multiRoot = false, platform = process.platform } = {}) {
  const notice = linkedFolderNotice(linked, platform);
  const action = multiRoot ? 'Open real folder' : 'Reopen at real path';
  return {
    message: `SFlow's guard is off in this window's Copilot chats: ${notice.because} ${multiRoot
      ? `Open ${linked.real} in a window of its own to turn it back on.` : 'Reopen the folder at its real path to turn it back on.'}`,
    action,
    status: '$(warning) SFlow guard off',
    tooltip: ['Copilot runs no hooks in this window\'s chats, so SFlow records no turn and checks no change.',
      notice.because, `Click to ${multiRoot ? `open ${linked.real} in a new window` : `reopen at ${linked.real}`}, or run: ${notice.command}`].join('\n'),
    newWindow: multiRoot
  };
}
