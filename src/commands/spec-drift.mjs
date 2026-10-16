/**
 * `singularity-flow spec drift [--work-id ID] [--ref REV] [--all] [--json]`: whether closed Stories'
 * approved clauses still match the code and tests (src/spec-drift.mjs). Read-only and advisory.
 */
import { refHead, repoRoot } from '../git.mjs';
import { because, commandResult, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { evaluateSpecDrift } from '../spec-drift.mjs';
import { loadConfig } from '../state-stores.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

const LABEL = Object.freeze({ 'in-sync': 'in sync', drifted: 'drifted', orphaned: 'orphaned', unverifiable: 'unverifiable' });

/** The plain-text report: every clause that is not in sync, with what changed and by which commits. */
export function renderSpecDrift(report, { all = false } = {}) {
  const lines = [`Spec drift against ${report.target} (advisory; nothing is refused):`];
  if (!report.stories.length) lines.push('  No closed Story with approved code is recorded in this checkout.');
  for (const story of report.stories) {
    const shown = story.clauses.filter((clause) => all || clause.status !== 'in-sync');
    if (!shown.length && !story.findings.length && !all) continue;
    lines.push('', `${story.workId}${story.title ? ` ${story.title}` : ''} (${story.status})`);
    for (const finding of story.findings) lines.push(`  ! ${finding.message}`);
    for (const clause of shown) {
      lines.push(`  ${clause.clauseId.padEnd(18)} ${LABEL[clause.status] ?? clause.status}`);
      for (const finding of clause.findings) {
        const by = finding.commits?.length ? ` (${finding.commits.map((entry) => `${entry.commit} ${entry.subject}`).join('; ')})` : '';
        lines.push(`      - ${finding.message}${by}`);
      }
    }
  }
  const summary = report.summary;
  lines.push('', `${summary.stories} closed Stor${summary.stories === 1 ? 'y' : 'ies'}, ${summary.clauses} clause(s): ${summary['in-sync']} in sync, ${summary.drifted} drifted, ${summary.orphaned} orphaned, ${summary.unverifiable} unverifiable.`);
  if (summary.drifted || summary.orphaned) {
    lines.push('A drifted clause is resolved by a person: adopt it (the specification follows the code, through a new or reopened Story that amends it) or restore it (the code follows the specification, through a fix Story).');
  }
  return lines.join('\n');
}

export async function specDriftCommand(positionals, options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const ref = optionString(options, 'ref') ?? null;
  if (ref && !refHead(root, ref)) throw new SingularityFlowError(`--ref ${ref} names no commit in this clone.`, { code: 'SPEC_DRIFT_REF_UNKNOWN' });
  const workId = optionString(options, 'work-id') ?? positionals[2] ?? null;
  const report = evaluateSpecDrift(root, { workItemRoot: config.workItemRoot ?? 'singularity/work-items', workId, ref });
  if (workId && !report.stories.length) {
    throw new SingularityFlowError(`No Story ${workId} is recorded in this checkout.`, { code: 'SPEC_DRIFT_STORY_UNKNOWN' });
  }
  if (!optionBoolean(options, 'json')) return console.log(renderSpecDrift(report, { all: optionBoolean(options, 'all') }));
  return emitCommandResult(commandResult({
    operation: { id: 'spec.drift', classification: 'read' },
    subject: { kind: workId ? 'story' : 'repository', id: workId ?? 'repository' },
    outcome: succeeded('spec.drift.reported', {
      stories: report.summary.stories, clauses: report.summary.clauses,
      drifted: report.summary.drifted, orphaned: report.summary.orphaned
    }),
    effects: noEffects(),
    why: [because('spec.drift.from-approved-receipts', 'evidence', { ref: report.target })],
    restState: 'informational',
    data: { drift: report }
  }), { json: true, restStateWhenIdle: 'informational' });
}
