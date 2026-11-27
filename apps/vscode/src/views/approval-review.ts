/**
 * The human approval ceremony for a Story phase.
 *
 * When a pinned policy requires Specification-quality articles, the extension renders the exact
 * checklist carried by the review bundle, leaves every decision empty, and requires reasons for
 * exceptions and not-applicable decisions. The starter policy has no such articles. One screen asks one question,
 * "Approve <Step> v<N>?", answered by the person's own choice of "Approve <Step> v<N>", bound to the version shown
 * (owner, 2026-11-19); nobody types the step's ID, and nothing is inferred or preselected.
 */
import * as vscode from 'vscode';

import {
  registerMessageRouter, stringField, type InboundMessage
} from './messages.ts';
import { navigateTo } from './navigate.ts';
import { approvalBlockingCommits, approvalBlockingCommitsHtml, approvalHoldsHtml, contentSecurityPolicy, escape, evidenceConsistencyHtml,
  navigationTarget, nonce, page, type EvidenceConsistencyPresentation } from './webview.ts';
import { approvalHolds } from './approvals-model.ts';
import { APPROVAL_STATE_PILL, guardCardText, type ApprovalStanding, type GuardCardRead } from './sf-guard-model.ts';
import { TRY_IT_STYLE, tryItCopyText, tryItHtml, tryItOpenUrl, type TryItView } from './try-it.ts';

export const APPROVAL_DECISIONS = ['satisfied', 'exception', 'not-applicable'] as const;
export type ApprovalChecklistDecision = {
  article: string;
  decision: typeof APPROVAL_DECISIONS[number];
  reason?: string;
};
/** The adequacy facets a witness exception names, exactly as the CLI reads them (src/wel-review.mjs). */
export const WITNESS_FACETS = ['setup', 'action', 'assertions', 'boundaries', 'implementation'] as const;
export type WitnessMappingDecision = {
  mappingSha256: string;
  decision: typeof APPROVAL_DECISIONS[number];
  reason?: string;
  expiresAt?: string;
  /** For an exception: which parts of the test fall short. */
  inadequate?: Array<typeof WITNESS_FACETS[number]>;
};
/** One of the approver's own decisions, answered in the approval and recorded in its commit [SPEC-OAP M4]. */
export type InApprovalDecision = { item: string; option: string; reason?: string; expires?: string; cause?: string };
type DecisionNeed = { default?: string; latest?: string } | undefined;
export type InApprovalItem = {
  id: string;
  title: string;
  why?: string;
  options: Array<{ id: string; label: string; recommended?: boolean; needs?: { reason?: DecisionNeed; expires?: DecisionNeed; cause?: DecisionNeed } }>;
};
export type WitnessMappingReview = {
  mappingSha256: string;
  clauseId: string;
  clauseText?: string | null;
  clauseFields?: { behavior?: string | null; observable?: string | null } | null;
  clauseStatus?: string;
  logicalTestId: string;
  sourcePath: string;
  sourceDeclarationSha256: string;
};

export interface ApprovalReviewRequest {
  title: string;
  expected: string;
  workId: string;
  phaseId: string;
  phaseLabel: string;
  generation: number;
  artifact: { path?: string | null; sha256?: string | null } | null;
  articles: Array<{ id: string; title: string; question: string }>;
  findings: Array<{ kind?: string; message?: string }>;
  witnessedClauses: {
    profile?: string;
    enrolledClauseCount?: number;
    analyzedClauseCount?: number;
    clauses?: Array<{
      clauseId?: string;
      fields?: Record<string, { status?: string }>;
      witnessType?: string | null;
      declaredWitnessType?: string | null;
      enforceable?: boolean;
    }>;
  } | null;
  witnessMappings?: WitnessMappingReview[];
  evidenceConsistency?: EvidenceConsistencyPresentation | null;
  /**
   * Evidence this approval counts on a step's approvers' "still holds" across an amendment's wording
   * (`decisions --json` approvalEvidence.carried) [SCS:REQ-022]: the engine's words, shown before the person approves.
   */
  carried?: { words: string; entries: Array<{ words: string }> } | null;
  /**
   * Decisions the engine would refuse this approval for (`decisions --json`), read beside the review
   * bundle. Presentation only: the approval gate checks again.
   */
  pendingDecisions?: { count: number; headline: string } | null;
  /**
   * The holding decisions this approver may answer in the approval itself (`decisions --json`
   * `inApproval`), with the list digest they were read from; answered ones go in the approval commit.
   */
  inApproval?: { digest: string; items: InApprovalItem[] } | null;
  /**
   * Commits after the submission that approval would refuse for (`blockingCommits` of submission
   * readiness), read beside the bundle as returned. Advisory: the approval gate checks again.
   */
  blockingCommits?: unknown;
  /** Whether approval would pass (`approvalCheck` of submission readiness), read the same way. Advisory. */
  approvalCheck?: unknown;
  /** The step's test run (`tests summary --json`), when one is recorded: its label and totals. */
  testRun?: { label: string; totals: string } | null;
  priorExceptions: Array<{ article?: string; decision?: string; reason?: string; actor?: string }>;
  selfApproval: boolean;
  /**
   * SF Guard, when this packet carries labels or the Story pinned it: the packet's attribution summary
   * and labels (`review --format json`), and this step's recorded decisions as SF Guard counts them
   * (`approvals --json`). Advisory: a label never refuses; the approval gate verifies signatures.
   */
  sfGuard?: { summary: string | null; labels: string[]; approvals: ApprovalStanding[]; card?: GuardCardRead | null } | null;
  /**
   * Approve twice: the steps SFlow approved when they were ready since the last person approval, which this approval
   * also covers (the decision list's approval item `details.covers`): each version, its documents and what was checked.
   */
  covers?: Array<{ label: string; generation: number; documents: string[]; words: string }> | null;
  /**
   * Each finding of this step's review a person disputed, with who and why (the decision list's approval item
   * `details.disputes`): the approver decides with it in view, and may still send the step back [owner, 2026-11-20].
   */
  disputes?: Array<{ finding: string; words: string }> | null;
  /**
   * What the code step's change does, in one line, and the Story's page of it (the decision list's approval item
   * `details.changeStory`) [CSP:REQ-007]: shown first, the page opened in a Markdown preview beside the review.
   */
  changeStory?: { summary: string; path: string } | null;
  /**
   * A code step's ready ways to try this version, from SFlow's runtime check of it (`tryIt` of `review --format json`,
   * step intents spec §12.5): a URL, requests, commands or a snippet. Optional: it records and holds nothing.
   */
  tryIt?: TryItView | null;
  /**
   * What needs the person's eyes, and only what is new to them (`phase show --json` approvalFocus, src/approval-focus.mjs)
   * [owner, 2026-11-21]. Presentation only: the approval binds every document in full, and each one opens in full.
   */
  focus?: ApprovalFocus | null;
  /** The checkout the focus's paths are relative to, so an item opens its file at its line beside the review. */
  repository?: string | null;
}

type FocusAt = { path?: string; line?: number; section?: string; requirement?: string };
type FocusSection = { title: string; line?: number | null; state: string; folded?: string; text?: string; diff?: Array<{ op: string; text: string }> };
export type ApprovalFocus = {
  eyes: { title: string; items: Array<{ id: string; kind: string; words: string; at?: FocusAt }>; more?: Array<{ id: string; kind: string; words: string; at?: FocusAt }>;
    none?: string; checked: string };
  documents: Array<{ label: string; path?: string; version?: number; kind: string; line: string; sections?: FocusSection[] }>;
  words: { full: number; shown: number; line?: string | null };
  binding: string;
};

