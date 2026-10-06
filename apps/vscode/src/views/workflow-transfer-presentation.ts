export type WorkflowImportAction = 'keep' | 'replace' | 'rename';
export type WorkflowImportChoice = { action: WorkflowImportAction; to?: string };

/** One subject an import collides on, with what the person can choose for it. */
export type WorkflowImportConflict = {
  subject: string | null;
  kind: string | null;
  id: string;
  reasons: string[];
  choices: WorkflowImportAction[];
  suggested: WorkflowImportAction | null;
  renameTo?: string;
  usedBy: string[];
};

export type WorkflowMutationPreview = {
  identities?: WorkflowTransferIdentity[];
  status?: string;
  planSha256?: string;
  unresolved?: WorkflowImportConflict[];
  resolutions?: Record<string, WorkflowImportChoice>;
  renamed?: Array<{ subject: string; to: string }>;
  replaced?: unknown[];
  kept?: unknown[];
  destinationAuthority?: {
    kind: string;
    branch: string;
    commit: string;
    sourceCommit: string;
    remoteFingerprint: string | null;
  };
  changedPaths?: string[];
  added?: unknown[];
  reused?: unknown[];
  conflicts?: unknown[];
  operations?: { add?: unknown[]; reuse?: unknown[]; replace?: unknown[]; keep?: unknown[]; conflicts?: unknown[] };
  counts?: { add?: number; reuse?: number; replace?: number; keep?: number; conflicts?: number };
  sharedDependencies?: unknown[] | Record<string, unknown>;
  dependencies?: unknown[] | Record<string, unknown>;
  summary?: Record<string, unknown>;
};

export type WorkflowTransferIdentity = {
  subject: string; kind: string; sourceId: string; targetId: string; suggestedId: string;
  renameable: boolean; reason?: string | null; occupiedIds: string[];
  label?: string; description?: string; action?: string;
  skills?: Array<{ id: string; phases?: string[] }>;
  resources?: Array<{ id: string; type: string; url?: string }>;
};

type WorkflowOperationKind = 'add' | 'reuse' | 'replace' | 'keep' | 'conflicts';

const AUTHORITY_DISPOSITION = 'The repository configuration authority decides the result: governed '
  + 'authority creates a review proposal; local authority records a local edit. Applying this plan does '
  + 'not bypass either policy.';

function operations(plan: WorkflowMutationPreview, kind: WorkflowOperationKind): unknown[] {
  if (kind === 'add') return plan.operations?.add ?? plan.added ?? [];
  if (kind === 'reuse') return plan.operations?.reuse ?? plan.reused ?? [];
  if (kind === 'replace') return plan.operations?.replace ?? plan.replaced ?? [];
  if (kind === 'keep') return plan.operations?.keep ?? plan.kept ?? [];
  return plan.operations?.conflicts ?? plan.conflicts ?? [];
}

