/**
 * The Spec Studio's logic, with no VS Code API (SPEC-SPA v1.3 §3, milestone S3).
 *
 * Every read and write is a `spec author … --json` command; this module builds those command lines,
 * reads the engine's answers defensively, and turns them into the library, steps and editor the page renders.
 * Nothing here calls a model: the authoring loop's seven steps all work by hand. Copilot's proposals
 * and assisted findings (S4) arrive through the engine like everything else, and only the person's
 * own clicks accept, reject or settle them.
 */

export const SPEC_STUDIO_STEPS = [
  { id: 'elicit', label: 'Overview', detail: 'Purpose and scope' },
  { id: 'research', label: 'Research', detail: 'Cited facts the specification relies on' },
  { id: 'draft', label: 'Write', detail: 'Requirements and acceptance criteria' },
  { id: 'gaps', label: 'Review gaps', detail: 'A person decides each one' },
  { id: 'check', label: 'Check quality', detail: 'Checks, review and open decisions' },
  { id: 'publish', label: 'Publish', detail: 'An immutable revision on the state branch' },
  { id: 'attach', label: 'Use in a Story', detail: 'Attach, split and track coverage' }
] as const;
export type SpecStudioStep = typeof SPEC_STUDIO_STEPS[number]['id'];
export const STEP_IDS: readonly SpecStudioStep[] = SPEC_STUDIO_STEPS.map((step) => step.id);

export const GAP_KINDS = ['code-disagrees', 'missing-unwanted-path', 'vague-term', 'missing-boundary', 'open-question'] as const;
export const CHECKLIST_DECISIONS = ['satisfied', 'exception', 'not-applicable'] as const;
export const FINDING_OUTCOMES = ['gap', 'fixed', 'dismissed'] as const;
export type FindingOutcome = typeof FINDING_OUTCOMES[number];
const PROPOSAL_ID = /^P-\d{3,}$/u;
const FINDING_ID = /^A-\d{3,}$/u;
export const MAXIMUM_OPTIONS = 4;
const SPEC_ID = /^SPEC-[A-Z0-9]+(?:-[A-Z0-9]+)*$/u;
const CLAUSE_ANCHOR = /\[([A-Z0-9][A-Z0-9._-]*):((?:REQ|BEH|IFC|AC|CON)-\d{3,})\]/gu;
const RESEARCH_MENTION = /\bR-\d{3,}\b/gu;

export interface SpecPerson { name: string | null; email: string | null }
export interface SpecBasedOn { revision: number; manifestSha256: string; reviewState: string }
export interface SpecGapOption { id: string; wording: string; changesCode: boolean }
export interface SpecGap {
  id: string; kind: string; status: 'open' | 'decided' | 'deferred'; question: string;
  evidence: string[]; clauses: string[]; options: SpecGapOption[];
  decision: { option: string | null; choice: string; reason: string; by: SpecPerson | null; at: string } | null;
  deferral: { owner: string; reason: string; by: SpecPerson | null; at: string } | null;
}
export interface SpecResearchItem {
  id: string; basis: string; kind: string; summary: string; source?: string | null;
  citation?: { path: string; lines: [number, number]; spanSha256?: string } | null;
  standing: string | null; staleReason: string | null;
}
export interface SpecFinding { part: 'D' | 'A' | 'H'; code: string; message: string; rule?: string; gap?: string; article?: string; item?: string }
export interface SpecRule { id: string; label: string; passed: boolean; findings: Array<{ code: string; message: string }> }
export interface SpecCounts { d: { passed: number; total: number }; a: { status: string; pending: number }; h: { open: number; deferred: number } }
/** What Copilot staged and a person has not taken or turned down yet. */
export interface SpecProposal {
  id: string; kind: 'edit' | 'research' | 'gap'; summary: string | null; notes: string[]; basisSequence: number; proposedBy: SpecPerson | null;
  spec?: string; stale?: boolean;
  citation?: { path: string; lines: [number, number] } | null; verified?: boolean;
  gapKind?: string; question?: string; evidence?: string[]; clauses?: string[]; options?: Array<{ id: string; wording: string; changesCode: boolean }>;
}
/** An assisted (A) checklist finding: pending until the person settles it. */
export interface SpecAssistedFinding { id: string; article: string; message: string; clauses: string[]; status: 'pending' | FindingOutcome; reason: string | null; gap: string | null }
export interface SpecStatus {
  specId: string; sequence: number; title: string; basedOn: SpecBasedOn | null; gaps: SpecGap[]; counts: SpecCounts;
  blocking: SpecFinding[]; reviewReady: boolean; next: string; spec: string; areas: string[]; researchItems: SpecResearchItem[];
  rules: SpecRule[]; articles: Array<{ article: string; decision: string | null; reason: string | null }>; clauseIds: string[];
  damagedSnapshots: number; proposals: SpecProposal[]; findings: SpecAssistedFinding[];
}
export interface SpecLibraryEntry { specId: string; revisions: number[]; latest: { revision: number; reviewState: string; title: string } }
export interface SpecLibrary {
  status: string; commit: string | null; specs: SpecLibraryEntry[];
  drafts: Array<{ specId: string; sequence: number; title: string | null; basedOn: SpecBasedOn | null }>;
}
export interface SpecRevision {
  specId: string; revision: number; commit: string; manifestSha256: string; spec: string;
  manifest: { title?: string; reviewState?: string; recordedAt?: string; publishedBy?: SpecPerson | null; [key: string]: unknown };
  gaps: number; research: number;
}
export interface SpecGapImpact { gap: string; options: Array<{ id: string; changesCode: boolean; records: string[] }> }
export interface SpecAllocation { kind: 'child' | 'story'; label: string }
export interface SpecCoverageRow { clause: string; status: string; deliveredBy: string[]; claimedBy: string[]; allocatedTo: SpecAllocation[]; leftOut: string | null }
export interface SpecCoverageChild { specId: string; title: string; split: number; fromRevision: number; status: string; changed: string[] }
export interface SpecCoverage { specId: string; revision: number; stateCommit: string | null; rows: SpecCoverageRow[]; children: SpecCoverageChild[]; unreadable: string[] }

