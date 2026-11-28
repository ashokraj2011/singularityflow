export type StepAdvice = {
  intent: string; decides: string; yes: string; sendBack: string; notNow: string; settles: string;
  stops: { undecided: string; changed: string; review: string; approver: string; repeated: string; browser: string };
};
export const GENERIC_INTENT: string;
export const ADVICE_FIELDS: readonly string[];
export const STOP_KINDS: readonly string[];
export const ADVICE_INTENTS: readonly string[];
export const STEP_ADVICE: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
export const WHEN_ADVICE: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>>;
export function stepAdvice(intent: string, options?: { step?: string; when?: string[] }): StepAdvice;
export function stopAdvice(intent: string, kind: string, options?: { step?: string }): string | null;
export function stepIntentOf(workflow: unknown, phaseId: string, inferred?: string | null): string;
export function adviceForStep(workflow: unknown, phaseId: string, intent?: string | null): StepAdvice;
