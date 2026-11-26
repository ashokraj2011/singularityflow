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
import { sheetNextIsTheList } from '../decisions.ts';
import { initiativePendingApprovals } from '../../../../src/initiative-approvals.mjs';
import {
  type ApprovalPolicy, type RepositorySnapshot, type InitiativeSnapshot, type StoryWorkflow
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
  /** Earlier phases this exact gate is configured to return work to. */
  rejectTo: string[];
  signatures: Array<{ actor: string; at: string | null }>;
  /** Exact governed file, from the repository root: a Story phase's artifact or an Epic output. */
  artifactPath?: string | null;
  workId?: string;
  /** Exact submitted packet and source revision this decision is bound to. */
  reviewPacketSha256?: string | null;
  submittedSourceCommit?: string | null;
  /** What approving does when a workflow decision follows the phase, in the engine's words. */
  afterApproval?: string | null;
  /**
   * The decisions the approval would be refused for (submission readiness `decisions-required`), so
   * the card offers the decision list first instead of an approval the engine would refuse.
   */
  heldBy?: { count: number; headline: string } | null;
  /** What else the approval would be refused for, and who clears it (the step sheet, or `approvalCheck` from an older CLI). */
  approvalHolds?: ApprovalHoldView[];
  /** The step sheet's next is on the decision list: the card offers it, so a hold is never left with only Request changes. */
  decideNext?: boolean;
}

export interface Approvals {
  initiativeId: string;
  actor: string | null;
  pending: PendingApproval[];
  /** Blocking gate errors that are not themselves approvals — evidence, checklists, missing outputs. */
  obstacles: string[];
  empty: string | null;
}

const lower = (value: unknown): string => String(value ?? '').trim().toLowerCase();

type Person = { email: string | null; login: string | null };

/** Who this repository attributes a decision to, by email and GitHub login. */
function personOf(snapshot: RepositorySnapshot): Person {
  return {
    email: lower(snapshot.identities?.git?.email) || null,
    login: lower(snapshot.identities?.github ?? snapshot.identities?.git?.login) || null
  };
}

/**
 * Whether an authority admits this person, by the engine's rule: a group open to any Git identity,
 * or a listed member matched by email or GitHub login.
 */
function authorityAdmits(snapshot: RepositorySnapshot, authority: string, person: Person): boolean {
  const definition = snapshot.workflow?.resolution?.approvalAuthorities?.[authority]
    ?? snapshot.definition?.approvalAuthorities?.[authority]
    ?? snapshot.portfolio?.approvalAuthorities?.[authority];
  if (!definition || (!person.email && !person.login)) return false;
  if (definition.allowAnyGitIdentity) return true;
  return (definition.members ?? []).some((member) => (person.email && lower(member.email) === person.email)
    || (person.login && lower(member.githubLogin ?? member.login) === person.login));
}

/** Whether an authority names its members only by GitHub login, so a person with no login known cannot be matched. */
function loginOnly(snapshot: RepositorySnapshot, authority: string): boolean {
  const definition = snapshot.workflow?.resolution?.approvalAuthorities?.[authority]
    ?? snapshot.definition?.approvalAuthorities?.[authority]
    ?? snapshot.portfolio?.approvalAuthorities?.[authority];
  return Boolean(definition && !definition.allowAnyGitIdentity && (definition.members ?? []).some((member) => (member.githubLogin ?? member.login) && !member.email));
}

