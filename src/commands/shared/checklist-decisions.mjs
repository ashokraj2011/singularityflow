/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { optionString, readJson, SingularityFlowError, optionStrings } from '../../util.mjs';
import path from 'node:path';

/**
 * The reviewer's checklist decisions, from `--article` or `--checklist`. `[SPK:REQ-060]`
 *
 * When the pinned phase policy requires the legacy checklist, `--article completeness=satisfied`
 * reads well for an individual decision and `--checklist decisions.json` carries longer reasons.
 * There is deliberately no flag that answers every article at once: that would turn the required
 * checklist into the rubber stamp `[SPK:REQ-060]` exists to prevent. The starter policy is off,
 * so its approvals do not accept these flags.
 *
 * Reasons come from `--article-reason` and not `--reason`, which already means "why this Story is
 * being returned" on `reject` and on `epic review`. Two meanings on one flag would have made
 * `epic review --decision reject --reason "..."` start failing as a malformed checklist.
 * `--article-reason` values pair with the non-`satisfied` articles in the order both are given.
 */
export async function checklistDecisions(options) {
  const file = optionString(options, 'checklist');
  if (file) {
    const payload = await readJson(path.resolve(file));
    const entries = Array.isArray(payload) ? payload : payload.checklist ?? payload.decisions;
    if (!Array.isArray(entries)) throw new SingularityFlowError('--checklist must contain an array of {article, decision, reason} entries.');
    return entries;
  }
  const articles = optionStrings(options, 'article');
  const reasons = optionStrings(options, 'article-reason');
  if (!articles.length) {
    if (reasons.length) throw new SingularityFlowError('--article-reason applies to a checklist article; pass --article <id>=exception alongside it.');
    return [];
  }
  let reasonIndex = 0;
  return articles.map((entry) => {
    const separator = String(entry).indexOf('=');
    const article = separator === -1 ? '' : String(entry).slice(0, separator).trim();
    const decision = separator === -1 ? '' : String(entry).slice(separator + 1).trim();
    if (!article || !decision) throw new SingularityFlowError(`--article must be <id>=satisfied|exception|not-applicable; got '${entry}'.`);
    return {
      article,
      decision,
      ...(decision === 'satisfied' ? {} : { reason: reasons[reasonIndex++] ?? null })
    };
  });
}
