/**
 * The Spec Studio's split planner (SPEC-SPA v1.3 §7, milestone S5), with no VS Code API.
 *
 * Stage 7 divides a reviewed revision among child specifications and Story slices. The person
 * assigns each clause to one or more groups, or leaves it out with a reason; the host writes that
 * plan to a private temporary file for `spec split SPEC-ID@N --propose --file FILE`, which checks it
 * and keeps it on this clone, and publishing it is one confirmation naming the split
 * (`spec split SPEC-ID@N --publish`). The engine decides every rule; this module only builds the
 * command lines, reads the answers and renders the planner. Nothing here calls a model.
 */
import { escape, icon } from './webview.ts';

export interface SpecSplitStory { key: string; title: string; description: string; workId: string | null; clauses: string[]; dependsOn: string[]; command: string }
export interface SpecSplitChild { specId: string; title: string; clauses: string[] }
export interface SpecSplitLeftOut { clause: string; reason: string }
export interface SpecSplitPlan { children: SpecSplitChild[]; stories: Array<Omit<SpecSplitStory, 'command'>>; notDelivered: SpecSplitLeftOut[] }
export interface SpecSplitRecord {
  split: number; recordedAt: string; publishedBy: string | null; children: SpecSplitChild[]; stories: SpecSplitStory[]; notDelivered: SpecSplitLeftOut[];
}
export interface SpecSplitProposal { plan: SpecSplitPlan; planSha256: string; stale: boolean; findings: Array<{ code: string; message: string }>; stories: SpecSplitStory[] }
export interface SpecSplitView { specId: string; revision: number; splits: SpecSplitRecord[]; proposal: SpecSplitProposal | null }

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const strings = (value: unknown): string[] => list(value).filter((entry): entry is string => typeof entry === 'string');
const short = (specId: string, clause: string): string => (clause.startsWith(`${specId}:`) ? clause.slice(specId.length + 1) : clause);

// ---- Command lines and answers -------------------------------------------------------------

export const splitArgv = (specId: string, revision: number): string[] => ['spec', 'split', `${specId}@${revision}`, '--json'];
export const splitProposeArgv = (specId: string, revision: number, file: string): string[] =>
  ['spec', 'split', `${specId}@${revision}`, '--propose', '--file', file, '--json'];
/** No host operation ID: the engine derives it from the proposed plan, so a retry is the same split. */
export const splitPublishArgv = (specId: string, revision: number): string[] => ['spec', 'split', `${specId}@${revision}`, '--publish', '--json'];

function storyFrom(raw: unknown): SpecSplitStory {
  const entry = record(raw);
  return { key: text(entry.key), title: text(entry.title), description: text(entry.description), workId: typeof entry.workId === 'string' ? entry.workId : null,
    clauses: strings(entry.clauses), dependsOn: strings(entry.dependsOn), command: text(entry.command) };
}

/** A published child names each clause as `{ parent, child }`; a plan's child names the parent clauses. */
function childFrom(raw: unknown): SpecSplitChild {
  const entry = record(raw);
  return { specId: text(entry.specId), title: text(entry.title),
    clauses: list(entry.clauses).map((clause) => (typeof clause === 'string' ? clause : text(record(clause).parent))).filter(Boolean) };
}

const leftOutFrom = (raw: unknown): SpecSplitLeftOut[] => list(raw).map(record).map((entry) => ({ clause: text(entry.clause), reason: text(entry.reason) }));

function planFrom(raw: unknown): SpecSplitPlan {
  const plan = record(raw);
  return { children: list(plan.children).map(childFrom), stories: list(plan.stories).map(storyFrom).map(({ command: _command, ...story }) => story),
    notDelivered: leftOutFrom(plan.notDelivered) };
}

