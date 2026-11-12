/**
 * The governed configuration roots: every directory repository initialization writes.
 *
 * A leaf module so path classification (application paths, the Copilot edit guard that runs on every
 * tool call) does not load the configuration loader. Importing this one constant from config.mjs
 * pulled about 200 modules into each hook process. config.mjs re-exports it unchanged.
 */
import { governedInitializationRoot, INITIALIZATION_MAPPINGS } from './initialization-assets.mjs';

export const GOVERNED_ROOTS = Object.freeze([
  ...new Set(INITIALIZATION_MAPPINGS.map(([, destination]) => governedInitializationRoot(destination)))
]);

/**
 * SFlow's Copilot hooks (repository-hooks.mjs) run the guard itself, so no agent edit, and no shell write the guard
 * sees, changes them: in any turn and in a plain chat, whatever protectedPaths or policy.plainChatEdits say. SFlow's
 * init and `doctor --repair-hooks` write them in their own process; a person, in their own terminal.
 */
export const isCopilotHooksPath = (relative) => /^\.github\/hooks(?:\/|$)/iu.test(String(relative ?? ''));
export const COPILOT_HOOKS_PROTECTED = 'no agent changes .github/hooks: its Copilot hooks run SFlow\'s guard for every chat in this repository. '
  + 'A person changes them in their own terminal, or runs singularity-flow doctor --repair-hooks there so SFlow writes them again '
  + 'for this repository\'s setting, then reviews and commits them';
