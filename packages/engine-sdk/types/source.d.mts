export interface SourceLimits { readonly maximumFiles: number; readonly maximumVisitedEntries: number;
  readonly maximumFileBytes: number; readonly maximumTotalBytes: number; readonly maximumManifestBytes: number; readonly maximumDurationMs: number }
export interface SourceDescriptor { readonly contract: 'sflow-source-unit/v1'; readonly id: string; readonly projectId: string;
  readonly repositoryId: string; readonly provider: string; readonly selection: { readonly excludePaths: readonly string[] }; readonly limits: SourceLimits }
export interface SourceSnapshot { readonly schemaVersion: 1; readonly format: 'sflow-source-snapshot/v1'; readonly unitId: string;
  readonly projectId: string; readonly repositoryId: string; readonly provider: string; readonly selection: { readonly excludePaths: readonly string[] };
  readonly entries: readonly { readonly path: string; readonly sha256: string; readonly bytes: number; readonly executable: boolean }[] }
export interface SourceUnit { readonly descriptor: SourceDescriptor; capture(options?: { readonly signal?: AbortSignal | null }):
  Promise<{ readonly snapshot: SourceSnapshot; readonly revision: string }> }
export declare const SOURCE_UNIT_CONTRACT: 'sflow-source-unit/v1';
export declare const SOURCE_SNAPSHOT_FORMAT: 'sflow-source-snapshot/v1';
export declare const SOURCE_LIMITS: SourceLimits;
export declare function sourceRelativePath(value: unknown): string;
export declare function sourceUnitDescriptor(value: unknown): SourceDescriptor;
export declare function validateSourceUnit(unit: unknown): SourceDescriptor;
export declare function sourceSnapshot(value: unknown, descriptor: SourceDescriptor): SourceSnapshot;
