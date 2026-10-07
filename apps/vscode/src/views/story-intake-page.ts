import type { StoryArtifact, StoryWorkflow } from '../cli/snapshot.ts';
import { escape } from './webview.ts';

export interface IntakeDocumentPreview {
  record?: { id?: string; path?: string };
  content?: string | null;
  binary?: boolean;
  truncated?: boolean;
  verifiedSha256?: string;
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const display = (value: unknown): string => value == null || value === '' ? 'Not recorded'
  : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const row = (label: string, value: unknown): string => `<tr><th scope="row">${escape(label)}</th><td class="intake-value">${escape(display(value))}</td></tr>`;

/** Saved intake is data, never executable Markdown, HTML, URLs or command selectors. */
export function storyIntakeBody(workflow: StoryWorkflow, preview: IntakeDocumentPreview, documents: StoryArtifact[] = []): string {
  if (preview.record?.id !== 'SYS-SOURCE' || preview.binary || typeof preview.content !== 'string') {
    throw new Error('The engine did not return the selected Story source document.');
  }
  let source: Record<string, unknown> | null = null;
  if (!preview.truncated) {
    try {
      const parsed: unknown = JSON.parse(preview.content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) source = object(parsed);
    } catch { /* Show the returned bytes honestly; never fabricate missing intake fields. */ }
  }
  const work = object(workflow.workItem);
  const resolution = object(workflow.resolution);
  const capability = object(resolution.capability);
  const references = Array.isArray(resolution.referenceRepositories) ? resolution.referenceRepositories.map(object) : [];
  const evidence = documents.filter(document => ['file', 'url', 'package'].includes(document.type ?? ''));
  const fields: Array<[string, string]> = [
    ['title', 'Title'], ['user', 'User or audience'], ['audience', 'Audience'], ['description', 'Description'],
    ['problem', 'Problem'], ['desiredOutcome', 'Desired outcome'], ['scope', 'Scope'], ['outOfScope', 'Out of scope'],
    ['acceptanceCriteria', 'Acceptance criteria'], ['constraints', 'Constraints'], ['dependencies', 'Dependencies'],
    ['risks', 'Risks'], ['stakeholders', 'Stakeholders'], ['priority', 'Priority'], ['urgency', 'Urgency'], ['notes', 'Notes']
  ];
  return `<header><h1>Story intake details</h1><p>${escape(workflow.workItem.id)} · ${escape(workflow.workItem.title ?? 'Story')}</p></header>
    <p class="muted">Read-only saved input, not a generated phase artifact. Opening this page does not restart intake, change the Story, run tests or grant approval.</p>
    <section><h2>Recorded setup</h2><table><tbody>${[
      ['Story ID', work.id], ['Workflow', work.workTypeLabel ?? work.workType], ['Story branch', work.branch],
      ['Selected base branch', work.baseBranch], ['Base commit', work.baseCommit], ['Base remote', work.baseRemote],
      ['Capability', capability.label ?? capability.name ?? capability.id], ['Created', work.createdAt],
      ['Source', source?.type ?? object(work.source).type], ['Source reference', source?.url ?? source?.key ?? source?.stableId],
      ['Recorded test execution mode', resolution.testExecutionMode],
      ['Quality gates', resolution.qualityGateMode ?? 'hard']
    ].map(([label, value]) => row(String(label), value)).join('')}</tbody></table>
      <p class="muted">Test policies can be amended after intake. Use Test policy and recovery to inspect current commands, baseline dispositions and risk decisions; absent records are not inferred.</p></section>
    <section><h2>Details entered at intake</h2>${source ? fields.filter(([key]) => source![key] != null && source![key] !== '')
      .map(([key, label]) => `<h3>${escape(label)}</h3><pre class="intake-value">${escape(display(source![key]))}</pre>`).join('')
      : `<p class="warning">${preview.truncated ? 'The source preview is truncated; not all intake details are available.' : 'The saved source could not be interpreted as a JSON object. The returned text is shown below.'}</p>`}
      <details><summary>Saved source record${preview.truncated ? ' (truncated)' : ''}</summary><pre class="intake-value">${escape(preview.content)}</pre></details>
      <p class="muted">${escape(preview.record.path ?? '')}${preview.verifiedSha256 ? ` · Read SHA-256: ${escape(preview.verifiedSha256)}` : ''}</p></section>
    <section><h2>Recorded reference repositories</h2>${references.length ? `<table><thead><tr><th>Repository</th><th>Branch</th><th>Pinned commit</th></tr></thead><tbody>${references.map(reference => `<tr><td>${escape(display(reference.id))}</td><td>${escape(display(reference.requestedBranch ?? reference.branch))}</td><td>${escape(display(reference.commit))}</td></tr>`).join('')}</tbody></table>` : '<p>No reference repository was recorded.</p>'}</section>
    <section><h2>Currently attached evidence</h2><p class="muted">This catalog includes later uploads. It is not presented as the original attachment history.</p>${evidence.length ? `<table><thead><tr><th>Document</th><th>Type</th><th>Status</th></tr></thead><tbody>${evidence.map(document => `<tr><td>${escape(document.name ?? document.label ?? document.id ?? 'Document')}</td><td>${escape(document.type ?? '')}</td><td>${escape(document.availability ?? document.status ?? 'Recorded')}</td></tr>`).join('')}</tbody></table>` : '<p>No supporting evidence is reported in the current catalog.</p>'}</section>
    <button class="secondary" data-action="evidence">View evidence &amp; designs</button>
    <button class="secondary" data-action="tests">Test policy and recovery</button>
    <button class="secondary" data-action="refresh">Refresh intake details</button>`;
}
