/**
 * Upstream discrepancies an author recorded in its own phase artifact. `[phase-self-repair A1]`
 *
 * The authoring contract tells an author what to do with an approved earlier artifact that is
 * wrong, incomplete or contradicts another input: keep it unchanged, continue on the most
 * conservative reading, and list the problem under `## Upstream discrepancies`. Those items are
 * decisions for the earlier phase's owner (return, amendment or accepted risk), so a reviewer must
 * see them without reading every artifact in full. This module only reads; nothing here blocks.
 */

const HEADING = /^##\s+Upstream discrepancies\s*$/iu;
const MAXIMUM_ITEMS = 50;
const MAXIMUM_TEXT = 300;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function cleanCell(value) {
  return String(value ?? '').replace(/`/gu, '').trim();
}

/** The items under `## Upstream discrepancies`, each with the earlier phase it names, if any. */
export function upstreamDiscrepanciesFromMarkdown(markdown, phaseIds = []) {
  const lines = String(markdown ?? '').split(/\r?\n/u);
  const start = lines.findIndex((line) => HEADING.test(line.trim()));
  if (start < 0) return [];
  const items = [];
  for (let index = start + 1; index < lines.length && items.length < MAXIMUM_ITEMS; index += 1) {
    const line = lines[index];
    if (/^#{1,2}\s/u.test(line)) break;
    let entry = null;
    const bullet = /^\s*(?:[-*]|\d+[.)])\s+(.*\S)\s*$/u.exec(line);
    const row = /^\s*\|(.*)\|\s*$/u.exec(line);
    if (bullet) entry = bullet[1];
    else if (row) {
      const cells = row[1].split('|').map(cleanCell);
      // Separator and header rows describe the table rather than an item.
      if (cells.every((cell) => /^:?-{2,}:?$/u.test(cell) || cell === '')) continue;
      if (cells.some((cell) => /^(producer|producer phase|phase|problem)$/iu.test(cell))) continue;
      entry = cells.filter(Boolean).join(' — ');
    }
    if (!entry || /^(none|n\/a|-)\.?$/iu.test(entry.trim())) continue;
    const phase = phaseIds.find((id) => new RegExp(`(^|[^\\w-])${escapeRegExp(id)}([^\\w-]|$)`, 'iu').test(entry))
      ?? null;
    items.push({ phase, text: entry.length > MAXIMUM_TEXT ? `${entry.slice(0, MAXIMUM_TEXT - 1)}…` : entry });
  }
  return items;
}

/** Discrepancies across a phase review's readable documents, with the document each came from. */
export function phaseUpstreamDiscrepancies(documents = [], workflow = null, phaseId = null) {
  const order = workflow?.phaseOrder ?? Object.keys(workflow?.phases ?? {});
  // Only earlier phases can be upstream; the current phase naming itself is not a producer.
  const position = phaseId ? order.indexOf(phaseId) : -1;
  const earlier = position >= 0 ? order.slice(0, position) : order.filter((id) => id !== phaseId);
  const found = [];
  for (const document of documents) {
    if (document?.content == null || document.binary || document.error) continue;
    for (const item of upstreamDiscrepanciesFromMarkdown(document.content, earlier)) {
      found.push({ ...item, path: document.path ?? null });
      if (found.length >= MAXIMUM_ITEMS) return found;
    }
  }
  return found;
}
