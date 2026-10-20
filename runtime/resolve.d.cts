export interface ManagedEngine {
  executable: string; cli: string; root: string; runtimeRoot: string; releaseRoot: string;
  runtime: string; release: string; source: 'managed';
}
declare const resolver: {
  assertLegacyInstallerAllowed(packageRoot: string): void;
  engineHome(options?: { environment?: NodeJS.ProcessEnv; homeDirectory?: string }): string;
  resolveManagedEngine(options?: { environment?: NodeJS.ProcessEnv; homeDirectory?: string; platform?: string; arch?: string }): ManagedEngine | null;
};
export = resolver;
