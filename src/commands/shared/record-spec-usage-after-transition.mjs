/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { redactDiagnosticText } from '../../git-remote-diagnostics.mjs';

/**
 * After an approval has landed, write the Story's specification usage records (SPEC-SPA v1.3 §6.4):
 * its claim once the first step is approved, its delivery once it is closed. Only a Story whose source
 * carries a specification slice loads anything. A failure is a warning naming the repair, never a
 * refusal: the approval already stands.
 */
export async function recordSpecUsageAfterTransition(root, config, workflow, { phase = null, ended = false } = {}) {
  // Only the first step's approval claims and only the closing one delivers; any other approval adds nothing.
  if (phase && phase !== workflow.phaseOrder?.[0] && !ended) return null;
  const workId = workflow.workItem.id;
  const file = path.join(root, config.workItemRoot ?? 'singularity/work-items', workId, 'source.json');
  let source = null;
  try { source = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch { return null; }
  if (!Array.isArray(source?.specification) || !source.specification.length) return null;
  const { publishUsage, repairCommand, usageRecords } = await import('../../spec-library/usage.mjs');
  try {
    const { loadAcceptedStoryExecution } = await import('../../accepted-story-execution.mjs');
    const accepted = await loadAcceptedStoryExecution(root, workId);
    const records = usageRecords(accepted.workflow, source);
    if (!records.length) return null;
    const result = await publishUsage(root, accepted.definition, records);
    if (result.differing.length) console.warn(`Warning: the state branch already holds different usage records at ${result.differing.join(', ')}; they were left as they are.`);
    return result.written.length
      ? `Recorded this Story's use of ${[...new Set(records.map((entry) => `${entry.record.specId}@${entry.record.revision}`))].join(', ')} on the state branch: ${[...new Set(records.filter((entry) => result.written.includes(entry.path)).map((entry) => entry.record.kind))].join(' and ')}.`
      : null;
  } catch (error) {
    console.warn(`Warning: the approval landed, but this Story's specification usage could not be recorded: ${redactDiagnosticText(error?.message ?? String(error))} Run ${source.specification.map((slice) => repairCommand(slice, workId)).join(' and ')}.`);
    return null;
  }
}
