/** The editor's bounded presentation of the CLI-owned performance report. No reads or execution. */
export const PERFORMANCE_CATEGORIES = {
  network: 'Network / remote Git', 'git-local': 'Local Git', copilot: 'Copilot / model (SFlow-owned)',
  file: 'File access', node: 'Node loading / compute', workflow: 'Workflow execution',
  external: 'External processes', waiting: 'Waiting / queueing'
} as const;
export type PerformanceCategory = keyof typeof PERFORMANCE_CATEGORIES;
export const PERFORMANCE_OUTCOMES = ['success', 'error', 'failed', 'blocked', 'timeout', 'cancelled', 'not-found', 'incomplete', 'unknown'] as const;
export const PERFORMANCE_TEMPERATURES = ['cold', 'warm', 'prewarmed', 'unknown'] as const;

type Metric = number | null;
export interface PerformanceCategoryRow {
  category: PerformanceCategory; wallMs: Metric; calls: Metric; inclusiveServiceMs: Metric;
  exclusiveServiceMs: Metric; errors: Metric; timeouts: Metric; cancellations: Metric; cacheHits: Metric; retries: Metric;
}
export interface SlowOperation { name: string; category: PerformanceCategory; outcome: string; durationMs: number }
export interface PerformanceTrace {
  actionId: string; invocationId: string; command: string; operationId: string | null; startedAt: string;
  outcome: string; platform: string; temperature: string; durationMs: number; firstFeedbackMs: Metric;
  overlapMs: Metric; unattributedMs: Metric; categories: PerformanceCategoryRow[];
  counters: Record<string, number>; slowOperations: SlowOperation[] | null;
  coverage: string; droppedSpans: Metric; spanCount: Metric;
  cpu: { userMs: Metric; systemMs: Metric }; memory: { rssEndBytes: Metric };
  host: { queueMs: Metric; launchCallMs: Metric; firstByteMs: Metric; processMs: Metric; parseMs: Metric; postCloseMs: Metric } | null;
}
export interface PerformanceReport { traces: PerformanceTrace[]; warnings: string[] }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const metric = (value: unknown): Metric => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const label = (value: unknown): string | null => typeof value === 'string' && /^[a-z][a-z0-9.-]{0,79}$/u.test(value) ? value : null;
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
const category = (value: unknown): value is PerformanceCategory => typeof value === 'string' && Object.hasOwn(PERFORMANCE_CATEGORIES, value);
const outcome = (value: unknown): string => PERFORMANCE_OUTCOMES.includes(value as typeof PERFORMANCE_OUTCOMES[number]) ? value as string : 'unknown';

export function performanceReportFrom(raw: unknown): PerformanceReport {
  const report = object(raw);
  if (report.resultType !== 'sflow-performance-report' || !Array.isArray(report.traces)) {
    throw new Error('The CLI did not return a performance report. Update the CLI and VS Code to matching builds.');
  }
  const traces: PerformanceTrace[] = [];
  const seen = new Set<string>();
  for (const item of report.traces.slice(0, 64)) {
    const row = object(item), duration = metric(row.durationMs);
    if (!id(row.invocationId) || !id(row.actionId) || !label(row.command) || duration == null
      || typeof row.startedAt !== 'string' || !Number.isFinite(Date.parse(row.startedAt)) || seen.has(row.invocationId)) continue;
    seen.add(row.invocationId);
    const categories: PerformanceCategoryRow[] = [];
    const categoryIds = new Set<string>();
    for (const value of Array.isArray(row.categories) ? row.categories.slice(0, 8) : []) {
      const entry = object(value);
      if (!category(entry.category) || categoryIds.has(entry.category)) continue;
      categoryIds.add(entry.category);
      categories.push({ category: entry.category, wallMs: metric(entry.wallMs), calls: metric(entry.calls),
        inclusiveServiceMs: metric(entry.inclusiveServiceMs), exclusiveServiceMs: metric(entry.exclusiveServiceMs),
        errors: metric(entry.errors), timeouts: metric(entry.timeouts), cancellations: metric(entry.cancellations),
        cacheHits: metric(entry.cacheHits), retries: metric(entry.retries) });
    }
    const slowOperations: SlowOperation[] | null = Array.isArray(row.slowOperations) ? row.slowOperations.slice(0, 10).flatMap(value => {
      const entry = object(value), elapsed = metric(entry.durationMs), name = label(entry.name);
      return name && category(entry.category) && elapsed != null
        ? [{ name, category: entry.category, outcome: outcome(entry.outcome), durationMs: elapsed }] : [];
    }) : null;
    const counters = Object.fromEntries(Object.entries(object(row.counters)).filter(([key, value]) =>
      /^(?:git|cache|discovery|composition|llm|file|configuration|worker|reads)\.[a-z0-9.-]{1,60}$/u.test(key)
        && Number.isSafeInteger(value) && (value as number) >= 0)) as Record<string, number>;
    const host = row.host && typeof row.host === 'object' ? object(row.host) : null;
    traces.push({ actionId: row.actionId, invocationId: row.invocationId, command: label(row.command)!,
      operationId: label(row.operationId), startedAt: new Date(row.startedAt).toISOString(),
      outcome: outcome(row.outcome), platform: ['win32', 'darwin', 'linux'].includes(row.platform as string) ? row.platform as string : 'other',
      temperature: PERFORMANCE_TEMPERATURES.includes(row.temperature as typeof PERFORMANCE_TEMPERATURES[number]) ? row.temperature as string : 'unknown',
      durationMs: duration, firstFeedbackMs: metric(row.firstFeedbackMs), overlapMs: metric(row.overlapMs),
      unattributedMs: metric(row.unattributedMs), categories, counters, slowOperations,
      coverage: object(row.coverage).status === 'partial' ? 'partial'
        : object(row.coverage).status === 'instrumented-boundaries' ? 'instrumented boundaries' : 'Unavailable',
      droppedSpans: metric(row.droppedSpans), spanCount: metric(row.spanCount),
      cpu: { userMs: metric(object(row.cpu).userMs), systemMs: metric(object(row.cpu).systemMs) },
      memory: { rssEndBytes: metric(object(row.memory).rssEndBytes) },
      host: host ? { queueMs: metric(host.queueMs), launchCallMs: metric(host.launchCallMs), firstByteMs: metric(host.firstByteMs),
        processMs: metric(host.processMs), parseMs: metric(host.parseMs), postCloseMs: metric(host.postCloseMs) } : null });
  }
  return { traces, warnings: Array.isArray(report.warnings) ? report.warnings.slice(0, 16)
    .filter((value): value is string => typeof value === 'string').map(value => value.slice(0, 500)) : [] };
}

