import { SingularityFlowError } from './util.mjs';

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
