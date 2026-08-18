/**
 * The capability editor's model: structure, delivery, Jira, teams, and policy as it will apply.
 *
 * Policy folds from the root toward each child and every fold is monotonic — the stricter severity,
 * the larger minimum, the smaller budget, the intersection of allowlists, the union of obligations.
 * A capability can therefore tighten what an ancestor set and can never loosen it.
 *
 * That is invisible in the file. A child declaring `approvalMinimum: 1` beneath a parent demanding
 * two reads as though one approval will do, and it will not. So every policy field is presented as
 * three facts: what this capability declared, what it will actually be held to, and — when those
 * differ — that the declaration is being overridden and by which ancestor. Showing only the file
 * would be showing the intention rather than the rule.
 */
import type { CapabilityNode, CapabilityPolicyValue as PolicyValue } from '../cli/snapshot.ts';

export type { PolicyValue };

/** The two structural capability kinds exposed by every surface. */
export const CAPABILITY_KINDS = ['collection', 'delivery'] as const;

export interface PolicyField {
  key: string;
  label: string;
  /** How this field folds, which is why an override happens; shown so the rule is learnable. */
  rule: string;
  declared: PolicyValue;
  effective: PolicyValue;
  /** True when what was declared is not what will apply. */
  overridden: boolean;
}

export interface CapabilityDetail {
  id: string;
  name: string;
  kind: string;
  /** Ancestors from the root down, which is the chain policy folds along. */
  ancestors: string[];
  /** The direct parent. Children are derived from this relationship by the engine. */
  parent: { id: string; name: string } | null;
  /** Direct children only; descendants remain available through the tree. */
  children: Array<{ id: string; name: string; kind: string; repository: string | null }>;
  delivery: boolean;
  repository: string | null;
  sourceRoots: string[];
  sharedRoots: string[];
  metadata: Record<string, string>;
  jira: { projectKey?: string; board?: string; component?: string } | null;
  teams: string[];
  owns: string[];
  policy: PolicyField[];
  /** Delivery capabilities beneath this one; a leaf ships itself. */
  ships: Array<{ id: string; repository: string }>;
}

/**
 * The policy vocabulary, with how each field folds.
 *
 * Ordered so the fields a reader is most likely to be looking for come first, rather than
 * alphabetically — approval rules before token budgets.
 */
const POLICY_FIELDS: Array<{ key: string; label: string; rule: string }> = [
  { key: 'gateSeverity', label: 'Gate severity', rule: 'the stricter of this and every ancestor' },
  { key: 'approvalMinimum', label: 'Approvals required', rule: 'the largest demanded by any ancestor' },
  { key: 'allowSelfApproval', label: 'Self-approval allowed', rule: 'only if every ancestor allows it' },
  { key: 'requiredAuthorityGroups', label: 'Required authorities', rule: 'the union of every ancestor' },
  { key: 'requiredChecks', label: 'Required checks', rule: 'the union of every ancestor' },
  { key: 'protectedPaths', label: 'Protected paths', rule: 'the union of every ancestor' },
  { key: 'qualityCommands', label: 'Quality commands', rule: 'the union of every ancestor' },
  { key: 'allowedPhases', label: 'Allowed phases', rule: 'the intersection with every ancestor' },
  { key: 'writeScopes', label: 'Write scopes', rule: 'the intersection with every ancestor' },
  { key: 'worldModelGrounding', label: 'World-model grounding', rule: 'the stricter of this and every ancestor' },
  { key: 'worldModelStaleness', label: 'World-model staleness', rule: 'the stricter of this and every ancestor' },
  { key: 'requiredWorldModelViews', label: 'Required views', rule: 'the union of every ancestor' },
  { key: 'jiraProjects', label: 'Jira projects', rule: 'the intersection with every ancestor' },
  { key: 'jiraOperations', label: 'Jira operations', rule: 'the intersection with every ancestor' },
  { key: 'gitPublication', label: 'Git publication', rule: 'the stricter of this and every ancestor' },
  { key: 'contextBoundary', label: 'Context boundary', rule: 'the stricter of this and every ancestor' },
  { key: 'maxDocumentBytes', label: 'Maximum document bytes', rule: 'the smallest set by any ancestor' },
  { key: 'tokenBudget', label: 'Token budget', rule: 'the smallest set by any ancestor' },
  { key: 'contextMaxBytes', label: 'Context maximum bytes', rule: 'the smallest set by any ancestor' }
];

const same = (left: PolicyValue, right: PolicyValue): boolean => {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => item === right[index]);
  }
  return left === right;
};

/** Flatten the tree once, keeping each node's ancestors. */
export function flattenCapabilities(
  tree: CapabilityNode[],
  ancestors: string[] = []
): Array<CapabilityNode & { depth: number; ancestors: string[] }> {
  return tree.flatMap((node) => [
    { ...node, depth: ancestors.length, ancestors },
    ...flattenCapabilities(node.children ?? [], [...ancestors, node.id])
  ]);
}