/** What a person opened: a specification (optionally one revision, a Story's clauses) at a step. */
export interface SpecStudioTarget { specId: string | null; revision: number | null; clauses: string[] | null; step: SpecStudioStep | null }

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const strings = (value: unknown): string[] => list(value).filter((entry): entry is string => typeof entry === 'string');
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const person = (value: unknown): SpecPerson | null => {
  const entry = record(value);
  return value ? { name: typeof entry.name === 'string' ? entry.name : null, email: typeof entry.email === 'string' ? entry.email : null } : null;
};
const answer = (raw: unknown, action: string): Record<string, unknown> | null => {
  const result = record(raw);
  return result.resultType === 'sflow-spec-author' && result.action === action ? result : null;
};

export const validSpecId = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && SPEC_ID.test(value);

/** `{ specId, revision, clauses, step }`, `'SPEC-ID'` or `'SPEC-ID@N'`; anything else opens the library. */
export function specStudioTarget(raw: unknown): SpecStudioTarget {
  const empty: SpecStudioTarget = { specId: null, revision: null, clauses: null, step: null };
  if (typeof raw === 'string') {
    const [specId, revision] = raw.split('@');
    return validSpecId(specId) ? { ...empty, specId, revision: /^[1-9]\d{0,5}$/u.test(revision ?? '') ? Number(revision) : null } : empty;
  }
  const value = record(raw);
  const reference = typeof value.revision === 'string' ? specStudioTarget(value.revision) : null;
  const specId = validSpecId(value.specId) ? value.specId : reference?.specId ?? null;
  if (!specId) return empty;
  const revision = typeof value.revision === 'number' && Number.isInteger(value.revision) && value.revision > 0 ? value.revision : reference?.revision ?? null;
  const step = STEP_IDS.includes(value.step as SpecStudioStep) ? value.step as SpecStudioStep : null;
  const clauses = Array.isArray(value.clauses) ? strings(value.clauses).map((clause) => qualifiedClause(specId, clause.replace(/^\[|\]$/gu, ''))) : null;
  return { specId, revision, clauses, step };
}

// ---- Command lines -------------------------------------------------------------------------

const author = (...args: string[]): string[] => ['spec', 'author', ...args, '--json'];
export const libraryArgv = (): string[] => author('list');
export const statusArgv = (specId: string): string[] => author('status', specId);
/** Without a revision, the highest reviewed one: only a reviewed revision can be attached. */
export const showArgv = (specId: string, revision: number | null): string[] => author('show', revision ? `${specId}@${revision}` : specId);
export const gapImpactArgv = (specId: string, gap: string): string[] => author('gaps', specId, gap);
export const coverageArgv = (specId: string, revision: number): string[] => author('coverage', `${specId}@${revision}`);

