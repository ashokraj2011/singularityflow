/**
 * Shared standalone-agent safeguards. Bundled Markdown repeats these boundaries deliberately:
 * each profile can be selected without another agent or skill already loaded. Studio uses the
 * same source, and the guidance contract test catches drift in the shipped profiles.
 */
import { CLI_PATH_CONTRACT } from './safe-command-guidance.mjs';

const STORY_CHECKOUT = 'Resolve the active Story checkout from this invocation\'s verified entry packet. The canonical skill owns pause/binding; do not preflight it again. Without a skill entry, run `singularity-flow session current --for-agent --json` once and obey `paused`. Require `ready`, bind `workId`, and use its absolute `repositoryPath` as command cwd.';
const REPOSITORY_SCOPE = 'Never discover repositories by searching `$HOME`, parents or unrelated directories. Use the CLI\'s exact artifact, packet and staging paths for this binding.';

export const STORY_AGENT_BOUNDARY = `${STORY_CHECKOUT} ${REPOSITORY_SCOPE} ${CLI_PATH_CONTRACT}`;
export const REPOSITORY_AGENT_BOUNDARY = `${STORY_CHECKOUT} If no Story is attached, use \`git rev-parse --show-toplevel\`; stop if neither resolves. ${REPOSITORY_SCOPE} ${CLI_PATH_CONTRACT}`;

// The composer owns the mode-specific protocol and final guard; role prompts add only topics.
export const AGENT_CLARIFICATION_GUIDANCE = "Follow the composed phase prompt's pinned clarification checkpoint before authoring; its mode and recording instructions override generic agent guidance.";
