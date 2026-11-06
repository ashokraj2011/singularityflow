/**
 * What the record says of each clause before the last step says it [bin-opr2].
 *
 * Release is the only step with clause verdicts, so a clause that would end partial was first said there,
 * when its owner had long been approved. The evidence graph knows sooner: the step that gathers test
 * evidence reads it for its outlook, and the conformance refusal reads it to tell a real gap from a
 * report that says less than the record does. Reads only, informs only, and any doubt says nothing.
 */
const OPEN_RESULTS = new Set(['failed', 'inconclusive', 'missing', 'pending']);

async function evaluatedRows(root, definition, workflow) {
  const { terminalReadinessOnce } = await import('./terminal.mjs');
  return (await terminalReadinessOnce(root, definition, workflow, { stage: 'submission' })).evaluation?.rows ?? [];
}

/** The clauses the record reads satisfied now. Empty on any doubt, so nothing here can clear a gap's route. */
export async function clausesReadSatisfied(root, definition, workflow) {
  try { return (await evaluatedRows(root, definition, workflow)).filter((row) => row.result === 'satisfied').map((row) => row.id); }
  catch { return []; }
}

/**
 * At the step that gathers test evidence, before the Story's end: each clause that would not read as
 * matched, with what the record says and who decides. Empty at any other step, and on any doubt.
 */
export async function clauseOutlookForStep(root, definition, workflow, phase) {
  try {
    const [{ isTestEvidencePhase }, { endsStory }] = await Promise.all([import('../phase-roles.mjs'), import('../upstream-entry-summary.mjs')]);
    if (!isTestEvidencePhase(phase) || endsStory(workflow, phase)) return [];
    const open = (await evaluatedRows(root, definition, workflow)).filter((row) => OPEN_RESULTS.has(row.result));
    if (!open.length) return [];
    const { terminalEvidenceDecisions } = await import('./terminal.mjs');
    const { evaluation } = await (await import('./terminal.mjs')).terminalReadinessOnce(root, definition, workflow, { stage: 'submission' });
    const decisions = terminalEvidenceDecisions(workflow.workItem.id, evaluation, workflow);
    const workId = workflow.workItem.id;
    return open.map((row) => {
      const decision = decisions.find((entry) => entry.criterion === row.id);
      const groups = [...new Set([...(decision?.witnesses ?? []), ...(decision?.risks ?? [])].flatMap((entry) => entry.groups ?? []))];
      const owners = [...new Set((row.obligations ?? []).filter((entry) => entry.status !== 'met').flatMap((entry) => entry.owningSteps ?? []))];
      const who = groups.length ? `the ${groups.join(' or ')} group decides` : owners.length ? `${owners.join(' and ')}'s approvers decide` : 'a person decides';
      return { clauseId: row.id, result: row.result, ...(groups.length ? { groups } : {}), ...(owners.length ? { owners } : {}),
        command: decision?.witnesses?.[0]?.command ?? decision?.risks?.[0]?.command ?? `singularity-flow decisions ${workId}`,
        words: `${row.id} reads ${row.result} in the record, so the last step would mark it partial or missing unless this changes. ${who[0].toUpperCase()}${who.slice(1)}; say so in your report now.` };
    });
  } catch { return []; }
}