/** The approval focus `phase show --json` returned, or null when it carried none or its shape is not one. */
export function focusOf(read: unknown): ApprovalFocus | null {
  const focus = (read as { approvalFocus?: ApprovalFocus } | null)?.approvalFocus;
  if (!focus || typeof focus !== 'object' || !Array.isArray(focus.eyes?.items) || typeof focus.eyes.checked !== 'string' || !Array.isArray(focus.documents)) return null;
  return focus;
}

const focusPlace = (at: FocusAt | undefined) => [at?.path ? `${at.path}${at.line ? `:${at.line}` : ''}` : null, at?.section ? `"${at.section}"` : null,
  at?.requirement && !at.path ? at.requirement : null].filter(Boolean).join(' · ');

/** One item of the list, with where it is; a file it names opens at its line beside the review. */
function focusItemHtml(item: ApprovalFocus['eyes']['items'][number]): string {
  const place = focusPlace(item.at);
  const open = item.at?.path ? `<button type="button" class="secondary focus-open" data-open="${escape(item.at.path)}" data-line="${Number(item.at.line) || ''}">Open</button>` : '';
  return `<li>${escape(item.words)}${place ? ` <span class="focus-at"><code>${escape(place)}</code></span>` : ''}${open}</li>`;
}

/** A section of a document as the focus shows it: its diff when it changed, its text when it is new. */
function focusSectionHtml(section: FocusSection): string {
  if (section.state === 'changed') {
    return `<h4>${escape(section.title)}: changed</h4><pre class="focus-diff">${(section.diff ?? []).map((entry) => `<span class="${entry.op === '+' ? 'focus-add' : 'focus-del'}">${escape(`${entry.op} ${entry.text}`)}</span>`).join('\n')}</pre>`;
  }
  if (section.state === 'new') return `<details open><summary>${escape(section.title)}: new</summary><pre class="focus-text">${escape(section.text ?? '')}</pre></details>`;
  if (section.state === 'removed') return `<p class="muted">${escape(section.title)}: removed</p>`;
  return `<details><summary>${escape(section.title)}: ${escape(section.folded ?? '')}</summary><pre class="focus-text">${escape(section.text ?? '')}</pre></details>`;
}

/**
 * The page's opening: "What needs your eyes", each item at its file and line, section or requirement, then one
 * "checked by SFlow" line; then "What is new", each document in one line and only its new or changed sections open.
 */
export function approvalFocusHtml(focus: ApprovalFocus | null | undefined): string {
  if (!focus) return '';
  const items = [...focus.eyes.items, ...(focus.eyes.more ?? [])];
  const documents = focus.documents.map((document) => {
    const sections = (document.sections ?? []).map(focusSectionHtml).join('');
    return `<div class="focus-doc"><h3>${escape(document.line)}</h3>${document.path
      ? `<button type="button" class="secondary focus-open" data-open="${escape(document.path)}" data-line="">Open the full document</button>` : ''}${sections}</div>`;
  }).join('');
  return `<section class="approval-focus" aria-label="${escape(focus.eyes.title)}">
    <h2>${escape(focus.eyes.title)}</h2>
    ${items.length ? `<ol>${items.map(focusItemHtml).join('')}</ol>` : `<p>${escape(focus.eyes.none ?? '')}</p>`}
    <p class="muted">${escape(focus.eyes.checked)}</p>
  </section>
  <section class="approval-new" aria-label="What is new">
    <h2>What is new</h2>
    <p class="muted">${typeof focus.words.line === 'string' && focus.words.line ? `${escape(focus.words.line)}. ` : ''}${escape(focus.binding)}</p>
    ${documents}
  </section>`;
}

/** "Approve Requirements v1", the one choice that approves; the question is the same words with a question mark. */
export function approvalChoice(request: Pick<ApprovalReviewRequest, 'phaseLabel' | 'generation'>): string {
  return `Approve ${request.phaseLabel} v${Number(request.generation) || 0}`;
}

/** The covered steps the decision list's approval item names (`details.covers`), or null when there are none. */
export function coversOf(listed: unknown): ApprovalReviewRequest['covers'] {
  const items = (listed as { items?: Array<{ kind?: string; details?: { covers?: unknown } }> } | null)?.items;
  const covers = Array.isArray(items) ? items.find((item) => item?.kind === 'approval')?.details?.covers : null;
  if (!Array.isArray(covers) || !covers.length) return null;
  return covers.filter((entry) => entry && typeof entry.label === 'string').map((entry) => ({ label: entry.label, generation: Number(entry.generation) || 0,
    documents: Array.isArray(entry.documents) ? entry.documents.filter((file: unknown): file is string => typeof file === 'string') : [],
    words: typeof entry.words === 'string' ? entry.words : 'approved automatically' }));
}

/** The disputed findings the decision list's approval item names (`details.disputes`), or null when there are none. */
export function disputesOf(listed: unknown): ApprovalReviewRequest['disputes'] {
  const items = (listed as { items?: Array<{ kind?: string; details?: { disputes?: unknown } }> } | null)?.items;
  const disputes = Array.isArray(items) ? items.find((item) => item?.kind === 'approval')?.details?.disputes : null;
  if (!Array.isArray(disputes) || !disputes.length) return null;
  return disputes.filter((entry) => entry && typeof entry.finding === 'string' && typeof entry.words === 'string')
    .map((entry) => ({ finding: entry.finding as string, words: entry.words as string }));
}

/** The page of what the change does that the decision list's approval item names (`details.changeStory`), or null. */
export function changeStoryOf(listed: unknown): ApprovalReviewRequest['changeStory'] {
  const items = (listed as { items?: Array<{ kind?: string; details?: { changeStory?: { summary?: unknown; path?: unknown } } }> } | null)?.items;
  const story = Array.isArray(items) ? items.find((item) => item?.kind === 'approval')?.details?.changeStory : null;
  return story && typeof story.summary === 'string' && typeof story.path === 'string' && !story.path.split('/').includes('..')
    ? { summary: story.summary, path: story.path } : null;
}

/** What the code step's change does, in one line, at the top of its approval, with its whole page a click away. */
export function approvalChangeStoryHtml(story: ApprovalReviewRequest['changeStory']): string {
  if (!story) return '';
  return `<section class="approval-change-story" aria-label="What this change does">
    <h2>What this change does</h2>
    <p>${escape(story.summary)}</p>
    <button type="button" class="secondary" data-change-story>Open the full page</button>
    <span class="muted">SFlow wrote it from its records and the code step's own notes; it opens beside this review.</span>
  </section>`;
}

/** The reviewer's findings a person disputed, each with who and why, before the person approves. */
export function approvalDisputesHtml(disputes: ApprovalReviewRequest['disputes']): string {
  if (!disputes?.length) return '';
  return `<section class="approval-disputes" aria-label="Disputed review findings">
    <h2>Disputed review findings</h2>
    <p class="muted">The reviewer asked for these to be fixed, and a person disputed them. Send the step back if you agree with the reviewer.</p>
    <ul>${disputes.map((entry) => `<li>${escape(entry.words)}</li>`).join('')}</ul>
  </section>`;
}

