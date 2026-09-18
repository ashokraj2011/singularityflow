/** Pure, bounded SGOS execution-workflow creator view. The engine remains the only writer. */
import {
  SGOS_LOWER_KEBAB, sgosEligibleVerifiers, sgosWorkflowSelectionIssue,
  validSgosInputPath, type SgosGuideOperation, type SgosWorkflowCreateSelection,
  type SgosWorkflowGuide
} from '../sgos-workflow-create-model.ts';
import { escape } from './webview.ts';

export type SgosWorkflowPageState = {
  readonly repository: string;
  readonly intentPath: string;
  readonly policyPath: string;
  readonly registryPath: string;
  readonly guide?: SgosWorkflowGuide;
  readonly selection?: Partial<SgosWorkflowCreateSelection>;
  readonly error?: string | null;
  readonly busy?: boolean;
  readonly guideLoading?: boolean;
};

type InputField = 'intentPath' | 'policyPath' | 'registryPath';

function inputRow(id: InputField, label: string, value: string, description: string): string {
  return `<div class="field full">
    <label for="sgos-${id}"><span>${escape(label)}</span></label>
    <div class="inline-form">
      <input id="sgos-${id}" data-sgos-field="${id}" type="text" value="${escape(value)}"
        placeholder="reviewed/${escape(id)}.json" autocomplete="off" spellcheck="false">
      <button type="button" class="secondary" data-sgos-browse="${id}" aria-label="Browse for ${escape(label)}">Browse…</button>
    </div><small>${escape(description)}</small>
  </div>`;
}

function option(operation: SgosGuideOperation, selected: string): string {
  const annotation = [operation.version ? `v${operation.version}` : '', operation.opcode ?? '']
    .filter(Boolean).join(' · ');
  return `<option value="${escape(operation.id)}"${selected === operation.id ? ' selected' : ''}>${escape(operation.id)}${annotation ? ` · ${escape(annotation)}` : ''}</option>`;
}

function field(label: string, id: string, value: string | number, description: string,
  attributes = ''): string {
  return `<label class="field" for="sgos-${id}"><span>${escape(label)}</span>
    <input id="sgos-${id}" data-sgos-field="${id}" value="${escape(value)}" ${attributes}>
    <small>${escape(description)}</small></label>`;
}

function guideBlockers(guide: SgosWorkflowGuide | undefined): string[] {
  return [
    ...(guide?.blockers ?? []).map((blocker) => blocker.message ?? blocker.code ?? 'Unknown guide blocker'),
    ...(guide?.unresolvedRequiredClauses ?? []).map((clause) =>
      `Unresolved required clause ${clause.clauseId ?? 'unknown'} (${clause.field ?? 'unknown'})`)
  ];
}

/** Validate display readiness only. The CLI revalidates all fields before writing anything. */
export function sgosWorkflowPageReady(state: SgosWorkflowPageState): boolean {
  const choice = state.selection ?? {};
  const guide = state.guide;
  if (state.busy || state.guideLoading || !guide) return false;
  const id = choice.id ?? '';
  const root = SGOS_LOWER_KEBAB.test(id) ? `singularity/sgos-drafts/${id}` : '';
  const complete: SgosWorkflowCreateSelection = {
    intentPath: state.intentPath,
    policyPath: state.policyPath,
    registryPath: state.registryPath,
    id,
    title: choice.title ?? '',
    operation: choice.operation ?? '',
    verificationOperation: choice.verificationOperation ?? '',
    storageProfileSha256: choice.storageProfileSha256 ?? '',
    maximumAttempts: choice.maximumAttempts ?? 1,
    outputRef: choice.outputRef ?? 'artifact:result',
    declarationOut: choice.declarationOut ?? (root ? `${root}/workflow-declaration.json` : ''),
    workflowOut: choice.workflowOut ?? (root ? `${root}/workflow-ir.json` : '')
  };
  return sgosWorkflowSelectionIssue(complete, guide) === null;
}

