/**
 * SF Guard's pages: the Guard page, its first-run card, the sign card, and the SF Guard standing the
 * Story, approval and review views show. Markup only; the extension decides what a click does.
 * [SPEC-PSS-v1 M5, AC-014] [SPEC-SFG-v1 G5, AC-012]
 */
import { escape, icon } from './webview.ts';
import {
  APPROVAL_STATE_PILL, CLASS_WORDS, remoteWords, SF_GUARD_RECIPE_PATH, SF_GUARD_RECIPE_ROUTE, SF_GUARD_RULE, signCommandText, totalsWords,
  type ApprovalStanding, type GuardReport, type GuardStatus, type PacketLabels, type SignRequest, type StoryStanding
} from './sf-guard-model.ts';

export type StoryRead = StoryStanding | 'loading' | { error: string };

export interface GuardPageView {
  status: GuardStatus | null;
  report: GuardReport | null;
  error: string | null;
  busy: boolean;
  firstRun: boolean;
  notice: string | null;
  stories: Readonly<Record<string, StoryRead>>;
  recipe: { path: string; text: string; incomplete: boolean } | null;
}

/** The first-run card: why Touch ID, and the one rule [PSS:REQ-012]. */
export function firstRunCardHtml({ dismissible = true }: { dismissible?: boolean } = {}): string {
  return `<section class="sfg-first-run" aria-labelledby="sfg-first-run-title">
    <h2 id="sfg-first-run-title">${icon('policy')}How SF Guard asks for your touch</h2>
    <p>In a repository that has turned SF Guard on, a person's step (approve, reject, a decision) carries your Touch ID presence signature, so no agent can take it for you.</p>
    <ol>
      <li>VS Code shows this step's card, then types the same command into <strong>your own terminal</strong>. You press Enter.</li>
      <li>The command prints its card there: the step, its subject and your key.</li>
      <li>Then macOS asks for Touch ID. Its prompt cannot say which step it is for, so the card is how you know.</li>
    </ol>
    <p class="sfg-rule" role="note"><strong>The rule:</strong> ${escape(SF_GUARD_RULE)}</p>
    <p class="muted">Agents never sign: Copilot is refused every person step, with your exact command to run yourself. Declining the prompt writes nothing.</p>
    ${dismissible ? '<button type="button" class="secondary" data-first-run-seen>Got it</button>' : ''}
  </section>`;
}

const pill = (tone: string, words: string): string => `<span class="pill ${escape(tone)}">${escape(words)}</span>`;

function switchHtml(status: GuardStatus): string {
  const head = status.on
    ? `${pill('ok', 'on')} Person steps are presence-signed in this repository.`
    : `${pill('idle', 'off')} Person steps are unsigned here. Nothing is asked of anyone.`;
  const chain = status.chainId
    ? `<p class="muted">Policy chain ${escape(status.chainId)}: ${status.validEvents} of ${status.events} event(s) verify${status.historyChecked ? '' : ' (history not checked in this clone)'}.</p>` : '';
  const problems = status.problems.length
    ? `<ul class="sfg-problems">${status.problems.map((problem) => `<li>${icon('bad', { size: 14 })}<code>${escape(problem.code)}</code> ${escape(problem.message)}</li>`).join('')}</ul>` : '';
  const optIn = !status.on && !status.chainId
    ? `<p class="muted">Opt in, in your own terminal with Touch ID: <code>singularity-flow guard register</code>, then <code>singularity-flow guard enable</code>.</p>` : '';
  return `<section class="sfg-section" data-sfg="switch"><h2>${icon('policy')}SF Guard</h2><p class="sfg-switch">${head}</p>${chain}${problems}${optIn}</section>`;
}