/** Whether a recorded identity is this person, by email or login. */
function samePerson(value: unknown, person: Person): boolean {
  const identity = value as { email?: string; login?: string } | null | undefined;
  return Boolean((person.email && lower(identity?.email) === person.email)
    || (person.login && lower(identity?.login) === person.login));
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
      reason: 'No approval group is configured for this subject.',
      authorities: []
    };
  }
  const person = personOf(snapshot);
  if (!actor && !person.login) {
    // Without an identity nothing can be attributed, so nothing is claimed to be actionable.
    return { standing: 'others', reason: 'No Git identity is configured for this repository.', authorities };
  }

  const permitted = authorities.some((authority) => authorityAdmits(snapshot, authority, person));
  if (permitted) return { standing: 'yours', reason: null, authorities };
  // A group that names its members only by GitHub login, and no login known here: whether it is theirs cannot be told on
  // this page, so its Approve is offered and the approval itself checks it. "With someone else" with no button left the
  // person nowhere [owner's Story arshy, 2026-11-20, hardening C].
  if (!person.login && authorities.some((authority) => loginOnly(snapshot, authority))) {
    return { standing: 'yours', reason: 'Your GitHub account is not known here, so SFlow cannot confirm you are in this group: approving checks it.', authorities };
  }

  return {
    standing: 'others',
    reason: openStep
      ? `Waiting on ${openStep.label} (${openStep.signatures}/${openStep.minimum}).`
      : `Waiting on ${authorities.join(', ')}.`,
    authorities
  };
}

export function buildApprovals(snapshot: RepositorySnapshot | null): Approvals {
  if (!snapshot) return { initiativeId: '', actor: null, pending: [], obstacles: [], empty: 'Reading the repository…' };
  if (snapshot.workflow) return storyApprovalsOf(snapshot, snapshot.workflow);
  const initiative = snapshot.initiative;
  if (!initiative) {
    return {
      initiativeId: '', actor: null, pending: [], obstacles: [],
      empty: 'No Story or Initiative is checked out on this branch.'
    };
  }
  return approvalsOf(snapshot, initiative);
}

/** One reason approval would be refused, and who clears it (`approvalCheck.holds` from the CLI). */
export interface ApprovalHoldView { code: string; owner: string; who: string; summary: string; action: { label: string; command: string } | null;
  /** `who` is a whole sentence for the person looking (the step sheet), not a phrase that leads the summary. */
  forViewer?: boolean }

/**
 * The holds an approval would be refused for that someone other than the approver clears, from an
 * untrusted CLI result, bounded. The approver's own answers (`you-decide`) are the form's business.
 */
export function approvalHolds(value: unknown): ApprovalHoldView[] {
  const check = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  const text = (entry: unknown, limit = 400) => (typeof entry === 'string' && entry.trim() ? entry.slice(0, limit) : null);
  return (Array.isArray(check?.holds) ? check.holds : []).slice(0, 20).flatMap((entry) => {
    const hold = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null;
    const owner = text(hold?.owner, 40);
    const summary = text(hold?.summary);
    if (!hold || !owner || owner === 'you-decide' || !summary) return [];
    const action = hold.action && typeof hold.action === 'object' ? hold.action as Record<string, unknown> : null;
    const command = text(action?.command, 2000);
    return [{ code: text(hold.code, 80) ?? 'unknown', owner, who: text(hold.who, 80) ?? owner, summary,
      action: command?.startsWith('singularity-flow ') ? { label: text(action?.label, 2000) ?? '', command } : null }];
  });
}

/** A blank in a sheet's command, as a person reads it in a command they will type. */
const shownCommand = (command: string) => command.replace(/\{([a-z0-9-]+)\}/gu, '<$1>');

/**
 * What the step sheet holds this approval for, from an untrusted CLI result, bounded: who clears each,
 * for the person looking, and the first way through. What the approval's own form asks and the
 * signature its terminal takes are part of approving, so neither is shown as a hold.
 */
export function sheetHolds(value: unknown): ApprovalHoldView[] | null {
  const sheet = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (sheet?.schema !== 'sflow-step-sheet/v1' || !Array.isArray(sheet.holds)) return null;
  const text = (entry: unknown, limit = 400) => (typeof entry === 'string' && entry.trim() ? entry.slice(0, limit) : null);
  return sheet.holds.slice(0, 20).flatMap((entry) => {
    const hold = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null;
    const party = hold?.clearedBy && typeof hold.clearedBy === 'object' ? hold.clearedBy as Record<string, unknown> : null;
    const title = text(hold?.title);
    const kind = text(party?.kind, 40);
    if (!hold || !title || !kind || kind === 'viewer-form' || hold.code === 'PSS_CARD_NOT_SHOWN') return [];
    const steps = Array.isArray(hold.steps) ? hold.steps as Array<Record<string, unknown>> : [];
    // Several ways through are a choice: the decision list asks it, and no card picks one to show first.
    const open = steps.filter((candidate) => candidate?.available !== false && typeof candidate?.command === 'string');
    const step = open.length === 1 ? open[0] : null;
    const command = text(step?.command, 2000);
    return [{ code: text(hold.code, 80) ?? 'unknown', owner: kind, who: text(party?.words, 600) ?? '', summary: title, forViewer: true,
      action: command?.startsWith('singularity-flow ') ? { label: text(step?.label, 2000) ?? '', command: shownCommand(command) } : null }];
  });
}

