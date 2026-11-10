/**
 * What each code step runs for the steps after it, as its Story pinned it [PHR:REQ-007], item 8 (config.mjs
 * withLaterStepTests): the repository tests a later step chose that the code step runs here before its approval,
 * so that step finds nothing new, and the ones bound to a declared environment it cannot run here, which that
 * step runs. Read where people see them: Story start, and the code step's own test runs. Pure.
 */

/** The pinned record for one code step, or null. */
export function laterStepTestsOf(workflow, phaseId) {
  return workflow?.resolution?.phases?.find((entry) => entry.id === phaseId)?.laterStepTests ?? null;
}

const stepList = (steps) => [...new Set(steps)].join(', ');

/** The lines a code step's own test run shows. */
export function laterStepTestLines(workflow, phaseId) {
  const record = laterStepTestsOf(workflow, phaseId);
  if (!record) return [];
  return [
    ...(record.runs ?? []).map((entry) => `Run here so ${stepList(entry.steps)} finds nothing new: ${entry.id} (a repository test ${stepList(entry.steps)} runs).`),
    ...(record.cannotRunHere ?? []).map((entry) => `Cannot run here: ${entry.id} needs ${entry.needs}; ${stepList(entry.steps)} runs it.`)
  ];
}

/** Story start's advisories: each code step's extra tests, named before any code is written. */
export function laterStepTestNotes(workflow) {
  return (workflow?.phaseOrder ?? []).flatMap((id) => {
    const record = laterStepTestsOf(workflow, id);
    if (!record) return [];
    const runs = (record.runs ?? []).map((entry) => entry.id);
    const cannot = record.cannotRunHere ?? [];
    return [{ id: 'later-step-tests', phase: id,
      message: [runs.length ? `${id} also runs ${runs.join(', ')} before its approval, the tests ${stepList((record.runs ?? []).flatMap((entry) => entry.steps))} runs, so those find nothing new.` : null,
        cannot.length ? `${cannot.map((entry) => `${entry.id} needs ${entry.needs}`).join('; ')}, so ${stepList(cannot.flatMap((entry) => entry.steps))} runs ${cannot.length === 1 ? 'it' : 'them'}, not ${id}.` : null]
        .filter(Boolean).join(' ') }];
  });
}