function keysHtml(status: GuardStatus): string {
  // Off, only registered keys matter; on, every approver's standing does (an unregistered one too).
  const rows = status.keys.filter((row) => status.on || row.keyId || row.exception);
  if (!rows.length) return `<section class="sfg-section" data-sfg="keys"><h2>${icon('approval')}Registered keys</h2><p class="muted">No presence key is registered here.</p></section>`;
  return `<section class="sfg-section" data-sfg="keys"><h2>${icon('approval')}Registered keys</h2>
    <div class="table-wrap"><table class="sfg-table"><thead><tr><th>Approver</th><th>Key</th><th>Expiry</th><th>Standing</th></tr></thead><tbody>${rows.map((row) => `
      <tr data-approver="${escape(row.approver)}"><td>${escape(row.label)}<br><small class="muted">${escape(row.approver)}</small></td>
        <td>${row.keyId ? `<code>${escape(row.keyId)}</code>${row.recovered ? ' <small>(recovered)</small>' : ''}` : '<span class="muted">none</span>'}</td>
        <td>${pill(row.expiryTone, row.expiry)}</td>
        <td>${row.exception ? pill('wait', 'bypass') : ''} ${escape(row.standing)}</td></tr>`).join('')}</tbody></table></div></section>`;
}

function exceptionsHtml(status: GuardStatus): string {
  if (!status.exceptions.length) return '';
  return `<section class="sfg-section" data-sfg="exceptions"><h2>${icon('warning')}Exceptions</h2>
    <p class="muted">An approver under an exception takes person steps unsigned. Every surface labels them as a bypass.</p>
    <ul class="sfg-list">${status.exceptions.map((entry) => `<li data-exception="${escape(entry.id)}">${pill(entry.active ? 'wait' : 'idle', entry.active ? 'bypass' : 'revoked')}
      <strong>${escape(entry.label)}</strong> · ${escape(entry.who)} <small class="muted">${escape(entry.approver)}</small><br><small>${escape(entry.reason)}</small></li>`).join('')}</ul></section>`;
}

function remoteHtml(status: GuardStatus, recipe: GuardPageView['recipe']): string {
  const { words, tone } = remoteWords(status);
  return `<section class="sfg-section" data-sfg="remote"><h2>${icon('gate')}Branch protection</h2>
    <p>${pill(tone, tone === 'ok' ? 'required' : tone === 'bad' ? 'not required' : 'check')} ${escape(words)}</p>
    <p class="muted">The remote check re-verifies every signature on the Git host. Save the CI recipe as <code>${escape(SF_GUARD_RECIPE_PATH)}</code> in a reviewed change, then make the check required in branch protection; SF Guard reads protection and never changes it.</p>
    <div class="sfg-route"><code>${escape(SF_GUARD_RECIPE_ROUTE)}</code>
      <button type="button" class="secondary compact-action" data-copy="${escape(SF_GUARD_RECIPE_ROUTE)}">Copy</button>
      <button type="button" class="secondary compact-action" data-recipe>Show the recipe</button></div>
    ${recipe ? `<details open class="sfg-recipe"><summary>${escape(recipe.path)}${recipe.incomplete ? ' — pin the SFlow release it installs first' : ''}</summary><pre>${escape(recipe.text)}</pre></details>` : ''}
  </section>`;
}