/** HTML fragment for the shared nonce/CSP webview shell. No script or style tags are emitted here. */
export function sgosWorkflowCreateHtml(state: SgosWorkflowPageState): string {
  const choice = state.selection ?? {};
  const guide = state.guide;
  const operations = (guide?.eligibleOperations ?? [])
    .filter((entry) => entry.guidedEligible !== false && entry.guidedRole !== 'verifier');
  const selectedOperation = operations.find((entry) => entry.id === choice.operation);
  const verifiers = guide && selectedOperation
    ? sgosEligibleVerifiers(guide, selectedOperation.id) : [];
  const blockers = guideBlockers(guide);
  const clauses = ((guide as SgosWorkflowGuide & {
    clauses?: readonly { clauseId?: string; field?: string; statement?: string; required?: boolean }[];
  } | undefined)?.clauses ?? []);
  const id = choice.id ?? '';
  const defaultRoot = SGOS_LOWER_KEBAB.test(id) ? `singularity/sgos-drafts/${id}` : '';
  const declarationOut = choice.declarationOut ?? (defaultRoot ? `${defaultRoot}/workflow-declaration.json` : '');
  const workflowOut = choice.workflowOut ?? (defaultRoot ? `${defaultRoot}/workflow-ir.json` : '');
  const ready = sgosWorkflowPageReady({
    ...state, selection: { ...choice, declarationOut, workflowOut }
  });
  return `<main class="sgos-workflow-create" aria-labelledby="sgos-create-heading">
    <header><p class="eyebrow">SGOS · execution workflow</p><h1 id="sgos-create-heading">Create a reviewable execution workflow</h1>
      <p>Turn a confirmed Intent into one bounded operation and an independent verifier. This is not a Story phase workflow.</p>
      <p class="muted">Repository: <code>${escape(state.repository)}</code></p></header>
    ${state.error ? `<div class="notice error" role="alert">${escape(state.error)}</div>` : ''}
    ${state.busy ? '<p role="status" aria-live="polite">Creating the two review files…</p>' : ''}
    <section class="editor-card" aria-labelledby="sgos-input-heading"><h2 id="sgos-input-heading">1. Reviewed inputs</h2>
      <p class="muted">Choose repository-local JSON files. No inputs are inferred from chat history or another workspace.</p>
      <details><summary>Where do these inputs come from?</summary>
        <p>The Intent IR is produced by a separate human confirmation of Intent. The policy and
        operation registry are reviewed SGOS snapshots from this repository. Ask the repository
        owner for the exact storage-profile SHA-256; this form does not derive or approve one.</p>
      </details>
      <div class="form-grid">
        ${inputRow('intentPath', 'Confirmed Intent IR', state.intentPath, 'The objective and clauses this Workflow must cover.')}
        ${inputRow('policyPath', 'Policy snapshot', state.policyPath, 'A reviewed policy snapshot; the engine checks this at creation.')}
        ${inputRow('registryPath', 'Operation registry snapshot', state.registryPath, 'Defines installed, eligible operations and their independent verifiers.')}
      </div>
      <div class="form-actions"><button type="button" data-sgos-guide="1"${state.busy || state.guideLoading || !validSgosInputPath(state.intentPath) || !validSgosInputPath(state.registryPath) ? ' disabled' : ''}>${state.guideLoading ? 'Checking eligibility…' : 'Check eligible operations'}</button></div>
    </section>
    <section class="editor-card" aria-labelledby="sgos-operation-heading"><h2 id="sgos-operation-heading">2. Operation and proof</h2>
      ${guide?.intent ? `<p><strong>${escape(guide.intent.intentId ?? 'Confirmed Intent')}</strong>${guide.intent.objective ? ` · ${escape(guide.intent.objective)}` : ''}</p>
      <p class="muted">${escape(guide.intent.clauseCount ?? 0)} governed clauses</p>` : '<p class="muted">Check the reviewed inputs to see eligible operations.</p>'}
      ${clauses.length ? `<details><summary>Review Intent clauses (${clauses.length})</summary><table><thead><tr><th>Clause</th><th>Field</th><th>Statement</th></tr></thead><tbody>
        ${clauses.slice(0, 50).map((clause) => `<tr><td><code>${escape(clause.clauseId ?? '')}</code>${clause.required ? ' · required' : ''}</td><td>${escape(clause.field ?? '')}</td><td>${escape(clause.statement ?? '')}</td></tr>`).join('')}
        </tbody></table>${clauses.length > 50 ? `<p class="muted">Showing the first 50 of ${clauses.length} clauses. Review the full Intent IR before creating.</p>` : ''}</details>` : ''}
      ${blockers.length ? `<div class="notice error" role="alert"><strong>Resolve before creating</strong><ul>${blockers.map((reason) => `<li>${escape(reason)}</li>`).join('')}</ul></div>` : ''}
      <div class="form-grid">
        <label class="field" for="sgos-operation"><span>Governed operation</span><select id="sgos-operation" data-sgos-field="operation"${!guide || blockers.length ? ' disabled' : ''}>
          <option value="">Choose an eligible operation…</option>${operations.map((entry) => option(entry, choice.operation ?? '')).join('')}</select>
          <small>Only registered core operations accepted by this Intent are shown.</small></label>
        <label class="field" for="sgos-verificationOperation"><span>Independent verifier</span><select id="sgos-verificationOperation" data-sgos-field="verificationOperation"${!selectedOperation || !verifiers.length ? ' disabled' : ''}>
          <option value="">${selectedOperation ? 'Choose a compatible verifier…' : 'Choose an operation first…'}</option>${verifiers.map((entry) => option(entry, choice.verificationOperation ?? '')).join('')}</select>
          <small>Must be a different operation explicitly allowed by the selected operation.</small></label>
      </div>
    </section>
    <section class="editor-card" aria-labelledby="sgos-identity-heading"><h2 id="sgos-identity-heading">3. Identity and bounded output</h2>
      <div class="form-grid">
        ${field('Stable workflow ID', 'id', id, 'Lower-case kebab case; identifies the unratified candidate.', 'type="text" placeholder="verified-migration-report"')}
        ${field('Display title', 'title', choice.title ?? '', 'Human-readable title; optional.', 'type="text"')}
        ${field('Storage profile SHA-256', 'storageProfileSha256', choice.storageProfileSha256 ?? '', 'Paste the exact reviewed storage-profile digest; never a policy-component digest.', 'type="text" placeholder="sha256:…" spellcheck="false"')}
        ${field('Maximum attempts', 'maximumAttempts', choice.maximumAttempts ?? 1, `Positive integer${guide?.installedLimits?.maximumAttemptsPerTask ? `; this build permits at most ${guide.installedLimits.maximumAttemptsPerTask}` : ''}.`, 'type="number" min="1" step="1"')}
        ${field('Output resource', 'outputRef', choice.outputRef ?? 'artifact:result', 'The resource the operation creates and the verifier checks.', 'type="text"')}
        ${field('Declaration JSON', 'declarationOut', declarationOut, 'New file under singularity/sgos-drafts/<id>/.', 'type="text" spellcheck="false"')}
        ${field('Workflow IR JSON', 'workflowOut', workflowOut, 'A different new file under the same draft area.', 'type="text" spellcheck="false"')}
      </div>
    </section>
    <section class="editor-card" aria-labelledby="sgos-review-heading"><h2 id="sgos-review-heading">4. Review before creation</h2>
      <p>This creates <strong>two uncommitted, unratified review files</strong> in this repository. It does not ratify, compile, approve, execute, commit, or push the Workflow.</p>
      <ul><li>Operation: <code>${escape(choice.operation || 'not selected')}</code></li>
        <li>Verifier: <code>${escape(choice.verificationOperation || 'not selected')}</code></li>
        <li>Files: <code>${escape(declarationOut || 'not set')}</code> and <code>${escape(workflowOut || 'not set')}</code></li></ul>
      <p class="muted" role="status" aria-live="polite">${ready ? 'Ready for engine validation and creation.' : 'Complete the reviewed inputs and compatible operation pair to enable creation.'}</p>
      <div class="form-actions"><button type="button" data-sgos-create="1"${ready ? '' : ' disabled'}>Create review files</button></div>
    </section>
  </main>`;
}

