/**
 * SF Guard M3 (SPEC-PSS-v1 AC-010): which of a Story's person records count, synchronously. Loading a
 * Story reads its policy chain once (`loadPresenceContext`) and registers its verdicts here under the
 * Story's pin. Import-free, so a reader on a Story SF Guard does not apply to pays nothing. On a Story it
 * requires whose chain this process did not read, no person record counts.
 */
const REGISTRY = Symbol.for('singularity-flow.presence-person-counts');
const everyEntry = () => true;

/** One Story's pin, as the key of its registered predicate: its Story and the pin itself. */
export function presencePinKey(workflow) {
  return `${workflow?.workItem?.id ?? ''}\0${JSON.stringify(workflow?.resolution?.presence ?? null)}`;
}

/** Record the predicate for a Story's pin: `null` when SF Guard does not apply to it. */
export function registerPersonCounts(key, counts) {
  (globalThis[REGISTRY] ??= new Map()).set(key, counts);
}

export function forgetPersonCounts() {
  globalThis[REGISTRY]?.clear();
}

/**
 * The entries of `records` that count: all of them unless SF Guard requires the Story; then a person's
 * decision (`isPerson`) only when its signature verifies against the approver's pinned key, or a
 * signed per-person exception covers it. Other entries (a request anyone may make) always count.
 */
export function countedRecords(workflow, records, isPerson = everyEntry) {
  const list = records ?? [];
  const pin = workflow?.resolution?.presence;
  if (!pin || !list.length) return list;
  const counts = globalThis[REGISTRY]?.get(presencePinKey(workflow));
  if (counts === null) return list;
  if (counts === undefined) return pin.status === 'off' ? list : list.filter((entry) => !isPerson(entry));
  return list.filter((entry) => !isPerson(entry) || counts(entry));
}
