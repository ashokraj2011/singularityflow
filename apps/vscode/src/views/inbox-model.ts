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
  /** The governed Work/Initiative ID that owns this artifact. */
  workId: string;
  /** Human-readable title for the owning Work/Initiative. */
  workLabel: string;
}

export interface InboxWorkItem {
  workId: string;
  label: string;
  source: 'initiative' | 'story';
  artifacts: InboxArtifact[];
  groups: Array<{ phase: string; label: string; artifacts: InboxArtifact[] }>;
}

export interface Inbox {
  subjectId: string;
  subjectLabel: string;
  approvals: Approvals;
  artifacts: InboxArtifact[];
  /** Generated artifacts grouped by their owning Work ID, then by lifecycle phase. */
  workItems: InboxWorkItem[];
  /** Flattened phase groups retained for callers that only render the active subject. */
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

function initiativeArtifact(output: InitiativeOutput, workId: string, workLabel: string): InboxArtifact | null {
  if (!output.sha256 || !output.repositoryPath) return null;
  return {
    id: `initiative:${workId}:${output.phase ?? 'unknown'}/${output.id}`,
    label: output.label ?? output.id,
    phase: output.phase ?? 'unknown',
    kind: output.kind,
    status: output.status,
    path: output.repositoryPath,
    generation: output.generation ?? null,
    sha256: output.sha256,
    generatedBy: output.generatedBy ?? output.generatedPersona ?? null,
    readOnly: output.status === 'approved',
    source: 'initiative',
    workId,
    workLabel
  };
}

function storyArtifact(document: StoryDocument, workId: string, workLabel: string): InboxArtifact | null {
  if (!document.path || !document.sha256) return null;
  const phase = document.phase ?? (document.type === 'system' ? 'work item' : 'sources');
  return {
    id: `story:${workId}:${document.id ?? document.path}`,
    label: document.label ?? document.id ?? document.path,
    phase,
    kind: document.kind ?? document.type ?? 'document',
    status: document.status ?? (document.type === 'artifact' ? 'generated' : 'available'),
    path: document.path,
    generation: document.generation ?? null,
    sha256: document.sha256,
    generatedBy: document.generatedBy ?? null,
    readOnly: document.status === 'approved',
    source: 'story',
    workId,
    workLabel
  };
}

function storyDocumentWorkId(document: StoryDocument, fallback: string): string {
  const match = document.path?.match(/(?:^|\/)singularity\/work-items\/([^/]+)\//);
  return match?.[1] ?? fallback;
}

function phaseGroups(
  artifacts: InboxArtifact[],
  labels: Map<string, string>,
  order: string[]
): InboxWorkItem['groups'] {
  const grouped = new Map<string, InboxArtifact[]>();
  for (const artifact of artifacts) {
    grouped.set(artifact.phase, [...(grouped.get(artifact.phase) ?? []), artifact]);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => {
      const leftOrder = order.indexOf(left); const rightOrder = order.indexOf(right);
      if (leftOrder >= 0 || rightOrder >= 0) return (leftOrder < 0 ? Number.MAX_SAFE_INTEGER : leftOrder)
        - (rightOrder < 0 ? Number.MAX_SAFE_INTEGER : rightOrder);
      return left.localeCompare(right);
    })
    .map(([phase, entries]) => ({
      phase,
      label: labels.get(phase) ?? phase,
      artifacts: entries.sort((left, right) => left.label.localeCompare(right.label))
    }));
}

export function buildInbox(snapshot: RepositorySnapshot | null): Inbox {
  const approvals = buildApprovals(snapshot);
  if (!snapshot) {
    return {
      subjectId: '', subjectLabel: '', approvals, artifacts: [], workItems: [], groups: [],
      empty: 'Reading the repository…'
    };
  }

  const initiative = snapshot.initiative;
  const initiativeId = initiative?.state.initiative.id ?? '';
  const initiativeLabel = initiative?.state.initiative.title ?? initiativeId;
  const storyId = snapshot.workflow?.workItem.id ?? snapshot.selectedWorkId ?? '';
  const storyLabel = snapshot.workflow?.workItem.title ?? snapshot.workItems
    .find((item) => item.id === storyId)?.title ?? storyId;
  const initiativeArtifacts = (initiative?.documents ?? [])
    .map((output) => initiativeArtifact(output, initiativeId, initiativeLabel))
    .filter((artifact): artifact is InboxArtifact => Boolean(artifact));
  const storyArtifacts = (snapshot.documents ?? [])
    .map((entry) => {
      const document = entry as StoryDocument;
      const workId = storyDocumentWorkId(document, storyId);
      const workLabel = workId === storyId
        ? storyLabel
        : snapshot.workItems.find((item) => item.id === workId)?.title ?? workId;
      return storyArtifact(document, workId, workLabel);
    })
    .filter((artifact): artifact is InboxArtifact => Boolean(artifact));

  // A phase artifact can also appear in a Story's general document catalog. Keep the governed path
  // as the identity so the inbox never shows the same bytes twice under two labels.
  const unique = new Map<string, InboxArtifact>();
  for (const artifact of [...initiativeArtifacts, ...storyArtifacts]) {
    unique.set(`${artifact.workId}:${artifact.path}`, artifact);
  }
  const artifacts = [...unique.values()].sort((left, right) =>
    left.workId.localeCompare(right.workId)
      || left.phase.localeCompare(right.phase)
      || left.label.localeCompare(right.label));

  const initiativePhaseLabels = new Map((initiative?.state.resolution.phases ?? [])
    .map((phase) => [phase.id, phase.label] as const));
  const storyPhaseLabels = new Map<string, string>();
  for (const phase of Object.values(snapshot.workflow?.phases ?? {})) {
    storyPhaseLabels.set(phase.id, phase.label);
  }
  const byWorkId = new Map<string, InboxArtifact[]>();
  for (const artifact of artifacts) {
    byWorkId.set(artifact.workId, [...(byWorkId.get(artifact.workId) ?? []), artifact]);
  }

  const subjectId = initiativeId || storyId;
  const subjectLabel = initiativeId ? initiativeLabel : storyLabel;
  const workItems = [...byWorkId.entries()].map(([workId, entries]): InboxWorkItem => {
    const source = entries[0]?.source ?? 'story';
    return {
      workId,
      label: entries[0]?.workLabel ?? workId,
      source,
      artifacts: entries,
      groups: phaseGroups(
        entries,
        source === 'initiative' ? initiativePhaseLabels : storyPhaseLabels,
        source === 'initiative' ? (initiative?.state.phaseOrder ?? []) : (snapshot.workflow?.phaseOrder ?? [])
      )
    };
  }).sort((left, right) => {
    if (left.workId === subjectId) return -1;
    if (right.workId === subjectId) return 1;
    return left.workId.localeCompare(right.workId);
  });
  // Compatibility for consumers that still expect one flat phase list. New renderers use
  // workItems, which prevents identical phase names from different Stories being conflated.
  const groups = workItems.flatMap((item) => item.groups);
  return {
    subjectId,
    subjectLabel,
    approvals,
    artifacts,
    workItems,
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
  const activeStories = (snapshot.workItems ?? [])
    .filter((item) => !['complete', 'completed', 'cancelled', 'invalid'].includes(String(item.status)))
    .sort((left, right) => left.id.localeCompare(right.id));
  return [{
    kind: 'action', id: 'inbox:open', label: 'Open business inbox',
    description: `${yours} waiting · ${inbox.artifacts.length} generated`,
    tooltip: 'Review decisions and every generated artifact in one place.',
    icon: yours ? 'bell-dot' : 'inbox', runCommand: 'singularityFlow.openInbox'
  }, ...(activeStories.length ? [{
    kind: 'group' as const, id: 'inbox:active-stories', label: 'Active Stories',
    description: String(activeStories.length), icon: 'list-tree',
    tooltip: 'Select a Story to open its isolated checkout and load its generated artifacts.',
    children: activeStories.map((item) => ({
      kind: 'story' as const, id: `inbox:active-story:${item.id}`, label: item.id,
      description: item.id === snapshot.selectedWorkId
        ? `${item.currentPhase ?? item.status ?? 'active'} · current`
        : String(item.currentPhase ?? item.status ?? 'active').replaceAll('_', ' '),
      tooltip: `${item.title ?? item.id}\nSelect to synchronize and open this Story checkout.`,
      icon: item.id === snapshot.selectedWorkId ? 'check' : 'statusCurrent',
      command: ['session', 'attach', item.id], runCommand: 'singularityFlow.runAction',
      contextValue: 'sflow.story.active.summary'
    }))
  }] : []), {
    kind: 'group', id: 'inbox:generated', label: 'Generated artifacts',
    description: String(inbox.artifacts.length), icon: 'files',
    children: inbox.workItems.map((work) => ({
      kind: 'group', id: `inbox:work:${work.workId}`, label: work.workId,
      description: `${work.artifacts.length} generated`, icon: 'directory',
      tooltip: work.label && work.label !== work.workId ? work.label : `Generated artifacts for ${work.workId}`,
      children: work.groups.map((group) => ({
        kind: 'group', id: `inbox:work:${work.workId}:phase:${group.phase}`, label: group.label,
        description: String(group.artifacts.length), icon: 'directory',
        children: group.artifacts.map((artifact) => ({
          kind: 'artifact', id: `inbox:artifact:${artifact.id}`, label: artifact.label,
          description: artifact.status.replace(/_/g, ' '), icon: artifact.readOnly ? 'lock-small' : 'file',
          path: artifact.path, readOnly: artifact.readOnly,
          tooltip: `${artifact.path}\nsha256 ${artifact.sha256 ?? 'unavailable'}`,
          contextValue: artifact.readOnly ? 'sflow.artifact.pinned' : 'sflow.artifact'
        }))
      }))
    }))
  }];
}