/** What this approval also covers: the steps SFlow approved since the last person approval, by version and documents. */
export function approvalCoversHtml(covers: ApprovalReviewRequest['covers']): string {
  if (!covers?.length) return '';
  return `<section class="approval-covers" aria-label="Also covered by this approval">
    <h2>Also covered by this approval</h2>
    <p class="muted">SFlow approved these steps when their reviewer said ready and nothing was open. Your Yes covers them too; send one back if it is wrong.</p>
    <ul>${covers.map((entry) => `<li><strong>${escape(entry.label)} v${Number(entry.generation) || 0}</strong> · ${escape(entry.words)}${entry.documents.length
      ? `<br>${entry.documents.map((file) => `<code>${escape(file)}</code>`).join(' ')}` : ''}</li>`).join('')}</ul>
  </section>`;
}

/** The packet's labels and this step's decisions under SF Guard, and the card Touch ID signs, before the person approves. */
export function sfGuardReviewHtml(guard: ApprovalReviewRequest['sfGuard']): string {
  const card = guard?.card ?? null;
  // Required here but not signed here (no key, Windows or Linux): the approval is refused, so the reason comes first.
  const unsigned = card?.required && !card.signs && !card.bypass && card.reason ? card.reason : null;
  if (!guard || (!guard.summary && !guard.labels.length && !guard.approvals.length && !card?.signs && !card?.bypass && !card?.offer && !unsigned)) return '';
  const decisions = guard.approvals.map((entry) => {
    const pill = APPROVAL_STATE_PILL[entry.state];
    return `<li><span class="pill ${escape(pill.tone)}" data-sfg-state="${escape(entry.state)}">${escape(pill.words)}</span>
      <strong>${escape(entry.actor)}</strong> ${escape(entry.decision)}<br><small>${escape(entry.label)}</small></li>`;
  }).join('');
  return `<section class="approval-sf-guard" aria-label="SF Guard">
    <h2>SF Guard</h2>
    ${guard.summary ? `<p data-sfg-summary>${escape(guard.summary)}</p>` : ''}
    ${guard.labels.length ? `<ul class="sfg-labels">${guard.labels.map((label) => `<li>${escape(label)}</li>`).join('')}</ul>` : ''}
    ${decisions ? `<h3>Decisions recorded on this step</h3><ul>${decisions}</ul>` : ''}
    ${card?.signs ? `<h3>What Touch ID signs</h3><pre class="sfg-card" data-sfg-card>${escape(guardCardText(card))}</pre>
    <p class="muted">Record approval signs this card: Touch ID asks right after you click, and nothing is recorded if you cancel it there.</p>` : ''}
    ${card?.bypass ? `<p data-sfg-bypass>${escape(card.reason ?? `Recorded unsigned, labelled "bypass: per-person exception ${card.bypass}".`)}</p>` : ''}
    ${card?.offer ? `<p class="muted" data-sfg-offer>${escape(card.offer)}</p>` : ''}
    ${unsigned ? `<p data-sfg-unsigned>SF Guard cannot sign this here: ${escape(unsigned)}.</p>` : ''}
    ${guard.summary || guard.labels.length ? '<p class="muted">Labels never refuse anything.</p>' : ''}
  </section>`;
}

export interface ApprovalReviewSubmission {
  confirmation: string;
  decisions: ApprovalChecklistDecision[];
  witnessDecisions: WitnessMappingDecision[];
  /** The approver's own decisions, recorded with the approval [SPEC-OAP M4]. */
  inApprovalDecisions?: InApprovalDecision[];
}

/** The answered in-approval decisions, checked against the request; a blank value takes its default. */
function inApprovalDecisions(request: ApprovalReviewRequest, raw: InboundMessage, errors: string[]): InApprovalDecision[] {
  const items = new Map((request.inApproval?.items ?? []).map((item) => [item.id, item]));
  const entries = Array.isArray(raw.inApprovalDecisions) ? raw.inApprovalDecisions : [];
  const answered: InApprovalDecision[] = [];
  for (const value of entries) {
    const entry = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
    const item = items.get(typeof entry.item === 'string' ? entry.item : '');
    const option = item?.options.find((candidate) => candidate.id === entry.option);
    if (!item || !option || answered.some((decision) => decision.item === item.id)) {
      errors.push(`Unknown or repeated decision '${String(entry.item ?? '(missing)')}'.`);
      continue;
    }
    const decision: InApprovalDecision = { item: item.id, option: option.id };
    for (const need of ['reason', 'expires', 'cause'] as const) {
      if (!option.needs?.[need]) continue;
      const typed = typeof entry[need] === 'string' ? (entry[need] as string).trim() : '';
      const chosen = typed || option.needs[need]?.default || '';
      if (!chosen) errors.push(`Give the ${need === 'expires' ? 'date' : need} for '${item.title}'.`);
      else decision[need] = chosen;
    }
    answered.push(decision);
  }
  return answered;
}

type SubmissionCheck = {
  value: ApprovalReviewSubmission | null;
  errors: string[];
};

