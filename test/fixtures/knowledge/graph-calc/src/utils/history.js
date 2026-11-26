export const MAX_ENTRIES = 50;

export function addEntry(history, entry) {
  if (history.length >= MAX_ENTRIES) return [...history.slice(1), entry];
  return [...history, entry];
}