/** One person per decision, keyed as the engine keys them: GitHub login, then email, then name. */
function identityOf(value: unknown): string {
  if (typeof value === 'string') return lower(value);
  const identity = value as { email?: string; login?: string; name?: string } | null | undefined;
  return lower(identity?.login) || lower(identity?.email) || lower(identity?.name);
}

/** The checked-out Story's exact phase decision, derived from workflow.json rather than Initiative state. */
/**
 * What approving this phase does under the decision that follows it, so the approver sees the route
 * before they approve: the engine's projection from the recorded values, or that a person chooses.
 */
function afterApprovalText(snapshot: RepositorySnapshot, workflow: StoryWorkflow, phaseId: string): string | null {
  const ahead = snapshot.decisions?.ahead;
  if (!ahead || ahead.after !== phaseId || workflow.currentPhase !== phaseId) return null;
  if (ahead.projection?.text) return ahead.projection.text;
  return ahead.mode === 'ask'
    ? `A person then chooses what happens next ('${ahead.label}').`
    : `'${ahead.label}' then chooses the next step from the recorded values.`;
}

/** The decisions the engine says hold this step's approval, from the same readiness every surface reads. */
function heldByDecisions(snapshot: RepositorySnapshot, phaseId: string): { count: number; headline: string } | null {
  const readiness = snapshot.submissionReadiness;
  const held = readiness?.phaseId === phaseId && readiness.classification === 'decisions-required' ? readiness.decisions : null;
  return held && Number.isSafeInteger(held.count) && held.count > 0 && typeof held.headline === 'string'
    ? { count: held.count, headline: held.headline } : null;
}

