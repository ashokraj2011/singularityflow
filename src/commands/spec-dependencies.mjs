/**
 * `spec dependencies [STEP] [--work-id ID] [--json]` [SPEC-CIC v1.1 stage 3; CIC:REQ-002, REQ-005]: what each
 * published generation of the Story's steps depended on, by edge kind, and whether its record is complete
 * (`resolved`) or not (`unresolved`, with the reasons), with the scope revision chain's own check. Model-free and
 * read-only; it lives beside `spec trace` and `spec coverage`, the other clause reads. A Story whose pinned spec
 * policy has observed dependencies off has no records: each generation reads `no-record`.
 */
import path from 'node:path';

import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { EDGE_KINDS, stepDependencies } from '../dependency-records.mjs';
import { repoRoot } from '../git.mjs';
import { optionBoolean, optionString, posix, SingularityFlowError } from '../util.mjs';

const CLAUSES_SHOWN = 12;

/** The read, in a person's words: one line per generation, and with a step named, its edges by kind. */
export function dependencyLines(workflow, result, { step = null } = {}) {
  const on = workflow.resolution?.spec?.observedDependencies === 'on';
  const lines = [`${workflow.workItem.id}: observed dependencies are ${on ? 'on' : 'off'} for this Story.`
    + ` Scope revisions: ${result.chain.revisions}, ${result.chain.verified ? 'chain verified' : `chain broken (${result.chain.problems.map((problem) => `revision ${problem.revision}: ${problem.problem}`).join('; ')})`}.`];
  for (const entry of result.steps) {
    if (!entry.generations.length) lines.push(`${entry.phase}: nothing published.`);
    for (const row of entry.generations) {
      const counts = EDGE_KINDS.filter((kind) => row.edges[kind]?.length).map((kind) => `${row.edges[kind].length} ${kind}`);
      lines.push(`${entry.phase} generation ${row.generation}: ${row.coverage.state}${row.coverage.reasons.length ? ` (${row.coverage.reasons.join(', ')})` : ''}`
        + `${counts.length ? `; ${counts.join(', ')}` : ''}.`);
      if (!step) continue;
      for (const kind of EDGE_KINDS.filter((name) => row.edges[name]?.length)) {
        const clauses = [...new Set(row.edges[kind].map((edge) => edge.clause))];
        lines.push(`  ${kind}: ${clauses.slice(0, CLAUSES_SHOWN).join(', ')}${clauses.length > CLAUSES_SHOWN ? ` and ${clauses.length - CLAUSES_SHOWN} more` : ''}`);
      }
      if (row.unclaimedPaths?.length) lines.push(`  changed paths no clause claims: ${row.unclaimedPaths.join(', ')}`);
      if (row.supportingPaths?.length) lines.push(`  supporting changes the plan lists: ${row.supportingPaths.join(', ')}`);
    }
  }
  return lines;
}

export async function specDependenciesCommand(positionals, options) {
  const root = repoRoot();
  const { config, workflow } = await loadAcceptedStoryExecution(root, optionString(options, 'work-id'));
  const step = positionals[2] ?? null;
  if (step && !workflow.phases?.[step]) {
    throw new SingularityFlowError(`Story ${workflow.workItem.id} has no step '${step}'. Its steps: ${(workflow.phaseOrder ?? []).join(', ')}.`, { code: 'SPEC_DEPENDENCIES_STEP_UNKNOWN' });
  }
  const itemRelative = posix(path.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id));
  const result = await stepDependencies(root, workflow, { step });
  const summary = dependencyLines(workflow, result, { step });
  if (optionBoolean(options, 'json')) {
    return console.log(JSON.stringify({ resultType: 'spec-dependencies', workId: workflow.workItem.id, recorded: false, summary,
      observedDependencies: workflow.resolution?.spec?.observedDependencies === 'on', records: posix(path.join(itemRelative, 'context', 'dependencies')),
      ...result }, null, 2));
  }
  for (const line of summary) console.log(line);
}
