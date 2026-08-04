/**
 * What is waiting for a decision, and whose decision it is.
 *
 * The question a reviewer opens a governance tool to ask is not "what is the state of this Epic" but
 * "is anything waiting for *me*". Everything else is context for that. So this sorts by who can act:
 * yours first, then what is waiting on somebody else, then what cannot move at all — and it says
 * which body is being waited on rather than reporting a count.
 *
 * Authorization is recomputed here from the same inputs the engine uses, which means it can be
 * wrong in one direction only: it may offer an approval the engine then refuses, and the refusal
 * arrives with the engine's own reason. It must never *hide* an approval the engine would accept,
 * so every uncertain case is treated as actionable.
 */
import type {
  ApprovalPolicy, RepositorySnapshot, InitiativeSnapshot, StoryWorkflow
} from '../cli/snapshot.ts';

export type Standing = 'yours' | 'others' | 'blocked';

export interface ChainStep {
  authority: string;
  label: string;
  minimum: number;
  signatures: number;
  satisfied: boolean;
  open: boolean;
}

export interface PendingApproval {
  source: 'initiative' | 'story';
  id: string;
  kind: 'output' | 'phase' | 'pack';
  phase: string;
  /** The subject as the CLI names it: "business-case", "phase", "pack:opportunity". */
  subject: string;
  label: string;
  detail: string;
  sha256: string | null;
  /** The exact confirmation the CLI will demand. */
  expected: string;
  standing: Standing;
  /** Why this is not yours to sign, when it is not. */
  reason: string | null;
  /** True when you generated what you would be approving. */
  selfApproval: boolean;
  chain: ChainStep[];
  authorities: string[];
  signatures: Array<{ actor: string; at: string | null }>;
  /** Exact governed file shown when this decision represents a Story phase. */
  artifactPath?: string | null;
  workId?: string;
}

export interface Approvals {
  initiativeId: string;
  actor: string | null;
  pending: PendingApproval[];
  /** Blocking gate errors that are not themselves approvals — evidence, checklists, missing outputs. */
  obstacles: string[];
  empty: string | null;
}

interface ApprovalRecord {
  phase?: string;
  subjectType?: string;
  subjectId?: string;
  subjectSha256?: string;
  actorEmail?: string;
  at?: string;
  chainStep?: number;
}

const lower = (value: unknown): string => String(value ?? '').trim().toLowerCase();

/** Members of an authority, as lowercase emails. */
function members(snapshot: RepositorySnapshot, authority: string): Set<string> {
  const listed = snapshot.workflow?.resolution?.approvalAuthorities?.[authority]?.members
    ?? snapshot.definition?.approvalAuthorities?.[authority]?.members
    ?? snapshot.portfolio?.approvalAuthorities?.[authority]?.members
    ?? [];
  return new Set(listed.map((member) => lower(member.email)).filter(Boolean));
}

/**
 * Which chain step is open, read from the gate's own sentence.
 *
 * The gate composes these — "artifact pack X has waiting on Executive Decisioning (0/1) for exact
 * pack abc" — and it is the thing that actually blocks the phase. The report's projection of the
 * approval records drops the chainStep each decision recorded, so recomputing progress here would
 * mean guessing which body signed. Reading the sentence keeps one implementation of chain state, and
 * where no sentence exists the chain simply reports no open step rather than inventing one.
 */
function openStepFrom(gateErrors: string[], subjectId: string): { label: string; signed: number; needed: number } | null {
  for (const error of gateErrors) {
    if (!error.includes(subjectId)) continue;
    const match = /waiting on (.+?) \((\d+)\/(\d+)\)/.exec(error);
    if (match?.[1]) return { label: match[1], signed: Number(match[2]), needed: Number(match[3]) };
  }
  return null;
}

