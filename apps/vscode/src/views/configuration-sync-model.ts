/**
 * Preview first, show the exact proposals apply would replay, then apply only that reviewed packet:
 * the apply carries the preview's digest, so a proposal pushed after the review is refused.
 * No model, merge UI or further questions.
 */
export interface ConfigurationSyncProposal {
  branch: string;
  commit: string;
  merged: boolean;
  author?: string;
  summary?: string;
  files?: string[];
}

export interface ConfigurationSyncResult {
  status: string;
  baseCommit: string;
  targetCommit: string;
  targetBranch?: string;
  proposals: ConfigurationSyncProposal[];
  backupRefs: unknown[];
  files?: string[];
  replacements?: Array<{ branch: string; path: string; pointer: string }>;
  confirmation?: string;
  failure?: { message: string };
  viewRefresh?: 'attention';
  referenceSync?: { status: string; results: Array<{ path: string | null; status: string; reason?: string }> };
}

const PREVIEW = ['configuration', 'recreate-sync', '--json'];
// A person reads each proposal by its branch, author and subject, never a commit (owner, 2026-11-11).
const branchName = (branch: string) => String(branch ?? '').replace(/(?:[-/][0-9a-f]{8,64})+$/iu, '');

export class ConfigurationSyncAction {
  private flight: Promise<ConfigurationSyncResult | null> | null = null;
  private readonly host: {
    run: (argv: string[]) => Promise<ConfigurationSyncResult>;
    refresh: () => Promise<void>;
    /** Shows the exact list; resolves true only on an explicit confirmation of it. */
    confirm: (preview: ConfigurationSyncResult) => Promise<boolean>;
  };
  constructor(host: ConfigurationSyncAction['host']) { this.host = host; }

  run(): Promise<ConfigurationSyncResult | null> {
    if (this.flight) return this.flight;
    this.flight = (async () => {
      const preview = await this.host.run(PREVIEW);
      if (preview.status !== 'preview' || !/^sha256:[a-f0-9]{64}$/u.test(preview.confirmation ?? '')
          || !Array.isArray(preview.proposals)) {
        throw new Error('No verified recreate preview was returned; nothing was applied.');
      }
      // Nothing pending: apply only refreshes references to approved configuration, no replay.
      if (preview.proposals.length && !await this.host.confirm(preview)) return null;
      const result = await this.host.run(['configuration', 'recreate-sync', '--apply', '--confirm', preview.confirmation!, '--json']);
      if (['synced', 'current'].includes(result.status)) {
        // The engine confirmed the remote transaction. A later UI failure must not misreport it.
        try { await this.host.refresh(); } catch { return { ...result, viewRefresh: 'attention' as const }; }
      }
      return result;
    })().finally(() => { this.flight = null; });
    return this.flight;
  }
}

/** The confirmation: a short modal naming the proposals, and the complete reviewed list. */
export function configurationSyncConfirmation(preview: ConfigurationSyncResult): {
  message: string; compactDetail: string; detail: string;
} {
  const pending = preview.proposals.filter(item => !item.merged);
  const merged = preview.proposals.filter(item => item.merged);
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const line = (item: ConfigurationSyncProposal) => branchName(item.branch)
    + `${item.author ? ` by ${item.author}` : ''}${item.summary ? ` — ${item.summary}` : ''}`;
  const target = preview.targetBranch ?? 'sflow/config';
  const effect = `${pending.length ? `Replays ${plural(pending.length, 'pending proposal')} (teammates' unreviewed ones included)` : 'Replays nothing'}`
    + ` onto approved ${target}${merged.length ? `; retires ${plural(merged.length, 'merged proposal')}` : ''}.`;
  const boundary = 'Archived as tags first. Application code and Stories unchanged. Proposals pushed after this preview are refused.';
  const detail = [
    effect,
    ...pending.flatMap(item => [line(item), ...(item.files ?? []).map(file => `    ${file}`)]),
    ...(merged.length ? ['Already merged (archived and retired only):', ...merged.map(line)] : []),
    `Configuration files changed: ${preview.files?.length ? preview.files.join(', ') : 'none'}.`,
    ...(preview.replacements ?? []).map(item => `Replaces current ${item.path}${item.pointer === '/' ? '' : ` ${item.pointer}`} with ${branchName(item.branch)}.`),
    boundary
  ].join('\n');
  return {
    message: `Recreate and sync configuration from ${plural(preview.proposals.length, 'proposal')}?`,
    // The native dialog keeps five lines; View details opens every proposal and file.
    compactDetail: [effect, ...(preview.proposals.length > 3
      ? [...preview.proposals.slice(0, 2).map(line), `…and ${preview.proposals.length - 2} more; View details lists every one.`]
      : preview.proposals.map(line)), boundary].join('\n'),
    detail
  };
}

/** An interrupted host call cannot establish whether the remote transaction completed. */
export function configurationSyncInterruptedMessage(exactTimeoutCommand: string | null = null): string {
  return 'Configuration sync did not return a confirmed result. Do not assume it completed or that nothing changed. '
    + 'Your application work and pending intent must be preserved. Click Recreate & sync configuration again to '
    + 'review the current proposals, reconcile the remote state and finish; do not activate an older proposal. '
    + 'Terminal: ' + (exactTimeoutCommand ?? 'singularity-flow configuration recreate-sync --json, then --apply --confirm with its confirmation');
}
