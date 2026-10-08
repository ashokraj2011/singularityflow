import { escape } from './webview.ts';
type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};

/** Display suggestions only; the correction command revalidates every path and clause. */
export function pendingEvidenceSuggestions(result: unknown): { path: string; clauses: string[] }[] {
  const envelope = object(result); const data = object(envelope.data ?? envelope);
  const recovery = object(data.recovery); const inspection = object(data.inspection);
  const byPath = new Map<string, string[]>();
  for (const action of Array.isArray(recovery.actions) ? recovery.actions.map(object) : []) {
    const evidence = object(action.evidence);
    if (typeof evidence.path === 'string' && evidence.path.includes('/evidence/')) byPath.set(evidence.path,
      Array.isArray(evidence.eligibleClauseIds) ? evidence.eligibleClauseIds.filter((id): id is string =>
        typeof id === 'string' && /^[A-Z0-9][A-Z0-9._-]{0,63}:AC-\d{3}$/u.test(id)) : []);
  }
  for (const finding of Array.isArray(inspection.findings) ? inspection.findings.map(object) : []) {
    if (finding.code === 'phase.evidence-contract.not-ready' && typeof finding.path === 'string'
        && finding.path.includes('/evidence/') && !byPath.has(finding.path)) byPath.set(finding.path, []);
  }
  return [...byPath].map(([path, clauses]) => ({ path, clauses }));
}

