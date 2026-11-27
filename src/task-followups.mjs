/**
 * An analysis's follow-ups [ITW:REQ-109, docs/SPEC-ITW-INTENT-TO-WORK-v1.2.md]: an investigate, review or docs task is done
 * with no person's approval, and ends by offering to start a Story from one of its findings.
 *
 * The report's "## Follow-ups" section lists each finding that could be its own Story: a numbered (or bulleted) item, its
 * title on the first line and its details on the lines after it. Each becomes a follow-up with the complete command that
 * starts it (`work "<title>" --from <ID> --finding <N> --kind <KIND> --start`), whose intake carries that finding alone. A
 * docs task's one follow-up implements its document, bound to the version it wrote (`--document`). Pure.
 */
import { kindFromWords } from './task-composition.mjs';

const FOLLOW_UPS = /^#{2,4}\s+follow[- ]?ups?\b/iu;
const ITEM = /^\s*(?:(\d{1,2})[.)]|[-*+])\s+(.+?)\s*$/u;
const LIMIT = 9;
const clean = (text) => String(text ?? '').replace(/\*\*|__|`/gu, '').replace(/\s+/gu, ' ').trim();
const quoted = (words) => `"${String(words).replace(/(["\\$`])/gu, '\\$1')}"`;
// A follow-up changes code unless its words say what else it is; an analysis is never its own follow-up's kind.
const CODE_KINDS = new Set(['fix', 'feature', 'change', 'refactor', 'tests', 'chore']);

/** The findings a report's Follow-ups section lists, in order: `{ n, title, details }`, at most nine. */
export function reportFollowUps(text) {
  const lines = String(text ?? '').split(/\r?\n/u);
  const at = lines.findIndex((line) => FOLLOW_UPS.test(line));
  if (at < 0) return [];
  const items = [];
  for (const line of lines.slice(at + 1)) {
    if (/^#{1,4}\s/u.test(line)) break;
    const item = ITEM.exec(line);
    if (item && (!/^\s/u.test(line) || !items.length)) {
      const title = clean(item[2]).replace(/[:.]\s*$/u, '');
      if (title) items.push({ n: items.length + 1, title, details: [] });
      continue;
    }
    if (items.length && line.trim()) items.at(-1).details.push(clean(line.replace(ITEM, '$2')));
  }
  return items.slice(0, LIMIT).map((item) => ({ n: item.n, title: item.title.slice(0, 160), details: item.details.join(' ').slice(0, 2000) }));
}

/** The kind of a follow-up's task: what its words name when that changes code, else a fix (an investigation found a problem). */
export function followUpKind(title, from) {
  const named = kindFromWords(title);
  return CODE_KINDS.has(named) ? named : from === 'docs' ? 'feature' : 'fix';
}

/**
 * The follow-ups a done analysis offers [ITW:REQ-109]: each `{ n, title, details, kind, command }`. `id` is the task,
 * `kind` its kind, `report` its last step's document text and `document` that document's repository path (a docs task).
 */
export function taskFollowUps({ id, kind, report, document = null, title = null }) {
  if (kind === 'docs') {
    if (!document) return [];
    const words = `Implement ${clean(title) || document}`;
    return [{ n: 1, title: words, details: `Build what ${document} says, bound to the version ${id} wrote.`, kind: 'feature',
      command: `singularity-flow work ${quoted(words)} --kind feature --document ${document} --start` }];
  }
  return reportFollowUps(report).map((item) => {
    const followKind = followUpKind(item.title, kind);
    return { ...item, kind: followKind, command: `singularity-flow work ${quoted(item.title)} --from ${id} --finding ${item.n} --kind ${followKind} --start` };
  });
}

/** The words a follow-up's intake carries: that finding alone, and where it came from. */
export function findingIntake(id, artifact, item) {
  return `## Starts from ${id}'s finding ${item.n} (${artifact})\n\n${item.title}${item.details ? `\n\n${item.details}` : ''}`;
}