function renamedText(plan: WorkflowMutationPreview): string[] {
  return (plan.renamed ?? []).map((item) => `${item.subject} → ${item.to}`);
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

function destinationText(plan: WorkflowMutationPreview): string {
  const destination = plan.destinationAuthority;
  if (!destination) return 'local working-tree content; no remote authorization';
  return `${destination.kind}; branch=${destination.branch}; source commit=${destination.sourceCommit}; `
    + `observed commit=${destination.commit}; remote fingerprint=${destination.remoteFingerprint ?? 'local-only'}`;
}

/**
 * Complete, untruncated modal detail for a workflow import/copy decision.
 *
 * The operation count is deliberately not capped: the exact confirmed plan may contain hundreds of
 * dependencies, and hiding the ninth operation would make the plan hash impossible to review.
 */
export function workflowMutationPlanDetail(plan: WorkflowMutationPreview): string {
  const choices = [
    ...(renamedText(plan).length ? [...detailSection('New names', renamedText(plan)), ''] : []),
    ...(operations(plan, 'replace').length ? [...detailSection('Replace yours', operations(plan, 'replace')), ''] : []),
    ...(operations(plan, 'keep').length ? [...detailSection('Keep yours', operations(plan, 'keep')), ''] : [])
  ];
  return [
    ...detailSection('Add', operations(plan, 'add')),
    '',
    ...detailSection('Reuse exact', operations(plan, 'reuse')),
    '',
    ...choices,
    ...detailSection('Conflicts', operations(plan, 'conflicts')),
    '',
    `Shared dependencies: ${dependencyText(plan)}`,
    `Predicted changed paths: ${plan.changedPaths?.length ? plan.changedPaths.join(', ') : 'none'}`,
    `Exact plan: ${plan.planSha256 ?? 'unavailable'}`,
    `Bound destination: ${destinationText(plan)}`,
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
    `- Bound destination: ${markdownEscape(destinationText(plan))}`,
    `- Shared dependencies: ${markdownEscape(dependencyText(plan))}`, '',
    ...markdownSection('Predicted changed paths', plan.changedPaths ?? []),
    AUTHORITY_DISPOSITION, '',
    ...markdownSection('Add', operations(plan, 'add')),
    ...markdownSection('Reuse exact', operations(plan, 'reuse')),
    ...(renamedText(plan).length ? markdownSection('New names', renamedText(plan)) : []),
    ...(operations(plan, 'replace').length ? markdownSection('Replace yours', operations(plan, 'replace')) : []),
    ...(operations(plan, 'keep').length ? markdownSection('Keep yours', operations(plan, 'keep')) : []),
    ...markdownSection('Conflicts', operations(plan, 'conflicts')),
    ...conflictChoicesMarkdown(plan)
  ].join('\n');
}

const NOUNS: Record<string, string> = {
  workflow: 'workflow', phase: 'step', template: 'template', 'artifact-set': 'artifact set',
  'approval-group': 'approval group', 'mcp-server': 'MCP server', 'initiative-workflow': 'Epic workflow',
  'initiative-phase': 'Epic step', 'initiative-approval-group': 'Epic approval group',
  'applicability-policy': 'applicability policy', agent: 'agent', 'template-file': 'template file', skill: 'skill'
};

function noun(conflict: WorkflowImportConflict): string {
  return conflict.kind ? NOUNS[conflict.kind] ?? conflict.kind : 'configuration';
}

function conflictChoicesMarkdown(plan: WorkflowMutationPreview): string[] {
  const open = plan.unresolved ?? [];
  if (!open.length) return [];
  return [
    `## Choices needed (${open.length})`, '',
    ...open.flatMap((conflict) => [
      `### ${markdownEscape(`${noun(conflict)} ${conflict.id}`)}`, '',
      ...conflict.reasons.map((reason) => `- ${markdownEscape(reason)}`),
      ...(conflict.usedBy.length ? [`- Used here by: ${markdownEscape(conflict.usedBy.join(', '))}`] : []),
      ...(conflict.choices.length
        ? workflowImportChoiceItems(conflict).map((item) => `- Choice: **${markdownEscape(item.label)}** — ${markdownEscape(item.detail)}`)
        : ['- No choice resolves this; change another choice or the repository first.']),
      ''
    ])
  ];
}

/** Conflicts a person can choose for, and those that block the import whatever is chosen. */
export function workflowImportOpenChoices(plan: WorkflowMutationPreview): {
  resolvable: WorkflowImportConflict[]; blocking: WorkflowImportConflict[];
} {
  const open = plan.unresolved ?? [];
  return {
    resolvable: open.filter((conflict) => conflict.subject && conflict.choices.length),
    blocking: open.filter((conflict) => !conflict.subject || !conflict.choices.length)
  };
}

/** What one choice does, in the person's terms. */
function choiceText(conflict: WorkflowImportConflict, action: WorkflowImportAction): { label: string; detail: string } {
  if (action === 'rename') {
    return {
      label: `Import theirs as ${conflict.renameTo ?? 'a new name'}`,
      detail: `Yours stays as it is; the imported workflow uses the new name.`
    };
  }
  if (action === 'keep') {
    return {
      label: 'Keep yours',
      detail: ['workflow', 'initiative-workflow'].includes(conflict.kind ?? '')
        ? 'Theirs is not imported.' : `The imported workflow uses your ${noun(conflict)}.`
    };
  }
  return {
    label: 'Replace yours with theirs',
    detail: conflict.usedBy.length ? `This also changes ${conflict.usedBy.join(', ')}.` : 'Nothing else here uses it.'
  };
}

/** Quick-pick items for one conflict, the suggested choice first. */
export function workflowImportChoiceItems(conflict: WorkflowImportConflict): Array<{
  label: string; description?: string; detail: string; choice: WorkflowImportChoice;
}> {
  const ordered = [
    ...(conflict.suggested && conflict.choices.includes(conflict.suggested) ? [conflict.suggested] : []),
    ...conflict.choices.filter((action) => action !== conflict.suggested)
  ];
  return ordered.map((action) => ({
    ...choiceText(conflict, action),
    ...(action === conflict.suggested ? { description: 'suggested' } : {}),
    choice: action === 'rename' && conflict.renameTo ? { action, to: conflict.renameTo } : { action }
  }));
}

export function workflowImportConflictLabel(conflict: WorkflowImportConflict): string {
  return `${noun(conflict)} ${conflict.id}`;
}

export function workflowImportConflictTitle(conflict: WorkflowImportConflict, index: number, total: number): string {
  return `Import conflict ${index + 1} of ${total}: ${workflowImportConflictLabel(conflict)}`;
}

/** Every open conflict resolved by its suggestion. */
export function workflowImportSuggestedChoices(conflicts: readonly WorkflowImportConflict[]): Record<string, WorkflowImportChoice> {
  const result: Record<string, WorkflowImportChoice> = {};
  for (const conflict of conflicts) {
    const item = workflowImportChoiceItems(conflict).find((candidate) => candidate.description === 'suggested');
    if (conflict.subject && item) result[conflict.subject] = item.choice;
  }
  return result;
}

/** One line on what taking every suggestion does. */
export function workflowImportSuggestionSummary(conflicts: readonly WorkflowImportConflict[]): string {
  const choices = Object.values(workflowImportSuggestedChoices(conflicts));
  const count = (action: WorkflowImportAction) => choices.filter((choice) => choice.action === action).length;
  const parts = [
    count('rename') ? `import ${count('rename')} under new names` : '',
    count('keep') ? `keep ${count('keep')} of yours` : '',
    count('replace') ? `replace ${count('replace')} of yours` : ''
  ].filter(Boolean);
  const text = parts.join(', ');
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}; nothing of yours changes unless you replace it.` : 'No suggestion applies.';
}

/** `--resolve` arguments for the CLI, in a stable order. */
export function workflowImportResolveArgs(choices: Readonly<Record<string, WorkflowImportChoice>>): string[] {
  return Object.entries(choices).sort(([left], [right]) => left.localeCompare(right)).flatMap(([subject, choice]) =>
    ['--resolve', `${subject}=${choice.action}${choice.action === 'rename' && choice.to ? `:${choice.to}` : ''}`]);
}

export function workflowMutationConflictCount(plan: WorkflowMutationPreview): number {
  return operations(plan, 'conflicts').length;
}
