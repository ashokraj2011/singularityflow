export function copilotHome(options?: {
  env?: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
}): string;

export const COPILOT_HOME_ENVIRONMENT: readonly ['COPILOT_HOME'];