/** `spec split SPEC-ID@N --json`: the revision's published splits and the plan proposed on this clone. */
export function splitFrom(raw: unknown): SpecSplitView | null {
  const result = record(raw);
  if (result.resultType !== 'sflow-spec-author' || result.action !== 'split' || result.mode !== 'read' || typeof result.revision !== 'number') return null;
  const proposal = result.proposal ? record(result.proposal) : null;
  return {
    specId: text(result.specId), revision: result.revision,
    splits: list(result.splits).map(record).map((split) => ({ split: typeof split.split === 'number' ? split.split : 0, recordedAt: text(split.recordedAt),
      publishedBy: text(record(split.publishedBy).name) || null, children: list(split.children).map(childFrom), stories: list(split.stories).map(storyFrom),
      notDelivered: leftOutFrom(split.notDelivered) })),
    proposal: proposal && { plan: planFrom(proposal.plan), planSha256: text(proposal.planSha256), stale: proposal.stale === true,
      findings: list(proposal.findings).map(record).map((finding) => ({ code: text(finding.code), message: text(finding.message) })), stories: list(proposal.stories).map(storyFrom) }
  };
}

/**
 * The plan the page posts, kept to its shape: strings and lists only, every clause one of the
 * revision's. The engine checks every rule of a split again when it is proposed.
 */
export function splitPlanRequest(raw: unknown, clauses: readonly string[]): SpecSplitPlan {
  const plan = record(record(raw).plan);
  const known = (values: unknown): string[] => [...new Set(strings(values).filter((clause) => clauses.includes(clause)))];
  return {
    children: list(plan.children).map(record).map((entry) => ({ specId: text(entry.specId).trim(), title: text(entry.title).trim(), clauses: known(entry.clauses) })),
    stories: list(plan.stories).map(record).map((entry) => ({ key: text(entry.key).trim(), title: text(entry.title).trim(), description: text(entry.description).trim(),
      workId: text(entry.workId).trim() || null, clauses: known(entry.clauses), dependsOn: strings(entry.dependsOn).map((key) => key.trim()).filter(Boolean) })),
    notDelivered: list(plan.notDelivered).map(record).filter((entry) => clauses.includes(text(entry.clause)) && text(entry.reason).trim())
      .map((entry) => ({ clause: text(entry.clause), reason: text(entry.reason).trim() }))
  };
}

/** The plan as the engine reads it: a slice without a work ID or description leaves them out. */
export function planFileText(plan: SpecSplitPlan): string {
  return `${JSON.stringify({
    children: plan.children,
    stories: plan.stories.map(({ workId, description, dependsOn, ...story }) => ({ ...story, ...(description ? { description } : {}), ...(workId ? { workId } : {}),
      ...(dependsOn.length ? { dependsOn } : {}) })),
    notDelivered: plan.notDelivered
  }, null, 2)}\n`;
}

export function splitConfirmation(view: SpecSplitView, proposal: SpecSplitProposal) {
  const name = `${view.specId}@${view.revision}`;
  const next = (view.splits.at(-1)?.split ?? 0) + 1;
  return {
    title: `Publish split ${next} of ${name}`,
    summary: `Divides ${name} among ${proposal.plan.children.length} child specification(s) and ${proposal.stories.length} Story slice(s) on the state branch, signed with your Git identity. No Story is started.`,
    detail: [`singularity-flow ${splitPublishArgv(view.specId, view.revision).filter((part) => part !== '--json').join(' ')}`, '',
      ...proposal.plan.children.map((child) => `Child ${child.specId} "${child.title}", drafted on this clone: ${child.clauses.map((clause) => short(view.specId, clause)).join(', ')}`),
      ...proposal.stories.map((story) => `Slice ${story.key} "${story.title}": ${story.clauses.map((clause) => short(view.specId, clause)).join(', ')}\n  ${story.command}`),
      ...proposal.plan.notDelivered.map((entry) => `Not delivered here: ${short(view.specId, entry.clause)}: ${entry.reason}`)].join('\n'),
    confirmLabel: `Publish split ${next}`
  };
}

// ---- The planner ---------------------------------------------------------------------------

interface Group { kind: 'story' | 'child'; key: string; specId: string; title: string; description: string; workId: string; dependsOn: string; clauses: string[] }

