/**
 * Shared standalone-agent safeguards. Bundled Markdown repeats these boundaries deliberately:
 * each profile can be selected without another agent or skill already loaded. Studio uses the
 * same source, and the guidance contract test catches drift in the shipped profiles.
 */
const STORY_CHECKOUT = 'Resolve the active Story checkout with `singularity-flow session current --json`; require `ready`, bind `workId`, and use its absolute `repositoryPath` as cwd for every shell and file tool.';
const REPOSITORY_SCOPE = 'Never search `$HOME`, a parent directory, or outside that repository. Use CLI-returned `workItemRoot` and artifact or packet paths for governed Story reads and writes; keep them within the bound `workId`.';

export const STORY_AGENT_BOUNDARY = `${STORY_CHECKOUT} ${REPOSITORY_SCOPE}`;
export const REPOSITORY_AGENT_BOUNDARY = `${STORY_CHECKOUT} If no Story is attached, use \`git rev-parse --show-toplevel\`; stop if neither resolves. ${REPOSITORY_SCOPE}`;

// The composer owns the mode-specific protocol and final guard; role prompts add only topics.
export const AGENT_CLARIFICATION_GUIDANCE = "Follow the composed phase prompt's pinned clarification checkpoint before authoring; its mode and recording instructions override generic agent guidance.";