/** Host-side validation; webview validation is usability, never authority. */
export function validateApprovalReviewSubmission(
  request: ApprovalReviewRequest,
  raw: InboundMessage
): SubmissionCheck {
  const confirmation = stringField(raw, 'confirmation') ?? '';
  const entries = Array.isArray(raw.decisions) ? raw.decisions : [];
  const decisions: ApprovalChecklistDecision[] = [];
  const witnessDecisions: WitnessMappingDecision[] = [];
  const errors: string[] = [];
  const expectedArticles = new Map(request.articles.map((article) => [article.id, article]));
  const seen = new Set<string>();

  for (const value of entries) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push('Every checklist answer must be a structured decision.');
      continue;
    }
    const entry = value as Record<string, unknown>;
    const article = typeof entry.article === 'string' ? entry.article : '';
    const decision = typeof entry.decision === 'string' ? entry.decision : '';
    const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
    if (!expectedArticles.has(article)) {
      errors.push(`Unknown checklist article '${article || '(missing)'}'.`);
      continue;
    }
    if (seen.has(article)) {
      errors.push(`Checklist article '${article}' was answered more than once.`);
      continue;
    }
    seen.add(article);
    if (!(APPROVAL_DECISIONS as readonly string[]).includes(decision)) {
      errors.push(`Choose a decision for '${article}'.`);
      continue;
    }
    if (decision !== 'satisfied' && !reason) {
      errors.push(`Explain why '${article}' is ${decision}.`);
      continue;
    }
    decisions.push({
      article,
      decision: decision as ApprovalChecklistDecision['decision'],
      ...(reason ? { reason } : {})
    });
  }
  for (const article of request.articles) {
    if (!seen.has(article.id)) errors.push(`Choose a decision for '${article.title}'.`);
  }
  const requestWitnessMappings = request.witnessMappings ?? [];
  const expectedMappings = new Map(requestWitnessMappings.map((mapping) => [mapping.mappingSha256, mapping]));
  const seenMappings = new Set<string>();
  const rawWitnessDecisions = Array.isArray(raw.witnessDecisions) ? raw.witnessDecisions : [];
  for (const value of rawWitnessDecisions) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push('Every witness mapping answer must be a structured decision.');
      continue;
    }
    const entry = value as Record<string, unknown>;
    const mappingSha256 = typeof entry.mappingSha256 === 'string' ? entry.mappingSha256 : '';
    const decision = typeof entry.decision === 'string' ? entry.decision : '';
    const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
    const expiresAt = typeof entry.expiresAt === 'string' ? entry.expiresAt.trim() : '';
    const inadequate = Array.isArray(entry.inadequate) ? entry.inadequate.filter((facet): facet is string => typeof facet === 'string') : [];
    const mapping = expectedMappings.get(mappingSha256);
    if (!mapping || seenMappings.has(mappingSha256)) {
      errors.push('A witness decision names a test this review does not list, or names one twice. Reopen the review.');
      continue;
    }
    seenMappings.add(mappingSha256);
    // A person reads a witness by its criterion and test file, never its mapping digest (owner, 2026-11-11).
    const named = `${mapping.clauseId} → ${mapping.sourcePath}`;
    // Only a criterion whose words changed since the step was submitted (or that is gone) stops it, as `approve` refuses it
    // (WEL_WITNESS_MAPPING_STALE). A criterion written as prose, with no Behavior or Observable fields, is decided from its
    // text: requiring both refused every test of a spec-driven Story [owner's Story arshy, 2026-11-20].
    if (mapping.clauseStatus !== 'current') {
      errors.push(witnessChangedWords(request, mapping));
      continue;
    }
    if (!(APPROVAL_DECISIONS as readonly string[]).includes(decision)) {
      errors.push(`Choose a decision for the witness ${named}.`);
      continue;
    }
    if (decision !== 'satisfied' && !reason) {
      errors.push(`Explain why the witness ${named} is ${decision}.`);
      continue;
    }
    if (decision === 'exception'
        && (!expiresAt || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) {
      errors.push(`Choose an expiry for the exception on the witness ${named}.`);
      continue;
    }
    if (decision === 'exception' && (!inadequate.length
        || inadequate.some((facet) => !(WITNESS_FACETS as readonly string[]).includes(facet)))) {
      errors.push(`Choose which part of the test falls short for the exception on the witness ${named}.`);
      continue;
    }
    witnessDecisions.push({
      mappingSha256,
      decision: decision as WitnessMappingDecision['decision'],
      ...(reason ? { reason } : {}),
      ...(decision === 'exception'
        ? { expiresAt, inadequate: WITNESS_FACETS.filter((facet) => inadequate.includes(facet)) } : {})
    });
  }
  for (const mapping of requestWitnessMappings) {
    if (!seenMappings.has(mapping.mappingSha256)) {
      errors.push(`Choose a decision for ${mapping.clauseId} → ${mapping.sourcePath}.`);
    }
  }
  // The person's choice of "Approve <Step> v<N>" is the one deliberate act; a self-approval is stated, as the CLI and
  // Copilot do, and recorded as self-approval by the engine. A second tick the engine never read added nothing.
  const answered = inApprovalDecisions(request, raw, errors);
  if (confirmation !== request.expected) errors.push(`Choose ${approvalChoice(request)} to approve it.`);
  return {
    value: errors.length ? null : { confirmation, decisions, witnessDecisions, ...(answered.length ? { inApprovalDecisions: answered } : {}) },
    errors
  };
}

/**
 * What an approval did, from the CLI's own result: its headline (approved and where the Story is now,
 * or an approval recorded that still needs more) and the first next step.
 */
export function approvalOutcome(output: string): { headline: string; next: string | null } {
  const lines = String(output ?? '').split(/\r?\n/u).map((line) => line.trim());
  const headline = [...lines].reverse().find((line) => /^Recorded an approval\b/u.test(line) || /^Approved \S+\. /u.test(line))
    ?? lines.find((line) => /^Approved \S+ by /u.test(line)) ?? 'Approval recorded.';
  const next = lines.find((line) => /^NOW\s+\S/u.test(line))?.replace(/^NOW\s+/u, '') ?? null;
  return { headline, next };
}

/**
 * The `approve` arguments for the reviewer's recorded answers, in the form the CLI parses
 * (src/commands/approve.mjs): a witness exception carries its facets, `exception:<facet>[,<facet>]`.
 */
export function storyApprovalArguments({ workId, phaseId, receiptToken, checklist, witnessDecisions, inApprovalDecisions: answered = [], decisionsDigest = null }: {
  workId: string; phaseId: string; receiptToken: string;
  checklist: ApprovalChecklistDecision[]; witnessDecisions: WitnessMappingDecision[];
  inApprovalDecisions?: InApprovalDecision[]; decisionsDigest?: string | null;
}): string[] {
  const argv = ['approve', workId, '--fetch', '--phase', phaseId, '--selection-receipt', receiptToken];
  for (const entry of checklist) {
    argv.push('--article', `${entry.article}=${entry.decision}`);
    if (entry.decision !== 'satisfied' && entry.reason) argv.push('--article-reason', entry.reason);
  }
  for (const entry of witnessDecisions) {
    const decision = entry.decision === 'exception' ? `exception:${(entry.inadequate ?? []).join(',')}` : entry.decision;
    argv.push('--witness-mapping', `${entry.mappingSha256}=${decision}`);
    if (entry.decision !== 'satisfied' && entry.reason) argv.push('--witness-mapping-reason', entry.reason);
    if (entry.decision === 'exception' && entry.expiresAt) argv.push('--witness-mapping-expires', entry.expiresAt);
  }
  // The approver's own decisions, with the list digest they were read from: one commit [SPEC-OAP M4].
  if (answered.length && decisionsDigest) {
    for (const entry of answered) {
      argv.push('--choose', `${entry.item}=${entry.option}`);
      for (const need of ['reason', 'expires', 'cause'] as const) if (entry[need]) argv.push(`--${need}`, `${entry.item}=${entry[need]}`);
    }
    argv.push('--decisions', decisionsDigest);
  }
  return argv;
}

function inApprovalItemHtml(item: InApprovalItem): string {
  const option = (entry: InApprovalItem['options'][number]) => `<option value="${escape(entry.id)}"`
    + ` data-needs="${escape(['reason', 'expires', 'cause'].filter((need) => entry.needs?.[need as 'reason']).join(' '))}"`
    + ` data-reason="${escape(entry.needs?.reason?.default ?? '')}" data-expires="${escape(entry.needs?.expires?.default ?? '')}"`
    + ` data-latest="${escape(entry.needs?.expires?.latest ?? '')}" data-cause="${escape(entry.needs?.cause?.default ?? '')}">`
    + `${escape(entry.label)}${entry.recommended ? ' (recommended)' : ''}</option>`;
  return `<fieldset class="approval-article approval-decision" data-item="${escape(item.id)}">
    <legend>${escape(item.title)}</legend>
    ${item.why ? `<p>${escape(item.why)}</p>` : ''}
    <label>Your decision
      <select data-choice aria-label="${escape(item.title)} decision"><option value="">Not now</option>${item.options.map(option).join('')}</select>
    </label>
    <label class="approval-reason" data-need="expires" hidden>Until <input type="date" data-value="expires"></label>
    <label class="approval-reason" data-need="cause" hidden>What stops the tests <textarea data-value="cause"></textarea></label>
    <label class="approval-reason" data-need="reason" hidden>Reason <textarea data-value="reason"></textarea></label>
  </fieldset>`;
}