function storyApprovalsOf(snapshot: RepositorySnapshot, workflow: StoryWorkflow): Approvals {
  const actor = lower(snapshot.identities?.git?.email) || null;
  const phaseId = workflow.currentPhase;
  const phase = phaseId ? workflow.phases[phaseId] : null;
  if (!phase || phase.status !== 'awaiting_approval') {
    return {
      initiativeId: workflow.workItem.id, actor, pending: [], obstacles: [],
      empty: workflow.status === 'closed'
        ? 'Every step of this Story is decided.'
        : 'Nothing is waiting for a decision.'
    };
  }

  const active = (phase.approvals ?? []).filter((approval) =>
    approval.decision === 'approved' && !approval.invalidatedAt);
  const minimum = phase.approvalPolicy?.minimum ?? 1;
  // The engine's verdict when the snapshot carries it; this rule is only a stand-in for an older CLI.
  const verdict = snapshot.approval?.phase === phaseId ? snapshot.approval : null;
  const requiredOutstanding = verdict ? verdict.remainingAuthorities : (phase.approvalPolicy?.requiredAuthorities ?? [])
    .filter((authority) => !active.some((approval) => approval.authorityGroup === authority));
  const met = verdict ? verdict.met
    : new Set(active.map((approval) => identityOf(approval.actor)).filter(Boolean)).size >= minimum && !requiredOutstanding.length;
  if (met) {
    return {
      initiativeId: workflow.workItem.id, actor, pending: [], obstacles: [],
      empty: 'Nothing is waiting for a decision.'
    };
  }

  const allowSelfApproval = phase.approvalPolicy?.allowSelfApproval ?? true;
  const policy: ApprovalPolicy = {
    mode: 'individual',
    // While a required group has not decided, only its members can move the phase.
    authorities: requiredOutstanding.length && active.length >= minimum ? requiredOutstanding : phase.approvalPolicy?.authorities ?? [],
    minimum, allowSelfApproval, chain: null
  };
  const selfApproval = samePerson(phase.generatedBy, personOf(snapshot));
  const decided = standingFor(snapshot, actor, policy, []);
  const { authorities } = decided;
  const blockedSelf = selfApproval && !allowSelfApproval && decided.standing === 'yours';
  const standing = blockedSelf ? 'blocked' : decided.standing;
  const reason = blockedSelf ? 'This phase does not allow its author to approve it.' : decided.reason;
  // `phase.requiredArtifact.path` is relative to the work-item directory. The document catalog is
  // already repository-relative, so it is the only safe path for an editor tab to open. Uploaded
  // documents share the catalog and come first in it, so only generated outputs qualify: a brief
  // attached during a phase is not what that phase's approval reviews.
  const catalogArtifact = snapshot.documents?.find((item) => (item.type === 'artifact' || (!item.type && Boolean(item.phase)))
    && item.phase === phase.id && Boolean(item.path));
  const artifact = catalogArtifact?.path ?? null;
  const submission = [...(workflow.lineage?.submissions ?? [])].reverse().find((item) =>
    item.phase === phase.id && item.generation === phase.generation);
  const packet = submission?.packetSha256 ?? null;
  const sourceCommit = submission?.projection?.sourceCommit ?? null;
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
      detail: `Generation ${phase.generation} of ${workflow.workItem.id}${packet ? ' · submitted for review' : ''}`,
      sha256: catalogArtifact?.sha256 ?? null,
      expected: phase.id,
      standing,
      reason,
      selfApproval,
      chain: [],
      authorities,
      // Older pinned Stories may predate effective-policy filtering. Never offer a target that
      // the lifecycle cannot enter, even when its historical rejectTo list still names one.
      rejectTo: (verdict?.correctionTargets ?? phase.approvalPolicy?.rejectTo ?? [phase.id]).filter((target) =>
        workflow.phaseOrder.includes(target) && workflow.phaseOrder.indexOf(target) <= workflow.phaseOrder.indexOf(phase.id)),
      signatures: active.map((approval) => ({
        actor: identityOf(approval.actor) || 'unknown', at: approval.at ?? null
      })),
      artifactPath: artifact,
      workId: workflow.workItem.id,
      reviewPacketSha256: packet,
      submittedSourceCommit: sourceCommit,
      afterApproval: afterApprovalText(snapshot, workflow, phase.id),
      heldBy: heldByDecisions(snapshot, phase.id),
      // An older CLI carries no sheet: its check, read as before.
      approvalHolds: snapshot.submissionReadiness?.phaseId === phase.id
        ? sheetHolds(snapshot.submissionReadiness.sheet) ?? approvalHolds(snapshot.submissionReadiness.approvalCheck) : [],
      decideNext: snapshot.submissionReadiness?.phaseId === phase.id && sheetNextIsTheList(snapshot.submissionReadiness.sheet)
    }],
    obstacles: [],
    empty: null
  };
}

/**
 * The open Initiative's approvals, by the engine's rule (src/initiative-approvals.mjs), which Needs you reads for every
 * Initiative in the workspace [FPL:REQ-008]. This page shows what it returns, nothing of its own.
 */
function approvalsOf(snapshot: RepositorySnapshot, initiative: InitiativeSnapshot): Approvals {
  const person = personOf(snapshot);
  const groupOf = (authority: string) => snapshot.workflow?.resolution?.approvalAuthorities?.[authority]
    ?? snapshot.definition?.approvalAuthorities?.[authority]
    ?? snapshot.portfolio?.approvalAuthorities?.[authority] ?? null;
  const read = initiativePendingApprovals(initiative, {
    person: { email: lower(snapshot.identities?.git?.email) || null, login: person.login }, groupOf
  });
  return { ...read, pending: read.pending.map(({ waitingSince: _waiting, couldNotTell: _tell, ...entry }) => entry as PendingApproval) };
}
