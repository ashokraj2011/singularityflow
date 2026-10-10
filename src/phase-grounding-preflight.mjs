/**
 * Publication readiness used to verify the registered World Model's grounding receipt here. That
 * model was removed; a phase prompt carries only the Repository brief, which needs no receipt
 * check, so this preflight reports the grounding check as off.
 */
export async function phaseGroundingPreflight() {
  return {
    check: { mode: 'off', errors: [], warnings: [], record: null, path: null },
    blockers: [],
    actions: [],
    projection: { status: 'off', mode: 'off', path: null, staleness: null, warnings: [] }
  };
}
