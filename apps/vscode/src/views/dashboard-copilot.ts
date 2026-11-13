/**
 * The Copilot activity section of Lifecycle Analytics: what a phase cost in requests, turns, calls
 * and prompt size when Copilot leaves token counts off its spans.
 *
 * Kept apart from the panel so it renders without VS Code. Every number comes from the engine's
 * report; this file only lays it out.
 */
import {
  copilotCountLabel, copilotEventSentence, premiumLabel, promptSizeLabel, promptSizeNote, sizeLabel,
  type LifecycleAnalytics, type LifecyclePhaseMetric
} from './dashboard-model.ts';
import { escape, icon } from './webview.ts';

/** Copilot's billed usage in AI units, or a dash when nothing reported it. */
function aiuLabel(metric: { value: number | null } | null | undefined): string {
  return metric?.value == null ? '—' : metric.value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** The engine writes commands as `code` spans; shown as code once the text is escaped. */
function codeSpans(escaped: string): string {
  return escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
}

const counted = (value: number, one: string): string => `${value.toLocaleString('en-US')} ${one}${value === 1 ? '' : 's'}`;

/**
 * Where the section's counts come from, as true for this Story: Copilot's own session logs where
 * they cover a phase, the older OpenTelemetry feeds elsewhere, and the multiplier estimate only
 * where a premium-request count is still estimated. [owner, 2026-11-13]
 */
function sourcesHtml(analytics: LifecycleAnalytics): string {
  const logs = Boolean(analytics.copilot?.sessions?.found);
  const estimated = analytics.phases.some((phase) => !['none', 'observed', undefined].includes(phase.copilot?.premiumRequests?.status));
  const estimate = 'estimated as requests × <code>tokens.premiumMultipliers</code>, and GitHub\'s billing is authoritative';
  const feeds = 'launches through <code>singularity-flow copilot</code>, and Copilot Chat in VS Code where counting is on';
  return [
    logs ? `Counted from Copilot's own session logs on this computer, which Copilot CLI and VS Code's Copilot agent write with no setup. A phase they do not cover is counted from the older OpenTelemetry feeds (${feeds}), never from both.`
      : `Counted from the OpenTelemetry feeds Copilot writes for ${feeds}.`,
    logs && !estimated ? 'Premium requests are Copilot\'s own count.'
      : logs ? `Premium requests are Copilot's own count where the logs cover a phase, and elsewhere ${estimate}.` : `Premium requests are ${estimate}.`,
    'The prompt is what sflow composed for the latest generation (bytes exact, tokens ≈ bytes ÷ 4); Copilot adds its own instructions, tools and history.'
  ].join(' ');
}

/** The prompt's size against the largest prompt on the page, with its budget as a dashed mark. */
function promptBarHtml(phase: LifecyclePhaseMetric, scale: number): string {
  const prompt = phase.copilot?.prompt;
  if (!prompt) return '<span class="muted">No composed prompt</span>';
  const width = Math.max(2, Math.round((prompt.bytes / scale) * 240));
  const budget = prompt.maximumBytes != null ? Math.round((prompt.maximumBytes / scale) * 240) : null;
  const note = promptSizeNote(prompt);
  return `<svg class="duration-bar" viewBox="0 0 240 16" preserveAspectRatio="none" role="img" aria-label="${escape(`${phase.label}: ${promptSizeLabel(prompt)}${note ? `, ${note}` : ''}`)}">
      <rect class="duration-track" width="240" height="16" rx="3"/>
      <rect class="${prompt.overBudget ? 'prompt-over' : 'duration-active'}" width="${width}" height="16" rx="3"/>
      ${budget != null && budget <= 240 ? `<line class="prompt-budget" x1="${budget}" x2="${budget}" y1="0" y2="16"/>` : ''}
    </svg>
    <small>${escape(promptSizeLabel(prompt))}${note ? ` · <span class="${prompt.overBudget ? 'warning-text' : ''}">${escape(note)}</span>` : ''}</small>`;
}

/**
 * Copilot activity by phase: what can be charted when Copilot leaves token counts off its spans.
 * Every number comes from the engine's report; the page only lays it out.
 */
export function copilotActivityHtml(analytics: LifecycleAnalytics): string {
  const copilot = analytics.copilot;
  if (!copilot) return '';
  const prompted = analytics.phases.filter((phase) => phase.copilot?.prompt);
  if (copilot.status === 'none' && !prompted.length) {
    // Nothing counted anywhere: still say why Copilot's own session logs hold nothing for the Story.
    return copilot.sessions?.explanation
      ? `<section><h2>${icon('impact')}Copilot activity</h2><p class="muted">${codeSpans(escape(copilot.sessions.explanation))}</p></section>` : '';
  }
  const scale = Math.max(1, ...prompted.flatMap((phase) => [phase.copilot?.prompt?.bytes ?? 0, phase.copilot?.prompt?.maximumBytes ?? 0]));
  const sessions = copilot.sessions;
  // Copilot's own count, from its session logs, needs no multiplier. Otherwise requests come first:
  // without them no multiplier can produce an estimate.
  const premiumNote = copilot.premiumRequests.status === 'observed' ? 'Copilot\'s count, from its session logs'
    : copilot.requests.value == null ? 'Requests were not captured'
      : copilot.premiumRequests.value == null
        ? (copilot.premiumMultipliersConfigured ? 'No multiplier for the models used' : 'Set tokens.premiumMultipliers to estimate')
        : copilot.premiumRequests.status === 'partial' ? 'Estimated; some models have no multiplier'
          : sessions?.found ? 'Copilot\'s session logs plus an estimate' : 'Estimated from configured multipliers';
  // Beside the events, the logs' ordinary model changes and Auto picks, which are not problems.
  const modelNotes = [sessions?.modelChanges ? counted(sessions.modelChanges, 'model change') : '', sessions?.autoPicks ? counted(sessions.autoPicks, 'Auto pick') : '']
    .filter(Boolean).join(', ');
  const failedTools = copilot.failedToolCalls?.value;
  // A count of events is only as good as the capture behind it: nothing captured is not zero events.
  const eventValue = copilot.status === 'none' ? '—'
    : copilot.status === 'unavailable' || copilot.eventsObserved === false ? 'Unavailable'
      : `${copilot.eventCount}${copilot.status === 'partial' ? ' (partial)' : ''}`;
  const captureNotes = copilot.captureNotes?.length
    ? `<ul class="sources">${copilot.captureNotes.map((note) => `<li class="warning-text">${codeSpans(escape(note))}</li>`).join('')}</ul>`
    : '';
  const rows = analytics.phases.map((phase) => {
    const failed = phase.copilot?.failedToolCalls?.value;
    return `<tr>
    <td><strong>${escape(phase.label)}</strong><small>${phase.generations} generation${phase.generations === 1 ? '' : 's'}${phase.sentBack ? ` · sent back ${phase.sentBack}×` : ''}</small></td>
    <td>${escape(copilotCountLabel(phase.copilot?.requests))}</td>
    <td>${escape(copilotCountLabel(phase.copilot?.turns))}</td>
    <td>${escape(copilotCountLabel(phase.copilot?.modelCalls))}</td>
    <td>${escape(copilotCountLabel(phase.copilot?.toolCalls))}${failed ? ` <span class="warning-text">(${failed} failed)</span>` : ''}</td>
    <td>${escape(premiumLabel(phase.copilot?.premiumRequests))}${phase.copilot?.eventCount ? ` <span class="warning-text" title="Quota or model events">⚠ ${phase.copilot.eventCount}</span>` : ''}</td>
    <td>${escape(aiuLabel(phase.copilot?.billedAiu))}</td>
    ${sessions?.found ? `<td>${phase.copilot?.sessions?.cacheHitShare != null ? `${phase.copilot.sessions.cacheHitShare}%` : '—'}</td>` : ''}
    <td class="duration-cell">${promptBarHtml(phase, scale)}</td>
  </tr>`;
  }).join('');
  const events = copilot.events.length
    ? `<h3>Quota and model events</h3><ul class="sources">${copilot.events.map((event) => `<li class="warning-text">${escape(copilotEventSentence(event))}</li>`).join('')}${copilot.omittedEvents ? `<li class="muted">${copilot.omittedEvents} more not listed.</li>` : ''}</ul>`
    : '';
  const chat = copilot.chat?.counted
    ? `<p class="muted">Copilot Chat on this computer: ${copilot.chat.requests} request${copilot.chat.requests === 1 ? '' : 's'} for this Story, counted since ${escape(copilot.chat.since ?? '')}${copilot.chat.cachedShare != null ? `; ${copilot.chat.cachedShare}% of their input tokens read from Copilot's cache` : ''}. Other people's Copilot Chat use is not included.</p>`
    : '';
  // From Copilot's own session logs: what they counted for the Story, or why nothing. [owner, 2026-11-13]
  const sessionLine = !sessions ? ''
    : sessions.found
      ? `<p class="muted">Copilot's session logs on this computer: ${escape([counted(sessions.premiumRequests ?? 0, 'premium request'), counted(sessions.modelCalls ?? 0, 'model call'),
        ...(sessions.activityPhases?.length ? [counted(sessions.turns ?? 0, 'agent turn'), counted(sessions.toolCalls ?? 0, 'tool call')] : [])]
        .join(', ').replace(/, (?=[^,]*$)/u, ' and '))} for this Story${sessions.syncedAt ? `, read ${escape(sessions.syncedAt)}` : ''}. Other people's use is not included.</p>`
      : `<p class="muted">${codeSpans(escape(sessions.explanation ?? ''))}</p>`;
  return `<section>
    <h2>${icon('impact')}Copilot activity</h2>
    <p class="muted">${sourcesHtml(analytics)}</p>
    <div class="summary-grid lifecycle-kpis">
      <div class="summary-card"><strong>${escape(copilotCountLabel(copilot.requests))}</strong><span>Requests you sent</span></div>
      <div class="summary-card${copilot.events.some((event) => event.kind !== 'failed') ? ' governance-warning' : ''}"><strong>${escape(premiumLabel(copilot.premiumRequests))}</strong><span>Premium requests · ${escape(premiumNote)}</span></div>
      ${copilot.billedAiu?.value != null ? `<div class="summary-card"><strong>${escape(aiuLabel(copilot.billedAiu))}</strong><span>Billed usage (AIU) · reported by ${sessions?.found ? 'Copilot' : 'Copilot Chat'}</span></div>` : ''}
      ${sessions?.found && sessions.cacheHitShare != null ? `<div class="summary-card"><strong>${sessions.cacheHitShare}%</strong><span>Cache hit · input tokens read from Copilot's cache</span></div>` : ''}
      <div class="summary-card"><strong>${escape(copilotCountLabel(copilot.turns))}</strong><span>Agent turns${copilot.turnsDerived ? ' · some counted from model calls' : ''}${sessions?.subagents ? ` · ${counted(sessions.subagents, 'sub-agent')}` : ''}</span></div>
      <div class="summary-card"><strong>${escape(copilotCountLabel(copilot.toolCalls))}</strong><span>Tool calls${failedTools ? ` · ${failedTools.toLocaleString('en-US')} failed` : ''}</span></div>
      <div class="summary-card${copilot.eventCount ? ' governance-warning' : ''}"><strong>${escape(eventValue)}</strong><span>Quota and model events${modelNotes ? ` · ${escape(modelNotes)}` : ''}</span></div>
      <div class="summary-card${copilot.promptsOverBudget.length ? ' governance-warning' : ''}"><strong>${copilot.largestPrompt ? escape(sizeLabel(copilot.largestPrompt.bytes)) : '—'}</strong><span>Largest governed prompt${copilot.largestPrompt ? ` · ${escape(copilot.largestPrompt.phase)}` : ''}${copilot.promptsOverBudget.length ? ` · ${copilot.promptsOverBudget.length} over budget` : ''}</span></div>
    </div>
    ${sessionLine}
    ${chat}
    ${captureNotes}
    <div class="table-wrap"><table class="analytics-table">
      <thead><tr><th>Phase</th><th>Requests</th><th>Turns</th><th>Model calls</th><th>Tool calls</th><th>${sessions?.found ? 'Premium' : 'Premium (est.)'}</th><th>Billed (AIU)</th>${sessions?.found ? '<th>Cache hit</th>' : ''}<th>Prompt</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${events}
  </section>`;
}
