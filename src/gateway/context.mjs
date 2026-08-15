/**
 * The two things a user sees before they commit to anything. `[INT:REQ-175]` `[INT:IFC-085]`
 *
 * A **Context Receipt** answers "what is about to be shown to a model", before assisted analysis
 * runs. A **context banner** answers "who am I, and what am I acting on", before a plan or ceremony
 * is confirmed. Different moments, same principle: the disclosure comes from the kernel, is exact,
 * and is computed rather than described.
 *
 * Both are refusable. A receipt the user can only acknowledge is a notice, not a control, so
 * narrowing is part of the contract `[INT:REQ-176]` — bounded by the evidence the operation's own
 * safety and governance contract requires `[INT:CON-173]`, which is not the user's to drop.
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from '../specifications.mjs';
import { SingularityFlowError } from '../util.mjs';

export const CONTEXT_RECEIPT_SCHEMA_VERSION = 1;

export const CONTEXT_MODES = Object.freeze(['deterministic', 'assisted']);

/**
 * What was left out, named rather than counted.
 *
 * "3 items omitted" tells a reader nothing about whether the omission mattered. A category tells
 * them whether to narrow further or stop worrying.
 */
export const OMISSION_CATEGORIES = Object.freeze([
  'secrets', 'generated-files', 'unrelated-repositories', 'binary-files',
  'oversized-artifacts', 'policy-excluded', 'unresolved-evidence'
]);

const TOKEN_FIELDS = Object.freeze(['estimatedInput', 'cacheReusable', 'newlyTransmitted', 'maximumOutput']);

function reject(code, detail, details = {}) {
  throw new SingularityFlowError(detail, { code, details });
}

function frozenTokens(tokens, { tokenizer, estimationMethod }) {
  /**
   * An estimate that does not say how it was made reads as a bill `[INT:CON-174]`.
   *
   * Hosts differ in whether they report usage at all, and the number a user remembers from this
   * screen is the one they will compare against an invoice. Naming the tokenizer and the method is
   * what keeps that comparison honest.
   */
  if (!tokenizer) reject('CONTEXT_RECEIPT_INVALID', 'A token estimate must name the tokenizer that produced it.');
  if (!estimationMethod) reject('CONTEXT_RECEIPT_INVALID', 'A token estimate must name its estimation method.');
  const resolved = {};
  for (const field of TOKEN_FIELDS) {
    const value = tokens?.[field];
    if (!Number.isInteger(value) || value < 0) {
      reject('CONTEXT_RECEIPT_INVALID', `tokens.${field} must be a non-negative integer.`, { field });
    }
    resolved[field] = value;
  }
  if (resolved.cacheReusable + resolved.newlyTransmitted !== resolved.estimatedInput) {
    reject('CONTEXT_RECEIPT_INVALID',
      'Cached and newly transmitted tokens must account for the whole estimated input.',
      { tokens: resolved });
  }
  return Object.freeze({ ...resolved, tokenizer, estimationMethod, exact: false });
}

function frozenEvidence(evidence) {
  if (!Array.isArray(evidence)) reject('CONTEXT_RECEIPT_INVALID', 'Evidence must be a list of handles.');
  return Object.freeze(evidence.map((entry, index) => {
    if (!entry?.handle) reject('CONTEXT_RECEIPT_INVALID', `Evidence[${index}] has no handle.`);
    if (!entry?.category) reject('CONTEXT_RECEIPT_INVALID', `Evidence[${index}] has no category.`);
    if (typeof entry.required !== 'boolean') {
      // Whether a piece of evidence can be dropped is the one thing narrowing depends on, so it is
      // never inferred from category or left to a default.
      reject('CONTEXT_RECEIPT_INVALID', `Evidence[${index}] must say whether it is required.`, { handle: entry.handle });
    }
    return Object.freeze({
      handle: String(entry.handle),
      category: String(entry.category),
      required: entry.required,
      reason: entry.reason ?? null
    });
  }));
}

