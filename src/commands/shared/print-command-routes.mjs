/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { safeCommandGuidance, commandRouteLines } from '../../safe-command-guidance.mjs';

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
  if (!guidance) console.log(`${indent}The supplied command could not be safely displayed.`);
  for (const line of commandRouteLines(guidance ?? {}, indent)) console.log(line);
}
