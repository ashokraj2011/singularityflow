export function askIntent(query: string, workId?: string | null):
  | { kind: 'spec'; reference: string }
  | { kind: 'work' | 'story-spec'; workId: string | null; workKind: string | null }
  | { kind: 'discovery' | 'commits' | 'comparison' }
  | { kind: 'work-history'; workId: string | null; workKind: string | null }
  | { kind: 'clarification'; message: string }
  | { kind: 'unsupported'; feature: 'task' | 'knowledge-time' | 'change-basis' };

export function askNeedsRepository(intent: ReturnType<typeof askIntent>): boolean;