function recordingHtml(status: GuardStatus, report: GuardReport | null): string {
  const recording = status.recording;
  const on = (recording?.state ?? report?.recording) === 'on';
  const gap = recording?.lastGap ?? report?.lastGap ?? null;
  return `<section class="sfg-section" data-sfg="recording"><h2>${icon('impact')}Recording</h2>
    <p>${pill(on ? 'ok' : 'idle', on ? 'on' : 'off')} ${on ? 'This checkout records which agent and skill wrote what.' : 'Nothing is recorded here: work reads unattributed or before SF Guard.'}</p>
    ${gap ? `<p class="muted">Last gap: <code>${escape(gap.code)}</code> at ${escape(gap.at)}${recording ? ` (${recording.gaps} recent)` : ''}. The hooks' answers were unchanged.</p>` : ''}
  </section>`;
}

function packetHtml(packet: PacketLabels): string {
  return `<li class="sfg-packet" data-packet="${escape(packet.packetSha256)}"><strong>${escape(packet.phase)}</strong> generation ${packet.generation}
    ${pill(packet.packet === 'intact' ? 'ok' : 'bad', `packet ${packet.packet}`)}
    ${packet.summary ? `<p class="sfg-summary">${escape(packet.summary)}</p>` : ''}
    <ul class="sfg-labels">${packet.labels.map((label) => `<li>${escape(label)}</li>`).join('')}</ul></li>`;
}

export function approvalPillHtml(standing: ApprovalStanding | null | undefined): string {
  if (!standing) return '';
  const state = APPROVAL_STATE_PILL[standing.state];
  return `<span class="pill ${escape(state.tone)} sfg-standing" data-sfg-state="${escape(standing.state)}" title="${escape(standing.label)}">${escape(state.words)}</span>`;
}

/**
 * A Story's SF Guard standing, for the Story, approval and review views: each recorded decision as SF
 * Guard counts it (signed, pre-signing, bypass, not counted) and each packet's attribution summary.
 * `phase` narrows it to one step.
 */
export function storyStandingHtml(standing: StoryRead | null | undefined, { phase = null as string | null, heading = true } = {}): string {
  if (!standing) return '';
  const title = heading ? `<h3>${icon('policy', { size: 14 })}SF Guard</h3>` : '';
  if (standing === 'loading') return `<section class="sfg-story" data-sfg="story" aria-busy="true">${title}<p class="muted">Reading SF Guard's standing…</p></section>`;
  if ('error' in standing) return `<section class="sfg-story" data-sfg="story">${title}<p class="muted">SF Guard's standing could not be read: ${escape(standing.error)}</p></section>`;
  const approvals = standing.approvals.filter((entry) => !phase || entry.phase === phase);
  const packets = standing.packets.filter((entry) => !phase || entry.phase === phase);
  const decisions = approvals.length
    ? `<ul class="sfg-list">${approvals.map((entry) => `<li data-approval-at="${escape(entry.at ?? '')}">${approvalPillHtml(entry)}
        <strong>${escape(entry.actor)}</strong> ${escape(entry.decision)} ${escape(entry.phase)}${entry.active ? '' : ' <small class="muted">(withdrawn)</small>'}
        <br><small>${escape(entry.label)}</small></li>`).join('')}</ul>`
    : '<p class="muted">No decision recorded yet.</p>';
  const labels = packets.length ? `<ul class="sfg-list">${packets.map(packetHtml).join('')}</ul>`
    : `<p class="muted">${standing.packetStatus === 'available' || standing.packetStatus == null ? 'No submitted packet carries labels yet.' : `Labels not readable here (${escape(standing.packetStatus)}).`}</p>`;
  return `<section class="sfg-story" data-sfg="story">${title}
    <h4>Decisions</h4>${decisions}
    <h4>Packets</h4>${labels}
    <p class="muted">Labels never refuse anything. Unattributed means nothing recorded explains it, never "a person": only a presence signature proves a person.</p></section>`;
}

function subjectHtml(subject: GuardReport['subjects'][number], story: StoryRead | undefined): string {
  const counts = Object.entries(subject.counts).filter(([, n]) => n).map(([name, n]) => `${n} ${CLASS_WORDS[name] ?? name}`).join(' · ') || 'none';
  return `<article class="sfg-subject" data-scope="${escape(subject.scope)}"><header><h3>${escape(subject.title)}</h3><small class="muted">${escape(counts)}</small></header>
    <ul class="sfg-groups">${subject.groups.slice(0, 12).map((group) => `<li data-class="${escape(group.classification)}">${escape(group.words)}</li>`).join('')}</ul>
    ${subject.scope === 'repository' ? '' : story ? storyStandingHtml(story, { heading: false })
    : `<button type="button" class="secondary compact-action" data-story="${escape(subject.scope)}">Show labels by step</button>`}
  </article>`;
}