/** Repository text is display-only: it never supplies command IDs, paths to open or executable HTML. */
export function phaseIssuesBody(result: unknown): string {
  const envelope = object(result);
  const data = object(envelope.data ?? envelope);
  const resolution = object(data.resolution);
  const issues = Array.isArray(resolution.issues) ? resolution.issues.map(object) : [];
  const appeals = object(data.appeals);
  const items = Array.isArray(appeals.items) ? appeals.items.map(object) : [];
  const repair = object(data.repairLoop);
  const quality = object(data.quality);
  const risks = object(quality.risks);
  const artifactQuality = object(data.artifactQuality);
  const journey = object(data.journey);
  const witnesses = (Array.isArray(journey.witnesses) ? journey.witnesses.map(object) : []).filter(w => w.status !== 'met');
  const riskItems = Array.isArray(risks.items) ? risks.items.map(object) : [];
  const documentRisks = Array.isArray(artifactQuality.items) ? artifactQuality.items.map(object) : [];
  return `<header><h1>Resolve phase issues</h1><p>${escape(String(data.workId ?? 'Story'))} · ${escape(String(data.phaseId ?? ''))}</p></header>
    <p>Opening this screen runs no tests and makes no changes. Scope accounting, intent changes, risk decisions and phase approval are separate.</p>
    <section><h2>Continuation</h2><p>${escape(String(journey.state ?? 'Recheck required'))} · ${escape(String(object(journey.build).description ?? 'Build identity unavailable'))}</p>
      ${journey.lastRefusal ? `<p>Last refusal: ${escape(String(journey.lastRefusal))}</p>` : ''}
      ${journey.diagnostic ? `<details><summary>Bounded failure diagnostic</summary><pre>${escape(String(journey.diagnostic))}</pre></details>` : ''}
      <p>Draft repairs may continue while a human evidence decision is pending. Classification does not establish a visual pass. Guarded continuation can publish and submit, but never approve or accept risk.</p>
      <button data-action="continue">Review guarded continuation…</button></section>
    <section><h2>Visual and inspection witnesses</h2>${witnesses.length ? witnesses.map(w => `<article class="card"><b>${escape(String(w.clauseId))} · ${escape(String(w.slot))}</b>
      <p>${escape(String(w.status))} · ${escape(Array.isArray(w.files) ? w.files.map(String).join(', ') : '')}</p>
      <p>After submission pins fresh candidate/test evidence, an authorized human must inspect the exact candidate and file, then answer each checklist item. Contract correction is not this decision.</p></article>`).join('')
      + '<button class="secondary" data-action="witness">Prepare human witness review…</button>' : '<p>No outstanding explicit witness contract was found.</p>'}</section>
    <section><h2>Issues and owners</h2>${issues.length ? issues.map(issue => `<article class="card"><h3>${escape(String(issue.code ?? 'Unknown finding'))}</h3>
      <p>${escape(String(issue.path ?? ''))} · ${escape(String(issue.status ?? 'needs-owner'))}</p>
      ${Array.isArray(issue.choices) ? issue.choices.map(object).map(choice => `<p><b>${escape(String(choice.owner ?? 'Owner'))}</b>: ${escape(String(choice.detail ?? 'Inspect recovery'))}</p>`).join('') : ''}</article>`).join('')
      : '<p>No issue was reported by this inspection. Normal transition checks still run.</p>'}</section>
    <section><h2>Appeals</h2>${items.length ? `<table><thead><tr><th>Appeal</th><th>Phase</th><th>Status</th></tr></thead><tbody>${items.map(item => `<tr><td>${escape(String(item.id ?? ''))}</td><td>${escape(String(item.phaseId ?? ''))}</td><td>${escape(String(item.status ?? ''))}</td></tr>`).join('')}</tbody></table>` : '<p>No retained appeals for this phase.</p>'}</section>
    <section><h2>Recorded repair loop</h2><p>${escape(String(repair.status ?? 'Inspect the repair plan'))} · ${escape(String(repair.consumed ?? 0))}/${escape(String(repair.maximum ?? 3))} attempts used.</p>
      <p>Attempts survive restarts. Exhausting automation does not prevent reviewed manual repair. Producer repairs save private recovery copies first; no test success or approval is implied.</p></section>
    <section><h2>Review-document quality</h2><p>Accepted shortfalls remain unmet, not passed. Acceptance binds the authored documents and approved upstream state.</p>
      <p>${escape(artifactQuality.excepted === true ? 'The recorded document-quality exception applies.' : 'Repair the draft or review an eligible exact exception.')}</p>
      ${Array.isArray(artifactQuality.remaining) ? artifactQuality.remaining.map(object).map(finding => `<p>${escape(String(finding.code ?? ''))} · ${escape(String(finding.path ?? ''))}</p>`).join('') : ''}
      ${documentRisks.length ? `<table><thead><tr><th>Risk</th><th>Status</th><th>Expires</th><th>Reason</th></tr></thead><tbody>${documentRisks.map(item => `<tr><td>${escape(String(item.id ?? ''))}</td><td>${escape(String(item.status ?? ''))}</td><td>${escape(String(item.expiresAt ?? ''))}</td><td>${escape(String(item.reason ?? ''))}</td></tr>`).join('')}</tbody></table>` : ''}
    </section>
    <section><h2>Pilot coverage risks</h2><p>Gate mode: ${escape(String(risks.gateMode ?? 'hard'))}. Soft mode still requires exact human review.</p>
      <p>Remaining: ${escape(Array.isArray(risks.remaining) ? risks.remaining.map(String).join(', ') || 'none' : 'not inspected')}.</p>
      ${riskItems.length ? `<table><thead><tr><th>Risk</th><th>Status</th><th>Expires</th><th>Reason</th></tr></thead><tbody>${riskItems.map(item => `<tr><td>${escape(String(item.id ?? ''))}</td><td>${escape(String(item.status ?? ''))}</td><td>${escape(String(item.expiresAt ?? ''))}</td><td>${escape(String(item.reason ?? ''))}</td></tr>`).join('')}</tbody></table>` : '<p>No accepted pilot coverage risks.</p>'}
      ${(risks.eligible === true && risks.excepted !== true) || (artifactQuality.eligible === true && artifactQuality.excepted !== true) ? '<button class="secondary" data-action="risk">Review exact quality risk…</button>' : ''}
    </section>
    <button data-action="appeal">Explain extra work in Copilot</button>
    <button class="secondary" data-action="review">Review an exact appeal…</button>
    <button class="secondary" data-action="evidence">Review evidence correction…</button>
    <button class="secondary" data-action="tests">Tests, documents and eligible risks…</button>
    <button class="secondary" data-action="repair">Review a bounded repair plan…</button>
    <button class="secondary" data-action="resume">Resume a recorded repair…</button>
    <button class="secondary" data-action="checkpoint">Save recovery copies</button>
    <button class="secondary" data-action="refresh">Recheck</button>
    <p>Failed, skipped or unavailable tests remain labelled as such. Protected configuration and trust failures require their owning authority. No automatic risk acceptance or phase advance.</p>`;
}
