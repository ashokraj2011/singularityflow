/**
 * People confirming, correcting or rejecting knowledge items.
 *
 * Knowledge read by pattern can be wrong, and the person who knows the code is the authority. A
 * review is a line in `docs/knowledge/confirmations.yml`, written in the working tree and committed
 * with the code it describes, so it goes through the repository's ordinary review. It records the
 * hash of the lines the item cited when it was reviewed: when those lines change, the review no
 * longer applies and the item says it needs reviewing again. Nothing here edits an item's facts.
 *
 *   confirmed  the item is right            → assurance becomes `confirmed`
 *   corrected  the item is wrong in a way   → the correction is shown beside it
 *   rejected   the item is wrong            → it is left out of views and prompts (and listed)
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import { gitCommitIdentity } from '../git.mjs';
import { SingularityFlowError } from '../util.mjs';

export const CONFIRMATIONS_PATH = 'docs/knowledge/confirmations.yml';
export const REVIEW_STATUSES = Object.freeze(['confirmed', 'corrected', 'rejected']);

/**
 * The lines a review is tied to: the item's own citation, or for a derived item (drift, coverage,
 * impact) the first cited item it relates to. A review of a test/code disagreement goes stale when
 * the rule it is about changes.
 */
export function reviewAnchor(knowledge, item) {
  if (item.citations[0]) return item.citations[0];
  const byId = new Map(knowledge.items.map((entry) => [entry.id, entry]));
  for (const relation of item.relations ?? []) {
    const related = byId.get(relation.to);
    if (related?.citations[0]) return related.citations[0];
  }
  return null;
}

export async function readConfirmations(root) {
  const text = await readFile(path.join(root, ...CONFIRMATIONS_PATH.split('/')), 'utf8').catch(() => null);
  if (text == null) return [];
  let parsed;
  try { parsed = YAML.parse(text); } catch (error) {
    throw new SingularityFlowError(`${CONFIRMATIONS_PATH} is not valid YAML: ${error.message}`, { code: 'KNOWLEDGE_CONFIRMATIONS_INVALID' });
  }
  const entries = Array.isArray(parsed?.reviews) ? parsed.reviews : [];
  return entries.filter((entry) => entry && typeof entry.item === 'string' && REVIEW_STATUSES.includes(entry.status));
}

/** Record one review in the working tree. Returns the entry and the file to commit. */
export async function recordReview(root, knowledge, { id, status, note = null, now = new Date() }) {
  if (!REVIEW_STATUSES.includes(status)) throw new SingularityFlowError(`A review is one of: ${REVIEW_STATUSES.join(', ')}.`);
  const item = knowledge.items.find((entry) => entry.id === id);
  if (!item) throw new SingularityFlowError(`No knowledge item '${id}' in this build. List them with: singularity-flow wm knowledge items`, { code: 'KNOWLEDGE_ITEM_UNKNOWN' });
  if (status !== 'confirmed' && !String(note ?? '').trim()) {
    throw new SingularityFlowError(`A ${status === 'corrected' ? 'correction' : 'rejection'} needs --note saying what is wrong.`, { code: 'KNOWLEDGE_REVIEW_NOTE_REQUIRED' });
  }
  const identity = gitCommitIdentity(root);
  const entry = {
    item: id,
    status,
    ...(note ? { note: String(note).trim() } : {}),
    kind: item.kind,
    about: item.subject?.symbol ?? item.subject?.name ?? item.subject?.path ?? null,
    at: reviewAnchor(knowledge, item) ? `${reviewAnchor(knowledge, item).path}:${reviewAnchor(knowledge, item).lines[0]}` : null,
    spanSha256: reviewAnchor(knowledge, item)?.spanSha256 ?? null,
    by: identity?.email ?? identity?.name ?? null,
    on: now.toISOString().slice(0, 10)
  };
  const reviews = (await readConfirmations(root)).filter((existing) => existing.item !== id);
  reviews.push(entry);
  reviews.sort((a, b) => String(a.at).localeCompare(String(b.at), 'en') || a.item.localeCompare(b.item, 'en'));
  const file = path.join(root, ...CONFIRMATIONS_PATH.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `# Reviews of repository knowledge (singularity-flow wm knowledge confirm|correct|reject).\n# Commit this file with the code it describes.\n${YAML.stringify({ reviews })}`);
  return { entry, file: CONFIRMATIONS_PATH };
}

/**
 * Apply reviews to a build. A review applies while the item's cited lines are the ones reviewed;
 * otherwise the item keeps its own assurance and says the review is out of date.
 */
export function applyReviews(knowledge, reviews) {
  if (!reviews.length) return { ...knowledge, rejected: [], orphaned: [] };
  const byItem = new Map(reviews.map((entry) => [entry.item, entry]));
  const rejected = [];
  const items = [];
  for (const item of knowledge.items) {
    const review = byItem.get(item.id);
    if (!review) { items.push(item); continue; }
    const current = !review.spanSha256 || review.spanSha256 === reviewAnchor(knowledge, item)?.spanSha256;
    const annotated = { ...item, review: { status: review.status, note: review.note ?? null, by: review.by ?? null, on: review.on ?? null, current } };
    if (current && review.status === 'rejected') { rejected.push(annotated); continue; }
    if (current && review.status === 'confirmed') annotated.assurance = 'confirmed';
    items.push(annotated);
  }
  // Reviews whose item no longer exists (its code was removed or rewritten) are listed, never dropped quietly.
  const present = new Set(knowledge.items.map((item) => item.id));
  const orphaned = reviews.filter((entry) => !present.has(entry.item));
  return { ...knowledge, items, rejected, orphaned };
}
