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
  if (copilot.status === 'none' && !prompted.length) return '';
  const scale = Math.max(1, ...prompted.flatMap((phase) => [phase.copilot?.prompt?.bytes ?? 0, phase.copilot?.prompt?.maximumBytes ?? 0]));
  const premiumNote = copilot.premiumRequests.value == null
    ? (copilot.premiumMultipliersConfigured ? 'No multiplier for the models used' : 'Set tokens.premiumMultipliers to estimate')
    : copilot.premiumRequests.status === 'partial' ? 'Estimated; some models have no multiplier' : 'Estimated from configured multipliers';
  const rows = analytics.phases.map((phase) => {
    const failed = phase.copilot?.failedToolCalls?.value;
    return `<tr>
    <td><strong>${escape(phase.label)}</strong><small>${phase.generations} generation${phase.generations === 1 ? '' : 's'}${phase.sentBack ? ` · sent back ${phase.sentBack}×` : ''}</small></td>
    <td>${escape(copilotCountLabel(phase.copilot?.requests))}</td>
    <td>${escape(copilotCountLabel(phase.copilot?.turns))}</td>
    <td>${escape(copilotCountLabel(phase.copilot?.modelCalls))}</td>
    <td>${escape(copilotCountLabel(phase.copilot?.toolCalls))}${failed ? ` <span class="warning-text">(${failed} failed)</span>` : ''}</td>
    <td>${escape(premiumLabel(phase.copilot?.premiumRequests))}${phase.copilot?.eventCount ? ` <span class="warning-text" title="Quota or model events">⚠ ${phase.copilot.eventCount}</span>` : ''}</td>
    <td class="duration-cell">${promptBarHtml(phase, scale)}</td>
  </tr>`;
  }).join('');
  const events = copilot.events.length
    ? `<h3>Quota and model events</h3><ul class="sources">${copilot.events.map((event) => `<li class="warning-text">${escape(copilotEventSentence(event))}</li>`).join('')}${copilot.omittedEvents ? `<li class="muted">${copilot.omittedEvents} more not listed.</li>` : ''}</ul>`
    : '';
  return `<section>
    <h2>${icon('impact')}Copilot activity</h2>
    <p class="muted">Counted from the spans Copilot exports for launches through <code>singularity-flow copilot</code>; native chat sends SFlow none. Premium requests are estimated as requests × <code>tokens.premiumMultipliers</code>, and GitHub's billing is authoritative. The governed prompt is what sflow composed for the latest generation (bytes exact, tokens ≈ bytes ÷ 4); Copilot adds its own instructions, tools and history.</p>
    <div class="summary-grid lifecycle-kpis">
      <div class="summary-card"><strong>${escape(copilotCountLabel(copilot.requests))}</strong><span>Requests you sent</span></div>
      <div class="summary-card${copilot.events.some((event) => event.kind !== 'failed') ? ' governance-warning' : ''}"><strong>${escape(premiumLabel(copilot.premiumRequests))}</strong><span>Premium requests · ${escape(premiumNote)}</span></div>
      <div class="summary-card"><strong>${escape(copilotCountLabel(copilot.turns))}</strong><span>Agent turns${copilot.turnsDerived ? ' · some counted from model calls' : ''}</span></div>
      <div class="summary-card"><strong>${escape(copilotCountLabel(copilot.toolCalls))}</strong><span>Tool calls</span></div>
      <div class="summary-card${copilot.eventCount ? ' governance-warning' : ''}"><strong>${copilot.eventCount}</strong><span>Quota and model events</span></div>
      <div class="summary-card${copilot.promptsOverBudget.length ? ' governance-warning' : ''}"><strong>${copilot.largestPrompt ? escape(sizeLabel(copilot.largestPrompt.bytes)) : '—'}</strong><span>Largest governed prompt${copilot.largestPrompt ? ` · ${escape(copilot.largestPrompt.phase)}` : ''}${copilot.promptsOverBudget.length ? ` · ${copilot.promptsOverBudget.length} over budget` : ''}</span></div>
    </div>
    <div class="table-wrap"><table class="analytics-table">
      <thead><tr><th>Phase</th><th>Requests</th><th>Turns</th><th>Model calls</th><th>Tool calls</th><th>Premium (est.)</th><th>Governed prompt</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${events}
  </section>`;
}
