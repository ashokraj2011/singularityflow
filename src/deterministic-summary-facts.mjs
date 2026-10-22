/**
 * The facts an engine-written phase summary reports, read from the Story's records.
 *
 * A deterministic summary is reviewer-facing evidence. It said "No clause claims are currently
 * recorded" for every Story, because it read a `workflow.spec` field nothing writes, while the
 * submission receipt counted every clause claimed; and "No source paths are currently changed" for
 * any step after a commit, because it read only uncommitted changes. Both now come from the records
 * the receipt and the gate read: the Story's active clause, planned and observed claim records, and
 * the application paths changed since the Story's base, committed or not.
 */
import { mergeObservedClaimRecords, mergePlannedClaimRecords } from './specifications.mjs';

const MAX_LISTED = 50;

function listed(values, label) {
  const unique = [...new Set(values ?? [])];
  return unique.length ? `; ${label}: ${unique.map((value) => `\`${value}\``).join(', ')}` : '';
}

/** One line per active clause: what published code was observed to do for it, else what is planned. */
export function specificationClaimLines(records, workflow) {
  if (!records) return ['- The Story\'s specification records could not be read; see singularity-flow spec trace.'];
  const clauses = [...new Map((records.indexes ?? []).flatMap((index) => index.clauses ?? [])
    .map((clause) => [clause.id, clause])).values()];
  if (!clauses.length) return ['- No specification clauses are recorded for this Story.'];
  const planned = mergePlannedClaimRecords(records.planned ?? []);
  const observed = mergeObservedClaimRecords(records.observed ?? [], planned, { workflow });
  const lines = clauses.slice(0, MAX_LISTED).map(({ id }) => {
    if (observed[id]) {
      return `- ${id}: ${observed[id].verdict}${listed(observed[id].observedPaths, 'source')}${listed(observed[id].testResults, 'tests')}`;
    }
    if (planned[id]) {
      return `- ${id}: planned, not yet observed in published code${listed(planned[id].expectedPaths, 'expected')}${listed(planned[id].tests, 'tests')}`;
    }
    return `- ${id}: no claim recorded`;
  });
  const observedCount = clauses.filter(({ id }) => observed[id] && observed[id].verdict !== 'missing').length;
  return [
    `${observedCount} of ${clauses.length} clause(s) claimed by published code; ${clauses.filter(({ id }) => planned[id]).length} planned.`,
    '',
    ...lines,
    ...(clauses.length > MAX_LISTED ? [`- …and ${clauses.length - MAX_LISTED} more: singularity-flow spec trace`] : [])
  ];
}

/**
 * Application paths the Story changed: committed since its base, and still uncommitted. `committed`
 * reads the base..HEAD difference; when the base cannot be read only uncommitted paths are listed,
 * and the summary says so rather than reporting fewer changes as all of them.
 */
export function storyChangedPathLines(workflow, { committed, uncommitted }) {
  const base = workflow.workItem?.baseCommit ?? workflow.workItem?.baseBranch ?? null;
  const paths = [...new Set([...(committed ?? []), ...uncommitted])].sort();
  const since = base ? ` since the Story base \`${String(base).slice(0, 12)}\`` : '';
  return [
    ...(committed ? [] : [`- The Story base could not be read${base ? ` (\`${String(base).slice(0, 12)}\`)` : ''}; only uncommitted paths are listed.`]),
    ...(paths.length ? paths.map((file) => `- \`${file}\``) : [`- No application paths changed${since}.`])
  ];
}
