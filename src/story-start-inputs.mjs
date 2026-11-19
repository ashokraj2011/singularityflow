import { SingularityFlowError } from './util.mjs';

/**
 * Preserve the local-only base refusal while showing the complete new-Story input shape. `branches` are the
 * bases this clone already knows, the usual one first: refusal-remediation.mjs runs the same start again
 * once per branch, so nobody types a branch name [audit 2026-11-19, entry 12].
 */
export function storyBaseRequired(id, { branches = [] } = {}) {
  const inspectCommand = `singularity-flow workspace branches --preflight-story ${id} --json`;
  return new SingularityFlowError(
    `Choose the branch Story '${id}' starts from${branches.length ? `: ${branches.join(', ')}` : ''}. A new manual one also needs `
    + `--work-type, --title and --description; to resume it: singularity-flow resume ${id} --fetch.`,
    { code: 'STORY_BASE_REQUIRED', details: { ...(branches.length ? { branches, defaultBranch: branches[0] } : { nextAction: inspectCommand }),
      requiredChoices: ['base', 'workflow', 'intake-source'],
      recoveryCommands: [`singularity-flow resume ${id} --fetch`] } }
  );
}

/** Aggregate only choices still absent after the exact base seed and receipt have been read. */
export function assertStoryStartChoices({ nonInteractive, workType, source, manualInput }) {
  if (!nonInteractive) return;
  // The existing test-only selection bridge is resolved by selectWorkType/selectIntakeSource.
  if (process.env.NODE_ENV === 'test' && process.env.SINGULARITY_FLOW_TEST_SELECTION) return;
  const missing = [];
  if (!workType) missing.push('--work-type <WORKFLOW>');
  if (!source) missing.push('--jira, --github <ISSUE>, --story-file <FILE>, or --title <TITLE> with --description <DESCRIPTION>');
  else if (source === 'manual' && !manualInput) missing.push('--story-file <FILE> or --title <TITLE> with --description <DESCRIPTION>');
  if (missing.length) throw new SingularityFlowError(
    `Story intake needs these choices together: ${missing.join('; ')}. No Story was created.`,
    { code: 'STORY_INPUTS_REQUIRED', details: { missingInputs: missing,
      nextAction: 'singularity-flow workspace branches --intake --json' } }
  );
}
