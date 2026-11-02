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

// Producers that claim a person's or an external tool's work (person-records.mjs AUTHORSHIP_CLAIM_PRODUCERS).
const CLAIMS = new Set(['human', 'external-tool', 'legacy-unspecified']);

/**
 * The producer a generation's authorship record is read as: as recorded, except that on a Story SF
 * Guard requires a person's or an external tool's claim its author did not sign is read as the agent's
 * (`governed-agent`), so it gets every agent check [SPEC-PSS-v1 §10.5].
 */
export function believedProducer(workflow, authorship, where = {}) {
  // No authorship record is no claim either way: the reader keeps its own rule for one.
  if (!authorship || typeof authorship !== 'object') return undefined;
  const producer = authorship.producer ?? 'legacy-unspecified';
  const pin = workflow?.resolution?.presence;
  if (!pin || !CLAIMS.has(producer)) return producer;
  const counts = globalThis[REGISTRY]?.get(presencePinKey(workflow));
  if (counts === null) return producer;
  if (counts === undefined) return pin.status === 'off' ? producer : 'governed-agent';
  return counts.claim?.(authorship, where) ? producer : 'governed-agent';
}

/**
 * The person records of `records` in the order they were decided: on a Story SF Guard requires, by each
 * record's own signed time, so moving an older signed record to the end of the list revives nothing; a
 * newer decision supersedes an older one whatever its `withdrawnAt` says [SPEC-PSS-v1 §10.5]. Elsewhere,
 * the list as it stands.
 */
export function inDecisionOrder(workflow, records) {
  const list = records ?? [];
  if (!required(workflow)) return list;
  return list.map((entry, index) => ({ entry, index, at: Date.parse(entry?.at) }))
    .sort((left, right) => (Number.isFinite(left.at) ? left.at : -Infinity) - (Number.isFinite(right.at) ? right.at : -Infinity) || left.index - right.index)
    .map(({ entry }) => entry);
}

/**
 * Whether `entry` is withdrawn. On a Story SF Guard requires a withdrawal is never read from the
 * unsigned `withdrawnAt` field: a newer signed decision supersedes it (`inDecisionOrder`), so neither
 * adding nor removing the field changes which decision stands.
 */
export function isWithdrawn(workflow, entry) {
  return required(workflow) ? false : Boolean(entry?.withdrawnAt);
}

/** Whether SF Guard requires `workflow`'s person steps, as its pin and the chain this process read say. */
function required(workflow) {
  const pin = workflow?.resolution?.presence;
  if (!pin) return false;
  const counts = globalThis[REGISTRY]?.get(presencePinKey(workflow));
  return counts === undefined ? pin.status !== 'off' : counts !== null;
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

// SF Guard M4: the final check's preview approves the closing step with a decision that exists only
// in memory. It is marked here, never by a field, so a record written to disk can never claim it.
const SYNTHETIC = Symbol.for('singularity-flow.presence-synthetic-approvals');

/** Mark an in-memory decision the final check's preview made (terminal readiness). */
export function markSyntheticApproval(record) {
  (globalThis[SYNTHETIC] ??= new WeakSet()).add(record);
  return record;
}

/** The approvals of `approvals` that count, keeping the preview's in-memory decision (SF Guard M4). */
export function countedApprovals(workflow, approvals) {
  const synthetic = globalThis[SYNTHETIC];
  const list = approvals ?? [];
  const counted = new Set(countedRecords(workflow, list.filter((entry) => !synthetic?.has(entry))));
  return list.filter((entry) => synthetic?.has(entry) || counted.has(entry));
}
