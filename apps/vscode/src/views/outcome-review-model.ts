/**
 * The outcome review as the panel reads it: `singularity-flow outcome --json`, checked before it is
 * shown. No process or repository operation lives here.
 */
export interface OutcomeTest { test: string | null; file: string | null; outcome: string | null; status: string | null }
export interface OutcomeCheck {
  slot: string; method: string; role: string | null; status: string | null; reference: string | null;
  files?: string[]; signOff?: string | null; suggestedFile?: string;
}
export interface OutcomeCriterion {
  id: string; text: string | null; result: string | null; methods: string[] | null;
  tests: OutcomeTest[]; checks: OutcomeCheck[]; findings: Array<{ code: string; message: string }>;
}
export interface OutcomeEntry { id: string; name: string; url: string; started: boolean; ready: boolean; pid: number | null; portTaken?: boolean }
export interface OutcomeApplication { status: string; capability?: string | null; entries?: OutcomeEntry[]; message?: string | null }
export interface OutcomeScopeItem { id: string; text: string; command: string; otherCommand?: string }
export interface OutcomeView {
  workId: string; title: string | null; lifecycle: string | null; completion: string | null;
  application: OutcomeApplication; criteria: OutcomeCriterion[];
  open: { scopeItems: OutcomeScopeItem[]; blocking: Array<{ code: string; message: string }> };
  testsCommand: string | null;
  applicationReview?: { required: boolean; sessionId: string | null };
}

const text = (value: unknown): value is string => typeof value === 'string';
const optionalText = (value: unknown): boolean => value === null || value === undefined || text(value);

function validCheck(value: unknown): value is OutcomeCheck {
  const check = value as OutcomeCheck | null;
  return Boolean(check && text(check.slot) && text(check.method) && optionalText(check.status) && optionalText(check.reference)
    && optionalText(check.signOff) && optionalText(check.suggestedFile));
}

function validCriterion(value: unknown): value is OutcomeCriterion {
  const criterion = value as OutcomeCriterion | null;
  return Boolean(criterion && text(criterion.id) && optionalText(criterion.text) && Array.isArray(criterion.tests)
    && Array.isArray(criterion.checks) && criterion.checks.every(validCheck) && Array.isArray(criterion.findings));
}

/** The view, or null when the result is not an outcome review this panel reads. */
export function outcomeView(raw: unknown): OutcomeView | null {
  const data = (raw as { data?: { outcome?: unknown } } | null)?.data?.outcome as Record<string, any> | undefined;
  if (!data || data.resultType !== 'sflow-outcome-review' || !text(data.workId)) return null;
  if (!Array.isArray(data.criteria) || !data.criteria.every(validCriterion)) return null;
  const application = data.application as OutcomeApplication | undefined;
  if (!application || !text(application.status)) return null;
  if (application.entries && !application.entries.every((entry) => entry && text(entry.id) && text(entry.url) && typeof entry.started === 'boolean')) return null;
  const open = data.open ?? {};
  return {
    workId: data.workId, title: text(data.title) ? data.title : null,
    lifecycle: text(data.lifecycle) ? data.lifecycle : null, completion: text(data.completion) ? data.completion : null,
    application, criteria: data.criteria,
    open: {
      scopeItems: Array.isArray(open.scopeItems) ? open.scopeItems.filter((item: OutcomeScopeItem) => item && text(item.id) && text(item.command)) : [],
      blocking: Array.isArray(open.blocking) ? open.blocking.filter((finding: { code: string; message: string }) => finding && text(finding.message)) : []
    },
    ...(data.applicationReview ? { applicationReview: { required: data.applicationReview.required === true, sessionId: text(data.applicationReview.sessionId) ? data.applicationReview.sessionId : null } } : {}),
    testsCommand: text(data.routes?.tests?.command) ? data.routes.tests.command : null
  };
}

/** The three checklist items in the person's words, in the order `decision witness` takes them. */
export function signOffQuestions(criterion: Pick<OutcomeCriterion, 'id' | 'text'>): Array<[string, string]> {
  return [
    ['states-the-outcome', `Does the screenshot show the outcome ${criterion.id} describes?`],
    ['matches-the-criterion', `Does it match the criterion as written${criterion.text ? `: "${criterion.text}"` : ''}?`],
    ['current-for-this-change', 'Is it a screenshot of this Story\'s current change?']
  ];
}

/** The `decision witness` arguments for the person's answers; every item is answered, yes or no. */
export function signOffArgs(workId: string, criterionId: string, slot: string, file: string,
  answers: Array<[string, boolean]>, reason: string): string[] {
  return ['decision', 'witness', workId, '--criterion', criterionId, '--slot', slot, '--file', file,
    ...answers.flatMap(([item, yes]) => [yes ? '--confirm' : '--deny', item]), '--reason', reason.trim(), '--json'];
}

/** A document reference such as DOC-001, which `documents view` opens; anything else is a path or a screen name. */
export function documentReference(reference: string | null): boolean {
  return Boolean(reference && /^[A-Z][A-Z0-9]*-\d+$/u.test(reference));
}
