/** Lightweight authority-aware configuration save routing shared by host and lazy panels. */
import { createHash } from 'node:crypto';
import type { RepositorySnapshot } from '../cli/snapshot.ts';

/** Already-redacted engine evidence, shared by upload and exact-proposal review surfaces.
 * Older outbox records have only evidence.diagnostic; never require a reimport to read them. */
export interface ConfigurationGitFailure {
  code?: string; classification?: string; diagnostic?: string;
  exitCode?: number | null; signal?: string | null; timedOut?: boolean;
  evidence?: { diagnostic?: string; diagnostics?: string; exitCode?: number | null;
    signal?: string | null; timedOut?: boolean };
}

export function configurationGitFailureText(failure?: ConfigurationGitFailure | null): string {
  if (!failure) return '';
  const evidence = failure.evidence ?? failure;
  const diagnostic = failure.diagnostic ?? failure.evidence?.diagnostics ?? failure.evidence?.diagnostic;
  return [
    failure.classification ? `Git failure: ${failure.classification}` : null,
    evidence.exitCode != null ? `Exit code: ${evidence.exitCode}` : null,
    evidence.signal ? `Signal: ${evidence.signal}` : null,
    evidence.timedOut ? 'Git deadline exceeded.' : null,
    typeof diagnostic === 'string' ? diagnostic.slice(0, 8400) : null
  ].filter(Boolean).join('\n');
}

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

/** A field both a proposal and sflow/config changed differently, with the two values to keep one of [SCF:REQ-007]. */
export interface ConfigurationClash {
  key: string; path: string; pointer: string; kind?: string;
  proposal: { value: unknown } | null; current: { value: unknown } | null;
}

/**
 * Whether the person approving is the proposal's author, and whether the repository lets them approve it
 * [SCF:REQ-011, D4]: `workflow proposal --json` answers for whoever runs it.
 */
export interface ConfigurationSelfApproval { self: boolean; allowed: boolean; profile?: string }

/**
 * Approve one reviewed proposal: the signed person step `configuration approve`, the same on every surface
 * [SCF:REQ-006, REQ-010]. Consent precedes expensive preparation; neither a review nor a failed command grants
 * it, and a self-approval is said in the acknowledgement before it is given.
 */
export async function activateReviewedWorkflowProposal<T>(
  reviewed: { branch: string; proposalCommit: string; merged?: boolean; lands?: { clashes?: ConfigurationClash[] };
    selfApproval?: ConfigurationSelfApproval | null },
  boundary: {
    acknowledge: (selfApproval: ConfigurationSelfApproval | null) => Promise<boolean>; activate: (args: string[]) => Promise<T>;
    /** The reviewer's pick for each clash; null when they stop. A clash with no pick activates nothing. */
    choose?: (clashes: ConfigurationClash[]) => Promise<Record<string, 'proposal' | 'current'> | null>;
  }
): Promise<T | null> {
  const args = ['configuration', 'approve', reviewed.branch, '--confirm', reviewed.proposalCommit];
  const clashes = reviewed.merged ? [] : reviewed.lands?.clashes ?? [];
  if (clashes.length) {
    const picks = boundary.choose ? await boundary.choose(clashes) : null;
    if (!picks || clashes.some((clash) => !picks[clash.key])) return null;
    for (const clash of clashes) args.push('--pick', `${clash.key}=${picks[clash.key]}`);
  }
  if (!reviewed.merged && !await boundary.acknowledge(reviewed.selfApproval ?? null)) return null;
  // One attempt only: a changed ref, lease refusal or server policy needs a fresh review,
  // not an automatic retry. The kernel still re-observes and validates the exact commit.
  return boundary.activate([...args, '--json']);
}

/**
 * What an approval approved, by its proposal's kind, as `configuration approve` says it: a people proposal is not
 * "workflow configuration" [SCF:REQ-012]. The result's `kind`, else the kind its branch names.
 */
export function approvedKindWords(kind: unknown, branch: string): string {
  const named = typeof kind === 'string' ? kind : /^sflow\/config-change\/(workflow|people|package)\//u.exec(branch)?.[1];
  const label = ({ workflow: 'Workflow', people: 'People', package: 'Package', capability: 'Capability', setup: 'Repository setup' } as Record<string, string>)[named ?? ''];
  return label ? `${label} configuration approved` : 'Configuration approved';
}

/** The acknowledgement's words about who approves [SCF:REQ-011]: a self-approval is recorded and shown. */
export function selfApprovalWords(selfApproval: ConfigurationSelfApproval | null): string {
  if (!selfApproval?.self) return 'Your approval is recorded in the approval commit.';
  if (!selfApproval.allowed) return 'You proposed this, and this repository needs another person to approve configuration changes: someone else approves it.';
  return selfApproval.profile === 'poc'
    ? 'You proposed this: a solo repository approves its own changes, recorded as a self-approval.'
    : 'You proposed this, so approving it is recorded as a self-approval.';
}

export type ConfigurationPathTarget =
  | { kind: 'artifact'; path: string }
  | { kind: 'unavailable'; message: string };

/** Open only a path the snapshot lists (templates, prompts and skills). */
export function configurationPathTarget(snapshot: RepositorySnapshot | null, requestedPath: string): ConfigurationPathTarget {
  const listed = new Set([
    ...(snapshot?.templates ?? []).map((entry) => entry.path),
    ...(snapshot?.prompts ?? snapshot?.agentPrompts ?? snapshot?.personaPrompts ?? []).map((entry) => entry.path),
    ...(snapshot?.repositorySkills ?? []).map((entry) => entry.path),
    ...(snapshot?.flowSkills ?? []).map((entry) => entry.packagePath ?? entry.path)
  ]);
  if (listed.has(requestedPath)) return { kind: 'artifact', path: requestedPath };
  return { kind: 'unavailable', message: `This repository no longer lists ${requestedPath}. Refresh and try again.` };
}
