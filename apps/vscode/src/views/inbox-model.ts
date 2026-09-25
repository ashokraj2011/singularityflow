/**
 * The business inbox, as data.
 *
 * Approvals answer "what needs a decision". The document catalog answers "what exists". Keeping
 * those as separate screens made reviewers hunt through Lifecycle after every generation, so this
 * model deliberately joins them without creating another source of truth: approvals still come
 * from the gate model and every document path still comes from the engine snapshot.
 */
import { buildApprovals, type Approvals } from './approvals-model.ts';
import type {
  InitiativeOutput, RepositorySnapshot, StoryArtifact, StoryPhase, SubmissionReadiness
} from '../cli/snapshot.ts';
import type { TreeNode } from './tree-model.ts';
import { storyArtifactPublicationLabel } from './submission-presentation.ts';

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

/** A Story discovered in one of the workspace's mapped delivery repositories. */
export interface WorkspaceStoryCatalogRow {
  repositoryId: string;
  repositoryPath: string;
  /** Original mapped remote when this repository has not been materialized locally. */
  repositoryUrl?: string | null;
  id: string;
  title: string;
  status: string;
  currentPhase: string | null;
  branch: string | null;
}

/** A Story checkout available from a mapped workspace repository. */
export interface InboxStory {
  workId: string;
  title: string;
  phase: string;
  status: string;
  terminal: boolean;
  current: boolean;
  repositoryId: string;
  repositoryPath: string;
  repositoryUrl: string | null;
  attachable: boolean;
  branch: string | null;
}

