/**
 * Spec Studio: a continuous document and Copilot, with sources, history and review opened as needed.
 * Existing research, review and breakdown services remain available in the secondary trays.
 * Person actions use the same `spec author` engine operations as the CLI.
 */
import { brandLockup, escape, icon } from './webview.ts';
import {
  CHECKLIST_DECISIONS, copilotPrompt, draftRecords, FINDING_OUTCOMES, gapPipeline, gateLine, GAP_KINDS, MAXIMUM_OPTIONS, nextRevision, sectionText, shortClause, sliceOption,
  SPEC_STUDIO_STEPS, specBlocks, specClauses, startCommand, stepStates,
  type SpecCoverage, type SpecGap, type SpecGapImpact, type SpecLibrary, type SpecProposal, type SpecResearchItem, type SpecRevision, type SpecStatus,
  type SpecStudioStep, type SpecStudioTarget
} from './spec-studio-model.ts';
import { splitSectionHtml, type SpecSplitPlan, type SpecSplitView } from './spec-studio-split.ts';

/** Everything the host knows when it renders; the page derives the rest. */
export interface SpecStudioPageState {
  target: SpecStudioTarget;
  step: SpecStudioStep;
  library: SpecLibrary | null;
  status: SpecStatus | null;
  /** The revision shown when there is no draft, and the one the attach stage slices. */
  revision: SpecRevision | null;
  coverage: SpecCoverage | null;
  /** The attach stage's revision's published splits and the plan proposed on this clone (S5). */
  split: SpecSplitView | null;
  /** A split plan the engine refused, kept in the planner as the person left it. */
  splitDraft: SpecSplitPlan | null;
  selectedGap: string | null;
  impact: SpecGapImpact | null;
  notice: string | null;
  error: { message: string; next: string | null } | null;
  busy: string | null;
  /** Copilot Chat can draft here (models allowed), and whether #sflowSpecStudio is bound to this draft. */
  copilot?: { available: boolean; tool: boolean } | null;
  creation?: { title: string; intent: string; areas: string[] };
  /** Unsaved text belongs to this panel and the snapshot it was edited from. */
  workingDraft?: { text: string; sequence: number; title?: string; kind?: string | null };
  saveState?: string; syncState?: string; shared?: Record<string, unknown> | null; history?: Array<{ sequence: number; savedAt: string; operation: string }>; sourceViews?: Array<Record<string, unknown>>;
}

const who = (value: { name: string | null } | null | undefined): string => value?.name ?? 'someone';
const when = (value: string | null | undefined): string => (value ? value.slice(0, 16).replace('T', ' ') : '');
const kindLabel = (kind: string): string => kind.replaceAll('-', ' ');
/** The anchor shown in a clause's head is not repeated in its text. */
const CLAUSE_TEXT_ANCHOR = /\s*\[[A-Z0-9][A-Z0-9._-]*:(?:REQ|BEH|IFC|AC|CON)-\d{3,}\]/gu;
const statusPill = (status: string): string => `<span class="pill ${status === 'open' ? 'wait' : status === 'decided' ? 'ok' : ''}">${escape(status)}</span>`;

function controls(step: SpecStudioStep, { cancel = true } = {}): string {
  return `<div class="ss-controls">
    <button type="button" class="secondary" data-message="spec.back">${icon('up')}Back</button>
    ${cancel ? `<button type="button" class="secondary" data-message="spec.cancel" data-cancel>${step === 'draft' ? 'Discard unsaved changes' : 'Cancel'}</button>` : ''}
    <span class="muted">${escape(SPEC_STUDIO_STEPS.find((entry) => entry.id === step)?.detail ?? '')}</span></div>`;
}

function notices(state: SpecStudioPageState): string {
  return [
    state.busy ? `<div class="notice warning" role="status" data-busy>${icon('wait')}${escape(state.busy)}</div>` : '',
    state.notice ? `<div class="notice ok" role="status" data-notice>${icon('ok')}${escape(state.notice)}</div>` : '',
    state.workingDraft && state.step !== 'draft' ? '<div class="notice warning" role="status">Unsaved writing is kept in this panel. <button type="button" class="secondary" data-message="spec.step" data-step="draft">Return to Write</button></div>' : '',
    state.workingDraft && state.error ? '<div class="notice warning"><span>Your writing is kept here.</span><button class="secondary" data-message="spec.copyEdits">Copy my writing</button><button class="secondary" data-message="spec.fork">Keep mine as another draft</button></div>' : '',
    state.error ? `<div class="notice error" role="alert" data-error>${icon('blocked')}<span>${escape(state.error.message)}</span>${state.error.next
      ? `<span class="ss-next">Next: <code>${escape(state.error.next)}</code>
        <button type="button" class="secondary compact-action" data-message="spec.copy" data-text="${escape(state.error.next)}">Copy</button></span>` : ''}</div>` : ''
  ].join('');
}

// ---- The library ---------------------------------------------------------------------------

function libraryHtml(state: SpecStudioPageState): string {
  const library = state.library;
  const drafts = library?.drafts ?? [];
  const specs = library?.specs ?? [];
  const ready = specs.filter(spec => spec.latest.reviewState === 'reviewed');
  const publishedDrafts = specs.filter(spec => spec.latest.reviewState !== 'reviewed');
  const shared = (library?.shared ?? []).filter(item => !drafts.some(draft => draft.specId === item.specId));
  const creation = state.creation;
  const card = (specId: string, title: string, detail: string, revision?: number): string => `<article class="ss-library-card" data-library-item data-search="${escape(`${title} ${specId}`.toLowerCase())}">
    <div><h3>${escape(title || 'Untitled specification')}</h3><p class="muted">${detail}</p><code class="ss-id">${escape(specId)}</code></div>
    <button type="button" class="secondary compact-action" data-message="spec.open" data-spec="${escape(specId)}"${revision ? ` data-revision="${revision}"` : ''}>Open</button></article>`;
  return `<section class="ss-library" aria-label="Specification library">
    <div class="ss-columns-2">
      <form class="ss-form ss-create" data-form="spec.new" aria-label="New specification">
        <p class="eyebrow">A good place to begin</p><h2>What would you like to build or change?</h2><p>Start with a few words. We’ll work it out together.</p>
        <label class="field"><span>Title <small class="muted">Optional</small></span><input name="title" maxlength="240" placeholder="What are you building?" value="${escape(creation?.title ?? '')}"></label>
        <label class="field"><span>What should it achieve? <small class="muted">Optional</small></span><textarea name="intent" rows="5" placeholder="Describe the outcome, who it helps, and what success looks like.">${escape(creation?.intent ?? '')}</textarea></label>
        <details class="ss-details"><summary>Code scope <span class="muted">Optional</span></summary>
          <label class="field"><span>Paths to research</span><input name="areas" placeholder="src/pricing, src/checkout" value="${escape(creation?.areas.join(', ') ?? '')}" autocomplete="off" spellcheck="false">
          <small class="muted">Separate paths with commas. You can research other paths later.</small></label></details>
        <div class="ss-controls"><button type="submit" name="mode" value="copilot"${state.busy || state.copilot?.available === false ? ' disabled' : ''}>${icon('agent')}Help me write it</button><button type="submit" name="mode" value="manual" class="secondary">Save draft</button></div>
        <p class="muted ss-auto-id">A unique specification ID is generated automatically. Saving is separate from review. You can leave and come back anytime.</p>
      </form>
      <div class="ss-library-list"><h2>Your specifications</h2>
        <label class="field ss-search"><span>Find a specification</span><input type="search" data-library-search placeholder="Search by title or ID" aria-describedby="ss-search-count"></label>
        <p id="ss-search-count" class="muted" data-search-count role="status">${drafts.length + specs.length + shared.length} entries</p>
        <section data-library-group><h3 class="ss-group-heading">Drafts <span class="pill">${drafts.length}</span></h3>
          ${drafts.length ? drafts.map((draft) => card(draft.specId, draft.title ?? '', `Saved draft${draft.basedOn ? ` · based on revision ${draft.basedOn.revision}` : ''}`)).join('') : '<p class="muted">Your new drafts will appear here.</p>'}</section>
        ${shared.length ? `<section data-library-group><h3 class="ss-group-heading">Shared drafts <span class="pill">${shared.length}</span></h3>${shared.map(item => card(item.specId, item.title, 'Unreviewed · saved ' + escape(when(item.savedAt)))).join('')}</section>` : ''}
        <section data-library-group><h3 class="ss-group-heading">Ready to use <span class="pill">${ready.length}</span></h3>
          ${ready.length ? ready.map((spec) => card(spec.specId, spec.latest.title, `Revision ${spec.latest.revision} · reviewed`, spec.latest.revision)).join('') : '<p class="muted">Reviewed versions will appear here.</p>'}</section>
        ${publishedDrafts.length ? `<section data-library-group><h3 class="ss-group-heading">Published drafts <span class="pill">${publishedDrafts.length}</span></h3>${publishedDrafts.map(spec => card(spec.specId, spec.latest.title, `Revision ${spec.latest.revision} · unreviewed`, spec.latest.revision)).join('')}</section>` : ''}
        ${library?.status === 'not-fetched' ? '<p class="muted" role="status">Shared specifications have not been loaded on this laptop. <button type="button" class="secondary" data-message="spec.refresh">Load shared specifications</button> Your local drafts are available.</p>' : ''}
        <p class="muted" data-search-empty hidden>No specifications match your search.</p>
        ${library ? `<details class="ss-details"><summary>Library details</summary><p class="muted">${library.status === 'not-fetched' ? 'The state branch has not been fetched on this clone.' : library.status === 'absent' ? 'No published library on the state branch yet.' : `State branch: ${escape((library.commit ?? '').slice(0, 12))}`}</p></details>` : ''}
      </div>
    </div></section>`;
}

// ---- The left column -----------------------------------------------------------------------

