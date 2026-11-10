/** Native value binding and legacy command presentation; statement rules have one pure owner. */
import {scopeStatements} from '../engine-compatibility/node-scope-policy.mjs';
import {DECIDABLE_SCOPE_DISPOSITIONS,CLAUSE_LINKED_DISPOSITIONS} from '../kernel/scope-statements.mjs';
export {DECIDABLE_SCOPE_DISPOSITIONS,CLAUSE_LINKED_DISPOSITIONS} from '../kernel/scope-statements.mjs';
export const normalizeStatement=scopeStatements.normalizeStatement;
export const statementSha256=scopeStatements.statementSha256;
export const scopeItemId=scopeStatements.scopeItemId;
export const clauseScopeItems=scopeStatements.clauseScopeItems;
export const extractNormativeStatements=scopeStatements.extractNormativeStatements;
export const storySourceStatements=scopeStatements.storySourceStatements;

export function scopeDecisionArgv(workId, itemId) {
  const head = ['decision', 'scope', ...(workId ? [workId] : []), '--item', itemId];
  const others = DECIDABLE_SCOPE_DISPOSITIONS.filter((entry) => !CLAUSE_LINKED_DISPOSITIONS.includes(entry));
  return {
    // `--clause` takes several IDs comma-separated. The placeholder is one the route filter accepts:
    // `<CLAUSE-ID,...>` was not, and the include route vanished from every refusal and recovery plan,
    // leaving only exclude or defer (ws-graph, 2026-10-27).
    linked: [...head, '--as', `<${CLAUSE_LINKED_DISPOSITIONS.join('|')}>`, '--clause', '<CLAUSE-ID>', '--reason', '<why>'],
    unlinked: [...head, '--as', `<${others.join('|')}>`, '--reason', '<why>']
  };
}

/** One of those commands as the line a person copies and fills in. */
export function scopeDecisionCommandLine(argv) {
  return ['singularity-flow', ...argv.map((entry) => entry === '<why>' ? '"<why>"' : entry)].join(' ');
}
