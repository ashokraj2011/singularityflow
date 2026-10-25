import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSkillPolicy } from './skill-policy.mjs';
import { PHASE_ENTRY_SKILLS, UTILITY_ENTRY_SKILLS } from '../src/copilot-mode.mjs';
import { compareNativeCopilotTraces, readNativeCopilotTrace, summarizeNativeCopilotTrace } from '../src/native-copilot-efficiency.mjs';
import { retainedPromptInventory } from '../src/retained-prompt-inventory.mjs';
import { readCopilotSessionReport } from '../src/native-copilot-sessions.mjs';
import { copilotFailureReport, copilotFailureSummary } from './native-copilot-failures.mjs';

const USAGE = 'Use [--details] [--trace <EXPORTED-JSON> [--compare <AFTER-JSON>]] [--story-dir <EXACT-STORY-DIRECTORY>], or --sessions <COPILOT-SESSION-STATE-DIR> [--since YYYY-MM-DD] [--details], or --sessions <COPILOT-SESSION-STATE-DIR> --failures [--details] [--out <JSON-FILE>].';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const options = {};
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (['--details', '--failures'].includes(argument) && !options[argument]) { options[argument] = true; continue; }
    if (!['--trace', '--compare', '--story-dir', '--sessions', '--since', '--out'].includes(argument) || !args[index + 1]
        || args[index + 1].startsWith('--') || options[argument]) throw new Error(USAGE);
    options[argument] = args[++index];
  }
  if (options['--compare'] && !options['--trace']) throw new Error('--compare requires --trace <BEFORE-JSON>.');
  if (options['--since'] && !options['--sessions']) throw new Error('--since requires --sessions <COPILOT-SESSION-STATE-DIR>.');
  if ((options['--failures'] || options['--out']) && !options['--sessions']) throw new Error('--failures requires --sessions <COPILOT-SESSION-STATE-DIR>.');
  if (options['--out'] && !options['--failures']) throw new Error('--out writes the --failures report.');
  if (options['--sessions']) {
    // Offline and read-only (SPEC-OUT CON-015): the host's own logs in, a content-free report out, nothing else.
    if (options['--trace'] || options['--story-dir']) throw new Error(USAGE);
    if (options['--failures']) {
      // What stopped or slowed SFlow turns, by skill, step and work type; written to --out, if named,
      // as UTF-8 (a PowerShell redirect would re-encode it), with a short summary printed instead.
      const failures = copilotFailureReport(path.resolve(options['--sessions']), { details: options['--details'] === true });
      if (!options['--out']) console.log(JSON.stringify(failures, null, 2));
      else {
        await writeFile(path.resolve(options['--out']), `${JSON.stringify(failures, null, 1)}\n`);
        console.log([...copilotFailureSummary(failures), '', `Wrote ${path.resolve(options['--out'])}`].join('\n'));
      }
    } else {
      const report = await readCopilotSessionReport(path.resolve(options['--sessions']), { since: options['--since'] ?? null, details: options['--details'] === true });
      console.log(JSON.stringify(report, null, 2));
    }
  } else {
    const skills = await auditSkillPolicy(root);
    const rows = skills.rows.map(row => ({ name: row.name, estimatedBodyTokens: row.bodyTokens,
      entry: Object.hasOwn(UTILITY_ENTRY_SKILLS, row.name) ? 'utility-entry'
        : row.name === 'sflow-session' ? 'session-open' : PHASE_ENTRY_SKILLS.includes(row.name) ? 'operation-entry'
        : row.class === 'delegation' ? 'delegated'
          : row.executionBoundary === 'story' ? 'session-entry' : 'pause-only',
      executionBoundary: row.executionBoundary, maximumTokens: row.maximumTokens }));
    const source = options['--trace'] ? await readNativeCopilotTrace(path.resolve(options['--trace'])) : null;
    const trace = source ? summarizeNativeCopilotTrace(source) : null;
    const comparison = options['--compare'] ? compareNativeCopilotTraces(source,
      await readNativeCopilotTrace(path.resolve(options['--compare']))) : null;
    const prompts = options['--story-dir'] ? await retainedPromptInventory(path.resolve(options['--story-dir'])) : null;
    const entryStrategies = {};
    for (const row of rows) entryStrategies[row.entry] = (entryStrategies[row.entry] ?? 0) + 1;
    console.log(JSON.stringify({ schemaVersion: 1, resultType: 'native-copilot-efficiency-audit',
      skillCount: rows.length, entryStrategies,
      largestSkills: [...rows].sort((left, right) => right.estimatedBodyTokens - left.estimatedBodyTokens).slice(0, 10),
      ...(options['--details'] ? { skills: rows } : {}), errors: skills.errors, trace, prompts,
      ...(comparison ? { comparison } : {}),
      limitations: ['Catalog totals are not per-prompt costs; only invoked skills enter a turn.',
        'Entry strategies describe packaged skill policy, not observed host execution.',
        'Without an exported complete native Copilot trace, complete Story token/latency savings are unmeasured.'] }, null, 2));
    if (skills.errors.length || comparison?.comparable === false) process.exitCode = 1;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