export function newArgv(specId: string | null, { title, intent, areas = [], revise = false }: { title?: string; intent?: string; areas?: string[]; revise?: boolean }, operationId: string): string[] {
  return author('new', ...(specId ? [specId] : []), ...(revise ? ['--revise'] : []), ...(title ? ['--title', title] : []), ...(intent ? ['--intent', intent] : []),
    ...areas.flatMap((area) => ['--area', area]), '--operation-id', operationId);
}
export const editArgv = (specId: string, file: string, sequence: number, operationId: string): string[] =>
  author('edit', specId, '--file', file, '--expected-seq', String(sequence), '--operation-id', operationId);
export function researchArgv(specId: string, { paths = [], refresh = false }: { paths?: string[]; refresh?: boolean }, operationId: string): string[] {
  return author('research', specId, ...paths.flatMap((entry) => ['--path', entry]), ...(refresh ? ['--refresh'] : []), '--operation-id', operationId);
}
export const factArgv = (specId: string, fact: string, source: string, operationId: string): string[] =>
  author('research', specId, '--fact', fact, '--source', source, '--operation-id', operationId);
export const removeResearchArgv = (specId: string, item: string, operationId: string): string[] =>
  author('research', specId, '--remove', item, '--operation-id', operationId);
export function gapArgv(specId: string, gap: { kind: string; question: string; evidence: string[]; clauses: string[] }, optionsFile: string | null, operationId: string): string[] {
  return author('gap', specId, '--kind', gap.kind, '--question', gap.question, ...(gap.evidence.length ? ['--research', gap.evidence.join(',')] : []),
    ...gap.clauses.flatMap((clause) => ['--clause', clause]), ...(optionsFile ? ['--options', optionsFile] : []), '--operation-id', operationId);
}
export type GapDecision = { option: string } | { defer: true; owner: string } | { reopen: true };
export function decideArgv(specId: string, gap: string, decision: GapDecision, reason: string, operationId: string): string[] {
  const choice = 'option' in decision ? ['--option', decision.option] : 'defer' in decision ? ['--defer', '--owner', decision.owner] : ['--reopen'];
  return author('decide', specId, gap, ...choice, '--reason', reason, '--operation-id', operationId);
}
export function settleArgv(specId: string, decisions: Record<string, string>, reason: string | null, operationId: string): string[] {
  return author('settle', specId, ...Object.entries(decisions).sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([article, decision]) => ['--article', `${article}=${decision}`]), ...(reason ? ['--reason', reason] : []), '--operation-id', operationId);
}
/**
 * No `--operation-id`: the engine derives publication's own from the draft head and the state, so a
 * retry after a lost acknowledgement is the same publication, never a second revision.
 */
export const publishArgv = (specId: string, state: 'reviewed' | 'draft'): string[] => author('publish', specId, `--${state}`);
export const discardArgv = (specId: string): string[] => author('discard', specId);
export function acceptArgv(specId: string, proposals: string[], editedFile: string | null, operationId: string): string[] {
  return author('accept', specId, ...proposals, ...(editedFile ? ['--edit', editedFile] : []), '--operation-id', operationId);
}
export const rejectArgv = (specId: string, proposals: string[], reason: string, operationId: string): string[] =>
  author('reject', specId, ...proposals, '--reason', reason, '--operation-id', operationId);
export function settleFindingsArgv(specId: string, outcomes: Record<string, FindingOutcome>, reason: string | null, operationId: string): string[] {
  return author('settle', specId, ...Object.entries(outcomes).sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([finding, outcome]) => ['--finding', `${finding}=${outcome}`]), ...(reason ? ['--reason', reason] : []), '--operation-id', operationId);
}
export const proposeArgv = (specId: string, file: string): string[] => author('propose', specId, '--file', file);

/** The proposals a person ticked, in ID order, each one still waiting. */
export function proposalSelection(message: Record<string, unknown>, status: SpecStatus): string[] {
  const waiting = new Set(status.proposals.map((proposal) => proposal.id));
  return [...new Set(strings(message.proposals).filter((id) => PROPOSAL_ID.test(id) && waiting.has(id)))].sort();
}

