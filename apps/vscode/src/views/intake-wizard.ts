/** Presentation-only navigation. The existing host/engine still own all creation checks. */
import { escape } from './webview.ts';

const STEPS = [
  { id: 'details', label: 'Details', regions: ['scope', 'identification'] },
  { id: 'workflow', label: 'Workflow & branch', regions: ['profile', 'workflow', 'base', 'poc'] },
  { id: 'inputs', label: 'Documents & checks', regions: ['attachments', 'references', 'checks', 'recovery'] },
  { id: 'review', label: 'Review & start', regions: ['review', 'status', 'inFlight'] }
] as const;

export function intakeWizardNavigation(enabled: boolean): string {
  if (!enabled) return '';
  return `<nav class="intake-wizard-nav" aria-label="Story intake steps" data-intake-wizard-nav>
    <ol>${STEPS.map((step, index) => `<li><button type="button" data-intake-wizard-go="${step.id}"${index === 0 ? ' aria-current="step"' : ''}>
      <span aria-hidden="true">${index + 1}</span>${escape(step.label)}</button></li>`).join('')}</ol>
    <p class="muted" data-intake-wizard-position role="status" aria-live="polite">Step 1 of 4 · Details</p>
  </nav>`;
}

/** Wrappers outlive region patches, including switching between Story and Epic intake. */
export function intakeWizardLayout(regions: Record<string, string>, enabled: boolean): string {
  const region = (id: string) => `<div data-intake-region="${id}">${regions[id] ?? ''}</div>`;
  return ['progress', 'heading', 'context', 'wizard'].map(region).join('')
    + STEPS.map((step, index) => `<div data-intake-wizard-panel="${step.id}" role="region" aria-label="${escape(step.label)}" tabindex="-1"${enabled && index > 0 ? ' hidden' : ''}>
      ${step.regions.map(region).join('')}</div>`).join('')
    + region('actions');
}

export function intakeWizardActions(enabled: boolean): string {
  return enabled ? '<button type="button" class="secondary" data-intake-wizard-back hidden>Back</button><button type="button" data-intake-wizard-next>Next</button>' : '';
}

export const INTAKE_WIZARD_STYLE = `
  .intake-wizard-nav { margin: 1.25rem 0; }
  .intake-wizard-nav ol { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .5rem; list-style: none; padding: 0; }
  .intake-wizard-nav button { display: flex; align-items: center; gap: .55rem; width: 100%; min-height: 3.2rem; padding: .7rem;
    text-align: left; color: var(--sf-dim); border: var(--sf-border); background: var(--sf-surface); white-space: normal; }
  .intake-wizard-nav button > span { display: inline-grid; place-items: center; flex: 0 0 1.5rem; height: 1.5rem;
    border: 1px solid currentColor; border-radius: 50%; font-size: .75rem; }
  .intake-wizard-nav [aria-current="step"] { border-color: var(--sf-accent); background: var(--sf-accent-quiet); color: var(--vscode-foreground); }
  .intake-wizard-nav button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
  [data-intake-wizard-panel][hidden], [data-intake-wizard-final][hidden], [data-intake-wizard-next][hidden], [data-intake-wizard-back][hidden] { display: none !important; }
  [data-intake-wizard-panel]:focus { outline: none; }
  .intake-review-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(20rem, 100%), 1fr)); gap: 1rem; }
  .intake-review-grid article { padding: 1rem; border: var(--sf-border); border-radius: var(--sf-radius); overflow-wrap: anywhere; }
  .intake-review-grid h3 { margin: 0 0 .65rem; }
  .intake-review-grid dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: .5rem 1rem; margin: 0; }
  .intake-review-grid dt { color: var(--sf-dim); }
  .intake-review-grid dd { margin: 0; }
  .intake-review-prose { white-space: pre-wrap; max-height: 16rem; overflow: auto; }
  @media (max-width: 640px) { .intake-wizard-nav ol { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (forced-colors: active) { .intake-wizard-nav button { border-color: CanvasText; } .intake-wizard-nav [aria-current="step"] { border: 2px solid Highlight; } }
`;

