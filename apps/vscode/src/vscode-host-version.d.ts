declare module '*/vscode-host-version.mjs' {
  export const VSCODE_PLUGIN_ROOT_VERSION: string;
  export function vscodeVersionLimits(version: unknown): { version: string; limits: string[]; summary: string; fix: string } | null;
  export function vscodeVersionWarning(version: unknown): string | null;
  export function vscodeEditorVersion(options?: {
    env?: Record<string, string | undefined>;
    exists?: (command: string) => boolean;
    execute?: (command: string, args: string[], options: Record<string, unknown>) => { status?: number | null; stdout?: string } | undefined;
  }): string | null;
}