/** `finding:A-001` fields set to an outcome; a dismissal needs the reason. */
export function findingsRequest(message: Record<string, unknown>, status: SpecStatus): { outcomes: Record<string, FindingOutcome>; reason: string | null; errors: string[] } {
  const outcomes: Record<string, FindingOutcome> = {};
  const pending = new Set(status.findings.filter((finding) => finding.status === 'pending').map((finding) => finding.id));
  for (const [key, value] of Object.entries(message)) {
    const id = key.startsWith('finding:') ? key.slice('finding:'.length) : '';
    if (FINDING_ID.test(id) && pending.has(id) && FINDING_OUTCOMES.includes(value as FindingOutcome)) outcomes[id] = value as FindingOutcome;
  }
  const reason = text(message.reason).trim() || null;
  const errors = !Object.keys(outcomes).length ? ['Choose how to settle at least one finding.']
    : Object.values(outcomes).includes('dismissed') && !reason ? ['Dismissing a finding needs your reason.'] : [];
  return { outcomes, reason, errors };
}

/** What a person types into Copilot Chat to have this specification drafted with the Studio's tool. */
export const copilotPrompt = (specId: string, tool: boolean): string => `/sf-spec-author ${specId} ${tool ? '#sflowSpecStudio ' : ''}`;

// ---- Engine answers ------------------------------------------------------------------------

export function libraryFrom(raw: unknown): SpecLibrary | null {
  const result = answer(raw, 'list');
  if (!result) return null;
  const state = record(result.state);
  return {
    status: text(state.status), commit: typeof state.commit === 'string' ? state.commit : null,
    specs: list(result.specs).map(record).filter((entry) => validSpecId(entry.specId)).map((entry) => {
      const latest = record(entry.latest);
      return { specId: entry.specId as string, revisions: list(entry.revisions).filter((value): value is number => typeof value === 'number'),
        latest: { revision: count(latest.revision), reviewState: text(latest.reviewState), title: text(latest.title) } };
    }),
    drafts: list(result.drafts).map(record).filter((entry) => validSpecId(entry.specId)).map((entry) => ({
      specId: entry.specId as string, sequence: count(entry.sequence), title: typeof entry.title === 'string' ? entry.title : null, basedOn: basedOn(entry.basedOn)
    }))
  };
}

function basedOn(value: unknown): SpecBasedOn | null {
  const entry = record(value);
  return typeof entry.revision === 'number' ? { revision: entry.revision, manifestSha256: text(entry.manifestSha256), reviewState: text(entry.reviewState) } : null;
}

function gapFrom(value: unknown): SpecGap {
  const entry = record(value);
  const decision = record(entry.decision);
  const deferral = record(entry.deferral);
  const status = ['open', 'decided', 'deferred'].includes(text(entry.status)) ? text(entry.status) as SpecGap['status'] : 'open';
  return {
    id: text(entry.id), kind: text(entry.kind), status, question: text(entry.question), evidence: strings(entry.evidence), clauses: strings(entry.clauses),
    options: list(entry.options).map(record).map((option) => ({ id: text(option.id), wording: text(option.wording), changesCode: option.changesCode !== false })),
    decision: entry.decision ? { option: typeof decision.option === 'string' ? decision.option : null, choice: text(decision.choice), reason: text(decision.reason), by: person(decision.by), at: text(decision.at) } : null,
    deferral: entry.deferral ? { owner: text(deferral.owner), reason: text(deferral.reason), by: person(deferral.by), at: text(deferral.at) } : null
  };
}

