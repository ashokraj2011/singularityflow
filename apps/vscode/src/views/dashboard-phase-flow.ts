/** Read-only phase order from the loaded Story report; no inferred routes or extra requests. */
import type { LifecycleAnalytics } from './dashboard-model.ts';
import { escape, icon } from './webview.ts';

export function phaseDetailId(index: number): string {
  return `story-phase-detail-${index}`;
}

export function storyPhaseFlowHtml(analytics: Pick<LifecycleAnalytics, 'phases' | 'currentPhase'>): string {
  if (!analytics.phases.length) return '<p class="muted">No workflow phases are recorded for this Story.</p>';
  const nodes = analytics.phases.map((phase, index) => {
    const current = phase.id === analytics.currentPhase;
    const state = phase.status === 'approved' ? 'done'
      : ['rejected', 'stale'].includes(phase.status) ? 'attention'
        : phase.status === 'awaiting_approval' ? 'waiting'
          : phase.status === 'skipped' ? 'skipped' : 'pending';
    const status = phase.status.replaceAll('_', ' ').replace(/^./, (value) => value.toUpperCase());
    return `<li class="story-phase-node ${state}${current ? ' current' : ''}">
      <a class="story-phase-card" href="#${phaseDetailId(index)}"${current ? ' aria-current="step"' : ''}>
        <span class="story-phase-number" aria-hidden="true">${state === 'done' ? icon('ok', { size: 16 }) : index + 1}</span>
        <span class="story-phase-copy"><strong>${escape(phase.label || phase.id)}</strong>
          <span class="story-phase-status">${current ? 'Current phase · ' : ''}${escape(status)}</span></span>
      </a>
      ${index < analytics.phases.length - 1 ? '<span class="story-phase-arrow" aria-hidden="true">&#8594;</span>' : ''}
    </li>`;
  }).join('');
  return `<section class="story-phase-flow" aria-labelledby="story-phase-flow-title">
    <h3 id="story-phase-flow-title">Workflow phases</h3>
    <p class="muted">Arrows show phase order, not executed decision or repair routes. Select a phase for its recorded timings below.</p>
    <div class="story-phase-scroll"><ol aria-label="Story workflow phases">${nodes}</ol></div>
  </section>`;
}

export const STORY_PHASE_FLOW_STYLE = `
  .story-phase-flow { margin: 1.2rem 0 0; padding: 0; border: 0; box-shadow: none; background: transparent; }
  .story-phase-flow h3 { margin: 0 0 .3rem; font-size: 1rem; }
  .story-phase-flow > p { margin: 0 0 .7rem; font-size: .8rem; }
  .story-phase-scroll { max-width: 100%; overflow-x: auto; padding: .2rem .2rem .7rem; }
  .story-phase-flow ol { display: flex; width: max-content; min-width: 100%; padding: 0; margin: 0; list-style: none; }
  .story-phase-node { display: flex; align-items: center; flex: 1 0 10rem; gap: .6rem; }
  .story-phase-card { display: flex; align-items: center; gap: .65rem; flex: 1; width: 10rem; min-height: 5rem;
    padding: .8rem; border: var(--sf-border); border-radius: var(--sf-radius); background: var(--sf-surface);
    color: var(--vscode-foreground); text-decoration: none; box-sizing: border-box; }
  .story-phase-card:hover { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-focusBorder); }
  .story-phase-card:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .story-phase-number { display: inline-grid; place-items: center; flex: 0 0 1.7rem; height: 1.7rem;
    border: var(--sf-border); border-radius: 50%; color: var(--sf-dim); font-size: .8rem; font-weight: 600; }
  .story-phase-copy { display: grid; gap: .35rem; min-width: 0; overflow-wrap: anywhere; }
  .story-phase-copy strong { font-size: .85rem; }
  .story-phase-status { color: var(--sf-dim); font-size: .72rem; }
  .story-phase-arrow { display: inline-flex; flex: 0 0 auto; margin-right: .6rem; color: var(--sf-dim); font-size: 1.35rem; line-height: 1; }
  .story-phase-node.done .story-phase-number { color: var(--sf-on-accent); background: var(--sf-accent); border-color: var(--sf-accent); }
  .story-phase-node.current .story-phase-card { border: 2px solid var(--sf-accent); background: var(--sf-accent-quiet); }
  .story-phase-node.current .story-phase-status { color: var(--vscode-foreground); font-weight: 600; }
  .story-phase-node.waiting .story-phase-number { color: var(--sf-wait); border-color: var(--sf-wait); }
  .story-phase-node.attention .story-phase-number { color: var(--sf-bad); border-color: var(--sf-bad); }
  .story-phase-node.skipped .story-phase-card { border-style: dashed; }
  .story-phase-node.skipped .story-phase-number { border-style: dashed; }
  .story-phase-detail { scroll-margin-top: 1rem; }
  .story-phase-detail:target { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
  @media (max-width: 600px) {
    .story-phase-flow ol { display: grid; width: auto; gap: .25rem; }
    .story-phase-node { flex-direction: column; align-items: stretch; gap: .25rem; }
    .story-phase-card { width: 100%; min-height: 4rem; }
    .story-phase-arrow { align-self: center; margin: 0; transform: rotate(90deg); }
  }
  @media (forced-colors: active) {
    .story-phase-card, .story-phase-number { border-color: CanvasText; }
    .story-phase-node.current .story-phase-card { border-color: Highlight; }
    .story-phase-node.done .story-phase-number { color: HighlightText; background: Highlight; }
    .story-phase-arrow { color: CanvasText; }
  }
`;
