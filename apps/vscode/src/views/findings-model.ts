/**
 * The Findings view's data [CQF:REQ-070]: the CLI's own `findings list --json` answer, and the
 * `findings import` the upload command runs. Nothing here reads the register itself.
 */

export interface FindingRow {
  id: string;
  feed: 'security' | 'tlm';
  state: string;
  stateLabel: string;
  severity: string | null;
  dueAt: string | null;
  label: string;
  story: string | null;
  file?: string | null;
  line?: number | null;
  package?: string | null;
  component?: string;
  currentVersion?: string | null;
  targetVersion?: string;
  endOfLifeAt?: string | null;
  repository: string;
  source: string;
}

export interface FindingsList {
  location: string;
  repository: string | null;
  state: string;
  total: number;
  items: FindingRow[];
  notShown?: number;
  lastImport: { importId: string; at: string; source: string; file: string | null } | null;
}

export interface FindingsImport {
  importId: string;
  file: { name: string };
  source: string;
  feeds: Record<string, { imported: number; added: number; updated: number; rejected: number; otherRepositories: number }>;
  rejected: Array<{ sheet: string; row: number; reason: string }>;
  ignoredSheets: Array<{ sheet: string; reason: string }>;
  store: string | null;
  storeMessage?: string;
  nothingImported?: boolean;
  message?: string;
}

export type FindingsTab = 'security' | 'tlm';

export const findingsListArgv = (all: boolean): string[] => ['findings', 'list', ...(all ? ['--state', 'all'] : []), '--limit', '2000', '--json'];

export const findingsImportArgv = (file: string, feed: FindingsTab | null): string[] =>
  ['findings', 'import', file, ...(feed ? ['--feed', feed] : []), '--json'];

export const findingsTemplateArgv = (file: string): string[] => ['findings', 'template', '--out', file, '--json'];

/** The list as the view reads it; anything that is not the CLI's answer reads as null. */
export function findingsListFrom(value: unknown): FindingsList | null {
  const result = value as Partial<FindingsList> | null;
  if (!result || !Array.isArray(result.items)) return null;
  return {
    location: String(result.location ?? 'none'), repository: result.repository ?? null, state: String(result.state ?? 'active'),
    total: Number(result.total ?? result.items.length), items: result.items.filter((item) => item && typeof item.id === 'string'),
    ...(result.notShown ? { notShown: result.notShown } : {}), lastImport: result.lastImport ?? null
  };
}

/** Whether a due date has passed, by the calendar day of `today` (ISO). */
export const overdue = (dueAt: string | null, today: string): boolean => Boolean(dueAt) && String(dueAt) < today;

/** One plain sentence for the upload's notification: what came in, what was rejected, where it went. */
export function importSummary(result: FindingsImport): string {
  if (result.nothingImported) return result.message ?? 'No sheet was read.';
  const parts = Object.entries(result.feeds).map(([feed, counts]) =>
    `${feed === 'tlm' ? 'TLM' : 'Security'}: ${counts.imported} imported (${counts.added} new, ${counts.updated} updated), ${counts.rejected} rejected`);
  return `${parts.join('; ')}. ${result.storeMessage ?? ''}`.trim();
}