const DECISION_OPTIONS = [
  ['', 'Choose a decision…'],
  ['satisfied', 'Satisfied'],
  ['exception', 'Exception'],
  ['not-applicable', 'Not applicable']
] as const;

function articleHtml(article: ApprovalReviewRequest['articles'][number]): string {
  return `<fieldset class="approval-article" data-article="${escape(article.id)}">
    <legend>${escape(article.title)}</legend>
    <p>${escape(article.question)}</p>
    <label>Decision
      <select data-decision required aria-label="${escape(article.title)} decision">
        ${DECISION_OPTIONS.map(([value, label]) =>
    `<option value="${escape(value)}">${escape(label)}</option>`).join('')}
      </select>
    </label>
    <label class="approval-reason">Reason <span>required for exception or not applicable</span>
      <textarea data-reason disabled aria-label="${escape(article.title)} reason"></textarea>
    </label>
  </fieldset>`;
}

/**
 * What the page says of a test whose criterion is no longer the one it was submitted against, and the way on: the step goes
 * back to its author, who submits it again against the criterion as it is now (Request changes, below).
 */
export function witnessChangedWords(request: Pick<ApprovalReviewRequest, 'phaseLabel' | 'generation'>, mapping: Pick<WitnessMappingReview, 'clauseId' | 'sourcePath' | 'clauseStatus'>): string {
  const step = `${request.phaseLabel} v${request.generation}`;
  return [mapping.clauseStatus === 'missing'
    ? `The criterion ${mapping.clauseId} is no longer in the Story's specification, so its test ${mapping.sourcePath} cannot be approved for it.`
    : `The criterion ${mapping.clauseId} changed after ${step} was submitted, so its test ${mapping.sourcePath} was checked against other words.`,
  `Choose Request changes: ${step} goes back to its author, who submits it again against the criterion as it is now.`].join(' ');
}

function witnessMappingHtml(mapping: WitnessMappingReview): string {
  // The criterion's own words always; Behavior and Observable only when the criterion states them.
  const fields = mapping.clauseFields?.behavior && mapping.clauseFields?.observable
    ? `<p><strong>Behavior:</strong> ${escape(mapping.clauseFields.behavior)}</p>
    <p><strong>Observable:</strong> ${escape(mapping.clauseFields.observable)}</p>` : '';
  return `<fieldset class="witness-mapping" data-mapping="${escape(mapping.mappingSha256)}">
    <legend>${escape(mapping.clauseId)} → ${escape(mapping.sourcePath)}</legend>
    ${fields}<p class="witness-criterion">${escape(mapping.clauseStatus === 'current' ? mapping.clauseText ?? 'The criterion is current; its words are not stored in this review.'
      : mapping.clauseStatus === 'missing' ? 'This criterion is no longer in the Story\'s specification.' : 'This criterion changed after the step was submitted.')}</p>
    <label>Decision
      <select data-decision required aria-label="${escape(mapping.clauseId)} witness decision">
        ${DECISION_OPTIONS.map(([value, label]) =>
    `<option value="${escape(value)}">${escape(label)}</option>`).join('')}
      </select>
    </label>
    <label class="approval-reason">Reason <span>required for exception or not applicable</span>
      <textarea data-reason disabled aria-label="${escape(mapping.clauseId)} witness reason"></textarea>
    </label>
    <fieldset class="approval-facets" data-facets disabled>
      <legend>Falls short on <span>required for an exception</span></legend>
      ${WITNESS_FACETS.map((facet) => `<label><input type="checkbox" data-facet="${facet}"> ${facet}</label>`).join('')}
    </fieldset>
    <label class="approval-expiry">Exception expiry
      <input type="date" data-expiry disabled aria-label="${escape(mapping.clauseId)} exception expiry">
    </label>
  </fieldset>`;
}