export function statusFrom(raw: unknown): SpecStatus | null {
  const result = answer(raw, 'status');
  if (!result || !validSpecId(result.specId) || typeof result.spec !== 'string') return null;
  const counts = record(result.counts);
  const d = record(counts.d); const a = record(counts.a); const h = record(counts.h);
  return {
    specId: result.specId, sequence: count(result.sequence), title: text(result.title), basedOn: basedOn(result.basedOn),
    gaps: list(result.gaps).map(gapFrom),
    counts: { d: { passed: count(d.passed), total: count(d.total) }, a: { status: text(a.status) || 'not-run', pending: count(a.pending) }, h: { open: count(h.open), deferred: count(h.deferred) } },
    blocking: list(result.blocking).map(record).map((entry) => ({ ...entry, part: (['D', 'A', 'H'].includes(text(entry.part)) ? entry.part : 'D') as SpecFinding['part'], code: text(entry.code), message: text(entry.message) })),
    reviewReady: result.reviewReady === true, next: text(result.next), spec: result.spec, areas: strings(result.areas),
    researchItems: list(result.researchItems).map(record).map((entry) => {
      const citation = record(entry.citation);
      const lines = list(citation.lines).filter((value): value is number => typeof value === 'number');
      return { id: text(entry.id), basis: text(entry.basis), kind: text(entry.kind), summary: text(entry.summary), source: typeof entry.source === 'string' ? entry.source : null,
        citation: typeof citation.path === 'string' && lines.length === 2 ? { path: citation.path, lines: [lines[0]!, lines[1]!], spanSha256: text(citation.spanSha256) } : null,
        standing: typeof entry.standing === 'string' ? entry.standing : null, staleReason: typeof entry.staleReason === 'string' ? entry.staleReason : null };
    }),
    rules: list(result.rules).map(record).map((entry) => ({ id: text(entry.id), label: text(entry.label), passed: entry.passed === true,
      findings: list(entry.findings).map(record).map((finding) => ({ code: text(finding.code), message: text(finding.message) })) })),
    articles: list(result.articles).map(record).map((entry) => ({ article: text(entry.article), decision: typeof entry.decision === 'string' ? entry.decision : null, reason: typeof entry.reason === 'string' ? entry.reason : null })),
    clauseIds: strings(result.clauseIds), damagedSnapshots: count(result.damagedSnapshots),
    proposals: list(result.proposals).map(proposalFrom).filter((entry): entry is SpecProposal => entry !== null),
    findings: list(result.findings).map(record).filter((entry) => FINDING_ID.test(text(entry.id))).map((entry) => ({
      id: text(entry.id), article: text(entry.article), message: text(entry.message), clauses: strings(entry.clauses),
      status: (['pending', ...FINDING_OUTCOMES] as string[]).includes(text(entry.status)) ? text(entry.status) as SpecAssistedFinding['status'] : 'pending',
      reason: typeof entry.reason === 'string' ? entry.reason : null, gap: typeof entry.gap === 'string' ? entry.gap : null
    }))
  };
}

function proposalFrom(value: unknown): SpecProposal | null {
  const entry = record(value);
  const kind = text(entry.kind);
  if (!PROPOSAL_ID.test(text(entry.id)) || !['edit', 'research', 'gap'].includes(kind)) return null;
  const citation = record(entry.citation);
  const lines = list(citation.lines).filter((line): line is number => typeof line === 'number');
  return {
    id: text(entry.id), kind: kind as SpecProposal['kind'], summary: typeof entry.summary === 'string' ? entry.summary : null, notes: strings(entry.notes),
    basisSequence: count(record(entry.basis).sequence), proposedBy: person(entry.proposedBy),
    ...(kind === 'edit' ? { spec: text(entry.spec), stale: entry.stale === true } : {}),
    ...(kind === 'research' ? { citation: typeof citation.path === 'string' && lines.length === 2 ? { path: citation.path, lines: [lines[0]!, lines[1]!] } : null, verified: entry.verified === true } : {}),
    ...(kind === 'gap' ? { gapKind: text(entry.gapKind), question: text(entry.question), evidence: strings(entry.evidence), clauses: strings(entry.clauses),
      options: list(entry.options).map(record).map((option) => ({ id: text(option.id), wording: text(option.wording), changesCode: option.changesCode !== false })) } : {})
  };
}

export function revisionFrom(raw: unknown): SpecRevision | null {
  const result = answer(raw, 'show');
  if (!result || !validSpecId(result.specId) || typeof result.spec !== 'string' || typeof result.revision !== 'number') return null;
  const manifest = record(result.manifest);
  return { specId: result.specId, revision: result.revision, commit: text(result.commit), manifestSha256: text(result.manifestSha256), spec: result.spec,
    manifest: { ...manifest, publishedBy: person(manifest.publishedBy) }, gaps: list(result.gaps).length, research: list(result.research).length };
}

export function impactFrom(raw: unknown, gapId: string): SpecGapImpact | null {
  const result = answer(raw, 'gaps');
  const gap = result ? list(result.gaps).map(record).find((entry) => entry.id === gapId) : null;
  if (!gap) return null;
  return { gap: gapId, options: list(record(gap.impact).options).map(record).map((option) => ({ id: text(option.id), changesCode: option.changesCode !== false,
    records: list(option.records).map(record).map((entry) => text(entry.text)).filter(Boolean) })) };
}

