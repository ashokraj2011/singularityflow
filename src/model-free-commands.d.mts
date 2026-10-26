export function parseModelFreeTarget(text?: string): { phase: string | null; workId: string | null };
export function modelFreeCommandForArgv(argv: unknown): string | null;
export function modelFreeCommandForCommand(command: unknown): string | null;
export interface PresentedCommandRoutes {
  copilotCommand?: string | null;
  command?: string | null;
  modelFreeCommand?: string | null;
}
export const COMMAND_PRESENTATION_CONTRACT: string;
export function commandRouteRows(guidance?: PresentedCommandRoutes | null): Array<{
  label: string; command: string | null | undefined; unavailable: string;
}>;
export function commandInlineCode(value: unknown): string;
export function formatCommandRouteLines(guidance: PresentedCommandRoutes | null, options?: {
  indent?: string; markdown?: boolean; modelFreeNote?: string;
}): string[];
export function withCommandPresentationProtocol(text: string): string;