export const INTAKE_WIZARD_SCRIPT = `
  const intakeWizard = (() => {
    const root = document.querySelector('[data-intake-wizard-root]');
    if (!root) return { refresh() {}, reveal() {}, canStart: () => true, step: null };
    const steps = ${JSON.stringify(STEPS.map(({ id, label }) => ({ id, label })))};
    const saved = window.__sfVscode.getState?.()?.intakeView?.wizardStep;
    let step = steps.some(item => item.id === saved) ? saved : 'details';
    const enabled = () => Boolean(document.querySelector('[data-intake-wizard-nav]'));
    let wasEnabled = enabled();
    const busy = () => root.getAttribute('aria-busy') === 'true';
    const remember = () => {
      const state = window.__sfVscode.getState?.() || {};
      state.intakeView = { ...(state.intakeView || {}), wizardStep: step };
      window.__sfVscode.setState?.(state);
    };
    const review = () => {
      document.querySelectorAll('[data-intake-review-field]').forEach(summary => {
        const field = document.querySelector('[data-field="' + summary.dataset.intakeReviewField + '"]');
        if (field) summary.textContent = field.value.trim() || 'Not provided';
      });
    };
    const refresh = () => {
      const on = enabled();
      if (on !== wasEnabled) { step = 'details'; wasEnabled = on; remember(); }
      document.querySelectorAll('[data-intake-wizard-panel]').forEach(panel => { panel.hidden = on && panel.dataset.intakeWizardPanel !== step; });
      document.querySelectorAll('[data-intake-wizard-go]').forEach(button => {
        if (on && button.closest('[data-intake-wizard-nav]') && button.dataset.intakeWizardGo === step) button.setAttribute('aria-current', 'step');
        else button.removeAttribute('aria-current');
        button.disabled = busy();
      });
      const back = document.querySelector('[data-intake-wizard-back]');
      const next = document.querySelector('[data-intake-wizard-next]');
      const final = document.querySelector('[data-intake-wizard-final]');
      if (back) { back.hidden = !on || step === 'details'; back.disabled = busy(); }
      if (next) { next.hidden = !on || step === 'review'; next.disabled = busy(); }
      if (final) final.hidden = on && step !== 'review';
      const position = document.querySelector('[data-intake-wizard-position]');
      const index = steps.findIndex(item => item.id === step);
      if (position) position.textContent = 'Step ' + (index + 1) + ' of 4 · ' + steps[index].label;
      review();
    };
    const go = (id, focus = true) => {
      if (!enabled() || busy() || !steps.some(item => item.id === id)) return;
      step = id; remember(); refresh();
      const panel = document.querySelector('[data-intake-wizard-panel="' + step + '"]');
      if (focus && panel) { panel.focus({ preventScroll: true }); panel.scrollIntoView({ block: 'start' }); }
    };
    const validate = () => {
      const panel = document.querySelector('[data-intake-wizard-panel="' + step + '"]');
      const fields = panel?.querySelectorAll('input[required],textarea[required],select[required]') || [];
      for (const field of fields) {
        field.setCustomValidity(field.value.trim() ? '' : 'Complete this field before continuing.');
        if (!field.reportValidity()) return false;
      }
      return true;
    };
    document.addEventListener('click', event => {
      const destination = event.target.closest('[data-intake-wizard-go]');
      if (destination) { event.preventDefault(); go(destination.dataset.intakeWizardGo); return; }
      const index = steps.findIndex(item => item.id === step);
      if (event.target.closest('[data-intake-wizard-back]')) { go(steps[index - 1]?.id); return; }
      if (event.target.closest('[data-intake-wizard-next]') && !busy() && validate()) go(steps[index + 1]?.id);
    });
    document.addEventListener('input', event => {
      event.target.setCustomValidity?.('');
      review();
    });
    refresh();
    return { refresh, get step() { return step; }, canStart: () => !busy() && (!enabled() || step === 'review'),
      reveal(target) { const panel = target?.closest('[data-intake-wizard-panel]'); if (panel) go(panel.dataset.intakeWizardPanel, false); } };
  })();
`;