export function coverageFrom(raw: unknown): SpecCoverage | null {
  const result = answer(raw, 'coverage');
  if (!result || !validSpecId(result.specId) || typeof result.revision !== 'number') return null;
  return { specId: result.specId, revision: result.revision, stateCommit: typeof result.stateCommit === 'string' ? result.stateCommit : null,
    rows: list(result.clauses).map(record).map((entry) => ({ clause: text(entry.clause), status: text(entry.status), deliveredBy: strings(entry.deliveredBy), claimedBy: strings(entry.claimedBy),
      allocatedTo: list(entry.allocatedTo).map(record).map((to): SpecAllocation => (to.kind === 'child'
        ? { kind: 'child', label: `child ${text(to.specId)}` } : { kind: 'story', label: `slice ${text(to.key)}${to.title ? ` (${text(to.title)})` : ''}` })),
      leftOut: typeof entry.leftOut === 'string' ? entry.leftOut : null })),
    // A child of a split whose parent clause changed in this revision is "parent-moved" (SPEC-SPA v1.3 §7, S5).
    children: list(result.children).map(record).map((entry) => ({ specId: text(entry.specId), title: text(entry.title), split: count(entry.split),
      fromRevision: count(entry.fromRevision), status: text(entry.status), changed: strings(entry.changed) })),
    unreadable: strings(result.unreadable) };
}

/** The closed code of a structured refusal (`error.code` in its --json result), or null. */
export const refusalCode = (error: unknown): string | null => text(record(record(record(error).result).error).code) || null;

/** The engine's refusal and the command it names to recover, from a CLI error's structured result. */
export function refusalFrom(error: unknown): { message: string; next: string | null } {
  const failure = record(record(record(error).result).error);
  const details = record(failure.details);
  const plan = list(record(record(record(error).result).remediationPlan).steps).map(record).find((step) => typeof step.command === 'string');
  const message = text(failure.message) || (error instanceof Error ? error.message.split('\nNext:')[0]!.trim() : String(error));
  const next = typeof details.nextAction === 'string' ? details.nextAction : typeof plan?.command === 'string' ? plan.command : null;
  return { message, next };
}

// ---- The specification text ----------------------------------------------------------------

export const qualifiedClause = (specId: string, clause: string): string => (clause.includes(':') ? clause : `${specId}:${clause}`);
export const shortClause = (specId: string, clause: string): string => (clause.startsWith(`${specId}:`) ? clause.slice(specId.length + 1) : clause);

/** Every clause written in the specification's own namespace, in order. */
export function specClauses(markdown: string, specId: string): Array<{ id: string; line: number; text: string }> {
  const found: Array<{ id: string; line: number; text: string }> = [];
  const seen = new Set<string>();
  markdown.split(/\r?\n/u).forEach((line, index) => {
    for (const match of line.matchAll(CLAUSE_ANCHOR)) {
      const id = `${match[1]}:${match[2]}`;
      if (match[1] !== specId || seen.has(id)) continue;
      seen.add(id);
      found.push({ id, line: index + 1, text: line.replace(CLAUSE_ANCHOR, '').trim() });
    }
  });
  return found;
}

export interface SpecBlock {
  kind: 'heading' | 'clause' | 'text';
  level: number;
  text: string;
  clauses: string[];
  flags: Array<{ gap: string; kind: string }>;
  research: string[];
  inSlice: boolean;
}

/**
 * The right column: `spec.md` as headings, clauses and prose, each clause flagged by the open gaps
 * that name it and marked when it is in the Story slice the Studio was opened for.
 */
