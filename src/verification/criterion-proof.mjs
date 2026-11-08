/**
 * For each criterion, how many tests prove it and whether each asserts [CQF:REQ-033], from the tests its
 * code step tagged and what publication read of each one's assertions (static syntax, never proof that a
 * branch ran). Read by the review packet, `tests summary` and the review bundle the approval card reads.
 * Pure; it refuses nothing.
 */

/** The witnessed and owed criteria of a code step's delivery, each with its tests; [] for a step without one. */
export function criterionProof(deliveryEvidence) {
  const acceptance = deliveryEvidence?.acceptanceCriteria;
  if (!acceptance) return [];
  const byClause = new Map();
  for (const clauseId of acceptance.required ?? []) byClause.set(clauseId, []);
  for (const witness of acceptance.witnesses ?? []) byClause.set(witness.clauseId, [...(byClause.get(witness.clauseId) ?? []), witness]);
  return [...byClause.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([clauseId, witnesses]) => {
    const tests = witnesses.map((witness) => {
      const assertions = witness.assertions ?? null;
      return { test: [...(witness.identity?.suitePath ?? []), witness.identity?.name ?? witness.testSource].join(' › '), testSource: witness.testSource,
        line: Number.isInteger(witness.line) ? witness.line : null, skipped: witness.skipped === true,
        asserts: assertions ? assertions.adequacy === 'adequate' : null, adequacy: assertions?.adequacy ?? null,
        assertions: assertions ? Math.max(0, (assertions.count ?? 0) - (assertions.tautological ?? 0)) : null };
    });
    const asserting = tests.filter((entry) => entry.asserts === true && !entry.skipped).length;
    const silent = tests.filter((entry) => entry.asserts === false);
    const unread = tests.filter((entry) => entry.asserts === null).length;
    const words = !tests.length ? `${clauseId}: no test proves it`
      : `${clauseId}: ${tests.length === 1 ? '1 test proves it' : `${tests.length} tests prove it`}; ${[
        asserting ? (asserting === tests.length ? (tests.length === 1 ? 'it asserts' : 'each asserts') : `${asserting} assert${asserting === 1 ? 's' : ''}`) : null,
        silent.length ? `${silent.map((entry) => `'${entry.test}'`).join(', ')} assert${silent.length === 1 ? 's' : ''} ${silent.every((entry) => entry.adequacy === 'tautological') ? 'only a literal' : 'nothing'}` : null,
        unread ? `${unread === tests.length ? (tests.length === 1 ? 'its' : 'their') : `${unread}'s`} assertions were not read` : null,
        tests.some((entry) => entry.skipped) ? `${tests.filter((entry) => entry.skipped).length} skipped` : null
      ].filter(Boolean).join('; ')}`;
    return { clauseId, tests: tests.length, asserting, silent: silent.length, unread, words, witnesses: tests };
  });
}
