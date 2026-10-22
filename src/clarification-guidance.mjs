/**
 * What `clarification status` says comes next. A record is written against the composed phase
 * prompt, and `clarification record` refuses until that prompt exists for the generation, so a
 * status that leaves recording ahead names `wm compose` first instead of resting.
 */
import { action } from './narration/command-result.mjs';

/** The line the text status adds when recording is ahead of an uncomposed prompt; null otherwise. */
export function clarificationCompositionLine(result) {
  const command = result?.composition?.command;
  return command ? `Before recording an answer, compose this generation's prompt (the record is bound to it): ${command}` : null;
}

/** `{ next }` naming the composition when recording is ahead of it, else the informational rest. */
export function clarificationStatusContinuation(result, phase) {
  const command = result?.composition?.command;
  if (!command) return { restState: 'informational' };
  return { next: [action({
    id: 'compose-before-clarification',
    label: `Compose the ${phase.id} prompt for this generation before recording its clarification`,
    command, rank: 'NOW', kind: 'remediation'
  })] };
}