function groupHtml(specId: string, clauses: ReadonlyArray<{ id: string; text: string }>, group: Group): string {
  const hidden = (kind: Group['kind']): string => (group.kind === kind ? '' : ' hidden');
  return `<fieldset class="ss-split-group" data-split-group>
    <legend><select name="kind" aria-label="Kind"><option value="story"${group.kind === 'story' ? ' selected' : ''}>Story slice</option>
      <option value="child"${group.kind === 'child' ? ' selected' : ''}>Child specification</option></select>
      <button type="button" class="secondary compact-action" data-split-remove>Remove</button></legend>
    <div class="ss-split-fields">
      <label class="field" data-for="story"${hidden('story')}><span>Slice key</span><input name="key" value="${escape(group.key)}"></label>
      <label class="field" data-for="child"${hidden('child')}><span>Specification ID</span><input name="specId" value="${escape(group.specId)}" placeholder="${escape(specId)}-PART"></label>
      <label class="field"><span>Title</span><input name="title" value="${escape(group.title)}"></label>
      <label class="field" data-for="story"${hidden('story')}><span>Work ID (optional)</span><input name="workId" value="${escape(group.workId)}"></label>
      <label class="field" data-for="story"${hidden('story')}><span>After slices (keys)</span><input name="dependsOn" value="${escape(group.dependsOn)}" placeholder="S1, S2"></label>
      <label class="field ss-wide" data-for="story"${hidden('story')}><span>Description</span><textarea name="description" rows="2">${escape(group.description)}</textarea></label>
    </div>
    <div class="ss-split-clauses">${clauses.map((clause) => `<label class="ss-check"><input type="checkbox" data-clause value="${escape(clause.id)}"${group.clauses.includes(clause.id) ? ' checked' : ''}>
      <code>${escape(short(specId, clause.id))}</code> ${escape(clause.text.slice(0, 100))}</label>`).join('')}</div></fieldset>`;
}

function storyLines(specId: string, stories: readonly SpecSplitStory[]): string {
  return stories.map((story) => `<li><strong>${escape(story.key)}</strong> ${escape(story.title)}: ${escape(story.clauses.map((clause) => short(specId, clause)).join(', '))}
    ${story.dependsOn.length ? `<small class="muted">after ${escape(story.dependsOn.join(', '))}</small>` : ''}
    <pre class="ss-pre">${escape(story.command)}</pre>
    <button type="button" class="secondary compact-action" data-message="spec.copy" data-text="${escape(story.command)}">Copy the start command</button></li>`).join('');
}