function receiptHash(receipt) {
  const { receiptHash: _ignored, ...body } = receipt;
  return `sha256:${createHash('sha256').update(canonicalJson(body)).digest('hex')}`;
}

/**
 * Build the receipt for one assisted or deterministic run. `[INT:IFC-080]`
 *
 * The counts and the evidence list are two views of the same selection and are not allowed to
 * disagree: the count is derived from the evidence rather than supplied, because a summary that can
 * drift from the thing it summarizes is the summary people will read and the detail nobody checks.
 */
export function contextReceipt({
  subject,
  mode,
  route = null,
  evidence = [],
  omitted = [],
  redactions = [],
  tokens,
  tokenizer,
  estimationMethod,
  registryHash,
  policyHash
} = {}) {
  if (!CONTEXT_MODES.includes(mode)) reject('CONTEXT_RECEIPT_INVALID', `mode '${mode}' is not one of ${CONTEXT_MODES.join(', ')}.`);
  if (!subject?.kind || !subject?.id) reject('CONTEXT_RECEIPT_INVALID', 'A receipt must name its subject.');
  if (!registryHash || !policyHash) reject('CONTEXT_RECEIPT_INVALID', 'A receipt must pin the registry and policy it was computed under.');
  for (const category of omitted) {
    if (!OMISSION_CATEGORIES.includes(category)) {
      reject('CONTEXT_RECEIPT_INVALID', `'${category}' is not a known omission category.`, { category, known: [...OMISSION_CATEGORIES] });
    }
  }

  const selected = frozenEvidence(evidence);
  const counts = {};
  for (const entry of selected) counts[entry.category] = (counts[entry.category] ?? 0) + 1;

  const body = {
    schemaVersion: CONTEXT_RECEIPT_SCHEMA_VERSION,
    kind: 'context-receipt',
    subject: Object.freeze({
      kind: subject.kind,
      id: subject.id,
      revision: Object.freeze({ ...(subject.revision ?? {}) })
    }),
    mode,
    /** Null is an answer: "the host did not tell us" is different from "no model is involved". */
    route: route ? Object.freeze({ provider: route.provider ?? null, model: route.model ?? null }) : null,
    selected: Object.freeze(counts),
    evidence: selected,
    omitted: Object.freeze([...omitted].sort()),
    redactions: Object.freeze(redactions.map((entry) => Object.freeze({
      rule: String(entry.rule), occurrences: Number(entry.occurrences ?? 0)
    }))),
    tokens: frozenTokens(tokens, { tokenizer, estimationMethod }),
    registryHash,
    policyHash
  };
  return Object.freeze({ ...body, receiptHash: receiptHash(body) });
}

/**
 * Narrow a receipt to less evidence, and refuse to narrow past the contract. `[INT:REQ-176]` `[INT:CON-173]`
 *
 * Refusing loudly rather than silently keeping required evidence: a user who thinks they removed
 * something and did not has been told the opposite of the truth by a disclosure screen, which is
 * worse than the screen not existing.
 */
export function narrowContextReceipt(receipt, { remove = [], tokens, tokenizer, estimationMethod } = {}) {
  const removing = new Set(remove);
  const required = receipt.evidence.filter((entry) => entry.required && removing.has(entry.handle));
  if (required.length) {
    reject('CONTEXT_NARROWING_REFUSED',
      `That evidence is required by the operation and cannot be removed: ${required.map((entry) => entry.handle).join(', ')}.`,
      { handles: required.map((entry) => entry.handle) });
  }
  const unknown = [...removing].filter((handle) => !receipt.evidence.some((entry) => entry.handle === handle));
  if (unknown.length) {
    reject('CONTEXT_NARROWING_REFUSED', `That evidence is not in this receipt: ${unknown.join(', ')}.`, { handles: unknown });
  }

  return contextReceipt({
    subject: { kind: receipt.subject.kind, id: receipt.subject.id, revision: receipt.subject.revision },
    mode: receipt.mode,
    route: receipt.route,
    evidence: receipt.evidence.filter((entry) => !removing.has(entry.handle)),
    omitted: receipt.omitted,
    redactions: receipt.redactions,
    tokens: tokens ?? receipt.tokens,
    tokenizer: tokenizer ?? receipt.tokens.tokenizer,
    estimationMethod: estimationMethod ?? receipt.tokens.estimationMethod,
    registryHash: receipt.registryHash,
    policyHash: receipt.policyHash
  });
}

