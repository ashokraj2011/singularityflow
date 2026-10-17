export type RepositoryCheckSettings = Readonly<{ mode: 'always' | 'cached' | 'manual'; intervalMinutes: number }>;
export const DEFAULT_REPOSITORY_CHECKS: RepositoryCheckSettings;
export function repositoryCheckPreferencesFile(env?: NodeJS.ProcessEnv): string;
export function normalizeRepositoryCheckSettings(value?: { mode?: string; intervalMinutes?: number | string }): RepositoryCheckSettings;
export function repositoryCheckSettings(root?: string | null, options?: { env?: NodeJS.ProcessEnv }): RepositoryCheckSettings;
export function saveRepositoryCheckSettings(settings: { mode?: string; intervalMinutes?: number } | null,
  options?: { workspacePath?: string | null; file?: string }): Promise<RepositoryCheckSettings | null>;
export function repositoryCheckKey(value: unknown): string;