function leftHtml(state: SpecStudioPageState): string {
  const status = state.status;
  const revision = state.revision;
  const gate = status ? `<div class="ss-gate" data-gate>
      <div class="${status.counts.d.passed === status.counts.d.total ? 'ok' : 'bad'}"><strong>D ${status.counts.d.passed}/${status.counts.d.total}</strong><small>rules passed</small></div>
      <div><strong>A</strong><small>${status.counts.a.status === 'not-run' ? 'not run' : `${status.counts.a.pending} pending`}</small></div>
      <div class="${status.counts.h.open ? 'bad' : 'ok'}"><strong>H ${status.counts.h.open}</strong><small>open${status.counts.h.deferred ? `, ${status.counts.h.deferred} deferred` : ''}</small></div></div>
      <p class="muted" data-gate-line>${escape(gateLine(status.counts))}</p>`
    : revision ? `<p class="muted">${escape(revision.specId)}@${revision.revision} is ${escape(String(revision.manifest.reviewState ?? ''))}; no draft on this clone.</p>` : '';
  const records = status ? draftRecords(status).map((entry) => `<li><button type="button" class="ss-link" data-message="spec.step" data-step="${entry.step}">
      <code>${escape(entry.file)}</code><small>${escape(entry.detail)}</small></button></li>`).join('')
    : revision ? ['spec.md', 'gaps.json', 'research.json', 'quality.json', 'manifest.json'].map((file) => `<li><code>${file}</code><small>${file === 'gaps.json' ? `${revision.gaps} event(s)` : file === 'research.json' ? `${revision.research} item(s)` : file === 'manifest.json' ? escape(revision.manifestSha256.slice(0, 19)) : ''}</small></li>`).join('') : '';
  const states = stepStates(status);
  const steps = SPEC_STUDIO_STEPS.map((step, index) => `<li><button type="button" class="ss-step ${states[step.id].state}" data-message="spec.step" data-step="${step.id}"${state.step === step.id ? ' aria-current="step"' : ''}>
      <span class="ss-step-number">${index + 1}</span><span><strong>${escape(step.label)}</strong><small>${escape(states[step.id].note || step.detail)}</small></span></button></li>`).join('');
  const pipeline = status ? gapPipeline(status.gaps).map((gap) => `<li><button type="button" class="ss-gap-row${state.selectedGap === gap.id ? ' selected' : ''}" data-message="spec.gap" data-gap="${escape(gap.id)}">
      <span>${escape(gap.id)} ${statusPill(gap.status)}</span><small>${escape(kindLabel(gap.kind))}: ${escape(gap.question)}</small></button></li>`).join('') : '';
  return `<aside class="ss-left" aria-label="Specification steps and quality">
    <h2>Steps</h2><ol class="ss-steps">${steps}</ol>
    <div class="ss-quality-summary"><h2>Quality</h2>${status ? `<p>${status.counts.d.passed}/${status.counts.d.total} checks passed</p><p>${status.counts.a.status === 'not-run' ? 'Assisted review not run' : `${status.counts.a.pending} review findings pending`}</p><p>${status.counts.h.open} open decisions</p>` : ''}
      <details class="ss-details"><summary>Check details</summary>${gate}</details></div>
    ${status ? `<details class="ss-details"${state.step === 'gaps' ? ' open' : ''}><summary>Open questions (${status.counts.h.open})</summary>${pipeline ? `<ul class="ss-pipeline" data-pipeline>${pipeline}</ul>` : '<p class="muted">No gaps yet.</p>'}</details>` : ''}
    <details class="ss-details"><summary>Draft records</summary><ul class="ss-records">${records}</ul></details>
  </aside>`;
}

// ---- The right column ----------------------------------------------------------------------

function rightHtml(state: SpecStudioPageState): string {
  // The attach stage slices a published revision, so the column shows that revision's text.
  const revisionShown = Boolean(state.revision && (state.step === 'attach' || !state.status));
  const source = revisionShown ? state.revision : state.status;
  if (!source) return '';
  const specId = source.specId;
  const slice = state.target.specId === specId ? state.target.clauses : null;
  const blocks = specBlocks(source.spec, specId, revisionShown ? [] : state.status?.gaps ?? [], slice).map((block) => {
    if (block.kind === 'heading') return `<h${Math.min(6, block.level + 2)} class="ss-heading">${escape(block.text)}</h${Math.min(6, block.level + 2)}>`;
    const refs = block.research.length ? `<span class="ss-refs">${block.research.map((id) => `<button type="button" class="ss-ref" data-message="spec.step" data-step="research" data-item="${escape(id)}">${escape(id)}</button>`).join('')}</span>` : '';
    if (block.kind === 'text') return `<p>${escape(block.text)}${refs}</p>`;
    return `<div class="ss-clause${block.flags.length ? ' flagged' : ''}${block.inSlice ? ' in-slice' : ''}" data-clause-id="${escape(block.clauses.join(' '))}">
      <div class="ss-clause-head">${block.clauses.map((clause) => `<code>[${escape(clause)}]</code>`).join(' ')}
        ${block.inSlice ? '<span class="pill ok">in this Story\'s slice</span>' : ''}
        ${block.flags.map((flag) => `<button type="button" class="pill wait ss-flag" data-message="spec.gap" data-gap="${escape(flag.gap)}">${escape(kindLabel(flag.kind))}, ${escape(flag.gap)}</button>`).join('')}</div>
      <p>${escape(block.text.replace(CLAUSE_TEXT_ANCHOR, '').trim())}${refs}</p></div>`;
  }).join('');
  return `<section class="ss-right" aria-label="spec.md">
    <h2>spec.md <small class="muted">${revisionShown ? `${escape(specId)}@${state.revision?.revision}` : `draft snapshot ${state.status?.sequence}`}</small></h2>
    <div class="ss-spec">${blocks}</div></section>`;
}

// ---- The stages ----------------------------------------------------------------------------

function citation(item: SpecResearchItem): string {
  if (!item.citation) return item.source ? `<small class="muted">stated by ${escape(item.source)}</small>` : '';
  return `<button type="button" class="ss-link" data-message="spec.openCitation" data-path="${escape(item.citation.path)}" data-line="${item.citation.lines[0]}">
    ${escape(item.citation.path)}:${item.citation.lines[0]}-${item.citation.lines[1]}</button>`;
}

function standing(item: SpecResearchItem): string {
  if (item.standing === 'current') return '<span class="pill ok">current</span>';
  if (item.standing === 'stale') return `<span class="pill bad" title="${escape(item.staleReason ?? '')}">stale</span>`;
  if (item.standing === 'uncited') return '<span class="pill bad">uncited</span>';
  return `<span class="pill">${escape(item.basis)}</span>`;
}

function elicitStage(status: SpecStatus): string {
  const outcome = sectionText(status.spec, 'Outcome');
  return `<h2>${icon('edit')}Overview</h2>
    <dl class="ss-facts"><dt>Title</dt><dd>${escape(status.title)}</dd>
      <dt>Area of code</dt><dd>${status.areas.length ? status.areas.map((area) => `<code>${escape(area || '.')}</code>`).join(' ') : '<span class="muted">none named; research names its own paths</span>'}</dd>
      <dt>Intent (Outcome)</dt><dd>${outcome ? `<pre class="ss-pre">${escape(outcome)}</pre>` : '<span class="muted">The specification has no Outcome section yet.</span>'}</dd>
      <dt>Based on</dt><dd>${status.basedOn ? `@${status.basedOn.revision} (${escape(status.basedOn.reviewState)})` : 'the library template; never published'}</dd></dl>
    <p class="muted">Change the prose in Write. The title and code scope are set when the draft starts.</p>
    ${controls('elicit', { cancel: false })}`;
}