/** The declared chain, marked up with whichever step the gate says is open. */
function chainProgress(policy: ApprovalPolicy | undefined, open: { label: string; signed: number; needed: number } | null): ChainStep[] {
  if (!policy?.chain?.length) return [];
  const openIndex = open
    ? policy.chain.findIndex((step) => ((step as { label?: string }).label ?? step.authority) === open.label)
    : -1;
  return policy.chain.map((step, index) => ({
    authority: step.authority,
    label: (step as { label?: string }).label ?? step.authority,
    minimum: step.minimum,
    signatures: index === openIndex ? open?.signed ?? 0 : (openIndex < 0 && !open) || index < openIndex ? step.minimum : 0,
    // Everything before the open step must have been satisfied for it to be open at all.
    satisfied: openIndex >= 0 ? index < openIndex : !open,
    open: index === openIndex
  }));
}

/** Whose decision this is now, and why it is not yours when it is not. */
function standingFor(
  snapshot: RepositorySnapshot,
  actor: string | null,
  policy: ApprovalPolicy | undefined,
  chain: ChainStep[]
): { standing: Standing; reason: string | null; authorities: string[] } {
  if (policy?.mode === 'none') {
    return { standing: 'blocked', reason: 'This subject is not approved individually.', authorities: [] };
  }

  const openStep = chain.find((step) => step.open);
  const authorities = openStep ? [openStep.authority] : (policy?.authorities ?? []);

  if (!authorities.length) {
    // No authority named is a configuration gap, not a decision anybody can take.
    return {
      standing: 'blocked',
      reason: 'No approval authority is configured for this subject.',
      authorities: []
    };
  }
  if (!actor) {
    // Without an identity nothing can be attributed, so nothing is claimed to be actionable.
    return { standing: 'others', reason: 'No Git identity is configured for this repository.', authorities };
  }

  const permitted = authorities.some((authority) => members(snapshot, authority).has(actor));
  if (permitted) return { standing: 'yours', reason: null, authorities };

  return {
    standing: 'others',
    reason: openStep
      ? `Waiting on ${openStep.label} (${openStep.signatures}/${openStep.minimum}).`
      : `Waiting on ${authorities.join(', ')}.`,
    authorities
  };
}

/** The phase a pack's approval is attributed to: the latest phase any member sits in. */
function packTerminalPhase(phaseOrder: string[], members2: string[]): string | null {
  let terminal: string | null = null;
  let latest = -1;
  for (const member of members2) {
    const phase = member.split('/')[0] ?? '';
    const position = phaseOrder.indexOf(phase);
    if (position > latest) { latest = position; terminal = phase; }
  }
  return terminal;
}

export function buildApprovals(snapshot: RepositorySnapshot | null): Approvals {
  if (!snapshot) return { initiativeId: '', actor: null, pending: [], obstacles: [], empty: 'Reading the repository…' };
  if (snapshot.workflow) return storyApprovalsOf(snapshot, snapshot.workflow);
  const initiative = snapshot.initiative;
  if (!initiative) {
    return {
      initiativeId: '', actor: null, pending: [], obstacles: [],
      empty: 'Nothing governed is checked out on this branch.'
    };
  }
  return approvalsOf(snapshot, initiative);
}

function identityOf(value: unknown): string {
  if (typeof value === 'string') return lower(value);
  const identity = value as { email?: string; login?: string; name?: string } | null | undefined;
  return lower(identity?.email ?? identity?.login ?? identity?.name);
}

