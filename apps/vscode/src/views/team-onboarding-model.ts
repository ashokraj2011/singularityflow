/**
 * Pure presentation model for the TON-v1 team-onboarding journey.
 *
 * Repository catalog cursors, RDS selection references, authority revisions and prepared clone
 * URLs remain extension-host state. The webview only ever addresses the opaque `id` values exposed
 * here; it cannot nominate a URL, capability authority or proposal ref of its own.
 */
import { gitRemoteProblem } from './map-capability-form.ts';

export const TEAM_ONBOARDING_MAX_SELECTED = 20;
export const TEAM_ONBOARDING_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export type TeamOnboardingStep = 'team-and-repositories' | 'check-and-onboard' | 'workspaces';

export const TEAM_ONBOARDING_STEPS: ReadonlyArray<{
  readonly id: TeamOnboardingStep;
  readonly label: string;
  readonly description: string;
}> = Object.freeze([
  {
    id: 'team-and-repositories',
    label: 'Team and repositories',
    description: 'Name the team and choose what it owns'
  },
  {
    id: 'check-and-onboard',
    label: 'Check and onboard',
    description: 'Inspect each choice and review one proposal'
  },
  {
    id: 'workspaces',
    label: 'Workspaces',
    description: 'Review clones and reused checkouts'
  }
]);

export type TeamOnboardingRepositoryStatus =
  | 'not-checked'
  | 'will-add'
  | 'will-link'
  | 'needs-choice'
  | 'left-out';

export const TEAM_ONBOARDING_STATUS_LABELS: Readonly<Record<TeamOnboardingRepositoryStatus, string>> =
  Object.freeze({
    'not-checked': 'Not checked yet',
    'will-add': 'Will add',
    'will-link': 'Will link',
    'needs-choice': 'Needs a choice',
    'left-out': 'Left out'
  });

export type TeamOnboardingRepositoryDecision = 'include' | 'set-aside';

/** One capability-map authority already admitted by the extension host. */
export interface TeamOnboardingAuthority {
  /** Opaque page identity used in messages. This is not the authority URL. */
  id: string;
  label: string;
  /** Host-read credential-free URL. It is displayed and used in the request, never read from a message. */
  leadUrl: string;
  detail?: string | null;
}

/** One RDS catalog observation. `id` is the only row identity the page may send back. */
export interface TeamOnboardingRepositoryRow {
  id: string;
  nameWithOwner: string;
  /** Host-prepared credential-free locator. The page never places it in a data attribute. */
  locator: string | null;
  visibility?: string | null;
  access?: string | null;
  selected: boolean;
  friendlyName: string;
  capabilityId: string;
  capabilityIdEdited: boolean;
  status: TeamOnboardingRepositoryStatus;
  decision: TeamOnboardingRepositoryDecision;
  inspecting?: boolean;
  inspectionCompleted?: boolean;
  detail?: string | null;
  /** Present only after inspection proves that one compatible top-level delivery can be linked. */
  existingCapabilityId?: string | null;
  existingCapabilityName?: string | null;
}

export interface TeamOnboardingCatalogState {
  query: string;
  loading: boolean;
  hasMore: boolean;
  providerConnected: boolean;
  sourceLabel?: string | null;
  notice?: string | null;
}

export interface TeamOnboardingInspectionState {
  running: boolean;
  completed: number;
  total: number;
  cancelled: boolean;
}

export type TeamOnboardingProposalStatus =
  | 'idle'
  | 'ready'
  | 'running'
  | 'review-required'
  | 'active'
  | 'failed';

export interface TeamOnboardingProposalState {
  status: TeamOnboardingProposalStatus;
  message?: string | null;
  /** Display-only host observations; no page action posts either value back. */
  branch?: string | null;
  commit?: string | null;
}

export interface TeamOnboardingWorkspaceCapability {
  /** Opaque host-owned option identity posted by the webview. */
  id: string;
  capabilityId: string;
  name: string;
  authorityLabel: string;
  selected: boolean;
}

export interface TeamOnboardingWorkspaceRepository {
  /** Opaque host-owned row identity posted by the webview, if an action is ever added. */
  id: string;
  name: string;
  origin: string;
  /** Clone/reuse is not knowable until the workspace target has been selected and preflighted. */
  action: 'pending' | 'clone' | 'reuse';
  targetPath?: string | null;
  evidence?: string | null;
}

