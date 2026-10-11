/** Exact preview/confirmation; double clicks share a single bounded cleanup transaction. */
export interface ConfigurationCleanupResult {
  status: string;
  confirmation: string;
  candidates: Array<{ branch: string; commit: string; archiveRef: string }>;
  retained: Array<{ branch: string; commit: string; reason: string }>;
  remaining: number;
  archived?: Array<{ branch: string; commit: string; archiveRef: string }>;
  failure?: { message: string };
}

export class ConfigurationCleanupAction {
  private flight: Promise<ConfigurationCleanupResult | null> | null = null;
  private readonly host: {
    run: (argv: string[]) => Promise<ConfigurationCleanupResult>;
    confirm: (preview: ConfigurationCleanupResult) => Promise<boolean>;
  };
  constructor(host: ConfigurationCleanupAction['host']) { this.host = host; }

  run(): Promise<ConfigurationCleanupResult | null> {
    if (this.flight) return this.flight;
    this.flight = (async () => {
      const preview = await this.host.run(['configuration', 'cleanup-history', '--json']);
      if (preview.status !== 'preview' || !/^sha256:[a-f0-9]{64}$/u.test(preview.confirmation)) {
        throw new Error('No verified cleanup preview was returned; no cleanup was authorized.');
      }
      if (!preview.candidates.length) return preview;
      if (!await this.host.confirm(preview)) return null;
      return this.host.run(['configuration', 'cleanup-history', '--apply', '--confirm', preview.confirmation, '--json']);
    })().finally(() => { this.flight = null; });
    return this.flight;
  }
}