/** Delegated events for the shared CSP shell; the host owns validation, CLI calls, and rerenders. */
export const SGOS_WORKFLOW_CREATE_SCRIPT = `
  const sgosVsCode = window.__sfVscode;
  const currentFields = () => Object.fromEntries(
    [...document.querySelectorAll('[data-sgos-field]')].map((input) => [
      input.dataset.sgosField,
      input.dataset.sgosField === 'maximumAttempts' ? Number(input.value) : input.value
    ])
  );
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('button') : null;
    if (!(target instanceof HTMLButtonElement) || target.disabled) return;
    const browse = target.dataset.sgosBrowse;
    if (browse === 'intentPath' || browse === 'policyPath' || browse === 'registryPath') {
      sgosVsCode.postMessage({ type: 'browse', field: browse });
    } else if (target.dataset.sgosGuide) {
      sgosVsCode.postMessage({ type: 'guide', fields: currentFields() });
    } else if (target.dataset.sgosCreate) {
      sgosVsCode.postMessage({ type: 'create', fields: currentFields() });
    }
  });
  document.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    const field = target.dataset.sgosField;
    if (!field) return;
    const fields = { [field]: field === 'maximumAttempts' ? Number(target.value) : target.value };
    if (field === 'operation') fields.verificationOperation = '';
    sgosVsCode.postMessage({ type: 'change', fields });
  });
`;