function researchStage(status: SpecStatus): string {
  const rows = status.researchItems.map((item) => `<tr data-research="${escape(item.id)}"><td><code>${escape(item.id)}</code></td><td>${standing(item)}</td>
    <td>${escape(item.summary)}<br>${citation(item)}${item.standing === 'stale' && item.staleReason ? `<br><small class="muted">${escape(item.staleReason)}</small>` : ''}</td>
    <td><button type="button" class="secondary compact-action" data-message="spec.removeResearch" data-item="${escape(item.id)}">Remove</button></td></tr>`).join('');
  return `<h2>${icon('search')}Research</h2>
    ${rows ? `<table class="ss-table"><thead><tr><th>Item</th><th>Standing</th><th>Fact</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">No research yet.</p>'}
    <form class="ss-form" data-form="spec.research"><h3>Collect from the code</h3>
      <label class="field"><span>Paths</span><input name="paths" value="${escape(status.areas.join(', '))}" autocomplete="off" spellcheck="false">
        <small class="muted">Rules, limits, entry points, journeys and the tests that reach them, each cited by path, lines and hash.</small></label>
      <label class="ss-check"><input type="checkbox" name="refresh"> Rebuild the knowledge model first</label>
      <div class="ss-controls"><button type="submit">${icon('search')}Collect research</button></div></form>
    <form class="ss-form" data-form="spec.fact"><h3>Add a person's fact</h3>
      <label class="field"><span>Fact</span><textarea name="fact" rows="2" required></textarea></label>
      <label class="field"><span>Stated by</span><input name="source" required></label>
      <div class="ss-controls"><button type="submit">${icon('add')}Add the fact</button></div></form>
    ${controls('research')}`;
}

function draftStage(status: SpecStatus, workingDraft?: SpecStudioPageState['workingDraft']): string {
  const content = workingDraft?.text ?? status.spec;
  const sequence = workingDraft?.sequence ?? status.sequence;
  return `<h2>${icon('document')}Write your specification</h2>
    <p class="muted">Describe the behavior, boundaries and evidence that will prove it works.</p>
    ${workingDraft && sequence !== status.sequence ? '<div class="notice warning" role="alert">A newer snapshot was saved. Your unsaved text is preserved. Copy it, discard unsaved changes to load the latest snapshot, then merge your edits with the saved preview. <button type="button" class="secondary" data-message="spec.copyEdits">Copy unsaved text</button></div>' : ''}
    <form class="ss-form" data-form="spec.save">
      <input type="hidden" name="sequence" value="${sequence}">
      <div class="ss-editor-meta"><span data-edit-status role="status">${workingDraft ? 'Unsaved changes' : 'All changes saved'}</span><span data-word-count>${content.trim().split(/\s+/u).filter(Boolean).length} words</span></div>
      <label class="field"><span class="sr-only">Specification text</span>
        <textarea name="text" class="ss-editor" rows="24" spellcheck="true">${escape(content)}</textarea>
        </label>
      <details class="ss-details"><summary>Writing requirements and acceptance criteria</summary><p class="muted">Use the section headings in the draft. Give each requirement a stable reference, for example [${escape(status.specId)}:REQ-002], and an acceptance criterion that proves it. Copilot can help structure the draft. Saving keeps a new snapshot.</p></details>
      <div class="ss-controls"><button type="submit">${icon('ok')}Save draft</button></div></form>
    ${controls('draft')}`;
}

function impactLines(impact: SpecGapImpact | null, option: string, changesCode: boolean): string {
  if (!changesCode) return '<small class="muted">Impact: none; it keeps the code as it is.</small>';
  const records = impact?.options.find((entry) => entry.id === option)?.records ?? null;
  if (!records) return '<small class="muted">Impact is read when the gap opens.</small>';
  return records.length ? `<ul class="ss-impact">${records.map((line) => `<li>${escape(line)}</li>`).join('')}</ul>` : '<small class="muted">Impact: no cited code.</small>';
}

function gapDetail(status: SpecStatus, gap: SpecGap, impact: SpecGapImpact | null): string {
  const evidence = gap.evidence.map((id) => status.researchItems.find((item) => item.id === id)).filter(Boolean) as SpecResearchItem[];
  const head = `<header class="ss-gap-head"><h3>${escape(gap.id)} ${statusPill(gap.status)} <small>${escape(kindLabel(gap.kind))}</small></h3><p>${escape(gap.question)}</p></header>
    ${evidence.length ? `<h4>Evidence</h4><ul class="ss-evidence">${evidence.map((item) => `<li><code>${escape(item.id)}</code> ${standing(item)} ${escape(item.summary)} ${citation(item)}</li>`).join('')}</ul>` : ''}
    ${gap.clauses.length ? `<p class="muted">Clauses: ${gap.clauses.map((clause) => `<code>${escape(clause)}</code>`).join(' ')}</p>` : ''}`;
  if (gap.status !== 'open') {
    const outcome = gap.decision ? `<p data-decision><strong>Decided:</strong> ${escape(gap.decision.choice)}</p><p class="muted">${escape(who(gap.decision.by))}, ${escape(when(gap.decision.at))}: ${escape(gap.decision.reason)}</p>`
      : gap.deferral ? `<p data-decision><strong>Deferred to ${escape(gap.deferral.owner)}.</strong></p><p class="muted">${escape(who(gap.deferral.by))}, ${escape(when(gap.deferral.at))}: ${escape(gap.deferral.reason)}</p>` : '';
    return `${head}${outcome}
      <p class="muted">State its outcome by its ID under "Decisions and open questions" in Draft before publishing.</p>
      <form class="ss-form" data-form="spec.reopen"><input type="hidden" name="gap" value="${escape(gap.id)}">
        <label class="field"><span>Why it needs deciding again</span><textarea name="reason" rows="2" required></textarea></label>
        <div class="ss-controls"><button type="submit" class="secondary">Reopen ${escape(gap.id)}</button></div></form>`;
  }
  const options = gap.options.map((option) => `<div class="ss-option" data-option-row="${escape(option.id)}">
      <p><strong>${escape(option.id)}</strong> ${escape(option.wording)}</p>${impactLines(impact, option.id, option.changesCode)}
      <button type="button" data-decide="${escape(option.id)}" data-gap="${escape(gap.id)}" disabled>${icon('approval')}Close gap with ${escape(option.id)} and sign</button></div>`).join('');
  return `${head}
    <div class="ss-decide" data-decide-for="${escape(gap.id)}">
      ${options || '<p class="muted">This gap has no options. Defer it, or reopen a gap with options.</p>'}
      <label class="field"><span>Rationale</span><textarea name="reason" rows="3" data-rationale required></textarea>
        <small class="muted">Recorded with your Git identity and the time, as on any approval.</small></label></div>
    <form class="ss-form" data-form="spec.defer"><input type="hidden" name="gap" value="${escape(gap.id)}"><h4>Or defer it</h4>
      <label class="field"><span>Owner</span><input name="owner" required></label>
      <label class="field"><span>Reason</span><textarea name="reason" rows="2" required></textarea></label>
      <div class="ss-controls"><button type="submit" class="secondary">Defer ${escape(gap.id)}</button></div></form>`;
}

function openGapForm(status: SpecStatus): string {
  const clauses = specClauses(status.spec, status.specId);
  return `<form class="ss-form" data-form="spec.openGap"><h3>Open a gap</h3>
    <label class="field"><span>Kind</span><select name="kind" required><option value="">Choose…</option>${GAP_KINDS.map((kind) => `<option value="${kind}">${escape(kindLabel(kind))}</option>`).join('')}</select></label>
    <label class="field"><span>Question</span><textarea name="question" rows="2" required></textarea></label>
    ${status.researchItems.length ? `<fieldset><legend>Evidence</legend>${status.researchItems.map((item) => `<label class="ss-check"><input type="checkbox" name="evidence[]" value="${escape(item.id)}"> <code>${escape(item.id)}</code> ${escape(item.summary)}</label>`).join('')}</fieldset>` : ''}
    ${clauses.length ? `<fieldset><legend>Clauses it touches</legend>${clauses.map((clause) => `<label class="ss-check"><input type="checkbox" name="clauses[]" value="${escape(clause.id)}"> <code>${escape(shortClause(status.specId, clause.id))}</code></label>`).join('')}</fieldset>` : ''}
    <fieldset><legend>Options (up to ${MAXIMUM_OPTIONS}): the clause wording each would put in the specification</legend>${Array.from({ length: MAXIMUM_OPTIONS }, (_, index) => `<div class="ss-option-input">
      <label class="field"><span>O${index + 1}</span><input name="option-wording-${index + 1}"></label>
      <label class="ss-check"><input type="checkbox" name="option-code-${index + 1}" checked> changes the code</label></div>`).join('')}</fieldset>
    <div class="ss-controls"><button type="submit">${icon('add')}Open the gap</button></div></form>`;
}

function gapsStage(state: SpecStudioPageState, status: SpecStatus): string {
  const gap = status.gaps.find((entry) => entry.id === state.selectedGap) ?? null;
  return `<h2>${icon('approval')}Review gaps</h2>
    ${gap ? gapDetail(status, gap, state.impact) : `<p class="muted">${status.gaps.length ? 'Choose a gap in the pipeline.' : 'No gaps yet.'} Open gaps come first.</p>`}
    ${gap ? '' : openGapForm(status)}
    ${controls('gaps')}`;
}

function checkStage(status: SpecStatus): string {
  const rules = status.rules.map((rule) => `<li class="${rule.passed ? 'ok' : 'bad'}">${icon(rule.passed ? 'ok' : 'blocked')}<span><strong>${escape(rule.label)}</strong>
    ${rule.findings.map((finding) => `<small>${escape(finding.message)}</small>`).join('')}</span></li>`).join('');
  const open = status.gaps.filter((gap) => gap.status === 'open');
  return `<h2>${icon('gate')}Check quality</h2>
    <h3>Automated checks</h3><ul class="ss-rules" data-rules>${rules}</ul>
    <h3>Assisted review</h3>${assistedHtml(status)}
    <h3>Your decisions</h3>
    ${open.length ? `<p>Open gaps: ${open.map((gap) => `<button type="button" class="ss-link" data-message="spec.gap" data-gap="${escape(gap.id)}">${escape(gap.id)}</button>`).join(' ')}</p>` : '<p class="muted">No open gap.</p>'}
    <form class="ss-form" data-form="spec.settle"><table class="ss-table"><thead><tr><th>Checklist article</th><th>Decision</th></tr></thead><tbody>${status.articles.map((entry) => `<tr>
      <td>${escape(entry.article.replaceAll('-', ' '))}</td><td><select name="article:${escape(entry.article)}" aria-label="${escape(entry.article)}"><option value="">${entry.decision ? `${escape(entry.decision)} (recorded)` : 'No decision'}</option>${CHECKLIST_DECISIONS.map((decision) => `<option value="${decision}">${escape(decision)}</option>`).join('')}</select></td></tr>`).join('')}</tbody></table>
      <label class="field"><span>Reason (needed for an exception or not applicable)</span><textarea name="reason" rows="2"></textarea></label>
      <div class="ss-controls"><button type="submit">${icon('approval')}Record checklist decisions</button></div></form>
    ${controls('check')}`;
}

function publishStage(state: SpecStudioPageState, status: SpecStatus): string {
  const revision = nextRevision(state.library, status);
  const name = `${status.specId}@${revision}`;
  return `<h2>${icon('archive')}Make ready to use</h2>
    <p>Review <strong>${escape(status.title)}</strong> before making this version available for Stories. Your draft stays editable.</p>
    <p>${status.kind === 'business' ? 'Business needs' : status.kind === 'technical' ? 'Technical details' : 'Choose the specification type in Write first.'} · ${status.sources?.length ?? 0} source(s)</p>
    ${status.reviewReady ? '<div class="notice ok">All automated checks pass, review findings are settled, and no decisions are open.</div>'
      : `<div class="notice warning"><p>A few things still need attention:</p><ul>${status.blocking.map((finding) => `<li>${escape(finding.message)}</li>`).join('')}</ul></div>`}
    ${!status.reviewReady ? '<p><button type="button" class="secondary" data-message="spec.step" data-step="check">Review the remaining questions</button></p>' : ''}
    <div class="ss-controls">
      <button type="button" data-message="spec.publish" data-state="reviewed"${status.reviewReady ? '' : ' disabled'}>${icon('approval')}Make ready to use</button></div>
    <p class="muted">You’ll confirm the exact saved version. This records agreed requirements; it does not claim that the work has been delivered.</p>
    <details class="ss-details"><summary>Version details and other options</summary>
      <p>The next revision is <strong data-next-revision>${escape(name)}</strong>: spec.md, gaps.json, research.json and quality.json, immutable on the state branch.</p>
      <button type="button" class="secondary" data-message="spec.publish" data-state="draft">Share an unreviewed version</button>
      <p class="muted">An unreviewed version cannot be used as an agreed Story input.</p>
      <h3>Discard</h3><p class="muted">Removes this laptop’s draft; published versions stay.</p>
      <button type="button" class="danger" data-message="spec.discard">${icon('remove')}Discard the draft…</button></details>
    ${controls('publish', { cancel: false })}`;
}

function attachStage(state: SpecStudioPageState): string {
  const revision = state.revision;
  const chooser = `<details class="ss-details"><summary>Choose another version</summary><form class="ss-form ss-inline" data-form="spec.attachRevision"><label class="field"><span>Version number</span>
    <input name="revision" inputmode="numeric" pattern="[1-9][0-9]*" value="${revision?.revision ?? ''}" placeholder="highest reviewed"></label>
    <button type="submit" class="secondary">Open this version</button></form></details>`;
  if (!revision) {
    return `<h2>${icon('story')}Create a Story</h2><p class="muted">Make a reviewed version ready before creating a Story.</p><button type="button" data-message="spec.step" data-step="publish">Make this draft ready to use</button>${chooser}${controls('attach', { cancel: false })}`;
  }
  const clauses = specClauses(revision.spec, revision.specId);
  const slice = state.target.specId === revision.specId ? state.target.clauses : null;
  const chosen = slice ?? clauses.map((clause) => clause.id);
  const reviewed = revision.manifest.reviewState === 'reviewed';
  const option = sliceOption(revision.specId, revision.revision, chosen, clauses.map((clause) => clause.id));
  const coverage = state.coverage && state.coverage.revision === revision.revision ? `<table class="ss-table" data-coverage><thead><tr><th>Clause</th><th>Status</th><th>Where</th></tr></thead><tbody>${state.coverage.rows.map((row) => `<tr>
      <td><code>${escape(shortClause(revision.specId, row.clause))}</code></td><td><span class="pill ${row.status === 'delivered' ? 'ok' : row.status === 'claimed' || row.status === 'allocated' ? 'wait' : ''}">${escape(row.status)}</span></td>
      <td>${escape([...row.deliveredBy.map((work) => `${work} delivered`), ...row.claimedBy.map((work) => `${work} claimed`), ...row.allocatedTo.map((to) => to.label),
        ...(row.leftOut ? [`left out: ${row.leftOut}`] : [])].join(', '))}</td></tr>`).join('')}</tbody></table>
      ${state.coverage.children.length ? `<ul class="ss-children" data-children>${state.coverage.children.map((child) => `<li><code>${escape(child.specId)}</code> ${escape(child.title)}
        <small class="muted">split ${child.split} of @${child.fromRevision}</small> <span class="pill ${child.status === 'parent-moved' ? 'wait' : ''}">${escape(child.status === 'parent-moved' ? 'parent moved' : child.status)}</span>
        ${child.changed.length ? `<small>${escape(child.changed.map((clause) => shortClause(revision.specId, clause)).join(', '))} changed since @${child.fromRevision}</small>` : ''}</li>`).join('')}</ul>` : ''}
      ${state.coverage.unreadable.length ? `<p class="muted">Unreadable records, not counted: ${escape(state.coverage.unreadable.join(', '))}</p>` : ''}` : '';
  return `<h2>${icon('story')}Create a Story</h2>
    <p><strong>${escape(String(revision.manifest.title ?? ''))}</strong> · version ${revision.revision} · ${reviewed ? 'Ready to use' : 'Not reviewed'}</p>
    ${reviewed ? '' : '<div class="notice warning">Make this version ready to use before creating a Story from it.</div>'}
    <form class="ss-form" data-form="spec.slice" data-spec="${escape(revision.specId)}" data-revision="${revision.revision}" data-reviewed="${reviewed}" data-all="${escape(clauses.map((clause) => clause.id).join(' '))}">
      <fieldset><legend>What should this Story deliver?</legend>${clauses.map((clause) => `<label class="ss-check"><input type="checkbox" name="clauses[]" value="${escape(clause.id)}"${chosen.includes(clause.id) ? ' checked' : ''}>
        <span>${escape(clause.text)}</span></label>`).join('')}</fieldset>
      <p class="muted">The selected requirements, related business needs, source references and agreed decisions will travel with the Story. You’ll choose its repositories and review everything in Story intake.</p>
      <div class="ss-controls"><button type="button" data-create-story${reviewed ? '' : ' disabled'}>Continue to Story intake</button></div>
      <details class="ss-details"><summary>Command line and reference details</summary>
        <p>Exact input: <code data-slice-option>${escape(option)}</code></p><pre class="ss-pre" data-start-command>${escape(startCommand(option))}</pre>
        <div class="ss-controls"><button type="button" class="secondary" data-copy-slice${reviewed ? '' : ' disabled'}>Copy the --spec option</button>
        <button type="button" class="secondary" data-copy-start${reviewed ? '' : ' disabled'}>Copy the start command</button></div></details></form>${chooser}
    ${splitSectionHtml(state.split?.specId === revision.specId && state.split.revision === revision.revision ? state.split : null,
      { specId: revision.specId, revision: revision.revision, reviewed }, clauses, state.splitDraft)}
    <h3>Coverage of @${revision.revision}</h3>
    <button type="button" class="secondary" data-message="spec.coverage">${icon('refresh')}Read coverage</button>${coverage}
    ${controls('attach', { cancel: false })}`;
}

function noDraftStage(state: SpecStudioPageState): string {
  const revision = state.revision;
  return `<h2>${icon('document')}${escape(state.target.specId ?? '')}</h2>
    ${revision ? `<p>${escape(revision.specId)}@${revision.revision} ${statusPill(String(revision.manifest.reviewState ?? ''))}: ${escape(String(revision.manifest.title ?? ''))},
      published ${escape(when(String(revision.manifest.recordedAt ?? '')))} by ${escape(who(revision.manifest.publishedBy))}.</p>` : ''}
    <p class="muted">This specification has no draft on this clone. Start a draft of its next revision to change it; the published revisions stay as they are.</p>
    <div class="ss-controls"><button type="button" data-message="spec.revise" data-spec="${escape(state.target.specId ?? '')}">${icon('edit')}Start a draft of the next revision</button></div>
    ${controls(state.step, { cancel: false })}`;
}

function stageHtml(state: SpecStudioPageState): string {
  const status = state.status;
  let body: string;
  if (state.step === 'attach') body = attachStage(state);
  else if (!status) body = noDraftStage(state);
  else if (state.step === 'elicit') body = elicitStage(status);
  else if (state.step === 'research') body = researchStage(status);
  else if (state.step === 'draft') body = draftStage(status, state.workingDraft);
  else if (state.step === 'gaps') body = gapsStage(state, status);
  else if (state.step === 'check') body = checkStage(status);
  else body = publishStage(state, status);
  return `<section class="ss-stage" data-stage="${state.step}" aria-label="${escape(SPEC_STUDIO_STEPS.find((entry) => entry.id === state.step)?.label ?? '')}">${body}</section>`;
}

const FINDING_LABELS: Record<string, string> = { gap: 'Open it as a gap', fixed: 'Fixed in the prose', dismissed: 'Dismiss, with a reason' };

/** Part A: Copilot's checklist findings, each pending until the person settles it here. */
function assistedHtml(status: SpecStatus): string {
  if (status.counts.a.status === 'not-run' && !status.findings.length) return '<p class="muted">Not run: no assisted findings. That is allowed, and the manifest says so.</p>';
  const pending = status.findings.filter((finding) => finding.status === 'pending');
  const settled = status.findings.filter((finding) => finding.status !== 'pending');
  return `<p class="muted">${pending.length ? `${pending.length} pending: a reviewed publication waits until you settle each one.` : 'Run; nothing pending.'}</p>
    ${pending.length ? `<form class="ss-form" data-form="spec.settleFindings" data-findings><table class="ss-table ss-findings"><thead><tr><th>ID</th><th>Article</th><th>What Copilot found</th><th>Settle</th></tr></thead><tbody>${pending.map((finding) => `<tr data-finding="${escape(finding.id)}">
      <td>${escape(finding.id)}</td><td>${escape(finding.article.replaceAll('-', ' '))}</td><td>${escape(finding.message)}${finding.clauses.length ? ` <small>(${escape(finding.clauses.join(', '))})</small>` : ''}</td>
      <td><select name="finding:${escape(finding.id)}" aria-label="Settle ${escape(finding.id)}"><option value="">Not yet</option>${FINDING_OUTCOMES.map((outcome) => `<option value="${outcome}">${escape(FINDING_LABELS[outcome]!)}</option>`).join('')}</select></td></tr>`).join('')}</tbody></table>
      <label class="field"><span>Reason (needed to dismiss)</span><textarea name="reason" rows="2"></textarea></label>
      <div class="ss-controls"><button type="submit">${icon('approval')}Settle findings</button></div></form>` : ''}
    ${settled.length ? `<ul class="ss-settled">${settled.map((finding) => `<li>${escape(finding.id)} ${escape(finding.article.replaceAll('-', ' '))}: ${escape(finding.status)}${finding.gap ? ` as ${escape(finding.gap)}` : ''}${finding.reason ? ` · ${escape(finding.reason)}` : ''}</li>`).join('')}</ul>` : ''}`;
}

function proposalBody(proposal: SpecProposal): string {
  if (proposal.kind === 'edit') {
    return `<details><summary>The proposed prose${proposal.stale ? ' (made against an older snapshot)' : ''}</summary><pre class="ss-proposed">${escape(proposal.spec ?? '')}</pre></details>
      ${proposal.stale ? `<p class="ss-stale">${icon('warning')}The prose changed since snapshot ${proposal.basisSequence}. Ask Copilot again, or merge it yourself and accept your text:</p>
      <form class="ss-form" data-form="spec.acceptEdited"><input type="hidden" name="proposal" value="${escape(proposal.id)}"><textarea name="text" rows="8" aria-label="Your merge of ${escape(proposal.id)}">${escape(proposal.spec ?? '')}</textarea>
        <div class="ss-controls"><button type="submit">${icon('approval')}Accept ${escape(proposal.id)} with this text</button></div></form>` : ''}`;
  }
  if (proposal.kind === 'research') {
    return proposal.citation ? `<p><button type="button" class="ss-link" data-message="spec.openCitation" data-path="${escape(proposal.citation.path)}" data-line="${proposal.citation.lines[0]}">${escape(proposal.citation.path)}:${proposal.citation.lines[0]}-${proposal.citation.lines[1]}</button> verified against the code</p>`
      : '<p class="ss-stale">Unverified: it cites no code, so it can support no gap and blocks a reviewed publication until it is removed.</p>';
  }
  return `<p><strong>${escape(proposal.question ?? '')}</strong> <small>${escape((proposal.gapKind ?? '').replaceAll('-', ' '))}${proposal.evidence?.length ? ` · evidence ${escape(proposal.evidence.join(', '))}` : ''}</small></p>
    ${proposal.options?.length ? `<ol>${proposal.options.map((option) => `<li>${escape(option.id)}: ${escape(option.wording)}${option.changesCode ? '' : ' <small>(keeps the code)</small>'}</li>`).join('')}</ol>` : ''}`;
}

/** The Copilot tab: what Copilot staged, for the person to take or turn down, and how to ask it. */
function copilotHtml(state: SpecStudioPageState, status: SpecStatus): string {
  const copilot = state.copilot;
  const ask = copilot?.available ? `<p><button type="button" data-message="spec.askCopilot">${icon('agent')}Ask Copilot to draft or check</button>
    <small class="muted">Your writing stays in this editor. Copilot suggests changes for you to accept.</small></p>`
    : '<p class="muted">Copilot is off for this window, so nothing is proposed here; every step works by hand.</p>';
  const waiting = status.proposals;
  const list = waiting.length ? `<form class="ss-form" data-form="spec.proposals"><ul class="ss-proposals">${waiting.map((proposal) => `<li data-proposal="${escape(proposal.id)}">
      <label class="ss-check"><input type="checkbox" name="proposals[]" value="${escape(proposal.id)}"${proposal.kind === 'edit' && proposal.stale ? ' disabled' : ''}><strong>${escape(proposal.id)}</strong> ${escape(proposal.kind)}${proposal.summary ? `: ${escape(proposal.summary)}` : ''}</label>
      ${proposalBody(proposal)}</li>`).join('')}</ul>
      <label class="field"><span>Reason (needed to reject)</span><textarea name="reason" rows="2"></textarea></label>
      <div class="ss-controls"><button type="submit" name="decision" value="accept">${icon('approval')}Accept selected</button><button type="submit" class="secondary" name="decision" value="reject">Reject selected</button></div></form>`
    : '<p class="muted">Nothing is waiting for you.</p>';
  const pending = status.findings.filter((finding) => finding.status === 'pending').length;
  return `${ask}${list}${pending ? `<p>${pending} assisted finding(s) to settle: <button type="button" class="ss-link" data-message="spec.step" data-step="check">Check</button></p>` : ''}`;
}

function tabsHtml(state: SpecStudioPageState): string {
  const status = state.status;
  const findings = status ? (status.blocking.length ? `<ul>${status.blocking.map((finding) => `<li><strong>${escape(finding.part)}</strong> <code>${escape(finding.code)}</code> ${escape(finding.message)}</li>`).join('')}</ul>`
    : '<p class="muted">No finding blocks a reviewed publication.</p>') : '<p class="muted">Findings belong to a draft.</p>';
  const revision = state.revision;
  const manifest = revision ? `<dl class="ss-facts"><dt>Revision</dt><dd>${escape(revision.specId)}@${revision.revision} (${escape(String(revision.manifest.reviewState ?? ''))})</dd>
      <dt>Manifest</dt><dd><code>${escape(revision.manifestSha256)}</code></dd><dt>State commit</dt><dd><code>${escape(revision.commit)}</code></dd>
      <dt>Published</dt><dd>${escape(when(String(revision.manifest.recordedAt ?? '')))} by ${escape(who(revision.manifest.publishedBy))}</dd></dl>`
    : status?.basedOn ? `<p>Based on @${status.basedOn.revision}: <code>${escape(status.basedOn.manifestSha256)}</code></p>` : '<p class="muted">Nothing published yet.</p>';
  return `<details class="ss-details ss-review-details"${status && (['check', 'publish'].includes(state.step) || status.proposals.length || status.findings.some((finding) => finding.status === 'pending')) ? ' open' : ''}><summary>Review and publication details${status?.proposals.length ? ` · ${status.proposals.length} Copilot proposals` : ''}${status?.blocking.length ? ` · ${status.blocking.length} quality findings` : ''}</summary><section class="ss-tabs" aria-label="Findings and manifest">
    <div role="tablist"><button type="button" role="tab" aria-selected="true" data-tab="findings">Quality findings${status ? ` (${status.blocking.length})` : ''}</button>
      <button type="button" role="tab" aria-selected="false" data-tab="manifest">State-branch manifest</button>
      ${status ? `<button type="button" role="tab" aria-selected="false" data-tab="copilot">Copilot (${status.proposals.length})</button>` : ''}</div>
    <div role="tabpanel" data-panel="findings">${findings}</div><div role="tabpanel" data-panel="manifest" hidden>${manifest}</div>
    ${status ? `<div role="tabpanel" data-panel="copilot" hidden>${copilotHtml(state, status)}</div>` : ''}</section></details>`;
}

/** A lossless line surface: unchanged Markdown, including anchors and tables, stays byte-for-byte. */
export function studioDocumentHtml(markdown: string): string {
  return markdown.split(/\r?\n/u).map(line => {
    const match = /^(#{1,6})\s+(.*)$/u.exec(line);
    const tag = match ? `h${match[1]!.length}` : 'p';
    const value = match ? match[2]! : line;
    const safe = escape(value).replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>').replace(/`([^`]+)`/gu, '<code>$1</code>').replace(/\[([A-Z0-9._-]+:(?:REQ|AC|CON|BEH|IFC)-\d{3,})\]/gu,
      '<span class="ss-clause-anchor" contenteditable="false">[$1]</span>');
    return `<${tag} data-original-line="${escape(line)}">${safe || '<br>'}</${tag}>`;
  }).join('');
}

