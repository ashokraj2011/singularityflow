/**
 * `singularity-flow spec attach WORK-ID --drop CLAUSE-ID --reason TEXT`: take one clause of a Story's
 * specification slice out of what it delivers, with the reason (SPEC-SPA v1.3 §6.3).
 *
 * A slice is attached when the Story starts (`start --spec`). It is part of the Story's pinned source,
 * which the Story's creation commit makes immutable with the rest of its resolved policy, so it is
 * never rewritten afterwards. Dropping a sliced clause is the scope decision that already exists for
 * any source statement: the clause's scope item is recorded `excluded` with the reason, by a person in
 * the group that decides the Story's scope, and its usage records list the clause as dropped. It is the
 * person's own step (OWN_TERMINAL_STEPS `spec-slice-change`).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { repoRoot } from '../git.mjs';
import { sliceClauseItem } from '../spec-library/slice.mjs';
import { optionBoolean, optionString, optionStrings, SingularityFlowError } from '../util.mjs';

const fail = (message, code, details = {}) => { throw new SingularityFlowError(message, { code, details }); };

/** `SPEC-X:REQ-003`, or `REQ-003` when only one attached specification has it. */
export function dropTarget(slices, value) {
  const raw = String(value ?? '').trim().toUpperCase();
  const candidates = slices.flatMap((slice) => (slice.clauses ?? []).map((clause) => ({ slice, clause, id: String(clause.anchor).replace(/^\[|\]$/gu, '') })));
  const found = candidates.filter((entry) => entry.id === raw || (!raw.includes(':') && entry.id.endsWith(`:${raw}`)));
  if (found.length === 1) return found[0];
  fail(found.length ? `${raw} is a clause of more than one attached specification; name it as SPEC-ID:${raw}.`
    : `${raw || '(nothing)'} is not a clause this Story's slice delivers; it delivers ${candidates.map((entry) => entry.id).join(', ') || 'none'}.`,
  'SPEC_SLICE_CLAUSE_UNKNOWN', { clause: raw, nextAction: 'singularity-flow evidence scope' });
}

/**
 * Resolve `spec attach WORK-ID --drop CLAUSE --reason TEXT` to the scope decision it records: the
 * caller runs `decision scope WORK-ID --item <item> --as excluded --reason TEXT` with it.
 */
export async function specSliceDrop(positionals, options) {
  const root = repoRoot();
  const workId = positionals[2];
  const reference = positionals[3] ?? null;
  const drops = optionStrings(options, 'drop');
  if (workId && reference && !drops.length) {
    fail(`A Story's specification slice is attached when it starts, as part of its pinned source, which never changes afterwards; nothing was attached to ${workId}. Start the Story that delivers ${reference} with --spec, or take clauses out of ${workId}'s slice with --drop CLAUSE-ID --reason TEXT.`,
      'SPEC_SLICE_ATTACH_AT_START', { workId, nextAction: `singularity-flow start <WORK-ID> --spec ${reference} --from-branch <BRANCH>` });
  }
  if (!workId || reference || drops.length !== 1) {
    fail('Usage: singularity-flow spec attach WORK-ID --drop CLAUSE-ID --reason TEXT (one clause at a time).', 'SPEC_SLICE_REQUEST_INVALID',
      { nextAction: 'singularity-flow help spec' });
  }
  if (!String(optionString(options, 'reason') ?? '').trim()) {
    fail('Dropping a sliced clause needs the reason it leaves this Story: --reason TEXT.', 'SPEC_SLICE_REASON_MISSING',
      { workId, nextAction: `singularity-flow spec attach ${workId} --drop ${drops[0]} --reason TEXT` });
  }
  const [{ loadConfig }, { checkoutStoryBranch }] = await Promise.all([import('../state-stores.mjs'), import('../story-branch-name.mjs')]);
  const config = await loadConfig(root);
  await checkoutStoryBranch(root, config, workId, { fetch: optionBoolean(options, 'fetch') });
  const file = path.join(root, config.workItemRoot ?? 'singularity/work-items', workId, 'source.json');
  const source = JSON.parse(await readFile(file, 'utf8'));
  const slices = Array.isArray(source.specification) ? source.specification : [];
  if (!slices.length) {
    fail(`${workId} was started without a specification slice, so there is no sliced clause to drop.`, 'SPEC_SLICE_CLAUSE_UNKNOWN',
      { workId, nextAction: `singularity-flow evidence scope ${workId}` });
  }
  const target = dropTarget(slices, drops[0]);
  return { workId, clause: target.id, item: sliceClauseItem(target.clause) };
}
