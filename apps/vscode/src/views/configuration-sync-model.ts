/** A button is the authorization; no model, picker, merge UI or follow-up confirmation. */
export interface ConfigurationSyncResult {
  status: string;
  baseCommit: string;
  targetCommit: string;
  proposals: unknown[];
  backupRefs: unknown[];
  failure?: { message: string };
  viewRefresh?: 'attention';
  referenceSync?: { status: string; results: Array<{ path: string | null; status: string; reason?: string }> };
}

export class ConfigurationSyncAction {
  private flight: Promise<ConfigurationSyncResult> | null = null;
  private readonly host: {
    run: (argv: string[]) => Promise<ConfigurationSyncResult>;
    refresh: () => Promise<void>;
  };
  constructor(host: ConfigurationSyncAction['host']) { this.host = host; }

  run(): Promise<ConfigurationSyncResult> {
    if (this.flight) return this.flight;
    this.flight = (async () => {
      const result = await this.host.run(['configuration', 'recreate-sync', '--apply', '--json']);
      if (['synced', 'current'].includes(result.status)) {
        // The engine confirmed the remote transaction. A later UI failure must not misreport it.
        try { await this.host.refresh(); } catch { return { ...result, viewRefresh: 'attention' as const }; }
      }
      return result;
    })().finally(() => { this.flight = null; });
    return this.flight;
  }
}

/** An interrupted host call cannot establish whether the remote transaction completed. */
export function configurationSyncInterruptedMessage(exactTimeoutCommand: string | null = null): string {
  return 'Configuration sync did not return a confirmed result. Do not assume it completed or that nothing changed. '
    + 'Your application work and pending intent must be preserved. Click Recreate & sync configuration again to '
    + 'reconcile the current remote state and finish; do not activate an older proposal. '
    + 'Terminal: ' + (exactTimeoutCommand ?? 'singularity-flow configuration recreate-sync --apply --json');
}