export function approvalReviewBody(request: ApprovalReviewRequest, errors: string[] = []): string {
  const binding = [
    `<strong>Story</strong><code>${escape(request.workId)}</code>`,
    `<strong>Phase</strong><code>${escape(request.phaseId)}</code>`,
    `<strong>Generation</strong><code>${request.generation}</code>`,
    // The approval binds the artifact's exact bytes; a person reads its path, never its digest (owner, 2026-11-11).
    request.artifact?.path ? `<strong>Artifact</strong><code>${escape(request.artifact.path)}</code>` : ''
  ].filter(Boolean).join('');
  const findings = request.findings.length
    ? `<details class="approval-evidence"><summary>Deterministic findings (${request.findings.length})</summary><ul>${
      request.findings.map((finding) => `<li><strong>${escape(finding.kind ?? 'finding')}</strong> ${escape(finding.message ?? '')}</li>`).join('')
    }</ul></details>`
    : '<p class="ok-text">No deterministic specification-quality findings are recorded.</p>';
  const witnessed = request.witnessedClauses
    ? `<details class="approval-evidence" open><summary>Witnessed clause structure (${request.witnessedClauses.analyzedClauseCount ?? 0}/${request.witnessedClauses.enrolledClauseCount ?? 0})</summary>
      <p class="muted">Structural facts only. This does not review witness semantics or prove the requirement.</p><ul>${
      (request.witnessedClauses.clauses ?? []).map((clause) => {
        const fields = Object.entries(clause.fields ?? {})
          .map(([name, field]) => `${escape(name)} <strong>${escape(field.status ?? 'unavailable')}</strong>`)
          .join(' · ');
        const witness = clause.witnessType ?? clause.declaredWitnessType ?? 'unavailable';
        return `<li><code>${escape(clause.clauseId ?? 'unknown clause')}</code> — ${fields} · witness <strong>${escape(witness)}</strong>${clause.enforceable ? ' (typed for future enforcement)' : ' (record only)'}</li>`;
      }).join('')
    }</ul></details>`
    : '';
  const prior = request.priorExceptions.length
    ? `<details class="approval-evidence"><summary>Earlier exceptions (${request.priorExceptions.length})</summary><ul>${
      request.priorExceptions.map((entry) => `<li><strong>${escape(entry.article ?? 'article')}</strong> — ${escape(entry.decision ?? 'exception')}${entry.reason ? `: ${escape(entry.reason)}` : ''}</li>`).join('')
    }</ul></details>` : '';
  const selfApproval = request.selfApproval ? `<section class="approval-self" aria-label="Self-approval warning">
    <h2>Self-approval — not independent review</h2>
    <p>The current Git identity generated this phase. The decision will be recorded as self-approval.</p>
  </section>` : '';
  const checklist = request.articles.length
    ? `<section><h2>Specification quality checklist</h2>
      <p class="muted">Answer every article yourself. Singularity Flow does not infer or preselect these decisions.</p>
      <div class="approval-checklist">${request.articles.map(articleHtml).join('')}</div></section>`
    : '<section><h2>Review decision</h2><p class="muted">This phase has no human specification-quality checklist.</p></section>';
  const witnessMappings = request.witnessMappings ?? [];
  const witnessReview = witnessMappings.length
    ? `<section><h2>Witness mapping decisions</h2>
      <p class="muted">Review semantic adequacy yourself. Exact identity and a passing local test do not prove the requirement.</p>
      <div class="approval-checklist">${witnessMappings.map(witnessMappingHtml).join('')}</div></section>`
    : '';
  const answerable = request.inApproval?.items ?? [];
  const decideHere = answerable.length ? `<section aria-label="Decide in this approval">
      <h2>Decide in this approval</h2>
      <p class="muted">${answerable.length === 1 ? 'This decision holds' : 'These decisions hold'} the step. What you choose is recorded with the approval, in the same commit; the approval is refused while one stays undecided.</p>
      <div class="approval-checklist">${answerable.map(inApprovalItemHtml).join('')}</div></section>` : '';
  // Only what the approval cannot answer still sends the person to the decision list first.
  const pending = request.pendingDecisions;
  const held = pending && pending.count > answerable.length ? `<section class="approval-held" aria-label="Decisions needed first">
    <h2>Decide what blocks this step first</h2>
    <p>${escape(pending.headline)}</p>
    <p class="muted">Approval is refused until each one is decided. They are listed in one place, in plain words with their choices.</p>
    <button type="button" data-decide>Decide what blocks this step</button>
  </section>` : '';
  // Never silent: what counts on a person's word instead of a run.
  const carried = request.carried?.entries?.length ? `<section class="approval-carried" aria-label="Evidence carried by still holds">
    <h2>Carried by "still holds"</h2><p class="muted">${escape(request.carried.words)}</p>
    <ul>${request.carried.entries.map((entry) => `<li>${escape(entry.words)}</li>`).join('')}</ul></section>` : '';
  const tests = request.testRun ? `<section class="approval-tests" aria-label="Test results">
    <h2>Test results</h2><p>${escape(request.testRun.totals)}${request.testRun.label ? ` · ${escape(request.testRun.label)}` : ''}</p>
    <button type="button" class="secondary" data-test-summary>Open test summary</button>
    <span class="muted">Every test case of this step's run, opened beside this review.</span>
  </section>` : '';
  const tryIt = tryItHtml(request.tryIt, (action, way, entry) => `data-try="${action}" data-try-way="${way}" data-try-entry="${entry}"`);
  return `<form class="approval-form" data-expected="${escape(request.expected)}">
    <div class="approval-review-content" tabindex="0" aria-label="Approval review details"><header>
      <h1>${escape(approvalChoice(request))}?</h1>
      <p class="meta">${escape(request.title)}. Review this version and answer any decision below, then choose ${escape(approvalChoice(request))}. Nothing is approved until you do.</p>
    </header>
    ${approvalChangeStoryHtml(request.changeStory)}${approvalFocusHtml(request.focus)}
    <div class="review-binding approval-binding">${binding}</div>
    ${approvalCoversHtml(request.covers)}${approvalDisputesHtml(request.disputes)}
    ${held}${approvalHoldsHtml(approvalHolds(request.approvalCheck), { except: ['STORY_REVIEW_INTERVENING_COMMIT'] })}${approvalBlockingCommitsHtml(approvalBlockingCommits(request.blockingCommits))}${carried}${tests}${tryIt}${sfGuardReviewHtml(request.sfGuard)}${findings}${witnessed}${prior}${selfApproval}${evidenceConsistencyHtml(request.evidenceConsistency)}
      ${decideHere}${checklist}${witnessReview}
      <section class="approval-confirmation">
        <h2>${escape(approvalChoice(request))}?</h2>
        <p class="muted">${escape(approvalChoice(request))} records your approval of this exact version, with your answers above. Nothing is chosen for you.</p>
      </section>
      <div class="approval-errors" role="alert">${errors.map((error) => `<p>${escape(error)}</p>`).join('')}</div>
    </div>
      <div class="form-actions">
        <p class="approval-progress muted" data-progress aria-live="polite"></p>
        <button type="submit" disabled>${escape(approvalChoice(request))}</button>
        <button type="button" class="secondary" data-cancel>Not now</button>
      </div>
    </form>`;
}

export const REVIEW_STYLE = `
html { height:100%; }
body { height:100vh; height:100dvh; display:flex; flex-direction:column; overflow:hidden; padding:0 .75rem; }
.approval-form { flex:1; min-height:0; display:grid; grid-template-rows:minmax(0,1fr) auto; }
.approval-review-content { min-height:0; overflow:auto; padding:0 .25rem .75rem; }
.approval-review-content h1, .approval-review-content code, .approval-confirmation label { overflow-wrap:anywhere; }
body > .page-nav { flex:none; flex-wrap:nowrap; overflow-x:auto; margin-top:.4rem; padding-block:.4rem; }
body > .page-nav button { flex:none; white-space:nowrap; }
.approval-binding { grid-template-columns:max-content minmax(0,1fr); margin:1rem 0; }
.approval-checklist { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(22rem,100%),1fr)); gap:.8rem; }
.approval-article, .witness-mapping { display:grid; gap:.65rem; min-width:0; padding:1rem; border:var(--sf-border); border-radius:var(--sf-radius); background:var(--sf-surface); }
.approval-article legend, .witness-mapping legend { padding:0 .35rem; font-weight:700; }
.approval-article p, .witness-mapping p { margin:0; color:var(--sf-dim); }
.approval-article label, .witness-mapping label { display:grid; gap:.3rem; font-weight:600; }
.approval-article select, .approval-article textarea, .witness-mapping select, .witness-mapping textarea, .witness-mapping input, .approval-confirmation input { width:100%; padding:.48rem .6rem; color:var(--vscode-input-foreground); background:var(--vscode-input-background); border:1px solid var(--vscode-input-border,var(--sf-border-color)); border-radius:3px; font:inherit; }
.approval-article textarea, .witness-mapping textarea { min-height:5rem; resize:vertical; }
.approval-reason span { color:var(--sf-dim); font-size:.75rem; font-weight:400; }
/* A field the chosen option does not need; the labels' own display would otherwise show it. */
.approval-decision [data-need][hidden] { display:none; }
.approval-reason:has(textarea:disabled) { opacity:.58; }
.approval-self { margin:1rem 0; padding:1rem; border:1px solid var(--sf-wait); border-left:4px solid var(--sf-wait); border-radius:var(--sf-radius); background:var(--vscode-inputValidation-warningBackground,var(--sf-surface)); }
.approval-self h2 { margin-top:0; color:var(--sf-wait); }
.approval-facets { display:flex; flex-wrap:wrap; gap:.4rem 1rem; margin:0; padding:.5rem .75rem; border:var(--sf-border); border-radius:var(--sf-radius); }
.approval-facets label { display:flex; gap:.35rem; align-items:center; font-weight:500; }
.approval-facets[disabled] { opacity:.55; }
.approval-evidence { margin:.65rem 0; padding:.65rem .8rem; border:var(--sf-border); border-radius:var(--sf-radius); }
.approval-confirmation { border-left:3px solid var(--sf-wait); padding-left:1rem; }
.approval-held { margin:1rem 0; padding:1rem; border:1px solid var(--sf-wait); border-left:4px solid var(--sf-wait); border-radius:var(--sf-radius); }
.approval-held h2 { margin-top:0; }
.approval-held pre { white-space:pre-wrap; overflow-wrap:anywhere; }
.approval-errors { min-height:1.2rem; color:var(--sf-bad); }
.approval-errors p { margin:.2rem 0; }
.form-actions { display:flex; gap:.6rem; flex-wrap:wrap; margin:0; padding:.6rem 0; border-top:var(--sf-border); background:var(--vscode-editor-background); }
.approval-progress { flex-basis:100%; margin:0; font-size:.85rem; }
.sfg-card { white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; margin:.4rem 0; padding:.6rem .75rem; border:var(--sf-border); border-radius:var(--sf-radius); }
.approval-change-story { margin:1rem 0; padding:1rem; border:var(--sf-border); border-left:4px solid var(--sf-ok); border-radius:var(--sf-radius); }
.approval-change-story h2 { margin-top:0; }
.approval-focus { margin:1rem 0; padding:1rem; border:1px solid var(--sf-wait); border-left:4px solid var(--sf-wait); border-radius:var(--sf-radius); }
.approval-focus h2, .approval-new h2 { margin-top:0; }
.approval-focus li { margin:.35rem 0; overflow-wrap:anywhere; }
.focus-at code { font-size:.85em; }
.focus-open { margin-left:.5rem; padding:.1rem .5rem; }
.focus-doc { margin:.6rem 0; padding:.6rem .8rem; border:var(--sf-border); border-radius:var(--sf-radius); }
.focus-doc h3 { margin:.1rem 0 .4rem; font-size:1rem; overflow-wrap:anywhere; }
.focus-diff, .focus-text { white-space:pre-wrap; overflow-wrap:anywhere; margin:.3rem 0; padding:.5rem .65rem; border:var(--sf-border); border-radius:var(--sf-radius); }
.focus-add { color:var(--vscode-gitDecoration-addedResourceForeground,var(--sf-ok)); }
.focus-del { color:var(--vscode-gitDecoration-deletedResourceForeground,var(--sf-bad)); }
${TRY_IT_STYLE}`;

