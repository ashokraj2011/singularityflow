/** Local, literal catalog search shared by the intake and Studio webviews. */
export const CATALOG_SEARCH_SCRIPT = String.raw`
  function catalogText(value) {
    return String(value == null ? '' : value).normalize('NFC').toLowerCase();
  }
  function catalogMatches(query, values) {
    var text = catalogText(values.join(' '));
    return catalogText(query).trim().split(/\s+/).filter(Boolean).every(function (term) {
      return text.indexOf(term) >= 0;
    });
  }
`;

/** Stored locally in VS Code, never in a workflow definition or Story start request. */
export const WORKFLOW_FAVOURITES_KEY = 'singularityFlow.intake.workflowFavourites.v1';
export const WORKFLOW_FAVOURITES_V2_KEY = 'singularityFlow.intake.workflowFavourites.v2';

interface FavouriteState {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}
export interface WorkflowFavouriteRecord { at: number; ids: string[] }
const favouriteWrites = new WeakMap<FavouriteState, {
  tail: Promise<void>; pending: Map<string, WorkflowFavouriteRecord>;
}>();

/** Personal preferences only. The newest known alias wins, including an explicit empty list. */
export function readWorkflowFavouriteRecord(state: FavouriteState, keys: string[]): WorkflowFavouriteRecord | null {
  let latest: WorkflowFavouriteRecord | null = null;
  for (const key of keys) {
    const value = favouriteWrites.get(state)?.pending.get(key) ?? state.get(key);
    const record = Array.isArray(value) ? { at: 0, ids: value }
      : value as WorkflowFavouriteRecord | null;
    if (record && Number.isSafeInteger(record.at) && record.at >= 0 && Array.isArray(record.ids)
        && (!latest || record.at > latest.at)) latest = { at: record.at, ids: workflowFavourites(record.ids) };
  }
  return latest;
}

/** Serialize across replacement panels and retain pending clicks during an immediate reopen. */
export function writeWorkflowFavouriteRecord(state: FavouriteState, keys: string[], record: WorkflowFavouriteRecord): Promise<void> {
  let writes = favouriteWrites.get(state);
  if (!writes) { writes = { tail: Promise.resolve(), pending: new Map() }; favouriteWrites.set(state, writes); }
  keys = [...new Set(keys)].filter(key => JSON.stringify(writes!.pending.get(key) ?? state.get(key)) !== JSON.stringify(record));
  for (const key of keys) writes.pending.set(key, record);
  const task = writes.tail.catch(() => {}).then(async () => {
    for (const key of keys) await state.update(key, record);
  });
  writes.tail = task;
  return task.finally(() => {
    for (const key of keys) if (writes!.pending.get(key) === record) writes!.pending.delete(key);
  });
}

/** Per repository: whether the Start form lists the demo, benchmark and POC workflows `init` seeds. */
export const SAMPLE_WORKFLOWS_KEY = 'singularityFlow.intake.sampleWorkflows.v1';

/**
 * The workflows `init` seeds into every repository for demos, benchmarks and proofs of concept.
 * Exact packaged IDs, so a team's own workflow is never hidden for the way it is named.
 */
export const SAMPLE_STORY_WORKFLOWS: ReadonlySet<string> = new Set([
  'demo-web-e2e-testing', 'demo-check-repair-close', 'demo-instruction-test-loop',
  'poc-lite', 'poc-workflow', 'benchmarking-a', 'benchmarking-b'
]);

export function workflowFavourites(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((id): id is string =>
    typeof id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && id.length <= 128))].slice(0, 200) : [];
}
