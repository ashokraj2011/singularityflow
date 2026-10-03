/**
 * The Story evidence matrix as the VS Code Evidence Matrix panel shows it [E2G-029].
 *
 * Pure: it reads the JSON `singularity-flow evidence matrix --json` returned and decides nothing
 * itself. The completion label, lifecycle words and every result are the engine's own; this module
 * only shapes them into rows, cells and a per-row drawer, so the panel can never say more than the
 * matrix did.
 */

export type EvidenceObligation = {
  readonly id: string;
  readonly responsibility: string;
  readonly status: string;
  readonly owningSteps: readonly string[];
  readonly facets: Readonly<Record<string, string>>;
};

/** Why a responsibility the route omits does not apply: the declared reason and the recorded decision. */
export type EvidenceApplicability = {
  readonly authority: string;
  readonly declaredReason: string | null;
  readonly satisfied: boolean;
  readonly decision: { readonly reason: string; readonly actor: string | null; readonly at: string | null } | null;
};

export type EvidenceRow = {
  readonly id: string;
  readonly type: string;
  readonly result: string;
  readonly assurance: string | null;
  readonly source: string | null;
  readonly obligations: readonly EvidenceObligation[];
  readonly findings: readonly string[];
  readonly actions: readonly string[];
  readonly applicability: EvidenceApplicability | null;
  /** For a scope inventory row: the requirement statement and its disposition, as the engine read them. */
  readonly statement: { readonly text: string; readonly disposition: string; readonly coveredBy: string | null } | null;
};

/**
 * The accepted scope in the engine's three separate states [E2G-007]: whether every identified
 * statement has a disposition, whether a person reviewed exactly this inventory, and correctness,
 * which is never claimed.
 */
export type EvidenceScope = {
  readonly structurallyComplete: boolean;
  readonly completenessReviewed: boolean;
  readonly structure: string;
  readonly review: string;
  readonly correctness: string;
};

export type EvidenceView = {
  readonly workId: string;
  readonly title: string | null;
  readonly lifecycle: string;
  readonly completion: string;
  readonly reasons: readonly string[];
  readonly counts: readonly { readonly result: string; readonly count: number }[];
  readonly assuranceFloor: string | null;
  readonly requiredAssurance: string | null;
  readonly scope: EvidenceScope | null;
  readonly rows: readonly EvidenceRow[];
  readonly total: number;
  readonly unreadable: readonly string[];
};

const RESPONSIBILITY_ORDER = ['scope', 'plan', 'implement', 'verify', 'review'];

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function list<T>(value: unknown, map: (entry: any) => T | null): T[] {
  return Array.isArray(value) ? value.map(map).filter((entry): entry is T => entry != null) : [];
}

function applicabilityOf(value: any): EvidenceApplicability | null {
  if (!value || typeof value !== 'object' || typeof value.responsibility !== 'string') return null;
  const decision = value.decision && typeof value.decision.reason === 'string' ? {
    reason: value.decision.reason,
    actor: typeof value.decision.actor === 'string' ? value.decision.actor : null,
    at: typeof value.decision.at === 'string' ? value.decision.at : null
  } : null;
  return {
    authority: text(value.authority),
    declaredReason: typeof value.declaredReason === 'string' ? value.declaredReason : null,
    satisfied: value.satisfied === true,
    decision
  };
}

function scopeOf(value: any): EvidenceScope | null {
  const words = value?.words;
  if (!words || typeof words.structure !== 'string' || typeof words.review !== 'string') return null;
  return {
    structurallyComplete: value.structurallyComplete === true,
    completenessReviewed: value.completenessReviewed === true,
    structure: words.structure,
    review: words.review,
    correctness: text(words.correctness)
  };
}

/** Shape the matrix JSON for the panel; anything malformed yields null rather than a guess. */
export function evidenceView(result: unknown): EvidenceView | null {
  // The rows arrive in `page` (the evaluation overview carries none), one page of them at a time.
  const matrix = (result as any)?.data?.matrix ?? (result as any)?.matrix ?? null;
  const evaluation = matrix?.evaluation;
  if (!evaluation || typeof evaluation !== 'object' || !Array.isArray(matrix?.page?.rows)) return null;
  const rows = list<EvidenceRow>(matrix.page.rows, (row) => (typeof row?.id === 'string' ? {
    id: row.id,
    type: text(row.type, 'STORY'),
    result: text(row.result, 'unknown'),
    assurance: typeof row.assurance === 'string' ? row.assurance : null,
    source: typeof row.source === 'string' ? row.source : null,
    obligations: list<EvidenceObligation>(row.obligations, (obligation) => (typeof obligation?.id === 'string' ? {
      id: obligation.id,
      responsibility: text(obligation.responsibility),
      status: text(obligation.status),
      owningSteps: list<string>(obligation.owningSteps, (step) => (typeof step === 'string' ? step : null)),
      facets: Object.fromEntries(Object.entries(obligation.facets ?? {}).filter(([, value]) => typeof value === 'string')) as Record<string, string>
    } : null)).sort((left, right) => RESPONSIBILITY_ORDER.indexOf(left.responsibility) - RESPONSIBILITY_ORDER.indexOf(right.responsibility)),
    findings: list<string>(row.findings, (finding) => (typeof finding?.message === 'string' ? finding.message : null)),
    actions: list<string>(row.actions, (action) => (typeof action?.command === 'string' ? action.command : null)),
    applicability: applicabilityOf(row.applicability),
    statement: row.scope && typeof row.scope.text === 'string'
      ? { text: row.scope.text, disposition: text(row.scope.disposition, 'unresolved'), coveredBy: typeof row.scope.coveredBy === 'string' ? row.scope.coveredBy : null }
      : null
  } : null));
  const counts = Object.entries(evaluation.summary?.results ?? {})
    .filter(([, count]) => typeof count === 'number' && count > 0)
    .map(([result, count]) => ({ result, count: count as number }));
  return {
    workId: text(evaluation.workId),
    title: typeof evaluation.title === 'string' ? evaluation.title : null,
    lifecycle: text(evaluation.lifecycle?.words),
    completion: text(evaluation.completion?.label),
    reasons: list<string>(evaluation.completion?.reasons, (reason) => (typeof reason === 'string' ? reason : null)),
    counts,
    assuranceFloor: typeof evaluation.summary?.assuranceFloor === 'string' ? evaluation.summary.assuranceFloor : null,
    requiredAssurance: typeof evaluation.requiredAssurance?.level === 'string' ? evaluation.requiredAssurance.level : null,
    scope: scopeOf(evaluation.summary?.scope),
    rows,
    total: typeof matrix.page?.total === 'number' ? matrix.page.total : rows.length,
    unreadable: list<string>(evaluation.findings, (finding) => (finding?.category === 'records' && typeof finding.message === 'string' ? finding.message : null))
  };
}

/** The status of one responsibility in a row, for its table cell; absent when the row owes none. */
export function evidenceCell(row: EvidenceRow, responsibility: string): string {
  const obligation = row.obligations.find((entry) => entry.responsibility === responsibility);
  return obligation ? obligation.status : '—';
}

/** Which tone a result reads in: met, an accepted exception, or still open. */
export function evidenceTone(result: string): 'ok' | 'wait' | 'bad' {
  if (result === 'satisfied' || result === 'not-applicable') return 'ok';
  if (result === 'failed') return 'bad';
  return 'wait';
}