export const REVIEW_SCRIPT = `
(function () {
  const form = document.querySelector('.approval-form');
  if (!form) return;
  const submit = form.querySelector('button[type="submit"]');
  const error = form.querySelector('.approval-errors');
  // Checklist articles only: a decision in this approval shares their look, not their fields.
  const rows = Array.from(form.querySelectorAll('.approval-article[data-article]'));
  const witnessRows = Array.from(form.querySelectorAll('.witness-mapping'));
  const decisionRows = Array.from(form.querySelectorAll('.approval-decision'));
  const progress = form.querySelector('[data-progress]');
  const api = window.__sfVscode;
  // Decisions survive a hidden tab or a host-side error re-render. The Yes is never remembered: it is
  // chosen fresh, every time.
  function facets(row) {
    return Array.from(row.querySelectorAll('[data-facet]')).filter((box) => box.checked).map((box) => box.dataset.facet);
  }
  function rowKey(row) { return row.dataset.article ? 'article:' + row.dataset.article : 'mapping:' + row.dataset.mapping; }
  function remember() {
    const saved = {};
    for (const row of rows.concat(witnessRows)) {
      saved[rowKey(row)] = {
        decision: row.querySelector('[data-decision]').value,
        reason: row.querySelector('[data-reason]').value,
        expiry: row.querySelector('[data-expiry]') ? row.querySelector('[data-expiry]').value : '',
        facets: facets(row)
      };
    }
    for (const row of decisionRows) {
      saved['item:' + row.dataset.item] = { choice: row.querySelector('[data-choice]').value,
        values: Object.fromEntries(Array.from(row.querySelectorAll('[data-value]')).map((field) => [field.dataset.value, field.value])) };
    }
    api.setState({ decisions: saved });
  }
  const restored = (api.getState() || {}).decisions || {};
  for (const row of rows.concat(witnessRows)) {
    const value = restored[rowKey(row)];
    if (!value) continue;
    row.querySelector('[data-decision]').value = value.decision || '';
    row.querySelector('[data-reason]').value = value.reason || '';
    if (row.querySelector('[data-expiry]')) row.querySelector('[data-expiry]').value = value.expiry || '';
    for (const box of row.querySelectorAll('[data-facet]')) box.checked = (value.facets || []).includes(box.dataset.facet);
  }
  // The approver's own decisions: each option shows only what it needs, starting from its default.
  function choose(row) {
    const selected = row.querySelector('[data-choice]').selectedOptions[0];
    const needs = (selected && selected.dataset.needs || '').split(' ').filter(Boolean);
    for (const label of row.querySelectorAll('[data-need]')) {
      const need = label.dataset.need;
      const field = label.querySelector('[data-value]');
      label.hidden = !needs.includes(need);
      if (label.hidden) { field.value = ''; continue; }
      if (!field.value) field.value = selected.dataset[need] || '';
      if (need === 'expires' && selected.dataset.latest) field.max = selected.dataset.latest;
    }
  }
  function inApprovalDecisions() {
    return decisionRows.filter((row) => row.querySelector('[data-choice]').value).map((row) => {
      const entry = { item: row.dataset.item, option: row.querySelector('[data-choice]').value };
      for (const field of row.querySelectorAll('[data-value]')) if (!field.closest('[data-need]').hidden) entry[field.dataset.value] = field.value.trim();
      return entry;
    });
  }
  for (const row of decisionRows) {
    row.querySelector('[data-choice]').addEventListener('change', function () { choose(row); });
    const value = restored['item:' + row.dataset.item];
    if (!value) continue;
    row.querySelector('[data-choice]').value = value.choice || '';
    for (const field of row.querySelectorAll('[data-value]')) field.value = (value.values || {})[field.dataset.value] || '';
    choose(row);
  }
  function decisions() {
    return rows.map((row) => ({
      article: row.dataset.article,
      decision: row.querySelector('[data-decision]').value,
      reason: row.querySelector('[data-reason]').value.trim()
    }));
  }
  function witnessDecisions() {
    return witnessRows.map((row) => ({
      mappingSha256: row.dataset.mapping,
      decision: row.querySelector('[data-decision]').value,
      reason: row.querySelector('[data-reason]').value.trim(),
      expiresAt: row.querySelector('[data-expiry]').value,
      inadequate: facets(row)
    }));
  }
  function valid() {
    const complete = [...decisions(), ...witnessDecisions()].every((entry) => entry.decision
      && (entry.decision === 'satisfied' || entry.reason)
      && (entry.decision !== 'exception' || !('expiresAt' in entry) || (entry.expiresAt && entry.inadequate.length)));
    return complete;
  }
  function sync(event) {
    for (const row of rows) {
      const decision = row.querySelector('[data-decision]').value;
      const reason = row.querySelector('[data-reason]');
      const needed = decision && decision !== 'satisfied';
      reason.disabled = !needed;
      reason.required = Boolean(needed);
      if (!needed) reason.value = '';
    }
    for (const row of witnessRows) {
      const decision = row.querySelector('[data-decision]').value;
      const reason = row.querySelector('[data-reason]');
      const expiry = row.querySelector('[data-expiry]');
      const reasonNeeded = decision && decision !== 'satisfied';
      const expiryNeeded = decision === 'exception';
      reason.disabled = !reasonNeeded;
      reason.required = Boolean(reasonNeeded);
      expiry.disabled = !expiryNeeded;
      expiry.required = expiryNeeded;
      const facetSet = row.querySelector('[data-facets]');
      facetSet.disabled = !expiryNeeded;
      if (!expiryNeeded) for (const box of facetSet.querySelectorAll('[data-facet]')) box.checked = false;
      if (!reasonNeeded) reason.value = '';
      if (!expiryNeeded) expiry.value = '';
    }
    submit.disabled = !valid();
    describeMissing();
    if (event) { error.textContent = ''; remember(); }
  }
  // A disabled button alone never says why; this line does, as the reviewer works.
  function describeMissing() {
    const entries = decisions().concat(witnessDecisions());
    const count = (n, one, many) => n + ' ' + (n === 1 ? one : many);
    const missing = [];
    const undecided = entries.filter((entry) => !entry.decision).length;
    const reasons = entries.filter((entry) => entry.decision && entry.decision !== 'satisfied' && !entry.reason).length;
    const expiries = witnessDecisions().filter((entry) => entry.decision === 'exception' && !entry.expiresAt).length;
    const shortfalls = witnessDecisions().filter((entry) => entry.decision === 'exception' && !entry.inadequate.length).length;
    if (undecided) missing.push(count(undecided, 'decision', 'decisions'));
    if (reasons) missing.push(count(reasons, 'reason', 'reasons'));
    if (expiries) missing.push(count(expiries, 'expiry date', 'expiry dates'));
    if (shortfalls) missing.push(count(shortfalls, 'choice of what falls short', 'choices of what falls short'));
    const text = missing.length ? 'Still needed: ' + missing.join(', ') + '.' : 'Ready when you are.';
    if (progress && progress.textContent !== text) progress.textContent = text;
  }
  form.addEventListener('input', sync);
  form.addEventListener('change', sync);
  form.querySelector('[data-cancel]').addEventListener('click', function () {
    window.__sfVscode.postMessage({ type: 'approval.cancel' });
  });
  const decide = form.querySelector('[data-decide]');
  if (decide) decide.addEventListener('click', function () { window.__sfVscode.postMessage({ type: 'approval.decide' }); });
  const tests = form.querySelector('[data-test-summary]');
  if (tests) tests.addEventListener('click', function () { window.__sfVscode.postMessage({ type: 'approval.testSummary' }); });
  const change = form.querySelector('[data-change-story]');
  if (change) change.addEventListener('click', function () { window.__sfVscode.postMessage({ type: 'approval.changeStory' }); });
  // Try it: only which way and which entry; the panel looks the address or the text up in what it loaded.
  Array.from(form.querySelectorAll('[data-try]')).forEach(function (button) {
    button.addEventListener('click', function () {
      window.__sfVscode.postMessage({ type: 'approval.tryIt', action: button.dataset.try,
        way: Number(button.dataset.tryWay), entry: Number(button.dataset.tryEntry) });
    });
  });
  // An item of "What needs your eyes", or a document: its file opens at its line beside the review.
  for (const open of form.querySelectorAll('[data-open]')) open.addEventListener('click', function () {
    window.__sfVscode.postMessage({ type: 'approval.open', path: open.dataset.open, line: Number(open.dataset.line) || 0 });
  });
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    sync();
    if (!valid()) {
      error.textContent = 'Complete every decision and required reason first.';
      return;
    }
    window.__sfVscode.postMessage({
      type: 'approval.submit',
      confirmation: form.dataset.expected,
      decisions: decisions(),
      witnessDecisions: witnessDecisions(),
      inApprovalDecisions: inApprovalDecisions()
    });
    submit.disabled = true;
  });
  sync();
})();
`;

