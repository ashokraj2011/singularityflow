/**
 * After a new build is installed, offer once per repository to replace the retired legacy-v3 World
 * Model view names (business, architecture, development, ...) its configuration still lists.
 *
 * Phase prompts already ignore those names, so nothing is broken; the repository just gets the
 * registered defaults instead of what it meant to assign. Nothing changes without a click: Preview
 * shows the exact rewrite, Replace runs `wm migrate-views` with the confirmation the preview
 * returned (the CLI restores every file if the result does not load), and the edit, which is in the
 * working tree only, is then reviewed and published like any configuration change.
 *
 * Pure (no editor APIs), so it is tested with a host made of plain functions.
 */
export const VIEW_MIGRATION_KEY = 'singularityFlow.viewMigration.offered';

export interface ViewMigrationChange { location: string; from: string | null; to: string | null }
export interface ViewMigrationPlan {
  status: 'current' | 'planned' | 'migrated';
  changes: number;
  files: Array<{ path: string; changes: ViewMigrationChange[] }>;
  confirmation?: string;
}

type Maybe<T> = Promise<T> | Thenable<T>;

export interface ViewMigrationHost {
  run<T>(args: string[]): Promise<T>;
  log(line: string): void;
  inform(message: string, ...actions: string[]): Maybe<string | undefined>;
  warn(message: string, ...actions: string[]): Maybe<string | undefined>;
  /** Show Markdown read-only, beside the editor. */
  showDocument(markdown: string): Maybe<unknown>;
  /** Open the configuration review and publish flow. */
  publish(): Maybe<unknown>;
  remembered<T>(key: string): T | undefined;
  remember(key: string, value: unknown): Maybe<void>;
}

/** CLI results may arrive bare or in a `{ data }` envelope. */
function unwrap<T>(value: unknown): T | undefined {
  if (value && typeof value === 'object' && 'data' in value && (value as { data?: unknown }).data) return (value as { data: T }).data;
  return value as T | undefined;
}

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The retired view names a plan replaces, in the order they appear (format settings are not views). */
export function retiredViewNames(plan: ViewMigrationPlan): string[] {
  return [...new Set(plan.files.flatMap((file) => file.changes
    .filter((change) => !/^worldModel\.(?:format|v4)\b/u.test(change.location))
    .map((change) => change.from)).filter((name): name is string => Boolean(name)))];
}

/** The rewrite, file by file, as Markdown for a read-only preview. */
export function viewMigrationPreview(plan: ViewMigrationPlan): string {
  return [
    '# Replace retired World Model views',
    '',
    `${plan.changes} reference${plan.changes === 1 ? '' : 's'} in ${plan.files.length} file${plan.files.length === 1 ? '' : 's'} would change in your working tree. Nothing is published until you review and publish the change.`,
    '',
    ...plan.files.flatMap((file) => [
      `## ${file.path}`,
      '',
      '| Where | Now | Becomes |',
      '| --- | --- | --- |',
      ...file.changes.map((change) => `| ${change.location} | ${change.from ? `\`${change.from}\`` : '—'} | ${change.to ? `\`${change.to}\`${change.from ? '' : ' (added)'}` : 'removed (no current view)'} |`),
      ''
    ])
  ].join('\n');
}

/**
 * Offer the migration. Once per build and repository unless `force` (the command palette entry).
 * Returns what happened, for the output log.
 */
export async function offerViewMigration(host: ViewMigrationHost, {
  repository, build, force = false
}: { repository: string | null | undefined; build: string; force?: boolean }): Promise<string> {
  if (!repository) return 'no-repository';
  const offered = host.remembered<Record<string, string>>(VIEW_MIGRATION_KEY) ?? {};
  if (!force && offered[repository] === build) return 'skipped-recent';
  let plan: ViewMigrationPlan | undefined;
  try {
    plan = unwrap<ViewMigrationPlan>(await host.run<unknown>(['wm', 'migrate-views', '--dry-run', '--json']));
  } catch (error) {
    host.log(`World Model view check could not run: ${failureText(error)}`);
    if (force) void host.warn(`Singularity Flow could not check the World Model views: ${failureText(error)}`);
    return 'failed';
  }
  // Asked once per build, whatever the answer: "Not now" is not repeated in every window.
  await host.remember(VIEW_MIGRATION_KEY, { ...offered, [repository]: build });
  if (!plan || plan.status !== 'planned' || !plan.changes || !plan.confirmation) {
    if (force) void host.inform('This repository names no retired World Model views; there is nothing to replace.');
    return 'current';
  }
  const names = retiredViewNames(plan);
  const question = `This repository's configuration still names retired World Model views (${names.join(', ')}), which phase prompts ignore. Replace them with the current views?`;
  let choice = await host.inform(question, 'Replace', 'Preview', 'Not now');
  if (choice === 'Preview') {
    await host.showDocument(viewMigrationPreview(plan));
    choice = await host.inform(`Replace ${plan.changes} retired view reference${plan.changes === 1 ? '' : 's'} as previewed?`, 'Replace', 'Not now');
  }
  if (choice !== 'Replace') return 'declined';
  let applied: ViewMigrationPlan | undefined;
  try {
    applied = unwrap<ViewMigrationPlan>(await host.run<unknown>(['wm', 'migrate-views', '--confirm', plan.confirmation, '--json']));
  } catch (error) {
    void host.warn(`The World Model views were not replaced: ${failureText(error)}`);
    return 'failed';
  }
  if (applied?.status !== 'migrated') {
    void host.warn('The World Model views were not replaced: the configuration changed since the preview. Run the check again.');
    return 'failed';
  }
  host.log(`World Model views replaced in ${applied.files.map((file) => file.path).join(', ')}.`);
  const next = await host.inform(
    `Replaced ${applied.changes} retired view reference${applied.changes === 1 ? '' : 's'} in ${applied.files.length} file${applied.files.length === 1 ? '' : 's'} in your working tree. Review and publish the change so new Stories use it.`,
    'Review & publish'
  );
  if (next === 'Review & publish') await host.publish();
  return 'migrated';
}
