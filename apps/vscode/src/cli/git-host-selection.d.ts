declare module '*/git-host-selection.mjs' {
  export function gitHostSearchDirectories(environment: NodeJS.ProcessEnv, platform?: string): string[];
  export function isAppleDeveloperGit(executable: string): boolean;
  export function gitHostChildEnvironment(environment: NodeJS.ProcessEnv, executable: string, platform?: string): NodeJS.ProcessEnv;
}
