/**
 * Implementation bindings [E2G-011, decision D7].
 *
 * For each obligation a code step delivers by new or modified source, the delivery binds three
 * things a reviewer can check: the exact changed hunks of the obligation's planned paths
 * (mandatory), the public declarations those hunks touch (best effort, stated as heuristic, never as
 * proof), and the author's explanation of how the change meets the clause, written after the
 * clause's `@clause` tag on the same comment line, so it cites an exact path and line. The tag
 * associates; the binding explains; a person decides. Pure apart from reading the delivered files.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { changedDeclarations, documentationLanguage, publicDeclarations } from './code-documentation.mjs';
import { buildComprehensionDiffPreview } from './comprehension/diff-preview.mjs';
import { SingularityFlowError } from './util.mjs';

import {clauseTagExplanation,EXPLANATION_LIMITS} from './kernel/code-delivery-evidence.mjs';
export {clauseTagExplanation,EXPLANATION_LIMITS} from './kernel/code-delivery-evidence.mjs';
import {implementationBindingsDigest as bindingsDigest} from './engine-compatibility/node-source-policy.mjs';
export {implementationBindingsDigest as bindingsDigest} from './engine-compatibility/node-source-policy.mjs';
const MAX_BOUND_FILE_BYTES = 2 * 1024 * 1024;

function hunksByPath(preview) {
  const byPath = new Map();
  for (const file of preview?.files ?? []) {
    const key = file.pathAfter ?? file.pathBefore;
    if (!key) continue;
    byPath.set(key, (file.hunks ?? []).map((hunk) => ({
      beforeStart: hunk.beforeStart ?? null, beforeLines: hunk.beforeLines ?? null,
      afterStart: hunk.afterStart ?? null, afterLines: hunk.afterLines ?? null
    })));
  }
  return byPath;
}

/**
 * Bind each required obligation to its delivered regions and explanation. `required` is the list
 * of `{ clauseId, expectedPaths }` this step owes in source; `tags` the `@clause` bindings found in
 * the delivered source (`{ clauseId, sourcePath, line, tag }`). Returns the bindings, their digest
 * and the problems a delivery must correct.
 */
export async function implementationBindings(root, { changeSet, required = [], tags = [] }) {
  const entries = new Map((changeSet?.entries ?? []).flatMap((entry) =>
    [entry.newPath, entry.oldPath].filter(Boolean).map((candidate) => [candidate, entry])));
  const planned = [...new Set(required.flatMap((obligation) => obligation.expectedPaths))].filter((candidate) => entries.has(candidate));
  const edited = planned.filter((candidate) => !entries.get(candidate).untracked && entries.get(candidate).status !== 'added');
  const preview = edited.length
    ? buildComprehensionDiffPreview(root, changeSet, { contextLines: 0, paths: edited })
    : { files: [] };
  const hunks = hunksByPath(preview);
  const sources = new Map();
  const readSource = async (relative) => {
    if (!sources.has(relative)) {
      const bytes = await readFile(path.join(root, ...relative.split('/'))).catch(() => null);
      sources.set(relative, bytes && bytes.length <= MAX_BOUND_FILE_BYTES && !bytes.includes(0) ? bytes.toString('utf8') : null);
    }
    return sources.get(relative);
  };
  const bindings = [];
  const problems = [];
  const problemFindings = [];
  const explanationsMissing = [];
  for (const obligation of [...required].sort((left, right) => left.clauseId.localeCompare(right.clauseId))) {
    const regions = [];
    for (const relative of obligation.expectedPaths.filter((candidate) => entries.has(candidate)).sort()) {
      const entry = entries.get(relative);
      const source = entry.status === 'deleted' ? null : await readSource(relative);
      const lines = source == null ? [] : source.split(/\r?\n/u);
      const whole = entry.untracked || entry.status === 'added';
      const regionHunks = entry.status === 'deleted'
        ? [{ beforeStart: 1, beforeLines: null, afterStart: 0, afterLines: 0 }]
        : whole ? [{ beforeStart: 0, beforeLines: 0, afterStart: 1, afterLines: source ? lines.length - /\n$/u.test(source) : 0 }]
          : hunks.get(relative) ?? [];
      const language = documentationLanguage(relative);
      const changedLines = new Set(regionHunks.flatMap((hunk) =>
        Array.from({ length: Math.max(0, Number(hunk.afterLines ?? 0)) }, (_, offset) => Number(hunk.afterStart) + offset)));
      const declarations = source != null && language ? publicDeclarations(source, language) : [];
      const touched = whole ? declarations : changedDeclarations(declarations, changedLines, lines);
      regions.push({
        path: relative,
        change: entry.status === 'deleted' ? 'deleted' : whole ? 'added' : entry.oldPath && entry.oldPath !== entry.newPath ? 'renamed' : 'modified',
        hunks: regionHunks,
        symbols: touched.map(({ name, kind, line }) => ({ name, kind, line })),
        symbolAssurance: language ? 'heuristic' : 'unsupported-language'
      });
    }
    // The explanation sits on a tag line of a delivered path; the first one long enough counts.
    let explanation = null;
    for (const tag of tags.filter((item) => item.clauseId === obligation.clauseId && item.tag === 'clause' && Number.isInteger(item.line))) {
      const source = await readSource(tag.sourcePath);
      const text = clauseTagExplanation(source?.split(/\r?\n/u)[tag.line - 1], obligation.clauseId);
      if (text && text.length >= EXPLANATION_LIMITS.minimum) {
        explanation = { text: text.slice(0, EXPLANATION_LIMITS.maximum), path: tag.sourcePath, line: tag.line };
        break;
      }
    }
    const deletionOnly = regions.length > 0 && regions.every((region) => region.change === 'deleted');
    if (!explanation && !deletionOnly && regions.length) {
      const where = tags.find((item) => item.clauseId === obligation.clauseId && item.tag === 'clause');
      explanationsMissing.push({ clauseId: obligation.clauseId, path: where?.sourcePath ?? null, line: where?.line ?? null });
      problems.push(`${obligation.clauseId} needs an explanation of how the change meets it, after its @clause tag${where ? ` in ${where.sourcePath}:${where.line}` : ''}`
        + ` (${EXPLANATION_LIMITS.minimum} to ${EXPLANATION_LIMITS.maximum} characters)`);
      problemFindings.push({ code: 'code.delivery.clause-explanation-missing', path: where?.sourcePath ?? null, value: obligation.clauseId });
    }
    bindings.push({ clauseId: obligation.clauseId, explanation, regions });
  }
  return { bindings, bindingsSha256: bindingsDigest(bindings), problems, problemFindings, explanationsMissing };
}