let activePanel: vscode.WebviewPanel | null = null;

/** Open one review form and resolve only after a validated human submission. */
export function collectApprovalReview(
  request: ApprovalReviewRequest
): Promise<ApprovalReviewSubmission | null> {
  activePanel?.dispose();
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.approvalReview',
      request.title,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: false }
    );
    activePanel = panel;
    let settled = false;
    const render = (errors: string[] = []) => {
      const token = nonce();
      panel.webview.html = page(
        request.title,
        `<style nonce="${token}">${REVIEW_STYLE}</style>${approvalReviewBody(request, errors)}`,
        contentSecurityPolicy(panel.webview, token),
        token,
        REVIEW_SCRIPT
      );
    };
    const finish = (value: ApprovalReviewSubmission | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
      panel.dispose();
    };
    const router = registerMessageRouter('singularityFlow.approvalReview', {
      'approval.cancel': () => finish(null),
      // Held by pending decisions: close this review and open the decision list for the same step.
      'approval.decide': () => {
        if (!request.pendingDecisions?.count) return;
        finish(null);
        void vscode.commands.executeCommand('singularityFlow.decisions', { workId: request.workId, phase: request.phaseId });
      },
      // The review stays open: the summary opens beside it, for the same Story step.
      'approval.testSummary': () => {
        if (!request.testRun) return;
        void vscode.commands.executeCommand('singularityFlow.testSummary', { workId: request.workId, phase: request.phaseId, beside: true });
      },
      // The page of what the change does, in a Markdown preview beside the review, which stays open [CSP:REQ-007].
      'approval.changeStory': () => {
        const story = request.changeStory;
        if (!story || !request.repository) return;
        void vscode.commands.executeCommand('markdown.showPreviewToSide', vscode.Uri.joinPath(vscode.Uri.file(request.repository), ...story.path.split('/')))
          .then(undefined, () => undefined);
      },
      // Optional, and never a reason to stop: it opens or copies what the panel loaded, and records nothing.
      'approval.tryIt': (message) => {
        const way = typeof message.way === 'number' && Number.isInteger(message.way) ? message.way : null;
        const entry = typeof message.entry === 'number' && Number.isInteger(message.entry) ? message.entry : null;
        if (message.action === 'open') {
          const url = tryItOpenUrl(request.tryIt, way);
          if (url) void vscode.env.openExternal(url as unknown as vscode.Uri);
          return;
        }
        const copied = message.action === 'copy' ? tryItCopyText(request.tryIt, way, entry) : null;
        if (copied) void vscode.env.clipboard.writeText(copied).then(() => vscode.window.setStatusBarMessage('$(clippy) Copied. Paste it in a terminal to try the change.', 4_000));
      },
      // Only a file the focus names, inside the Story's checkout, opens: at its line, beside the review, which stays open.
      'approval.open': (message) => {
        const file = stringField(message, 'path');
        const named = new Set([...(request.focus?.eyes.items ?? []), ...(request.focus?.eyes.more ?? [])].map((item) => item.at?.path)
          .concat((request.focus?.documents ?? []).map((document) => document.path)).filter((entry): entry is string => typeof entry === 'string'));
        if (!file || !request.repository || !named.has(file) || file.split('/').includes('..')) return;
        const line = Math.max(0, Math.floor(Number((message as { line?: unknown }).line) || 0) - 1);
        void vscode.window.showTextDocument(vscode.Uri.joinPath(vscode.Uri.file(request.repository), ...file.split('/')),
          { viewColumn: vscode.ViewColumn.Beside, preview: true, selection: new vscode.Range(line, 0, line, 0) }).then(undefined, () => undefined);
      },
      'approval.submit': (message) => {
        const checked = validateApprovalReviewSubmission(request, message);
        if (!checked.value) return render(checked.errors);
        finish(checked.value);
      }
    });
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) {
        finish(null);
        return void navigateTo(navigation);
      }
      router.route(raw);
    });
    panel.onDidDispose(() => {
      if (activePanel === panel) activePanel = null;
      if (!settled) { settled = true; resolve(null); }
    });
    render();
  });
}
