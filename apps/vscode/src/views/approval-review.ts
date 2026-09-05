/**
 * The human approval ceremony for a Story phase.
 *
 * Specification-quality articles are deliberately not model-decidable. The extension therefore
 * renders the exact checklist carried by the review bundle, leaves every decision empty, requires
 * reasons for exceptions and not-applicable decisions, and requires the phase confirmation to be
 * typed. Nothing is inferred or preselected on behalf of the reviewer.
 */
import * as vscode from 'vscode';

import {
  booleanField, registerMessageRouter, stringField, type InboundMessage
} from './messages.ts';
import { navigateTo } from './navigate.ts';
import { contentSecurityPolicy, escape, navigationTarget, nonce, page } from './webview.ts';

export const APPROVAL_DECISIONS = ['satisfied', 'exception', 'not-applicable'] as const;
export type ApprovalChecklistDecision = {
  article: string;
  decision: typeof APPROVAL_DECISIONS[number];
  reason?: string;
};
export type WitnessMappingDecision = {
  mappingSha256: string;
  decision: typeof APPROVAL_DECISIONS[number];
  reason?: string;
  expiresAt?: string;
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
  priorExceptions: Array<{ article?: string; decision?: string; reason?: string; actor?: string }>;
  selfApproval: boolean;
}