function composePage(state: SpecStudioPageState, status: SpecStatus): string {
  const working = state.workingDraft;
  const sources = status.sources ?? [];
  const gap = status.gaps.find(item => item.status === 'open');
  const text = working?.text ?? status.spec;
  const tray = state.step !== 'draft' && state.step !== 'elicit' ? `<section class="ss-compose-tray"><button type="button" class="secondary ss-close-tray" data-message="spec.step" data-step="draft">Back to writing</button>${stageHtml(state)}</section>` : '';
  return `<div class="ss-root ss-compose" data-view="spec" data-spec="${escape(status.specId)}">
    <header class="ss-compose-top"><button class="ss-link" data-message="spec.home">Spec Studio</button><span class="muted">Your draft</span>
      <div class="ss-compose-actions"><span data-save-state role="status">${escape(state.saveState ?? 'Saved on this laptop')}</span><button class="secondary" data-message="spec.sync">Sync now</button>
      <button class="secondary" data-message="spec.step" data-step="publish">Make ready to use</button><button data-message="spec.step" data-step="attach">Create a Story</button></div></header>
    ${notices(state)}<div class="notice warning" data-sync-problem hidden role="status"><span data-sync-error></span><code data-sync-next hidden></code><button type="button" class="secondary" data-message="spec.sync">Retry sharing</button></div>${tray}
    <div class="ss-compose-grid"><main class="ss-paper"><form data-form="spec.save" class="ss-writing-form">
      <input type="hidden" name="sequence" value="${working?.sequence ?? status.sequence}">
      <p class="eyebrow">Your specification · Draft</p><label class="sr-only" for="ss-title">Specification title</label><textarea id="ss-title" class="ss-writing-title" name="title" maxlength="240" rows="1">${escape(working?.title ?? status.title)}</textarea>
      <label class="ss-kind-label">This describes <select name="kind" aria-label="Specification kind"><option value="">Choose when you’re ready</option><option value="business"${(working?.kind ?? status.kind) === 'business' ? ' selected' : ''}>Business needs</option><option value="technical"${(working?.kind ?? status.kind) === 'technical' ? ' selected' : ''}>Technical details</option></select></label>
      <section class="ss-sources" aria-label="Files and links"><p class="muted">Files and links · originals stay on this laptop</p><div class="ss-source-list">${sources.map(source => `<button type="button" class="secondary compact-action" data-message="spec.viewSource" data-item="${escape(String(source.id))}">${escape(String(source.name))}<small>Not yet inspected</small></button>`).join('')}</div>
      <div class="ss-source-actions"><button type="button" class="ss-link" data-message="spec.addFiles">+ Add files or images</button><button type="button" class="ss-link" data-message="spec.addLink">Add a link</button><button type="button" class="ss-link" data-message="spec.chooseCode">Choose code</button><button type="button" class="ss-link" data-message="spec.addSpecification">Use a specification</button></div></section>
      <div class="ss-writing-tools" role="toolbar" aria-label="Writing tools"><button type="button" class="secondary" data-format="bold"><strong>B</strong><span class="sr-only">Bold</span></button><button type="button" class="secondary" data-format="heading">Heading</button><button type="button" class="secondary" data-format="list">List</button><button type="button" class="secondary" data-message="spec.insertLink">Link</button><button type="button" class="secondary" data-format="undo">Undo</button><button type="button" class="secondary" data-format="redo">Redo</button><button type="button" class="ss-link" data-source-toggle>Markdown</button></div>
      <label class="sr-only" for="ss-prose">Specification text</label><textarea id="ss-prose" name="text" class="ss-editor ss-markdown" rows="24">${escape(text)}</textarea>
      <article class="ss-rich-editor" contenteditable="true" role="textbox" aria-label="Specification text" aria-multiline="true" hidden>${studioDocumentHtml(text)}</article>
      <footer class="ss-writing-foot"><span data-word-count>${text.trim().split(/\s+/u).filter(Boolean).length} words</span><span data-edit-status role="status">${working ? 'Saving your changes…' : 'Write freely. Changes save automatically.'}</span><button type="button" class="ss-link" data-message="spec.history">Earlier versions</button><button type="submit" class="secondary">Save</button></footer></form>
      <details class="ss-details"><summary>Details and review</summary><p><code>${escape(status.specId)}</code> · saved version ${status.sequence}</p><p>${escape(state.syncState ?? 'No shared checkpoint confirmed yet.')}</p><button class="secondary" data-message="spec.step" data-step="check">Check this draft</button><button class="secondary" data-message="spec.derive">Work out the technical details</button><button class="secondary" data-message="spec.step" data-step="attach">Break into smaller parts</button>${tabsHtml(state)}</details>
      ${state.history ? `<section class="ss-version-list"><h2>Earlier versions</h2>${state.history.map(version => `<div><span>Saved ${escape(when(version.savedAt))}</span><span><button class="secondary" data-message="spec.version" data-revision="${version.sequence}">View version ${version.sequence}</button><button class="ss-link" data-message="spec.restoreVersion" data-revision="${version.sequence}">Restore wording</button></span></div>`).join('')}</section>` : ''}
      ${state.shared ? `<section class="ss-compose-tray"><h2>There is a shared draft</h2><p>Your local versions remain available in Earlier versions.</p><pre>${escape(String((state.shared.draft as Record<string, unknown>)?.spec ?? ''))}</pre><button data-message="spec.resumeShared">Use the shared draft</button><button class="secondary" data-message="spec.fork">Keep mine as another draft</button></section>` : ''}
      ${state.sourceViews ? `<section class="ss-compose-tray"><h2>Selected source</h2>${state.sourceViews.map(view => `<p>${escape(String((view.source as Record<string, unknown>)?.name ?? 'Source'))} · ${escape(String(view.status))}</p>${view.message ? `<p>${escape(String(view.message))}</p>` : ''}${view.text ? `<pre>${escape(String(view.text))}</pre>` : ''}${view.next ? `<button class="ss-link" data-message="spec.viewSource" data-item="${escape(String((view.source as Record<string, unknown>)?.id))}" data-line="${Number(view.next)}" data-column="${Number(view.nextColumn ?? 0)}">Read more</button>` : ''}${view.instruction ? `<p class="muted">${escape(String(view.instruction))}</p>` : ''}<button class="ss-link" data-message="spec.removeSource" data-item="${escape(String((view.source as Record<string, unknown>)?.id))}">Remove from this draft</button>${view.status === 'upload-required' ? `<button class="secondary" data-message="spec.restoreSource" data-item="${escape(String((view.source as Record<string, unknown>)?.id))}">Add this file again</button>` : ''}`).join('')}</section>` : ''}
    </main><aside class="ss-cowriter" aria-label="Write with Copilot"><h2>${icon('agent')}Write with Copilot</h2><p class="muted">Your idea, made clearer together.</p>
      ${gap ? `<section class="ss-question-card"><h3>One thing to confirm</h3>${gapDetail(status, gap, state.impact)}</section>` : '<p>Bring your notes, documents and selected code. Copilot can suggest a first draft, explain gaps and help improve a section.</p>'}
      ${copilotHtml(state, status)}<div class="ss-ask-box"><div class="ss-quick-prompts"><button class="ss-link" data-prompt="Make this clearer while keeping the intended meaning.">Make this clearer</button><button class="ss-link" data-prompt="Find missing failure cases, boundaries and dependencies. Explain their implications.">What could go wrong?</button></div><form data-form="spec.ask"><label class="sr-only" for="ss-request">Ask Copilot</label><textarea id="ss-request" name="request" rows="4" placeholder="Ask a question or describe a change…"></textarea><p class="muted">Changes are yours to keep.</p><button type="submit"${state.copilot?.available ? '' : ' disabled'}>Send to Copilot</button></form></div>
    </aside></div></div>`;
}