export interface TeamOnboardingWorkspaceState {
  ready: boolean;
  busy: boolean;
  capabilities: TeamOnboardingWorkspaceCapability[];
  repositories: TeamOnboardingWorkspaceRepository[];
  message?: string | null;
}

export interface TeamOnboardingView {
  step: TeamOnboardingStep;
  teamName: string;
  teamId: string;
  teamIdEdited: boolean;
  jiraProject: string;
  authorities: TeamOnboardingAuthority[];
  selectedAuthorityId: string | null;
  repositories: TeamOnboardingRepositoryRow[];
  catalog: TeamOnboardingCatalogState;
  inspection: TeamOnboardingInspectionState;
  proposal: TeamOnboardingProposalState;
  workspace: TeamOnboardingWorkspaceState;
  error?: string | null;
}

export interface TeamOnboardingRepositoryInput {
  id: string;
  nameWithOwner: string;
  locator?: string | null;
  visibility?: string | null;
  access?: string | null;
}

export interface TeamOnboardingProposalMember {
  rowId: string;
  capabilityId: string;
  name: string;
  locator: string;
}

export interface TeamOnboardingProposalLink {
  rowId: string;
  capabilityId: string;
  name: string;
}

export interface TeamOnboardingProposalExcluded {
  rowId: string;
  repository: string;
  status: TeamOnboardingRepositoryStatus;
  label: string;
  reason: string | null;
}

export interface TeamOnboardingProposalPreview {
  team: { id: string; name: string; jiraProject: string | null };
  authority: TeamOnboardingAuthority | null;
  members: TeamOnboardingProposalMember[];
  links: TeamOnboardingProposalLink[];
  excluded: TeamOnboardingProposalExcluded[];
  defaults: {
    sourceScope: 'whole repository';
    cloneMode: 'blobless';
    sparseCone: null;
    fallback: 'refuse';
  };
}

/** Closed JSON document accepted by `capability map-team --request`. */
export interface CapabilityTeamRequestDocument {
  teamId: string;
  lead: string;
  name: string;
  jiraProject: string | null;
  members: Array<{
    capabilityId: string;
    repositoryUrl: string;
    name: string;
  }>;
  links: string[];
}

const ACRONYMS = new Set(['api', 'cli', 'css', 'html', 'ios', 'sdk', 'ui', 'url']);