export interface ApprovalReviewSubmission {
  confirmation: string;
  decisions: ApprovalChecklistDecision[];
  witnessDecisions: WitnessMappingDecision[];
  acknowledgeSelfApproval: boolean;
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
  const acknowledgeSelfApproval = booleanField(raw, 'acknowledgeSelfApproval');
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
    const mapping = expectedMappings.get(mappingSha256);
    if (!mapping || seenMappings.has(mappingSha256)) {
      errors.push(`Unknown or repeated witness mapping '${mappingSha256 || '(missing)'}'.`);
      continue;
    }
    seenMappings.add(mappingSha256);
    if (mapping.clauseStatus !== 'current' || !mapping.clauseText
        || !mapping.clauseFields?.behavior || !mapping.clauseFields?.observable) {
      errors.push(`Witness mapping '${mappingSha256}' no longer has its exact reviewed clause bytes.`);
      continue;
    }
    if (!(APPROVAL_DECISIONS as readonly string[]).includes(decision)) {
      errors.push(`Choose a decision for witness mapping '${mappingSha256}'.`);
      continue;
    }
    if (decision !== 'satisfied' && !reason) {
      errors.push(`Explain why witness mapping '${mappingSha256}' is ${decision}.`);
      continue;
    }
    if (decision === 'exception'
        && (!expiresAt || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) {
      errors.push(`Choose an expiry for witness mapping exception '${mappingSha256}'.`);
      continue;
    }
    witnessDecisions.push({
      mappingSha256,
      decision: decision as WitnessMappingDecision['decision'],
      ...(reason ? { reason } : {}),
      ...(decision === 'exception' ? { expiresAt } : {})
    });
  }
  for (const mapping of requestWitnessMappings) {
    if (!seenMappings.has(mapping.mappingSha256)) {
      errors.push(`Choose a decision for ${mapping.clauseId} → ${mapping.sourcePath}.`);
    }
  }
  if (confirmation !== request.expected) errors.push(`Type exactly '${request.expected}' to approve.`);
  if (request.selfApproval && !acknowledgeSelfApproval) {
    errors.push('Acknowledge that this is self-approval and is not independent review.');
  }
  return {
    value: errors.length ? null : {
      confirmation, decisions, witnessDecisions, acknowledgeSelfApproval
    },
    errors
  };
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

function witnessMappingHtml(mapping: WitnessMappingReview): string {
  return `<fieldset class="witness-mapping" data-mapping="${escape(mapping.mappingSha256)}">
    <legend>${escape(mapping.clauseId)} → ${escape(mapping.sourcePath)}</legend>
    <p><strong>Behavior:</strong> ${escape(mapping.clauseFields?.behavior ?? 'unavailable')}</p>
    <p><strong>Observable:</strong> ${escape(mapping.clauseFields?.observable ?? 'unavailable')}</p>
    <details><summary>Exact clause and identity</summary>
      <p>${escape(mapping.clauseText ?? 'Exact clause bytes are stale or unavailable.')}</p>
      <code>${escape(mapping.logicalTestId)}</code><br><code>${escape(mapping.sourceDeclarationSha256)}</code>
    </details>
    <label>Decision
      <select data-decision required aria-label="${escape(mapping.clauseId)} witness decision">
        ${DECISION_OPTIONS.map(([value, label]) =>
    `<option value="${escape(value)}">${escape(label)}</option>`).join('')}
      </select>
    </label>
    <label class="approval-reason">Reason <span>required for exception or not applicable</span>
      <textarea data-reason disabled aria-label="${escape(mapping.clauseId)} witness reason"></textarea>
    </label>
    <label class="approval-expiry">Exception expiry
      <input type="date" data-expiry disabled aria-label="${escape(mapping.clauseId)} exception expiry">
    </label>
  </fieldset>`;
}

function reviewBody(request: ApprovalReviewRequest, errors: string[] = []): string {
  const binding = [
    `<strong>Story</strong><code>${escape(request.workId)}</code>`,
    `<strong>Phase</strong><code>${escape(request.phaseId)}</code>`,
    `<strong>Generation</strong><code>${request.generation}</code>`,
    request.artifact?.path ? `<strong>Artifact</strong><code>${escape(request.artifact.path)}</code>` : '',
    request.artifact?.sha256 ? `<strong>SHA-256</strong><code>${escape(request.artifact.sha256)}</code>` : ''
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
    <label><input type="checkbox" data-self-approval> I understand and want to record this self-approval.</label>
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
  return `<header>
      <h1>${escape(request.title)}</h1>
      <p class="meta">Review the exact generation, record every required decision, then type the phase confirmation.</p>
    </header>
    <div class="review-binding approval-binding">${binding}</div>
    ${findings}${witnessed}${prior}${selfApproval}
    <form class="approval-form" data-expected="${escape(request.expected)}">
      ${checklist}${witnessReview}
      <section class="approval-confirmation">
        <h2>Confirm the exact decision</h2>
        <label for="approval-confirm">Type <code>${escape(request.expected)}</code></label>
        <input id="approval-confirm" data-confirmation autocomplete="off" spellcheck="false"
          placeholder="${escape(request.expected)}">
        <p class="muted">This value is never filled in or remembered.</p>
      </section>
      <div class="approval-errors" role="alert">${errors.map((error) => `<p>${escape(error)}</p>`).join('')}</div>
      <div class="form-actions">
        <button type="submit" disabled>Record approval</button>
        <button type="button" class="secondary" data-cancel>Cancel</button>
      </div>
    </form>`;
}

const REVIEW_STYLE = `
.approval-binding { grid-template-columns:max-content minmax(0,1fr); margin:1rem 0; }
.approval-checklist { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(22rem,100%),1fr)); gap:.8rem; }
.approval-article, .witness-mapping { display:grid; gap:.65rem; min-width:0; padding:1rem; border:var(--sf-border); border-radius:var(--sf-radius); background:var(--sf-surface); }
.approval-article legend, .witness-mapping legend { padding:0 .35rem; font-weight:700; }
.approval-article p, .witness-mapping p { margin:0; color:var(--sf-dim); }
.approval-article label, .witness-mapping label { display:grid; gap:.3rem; font-weight:600; }
.approval-article select, .approval-article textarea, .witness-mapping select, .witness-mapping textarea, .witness-mapping input, .approval-confirmation input { width:100%; padding:.48rem .6rem; color:var(--vscode-input-foreground); background:var(--vscode-input-background); border:1px solid var(--vscode-input-border,var(--sf-border-color)); border-radius:3px; font:inherit; }
.approval-article textarea, .witness-mapping textarea { min-height:5rem; resize:vertical; }
.approval-reason span { color:var(--sf-dim); font-size:.75rem; font-weight:400; }
.approval-reason:has(textarea:disabled) { opacity:.58; }
.approval-self { margin:1rem 0; padding:1rem; border:1px solid var(--sf-wait); border-left:4px solid var(--sf-wait); border-radius:var(--sf-radius); background:var(--vscode-inputValidation-warningBackground,var(--sf-surface)); }
.approval-self h2 { margin-top:0; color:var(--sf-wait); }
.approval-self label { display:flex; gap:.5rem; align-items:flex-start; margin-top:.7rem; font-weight:650; }
.approval-evidence { margin:.65rem 0; padding:.65rem .8rem; border:var(--sf-border); border-radius:var(--sf-radius); }
.approval-confirmation { border-left:3px solid var(--sf-wait); padding-left:1rem; }
.approval-errors { min-height:1.2rem; color:var(--sf-bad); }
.approval-errors p { margin:.2rem 0; }
.form-actions { display:flex; gap:.6rem; flex-wrap:wrap; margin-top:1rem; }
`;

const REVIEW_SCRIPT = `
(function () {
  const form = document.querySelector('.approval-form');
  if (!form) return;
  const submit = form.querySelector('button[type="submit"]');
  const error = form.querySelector('.approval-errors');
  const rows = Array.from(form.querySelectorAll('.approval-article'));
  const witnessRows = Array.from(form.querySelectorAll('.witness-mapping'));
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
      expiresAt: row.querySelector('[data-expiry]').value
    }));
  }
  function valid() {
    const complete = [...decisions(), ...witnessDecisions()].every((entry) => entry.decision
      && (entry.decision === 'satisfied' || entry.reason)
      && (entry.decision !== 'exception' || !('expiresAt' in entry) || entry.expiresAt));
    const confirmed = form.querySelector('[data-confirmation]').value === form.dataset.expected;
    const self = form.querySelector('[data-self-approval]');
    return complete && confirmed && (!self || self.checked);
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
      if (!reasonNeeded) reason.value = '';
      if (!expiryNeeded) expiry.value = '';
    }
    submit.disabled = !valid();
    if (event) error.textContent = '';
  }
  form.addEventListener('input', sync);
  form.addEventListener('change', sync);
  form.querySelector('[data-cancel]').addEventListener('click', function () {
    window.__sfVscode.postMessage({ type: 'approval.cancel' });
  });
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    sync();
    if (!valid()) {
      error.textContent = 'Complete every decision, required reason, acknowledgement, and exact confirmation.';
      return;
    }
    window.__sfVscode.postMessage({
      type: 'approval.submit',
      confirmation: form.querySelector('[data-confirmation]').value,
      acknowledgeSelfApproval: Boolean(form.querySelector('[data-self-approval]')?.checked),
      decisions: decisions(),
      witnessDecisions: witnessDecisions()
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
        `<style nonce="${token}">${REVIEW_STYLE}</style>${reviewBody(request, errors)}`,
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
