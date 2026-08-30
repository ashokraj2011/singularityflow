import type {
  RepositorySnapshot, SgosCommandCenterSnapshot, SgosProcessCard,
  SgosUnavailableProcessCard, SgosWorkObject
} from '../cli/snapshot.ts';
import type { SgosProcessGraph } from './sgos-process-graph-model.ts';

export interface SgosLane { id: string; label: string; processes: SgosProcessCard[] }

export interface SgosHumanRequestChoice {
  label: string;
  detail: string;
  args: string[];
}

export interface SgosHumanRequestChoiceSource {
  requestType: string;
  options?: Array<{ id: string; label?: string }>;
  inputSchema?: unknown;
  sensitiveMode?: string;
}

export interface SgosCommandCenterView {
  available: boolean;
  loading: boolean;
  stale: boolean;
  error: string | null;
  contentSha256: string | null;
  profileId: string | null;
  counts: Record<string, number>;
  lanes: SgosLane[];
  needsYou: SgosWorkObject[];
  unavailable: SgosUnavailableProcessCard[];
  capabilities: SgosCommandCenterSnapshot['runtimeProfile']['capabilities'];
  selected: SgosProcessCard | null;
  graph: SgosProcessGraph | null;
}

const LANE_ORDER = [
  ['running', 'Running'], ['waiting-human', 'Needs you'], ['blocked', 'Blocked'],
  ['recovery-required', 'Recovery required'], ['paused', 'Paused'], ['queued', 'Queued'],
  ['succeeded', 'Completed'], ['failed', 'Failed'], ['cancelled', 'Cancelled']
] as const;

const HUMAN_DECISIONS_BY_REQUEST: Readonly<Record<string, readonly string[]>> = Object.freeze({
  approval: ['approved', 'rejected', 'cancelled'],
  clarification: ['provided', 'cancelled'],
  credential: ['provided', 'cancelled'],
  exception: ['approved', 'rejected', 'cancelled'],
  'policy-choice': ['selected', 'cancelled'],
  'conflict-resolution': ['selected', 'provided', 'cancelled'],
  interpretation: ['provided', 'cancelled'],
  'evidence-review': ['approved', 'rejected', 'provided', 'cancelled'],
  'scope-expansion': ['approved', 'rejected', 'cancelled'],
  'production-authority': ['approved', 'rejected', 'cancelled'],
  'scientific-judgment': ['approved', 'rejected', 'provided', 'cancelled'],
  'legal-judgment': ['approved', 'rejected', 'provided', 'cancelled']
});

const DIRECT_DECISIONS: Readonly<Record<string, { label: string; detail: string }>> = Object.freeze({
  approved: { label: 'Approve', detail: 'Record an explicit approval' },
  rejected: { label: 'Reject', detail: 'Record an explicit rejection' },
  provided: { label: 'Provide', detail: 'Record that no additional typed input is required' },
  cancelled: { label: 'Cancel request', detail: 'Record cancellation of this request' }
});

/**
 * Project only responses the current Command Center can submit faithfully. The kernel remains the
 * authority and revalidates the request type, decision, option, hash, and Process revision.
 */
export function sgosHumanRequestChoices(
  request: SgosHumanRequestChoiceSource
): SgosHumanRequestChoice[] {
  const allowed = HUMAN_DECISIONS_BY_REQUEST[request.requestType];
  if (!allowed) return [];
  const choices: SgosHumanRequestChoice[] = [];
  for (const decision of allowed) {
    if (decision === 'selected') {
      for (const option of request.options ?? []) {
        choices.push({
          label: option.label ?? option.id,
          detail: `Select declared option ${option.id}`,
          args: ['--option', option.id]
        });
      }
      continue;
    }
    // Typed and sensitive values are intentionally not collected by this first UI. A user can
    // still cancel the exact request here and use the CLI/broker flow to provide a value.
    if (decision === 'provided'
        && (request.inputSchema != null
          || (request.sensitiveMode != null && request.sensitiveMode !== 'none'))) continue;
    const direct = DIRECT_DECISIONS[decision];
    if (direct) choices.push({
      ...direct,
      args: ['--decision', decision]
    });
  }
  return choices;
}

/** Pure UI projection: it cannot run an SGOS operation or manufacture a runtime state. */
export function buildSgosCommandCenter(
  snapshot: RepositorySnapshot | null,
  { loading = false, stale = false, error = null, selectedProcessId = null, graph = null }: {
    loading?: boolean; stale?: boolean; error?: string | null;
    selectedProcessId?: string | null; graph?: SgosProcessGraph | null;
  } = {}
): SgosCommandCenterView {
  const sgos = snapshot?.sgos;
  const processes = [...(sgos?.processes ?? [])];
  const selected = processes.find((process) => process.processId === selectedProcessId)
    ?? processes[0] ?? null;
  const known = new Set<string>(LANE_ORDER.map(([id]) => id));
  const lanes: SgosLane[] = LANE_ORDER.map(([id, label]) => ({
    id, label, processes: processes.filter((process) => process.status === id)
  })).filter((lane) => lane.processes.length > 0);
  const other = processes.filter((process) => !known.has(process.status));
  if (other.length) lanes.push({ id: 'other', label: 'Other runtime state', processes: other });
  return {
    available: Boolean(sgos), loading, stale, error,
    contentSha256: sgos?.contentSha256 ?? null,
    profileId: sgos?.runtimeProfile.id ?? null,
    counts: { ...(sgos?.counts ?? {}) },
    lanes,
    needsYou: [...(sgos?.needsYou ?? [])],
    unavailable: [...(sgos?.unavailable ?? [])],
    capabilities: { ...(sgos?.runtimeProfile.capabilities ?? {}) },
    selected,
    graph: graph && selected && graph.processSha256 === selected.processSha256 ? graph : null
  };
}
