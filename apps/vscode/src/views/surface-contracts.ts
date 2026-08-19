/** Pure argv contracts for VS Code surfaces. No VS Code runtime import, so they are directly testable. */
export function goalCreateArgs(input: {
  statement: string; success: string[]; workId: string; kind: 'story' | 'initiative' | 'none'
}): string[] {
  const args = ['goal', 'create', input.statement];
  for (const criterion of input.success) args.push('--success', criterion);
  if (input.kind !== 'none') args.push('--work-id', input.workId, '--kind', input.kind);
  return [...args, '--json'];
}

export function canActivateGoal(goal: { id?: string; status?: string }, activeGoalId: string | null): boolean {
  return goal.status === 'active' && goal.id !== activeGoalId;
}

export function verificationArgv(raw: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0
      || !parsed.every((item) => typeof item === 'string' && item.length > 0 && !/[\r\n\0]/.test(item))) return null;
    // Credentials belong in the verifier's environment/SecretStorage, never a persisted plan argv.
    if (parsed.some((item) => /(?:token|secret|password|passwd|authorization|api[-_]?key)/i.test(item))) return null;
    return parsed;
  } catch { return null; }
}

export function repairPlanArgs(input: {
  faultId: string; paths: string[]; verification: string[][]; maxAttempts: number; persist: boolean
}): string[] {
  const args = ['fix', input.faultId, ...(input.persist ? [] : ['--plan-only']), '--max-attempts', String(input.maxAttempts)];
  for (const allowed of input.paths) args.push('--allow-path', allowed);
  for (const argv of input.verification) args.push('--verify-argv', JSON.stringify(argv));
  return [...args, '--json'];
}

export type ResetMode = 'forget-only' | 'delete-workspaces';
export function resetPreviewArgs(mode: ResetMode): string[] {
  return ['local-reset', ...(mode === 'forget-only' ? ['--forget-only'] : []), '--dry-run', '--json'];
}
export function resetExecuteArgs(mode: ResetMode, confirmation: string): string[] {
  return ['local-reset', ...(mode === 'forget-only' ? ['--forget-only'] : []), '--confirm', confirmation, '--json'];
}

interface ResetFingerprintInput {
  mode?: unknown; confirmation?: unknown; workspaces?: unknown; missingRegistrations?: unknown;
  remove?: unknown; preserve?: unknown; machineTargets?: unknown; installerGeneratedPaths?: unknown;
  capabilityState?: unknown; journalState?: unknown; vscodeReset?: unknown;
}
export function resetPlanFingerprint(plan: ResetFingerprintInput): string {
  return JSON.stringify({
    mode: plan.mode, confirmation: plan.confirmation, workspaces: plan.workspaces,
    missingRegistrations: plan.missingRegistrations, remove: plan.remove, preserve: plan.preserve,
    machineTargets: plan.machineTargets, installerGeneratedPaths: plan.installerGeneratedPaths,
    capabilityState: plan.capabilityState, journalState: plan.journalState, vscodeReset: plan.vscodeReset
  });
}

export function schemaRecordRemedy(storedVersion: unknown, minimum: unknown, maximum: unknown): string {
  const stored = Number(storedVersion); const low = Number(minimum); const high = Number(maximum);
  if (Number.isFinite(stored) && Number.isFinite(high) && stored > high) return SCHEMA_REMEDIES.future;
  if (Number.isFinite(stored) && Number.isFinite(low) && stored < low) return SCHEMA_REMEDIES.older;
  return 'record is outside its registered readable range; inspect the schema census before changing it.';
}

export const SCHEMA_REMEDIES = Object.freeze({
  future: 'written by a newer sflow — upgrade to read it.',
  older: 'use the archival reader for that release, or a governed republication with recorded lineage.',
  unregistered: 'archive the record outside active state until an installed reader registers that family.'
});
