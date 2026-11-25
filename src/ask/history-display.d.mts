export interface AskHistoryDisplay {
  title: string;
  summary: string[];
  rows: { label: string; detail: string; evidenceId?: string }[];
  patch?: { status: string; text?: string | null };
}
export function askHistoryDisplay(value: object): AskHistoryDisplay | null;
