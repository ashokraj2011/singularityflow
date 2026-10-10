import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSkillPolicy } from './skill-policy.mjs';
import { PHASE_ENTRY_SKILLS } from '../src/copilot-mode.mjs';
import { readNativeCopilotTrace, summarizeNativeCopilotTrace } from '../src/native-copilot-efficiency.mjs';
import { retainedPromptInventory } from '../src/retained-prompt-inventory.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const options = {};
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--details' && !options[argument]) { options[argument] = true; continue; }
    if (!['--trace', '--story-dir'].includes(argument) || !args[index + 1]
        || args[index + 1].startsWith('--') || options[argument]) throw new Error('Use [--details] [--trace <EXPORTED-JSON>] [--story-dir <EXACT-STORY-DIRECTORY>].');
    options[argument] = args[++index];
  }
  const skills = await auditSkillPolicy(root);
  const rows = skills.rows.map(row => ({ name: row.name, estimatedBodyTokens: row.bodyTokens,
    entry: PHASE_ENTRY_SKILLS.includes(row.name) ? 'operation-entry'
      : row.class === 'delegation' ? 'delegated'
        : row.executionBoundary === 'story' ? 'session-entry' : 'pause-only',
    executionBoundary: row.executionBoundary, maximumTokens: row.maximumTokens }));
  const trace = options['--trace'] ? summarizeNativeCopilotTrace(await readNativeCopilotTrace(path.resolve(options['--trace']))) : null;
  const prompts = options['--story-dir'] ? await retainedPromptInventory(path.resolve(options['--story-dir'])) : null;
  const entryStrategies = {};
  for (const row of rows) entryStrategies[row.entry] = (entryStrategies[row.entry] ?? 0) + 1;
  console.log(JSON.stringify({ schemaVersion: 1, resultType: 'native-copilot-efficiency-audit',
    skillCount: rows.length, entryStrategies,
    largestSkills: [...rows].sort((left, right) => right.estimatedBodyTokens - left.estimatedBodyTokens).slice(0, 10),
    ...(options['--details'] ? { skills: rows } : {}), errors: skills.errors, trace, prompts,
    limitations: ['Catalog totals are not per-prompt costs; only invoked skills enter a turn.',
      'Without an exported complete native Copilot trace, complete Story token/latency savings are unmeasured.'] }, null, 2));
  if (skills.errors.length) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