/** The checked-out Story's exact phase decision, derived from workflow.json rather than Initiative state. */
function storyApprovalsOf(snapshot: RepositorySnapshot, workflow: StoryWorkflow): Approvals {
  const actor = lower(snapshot.identities?.git?.email) || null;
  const phaseId = workflow.currentPhase;
  const phase = phaseId ? workflow.phases[phaseId] : null;
  if (!phase || phase.status !== 'awaiting_approval') {
    return {
      initiativeId: workflow.workItem.id, actor, pending: [], obstacles: [],
      empty: workflow.status === 'complete'
        ? 'This Story workflow is complete.'
        : 'Nothing is waiting for a decision.'
    };
  }

  const active = (phase.approvals ?? []).filter((approval) =>
    approval.decision === 'approved' && !approval.invalidatedAt);
  const minimum = phase.approvalPolicy?.minimum ?? 1;
  if (new Set(active.map((approval) => identityOf(approval.actor)).filter(Boolean)).size >= minimum) {
    return {
      initiativeId: workflow.workItem.id, actor, pending: [], obstacles: [],
      empty: 'Nothing is waiting for a decision.'
    };
  }

  const policy: ApprovalPolicy = {
    mode: 'individual', authorities: phase.approvalPolicy?.authorities ?? [], minimum,
    allowSelfApproval: true, chain: null
  };
  const { standing, reason, authorities } = standingFor(snapshot, actor, policy, []);
  // `phase.requiredArtifact.path` is relative to the work-item directory. The document catalog is
  // already repository-relative, so it is the only safe path for an editor tab to open.
  const catalogArtifact = snapshot.documents?.find((item) => item.phase === phase.id && Boolean(item.path));
  const artifact = catalogArtifact?.path ?? null;
  return {
    initiativeId: workflow.workItem.id,
    actor,
    pending: [{
      source: 'story',
      id: `story-phase:${phase.id}`,
      kind: 'phase',
      phase: phase.id,
      subject: 'phase',
      label: `${phase.label} — Story phase`,
      detail: `Generation ${phase.generation} of ${workflow.workItem.id}`,
      sha256: catalogArtifact?.sha256 ?? null,
      expected: phase.id,
      standing,
      reason,
      selfApproval: Boolean(actor) && identityOf(phase.generatedBy) === actor,
      chain: [],
      authorities,
      signatures: active.map((approval) => ({
        actor: identityOf(approval.actor) || 'unknown', at: approval.at ?? null
      })),
      artifactPath: artifact,
      workId: workflow.workItem.id
    }],
    obstacles: [],
    empty: null
  };
}

