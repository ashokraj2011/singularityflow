/** Types for src/initiative-approvals.mjs, which VS Code's Approvals page reads (apps/vscode/src/views/approvals-model.ts). */
export interface InitiativeApprovalEntry {
  source: 'initiative'; id: string; kind: 'output' | 'pack' | 'phase'; phase: string; subject: string; label: string; detail: string;
  artifactPath?: string | null; sha256: string | null; expected: string; standing: 'yours' | 'others' | 'blocked'; reason: string | null;
  couldNotTell?: boolean; selfApproval: boolean;
  chain: Array<{ authority: string; label: string; minimum: number; signatures: number; satisfied: boolean; open: boolean }>;
  authorities: string[]; rejectTo: string[]; signatures: Array<{ actor: string; at: string | null }>; waitingSince: string | null;
}

export function initiativeStanding(
  groupOf: (id: string) => unknown, person: { email: string | null; login: string | null }, policy: unknown, chain: unknown[]
): { standing: 'yours' | 'others' | 'blocked'; reason: string | null; authorities: string[]; couldNotTell?: boolean };

export function initiativePendingApprovals(initiative: unknown, options?: {
  person?: { email?: string | null; login?: string | null };
  groupOf?: (id: string) => unknown;
}): { initiativeId: string; actor: string | null; pending: InitiativeApprovalEntry[]; obstacles: string[]; empty: string | null };
