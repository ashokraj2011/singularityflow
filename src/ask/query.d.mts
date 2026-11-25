export function askIntent(query: string, workId?: string | null):
  | { kind: 'spec'; reference: string }
  | { kind: 'work' | 'story-spec'; workId: string | null; workKind: string | null }
  | { kind: 'discovery' }
  | { kind: 'unsupported'; feature: 'history' | 'task' };
