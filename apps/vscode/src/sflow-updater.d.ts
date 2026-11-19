declare module '*/updater/source.mjs' {
  export interface UpdateSource { mode: 'folder' | 'local-folder'; source?: string; localFolder?: string }
  export interface UpdaterSettings { schemaVersion?: 1; mode?: 'folder' | 'local-folder'; source?: string; localFolder?: string; timeoutSeconds?: number }
  export function updaterHome(environment?: NodeJS.ProcessEnv, homeDirectory?: string): string;
  export function loadConfig(directory: string): Promise<UpdaterSettings>;
  export function privateDirectory(directory: string): Promise<void>;
  export function activeSource(config: UpdaterSettings | null | undefined): UpdateSource | null;
  export function describeSource(source: UpdateSource | null): string;
  export function sourceArgument(value: string, options?: { platform?: NodeJS.Platform; cwd?: string }): UpdateSource;
  export function localFolder(value: string, platform?: NodeJS.Platform): string;
}
declare module '*/updater/cli-detect.mjs' {
  export interface CliInstallPlan {
    route: 'managed' | 'npm-global' | 'unsupported';
    fresh?: boolean; engineHome?: string | null; prefix?: string; packageRoot?: string; cli?: string | null;
    version?: string | null; others?: string[]; reason?: string; code?: string; problem?: string | null;
  }
  export function detectCliInstall(options?: { currentCli?: string | null; environment?: NodeJS.ProcessEnv; homeDirectory?: string }): CliInstallPlan;
  export function describeCliInstall(plan: CliInstallPlan): string;
  export function updateSteps(plan: CliInstallPlan, sourceMode?: 'folder' | 'local-folder'): string[];
}
declare module '*/updater/files.mjs' {
  export const UPDATER_FILES: readonly string[];
}