export function specBlocks(markdown: string, specId: string, gaps: readonly SpecGap[] = [], slice: readonly string[] | null = null): SpecBlock[] {
  const flags = new Map<string, Array<{ gap: string; kind: string }>>();
  for (const gap of gaps.filter((entry) => entry.status === 'open')) {
    for (const clause of gap.clauses) {
      const id = qualifiedClause(specId, clause);
      flags.set(id, [...(flags.get(id) ?? []), { gap: gap.id, kind: gap.kind }]);
    }
  }
  const blocks: SpecBlock[] = [];
  let fenced = false;
  for (const line of markdown.split(/\r?\n/u)) {
    if (/^\s*(```|~~~)/u.test(line)) fenced = !fenced;
    if (!line.trim()) continue;
    const heading = !fenced && /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    const research = [...new Set(line.match(RESEARCH_MENTION) ?? [])];
    if (heading) { blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]!, clauses: [], flags: [], research: [], inSlice: false }); continue; }
    const clauses = [...line.matchAll(CLAUSE_ANCHOR)].filter((match) => match[1] === specId).map((match) => `${match[1]}:${match[2]}`);
    blocks.push({ kind: clauses.length ? 'clause' : 'text', level: 0, text: line, clauses, research,
      flags: clauses.flatMap((clause) => flags.get(clause) ?? []), inSlice: Boolean(slice && clauses.some((clause) => slice.includes(clause))) });
  }
  return blocks;
}

/** The text of one `##` section, for the elicit stage's intent. */
export function sectionText(markdown: string, title: string): string | null {
  const kept: string[] = [];
  let level = 0;
  for (const line of markdown.split(/\r?\n/u)) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (match) {
      if (level && match[1]!.length <= level) break;
      if (!level && match[2]!.trim().toLowerCase() === title.toLowerCase()) { level = match[1]!.length; continue; }
    }
    if (level) kept.push(line);
  }
  return level ? kept.join('\n').trim() : null;
}

// ---- Commands a person runs elsewhere ------------------------------------------------------

/** `--spec SPEC-ID@N[=REQ-001,…]`: every clause when all are chosen, as Story start reads it. */
export function sliceOption(specId: string, revision: number, chosen: readonly string[], all: readonly string[]): string {
  const every = all.length > 0 && all.every((clause) => chosen.includes(clause));
  return `--spec ${specId}@${revision}${every ? '' : `=${all.filter((clause) => chosen.includes(clause)).map((clause) => shortClause(specId, clause)).join(',')}`}`;
}

export function startCommand(slice: string): string {
  return `singularity-flow start <WORK-ID> --from-branch <BRANCH> --title "<TITLE>" ${slice}`;
}

/** The revision a publication will create: the next after the highest this clone can see. */
export function nextRevision(library: SpecLibrary | null, status: SpecStatus): number {
  const known = library?.specs.find((entry) => entry.specId === status.specId)?.revisions ?? [];
  return Math.max(0, status.basedOn?.revision ?? 0, ...known) + 1;
}

export function publishConfirmation(status: SpecStatus, revision: number, state: 'reviewed' | 'draft') {
  const name = `${status.specId}@${revision}`;
  const open = status.blocking.map((finding) => `  ${finding.part} ${finding.message}`);
  return {
    title: `Publish ${name}`,
    summary: `${status.title}: one immutable ${state} revision on the state branch, signed with your Git identity.`,
    detail: [`singularity-flow ${publishArgv(status.specId, state).filter((part) => part !== '--json').join(' ')}`, '',
      `Revision: ${name} (${state})`, `From draft snapshot ${status.sequence}${status.basedOn ? `, based on @${status.basedOn.revision}` : ''}`,
      `Files: spec.md, gaps.json, research.json, quality.json and manifest.json`,
      ...(state === 'draft' && open.length ? ['', 'Still open, so it is published as a draft revision a Story cannot attach:', ...open] : [])].join('\n'),
    confirmLabel: `Publish ${name}`
  };
}

export function discardConfirmation(status: SpecStatus) {
  return {
    title: `Discard the draft of ${status.specId}`,
    summary: `Removes ${status.specId}'s draft on this clone: ${status.sequence} snapshot(s). Published revisions are unchanged.`,
    detail: `singularity-flow spec author discard ${status.specId}\n\nThe draft's prose, research, gaps and checklist decisions on this clone are removed.`,
    confirmLabel: 'Discard the draft', expected: status.specId
  };
}

// ---- Form input from the page --------------------------------------------------------------

export interface GapRequest { kind: string; question: string; evidence: string[]; clauses: string[]; options: SpecGapOption[] }

/** The page's "Open a gap" form, checked as the engine will check it, so a refusal is rare. */
export function gapRequest(raw: unknown, status: SpecStatus): { request: GapRequest | null; errors: string[] } {
  const value = record(raw);
  const errors: string[] = [];
  const kind = text(value.kind);
  const question = text(value.question).trim();
  if (!(GAP_KINDS as readonly string[]).includes(kind)) errors.push('Choose what kind of gap this is.');
  if (!question) errors.push('Write the question the gap asks.');
  const known = new Set(status.researchItems.map((item) => item.id));
  const evidence = strings(value.evidence).filter((id) => known.has(id));
  const clauses = strings(value.clauses).filter((clause) => status.clauseIds.includes(clause) || specClauses(status.spec, status.specId).some((entry) => entry.id === clause));
  const options = list(value.options).map(record).map((option) => ({ wording: text(option.wording).trim(), changesCode: option.changesCode === true }))
    .filter((option) => option.wording).slice(0, MAXIMUM_OPTIONS).map((option, index) => ({ id: `O${index + 1}`, ...option }));
  return { request: errors.length ? null : { kind, question, evidence, clauses, options }, errors };
}

/** The checklist form: only real articles and decisions, and the reason an exception needs. */
export function settleRequest(raw: unknown, status: SpecStatus): { decisions: Record<string, string>; reason: string | null; errors: string[] } {
  const value = record(raw);
  const known = new Set(status.articles.map((entry) => entry.article));
  const decisions = Object.fromEntries(Object.entries(record(value.decisions))
    .filter(([article, decision]) => known.has(article) && (CHECKLIST_DECISIONS as readonly string[]).includes(String(decision))) as Array<[string, string]>);
  const reason = text(value.reason).trim() || null;
  const errors = !Object.keys(decisions).length ? ['Choose a decision for at least one article.']
    : Object.values(decisions).some((decision) => decision !== 'satisfied') && !reason ? ['An exception or not-applicable decision needs the reason.'] : [];
  return { decisions, reason, errors };
}

// ---- The left column -----------------------------------------------------------------------

/** Gaps open first, then deferred, then decided; each in ID order. */
export function gapPipeline(gaps: readonly SpecGap[]): SpecGap[] {
  const rank = { open: 0, deferred: 1, decided: 2 } as const;
  return [...gaps].sort((left, right) => rank[left.status] - rank[right.status] || left.id.localeCompare(right.id, 'en', { numeric: true }));
}

/** One line per governed record of the draft, as the revision directory will hold it. */
export function draftRecords(status: SpecStatus): Array<{ file: string; step: SpecStudioStep; detail: string }> {
  const stale = status.researchItems.filter((item) => item.standing === 'stale' || item.standing === 'uncited').length;
  const open = status.gaps.filter((gap) => gap.status === 'open').length;
  return [
    { file: 'spec.md', step: 'draft', detail: `${specClauses(status.spec, status.specId).length} clause(s), snapshot ${status.sequence}` },
    { file: 'research.json', step: 'research', detail: `${status.researchItems.length} item(s)${stale ? `, ${stale} need attention` : ''}` },
    { file: 'gaps.json', step: 'gaps', detail: `${status.gaps.length} gap(s), ${open} open` },
    { file: 'quality.json', step: 'check', detail: status.reviewReady ? 'ready to publish as reviewed' : `${status.blocking.length} finding(s) block a reviewed publication` }
  ];
}

/** What each step shows beside its name: done, waiting, or nothing to say yet. */
export function stepStates(status: SpecStatus | null): Record<SpecStudioStep, { state: 'done' | 'open' | 'idle'; note: string }> {
  const idle = { state: 'idle' as const, note: '' };
  if (!status) return Object.fromEntries(STEP_IDS.map((step) => [step, idle])) as Record<SpecStudioStep, typeof idle>;
  const open = status.gaps.filter((gap) => gap.status === 'open').length;
  const stale = status.researchItems.filter((item) => item.standing === 'stale' || item.standing === 'uncited').length;
  const placeholders = status.rules.find((rule) => rule.id === 'placeholders');
  return {
    elicit: { state: 'done', note: status.areas.length ? status.areas.join(', ') : 'Code scope optional' },
    research: { state: stale ? 'open' : status.researchItems.length ? 'done' : 'idle', note: stale ? `${stale} need attention` : `${status.researchItems.length} item(s)` },
    draft: { state: placeholders && !placeholders.passed ? 'open' : 'done', note: `snapshot ${status.sequence}` },
    gaps: { state: open ? 'open' : 'done', note: open ? `${open} open` : `${status.gaps.length} closed` },
    check: { state: status.reviewReady ? 'done' : 'open', note: `${status.counts.d.passed}/${status.counts.d.total} checks · ${status.counts.h.open} open decisions` },
    publish: { state: status.basedOn ? 'done' : 'idle', note: status.basedOn ? `@${status.basedOn.revision} ${status.basedOn.reviewState}` : 'not yet published' },
    attach: { state: status.basedOn?.reviewState === 'reviewed' ? 'open' : 'idle', note: status.basedOn?.reviewState === 'reviewed' ? `@${status.basedOn.revision} can be attached` : 'needs a reviewed revision' }
  };
}

export function gateLine(counts: SpecCounts): string {
  return `D ${counts.d.passed}/${counts.d.total} rules passed · A ${counts.a.status === 'not-run' ? 'not run' : `${counts.a.pending} pending`} · H ${counts.h.open} open${counts.h.deferred ? `, ${counts.h.deferred} deferred` : ''}`;
}