export interface Inbox {
  subjectId: string;
  subjectLabel: string;
  approvals: Approvals;
  artifacts: InboxArtifact[];
  /** Generated artifacts grouped by their owning Work ID, then by lifecycle phase. */
  workItems: InboxWorkItem[];
  /** All discovered Stories, including completed and cancelled work. */
  stories: InboxStory[];
  /** Non-terminal Stories retained for consumers needing only work in progress. */
  activeStories: InboxStory[];
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

function storyArtifact(
  document: StoryDocument,
  workId: string,
  workLabel: string,
  phaseDefinition: StoryPhase | null = null,
  readiness: SubmissionReadiness | null | undefined = null
): InboxArtifact | null {
  if (!document.path || !document.sha256) return null;
  const generation = document.generation ?? phaseDefinition?.generation ?? null;
  // Seeded templates may already have hashable bytes. They are still authoring inputs, not
  // generated outputs, until the engine records a positive publication generation.
  if (document.type === 'artifact' && generation === 0) return null;
  const phaseId = document.phase ?? (document.type === 'system' ? 'work item' : 'sources');
  return {
    id: `story:${workId}:${document.id ?? document.path}`,
    label: document.label ?? document.id ?? document.path,
    phase: phaseId,
    kind: document.kind ?? document.type ?? 'document',
    status: phaseDefinition && document.type === 'artifact'
      ? storyArtifactPublicationLabel(document as StoryArtifact, phaseDefinition, readiness)
      : document.status ?? (document.type === 'artifact' ? 'generated' : 'available'),
    path: document.path,
    generation,
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

const TERMINAL_STORY_STATUSES = new Set(['complete', 'completed', 'cancelled', 'invalid']);

function storiesOf(
  snapshot: RepositorySnapshot | null,
  catalog: readonly WorkspaceStoryCatalogRow[],
  currentRepositoryPath: string
): InboxStory[] {
  const selectedWorkId = snapshot?.selectedWorkId ?? snapshot?.workflow?.workItem.id ?? null;
  const currentCatalog = currentRepositoryPath
    ? catalog.filter((row) => row.repositoryPath === currentRepositoryPath)
    : [];
  const byRepositoryAndId = new Map<string, InboxStory>();
  const key = (repositoryPath: string, workId: string, repositoryUrl?: string | null, repositoryId?: string) =>
    `${repositoryPath ? `path:${repositoryPath}` : `remote:${repositoryUrl || repositoryId || ''}`}\u0000${workId}`;
  for (const item of snapshot?.workItems ?? []) {
    const catalogRow = currentCatalog.find((row) => row.id === item.id);
    byRepositoryAndId.set(key(currentRepositoryPath, item.id), {
      workId: item.id,
      title: item.title ?? catalogRow?.title ?? item.id,
      phase: String(item.currentPhase ?? item.status ?? 'active').replaceAll('_', ' '),
      status: String(item.status ?? 'active').replaceAll('_', ' '),
      terminal: TERMINAL_STORY_STATUSES.has(String(item.status)),
      current: item.id === selectedWorkId,
      repositoryId: catalogRow?.repositoryId ?? 'Current repository',
      repositoryPath: currentRepositoryPath,
      repositoryUrl: catalogRow?.repositoryUrl ?? null,
      attachable: true,
      branch: catalogRow?.branch ?? item.branch ?? null
    });
  }
  for (const row of catalog) {
    if (!row.id) continue;
    const identity = key(row.repositoryPath, row.id, row.repositoryUrl, row.repositoryId);
    if (byRepositoryAndId.has(identity)) continue;
    byRepositoryAndId.set(identity, {
      workId: row.id,
      title: row.title || row.id,
      phase: String(row.currentPhase || row.status || 'active').replaceAll('_', ' '),
      status: String(row.status || 'active').replaceAll('_', ' '),
      terminal: TERMINAL_STORY_STATUSES.has(String(row.status)),
      current: Boolean(row.repositoryPath) && row.repositoryPath === currentRepositoryPath && row.id === selectedWorkId,
      repositoryId: row.repositoryId || row.repositoryPath || row.repositoryUrl || 'Mapped repository',
      repositoryPath: row.repositoryPath,
      repositoryUrl: row.repositoryUrl ?? null,
      attachable: Boolean(row.repositoryPath),
      branch: row.branch
    });
  }
  return [...byRepositoryAndId.values()].sort((left, right) => Number(left.terminal) - Number(right.terminal)
    || Number(right.current) - Number(left.current)
    || left.repositoryId.localeCompare(right.repositoryId)
    || left.workId.localeCompare(right.workId));
}

export function buildInbox(
  snapshot: RepositorySnapshot | null,
  catalog: readonly WorkspaceStoryCatalogRow[] = [],
  currentRepositoryPath = ''
): Inbox {
  const approvals = buildApprovals(snapshot);
  const stories = storiesOf(snapshot, catalog, currentRepositoryPath);
  const activeStories = stories.filter((story) => !story.terminal);
  if (!snapshot) {
    return {
      subjectId: '', subjectLabel: '', approvals, artifacts: [], workItems: [], stories, activeStories, groups: [],
      empty: stories.length ? null : 'Reading the repository…'
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
      const phase = workId === storyId && document.phase
        ? snapshot.workflow?.phases[document.phase] ?? null
        : null;
      return storyArtifact(document, workId, workLabel, phase, snapshot.submissionReadiness);
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
    stories,
    activeStories,
    groups,
    empty: subjectId || artifacts.length || approvals.pending.length || stories.length
      ? null
      : 'Nothing governed is checked out on this branch.'
  };
}

/** A compact sidebar index. The full card-and-document view opens from its first row. */
export function buildInboxTree(
  snapshot: RepositorySnapshot | null,
  error?: Error | null,
  catalog: readonly WorkspaceStoryCatalogRow[] = [],
  currentRepositoryPath = '',
  catalogIssue: string | null = null
): TreeNode[] {
  const refreshStories: TreeNode = {
    kind: 'action', id: 'inbox:refresh-stories', label: 'Refresh Stories',
    description: 'fetch remote Story branches', icon: 'refresh', runCommand: 'singularityFlow.refresh'
  };
  const discoveryWarning: TreeNode[] = catalogIssue ? [{
    kind: 'message', id: 'inbox:story-discovery-issue', label: 'Story list may be incomplete',
    description: catalogIssue, icon: 'warning',
    tooltip: `${catalogIssue}\nUse Refresh Stories to retry discovery.`
  }] : [];
  if (error) return [{
    kind: 'message', id: 'inbox:error', label: error.message, icon: 'error',
    tooltip: 'The inbox could not read the governed repository.'
  }, ...discoveryWarning, refreshStories];
  const inbox = buildInbox(snapshot, catalog, currentRepositoryPath);
  if (!snapshot && !inbox.stories.length) {
    return catalogIssue
      ? [...discoveryWarning, refreshStories]
      : [{ kind: 'message', id: 'inbox:loading', label: 'Reading the inbox…', icon: 'loading~spin' }];
  }
  if (inbox.empty && catalogIssue) return [...discoveryWarning, refreshStories];
  if (inbox.empty) return [{
    kind: 'action', id: 'inbox:empty', label: inbox.empty, description: 'start intake first',
    icon: 'inbox', runCommand: 'singularityFlow.startWork'
  }, refreshStories];

  const yours = inbox.approvals.pending.filter((approval) => approval.standing === 'yours').length;
  const stories = inbox.stories;
  return [...discoveryWarning, {
    kind: 'action', id: 'inbox:open', label: 'Open business inbox',
    description: `${yours} waiting · ${inbox.artifacts.length} generated`,
    tooltip: 'Review decisions and every generated artifact in one place.',
    icon: yours ? 'bell-dot' : 'inbox', runCommand: 'singularityFlow.openInbox'
  }, ...(stories.length ? [{
    kind: 'group' as const, id: 'inbox:active-stories', label: 'Workspace Stories',
    description: String(stories.length), icon: 'list-tree',
    tooltip: 'Open a materialized Story checkout. Remote-only Stories need their repository materialized first.',
    children: stories.map((item) => ({
      kind: 'story' as const,
      id: item.attachable && item.repositoryPath === currentRepositoryPath
        ? `inbox:active-story:${item.workId}`
        : `inbox:active-story:${encodeURIComponent(item.repositoryPath || item.repositoryUrl || item.repositoryId)}:${item.workId}`,
      label: item.workId,
      description: `${item.repositoryId} · ${item.phase}${item.terminal ? ` · ${item.status}` : ''}${item.current ? ' · current' : ''}${item.attachable ? '' : ' · materialize to open'}`,
      tooltip: `${item.title}\n${item.repositoryPath || item.repositoryUrl || item.repositoryId}\n${item.status}\n${item.attachable
        ? 'Select to synchronize and open this Story checkout.'
        : 'Materialize repository to open this Story.'}`,
      icon: item.attachable ? item.current ? 'check' : 'statusCurrent' : 'warning',
      ...(item.attachable ? {
        command: ['session', 'attach', item.workId], runCommand: 'singularityFlow.runAction',
        ...(item.repositoryPath !== currentRepositoryPath ? { openPath: item.repositoryPath } : {}),
        contextValue: 'sflow.story.active.summary'
      } : { contextValue: 'sflow.story.remote-only' })
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
  }, refreshStories];
}
