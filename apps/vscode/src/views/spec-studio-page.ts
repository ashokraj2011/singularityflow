/**
 * The Spec Studio page (SPEC-SPA v1.3 §3): the library, or one specification in three columns.
 * Left: the quality gate, the governed records, the authoring loop's steps and the gap pipeline.
 * Middle: the active step's stage. Right: `spec.md` clause by clause. Below: findings, manifest and
 * what Copilot proposed (S4), which only the person's own clicks accept, reject or settle.
 * Every button posts a message; the host runs the `spec author` command and renders again.
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
    ${cancel ? '<button type="button" class="secondary" data-message="spec.cancel" data-cancel>Cancel</button>' : ''}
    <span class="muted">${escape(SPEC_STUDIO_STEPS.find((entry) => entry.id === step)?.detail ?? '')}</span></div>`;
}

function notices(state: SpecStudioPageState): string {
  return [
    state.busy ? `<div class="notice warning" role="status" data-busy>${icon('wait')}${escape(state.busy)}</div>` : '',
    state.notice ? `<div class="notice ok" role="status" data-notice>${icon('ok')}${escape(state.notice)}</div>` : '',
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
  const where = !library ? 'The library has not been read yet.'
    : library.status === 'absent' ? 'Nothing has been published to the state branch yet.'
      : `State branch at ${(library.commit ?? '').slice(0, 12)}.`;
  return `<section class="ss-library" aria-label="Specification library">
    <div class="ss-columns-2">
      <div><h2>Drafts on this clone</h2>${drafts.length ? `<table><thead><tr><th>Specification</th><th>Title</th><th>Snapshot</th><th></th></tr></thead><tbody>${drafts.map((draft) => `<tr>
        <td><code>${escape(draft.specId)}</code></td><td>${escape(draft.title ?? '')}</td>
        <td>${draft.sequence}${draft.basedOn ? ` · based on @${draft.basedOn.revision}` : ''}</td>
        <td><button type="button" class="compact-action" data-message="spec.open" data-spec="${escape(draft.specId)}">Open</button></td></tr>`).join('')}</tbody></table>`
        : '<p class="muted">No draft on this clone.</p>'}
      <h2>Published specifications</h2><p class="muted">${escape(where)}</p>${specs.length ? `<table><thead><tr><th>Specification</th><th>Latest</th><th>Title</th><th></th></tr></thead><tbody>${specs.map((spec) => `<tr>
        <td><code>${escape(spec.specId)}</code></td><td>@${spec.latest.revision} ${statusPill(spec.latest.reviewState)}</td><td>${escape(spec.latest.title)}</td>
        <td><button type="button" class="compact-action" data-message="spec.open" data-spec="${escape(spec.specId)}" data-revision="${spec.latest.revision}">Open</button></td></tr>`).join('')}</tbody></table>` : ''}</div>
      <form class="ss-form" data-form="spec.new" aria-label="New specification">
        <h2>New specification</h2>
        <label class="field"><span>Specification ID</span><input name="specId" required pattern="SPEC-[A-Z0-9]+(-[A-Z0-9]+)*" placeholder="SPEC-CHK-004" autocomplete="off" spellcheck="false"></label>
        <label class="field"><span>Title</span><input name="title" required placeholder="Order discount threshold"></label>
        <label class="field"><span>Area of code (optional)</span><input name="areas" placeholder="src/pricing" autocomplete="off" spellcheck="false">
          <small class="muted">Paths research starts from; separate several with commas.</small></label>
        <p class="muted">The draft starts from the library template: Outcome, Actors, User scenarios, Scope, Requirements, Acceptance, and Decisions and open questions.</p>
        <div class="ss-controls"><button type="submit">${icon('add')}Start the draft</button><button type="reset" class="secondary" data-cancel>Cancel</button></div>
      </form>
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
  return `<aside class="ss-left" aria-label="Quality gate, records and steps">
    <h2>Quality gate</h2>${gate}
    <h2>Governed records</h2><ul class="ss-records">${records}</ul>
    <h2>Authoring loop</h2><ol class="ss-steps">${steps}</ol>
    ${status ? `<h2>Gap pipeline</h2>${pipeline ? `<ul class="ss-pipeline" data-pipeline>${pipeline}</ul>` : '<p class="muted">No gaps yet.</p>'}` : ''}
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
  return `<h2>${icon('edit')}Elicit</h2>
    <dl class="ss-facts"><dt>Title</dt><dd>${escape(status.title)}</dd>
      <dt>Area of code</dt><dd>${status.areas.length ? status.areas.map((area) => `<code>${escape(area || '.')}</code>`).join(' ') : '<span class="muted">none named; research names its own paths</span>'}</dd>
      <dt>Intent (Outcome)</dt><dd>${outcome ? `<pre class="ss-pre">${escape(outcome)}</pre>` : '<span class="muted">The specification has no Outcome section yet.</span>'}</dd>
      <dt>Based on</dt><dd>${status.basedOn ? `@${status.basedOn.revision} (${escape(status.basedOn.reviewState)})` : 'the library template; never published'}</dd></dl>
    <p class="muted">Change the prose in Draft. The title and area are set when the draft starts.</p>
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

function draftStage(status: SpecStatus): string {
  return `<h2>${icon('document')}Draft</h2>
    <form class="ss-form" data-form="spec.save">
      <input type="hidden" name="sequence" value="${status.sequence}">
      <label class="field"><span>spec.md, snapshot ${status.sequence}</span>
        <textarea name="text" class="ss-editor" rows="24" spellcheck="true">${escape(status.spec)}</textarea>
        <small class="muted">Write each clause with its literal anchor, for example [${escape(status.specId)}:REQ-002]. Saving makes the next snapshot; a save from an older snapshot is refused.</small></label>
      <div class="ss-controls"><button type="submit">${icon('ok')}Save snapshot ${status.sequence + 1}</button></div></form>
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
  return `<h2>${icon('gate')}Check</h2>
    <h3>D · deterministic</h3><ul class="ss-rules" data-rules>${rules}</ul>
    <h3>A · assisted</h3>${assistedHtml(status)}
    <h3>H · human</h3>
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
  return `<h2>${icon('archive')}Publish</h2>
    <p>The next revision is <strong data-next-revision>${escape(name)}</strong>: spec.md, gaps.json, research.json and quality.json, immutable on the state branch.</p>
    ${status.reviewReady ? '<div class="notice ok">Every D rule passes, no A finding is pending and nothing in H is open.</div>'
      : `<div class="notice warning"><p>Not ready to publish as reviewed:</p><ul>${status.blocking.map((finding) => `<li>${escape(finding.part)} ${escape(finding.message)}</li>`).join('')}</ul></div>`}
    <div class="ss-controls">
      <button type="button" data-message="spec.publish" data-state="reviewed"${status.reviewReady ? '' : ' disabled'}>${icon('approval')}Publish ${escape(name)} as reviewed</button>
      <button type="button" class="secondary" data-message="spec.publish" data-state="draft">Publish ${escape(name)} as a draft revision</button></div>
    <p class="muted">Publishing asks once, naming the revision. A draft revision is shown as a draft and a Story cannot attach it.</p>
    <h3>Discard</h3><p class="muted">Removes this clone's draft; published revisions stay.</p>
    <button type="button" class="danger" data-message="spec.discard">${icon('remove')}Discard the draft…</button>
    ${controls('publish', { cancel: false })}`;
}

function attachStage(state: SpecStudioPageState): string {
  const revision = state.revision;
  const chooser = `<form class="ss-form ss-inline" data-form="spec.attachRevision"><label class="field"><span>Revision</span>
    <input name="revision" inputmode="numeric" pattern="[1-9][0-9]*" value="${revision?.revision ?? ''}" placeholder="highest reviewed"></label>
    <button type="submit" class="secondary">Read it</button></form>`;
  if (!revision) {
    return `<h2>${icon('story')}Attach or split</h2>${chooser}<p class="muted">A Story attaches a reviewed revision, and a split divides one. Publish one, or read a revision by its number.</p>${controls('attach', { cancel: false })}`;
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
  return `<h2>${icon('story')}Attach or split</h2>${chooser}
    <p><strong>${escape(revision.specId)}@${revision.revision}</strong> ${statusPill(String(revision.manifest.reviewState ?? ''))} ${escape(String(revision.manifest.title ?? ''))}</p>
    ${reviewed ? '' : '<div class="notice warning">This revision is a draft revision; a Story attaches only a reviewed one.</div>'}
    <form class="ss-form" data-form="spec.slice" data-spec="${escape(revision.specId)}" data-revision="${revision.revision}" data-reviewed="${reviewed}" data-all="${escape(clauses.map((clause) => clause.id).join(' '))}">
      <fieldset><legend>Clauses this Story delivers</legend>${clauses.map((clause) => `<label class="ss-check"><input type="checkbox" name="clauses[]" value="${escape(clause.id)}"${chosen.includes(clause.id) ? ' checked' : ''}>
        <code>${escape(shortClause(revision.specId, clause.id))}</code> ${escape(clause.text.slice(0, 140))}</label>`).join('')}</fieldset>
      <p>Story start: <code data-slice-option>${escape(option)}</code></p>
      <pre class="ss-pre" data-start-command>${escape(startCommand(option))}</pre>
      <div class="ss-controls"><button type="button" data-copy-slice${reviewed ? '' : ' disabled'}>Copy the --spec option</button>
        <button type="button" class="secondary" data-copy-start${reviewed ? '' : ' disabled'}>Copy the start command</button></div>
      <p class="muted">The slice's clauses and the revision's decisions go into the Story's pinned source, and its scope review asks the Story to cover each one.</p></form>
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
  else if (state.step === 'draft') body = draftStage(status);
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
    <small class="muted">Opens Copilot Chat with <code>${escape(copilotPrompt(status.specId, copilot.tool))}</code>. It only proposes; you accept here.</small></p>`
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
  return `<section class="ss-tabs" aria-label="Findings and manifest">
    <div role="tablist"><button type="button" role="tab" aria-selected="true" data-tab="findings">Quality findings${status ? ` (${status.blocking.length})` : ''}</button>
      <button type="button" role="tab" aria-selected="false" data-tab="manifest">State-branch manifest</button>
      ${status ? `<button type="button" role="tab" aria-selected="false" data-tab="copilot">Copilot (${status.proposals.length})</button>` : ''}</div>
    <div role="tabpanel" data-panel="findings">${findings}</div><div role="tabpanel" data-panel="manifest" hidden>${manifest}</div>
    ${status ? `<div role="tabpanel" data-panel="copilot" hidden>${copilotHtml(state, status)}</div>` : ''}</section>`;
}

export function specStudioHtml(state: SpecStudioPageState): string {
  const specId = state.status?.specId ?? state.target.specId;
  const header = `<header class="inbox-header ss-header"><div>${brandLockup()}<p class="eyebrow">Specify</p>
      <h1>${icon('document', { size: 24 })}Spec Studio${specId ? ` · ${escape(specId)}` : ''}</h1>
      <p class="meta">${state.status ? `${escape(state.status.title)} · draft snapshot ${state.status.sequence}${state.status.basedOn ? ` · based on @${state.status.basedOn.revision}` : ''}`
        : specId ? 'Published revision' : 'Write, research, question and review a specification before any Story exists.'}</p></div>
    <div class="header-actions">${specId ? `<button type="button" class="secondary" data-message="spec.home">${icon('book')}Library</button>` : ''}
      <button type="button" class="secondary" data-message="spec.refresh"${state.busy ? ' disabled' : ''}>${icon('refresh')}Refresh</button></div></header>`;
  if (!specId) return `<div class="ss-root" data-view="library">${header}${notices(state)}${libraryHtml(state)}</div>`;
  return `<div class="ss-root" data-view="spec" data-spec="${escape(specId)}">${header}${notices(state)}
    <div class="ss-grid">${leftHtml(state)}${stageHtml(state)}${rightHtml(state)}</div>${tabsHtml(state)}</div>`;
}

export const SPEC_STUDIO_STYLE = `
body:has(.ss-root) { max-width:none; }
.ss-header { display:flex; flex-wrap:wrap; justify-content:space-between; gap:1rem; align-items:flex-end; }
.ss-grid { display:grid; grid-template-columns:minmax(14rem,18rem) minmax(0,1fr) minmax(16rem,28rem); gap:1rem; margin:1rem 0; align-items:start; }
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
.ss-editor { font-family:var(--vscode-editor-font-family); font-size:var(--vscode-editor-font-size); min-height:24rem; resize:vertical; }
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
.ss-columns-2 { display:grid; grid-template-columns:minmax(0,1.4fr) minmax(16rem,1fr); gap:1.5rem; }
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
  const split = (text) => String(text || '').split(/[,\\n]/).map((entry) => entry.trim()).filter(Boolean);
  const transforms = {
    'spec.new': (value) => ({ specId: value.specId.trim(), title: value.title.trim(), areas: split(value.areas) }),
    'spec.research': (value) => ({ paths: split(value.paths), refresh: value.refresh === true }),
    'spec.save': (value) => ({ text: value.text, sequence: Number(value.sequence) }),
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
    for (const key of ['step', 'gap', 'spec', 'revision', 'item', 'state', 'text', 'path', 'line']) if (button.dataset[key] !== undefined) message[key] = button.dataset[key];
    if (message.revision !== undefined) message.revision = Number(message.revision);
    if (message.line !== undefined) message.line = Number(message.line);
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
    syncDecide();
    const slice = event.target.closest('form[data-form="spec.slice"]');
    if (slice) syncSlice(slice);
  });
  syncDecide();
  for (const form of root.querySelectorAll('form[data-form="spec.slice"]')) syncSlice(form);
})();
`;
