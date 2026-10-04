/**
 * The Journey header line for a Story built on another Story, or holding an Epic: which Story, on
 * which branch, and whether the Epic was its own or inherited. Kept apart from the panel so it
 * renders without the editor.
 */
import type { Journey } from './journey-model.ts';
import { escape } from './webview.ts';

/** The Story this one is built on and its Epic, beneath the title, when it has either. */
export function journeyLineageHtml(journey: Journey): string {
  const lineage = journey.lineage;
  if (!lineage) return '';
  const parts: string[] = [];
  if (lineage.builtOn) {
    parts.push(`Built on <code>${escape(lineage.builtOn.id)}</code> ${escape(lineage.builtOn.title)}
        (branch ${escape(lineage.builtOn.branch)})`);
  }
  if (lineage.epicId) {
    parts.push(`Epic <code>${escape(lineage.epicId)}</code>${lineage.epicInheritedFrom
      ? ` inherited from ${escape(lineage.epicInheritedFrom)}` : ''}`);
  }
  return `<p class="meta journey-lineage">${parts.join(' · ')}</p>`;
}