/** The published splits of the revision, the proposed plan, and the planner itself. */
export function splitSectionHtml(view: SpecSplitView | null, revision: { specId: string; revision: number; reviewed: boolean },
  clauses: ReadonlyArray<{ id: string; text: string }>, editing: SpecSplitPlan | null = null): string {
  const { specId } = revision;
  const name = `${specId}@${revision.revision}`;
  if (!revision.reviewed) return `<h3>${icon('story')}Split</h3><p class="muted">${escape(name)} is a draft revision; only a reviewed revision can be split.</p>`;
  const latest = view?.splits.at(-1) ?? null;
  const published = latest ? `<div class="ss-split-published" data-split-published><h4>Split ${latest.split}, published ${escape(latest.recordedAt.slice(0, 16).replace('T', ' '))}${latest.publishedBy ? ` by ${escape(latest.publishedBy)}` : ''}</h4>
      <ul>${latest.children.map((child) => `<li>Child <code>${escape(child.specId)}</code> ${escape(child.title)}: ${escape(child.clauses.map((clause) => short(specId, clause)).join(', '))}
        <button type="button" class="secondary compact-action" data-message="spec.open" data-spec="${escape(child.specId)}">Open in Spec Studio</button></li>`).join('')}</ul>
      <ul class="ss-split-stories">${storyLines(specId, latest.stories)}</ul>
      ${latest.notDelivered.length ? `<p class="muted">Not delivered here: ${escape(latest.notDelivered.map((entry) => `${short(specId, entry.clause)} (${entry.reason})`).join('; '))}</p>` : ''}</div>` : '';
  const proposal = view?.proposal ?? null;
  // A plan the engine refused stays in the form as the person left it; otherwise the proposal on this clone.
  const shown = editing ?? proposal?.plan ?? null;
  const seed: Group[] = shown
    ? [...shown.children.map((child) => ({ kind: 'child' as const, key: '', specId: child.specId, title: child.title, description: '', workId: '', dependsOn: '', clauses: child.clauses })),
      ...shown.stories.map((story) => ({ kind: 'story' as const, key: story.key, specId: '', title: story.title, description: story.description, workId: story.workId ?? '',
        dependsOn: story.dependsOn.join(', '), clauses: story.clauses }))]
    : [{ kind: 'story', key: 'S1', specId: '', title: '', description: '', workId: '', dependsOn: '', clauses: clauses.map((clause) => clause.id) }];
  const leftOut = new Map((shown?.notDelivered ?? []).map((entry) => [entry.clause, entry.reason]));
  const proposed = proposal ? `<div class="ss-split-proposal" data-split-proposal>
      <h4>Proposed on this clone</h4>
      ${proposal.stale ? '<div class="notice warning">The proposal was checked against other bytes of this revision; propose it again.</div>' : ''}
      ${proposal.findings.length ? `<div class="notice error">${escape(proposal.findings.map((finding) => finding.message).join('; '))}</div>` : `<ul>${proposal.plan.children.map((child) =>
        `<li>Child <code>${escape(child.specId)}</code> ${escape(child.title)}: ${escape(child.clauses.map((clause) => short(specId, clause)).join(', '))}, drafted on this clone when published</li>`).join('')}</ul>
      <ul class="ss-split-stories">${storyLines(specId, proposal.stories)}</ul>
      ${proposal.plan.notDelivered.length ? `<p class="muted">Not delivered here: ${escape(proposal.plan.notDelivered.map((entry) => `${short(specId, entry.clause)} (${entry.reason})`).join('; '))}</p>` : ''}`}
      <div class="ss-controls"><button type="button" data-message="spec.splitPublish" data-revision="${revision.revision}"${proposal.findings.length || proposal.stale ? ' disabled' : ''}>${icon('ok')}Publish the split…</button>
        <span class="muted">Publishing asks once, names the split and starts no Story.</span></div></div>` : '';
  const empty: Group = { kind: 'story', key: '', specId: '', title: '', description: '', workId: '', dependsOn: '', clauses: [] };
  return `<h3>${icon('story')}Split ${escape(name)}</h3>${published}${proposed}
    <form class="ss-form" data-split-form data-spec="${escape(specId)}" data-revision="${revision.revision}">
      <p class="muted">Give every clause to a child specification or a Story slice, or say why it is not delivered here. A slice that needs a clause another slice delivers comes after it.</p>
      <div data-split-groups>${seed.map((group) => groupHtml(specId, clauses, group)).join('')}</div>
      <template data-split-template>${groupHtml(specId, clauses, empty)}</template>
      <div class="ss-controls"><button type="button" class="secondary" data-split-add="story">Add a Story slice</button>
        <button type="button" class="secondary" data-split-add="child">Add a child specification</button></div>
      <fieldset><legend>Not delivered here</legend>${clauses.map((clause) => `<label class="field"><span><code>${escape(short(specId, clause.id))}</code> reason</span>
        <input data-left-out="${escape(clause.id)}" value="${escape(leftOut.get(clause.id) ?? '')}" placeholder="Leave empty when a group delivers it"></label>`).join('')}</fieldset>
      <p class="muted" data-split-unallocated></p>
      <div class="ss-controls"><button type="button" data-split-propose>${icon('gate')}Check and propose the split</button>
        <span class="muted">Proposing keeps the plan on this clone; nothing is published.</span></div></form>`;
}