function approvalsOf(snapshot: RepositorySnapshot, initiative: InitiativeSnapshot): Approvals {
  const actor = lower((snapshot.identities as { git?: { email?: string } } | undefined)?.git?.email) || null;
  // `records` in the report is a count; the decisions themselves are grouped by phase.
  const byPhase = (initiative.report as { approvals?: { byPhase?: Record<string, ApprovalRecord[]> } } | undefined)
    ?.approvals?.byPhase ?? {};
  const records = Object.values(byPhase).flat();
  const { state } = initiative;
  const phaseId = state.currentPhase;
  const pending: PendingApproval[] = [];

  const gateErrors = initiative.phaseGate?.ready ? [] : initiative.phaseGate?.errors ?? [];
  const recordsFor = (phase: string, type: string, id: string): ApprovalRecord[] =>
    records.filter((record) => record.phase === phase && record.subjectType === type && record.subjectId === id);

  if (phaseId) {
    const resolution = state.resolution.phases.find((phase) => phase.id === phaseId);
    const phase = state.phases[phaseId];

    // Artifacts that exist and are not yet approved.
    for (const output of Object.values(phase?.outputs ?? {})) {
      if (!output.sha256 || output.status === 'approved') continue;
      const policy = resolution?.outputs.find((declared) => declared.id === output.id)?.approval;
      const signed = recordsFor(phaseId, 'output', output.id);
      const chain = chainProgress(policy, openStepFrom(gateErrors, output.id));
      const { standing, reason, authorities } = standingFor(snapshot, actor, policy, chain);
      pending.push({
        source: 'initiative',
        id: `output:${phaseId}/${output.id}`,
        kind: 'output',
        phase: phaseId,
        subject: output.id,
        label: output.label ?? output.id,
        detail: output.path,
        sha256: output.sha256,
        expected: `${phaseId}:${output.id}`,
        standing,
        reason,
        selfApproval: Boolean(actor) && lower(output.generatedBy) === actor,
        chain,
        authorities,
        signatures: signed.map((record) => ({ actor: record.actorEmail ?? 'unknown', at: record.at ?? null }))
      });
    }

    // Packs whose last member sits in this phase.
    for (const pack of state.resolution.packs ?? []) {
      if (packTerminalPhase(state.phaseOrder, pack.members) !== phaseId) continue;
      const complete = pack.members.every((member) => {
        const [memberPhase, memberOutput] = [member.split('/')[0] ?? '', member.split('/')[1] ?? ''];
        return Boolean(state.phases[memberPhase]?.outputs?.[memberOutput]?.sha256);
      });
      if (!complete) continue;
      const policy = (pack as { approval?: ApprovalPolicy }).approval;
      const signed = recordsFor(phaseId, 'pack', pack.id);
      const open = openStepFrom(gateErrors, pack.id);
      // A pack has no status of its own, so "already approved" is: somebody signed it and the gate
      // has stopped asking. Listing a signed-off pack as pending would invite a second decision on
      // something already decided.
      if (signed.length && !open && !gateErrors.some((error) => error.includes(pack.id))) continue;
      const chain = chainProgress(policy, open);
      const { standing, reason, authorities } = standingFor(snapshot, actor, policy, chain);
      pending.push({
        source: 'initiative',
        id: `pack:${pack.id}`,
        kind: 'pack',
        phase: phaseId,
        subject: `pack:${pack.id}`,
        label: pack.label ?? pack.id,
        detail: `${pack.members.length} artifacts across ${new Set(pack.members.map((member) => member.split('/')[0])).size} phases`,
        sha256: null,
        expected: `${phaseId}:pack:${pack.id}`,
        standing,
        reason,
        selfApproval: false,
        chain,
        authorities,
        signatures: signed.map((record) => ({ actor: record.actorEmail ?? 'unknown', at: record.at ?? null }))
      });
    }

    // The phase itself, once its gate is ready.
    if (phase && phase.status !== 'approved' && initiative.phaseGate?.ready) {
      const policy = resolution?.bundleApproval;
      const signed = recordsFor(phaseId, 'phase', phaseId);
      const chain = chainProgress(policy, openStepFrom(gateErrors, phaseId));
      const { standing, reason, authorities } = standingFor(snapshot, actor, policy, chain);
      pending.push({
        source: 'initiative',
        id: `phase:${phaseId}`,
        kind: 'phase',
        phase: phaseId,
        subject: 'phase',
        label: `${phase.label ?? phaseId} — the phase itself`,
        detail: 'Approving the phase closes it and opens the next.',
        sha256: initiative.phaseGate?.bundleSha256 ?? null,
        expected: `${phaseId}:phase`,
        standing,
        reason,
        selfApproval: Boolean(actor)
          && Object.values(phase.outputs ?? {}).some((output) => lower(output.generatedBy) === actor),
        chain,
        authorities,
        signatures: signed.map((record) => ({ actor: record.actorEmail ?? 'unknown', at: record.at ?? null }))
      });
    }
  }

  // Yours first: it is the only part most readers need.
  const order: Record<Standing, number> = { yours: 0, others: 1, blocked: 2 };
  pending.sort((left, right) => order[left.standing] - order[right.standing]
    || left.label.localeCompare(right.label));

  // Gate errors that are not approvals: evidence, checklists, artifacts that do not exist yet.
  const obstacles = (initiative.phaseGate?.ready ? [] : initiative.phaseGate?.errors ?? [])
    .filter((error) => !/\bapprovals?\b|waiting on/i.test(error));

  return {
    initiativeId: state.initiative.id,
    actor,
    pending,
    obstacles,
    empty: pending.length || obstacles.length ? null : 'Nothing is waiting for a decision.'
  };
}
