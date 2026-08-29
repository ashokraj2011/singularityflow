/** Installed sequential-runtime ceilings; Program-declared budgets may only narrow these limits. */
export const SGOS_INSTALLED_LIMITS = Object.freeze({
  maximumProgramBytes: 8 * 1024 * 1024,
  // Every SGOS writer shares this exact durable-file ceiling. Quarantine derives its worst-case
  // tree byte bound from the same value, so a Process admitted and persisted by this build cannot
  // later become unquarantinable merely because one valid record is larger than its reader.
  maximumRecordBytes: 8 * 1024 * 1024,
  // The rooted record index admits the complete immutable payload envelope, not merely individual
  // files. Keeping the installed ceiling practical prevents a valid Process from exhausting the
  // machine or becoming impossible to inspect/quarantine later.
  maximumProcessRecordBytes: 256 * 1024 * 1024,
  maximumProcessRecords: 100_000,
  // One state transition is intentionally much smaller than the complete Process envelope. This
  // keeps exact validation and publication bounded even when the cumulative index is large.
  maximumRecordIndexDeltaEntries: 64,
  maximumPendingWriterFiles: 1_024,
  maximumTasks: 2_000,
  maximumEdges: 10_000,
  maximumResourceDeclarations: 50_000,
  maximumAttemptsPerTask: 10,
  maximumAttemptRecords: 10_000,
  maximumControlRecords: 10_000,
  // Human/operator pause-resume churn is bounded separately so it cannot consume the control
  // capacity reserved at Program admission for task attempts and recovery transitions.
  maximumOperatorControlTransitions: 64,
  maximumExecutionLeases: 16
});
