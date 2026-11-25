export interface AskDestination {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly topic: string;
  readonly aliases: readonly string[];
}
export const ASK_DESTINATIONS: readonly AskDestination[];
export const ASK_HINT: string;
export function askSuggestions(query: string, enabled?: ReadonlySet<string> | null): readonly AskDestination[];