export function specStudioHtml(state: SpecStudioPageState): string {
  if (state.status) return composePage(state, state.status);
  const header = `<header class="ss-header"><div>${brandLockup()}<h1>Spec Studio</h1><p class="muted">Turn an idea into something your team can build and check.</p></div><button class="secondary" data-message="spec.refresh">Refresh</button></header>`;
  if (state.shared && !state.status) return `<div class="ss-root">${header}${notices(state)}<section class="ss-compose-tray"><h2>Continue a shared draft</h2><p>This is unreviewed writing. Original files may need to be added on this laptop.</p><pre>${escape(String((state.shared.draft as Record<string, unknown>)?.spec ?? ''))}</pre><button data-message="spec.resumeShared">Continue writing</button></section></div>`;
  if (!state.target.specId) return `<div class="ss-root" data-view="library">${header}${notices(state)}${libraryHtml(state)}</div>`;
  return `<div class="ss-root" data-spec="${escape(state.target.specId)}">${header}${notices(state)}${stageHtml(state)}${rightHtml(state)}</div>`;
}

export const SPEC_STUDIO_STYLE = `
body:has(.ss-root) { max-width:none; }
.ss-root { max-width:96rem; margin:0 auto; }
.ss-workspace { min-width:0; display:grid; gap:1rem; }
.ss-details { margin:.8rem 0; }
.ss-details > summary { cursor:pointer; color:var(--sf-dim); padding:.4rem 0; }
.ss-details[open] > summary { margin-bottom:.6rem; }
.ss-quality-summary { margin-top:1.4rem; border-top:var(--sf-border); }
.ss-quality-summary p { margin:.45rem 0; font-size:.9em; }
.ss-library .ss-columns-2 { align-items:start; gap:2.5rem; }
.ss-create { margin:0; padding:1.1rem; background:var(--vscode-editor-background); border:var(--sf-border); border-radius:var(--sf-radius); }
.ss-create h2, .ss-library-list h2 { margin:0 0 .6rem; }
.ss-create .field { display:grid; gap:.45rem; }
.ss-create .field > span { display:flex; align-items:baseline; gap:.4rem; }
.ss-library-card { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:1rem 0; border-bottom:var(--sf-border); }
.ss-library-card[hidden], [data-library-group][hidden] { display:none; }
.ss-library-card h3 { margin:0; font-size:1rem; }
.ss-library-card p { margin:.3rem 0; }
.ss-id { font-size:.8em; color:var(--sf-dim); overflow-wrap:anywhere; }
.ss-group-heading { margin:1.5rem 0 .25rem; font-size:.9rem; display:flex; align-items:center; gap:.5rem; }
.ss-search { display:grid; gap:.45rem; }
.ss-search input { padding:.65rem; width:100%; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:var(--sf-border); border-radius:var(--sf-radius); }
.ss-editor-meta { display:flex; justify-content:space-between; gap:1rem; color:var(--sf-dim); font-size:.85em; }
.ss-auto-id { font-size:.85em; line-height:1.5; }
.sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
.ss-header { display:flex; flex-wrap:wrap; justify-content:space-between; gap:1rem; align-items:flex-end; }
.ss-grid { display:grid; grid-template-columns:minmax(13rem,16rem) minmax(0,1fr); gap:1rem; margin:1rem 0; align-items:start; }
@media (max-width: 1100px) { .ss-grid { grid-template-columns:minmax(13rem,16rem) minmax(0,1fr); } .ss-right { grid-column:1 / -1; } }
@media (max-width: 720px) { .ss-grid { grid-template-columns:minmax(0,1fr); } }
.ss-left, .ss-stage, .ss-right, .ss-tabs, .ss-library { padding:.9rem; border:var(--sf-border); border-radius:var(--sf-radius); background:var(--sf-surface); min-width:0; }
.ss-left h2, .ss-right h2 { font-size:.8rem; text-transform:uppercase; letter-spacing:.08em; color:var(--sf-dim); margin:1rem 0 .4rem; }
.ss-left h2:first-child, .ss-right h2:first-child { margin-top:0; }
.ss-gate { display:grid; grid-template-columns:repeat(3,1fr); gap:.4rem; }
.ss-gate > div { display:grid; gap:.1rem; padding:.45rem; border:var(--sf-border); border-radius:var(--sf-radius); text-align:center; }
.ss-gate > div.ok strong { color:var(--sf-ok); } .ss-gate > div.bad strong { color:var(--sf-bad); }
.ss-gate small, .ss-step small, .ss-records small, .ss-gap-row small { color:var(--sf-dim); overflow-wrap:anywhere; }
.ss-records, .ss-steps, .ss-pipeline { list-style:none; margin:0; padding:0; display:grid; gap:.25rem; }
.ss-records li { display:grid; gap:.1rem; }
.ss-link { display:inline-grid; justify-items:start; justify-content:start; gap:.1rem; padding:.15rem 0; border:0; background:none; color:var(--vscode-textLink-foreground); text-align:left; cursor:pointer; font:inherit; min-height:0; }
.ss-records .ss-link { width:100%; }
.ss-step, .ss-gap-row { display:flex; gap:.5rem; align-items:flex-start; width:100%; padding:.4rem .5rem; border:var(--sf-border); border-radius:var(--sf-radius);
  background:var(--vscode-editor-background); color:var(--vscode-foreground); text-align:left; font:inherit; cursor:pointer; min-height:0; justify-content:flex-start; }
.ss-step span:last-child, .ss-gap-row { display:grid; }
.ss-step[aria-current="step"], .ss-gap-row.selected { border:2px solid var(--sf-accent); background:var(--sf-accent-quiet); }
.ss-step-number { display:grid; place-items:center; flex:0 0 1.4rem; height:1.4rem; border-radius:50%; border:var(--sf-border); font-size:.75rem; }
.ss-step.done .ss-step-number { background:var(--sf-accent); color:var(--sf-on-accent); border-color:var(--sf-accent); }
.ss-step.open .ss-step-number { border-color:var(--sf-wait); color:var(--sf-wait); }
.ss-stage h2 { margin-top:0; display:flex; gap:.4rem; align-items:center; }
.ss-controls { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; margin-top:.75rem; }
.ss-form { display:grid; gap:.6rem; margin:1rem 0; }
.ss-form.ss-inline { grid-template-columns:minmax(0,12rem) auto; align-items:end; }
.ss-form fieldset { display:grid; gap:.3rem; border:var(--sf-border); border-radius:var(--sf-radius); padding:.6rem; }
.ss-form input:not([type=checkbox]), .ss-form textarea, .ss-form select { width:100%; padding:.4rem .5rem; color:var(--vscode-input-foreground); background:var(--vscode-input-background);
  border:1px solid var(--vscode-input-border,var(--sf-border-color)); border-radius:3px; font:inherit; }
.ss-form textarea.ss-editor { line-height:1.65; padding:1rem!important; tab-size:2; font-family:var(--vscode-editor-font-family); font-size:var(--vscode-editor-font-size); min-height:24rem; resize:vertical; }
.ss-check { display:flex; gap:.4rem; align-items:baseline; }
.ss-check code { white-space:nowrap; }
.ss-form.ss-inline button { justify-self:start; }
.ss-option-input { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:.5rem; align-items:end; }
.ss-option { display:grid; gap:.35rem; padding:.6rem; margin:.5rem 0; border:var(--sf-border); border-radius:var(--sf-radius); }
.ss-option > button { justify-self:start; }
.ss-impact { margin:0; padding-left:1.1rem; color:var(--sf-dim); }
.ss-table { width:100%; border-collapse:collapse; }
.ss-table th, .ss-table td { text-align:left; vertical-align:top; padding:.3rem .4rem; border-bottom:var(--sf-border); overflow-wrap:anywhere; }
.ss-rules { list-style:none; padding:0; display:grid; gap:.3rem; }
.ss-rules li { display:flex; gap:.4rem; align-items:flex-start; } .ss-rules li > span { display:grid; }
.ss-rules li.ok > svg { color:var(--sf-ok); } .ss-rules li.bad > svg { color:var(--sf-bad); }
.ss-rules small { color:var(--sf-dim); }
.ss-facts { display:grid; grid-template-columns:max-content minmax(0,1fr); gap:.3rem .8rem; }
.ss-facts dt { color:var(--sf-dim); }
.ss-pre { white-space:pre-wrap; overflow-wrap:anywhere; margin:0; font-family:var(--vscode-editor-font-family); }
.ss-spec { display:grid; gap:.35rem; max-height:70vh; overflow:auto; }
.ss-spec p { margin:0; overflow-wrap:anywhere; }
.ss-heading { margin:.6rem 0 .1rem; }
.ss-clause { display:grid; gap:.25rem; padding:.45rem .55rem; border-left:3px solid var(--sf-border-color); background:var(--vscode-editor-background); }
.ss-clause.flagged { border-left-color:var(--sf-wait); }
.ss-clause.in-slice { border-left-color:var(--sf-accent); background:var(--sf-accent-quiet); }
.ss-clause-head { display:flex; flex-wrap:wrap; gap:.35rem; align-items:center; }
.ss-clause-head button.pill.ss-flag { cursor:pointer; min-height:0; padding:.05rem .45rem; border:1px solid var(--sf-wait); background:transparent; color:var(--sf-wait); font:inherit; font-size:.8em; }
.ss-right h2 small { margin-left:.5rem; text-transform:none; letter-spacing:0; }
.ss-refs { display:inline-flex; gap:.25rem; margin-left:.35rem; }
.ss-ref { padding:0 .3rem; border:var(--sf-border); border-radius:3px; background:none; color:var(--vscode-textLink-foreground); font-size:.8em; cursor:pointer; min-height:0; }
.ss-gap-head h3 { margin:0; display:flex; gap:.4rem; align-items:center; }
.ss-evidence { padding-left:1.1rem; }
.ss-next { display:inline-flex; flex-wrap:wrap; gap:.4rem; align-items:center; margin-left:.4rem; }
.ss-columns-2 { display:grid; grid-template-columns:minmax(18rem,1fr) minmax(22rem,1.2fr); gap:1.5rem; }
@media (max-width: 900px) { .ss-columns-2 { grid-template-columns:minmax(0,1fr); } }
.ss-tabs [role=tablist] { display:flex; gap:.4rem; margin-bottom:.6rem; }
.ss-proposals { list-style:none; padding:0; margin:0 0 .6rem; display:grid; gap:.6rem; }
.ss-proposals > li { padding:.5rem .6rem; border:var(--sf-border); border-radius:var(--sf-radius); }
.ss-proposed { max-height:16rem; overflow:auto; white-space:pre-wrap; }
.ss-findings th, .ss-findings td { overflow-wrap:normal; word-break:normal; }
.ss-findings td:first-child, .ss-findings td:last-child { white-space:nowrap; }
.ss-stale { color:var(--vscode-editorWarning-foreground); }
.ss-children { padding-left:1.1rem; display:grid; gap:.25rem; }
.ss-tabs [role=tab][aria-selected="true"] { border-color:var(--sf-accent); background:var(--sf-accent-quiet); }

.ss-compose{max-width:1440px;margin:auto}.ss-compose-top{display:flex;align-items:center;gap:12px;padding:16px 24px;border-bottom:1px solid var(--vscode-panel-border)}.ss-compose-actions{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-left:auto}.ss-compose-actions [data-save-state]{font-size:12px;color:var(--vscode-descriptionForeground)}.ss-compose-grid{display:grid;grid-template-columns:minmax(0,1fr) 300px}.ss-paper{padding:36px clamp(20px,4vw,64px);min-width:0;background:var(--vscode-editor-background)}.ss-writing-title{resize:none;overflow:hidden;field-sizing:content;min-height:44px;width:100%;padding:0;border:0!important;background:transparent!important;color:var(--vscode-foreground);font-size:30px!important;font-weight:600;line-height:1.3;letter-spacing:-.6px}.ss-kind-label{display:flex;align-items:center;gap:10px;color:var(--vscode-descriptionForeground);font-size:12px;margin:15px 0 24px}.ss-kind-label select{width:auto;max-width:230px}.ss-sources{margin-bottom:22px}.ss-source-list,.ss-source-actions{display:flex;flex-wrap:wrap;gap:12px}.ss-source-list button{display:grid;text-align:left;gap:2px}.ss-source-list small{display:block;font-size:10px;color:var(--vscode-descriptionForeground)}.ss-source-actions{margin-top:12px}.ss-writing-tools{display:flex;gap:4px;flex-wrap:wrap;border-block:1px solid var(--vscode-panel-border);padding:9px 0;margin-bottom:20px}.ss-writing-tools button{font-size:12px;padding:5px 8px;min-height:30px}.ss-rich-editor{outline:none;min-height:420px;line-height:1.8;overflow-wrap:anywhere;font-size:14px}.ss-rich-editor h1{font-size:24px}.ss-rich-editor h2{font-size:18px;margin:24px 0 8px}.ss-rich-editor h3{font-size:16px}.ss-rich-editor p{margin:0 0 9px;white-space:pre-wrap}.ss-rich-editor [data-original-line=""]{height:6px;min-height:6px;line-height:6px;margin:0}.ss-clause-anchor{font-size:10px;color:var(--vscode-descriptionForeground);opacity:.65}.ss-writing-foot{display:flex;flex-wrap:wrap;align-items:center;gap:14px;font-size:11px;color:var(--vscode-descriptionForeground);border-top:1px solid var(--vscode-panel-border);margin-top:24px;padding-top:14px}.ss-writing-foot [data-word-count]{margin-right:auto}.ss-cowriter{display:flex;flex-direction:column;gap:16px;border-left:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background,var(--vscode-editor-background));padding:30px 22px;min-width:0}.ss-cowriter h2{display:flex;align-items:center;gap:8px;font-size:16px;margin:0}.ss-cowriter p{font-size:13px;line-height:1.7}.ss-question-card{padding:14px;background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:10px}.ss-question-card h3{font-size:13px}.ss-question-card .ss-controls,.ss-cowriter .ss-controls{flex-wrap:wrap}.ss-cowriter .ss-pre{max-height:260px;overflow:auto}.ss-cowriter .ss-proposals{padding:0;list-style:none}.ss-cowriter .ss-proposals>li{padding:12px 0;border-bottom:1px solid var(--vscode-panel-border)}.ss-ask-box{margin-top:auto;padding-top:20px}.ss-ask-box form{padding:12px;border:1px solid var(--vscode-panel-border);border-radius:10px;background:var(--vscode-editor-background)}.ss-ask-box textarea{width:100%;resize:vertical;min-height:80px;border:0}.ss-quick-prompts{display:flex;gap:10px;font-size:11px;margin-bottom:10px}.ss-compose-tray{margin:18px 24px;padding:20px;border:1px solid var(--vscode-panel-border);border-radius:10px;overflow:auto}.ss-compose-tray .ss-stage{padding:10px;border:0}.ss-close-tray{float:right}.ss-compose-tray pre{white-space:pre-wrap;max-height:280px;overflow:auto}.ss-version-list>div{display:flex;justify-content:space-between;gap:12px;margin:10px 0}.ss-create textarea{font-size:16px;line-height:1.7;min-height:130px}.ss-create h2{font-size:27px;line-height:1.35;letter-spacing:-.5px}.ss-compose [hidden]{display:none!important}.ss-compose button:focus-visible,.ss-rich-editor:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:3px}@media(max-width:860px){.ss-compose-grid{grid-template-columns:minmax(0,1fr)}.ss-cowriter{border-left:0;border-top:1px solid var(--vscode-panel-border)}.ss-compose-top{flex-wrap:wrap;padding:14px 18px}.ss-compose-actions{margin-left:0}.ss-paper{padding:24px 20px}}@media(max-width:420px){.ss-writing-title{font-size:25px!important}.ss-compose-tray{margin:12px 0}.ss-compose-actions button{min-height:38px}.ss-kind-label{flex-wrap:wrap}}
`;

