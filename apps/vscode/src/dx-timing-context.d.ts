declare module '*/dx-timing-context.mjs' {
  export function withPerformanceAction<T>(action: () => T, id?: string): T;
  export function performanceActionId(): string | null;
  export function configurePerformanceActions(enabled: boolean): void;
  export function performanceAction<T>(action: () => T): T;
}
declare module '*/performance-trace-store.mjs' {
  export function writeHostPerformanceTrace(repository: string, event: unknown): Promise<void>;
}