function reportHtml(report: GuardReport | null, stories: GuardPageView['stories']): string {
  if (!report) return '';
  return `<section class="sfg-section" data-sfg="report"><h2>${icon('story')}Labels by Story</h2>
    <p>Recorded calls${report.since ? ` since ${escape(report.since)}` : " (this machine's 14-day records)"}: <strong data-sfg-totals>${escape(totalsWords(report.totals))}</strong></p>
    ${report.subjects.length ? report.subjects.map((subject) => subjectHtml(subject, stories[subject.scope])).join('') : '<p class="muted">Nothing recorded on this machine.</p>'}
    <p class="muted">The same counts as <code>singularity-flow guard report</code>, from the same reader. Off-workflow work is labelled, never refused.</p></section>`;
}

export function guardPageHtml(view: GuardPageView): string {
  const header = `<header><h1>${icon('policy', { size: 20 })}SF Guard</h1>
    <p class="meta">Presence-signed person steps, and who wrote what. <button type="button" class="link" data-refresh${view.busy ? ' disabled' : ''}>Refresh</button></p></header>`;
  const notice = view.notice ? `<p class="callout" role="status">${escape(view.notice)}</p>` : '';
  const error = view.error ? `<div role="alert" class="sfg-error"><p>${escape(view.error)}</p></div>` : '';
  if (!view.status) {
    return `${header}${view.firstRun ? firstRunCardHtml() : ''}${notice}${error}${view.busy ? '<p class="muted" aria-busy="true">Reading SF Guard…</p>' : ''}`;
  }
  return `${header}${view.firstRun ? firstRunCardHtml() : ''}${notice}${error}
    <div class="sfg-grid">${switchHtml(view.status)}${recordingHtml(view.status, view.report)}</div>
    ${keysHtml(view.status)}${exceptionsHtml(view.status)}${remoteHtml(view.status, view.recipe)}${reportHtml(view.report, view.stories)}
    ${view.firstRun ? '' : '<p class="muted"><button type="button" class="link" data-first-run-show>How SF Guard asks for your touch</button></p>'}`;
}

export const GUARD_SCRIPT = `
(() => {
  const api = window.__sfVscode;
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-refresh],[data-story],[data-recipe],[data-copy],[data-first-run-seen],[data-first-run-show]');
    if (!target || target.disabled) return;
    if (target.hasAttribute('data-refresh')) api.postMessage({ type: 'guard.refresh' });
    else if (target.dataset.story) { target.disabled = true; api.postMessage({ type: 'guard.story', workId: target.dataset.story }); }
    else if (target.hasAttribute('data-recipe')) { target.disabled = true; api.postMessage({ type: 'guard.recipe' }); }
    else if (target.dataset.copy) api.postMessage({ type: 'guard.copy', text: target.dataset.copy });
    else if (target.hasAttribute('data-first-run-seen')) api.postMessage({ type: 'guard.firstRunSeen' });
    else if (target.hasAttribute('data-first-run-show')) api.postMessage({ type: 'guard.firstRunShow' });
  });
})();
`;

export interface SignCardView {
  request: SignRequest;
  firstRun: boolean;
  /** `ready` before the person opens their terminal; `sent` after; `stale` when the repository changed. */
  state: 'ready' | 'sent' | 'stale';
}

