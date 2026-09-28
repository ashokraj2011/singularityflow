/**
 * Zero-import XPL2 vocabulary leaf shared by the CLI engine and the VS Code Change Explorer.
 *
 * Keeping it import-free lets the extension render the same relationship meanings and limits
 * without bundling the engine.
 */
export const XPL2_SUBJECTS = Object.freeze(['change', 'clause', 'test', 'line', 'gap', 'generation']);

export const XPL2_AUDIENCES = Object.freeze(['reviewer', 'auditor', 'developer']);

/**
 * Typed relationship vocabulary. Each entry states what the edge means and, just as importantly,
 * what it does not imply; the Change Explorer renders both.
 */
export const XPL2_RELATIONSHIPS = Object.freeze({
  'file-contains-unit': Object.freeze({
    granularity: 'exact-unit', style: 'containment',
    means: 'The unit is an exact entry in the captured diff of this file.',
    notImplied: 'Semantic ownership of a function or module.'
  }),
  'declaration-line-overlap': Object.freeze({
    granularity: 'navigation', style: 'navigation',
    means: 'A cached declaration line falls inside the unit.',
    notImplied: 'Function-body coverage, ownership or behavior.'
  }),
  'region-associated-with-clause': Object.freeze({
    granularity: 'region-only', style: 'region',
    means: 'A recorded cause reference names this clause for the whole change region.',
    notImplied: 'That any individual hunk implements the clause.'
  }),
  'test-source-tags-clause': Object.freeze({
    granularity: 'declared-mapping', style: 'proposed',
    means: 'The test source declares an acceptance tag for the clause.',
    notImplied: 'That the test ran, passed or covers the changed code.'
  }),
  'test-source-in-change': Object.freeze({
    granularity: 'exact-path', style: 'exact',
    means: 'The tagged test source is one of the changed files in this interval.',
    notImplied: 'That the test exercises the other changed files.'
  }),
  'observation-gap': Object.freeze({
    granularity: 'diagnostic', style: 'diagnostic',
    means: 'The owner or this reader reported no admitted record of this kind for the item.',
    notImplied: 'That the item has no reason, no test or no evidence elsewhere; a gap is not a failed test.'
  })
});