export const BINDING_DECISIONS = Object.freeze(['accepted', 'accepted-with-exception']);

/**
 * One decision per binding a step submitted [E2G-011, D7]: approving the step accepts every
 * binding as a batch over their exact digest, unless the reviewer records an exception for one,
 * with its reason. A binding is never rejected inside an approval; returning it for correction is a
 * rejection of the step.
 */
export function reviewBindings(submitted, requested = []) {
  const bindings = submitted?.bindings ?? [];
  const known = new Set(bindings.map((binding) => binding.clauseId));
  if (!bindings.length) {
    if (requested.length) {
      throw new SingularityFlowError('This step submitted no implementation bindings to decide; leave out --binding.', { code: 'IMPLEMENTATION_BINDING_UNKNOWN' });
    }
    return null;
  }
  const chosen = new Map();
  for (const entry of requested) {
    const clauseId = String(entry.clauseId ?? '').toUpperCase();
    if (!known.has(clauseId)) {
      throw new SingularityFlowError(`This step submitted no binding for ${clauseId}; bound: ${[...known].join(', ')}.`, { code: 'IMPLEMENTATION_BINDING_UNKNOWN' });
    }
    if (entry.decision === 'reject') {
      throw new SingularityFlowError(`To return ${clauseId} for correction, reject the step instead of approving it.`, { code: 'IMPLEMENTATION_BINDING_DECISION_INVALID' });
    }
    if (!['accept', 'exception'].includes(entry.decision)) {
      throw new SingularityFlowError(`--binding must be <clause>=accept|exception; got ${entry.decision ?? 'nothing'} for ${clauseId}.`, { code: 'IMPLEMENTATION_BINDING_DECISION_INVALID' });
    }
    const reason = String(entry.reason ?? '').trim();
    if (entry.decision === 'exception' && (reason.length < 20 || reason.length > 1000)) {
      throw new SingularityFlowError(`An exception for ${clauseId} needs a reason of 20 to 1000 characters with --binding-reason.`, { code: 'IMPLEMENTATION_BINDING_REASON_REQUIRED' });
    }
    chosen.set(clauseId, entry.decision === 'exception' ? { decision: 'accepted-with-exception', reason } : { decision: 'accepted' });
  }
  return {
    bindingsSha256: submitted.bindingsSha256,
    decisions: bindings.map((binding) => ({ clauseId: binding.clauseId, ...(chosen.get(binding.clauseId) ?? { decision: 'accepted' }) }))
  };
}
