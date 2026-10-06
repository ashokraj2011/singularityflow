/** Bound the native dialog, not the reviewed data. Full details remain available verbatim. */
export const COMPACT_MESSAGE_MAX_CHARS = 600;
export const COMPACT_MESSAGE_MAX_LINES = 8;

export function compactMessagePresentation(message: string, detail = '', summary?: string): {
  message: string; detail: string; fullText: string | null;
} {
  const large = message.length > 220 || message.includes('\n') || detail.length > COMPACT_MESSAGE_MAX_CHARS
    || detail.split(/\r?\n/).length > COMPACT_MESSAGE_MAX_LINES;
  if (!large) return { message, detail, fullText: null };
  const firstLine = message.split(/\r?\n/)[0] ?? '';
  const title = firstLine.length > 220 ? firstLine.slice(0, 217) + '…' : firstLine;
  // Keep a short introduction, but never substitute this excerpt for the exact review document.
  const introduction = (summary ?? detail).split(/\r?\n/).filter(line => line.trim()).slice(0, summary ? 5 : 3)
    .map(line => line.length > 140 ? line.slice(0, 137) + '…' : line).join('\n').slice(0, 500);
  return { message: title || 'Review this change',
    detail: [introduction, 'View details opens the complete review. Nothing changes until you confirm.'].filter(Boolean).join('\n\n'),
    fullText: `${message}\n\n${detail}` };
}
