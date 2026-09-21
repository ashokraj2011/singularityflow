export type WorkflowMutationPreview = {
  status?: string;
  planSha256?: string;
  changedPaths?: string[];
  added?: unknown[];
  reused?: unknown[];
  conflicts?: unknown[];
  operations?: { add?: unknown[]; reuse?: unknown[]; conflicts?: unknown[] };
  counts?: { add?: number; reuse?: number; conflicts?: number };
  sharedDependencies?: unknown[] | Record<string, unknown>;
  dependencies?: unknown[] | Record<string, unknown>;
  summary?: Record<string, unknown>;
};

type WorkflowOperationKind = 'add' | 'reuse' | 'conflicts';

const AUTHORITY_DISPOSITION = 'The repository configuration authority decides the result: governed '
  + 'authority creates a review proposal; local authority records a local edit. Applying this plan does '
  + 'not bypass either policy.';

function operations(plan: WorkflowMutationPreview, kind: WorkflowOperationKind): unknown[] {
  if (kind === 'add') return plan.operations?.add ?? plan.added ?? [];
  if (kind === 'reuse') return plan.operations?.reuse ?? plan.reused ?? [];
  return plan.operations?.conflicts ?? plan.conflicts ?? [];
}

function operationIdentity(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return String(value ?? 'none');
  const item = value as Record<string, unknown>;
  const identity = item.id ?? item.path ?? item.name ?? item.key ?? item.kind;
  const kind = item.kind ?? item.type;
  if (identity && kind && identity !== kind) return `${String(kind)}:${String(identity)}`;
  if (identity) return String(identity);
  return JSON.stringify(value);
}

function operationDetails(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const item = value as Record<string, unknown>;
  const details = Object.entries(item)
    .filter(([key]) => !['id', 'path', 'name', 'key', 'kind', 'type'].includes(key))
    .map(([key, entry]) => `${key}=${typeof entry === 'string' ? entry : JSON.stringify(entry)}`);
  return details.length ? ` — ${details.join('; ')}` : '';
}

function detailSection(label: string, items: unknown[]): string[] {
  if (!items.length) return [`${label} (0): none`];
  return [
    `${label} (${items.length}):`,
    ...items.map((item, index) => `  ${index + 1}. ${operationIdentity(item)}${operationDetails(item)}`)
  ];
}

function markdownEscape(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('`', '\\`');
}

function markdownSection(label: string, items: unknown[]): string[] {
  if (!items.length) return [`## ${label} (0)`, '', '_None._', ''];
  return [
    `## ${label} (${items.length})`, '',
    ...items.map((item, index) => `${index + 1}. \`${markdownEscape(operationIdentity(item))}\`${markdownEscape(operationDetails(item))}`),
    ''
  ];
}

function dependencyText(plan: WorkflowMutationPreview): string {
  const dependencies = plan.sharedDependencies ?? plan.dependencies ?? plan.summary?.sharedDependencies;
  if (Array.isArray(dependencies)) {
    return dependencies.length
      ? dependencies.map((value) => `${operationIdentity(value)}${operationDetails(value)}`).join(', ')
      : 'none';
  }
  if (dependencies && typeof dependencies === 'object') {
    const entries = Object.entries(dependencies);
    if (entries.length) {
      return entries.map(([kind, value]) =>
        `${kind}=${Array.isArray(value) ? value.map(operationIdentity).join(', ') : String(value)}`).join('; ');
    }
  }
  const summary = plan.summary ?? {};
  const parts = ['phases', 'agents', 'approvalAuthorities', 'artifacts', 'templates', 'assets']
    .filter((key) => summary[key] !== undefined)
    .map((key) => `${key}=${String(summary[key])}`);
  if (parts.length) return parts.join('; ');
  const reused = operations(plan, 'reuse');
  return reused.length
    ? reused.map((value) => `${operationIdentity(value)}${operationDetails(value)}`).join(', ')
    : 'shared contracts remain linked';
}

/**
 * Complete, untruncated modal detail for a workflow import/copy decision.
 *
 * The operation count is deliberately not capped: the exact confirmed plan may contain hundreds of
 * dependencies, and hiding the ninth operation would make the plan hash impossible to review.
 */
export function workflowMutationPlanDetail(plan: WorkflowMutationPreview): string {
  return [
    ...detailSection('Add', operations(plan, 'add')),
    '',
    ...detailSection('Reuse exact', operations(plan, 'reuse')),
    '',
    ...detailSection('Conflicts', operations(plan, 'conflicts')),
    '',
    `Shared dependencies: ${dependencyText(plan)}`,
    `Predicted changed paths: ${plan.changedPaths?.length ? plan.changedPaths.join(', ') : 'none'}`,
    `Exact plan: ${plan.planSha256 ?? 'unavailable'}`,
    '',
    AUTHORITY_DISPOSITION
  ].join('\n');
}

/** Full scrollable review document shown before the exact modal confirmation. */
export function workflowMutationPlanMarkdown(plan: WorkflowMutationPreview, title: string): string {
  return [
    `# ${title}`, '',
    `- Status: **${markdownEscape(plan.status ?? 'preview')}**`,
    `- Exact plan: \`${markdownEscape(plan.planSha256 ?? 'unavailable')}\``,
    `- Shared dependencies: ${markdownEscape(dependencyText(plan))}`, '',
    ...markdownSection('Predicted changed paths', plan.changedPaths ?? []),
    AUTHORITY_DISPOSITION, '',
    ...markdownSection('Add', operations(plan, 'add')),
    ...markdownSection('Reuse exact', operations(plan, 'reuse')),
    ...markdownSection('Conflicts', operations(plan, 'conflicts'))
  ].join('\n');
}

export function workflowMutationConflictCount(plan: WorkflowMutationPreview): number {
  return operations(plan, 'conflicts').length;
}
