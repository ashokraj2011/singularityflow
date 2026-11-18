export const SIGN_OFF_ANSWERS: Readonly<{ yes: string; no: string; unsure: string }>;
export const CONFIRMED_ON_CARD: string;
export function signOffQuestion(review: { method?: string | null; clauseId?: string | null; files?: string[] } | null | undefined, file?: string | null): string;
export function unsureWords(workId: string): string;
export function signOffAnswers(answer: 'yes' | 'no' | 'unsure', note?: string | null):
  { unsure: true } | { problem: string } | { reason: string; answers: Array<[string, boolean]> };
