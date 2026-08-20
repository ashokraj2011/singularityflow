import { escape, icon } from './webview.ts';

export type StartWizardStep = 'capability' | 'workspace' | 'work';

export interface StartWizardProgress {
  step: StartWizardStep;
  capabilityId?: string | null;
  workspaceName?: string | null;
}

const STEPS: ReadonlyArray<{
  id: StartWizardStep;
  label: string;
  description: string;
}> = Object.freeze([
  { id: 'capability', label: 'Map capability', description: 'what the organisation builds' },
  { id: 'workspace', label: 'Create workspace', description: 'where its repositories live' },
  { id: 'work', label: 'Start work', description: 'choose the governed journey' }
]);

/** A single, consistent orientation rail shared by all three existing governed forms. */
export function startWizardProgress(progress: StartWizardProgress | null = null): string {
  if (!progress) return '';
  const active = STEPS.findIndex((step) => step.id === progress.step);
  const context = [
    progress.capabilityId ? `Capability: ${progress.capabilityId}` : null,
    progress.workspaceName ? `Workspace: ${progress.workspaceName}` : null
  ].filter(Boolean).join(' · ');
  return `
    <aside class="start-wizard" aria-label="Guided setup progress">
      <div class="start-wizard-heading">
        <div>
          <span class="eyebrow">Guided start</span>
          <strong>Capability → workspace → first work item</strong>
        </div>
        <span class="pill">Step ${active + 1} of ${STEPS.length}</span>
      </div>
      <ol class="start-wizard-rail">
        ${STEPS.map((step, index) => {
    const state = index < active ? 'done' : index === active ? 'current' : 'upcoming';
    const marker = index < active ? icon('ok') : String(index + 1);
    return `<li class="start-wizard-step ${state}"${index === active ? ' aria-current="step"' : ''}>
            <span class="start-wizard-marker">${marker}</span>
            <span><strong>${escape(step.label)}</strong><small>${escape(step.description)}</small></span>
          </li>`;
  }).join('')}
      </ol>
      ${context ? `<p class="start-wizard-context">${escape(context)}</p>` : ''}
      <p class="muted">Each step uses the normal governed checks and confirmations. You can close the screen and resume without creating partial lifecycle state.</p>
    </aside>`;
}
