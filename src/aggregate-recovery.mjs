const STATE_REVISION = Symbol.for('singularity-flow.state-revision');

/** Capture the caller-visible aggregate separately from its non-enumerable revision receipt. */
export function captureAggregateRecovery(aggregate, value = aggregate) {
  return {
    value: structuredClone(value),
    stateRevision: aggregate?.[STATE_REVISION]
      ? structuredClone(aggregate[STATE_REVISION])
      : null
  };
}

/**
 * Restore a mutable aggregate object in place after its durable transaction was rolled back.
 *
 * Long-lived hosts retain the object identity, so returning a new object would still leave their
 * reference poisoned by the refused transition. This function deliberately touches only caller
 * memory; durable bytes are restored by the transaction before it invokes this helper.
 */
export function restoreAggregateRecovery(aggregate, recovery) {
  if (!aggregate || typeof aggregate !== 'object' || !recovery?.value) return aggregate;
  for (const key of Object.keys(aggregate)) delete aggregate[key];
  Object.assign(aggregate, structuredClone(recovery.value));
  if (recovery.stateRevision) {
    Object.defineProperty(aggregate, STATE_REVISION, {
      value: structuredClone(recovery.stateRevision),
      configurable: true,
      writable: true,
      enumerable: false
    });
  } else {
    delete aggregate[STATE_REVISION];
  }
  return aggregate;
}
