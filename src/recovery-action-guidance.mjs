/** Presentation only. Keep decisions/hashes separate from verified command routing. */
import { safeCommandGuidance } from './safe-command-guidance.mjs';

export function recoveryActionGuidance(action) {
  const commandGuidance = action?.command ? safeCommandGuidance(action) : null;
  return { ...action, commandGuidance, copilotCommand: commandGuidance?.copilotCommand ?? null };
}