export interface PerformanceFilters { search: string; command: string; outcome: string; temperature: string; hours: string }
export const emptyPerformanceFilters = (): PerformanceFilters => ({ search: '', command: '', outcome: '', temperature: '', hours: '' });
export function performanceFiltersFrom(raw: unknown): PerformanceFilters | null {
  const filters = object(raw);
  if (Object.keys(emptyPerformanceFilters()).some(key => typeof filters[key] !== 'string' || (filters[key] as string).length > 100)) return null;
  if (filters.outcome && !PERFORMANCE_OUTCOMES.includes(filters.outcome as typeof PERFORMANCE_OUTCOMES[number])) return null;
  if (filters.temperature && !PERFORMANCE_TEMPERATURES.includes(filters.temperature as typeof PERFORMANCE_TEMPERATURES[number])) return null;
  if (!['', '1', '24', '168'].includes(filters.hours as string)) return null;
  if (filters.command && !label(filters.command)) return null;
  return { search: (filters.search as string).trim(), command: filters.command as string, outcome: filters.outcome as string,
    temperature: filters.temperature as string, hours: filters.hours as string };
}
export function filteredPerformanceTraces(report: PerformanceReport | null, filters: PerformanceFilters, now = Date.now()): PerformanceTrace[] {
  const text = filters.search.toLowerCase(), cutoff = filters.hours ? now - Number(filters.hours) * 3600000 : 0;
  return (report?.traces ?? []).filter(trace => (!filters.command || trace.command === filters.command)
    && (!filters.outcome || trace.outcome === filters.outcome) && (!filters.temperature || trace.temperature === filters.temperature)
    && (!cutoff || Date.parse(trace.startedAt) >= cutoff)
    && (!text || [trace.command, trace.actionId, trace.invocationId, trace.operationId].some(value => value?.toLowerCase().includes(text))));
}

export interface PerformanceReportClient {
  readonly repository: string;
  run<T>(args: string[], signal?: AbortSignal): Promise<T>;
}
/** Cancels superseded reads and clears old data before every rebind, including A → B → A. */
export class PerformanceReportReader {
  report: PerformanceReport | null = null;
  error: string | null = null;
  loading = false;
  repository = '';
  private revision = 0;
  private request: AbortController | null = null;
  private disposed = false;
  private client: PerformanceReportClient;
  private changed: () => void;
  constructor(client: PerformanceReportClient, changed: () => void) { this.client = client; this.repository = client.repository; this.changed = changed; }
  rebind(client: PerformanceReportClient): void {
    if (this.disposed) return;
    this.revision++; this.request?.abort(); this.client = client; this.repository = client.repository;
    this.report = null; this.error = null;
    void this.refresh();
  }
  async refresh(): Promise<void> {
    if (this.disposed) return;
    const revision = ++this.revision, repository = this.client.repository;
    if (repository !== this.repository) this.report = null;
    this.request?.abort();
    const request = new AbortController(); this.request = request;
    this.repository = repository; this.loading = true; this.error = null; this.changed();
    const current = () => !this.disposed && this.revision === revision && this.client.repository === repository;
    try {
      const raw = await this.client.run<unknown>(['logs', 'performance', '--limit', '64', '--json'], request.signal);
      if (current()) this.report = performanceReportFrom(raw);
    } catch (error) {
      if (current()) { this.report = null; this.error = (error instanceof Error ? error.message : String(error)).slice(0, 1000); }
    } finally { if (current()) { this.loading = false; this.changed(); } }
  }
  dispose(): void { this.disposed = true; this.revision++; this.request?.abort(); }
}
