declare module '*/machine-activity.mjs' {
  export const DEFAULT_IDLE_MINUTES: number;
  export function activityFile(env?: Record<string, string | undefined>, home?: string): string;
  export function idleMinutes(env?: Record<string, string | undefined>): number;
  export function lastActivityAt(file?: string): number | null;
  export function noteActivity(options?: { env?: Record<string, string | undefined>; now?: number; file?: string }): boolean;
  export function noteCommandActivity(env?: Record<string, string | undefined>): boolean;
  export function idleState(options?: {
    env?: Record<string, string | undefined>; now?: number; idleMs?: number; file?: string; osIdleMs?: number | null;
  }): { idle: boolean; remainingMs: number; lastActivityAt: number | null };
}