/**
 * What actually happened, against what was promised. `[INT:REQ-177]`
 *
 * Carrying the original receipt hash is the whole point: an estimate nobody ever compares to an
 * outcome is a number that can be wrong forever.
 */
export function contextUsageRecord(receipt, { actual = {}, cacheReused = null, truncated = false, fallbacks = [], reportedByHost = false } = {}) {
  if (receipt?.kind !== 'context-receipt') reject('CONTEXT_USAGE_INVALID', 'A usage record must refer to a context receipt.');
  return Object.freeze({
    schemaVersion: CONTEXT_RECEIPT_SCHEMA_VERSION,
    kind: 'context-usage',
    receiptHash: receipt.receiptHash,
    subject: receipt.subject,
    mode: receipt.mode,
    /** Absent, not zero. A host that reports nothing has not reported zero. */
    actual: Object.freeze(Object.fromEntries(TOKEN_FIELDS
      .filter((field) => Number.isInteger(actual[field]))
      .map((field) => [field, actual[field]]))),
    reportedByHost,
    cacheReused,
    truncated,
    fallbacks: Object.freeze([...fallbacks])
  });
}

/**
 * Who is acting, on what, under whose authority. `[INT:IFC-085]`
 *
 * Rendered before a plan or ceremony and sourced from the kernel, never from the conversation. The
 * fields are the ones a person needs to notice they are about to approve something in the wrong
 * workspace, as the wrong identity, or against a revision that is no longer what they read.
 */
const BANNER_FIELDS = Object.freeze([
  'actor', 'authority', 'workspaceId', 'subjectKind', 'subjectId',
  'repositories', 'sourceRevision', 'lifecycleRevision'
]);

export function contextBanner(values = {}) {
  const banner = {};
  for (const field of BANNER_FIELDS) {
    const value = values[field];
    // Unresolved is a state, not a blank. It blocks confirmation below rather than rendering empty.
    banner[field] = value === undefined ? null : value;
  }
  return Object.freeze({
    schemaVersion: CONTEXT_RECEIPT_SCHEMA_VERSION,
    kind: 'context-banner',
    ...banner,
    repositories: Object.freeze([...(values.repositories ?? [])]),
    /** Only when an external target is involved; otherwise there is no provider to disclose. */
    provider: values.provider ? Object.freeze({ ...values.provider }) : null,
    unresolved: Object.freeze(BANNER_FIELDS.filter((field) => banner[field] == null && field !== 'lifecycleRevision'))
  });
}

/**
 * Block confirmation while the banner is stale or incomplete. `[INT:CON-186]`
 *
 * Returns the reasons rather than a boolean, because "refresh the banner" without saying what moved
 * is an instruction the user cannot act on or argue with.
 */
export function bannerBlockers(banner, current = null) {
  const blockers = banner.unresolved.map((field) => ({ field, reason: 'unresolved' }));
  if (!current) return Object.freeze(blockers);
  for (const field of BANNER_FIELDS) {
    const before = JSON.stringify(banner[field] ?? null);
    const after = JSON.stringify(current[field] ?? null);
    if (before !== after) blockers.push({ field, reason: 'changed', before: banner[field] ?? null, after: current[field] ?? null });
  }
  const providerBefore = JSON.stringify(banner.provider ?? null);
  const providerAfter = JSON.stringify(current.provider ?? null);
  if (providerBefore !== providerAfter) blockers.push({ field: 'provider', reason: 'changed' });
  return Object.freeze(blockers);
}