/** The sign card: the step, the exact command, and the rule, before the person's own terminal opens. */
export function signCardHtml(view: SignCardView): string {
  const { request } = view;
  const command = signCommandText(request.args);
  const action = view.state === 'ready'
    ? `<div class="sfg-actions"><button type="button" data-sign>${icon('approval')}Open my terminal to sign</button>
        <button type="button" class="secondary" data-cancel>Not now</button></div>
       <p class="muted">Nothing has been written. Your terminal gets the same command, for you to run: it prints its card, then Touch ID asks.</p>`
    : view.state === 'sent'
      ? `<p class="callout" role="status">${icon('wait')}The command is typed into your terminal. Press Enter there, read the card it prints, then touch the sensor. If a prompt comes without that card, decline it.</p>
         <div class="sfg-actions"><button type="button" class="secondary" data-done>Done: refresh</button></div>`
      : '<p class="callout" role="alert">The repository changed since this step was refused. Start it again from its view.</p>';
  return `<header><h1>${icon('policy', { size: 20 })}SF Guard: your touch is needed</h1></header>
    ${view.firstRun ? firstRunCardHtml({ dismissible: false }) : ''}
    <section class="sfg-card" aria-labelledby="sfg-card-title" data-sign-state="${escape(view.state)}">
      <h2 id="sfg-card-title">${escape(request.title)}</h2>
      <dl class="sfg-card-fields"><dt>Command</dt><dd><code>${escape(command)}</code></dd>
        <dt>Repository</dt><dd><code>${escape(request.repository)}</code></dd></dl>
      <p class="sfg-rule" role="note"><strong>The rule:</strong> ${escape(SF_GUARD_RULE)}</p>
      ${action}
    </section>`;
}

export const SIGN_CARD_SCRIPT = `
(() => {
  const api = window.__sfVscode;
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-sign],[data-cancel],[data-done]');
    if (!target || target.disabled) return;
    if (target.hasAttribute('data-sign')) { target.disabled = true; api.postMessage({ type: 'sign.terminal' }); }
    else if (target.hasAttribute('data-cancel')) api.postMessage({ type: 'sign.cancel' });
    else if (target.hasAttribute('data-done')) api.postMessage({ type: 'sign.done' });
  });
})();
`;

export const SF_GUARD_STYLE = `
.sfg-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(18rem,100%),1fr)); gap:1rem; }
.sfg-section, .sfg-first-run, .sfg-card, .sfg-story { padding:1rem; border:var(--sf-border); border-radius:var(--sf-radius); background:var(--sf-surface); margin:1rem 0; }
.sfg-grid > .sfg-section { margin:0; }
.sfg-section h2, .sfg-first-run h2, .sfg-card h2 { display:flex; gap:.4rem; align-items:center; margin:0 0 .6rem; font-size:1.05rem; }
.sfg-story h3, .sfg-story h4 { display:flex; gap:.4rem; align-items:center; margin:.4rem 0; }
.sfg-first-run { border-left:4px solid var(--sf-accent); }
.sfg-first-run ol { margin:.4rem 0 .6rem 1.2rem; padding:0; }
.sfg-rule { padding:.6rem .8rem; border-left:3px solid var(--sf-wait); background:var(--sf-accent-quiet); }
.sfg-table { width:100%; border-collapse:collapse; }
.sfg-table th, .sfg-table td { text-align:left; padding:.35rem .5rem; border-bottom:var(--sf-border); vertical-align:top; overflow-wrap:anywhere; }
.sfg-list, .sfg-groups, .sfg-labels { margin:.3rem 0; padding-left:1.1rem; }
.sfg-list > li { margin:.35rem 0; overflow-wrap:anywhere; }
.sfg-problems { list-style:none; padding:0; }
.sfg-route { display:flex; flex-wrap:wrap; gap:.4rem; align-items:center; }
.sfg-route code, .sfg-card code { overflow-wrap:anywhere; white-space:pre-wrap; }
.sfg-recipe pre { max-height:20rem; overflow:auto; }
.sfg-subject { border-top:var(--sf-border); padding:.6rem 0; }
.sfg-subject header { display:flex; flex-wrap:wrap; gap:.6rem; align-items:baseline; }
.sfg-subject h3 { margin:0; font-size:1rem; }
.sfg-summary { margin:.2rem 0; }
.sfg-card-fields { display:grid; grid-template-columns:max-content minmax(0,1fr); gap:.3rem .8rem; }
.sfg-card-fields dd { margin:0; }
.sfg-actions { display:flex; flex-wrap:wrap; gap:.5rem; margin:.6rem 0; }
.sfg-standing { margin-right:.3rem; }
.sfg-error { color:var(--sf-bad); }
`;
