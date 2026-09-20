/** Lightweight authority-aware configuration save routing shared by host and lazy panels. */
import { createHash } from 'node:crypto';
import type { RepositorySnapshot } from '../cli/snapshot.ts';

export interface ConfigurationSavePlan {
  /** False when the displayed bytes came only from a recovery mirror with no writable authority. */
  writable: boolean;
  blockedReason?: string;
  /** External approved authority is edited through a review proposal; local/FOS stays direct. */
  proposal: boolean;
  /** Revision of the file in the destination that will actually be written. */
  expectedSha256: string;
  /** Authority identity CAS. These are present only for an externally governed proposal. */
  expectedAuthorityKind?: string;
  expectedAuthorityCommit?: string;
  expectedAuthorityRemoteFingerprint?: string;
  expectedAuthoritySourceCommit?: string;
}

/**
 * Bind a visual save to the same byte domain it will mutate.
 *
 * An externally governed checkout renders the approved `sflow/config` overlay. Its physical
 * application-branch file is deliberately allowed to differ, so direct-save CAS is categorically
 * wrong there. Proposal authoring clones the approved authority and therefore uses that authority's
 * per-file digest. A genuinely local authority still writes the working tree and hashes the exact
 * rendered bytes, retaining the existing concurrent-edit protection.
 */
export function configurationSavePlan(
  source: RepositorySnapshot['configurationSource'] | null | undefined,
  path: string,
  renderedText: string
): ConfigurationSavePlan {
  const proposal = Boolean(source?.effective?.kind && source.effective.kind !== 'working-tree');
  const renderedSha256 = createHash('sha256').update(renderedText).digest('hex');
  if (source?.effective?.kind === 'verified-state-mirror') {
    return {
      writable: false,
      proposal: false,
      expectedSha256: renderedSha256,
      blockedReason: 'This configuration is readable only from the verified state recovery mirror. Restore or reinitialize sflow/config before editing.'
    };
  }
  if (!proposal) return { writable: true, proposal: false, expectedSha256: renderedSha256 };
  const approvedSha256 = source?.effective?.files?.[path]
    ?? (path === 'singularity/workflow.yml' ? source?.effective?.sha256 : null);
  // Old snapshots lack the per-file map. workflow.yml has always carried `effective.sha256`; for
  // any other path fail closed to its rendered approved bytes until the refreshed snapshot arrives.
  return {
    writable: true,
    proposal: true,
    expectedSha256: approvedSha256 ?? renderedSha256,
    ...(source?.effective?.kind ? { expectedAuthorityKind: source.effective.kind } : {}),
    ...(source?.effective?.commit ? { expectedAuthorityCommit: source.effective.commit } : {}),
    ...(source?.effective?.remoteFingerprint
      ? { expectedAuthorityRemoteFingerprint: source.effective.remoteFingerprint } : {}),
    ...(source?.effective?.sourceCommit
      ? { expectedAuthoritySourceCommit: source.effective.sourceCommit } : {})
  };
}

/** Structured argv suffix for the exact destination and authority revision selected above. */
export function configurationSavePlanCliArgs(plan: ConfigurationSavePlan): string[] {
  if (!plan.writable) throw new Error(plan.blockedReason ?? 'The approved configuration authority is read-only.');
  return [
    '--expected-sha256', plan.expectedSha256,
    ...(plan.expectedAuthorityKind ? ['--expected-authority-kind', plan.expectedAuthorityKind] : []),
    ...(plan.expectedAuthorityCommit ? ['--expected-authority-commit', plan.expectedAuthorityCommit] : []),
    ...(plan.expectedAuthorityRemoteFingerprint
      ? ['--expected-authority-remote-fingerprint', plan.expectedAuthorityRemoteFingerprint] : []),
    ...(plan.expectedAuthoritySourceCommit
      ? ['--expected-authority-source-commit', plan.expectedAuthoritySourceCommit] : []),
    ...(plan.proposal ? ['--propose', '--json'] : [])
  ];
}

export type ConfigurationSaveDisposition =
  | { kind: 'proposal'; branch: string; baseBranch: string; proposalCommit: string; files: string[] }
  | { kind: 'local' }
  | { kind: 'unchanged' };

/** Interpret the CLI result rather than guessing the effect from the requested route. */
export function configurationSaveDisposition(output: string, plannedProposal: boolean): ConfigurationSaveDisposition {
  if (!plannedProposal) return { kind: 'local' };
  const result = JSON.parse(output) as {
    reviewRequired?: boolean; branch?: string | null; baseBranch?: string; authorityMode?: string;
    commit?: string; files?: string[];
  };
  if (result.reviewRequired === true) {
    if (!result.branch || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(result.commit ?? '')) {
      throw new Error('Configuration proposal response did not identify its exact branch and commit.');
    }
    return {
      kind: 'proposal', branch: result.branch, baseBranch: result.baseBranch ?? 'sflow/config',
      proposalCommit: result.commit!,
      files: Array.isArray(result.files) ? result.files.filter((entry): entry is string => typeof entry === 'string') : []
    };
  }
  if (result.authorityMode === 'local') return { kind: 'local' };
  return { kind: 'unchanged' };
}
