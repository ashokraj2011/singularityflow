/**
 * The lifecycle as a thing you can edit: profiles, the phases they run, the artifacts each phase
 * produces, and the templates those artifacts start from.
 *
 * The reason this is a screen rather than two YAML files is the consequence nobody can see from
 * inside the files. An Epic pins its whole resolution when it starts — the portfolio's hash and the
 * hash of every template it will use — and validates against those exact bytes for the rest of its
 * life. Editing a template an in-flight Epic pinned does not change that Epic. It stops it, with a
 * message about a hash, at whatever moment somebody next runs a phase.
 *
 * So every edit offered here is shown with the Epics it would stop. That is the whole point: the
 * files are editable already, and what they cannot tell you is who is standing on them.
 */
import type { RepositorySnapshot } from '../cli/snapshot.ts';

export interface ApprovalPolicy {
  mode?: string;
  authorities?: string[] | null;
  minimum?: number;
  allowSelfApproval?: boolean;
  chain?: Array<{ authority: string; label?: string; minimum?: number }> | null;
}

export interface PhaseOutput {
  id: string;
  label: string;
  kind?: string;
  path?: string;
  /** Null for an output the engine generates rather than one an author starts from a template. */
  template?: string | null;
  generator?: string | null;
  required?: boolean;
  approval?: ApprovalPolicy;
}

export interface Phase {
  id: string;
  label: string;
  /** Position in the profile being viewed, which is the only order that means anything. */
  order: number;
  outputs: PhaseOutput[];
  checklist: Array<{ id: string; label?: string; requirement?: string }>;
  bundleApproval?: ApprovalPolicy;
}

export interface Profile {
  id: string;
  label: string;
  phases: Phase[];
}

/** An Epic that pinned something an edit would change. */
export interface Standing {
  id: string;
  title: string;
  currentPhase: string | null;
}

export interface TemplateUsage {
  path: string;
  name: string;
  bytes?: number;
  /** Which profile phases start an artifact from this template. */
  usedBy: Array<{ profile: string; phase: string; output: string }>;
  /** Epics that pinned this template's bytes and would stop if it changed. */
  standing: Standing[];
}

interface InitiativeSummary {
  id: string;
  title?: string;
  status?: string;
  currentPhase?: string | null;
  pinnedTemplates?: Array<{ path: string; sha256: string | null }>;
}

/** Epics still running: a closed one has nothing left to stop. */
function inFlight(snapshot: RepositorySnapshot): InitiativeSummary[] {
  return ((snapshot.initiatives ?? []) as InitiativeSummary[])
    .filter((entry) => entry.status !== 'complete' && entry.status !== 'closed');
}

export function buildProfiles(snapshot: RepositorySnapshot): Profile[] {
  const portfolio = snapshot.portfolio as {
    initiativeProfiles?: Record<string, { label?: string; phases?: string[] }>;
    initiativePhases?: Record<string, {
      label?: string;
      outputs?: PhaseOutput[];
      checklist?: Array<{ id: string; label?: string; requirement?: string }>;
      bundleApproval?: ApprovalPolicy;
    }>;
  } | undefined;
  const phases = portfolio?.initiativePhases ?? {};

  return Object.entries(portfolio?.initiativeProfiles ?? {}).map(([id, profile]) => ({
    id,
    label: profile.label ?? id,
    phases: (profile.phases ?? []).map((phaseId, order) => {
      const phase = phases[phaseId];
      return {
        id: phaseId,
        label: phase?.label ?? phaseId,
        order,
        outputs: phase?.outputs ?? [],
        checklist: phase?.checklist ?? [],
        bundleApproval: phase?.bundleApproval
      };
    })
  }));
}

/**
 * Every template, with what uses it and who is standing on it.
 *
 * Templates with no user are worth seeing rather than hiding: a template nothing points at is
 * either about to be wired up or dead, and only a person can tell which.
 */
export function buildTemplateUsage(snapshot: RepositorySnapshot): TemplateUsage[] {
  const profiles = buildProfiles(snapshot);
  const running = inFlight(snapshot);

  const usage = new Map<string, TemplateUsage['usedBy']>();
  for (const profile of profiles) {
    for (const phase of profile.phases) {
      for (const output of phase.outputs) {
        if (!output.template) continue;
        // The portfolio names a template relative to the templates root; the files the snapshot
        // lists are repository-relative. Match on the tail, which is what both agree on.
        const key = output.template;
        const entry = usage.get(key) ?? [];
        entry.push({ profile: profile.id, phase: phase.id, output: output.id });
        usage.set(key, entry);
      }
    }
  }

  return (snapshot.templates ?? []).map((template) => {
    const used = [...usage.entries()]
      .filter(([declared]) => template.path.endsWith(declared))
      .flatMap(([, entries]) => entries);
    return {
      path: template.path,
      name: template.name,
      bytes: template.bytes,
      usedBy: used,
      standing: running
        .filter((initiative) => (initiative.pinnedTemplates ?? [])
          .some((pinned) => pinned.path === template.path))
        .map((initiative) => ({
          id: initiative.id,
          title: initiative.title ?? initiative.id,
          currentPhase: initiative.currentPhase ?? null
        }))
    };
  });
}

/**
 * The Epics an edit to this file would stop.
 *
 * Editing the portfolio stops every running Epic, because each pinned its hash; editing a template
 * stops only the Epics that pinned that template. Both are worth saying before the edit rather than
 * discovering at the next phase.
 */
export function standingOn(snapshot: RepositorySnapshot, file: string): Standing[] {
  const running = inFlight(snapshot);
  const portfolioPath = snapshot.portfolioPath ?? 'singularity/portfolio.yml';
  const affected = file === portfolioPath || file === (snapshot.definitionPath ?? 'singularity/workflow.yml')
    ? running
    : running.filter((initiative) => (initiative.pinnedTemplates ?? [])
      .some((pinned) => pinned.path === file));
  return affected.map((initiative) => ({
    id: initiative.id,
    title: initiative.title ?? initiative.id,
    currentPhase: initiative.currentPhase ?? null
  }));
}

/** How an edit to this file lands, in one sentence, for the person about to make it. */
export function consequence(standing: Standing[], file: string): string {
  if (!standing.length) {
    return `No Epic has pinned ${file}, so editing it changes what the next Epic starts from and nothing else.`;
  }
  const names = standing.map((entry) => entry.id).join(', ');
  return `${standing.length} running ${standing.length === 1 ? 'Epic' : 'Epics'} pinned ${file} `
    + `(${names}). Editing it does not change ${standing.length === 1 ? 'that Epic' : 'those Epics'} — `
    + `${standing.length === 1 ? 'it stops it' : 'it stops them'} at the next phase, with a message about a hash.`;
}
