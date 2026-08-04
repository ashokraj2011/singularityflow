/**
 * The status dashboard: whether this repository is in a state to do governed work, and where the
 * work that is under way has got to.
 *
 * Everything here is already in the snapshot — diagnostics, the Epic, the approval inbox, agent
 * status, the ledger, telemetry. None of it had a surface, so a person had to run four commands and
 * hold the answers in their head to know whether they were ready to start.
 *
 * The ordering is deliberate: what is broken, then what is waiting on a person, then what is merely
 * true. A dashboard that leads with counts trains people to skim past the one line that mattered.
 */
import type {
  RepositorySnapshot, InitiativeSnapshot, StoryWorkflowReport, StoryPhaseReport, StoryModelUsage
} from '../cli/snapshot.ts';
import { phasesInOrder } from '../cli/snapshot.ts';

export type Health = 'pass' | 'warn' | 'fail' | 'skip' | (string & {});

export interface Check { id: string; status: Health; message: string; fix?: string | null }

export interface DashboardSection {
  id: string;
  label: string;
  /** The single sentence a reader should take away, or null when there is nothing to say. */
  headline: string;
  status: Health;
  detail: string[];
}

export interface Dashboard {
  repository: string;
  branch: string;
  /** Checks that are not passing, worst first — the only ones worth a reader's attention. */
  failing: Check[];
  passing: number;
  sections: DashboardSection[];
  analytics: LifecycleAnalytics | null;
  /** True when nothing is broken and nothing is waiting. */
  quiet: boolean;
}

export type UsageStatus = 'none' | 'unavailable' | 'partial' | 'exact';

export interface LifecyclePhaseMetric extends StoryPhaseReport {
  elapsedShare: number;
  activeShare: number;
  waitingShare: number;
}

export interface LifecycleAnalytics {
  id: string;
  title: string | null;
  workType: string | null;
  status: string;
  completedPhases: number;
  totalPhases: number;
  completionPercent: number;
  currentPhase: string | null;
  elapsedMs: number | null;
  activeMs: number | null;
  waitingMs: number;
  reworkCycles: number;
  selfApprovals: number;
  rejections: number;
  sequenceOverrides: number;
  totalTokens: number;
  usageStatus: UsageStatus;
  usageRecords: number;
  exactUsageRecords: number;
  pendingTelemetry: number;
  cost: number | null;
  costStatus: string;
  models: StoryModelUsage[];
  bottleneck: { phase: string; waitingMs: number; share: number | null } | null;
  phases: LifecyclePhaseMetric[];
}

const RANK: Record<string, number> = { fail: 0, warn: 1, skip: 2, pass: 3 };

/** The worse of two health values, so a section reports its weakest part rather than its average. */
function worse(left: Health, right: Health): Health {
  return (RANK[left] ?? 9) <= (RANK[right] ?? 9) ? left : right;
}

function epicSection(initiative: InitiativeSnapshot | null | undefined): DashboardSection {
  if (!initiative) {
    return {
      id: 'epic', label: 'Epic', status: 'skip',
      headline: 'Nothing governed is checked out on this branch.',
      detail: ['Starting one is the first governed act in a repository.']
    };
  }

  const phases = phasesInOrder(initiative);
  const approved = phases.filter((phase) => phase.status === 'approved').length;
  const current = phases.find((phase) => phase.current);
  const blocked = phases.filter((phase) => phase.status === 'rejected' || phase.status === 'stale');

  // An artifact that has not been generated is not a fault; a phase that is rejected or stale is.
  const status: Health = blocked.length ? 'warn' : approved === phases.length ? 'pass' : 'skip';
  const title = initiative.state.initiative.title ?? initiative.state.initiative.id;

  return {
    id: 'epic',
    label: 'Epic',
    status,
    headline: current
      ? `${title} is in ${current.label}.`
      : `${title} — ${approved} of ${phases.length} phases approved.`,
    detail: [
      `${approved} of ${phases.length} phases approved.`,
      ...blocked.map((phase) => `${phase.label} is ${phase.status === 'stale'
        ? 'stale: an artifact it depended on changed'
        : 'rejected and needs another pass'}.`)
    ]
  };
}

function approvalSection(snapshot: RepositorySnapshot): DashboardSection {
  const inbox = snapshot.approvalInbox;
  const waiting = inbox?.count ?? 0;
  return {
    id: 'approvals',
    label: 'Approvals',
    // Something waiting on a person is the state most worth surfacing: it is the only one that
    // will not resolve itself.
    status: waiting ? 'warn' : 'pass',
    headline: waiting
      ? `${waiting} ${waiting === 1 ? 'approval is' : 'approvals are'} waiting on you.`
      : 'Nothing is waiting on you.',
    detail: inbox?.fetched === false && waiting === 0
      ? ['The remote was not read, so this counts only what is already local.']
      : []
  };
}

