import { escape } from './webview.ts';
type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};

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
  const riskItems = Array.isArray(risks.items) ? risks.items.map(object) : [];
  const documentRisks = Array.isArray(artifactQuality.items) ? artifactQuality.items.map(object) : [];
  return `<header><h1>Resolve phase issues</h1><p>${escape(String(data.workId ?? 'Story'))} · ${escape(String(data.phaseId ?? ''))}</p></header>
    <p>Opening this screen runs no tests and makes no changes. Scope accounting, intent changes, risk decisions and phase approval are separate.</p>
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
    <button class="secondary" data-action="tests">Tests, documents and eligible risks…</button>
    <button class="secondary" data-action="repair">Review a bounded repair plan…</button>
    <button class="secondary" data-action="resume">Resume a recorded repair…</button>
    <button class="secondary" data-action="checkpoint">Save recovery copies</button>
    <button class="secondary" data-action="refresh">Recheck</button>
    <p>Failed, skipped or unavailable tests remain labelled as such. Protected configuration and trust failures require their owning authority. No automatic risk acceptance or phase advance.</p>`;
}
