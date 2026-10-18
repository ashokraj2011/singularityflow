declare module '*/copilot-story-follow.mjs' {
  export interface CopilotStoryFollow {
    schemaVersion: 1;
    kind: 'copilot-story-follow';
    eventId: string;
    originPath: string;
    repositoryPath: string;
    workId: string;
    observedAt: number;
  }
  export function copilotStoryFollowDirectory(env?: NodeJS.ProcessEnv, home?: string): string;
  export function readCopilotStoryFollow(origin: string): Promise<CopilotStoryFollow | null>;
  export function verifiedCopilotStoryFollow(notice: CopilotStoryFollow, context: unknown): boolean;
  export function createCopilotStoryFollower<T>(ports: {
    read(): Promise<CopilotStoryFollow | null>;
    verify(notice: CopilotStoryFollow): Promise<T | null>;
    apply(value: T, isCurrent: () => Promise<boolean>): Promise<void>;
    isActive(): boolean;
    onError(error: Error): void;
  }): { reconcile(): Promise<void>; dispose(): void };
}
