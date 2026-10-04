import { SingularityFlowError } from './util.mjs';

/** Preserve the local-only base refusal while showing the complete new-Story input shape. */
export function storyBaseRequired(id) {
  const inspectCommand = `singularity-flow workspace branches --preflight-story ${id} --json`;
  return new SingularityFlowError(
    `Choose the remote base branch explicitly with --from-branch <BRANCH>. No locally known `
    + `governed Story '${id}' can be resumed, so Singularity Flow did not start remote or `
    + `configuration discovery. Inspect available bases with: ${inspectCommand}. For an existing `
    + `remote Story, run singularity-flow resume ${id} --fetch. Nothing was changed. `
    + 'For a new manual Story, provide all choices together: --from-branch <BRANCH> '
    + '--work-type <WORKFLOW> --title <TITLE> --description <DESCRIPTION> '
    + '(or --story-file <FILE> instead of title/description). A governed seed or selection receipt can supply these choices.',
    { code: 'STORY_BASE_REQUIRED', details: { nextAction: inspectCommand,
      requiredChoices: ['base', 'workflow', 'intake-source'],
      recoveryCommands: [`singularity-flow start ${id} --from-branch <BRANCH>`,
        `singularity-flow resume ${id} --fetch`] } }
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
