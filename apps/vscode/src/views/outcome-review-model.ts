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
export interface OutcomeTarget { workId: string; phase: string | null; generation: number | null }
export interface DeliveryChoice { id: string; label: string; description: string; entryId?: string }
export interface DeliveryValidation {
  schemaVersion: 1; binding: OutcomeTarget; question: string;
  steps: Array<{ id: string; label: string; status: string; detail: string }>;
  choices: DeliveryChoice[];
}
export interface OutcomeView {
  workId: string; title: string | null; lifecycle: string | null; completion: string | null;
  target?: OutcomeTarget | null;
  application: OutcomeApplication; criteria: OutcomeCriterion[];
  open: { scopeItems: OutcomeScopeItem[]; blocking: Array<{ code: string; message: string }> };
  testsCommand: string | null;
  testsPhase?: string | null;
  repairCommand?: string | null;
  repairCopilot?: string | null;
  applicationReview?: { required: boolean; sessionId: string | null };
  validation?: DeliveryValidation;
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
  const target = { workId: data.workId, phase: text(data.step?.id) ? data.step.id : null,
    generation: Number.isSafeInteger(data.step?.generation) ? data.step.generation : null };
  const validation = data.validation as DeliveryValidation | undefined;
  if (validation && (validation.schemaVersion !== 1 || !sameOutcomeTarget(validation.binding, target)
      || !text(validation.question) || !Array.isArray(validation.steps) || !validation.steps.every(step => step && text(step.id) && text(step.label) && text(step.status) && text(step.detail))
      || !Array.isArray(validation.choices) || !validation.choices.every(choice => choice && text(choice.id) && text(choice.label) && text(choice.description)
        && (['tests', 'configure', 'review', 'repair', 'continue'].includes(choice.id)
          || /^(?:start|open):[A-Za-z0-9._-]+$/u.test(choice.id) && text(choice.entryId) && choice.id.endsWith(`:${choice.entryId}`))))) return null;
  return {
    workId: data.workId, title: text(data.title) ? data.title : null,
    target,
    ...(validation ? { validation } : {}),
    lifecycle: text(data.lifecycle) ? data.lifecycle : null, completion: text(data.completion) ? data.completion : null,
    application, criteria: data.criteria,
    open: {
      scopeItems: Array.isArray(open.scopeItems) ? open.scopeItems.filter((item: OutcomeScopeItem) => item && text(item.id) && text(item.command)) : [],
      blocking: Array.isArray(open.blocking) ? open.blocking.filter((finding: { code: string; message: string }) => finding && text(finding.message)) : []
    },
    ...(data.applicationReview ? { applicationReview: { required: data.applicationReview.required === true, sessionId: text(data.applicationReview.sessionId) ? data.applicationReview.sessionId : null } } : {}),
    testsCommand: text(data.routes?.tests?.command) ? data.routes.tests.command : null,
    testsPhase: text(data.validation?.tests?.phase) ? data.validation.tests.phase : null,
    repairCommand: text(data.routes?.repair?.command) ? data.routes.repair.command : null,
    repairCopilot: text(data.routes?.repair?.copilotCommand) ? data.routes.repair.copilotCommand : null
  };
}

/** A panel never silently acts on another Story or a replacement code generation. */
export function sameOutcomeTarget(left: OutcomeTarget | null | undefined, right: OutcomeTarget | null | undefined): boolean {
  return Boolean(left && right && left.workId === right.workId && left.phase === right.phase && left.generation === right.generation);
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