export function capabilityDetail(tree: CapabilityNode[], capabilityId: string): CapabilityDetail | null {
  const rows = flattenCapabilities(tree);
  const row = rows.find((entry) => entry.id === capabilityId);
  if (!row) return null;

  const declaredPolicy = row.policy ?? {};
  const effectivePolicy = row.effectivePolicy ?? {};

  const policy = POLICY_FIELDS
    .map((field) => {
      const declared = declaredPolicy[field.key] ?? null;
      const effective = effectivePolicy[field.key] ?? null;
      return {
        ...field,
        declared,
        effective,
        // An empty effective list is not an override of an absent declaration; it is the same
        // nothing said twice.
        overridden: declared != null && !same(declared, effective)
      };
    })
    // Only fields that say something. A form listing twenty empty rules teaches nothing.
    .filter((field) => field.declared != null
      || (Array.isArray(field.effective) ? field.effective.length > 0 : field.effective != null));

  const ships = rows
    .filter((entry) => entry.repository
      && (entry.id === capabilityId || entry.ancestors.includes(capabilityId)))
    .map((entry) => ({ id: entry.id, repository: entry.repository as string }));

  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    ancestors: row.ancestors,
    parent: row.ancestors.length
      ? (() => {
        const id = row.ancestors.at(-1) as string;
        const parent = rows.find((entry) => entry.id === id);
        return { id, name: parent?.name ?? id };
      })()
      : null,
    children: (row.children ?? []).map((child) => ({
      id: child.id,
      name: child.name,
      kind: child.kind,
      repository: child.repository ?? null
    })),
    delivery: row.kind === 'delivery',
    repository: row.repository ?? null,
    sourceRoots: row.sourceRoots ?? [],
    sharedRoots: row.sharedRoots ?? [],
    metadata: row.metadata ?? {},
    jira: row.jira ?? null,
    teams: row.teams ?? [],
    owns: row.owns ?? [],
    policy,
    ships
  };
}

/** Which flag carries which field. The panel's field names, the CLI's option names. */
const EDIT_FLAGS: Array<[string, string]> = [
  ['name', '--name'], ['kind', '--kind'], ['parent', '--parent'], ['repository', '--repository'],
  ['sourceRoots', '--source-roots'], ['sharedRoots', '--shared-roots'],
  ['jira.projectKey', '--jira-project'], ['jira.board', '--jira-board'], ['teams', '--teams']
];

/**
 * The CLI call one edit becomes.
 *
 * Empty values are passed rather than dropped. A collection/delivery change and its repository edit
 * therefore reach the engine in one validated operation.
 */
export function capabilityArgv(
  mode: 'add' | 'set' | 'remove',
  capabilityId: string,
  edits: Record<string, string> = {},
  { reparentChildrenTo = undefined }: { reparentChildrenTo?: string | null } = {}
): string[] {
  const argv = ['capability', mode, capabilityId];
  if (mode === 'remove') {
    if (reparentChildrenTo !== undefined) {
      argv.push('--reparent-children-to', reparentChildrenTo ?? '');
    }
    return argv;
  }
  for (const [field, flag] of EDIT_FLAGS) {
    if (edits[field] === undefined) continue;
    argv.push(flag, edits[field].trim());
  }
  if (edits.metadata !== undefined) {
    let pairs: unknown;
    try {
      pairs = JSON.parse(edits.metadata);
    } catch {
      throw new Error('Capability metadata must be a JSON array of key/value pairs.');
    }
    if (!Array.isArray(pairs)) throw new Error('Capability metadata must be a JSON array of key/value pairs.');
    for (const pair of pairs) {
      if (!Array.isArray(pair) || pair.length !== 2
        || typeof pair[0] !== 'string' || typeof pair[1] !== 'string' || !pair[0].trim()) {
        throw new Error('Every capability metadata entry must contain a non-empty key and a text value.');
      }
      argv.push('--metadata', `${pair[0].trim()}=${pair[1].trim()}`);
    }
  }
  return argv;
}

/**
 * The reviewed, remote-authority form of a capability edit.
 *
 * The plain add/set/remove commands deliberately edit the checkout they run in. The VS Code
 * designer represents the organisation map instead, whose authority is the lead repository's
 * sflow/config branch, so it must never use those local commands by accident.
 */
export function capabilityProposalArgv(
  mode: 'add' | 'set' | 'remove',
  capabilityId: string,
  lead: string,
  edits: Record<string, string> = {},
  options: { reparentChildrenTo?: string | null } = {}
): string[] {
  const local = capabilityArgv(mode, capabilityId, edits, options);
  return ['capability', 'edit', capabilityId, '--lead', lead, '--mode', mode, ...local.slice(3), '--json'];
}

/**
 * Where a capability may sit.
 *
 * A capability cannot be moved beneath itself or one of its descendants because that would create a
 * cycle. Every other capability is a valid relationship target. In particular, shipping from a
 * repository does not make a capability a leaf: products commonly own repositories and still group
 * smaller capabilities beneath them.
 */
export function parentChoices(
  tree: CapabilityNode[],
  capabilityId: string | null
): Array<{ id: string; name: string; depth: number }> {
  const rows = flattenCapabilities(tree);
  return rows
    .filter((row) => row.id !== capabilityId)
    .filter((row) => !capabilityId || !row.ancestors.includes(capabilityId))
    .map((row) => ({ id: row.id, name: row.name, depth: row.depth }));
}

/** Rendered for the value columns: an array reads as a list, an absent value as nothing set. */
export function formatPolicyValue(value: PolicyValue): string {
  if (value == null) return '—';
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'none';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}