/** Deterministic lower-kebab suggestion. The engine remains the final identifier validator. */
export function teamOnboardingId(value: string): string {
  return value.normalize('NFKD')
    .replace(/\p{Mark}+/gu, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .replace(/-{2,}/gu, '-');
}

/** Friendly child name suggested from the final owner/repository segment. */
export function repositoryFriendlyName(nameWithOwner: string): string {
  const final = nameWithOwner.trim().split('/').filter(Boolean).at(-1)?.replace(/\.git$/iu, '') ?? '';
  return final.split(/[-_.\s]+/u).filter(Boolean)
    .map((word) => ACRONYMS.has(word.toLocaleLowerCase())
      ? word.toLocaleUpperCase()
      : `${word.charAt(0).toLocaleUpperCase()}${word.slice(1)}`)
    .join(' ');
}

/** Private host-side catalog identity; the same owner/name on different Git hosts stays distinct. */
export function teamOnboardingCatalogKey({
  providerInstanceId = null,
  host = null,
  nameWithOwner
}: {
  providerInstanceId?: string | null;
  host?: string | null;
  nameWithOwner: string;
}): string {
  const authority = providerInstanceId?.trim() || host?.trim() || 'unknown-provider';
  return `${authority.toLowerCase()}\n${nameWithOwner.trim().toLowerCase()}`;
}

/** Build a new untouched catalog row; catalog discovery itself grants no authority. */
export function teamOnboardingRepository(input: TeamOnboardingRepositoryInput): TeamOnboardingRepositoryRow {
  const basename = input.nameWithOwner.trim().split('/').filter(Boolean).at(-1)?.replace(/\.git$/iu, '') ?? '';
  return {
    id: input.id,
    nameWithOwner: input.nameWithOwner,
    locator: input.locator ?? null,
    visibility: input.visibility ?? null,
    access: input.access ?? null,
    selected: false,
    friendlyName: repositoryFriendlyName(input.nameWithOwner),
    capabilityId: teamOnboardingId(basename),
    capabilityIdEdited: false,
    status: 'not-checked',
    decision: 'include',
    inspecting: false,
    inspectionCompleted: false,
    detail: null,
    existingCapabilityId: null,
    existingCapabilityName: null
  };
}

export function emptyTeamOnboardingView(
  authorities: TeamOnboardingAuthority[] = [],
  repositories: TeamOnboardingRepositoryRow[] = []
): TeamOnboardingView {
  return {
    step: 'team-and-repositories',
    teamName: '',
    teamId: '',
    teamIdEdited: false,
    jiraProject: '',
    authorities,
    selectedAuthorityId: authorities.length === 1 ? authorities[0]?.id ?? null : null,
    repositories,
    catalog: {
      query: '', loading: false, hasMore: false, providerConnected: false,
      sourceLabel: null, notice: null
    },
    inspection: { running: false, completed: 0, total: 0, cancelled: false },
    proposal: { status: 'idle', message: null, branch: null, commit: null },
    workspace: { ready: false, busy: false, capabilities: [], repositories: [], message: null },
    error: null
  };
}

export function selectedTeamRepositories(view: TeamOnboardingView): TeamOnboardingRepositoryRow[] {
  return view.repositories.filter((row) => row.selected);
}

/** A set-aside decision changes presentation and proposal membership, not inspection evidence. */
export function effectiveTeamRepositoryStatus(
  row: TeamOnboardingRepositoryRow
): TeamOnboardingRepositoryStatus {
  return row.decision === 'set-aside' ? 'left-out' : row.status;
}

export function eligibleTeamRepositories(view: TeamOnboardingView): TeamOnboardingRepositoryRow[] {
  return selectedTeamRepositories(view).filter((row) => row.decision === 'include'
    && (row.status === 'will-add' || row.status === 'will-link'));
}

export function setAsideTeamRepositories(view: TeamOnboardingView): TeamOnboardingRepositoryRow[] {
  return selectedTeamRepositories(view).filter((row) => row.decision === 'set-aside'
    || row.status === 'left-out');
}

export interface TeamOnboardingChange {
  view: TeamOnboardingView;
  problem: string | null;
}

/** Select by host-owned row ID and enforce the TON-v1 cap before changing state. */
export function changeTeamRepositorySelection(
  view: TeamOnboardingView,
  rowId: string,
  selected: boolean
): TeamOnboardingChange {
  const row = view.repositories.find((entry) => entry.id === rowId);
  if (!row) return { view, problem: 'That repository is no longer in the current catalog page.' };
  if (selected && !row.selected
      && selectedTeamRepositories(view).length >= TEAM_ONBOARDING_MAX_SELECTED) {
    return {
      view,
      problem: `Choose at most ${TEAM_ONBOARDING_MAX_SELECTED} repositories for one team proposal.`
    };
  }
  const repositories = view.repositories.map((entry) => entry.id === rowId
    ? {
        ...entry,
        selected,
        status: selected ? entry.status : 'not-checked' as TeamOnboardingRepositoryStatus,
        decision: 'include' as TeamOnboardingRepositoryDecision,
        inspecting: false,
        inspectionCompleted: selected ? entry.inspectionCompleted : false,
        detail: selected ? entry.detail : null
      }
    : entry);
  return { view: { ...view, repositories, error: null }, problem: null };
}

/** Keep the derived team ID in sync until the contributor edits it explicitly. */
export function changeTeamName(view: TeamOnboardingView, teamName: string): TeamOnboardingView {
  return {
    ...view,
    teamName,
    teamId: view.teamIdEdited ? view.teamId : teamOnboardingId(teamName),
    error: null
  };
}

export function changeTeamId(view: TeamOnboardingView, teamId: string): TeamOnboardingView {
  return { ...view, teamId, teamIdEdited: true, error: null };
}

export function changeRepositoryFriendlyName(
  view: TeamOnboardingView,
  rowId: string,
  friendlyName: string
): TeamOnboardingView {
  return {
    ...view,
    repositories: view.repositories.map((row) => row.id === rowId
      ? {
          ...row,
          friendlyName,
          capabilityId: row.capabilityIdEdited ? row.capabilityId : teamOnboardingId(friendlyName)
        }
      : row),
    error: null
  };
}

export function changeRepositoryCapabilityId(
  view: TeamOnboardingView,
  rowId: string,
  capabilityId: string
): TeamOnboardingView {
  return {
    ...view,
    repositories: view.repositories.map((row) => row.id === rowId
      ? { ...row, capabilityId, capabilityIdEdited: true }
      : row),
    error: null
  };
}

/** Enter step two without inspecting a catalog row the person did not select. */
export function beginTeamRepositoryInspection(view: TeamOnboardingView): TeamOnboardingView {
  const selected = selectedTeamRepositories(view);
  return {
    ...view,
    step: 'check-and-onboard',
    repositories: view.repositories.map((row) => row.selected
      ? {
          ...row,
          status: 'not-checked' as TeamOnboardingRepositoryStatus,
          decision: 'include' as TeamOnboardingRepositoryDecision,
          inspecting: false,
          inspectionCompleted: false,
          detail: null,
          existingCapabilityId: null,
          existingCapabilityName: null
        }
      : row),
    inspection: { running: selected.length > 0, completed: 0, total: selected.length, cancelled: false },
    proposal: { status: 'idle', message: null, branch: null, commit: null },
    error: null
  };
}

export function markTeamRepositoryInspecting(
  view: TeamOnboardingView,
  rowId: string
): TeamOnboardingView {
  return {
    ...view,
    repositories: view.repositories.map((row) => row.id === rowId && row.selected
      ? { ...row, inspecting: true }
      : row)
  };
}

export interface TeamOnboardingRepositoryOutcome {
  status: Exclude<TeamOnboardingRepositoryStatus, 'not-checked'>;
  detail?: string | null;
  existingCapabilityId?: string | null;
  existingCapabilityName?: string | null;
}

/** Minimal raw shape returned by `capability inspect-repository --json`. */
export interface TeamOnboardingRawInspection {
  status?: string;
  completeness?: string;
  proposalCoverage?: string;
  matches?: Array<{
    lead?: string;
    capabilities?: string[];
  }>;
  pendingMatches?: unknown[];
  failures?: Array<string | { message?: string; code?: string }>;
  organisations?: Array<{
    lead?: string;
    organisation?: {
      capabilities?: TeamOnboardingInspectedCapability[];
    };
  }>;
}

export interface TeamOnboardingInspectedCapability {
  id: string;
  name?: string;
  kind?: string;
  parent?: string | null;
  children?: TeamOnboardingInspectedCapability[];
}

function inspectedCapabilities(
  nodes: TeamOnboardingInspectedCapability[] = [],
  derivedParent: string | null = null
): TeamOnboardingInspectedCapability[] {
  return nodes.flatMap((node) => {
    // `capability organisation` returns a nested tree and deliberately omits redundant parent
    // fields. Derive that relationship here so a child of another team can never be mislabeled as
    // a linkable top-level capability merely because the JSON tree did not repeat its parent ID.
    const normalized = { ...node, parent: node.parent ?? derivedParent };
    return [normalized, ...inspectedCapabilities(node.children ?? [], node.id)];
  });
}

function inspectionFailureText(inspection: TeamOnboardingRawInspection): string | null {
  const first = inspection.failures?.[0];
  if (!first) return null;
  return typeof first === 'string'
    ? first
    : first.message ?? first.code ?? 'Repository inspection did not complete.';
}

/**
 * Convert engine inspection evidence into the five TON-v1 row outcomes.
 *
 * This helper deliberately fails closed. In particular, `already-mapped` is not enough to link:
 * the result must also identify one delivery capability and prove that it is top-level (or already
 * beneath the team being resumed). The host still binds the inspection call to the exact authority
 * and locator; this function only classifies the returned facts.
 */
export function classifyTeamRepositoryInspection(
  inspection: TeamOnboardingRawInspection,
  options: { authorityLeadUrl: string; teamId: string }
): TeamOnboardingRepositoryOutcome {
  const status = inspection.status ?? 'inconclusive';
  const failure = inspectionFailureText(inspection);
  if (status === 'unreachable') {
    return { status: 'left-out', detail: failure ?? 'The repository could not be reached.' };
  }
  if ((inspection.pendingMatches?.length ?? 0) > 0) {
    return {
      status: 'needs-choice',
      detail: 'A capability proposal already mentions this repository. Review it before onboarding.'
    };
  }
  if (inspection.completeness !== 'complete' || inspection.proposalCoverage !== 'complete') {
    return {
      status: 'needs-choice',
      detail: failure ?? 'Authority or proposal coverage is incomplete, so absence is not proven.'
    };
  }
  if (status === 'not-onboarded' || status === 'known-repository-unassigned') {
    return {
      status: 'will-add',
      detail: 'Complete inspection found no approved capability for this repository.'
    };
  }
  if (status !== 'already-mapped') {
    return {
      status: 'needs-choice',
      detail: failure ?? (status === 'ambiguous'
        ? 'More than one capability authority or repository binding matches.'
        : 'Repository ownership could not be resolved from complete evidence.')
    };
  }

  const authority = options.authorityLeadUrl.trim();
  const matches = (inspection.matches ?? []).filter((match) => match.lead?.trim() === authority);
  const capabilityIds = [...new Set(matches.flatMap((match) => match.capabilities ?? []))];
  if (matches.length !== 1 || capabilityIds.length !== 1) {
    return {
      status: 'needs-choice',
      detail: 'The selected authority does not resolve this repository to one capability.'
    };
  }
  const organisation = (inspection.organisations ?? [])
    .find((entry) => entry.lead?.trim() === authority)?.organisation;
  const capability = inspectedCapabilities(organisation?.capabilities)
    .find((entry) => entry.id === capabilityIds[0]);
  if (!capability || capability.kind !== 'delivery') {
    return {
      status: 'needs-choice',
      detail: 'The existing mapping is not one proven delivery capability.'
    };
  }
  if (capability.parent && capability.parent !== options.teamId.trim()) {
    return {
      status: 'needs-choice',
      detail: `The existing capability already belongs to ${capability.parent}; it will not be reparented.`
    };
  }
  return {
    status: 'will-link',
    detail: capability.parent
      ? 'This delivery is already linked to the matching team.'
      : 'One compatible top-level delivery can be linked explicitly.',
    existingCapabilityId: capability.id,
    existingCapabilityName: capability.name ?? capability.id
  };
}

/** Record an inspection result only against the exact selected row the host queued. */
export function recordTeamRepositoryOutcome(
  view: TeamOnboardingView,
  rowId: string,
  outcome: TeamOnboardingRepositoryOutcome
): TeamOnboardingView {
  const target = view.repositories.find((row) => row.id === rowId && row.selected);
  if (!target) return view;
  const wasComplete = target.inspectionCompleted === true;
  const completed = Math.min(
    view.inspection.total,
    view.inspection.completed + (wasComplete ? 0 : 1)
  );
  return {
    ...view,
    repositories: view.repositories.map((row) => row.id === rowId
      ? {
          ...row,
          status: outcome.status,
          decision: outcome.status === 'left-out' ? 'set-aside' : row.decision,
          inspecting: false,
          inspectionCompleted: true,
          detail: outcome.detail ?? null,
          existingCapabilityId: outcome.existingCapabilityId ?? null,
          existingCapabilityName: outcome.existingCapabilityName ?? null
        }
      : row),
    inspection: {
      ...view.inspection,
      completed,
      running: completed < view.inspection.total && view.inspection.running
    }
  };
}

export function finishTeamRepositoryInspection(
  view: TeamOnboardingView,
  { cancelled = false }: { cancelled?: boolean } = {}
): TeamOnboardingView {
  return {
    ...view,
    // An aborted Git/RDS call may never produce a row outcome. Clear its transient flag here so
    // the row can be retried or set aside instead of remaining permanently labelled "Checking…".
    repositories: view.repositories.map((row) => row.inspecting
      ? { ...row, inspecting: false }
      : row),
    inspection: { ...view.inspection, running: false, cancelled },
    proposal: { ...view.proposal, status: cancelled ? 'idle' : 'ready' }
  };
}

export function changeTeamRepositoryDecision(
  view: TeamOnboardingView,
  rowId: string,
  decision: TeamOnboardingRepositoryDecision
): TeamOnboardingView {
  return {
    ...view,
    repositories: view.repositories.map((row) => row.id === rowId && row.selected
      ? { ...row, decision }
      : row),
    error: null
  };
}

function selectedAuthority(view: TeamOnboardingView): TeamOnboardingAuthority | null {
  return view.authorities.find((authority) => authority.id === view.selectedAuthorityId) ?? null;
}

function baseProblems(view: TeamOnboardingView, validateRows = true): string[] {
  const problems: string[] = [];
  const selected = selectedTeamRepositories(view);
  if (!view.teamName.trim()) problems.push('Name the team.');
  if (!TEAM_ONBOARDING_ID.test(view.teamId.trim())) {
    problems.push('The team ID must be lower-case kebab-case.');
  }
  if (!selectedAuthority(view)) problems.push('Choose the exact capability-map authority.');
  if (!selected.length) problems.push('Choose at least one repository.');
  if (selected.length > TEAM_ONBOARDING_MAX_SELECTED) {
    problems.push(`Choose at most ${TEAM_ONBOARDING_MAX_SELECTED} repositories.`);
  }
  if (validateRows) {
    for (const row of selected) {
      if (!row.friendlyName.trim()) problems.push(`Give ${row.nameWithOwner} a friendly capability name.`);
      if (!TEAM_ONBOARDING_ID.test(row.capabilityId.trim())) {
        problems.push(`The capability ID for ${row.nameWithOwner} must be lower-case kebab-case.`);
      }
    }
    const ids = selected.map((row) => row.capabilityId.trim()).filter(Boolean);
    const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    if (duplicates.length) problems.push(`Capability IDs must be unique: ${duplicates.join(', ')}.`);
    if (ids.includes(view.teamId.trim())) problems.push('The team and one of its children cannot use the same ID.');
  }
  return problems;
}

/** Every display blocker for the requested step, returned together rather than one attempt at a time. */
export function teamOnboardingProblems(
  view: TeamOnboardingView,
  step: TeamOnboardingStep = view.step
): string[] {
  if (step === 'workspaces') {
    return view.proposal.status === 'active'
      ? []
      : ['Activate the reviewed capability proposal before creating a workspace from it.'];
  }
  const problems = baseProblems(view, step === 'team-and-repositories');
  if (step === 'team-and-repositories') return problems;
  if (view.inspection.running) problems.push('Wait for the selected repository checks, or cancel the remaining queue.');
  for (const row of selectedTeamRepositories(view)) {
    if (row.decision === 'set-aside' || row.status === 'left-out') continue;
    if (row.status === 'not-checked') problems.push(`${row.nameWithOwner} has not been checked yet.`);
    if (row.status === 'needs-choice') {
      problems.push(`Resolve or set aside ${row.nameWithOwner}.`);
    }
    if (row.status === 'will-add') {
      if (!row.friendlyName.trim()) problems.push(`Give ${row.nameWithOwner} a friendly capability name.`);
      if (!TEAM_ONBOARDING_ID.test(row.capabilityId.trim())) {
        problems.push(`The capability ID for ${row.nameWithOwner} must be lower-case kebab-case.`);
      }
      if (!row.locator?.trim()) problems.push(`${row.nameWithOwner} has no prepared credential-free Git locator.`);
      else {
        const unsafe = gitRemoteProblem(row.locator, row.nameWithOwner);
        if (unsafe) problems.push(unsafe);
      }
    }
    if (row.status === 'will-link'
        && !TEAM_ONBOARDING_ID.test(row.existingCapabilityId?.trim() ?? '')) {
      problems.push(`${row.nameWithOwner} is not bound to one linkable capability.`);
    }
  }
  const authority = selectedAuthority(view);
  if (authority) {
    const unsafe = gitRemoteProblem(authority.leadUrl, 'Capability-map authority');
    if (!authority.leadUrl.trim()) problems.push('The selected capability-map authority has no Git locator.');
    else if (unsafe) problems.push(unsafe);
  }
  if (!eligibleTeamRepositories(view).length) {
    problems.push('Keep at least one checked repository in this proposal.');
  }
  const proposalIds = eligibleTeamRepositories(view).map((row) => row.status === 'will-link'
    ? row.existingCapabilityId?.trim() ?? ''
    : row.capabilityId.trim()).filter(Boolean);
  const duplicateProposalIds = [...new Set(proposalIds
    .filter((id, index) => proposalIds.indexOf(id) !== index))];
  if (duplicateProposalIds.length) {
    problems.push(`Proposal capability IDs must be unique: ${duplicateProposalIds.join(', ')}.`);
  }
  if (proposalIds.includes(view.teamId.trim())) {
    problems.push('The team and one of its proposed children cannot use the same ID.');
  }
  return [...new Set(problems)];
}

export function teamOnboardingProposalPreview(view: TeamOnboardingView): TeamOnboardingProposalPreview {
  const eligible = eligibleTeamRepositories(view);
  const members = eligible.filter((row) => row.status === 'will-add').map((row) => ({
    rowId: row.id,
    capabilityId: row.capabilityId.trim(),
    name: row.friendlyName.trim(),
    locator: row.locator?.trim() ?? ''
  }));
  const links = eligible.filter((row) => row.status === 'will-link').map((row) => ({
    rowId: row.id,
    capabilityId: row.existingCapabilityId?.trim() ?? '',
    name: row.existingCapabilityName?.trim() || row.friendlyName.trim()
  }));
  const eligibleIds = new Set(eligible.map((row) => row.id));
  const excluded = selectedTeamRepositories(view).filter((row) => !eligibleIds.has(row.id)).map((row) => {
    const status = effectiveTeamRepositoryStatus(row);
    return {
      rowId: row.id,
      repository: row.nameWithOwner,
      status,
      label: TEAM_ONBOARDING_STATUS_LABELS[status],
      reason: row.detail?.trim() || null
    };
  });
  return {
    team: {
      id: view.teamId.trim(),
      name: view.teamName.trim(),
      jiraProject: view.jiraProject.trim() || null
    },
    authority: selectedAuthority(view),
    members,
    links,
    excluded,
    defaults: {
      sourceScope: 'whole repository',
      cloneMode: 'blobless',
      sparseCone: null,
      fallback: 'refuse'
    }
  };
}

/** Closed request for the one all-or-nothing proposal. Throws before unsafe host state is written. */
export function mapTeamRequest(view: TeamOnboardingView): CapabilityTeamRequestDocument {
  const problems = teamOnboardingProblems(view, 'check-and-onboard');
  if (problems.length) throw new Error(problems.join(' '));
  const preview = teamOnboardingProposalPreview(view);
  const authority = preview.authority as TeamOnboardingAuthority;
  return {
    teamId: preview.team.id,
    lead: authority.leadUrl.trim(),
    name: preview.team.name,
    jiraProject: preview.team.jiraProject,
    members: preview.members.map((member) => ({
      capabilityId: member.capabilityId,
      repositoryUrl: member.locator,
      name: member.name
    })),
    links: preview.links.map((link) => link.capabilityId)
  };
}

/** Exact manual argv remains available for small shell invocations and proposal preview tests. */
export function mapTeamCommand(view: TeamOnboardingView): string[] {
  const request = mapTeamRequest(view);
  const args = [
    'capability', 'map-team', request.teamId,
    '--lead', request.lead,
    '--name', request.name
  ];
  if (request.jiraProject) args.push('--jira-project', request.jiraProject);
  for (const member of request.members) {
    args.push('--member', `${member.capabilityId}=${member.repositoryUrl}`);
  }
  for (const member of request.members) {
    args.push('--member-name', `${member.capabilityId}=${member.name}`);
  }
  for (const link of request.links) args.push('--link', link);
  args.push('--json');
  return args;
}

export function teamOnboardingStepNumber(step: TeamOnboardingStep): number {
  return Math.max(0, TEAM_ONBOARDING_STEPS.findIndex((entry) => entry.id === step)) + 1;
}

export function workspaceRepositoryActionLabel(
  action: TeamOnboardingWorkspaceRepository['action']
): 'Pending preflight' | 'Will clone' | 'Will reuse' {
  if (action === 'reuse') return 'Will reuse';
  return action === 'clone' ? 'Will clone' : 'Pending preflight';
}
