/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { safeCommandGuidance } from '../../safe-command-guidance.mjs';

/**
 * Print one actionable CLI instruction through all supported user surfaces.
 *
 * Keep this at the presentation boundary: callers still execute exactly one governed mutation,
 * while a reader can choose either the shell command or the owning Copilot skill without having
 * to translate the command by hand.
 */
export function printCommandRoutes(command, { skill = null, indent = '', label = null } = {}) {
  if (label) console.log(`${indent}${label}:`);
  const guidance = safeCommandGuidance(typeof command === 'string'
    ? { command, skill }
    : { ...command, skill });
  if (!guidance) {
    console.log(`${indent}Copilot: unavailable — ask /sf-next for a current action.`);
    console.log(`${indent}Shell: unavailable — the supplied command was not safe to display.`);
    console.log(`${indent}VS Code (model-free): not available for this action`);
    return;
  }
  console.log(`${indent}Copilot: ${guidance.copilotCommand}`);
  console.log(`${indent}Shell: ${guidance.command}`);
  console.log(`${indent}VS Code (model-free): ${guidance.modelFreeCommand ?? 'not available for this action'}`);
}
