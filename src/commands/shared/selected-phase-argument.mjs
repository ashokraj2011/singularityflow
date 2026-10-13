/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { optionString, SingularityFlowError } from '../../util.mjs';

export function selectedPhaseArgument(positionals, options, command) {
  const positional = positionals[1];
  const flagged = optionString(options, 'phase');
  if (positional && flagged && positional !== flagged) {
    throw new SingularityFlowError(`${command} received two different phases: '${positional}' and '${flagged}'. Pass the phase once, either positionally or with --phase.`);
  }
  return flagged ?? positional;
}