function agentSection(snapshot: RepositorySnapshot): DashboardSection {
  const agents = snapshot.agentStatus ?? [];
  const drifted = agents.filter((agent) => agent.sourceChanged);
  const unlocked = agents.filter((agent) => agent.status === 'local-only');
  return {
    id: 'agents',
    label: 'Agents',
    status: drifted.length ? 'warn' : 'pass',
    headline: agents.length
      ? `${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}${drifted.length ? `, ${drifted.length} changed since being locked` : ''}.`
      : 'No agents are installed.',
    detail: [
      ...drifted.map((agent) => `${agent.id} has changed since it was locked.`),
      ...(unlocked.length ? [`${unlocked.length} not yet locked to a version.`] : [])
    ]
  };
}

function governanceSection(snapshot: RepositorySnapshot): DashboardSection {
  const ledger = snapshot.ledger;
  const enabled = Boolean(ledger?.enabled);
  return {
    id: 'governance',
    label: 'Governance',
    // Not an error: a repository can be governed without a ledger. It is worth stating, because
    // the difference decides whether workflow progress is recoverable from Git.
    status: enabled ? 'pass' : 'skip',
    headline: enabled
      ? `Workflow progress is recorded on ${ledger?.config?.branch ?? 'the state branch'}.`
      : 'No state branch: workflow progress is not recorded in Git.',
    detail: enabled ? [] : ['A workspace can create one; an existing repository enables it in workflow.yml.']
  };
}

function usageStatus(report: StoryWorkflowReport): UsageStatus {
  const coverage = report.costCoverage;
  if (!coverage.usageRecords && !coverage.pendingRecords) return 'none';
  if (!coverage.exactUsageRecords) return 'unavailable';
  return coverage.pendingRecords || coverage.exactUsageRecords !== coverage.usageRecords ? 'partial' : 'exact';
}

/** A display-oriented view over the engine's report. It never derives lifecycle facts itself. */
export function buildLifecycleAnalytics(report: StoryWorkflowReport | null | undefined): LifecycleAnalytics | null {
  if (!report) return null;
  const maximumElapsed = Math.max(...report.phases.map((phase) => phase.elapsedMs ?? 0), 1);
  const completedPhases = report.phases.filter((phase) => phase.status === 'approved').length;
  const current = report.phases.find((phase) => ['in_progress', 'awaiting_approval', 'rejected', 'stale'].includes(phase.status));
  const share = (value: number | null): number => Math.max(0, Math.min(100, Math.round(((value ?? 0) / maximumElapsed) * 100)));
  return {
    id: report.workItem.id,
    title: report.workItem.title,
    workType: report.workItem.workType,
    status: report.workItem.status ?? (report.completedAt ? 'complete' : 'in_progress'),
    completedPhases,
    totalPhases: report.phases.length,
    completionPercent: report.phases.length ? Math.round((completedPhases / report.phases.length) * 100) : 0,
    currentPhase: current?.id ?? null,
    elapsedMs: report.elapsedMs,
    activeMs: report.activeMs,
    waitingMs: report.waitingMs,
    reworkCycles: report.reworkCycles,
    selfApprovals: report.selfApprovals,
    rejections: report.rejections.length,
    sequenceOverrides: report.sequenceOverrides.length,
    totalTokens: report.tokens.total,
    usageStatus: usageStatus(report),
    usageRecords: report.costCoverage.usageRecords,
    exactUsageRecords: report.costCoverage.exactUsageRecords,
    pendingTelemetry: report.costCoverage.pendingRecords,
    cost: report.cost,
    costStatus: report.costStatus,
    models: report.tokens.byModel,
    bottleneck: report.bottleneck,
    phases: report.phases.map((phase) => ({
      ...phase,
      elapsedShare: share(phase.elapsedMs),
      activeShare: share(phase.activeMs),
      waitingShare: share(phase.waitingMs)
    }))
  };
}

export function humanizeDuration(milliseconds: number | null | undefined): string {
  if (milliseconds == null || !Number.isFinite(milliseconds) || milliseconds < 0) return 'Unavailable';
  const seconds = milliseconds / 1000;
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 36) return `${(Math.round(hours * 10) / 10).toFixed(1)}h`;
  return `${(Math.round((hours / 24) * 10) / 10).toFixed(1)}d`;
}

export function buildDashboard(snapshot: RepositorySnapshot | null): Dashboard | null {
  if (!snapshot) return null;
  const diagnostics = snapshot.diagnostics;
  const checks = (diagnostics?.checks ?? []) as Check[];
  const failing = checks
    .filter((check) => check.status !== 'pass')
    .sort((left, right) => (RANK[left.status] ?? 9) - (RANK[right.status] ?? 9));

  const sections = [
    epicSection(snapshot.initiative),
    approvalSection(snapshot),
    agentSection(snapshot),
    governanceSection(snapshot)
  ];

  return {
    repository: diagnostics?.repository ?? '',
    branch: diagnostics?.branch ?? '',
    failing,
    passing: checks.filter((check) => check.status === 'pass').length,
    sections,
    analytics: buildLifecycleAnalytics(snapshot.report),
    quiet: !failing.some((check) => check.status === 'fail')
      && sections.every((section) => section.status !== 'warn')
  };
}

/** The dashboard's own worst state, for a status-bar or a title. */
export function dashboardHealth(dashboard: Dashboard): Health {
  return [
    ...dashboard.failing.map((check) => check.status),
    ...dashboard.sections.map((section) => section.status)
  ].reduce<Health>((accumulated, next) => worse(accumulated, next), 'pass');
}
