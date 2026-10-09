/** A button is the authorization; no model, picker, merge UI or follow-up confirmation. */
export interface ConfigurationSyncResult {
  status: string;
  baseCommit: string;
  targetCommit: string;
  proposals: unknown[];
  backupRefs: unknown[];
  failure?: { message: string };
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
      if (['synced', 'current'].includes(result.status)) await this.host.refresh();
      return result;
    })().finally(() => { this.flight = null; });
    return this.flight;
  }
}
