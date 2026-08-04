/**
 * The business inbox, as data.
 *
 * Approvals answer "what needs a decision". The document catalog answers "what exists". Keeping
 * those as separate screens made reviewers hunt through Lifecycle after every generation, so this
 * model deliberately joins them without creating another source of truth: approvals still come
 * from the gate model and every document path still comes from the engine snapshot.
 */
import { buildApprovals, type Approvals } from './approvals-model.ts';
import type { InitiativeOutput, RepositorySnapshot } from '../cli/snapshot.ts';
import type { TreeNode } from './tree-model.ts';

export interface InboxArtifact {
  id: string;
  label: string;
  phase: string;
  kind: string;
  status: string;
  path: string;
  generation: number | null;
  sha256: string | null;
  generatedBy: string | null;
  readOnly: boolean;
  source: 'initiative' | 'story';
}

export interface Inbox {
  subjectId: string;
  subjectLabel: string;
  approvals: Approvals;
  artifacts: InboxArtifact[];
  groups: Array<{ phase: string; label: string; artifacts: InboxArtifact[] }>;
  empty: string | null;
}

interface StoryDocument {
  id?: string;
  label?: string;
  kind?: string;
  type?: string;
  path?: string;
  phase?: string | null;
  status?: string;
  generation?: number;
  sha256?: string | null;
  generatedBy?: string | null;
}

function initiativeArtifact(output: InitiativeOutput): InboxArtifact | null {
  if (!output.sha256 || !output.repositoryPath) return null;
  return {
    id: `initiative:${output.phase ?? 'unknown'}/${output.id}`,
    label: output.label ?? output.id,
    phase: output.phase ?? 'unknown',
    kind: output.kind,
    status: output.status,
    path: output.repositoryPath,
    generation: output.generation ?? null,
    sha256: output.sha256,
    generatedBy: output.generatedBy ?? output.generatedPersona ?? null,
    readOnly: output.status === 'approved',
    source: 'initiative'
  };
}

function storyArtifact(document: StoryDocument): InboxArtifact | null {
  if (!document.path || !document.sha256) return null;
  const phase = document.phase ?? (document.type === 'system' ? 'work item' : 'sources');
  return {
    id: `story:${document.id ?? document.path}`,
    label: document.label ?? document.id ?? document.path,
    phase,
    kind: document.kind ?? document.type ?? 'document',
    status: document.status ?? (document.type === 'artifact' ? 'generated' : 'available'),
    path: document.path,
    generation: document.generation ?? null,
    sha256: document.sha256,
    generatedBy: document.generatedBy ?? null,
    readOnly: document.status === 'approved',
    source: 'story'
  };
}

