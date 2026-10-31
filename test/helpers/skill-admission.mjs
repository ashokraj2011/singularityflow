/**
 * Whether a command SFlow names as a route is one its Copilot skill carries out (sweep E7,
 * 2026-10-31): help named /sf-doctor for `index`, `lock show` and `backup inspect`, a skill that never
 * ran them, so the route ended where it began. A routed command is admitted when its skill's body
 * names it (`singularity-flow <family> <sub>`, a `|`-separated choice counting for each option) and
 * the skill's turn admits its argv. A command with no Copilot route is the person's terminal step.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { argvAllowed } from '../../src/copilot-mutation-guard.mjs';
import { mutationTurnMode } from '../../src/phase-mutation-contract.mjs';
import { safeCommandGuidance } from '../../src/safe-command-guidance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bodies = new Map();

async function skillBody(skill) {
  if (!bodies.has(skill)) {
    bodies.set(skill, readFile(path.join(root, 'plugin', 'skills', skill.replace(/^sf-/u, 'sflow-'), 'SKILL.md'), 'utf8'));
  }
  return bodies.get(skill);
}

/** Each `singularity-flow <family> <word>` the body names, a choice `a|b` counting for each option. */
function namedCommands(body) {
  const named = new Set();
  for (const [, family, words] of body.matchAll(/singularity-flow ([a-z][a-z-]*)(?: ([a-z][a-z|-]*))?/gu)) {
    named.add(family);
    for (const word of (words ?? '').split('|').filter(Boolean)) named.add(`${family} ${word}`);
  }
  return named;
}

/**
 * { command, skill, named, admitted }; skill null when the command has no Copilot route. `copilot`
 * is the route a plan step shows, when its producer named the skill itself.
 */
export async function routeAdmission(command, copilot = null) {
  const guidance = safeCommandGuidance({ command });
  if (!guidance) return { command, skill: null, rejected: true, named: false, admitted: false };
  const skill = (copilot ?? guidance.copilotCommand)?.replace(/^\//u, '').split(/\s+/u)[0] ?? null;
  if (!skill) return { command, skill: null, named: false, admitted: false };
  const [family, sub] = guidance.argv;
  const body = await skillBody(skill);
  const named = namedCommands(body);
  const subcommand = /^[a-z][a-z-]*$/u.test(sub ?? '') ? sub : null;
  // A relay skill (/sf-sgos) runs `singularity-flow $ARGUMENTS` for each family its hint lists.
  const relayed = body.includes('singularity-flow $ARGUMENTS')
    && new RegExp(`^argument-hint: .*[<|]${family}[|>]`, 'mu').test(body);
  return {
    command, skill,
    named: relayed || (subcommand ? named.has(`${family} ${subcommand}`) : named.has(family)),
    admitted: argvAllowed(guidance.argv, mutationTurnMode(skill), { contract: {}, skill: `/${skill}` }) === true
  };
}