export const SPEC_STUDIO_SCRIPT = `
(() => {
  const api = window.__sfVscode;
  const root = document.querySelector('.ss-root');
  if (!root) return;
  const post = (message) => api.postMessage(message);
  function fields(form) {
    const value = {};
    for (const element of form.querySelectorAll('[name]')) {
      const name = element.name;
      if (name.endsWith('[]')) { const key = name.slice(0, -2); value[key] = value[key] || []; if (element.checked) value[key].push(element.value); continue; }
      value[name] = element.type === 'checkbox' ? element.checked : element.value;
    }
    return value;
  }

  let selectedWording = () => '';
  const writing = root.querySelector('.ss-writing-form');
  if (writing) {
    const raw = writing.querySelector('textarea[name=text]'), rich = writing.querySelector('.ss-rich-editor');
    const originals = new WeakMap();
    for (const child of rich.children) originals.set(child, { html: child.innerHTML, raw: child.dataset.originalLine });
    function inline(node) {
      if (node.nodeType === 3) return node.textContent;
      if (node.nodeName === 'BR') return '\\n';
      const value = Array.from(node.childNodes).map(inline).join('');
      if (['B','STRONG'].includes(node.nodeName)) return '**' + value + '**';
      if (['I','EM'].includes(node.nodeName)) return '*' + value + '*';
      if (node.nodeName === 'A') { const href=node.getAttribute('href')||'';return /^(https?:|mailto:|#)/i.test(href)?'['+value+']('+href+')':value; }
      return value;
    }
    function block(node) {
      if (node.nodeType === 3) return node.textContent;
      const original = originals.get(node);
      if (original && original.html === node.innerHTML) return original.raw;
      if (['UL','OL'].includes(node.nodeName)) return Array.from(node.children).map((child,index)=>(node.nodeName==='UL'?'- ':String(index+1)+'. ')+inline(child).trim()).join('\\n');
      if (/^H[1-6]$/.test(node.nodeName)) return '#'.repeat(Number(node.nodeName[1]))+' '+inline(node).trim();
      if (node.nodeName === 'DIV' && Array.from(node.children).some(child=>['DIV','P','UL','OL'].includes(child.nodeName))) return Array.from(node.childNodes).map(block).join('\\n');
      return inline(node).replace(/\\n$/,'');
    }
    let titleLine = /^# /.test(raw.value.split('\\n')[0]) ? raw.value.split('\\n')[0] : null;
    if(titleLine && rich.firstElementChild?.tagName === 'H1')rich.firstElementChild.remove();
    const serialize = () => { if (!rich.hidden) raw.value = (titleLine === null ? '' : titleLine+'\\n') + Array.from(rich.childNodes).map(block).join('\\n'); };
    const title = writing.querySelector('[name=title]');
    const sizeTitle = () => {title.style.height='auto';title.style.height=title.scrollHeight+'px';};
    title.addEventListener('input',()=>{if(titleLine!==null){const previous=titleLine;titleLine='# '+title.value;if(rich.hidden&&raw.value.startsWith(previous+'\\n'))raw.value=titleLine+raw.value.slice(previous.length);else serialize();}sizeTitle();});
    sizeTitle();
    rich.hidden=false; raw.hidden=true;
    rich.addEventListener('input',event=>{event.stopPropagation();serialize();raw.dispatchEvent(new Event('input',{bubbles:true}));});
    rich.addEventListener('paste',event=>{event.preventDefault();document.execCommand('insertText',false,event.clipboardData.getData('text/plain'));});
    rich.addEventListener('drop',event=>event.preventDefault());
    let selection=null;
    document.addEventListener('selectionchange',()=>{const selected=window.getSelection();if(selected&&selected.rangeCount&&rich.contains(selected.anchorNode))selection=selected.getRangeAt(0).cloneRange();});
    for(const button of root.querySelectorAll('[data-format]'))button.addEventListener('click',()=>{rich.focus();if(selection){const selected=window.getSelection();selected.removeAllRanges();selected.addRange(selection);}const kind=button.dataset.format;document.execCommand(kind==='heading'?'formatBlock':kind==='list'?'insertUnorderedList':kind,false,kind==='heading'?'h2':null);serialize();raw.dispatchEvent(new Event('input',{bubbles:true}));});
    root.querySelector('[data-source-toggle]').addEventListener('click',()=>{
      if(raw.hidden){serialize();raw.hidden=false;rich.hidden=true;raw.focus();}
      else {rich.replaceChildren();const lines=raw.value.split(/\\r?\\n/);titleLine=/^# /.test(lines[0])?lines.shift():null;if(titleLine!==null){title.value=titleLine.slice(2);sizeTitle();}for(const line of lines){const heading=/^(#{1,6})\\s+(.*)$/.exec(line);const element=document.createElement(heading?'h'+heading[1].length:'p');element.textContent=heading?heading[2]:line;if(!element.textContent)element.append(document.createElement('br'));element.dataset.originalLine=line;rich.append(element);originals.set(element,{html:element.innerHTML,raw:line});}raw.hidden=true;rich.hidden=false;selection=null;rich.focus();}
    });
    writing.addEventListener('submit',()=>serialize());
    window.addEventListener('message',event=>{const message=event.data;if(message.type!=='spec.syncState')return;const problem=root.querySelector('[data-sync-problem]');problem.hidden=!message.message;root.querySelector('[data-sync-error]').textContent=message.message||'';const next=root.querySelector('[data-sync-next]');next.textContent=message.next||'';next.hidden=!message.next;});
    window.addEventListener('message',event=>{const message=event.data;if(message.type==='spec.saved'){writing.querySelector('button[type=submit]').disabled=false;writing.querySelector('[name=sequence]').value=String(message.sequence);root.querySelector('[data-save-state]').textContent=message.dirty?'Saving your changes…':message.synced?'Synced':'Saved on this laptop';root.querySelector('[data-edit-status]').textContent=message.dirty?'Changes waiting to save':'Changes saved';}if(message.type==='spec.saveFailed'){writing.querySelector('button[type=submit]').disabled=false;root.querySelector('[data-save-state]').textContent='Could not save — your text is kept here';root.querySelector('[data-edit-status]').textContent=message.message;}if(message.type==='spec.syncState')root.querySelector('[data-save-state]').textContent=message.text;if(message.type==='spec.link'){rich.focus();if(selection){const selected=window.getSelection();selected.removeAllRanges();selected.addRange(selection);}document.execCommand('createLink',false,message.url);serialize();raw.dispatchEvent(new Event('input',{bubbles:true}));}});
    document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='s'){event.preventDefault();serialize();post(Object.assign({type:'spec.save'},fields(writing),{sequence:Number(fields(writing).sequence)}));}});
    selectedWording = () => raw.hidden ? (selection?.toString() || '') : raw.value.slice(raw.selectionStart, raw.selectionEnd);
    for(const button of root.querySelectorAll('[data-prompt]'))button.addEventListener('click',()=>post({type:'spec.ask',request:button.dataset.prompt,selection:selectedWording()}));
  }
  const split = (text) => String(text || '').split(/[,\\n]/).map((entry) => entry.trim()).filter(Boolean);
  const transforms = {
    'spec.ask': value => ({request:value.request,selection:selectedWording()}),
    'spec.new': (value) => ({ title: value.title.trim(), intent: value.intent.trim(), areas: split(value.areas), ...(value.mode ? {mode:value.mode} : {}) }),
    'spec.research': (value) => ({ paths: split(value.paths), refresh: value.refresh === true }),
    'spec.save': (value) => ({ text: value.text, title: value.title, kind: value.kind, sequence: Number(value.sequence) }),
    'spec.openGap': (value) => {
      const options = [];
      for (let index = 1; index <= 4; index += 1) {
        const wording = String(value['option-wording-' + index] || '').trim();
        if (wording) options.push({ wording: wording, changesCode: value['option-code-' + index] === true });
      }
      return { kind: value.kind, question: value.question, evidence: value.evidence || [], clauses: value.clauses || [], options: options };
    },
    'spec.settle': (value) => {
      const decisions = {};
      for (const key of Object.keys(value)) if (key.startsWith('article:') && value[key]) decisions[key.slice('article:'.length)] = value[key];
      return { decisions: decisions, reason: value.reason };
    },
    'spec.attachRevision': (value) => ({ revision: value.revision ? Number(value.revision) : null })
  };
  function sliceText(form) {
    const all = (form.dataset.all || '').split(' ').filter(Boolean);
    const chosen = Array.from(form.querySelectorAll('input[name="clauses[]"]:checked')).map((input) => input.value);
    const spec = form.dataset.spec, revision = form.dataset.revision;
    if (!chosen.length) return '';
    const every = all.every((clause) => chosen.includes(clause));
    return '--spec ' + spec + '@' + revision + (every ? '' : '=' + all.filter((clause) => chosen.includes(clause)).map((clause) => clause.startsWith(spec + ':') ? clause.slice(spec.length + 1) : clause).join(','));
  }
  function syncSlice(form) {
    const option = sliceText(form);
    const shown = form.querySelector('[data-slice-option]');
    const command = form.querySelector('[data-start-command]');
    if (shown) shown.textContent = option || 'Choose at least one clause.';
    if (command) command.textContent = option ? 'singularity-flow start <WORK-ID> --from-branch <BRANCH> --title "<TITLE>" ' + option : '';
    for (const button of form.querySelectorAll('[data-copy-slice],[data-copy-start]')) button.disabled = !option || form.dataset.reviewed !== 'true';
  }
  function syncDecide() {
    for (const block of root.querySelectorAll('[data-decide-for]')) {
      const reason = block.querySelector('[data-rationale]');
      for (const button of block.querySelectorAll('[data-decide]')) button.disabled = !reason || !reason.value.trim();
    }
  }
  root.addEventListener('click', (event) => { const button=event.target.closest('[data-create-story]'); if(button){const form=button.closest('form');if(form&&form.dataset.reviewed==='true')post({type:'spec.createStory',option:sliceText(form)});} });
  root.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-tab]');
    if (tab) {
      for (const other of root.querySelectorAll('[data-tab]')) other.setAttribute('aria-selected', String(other === tab));
      for (const panel of root.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== tab.dataset.tab;
      return;
    }
    const decide = event.target.closest('[data-decide]');
    if (decide && !decide.disabled) {
      const reason = decide.closest('[data-decide-for]').querySelector('[data-rationale]').value;
      post({ type: 'spec.decide', gap: decide.dataset.gap, option: decide.dataset.decide, reason: reason });
      return;
    }
    const copySlice = event.target.closest('[data-copy-slice],[data-copy-start]');
    if (copySlice && !copySlice.disabled) {
      const form = copySlice.closest('form');
      const option = sliceText(form);
      if (option) post({ type: 'spec.copy', text: copySlice.hasAttribute('data-copy-start') ? 'singularity-flow start <WORK-ID> --from-branch <BRANCH> --title "<TITLE>" ' + option : option });
      return;
    }
    const button = event.target.closest('[data-message]');
    if (!button || button.disabled) return;
    const message = { type: button.dataset.message };
    for (const key of ['step', 'gap', 'spec', 'revision', 'item', 'state', 'text', 'path', 'line', 'column']) if (button.dataset[key] !== undefined) message[key] = button.dataset[key];
    if (message.revision !== undefined) message.revision = Number(message.revision);
    if (message.line !== undefined) message.line = Number(message.line);
    if (message.column !== undefined) message.column = Number(message.column);
    if (button.hasAttribute('data-cancel')) for (const form of root.querySelectorAll('form')) form.reset();
    post(message);
  });
  root.addEventListener('submit', (event) => {
    const form = event.target.closest('form[data-form]');
    if (!form) return;
    event.preventDefault();
    if (form.dataset.form === 'spec.slice') return;
    const value = fields(form);
    if (event.submitter && event.submitter.name) value[event.submitter.name] = event.submitter.value;
    const transform = transforms[form.dataset.form];
    for (const button of form.querySelectorAll('button[type=submit]')) button.disabled = true;
    post(Object.assign({ type: form.dataset.form }, transform ? transform(value) : value));
  });
  root.addEventListener('reset', () => { setTimeout(() => { syncDecide(); for (const form of root.querySelectorAll('form[data-form="spec.slice"]')) syncSlice(form); }, 0); });
  root.addEventListener('input', (event) => {
    const creation = event.target.closest('form[data-form="spec.new"]');
    if (creation) post(Object.assign({ type: 'spec.creating' }, transforms['spec.new'](fields(creation))));
    const editor = event.target.closest('form[data-form="spec.save"]');
    if (editor) {
      const value = fields(editor);
      const saveState = root.querySelector('[data-save-state]'); if (saveState) saveState.textContent = 'Changes waiting to save';
      const status = editor.querySelector('[data-edit-status]');
      if (status) status.textContent = 'Unsaved changes';
      const words = editor.querySelector('[data-word-count]');
      if (words) words.textContent = value.text.trim().split(/\\s+/).filter(Boolean).length + ' words';
      post({ type: 'spec.editing', spec: root.dataset.spec, sequence: Number(value.sequence), text: value.text, title: value.title, kind: value.kind });
    }
    if (event.target.matches('[data-library-search]')) {
      const query = event.target.value.trim().toLowerCase();
      let count = 0;
      for (const card of root.querySelectorAll('[data-library-item]')) {
        card.hidden = !card.dataset.search.includes(query);
        if (!card.hidden) count += 1;
      }
      for (const group of root.querySelectorAll('[data-library-group]')) {
        group.hidden = Boolean(query) && !Array.from(group.querySelectorAll('[data-library-item]')).some((card) => !card.hidden);
      }
      root.querySelector('[data-search-count]').textContent = count + (count === 1 ? ' entry' : ' entries');
      root.querySelector('[data-search-empty]').hidden = count !== 0;
    }
    syncDecide();
    const slice = event.target.closest('form[data-form="spec.slice"]');
    if (slice) syncSlice(slice);
  });
  syncDecide();
  for (const form of root.querySelectorAll('form[data-form="spec.slice"]')) syncSlice(form);
})();
`;