export const SPEC_STUDIO_SPLIT_STYLE = `
.ss-split-group { display:grid; gap:.5rem; }
/* A field of the other kind is hidden; the field's own display would otherwise win over the attribute. */
.ss-split-group [hidden] { display:none !important; }
.ss-split-group legend { display:flex; gap:.5rem; align-items:center; }
.ss-split-fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(10rem,1fr)); gap:.5rem; }
.ss-split-fields .ss-wide { grid-column:1 / -1; }
.ss-split-clauses { display:grid; gap:.2rem; }
.ss-split-stories { list-style:none; padding:0; display:grid; gap:.5rem; }
.ss-split-published, .ss-split-proposal { padding:.6rem; margin:.5rem 0; border:var(--sf-border); border-radius:var(--sf-radius); }
`;

/** The planner's page behaviour: groups added and removed, the plan read from the form and posted. */
export const SPEC_STUDIO_SPLIT_SCRIPT = `
(() => {
  const api = window.__sfVscode;
  const form = document.querySelector('form[data-split-form]');
  if (!form) return;
  const groups = form.querySelector('[data-split-groups]');
  const value = (group, name) => (group.querySelector('[name="' + name + '"]') || { value: '' }).value.trim();
  function showKind(group) {
    const kind = value(group, 'kind');
    for (const field of group.querySelectorAll('[data-for]')) field.hidden = field.dataset.for !== kind;
  }
  function plan() {
    const children = [], stories = [], notDelivered = [];
    for (const group of groups.querySelectorAll('[data-split-group]')) {
      const clauses = Array.from(group.querySelectorAll('input[data-clause]:checked')).map((input) => input.value);
      if (value(group, 'kind') === 'child') { children.push({ specId: value(group, 'specId'), title: value(group, 'title'), clauses: clauses }); continue; }
      stories.push({ key: value(group, 'key'), title: value(group, 'title'), description: value(group, 'description'), workId: value(group, 'workId'),
        dependsOn: value(group, 'dependsOn').split(',').map((key) => key.trim()).filter(Boolean), clauses: clauses });
    }
    for (const input of form.querySelectorAll('[data-left-out]')) if (input.value.trim()) notDelivered.push({ clause: input.dataset.leftOut, reason: input.value.trim() });
    return { children: children, stories: stories, notDelivered: notDelivered };
  }
  function sync() {
    const current = plan();
    const given = new Set([...current.children, ...current.stories].flatMap((group) => group.clauses).concat(current.notDelivered.map((entry) => entry.clause)));
    const missing = Array.from(form.querySelectorAll('[data-left-out]')).map((input) => input.dataset.leftOut).filter((clause) => !given.has(clause));
    const shown = form.querySelector('[data-split-unallocated]');
    if (shown) shown.textContent = missing.length ? 'Not yet given to any group or left out: ' + missing.map((clause) => clause.slice(clause.indexOf(':') + 1)).join(', ') : 'Every clause is given to a group or left out.';
  }
  form.addEventListener('click', (event) => {
    const add = event.target.closest('[data-split-add]');
    if (add) {
      const fresh = form.querySelector('[data-split-template]').content.firstElementChild.cloneNode(true);
      fresh.querySelector('[name="kind"]').value = add.dataset.splitAdd;
      if (add.dataset.splitAdd === 'story') fresh.querySelector('[name="key"]').value = 'S' + (groups.querySelectorAll('[data-split-group]').length + 1);
      groups.appendChild(fresh);
      showKind(fresh);
      sync();
      return;
    }
    const remove = event.target.closest('[data-split-remove]');
    if (remove) { remove.closest('[data-split-group]').remove(); sync(); return; }
    if (event.target.closest('[data-split-propose]')) api.postMessage({ type: 'spec.splitPropose', revision: Number(form.dataset.revision), plan: plan() });
  });
  form.addEventListener('change', (event) => { const group = event.target.closest('[data-split-group]'); if (group) showKind(group); sync(); });
  form.addEventListener('input', sync);
  form.addEventListener('submit', (event) => event.preventDefault());
  sync();
})();
`;
