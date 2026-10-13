/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { gitAnswer } from './git-answer.mjs';

/**
 * Which repository a session command is about. `[session]`
 *
 * The working directory is asked first and always wins when it is a governed repository: a person
 * standing in one clone must never be answered about another, however recently they selected it.
 *
 * When the working directory is not a governed repository, the active workspace selection answers
 * instead. That selection is an explicit act — someone chose this workspace and this repository —
 * and it already records the absolute path. Copilot does not run with its working directory inside
 * the clone, so without this fallback `session status` reported `initialized: false` and the only
 * remedy on offer was to reopen the editor somewhere else. The repository was known the whole time.
 *
 * The caller is always told which of the two answered, because the same JSON otherwise describes
 * two materially different situations.
 */
export function sessionRepositoryRemotes(root) {
  const names = gitAnswer(root, ['remote'], 'Session repository remotes')
    .split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  return [...new Set(['origin', ...names].filter((name) => names.includes(name)))];
}