export function buildInbox(snapshot: RepositorySnapshot | null): Inbox {
  const approvals = buildApprovals(snapshot);
  if (!snapshot) {
    return {
      subjectId: '', subjectLabel: '', approvals, artifacts: [], groups: [],
      empty: 'Reading the repository…'
    };
  }

  const initiative = snapshot.initiative;
  const initiativeArtifacts = (initiative?.documents ?? [])
    .map(initiativeArtifact)
    .filter((artifact): artifact is InboxArtifact => Boolean(artifact));
  const storyArtifacts = (snapshot.documents ?? [])
    .map((document) => storyArtifact(document as StoryDocument))
    .filter((artifact): artifact is InboxArtifact => Boolean(artifact));

  // A phase artifact can also appear in a Story's general document catalog. Keep the governed path
  // as the identity so the inbox never shows the same bytes twice under two labels.
  const unique = new Map<string, InboxArtifact>();
  for (const artifact of [...initiativeArtifacts, ...storyArtifacts]) unique.set(artifact.path, artifact);
  const artifacts = [...unique.values()].sort((left, right) =>
    left.phase.localeCompare(right.phase) || left.label.localeCompare(right.label));

  const phaseLabels = new Map((initiative?.state.resolution.phases ?? [])
    .map((phase) => [phase.id, phase.label] as const));
  for (const phase of Object.values(snapshot.workflow?.phases ?? {})) {
    phaseLabels.set(phase.id, phase.label);
  }
  const grouped = new Map<string, InboxArtifact[]>();
  for (const artifact of artifacts) {
    const current = grouped.get(artifact.phase) ?? [];
    current.push(artifact);
    grouped.set(artifact.phase, current);
  }
  const order = initiative?.state.phaseOrder ?? snapshot.workflow?.phaseOrder ?? [];
  const groups = [...grouped.entries()]
    .sort(([left], [right]) => {
      const leftOrder = order.indexOf(left); const rightOrder = order.indexOf(right);
      if (leftOrder >= 0 || rightOrder >= 0) return (leftOrder < 0 ? Number.MAX_SAFE_INTEGER : leftOrder)
        - (rightOrder < 0 ? Number.MAX_SAFE_INTEGER : rightOrder);
      return left.localeCompare(right);
    })
    .map(([phase, entries]) => ({ phase, label: phaseLabels.get(phase) ?? phase, artifacts: entries }));

  const subjectId = initiative?.state.initiative.id ?? snapshot.workflow?.workItem.id
    ?? snapshot.selectedWorkId ?? '';
  const subjectLabel = initiative?.state.initiative.title ?? snapshot.workflow?.workItem.title ?? snapshot.workItems
    .find((item) => item.id === snapshot.selectedWorkId)?.title ?? subjectId;
  return {
    subjectId,
    subjectLabel,
    approvals,
    artifacts,
    groups,
    empty: subjectId || artifacts.length || approvals.pending.length
      ? null
      : 'Nothing governed is checked out on this branch.'
  };
}

/** A compact sidebar index. The full card-and-document view opens from its first row. */
export function buildInboxTree(snapshot: RepositorySnapshot | null, error?: Error | null): TreeNode[] {
  if (error) return [{
    kind: 'message', id: 'inbox:error', label: error.message, icon: 'error',
    tooltip: 'The inbox could not read the governed repository.'
  }];
  const inbox = buildInbox(snapshot);
  if (!snapshot) return [{ kind: 'message', id: 'inbox:loading', label: 'Reading the inbox…', icon: 'loading~spin' }];
  if (inbox.empty) return [{
    kind: 'action', id: 'inbox:empty', label: inbox.empty, description: 'start intake first',
    icon: 'inbox', runCommand: 'singularityFlow.startWork'
  }];

  const yours = inbox.approvals.pending.filter((approval) => approval.standing === 'yours').length;
  return [{
    kind: 'action', id: 'inbox:open', label: 'Open business inbox',
    description: `${yours} waiting · ${inbox.artifacts.length} generated`,
    tooltip: 'Review decisions and every generated artifact in one place.',
    icon: yours ? 'bell-dot' : 'inbox', runCommand: 'singularityFlow.openInbox'
  }, {
    kind: 'group', id: 'inbox:generated', label: 'Generated artifacts',
    description: String(inbox.artifacts.length), icon: 'files',
    children: inbox.groups.map((group) => ({
      kind: 'group', id: `inbox:phase:${group.phase}`, label: group.label,
      description: String(group.artifacts.length), icon: 'folder',
      children: group.artifacts.map((artifact) => ({
        kind: 'artifact', id: `inbox:artifact:${artifact.id}`, label: artifact.label,
        description: artifact.status.replace(/_/g, ' '), icon: artifact.readOnly ? 'lock-small' : 'file',
        path: artifact.path, readOnly: artifact.readOnly,
        tooltip: `${artifact.path}\nsha256 ${artifact.sha256 ?? 'unavailable'}`,
        contextValue: artifact.readOnly ? 'sflow.artifact.pinned' : 'sflow.artifact'
      }))
    }))
  }];
}
