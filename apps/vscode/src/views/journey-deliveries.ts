/**
 * The Journey's after-step actions section: what a Story sends to other systems after its steps,
 * and how each delivery on this machine went. Pure HTML, so it is tested without the VS Code API;
 * every value from the outbox is escaped, and the page can only ask to retry a key by name or to
 * record receipts.
 */
import type { Journey } from './journey-model.ts';
import { escape } from './webview.ts';
import { icon } from './icons.ts';
import {
  deliveryDetail, deliveryState, isDeliveryKey, pinnedActionLine, unrecordedDeliveries,
  type PinnedStep, type StepActionDelivery
} from '../step-action-deliveries.ts';

/** What a Story sends after its steps, and how each delivery on this machine went. */
export interface JourneyDeliveries {
  pinned: PinnedStep[];
  deliveries: StepActionDelivery[];
  /** Required approved deliveries that hold the next step until they are delivered and recorded. */
  holds: StepActionDelivery[];
  loaded: boolean;
  error: string | null;
}

function deliveryTime(value: string | null | undefined): string {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export function deliveriesHtml(view: JourneyDeliveries | null, journey: Journey): string {
  if (!view || journey.kind !== 'story' || !view.pinned.length) return '';
  const labels = new Map(view.pinned.map((step) => [step.phaseId, step.label]));
  const pinned = `<ul class="pinned-actions">${view.pinned.map((step) => `
      <li><strong>${escape(step.label)}</strong>: ${step.actions.map((action) => escape(pinnedActionLine(action))).join('; ')}</li>`).join('')}</ul>`;
  const rows = view.deliveries.map((delivery) => {
    const state = deliveryState(delivery);
    const detail = deliveryDetail(delivery);
    const step = delivery.phaseId ? labels.get(delivery.phaseId) ?? delivery.phaseId : '';
    const when = delivery.status === 'delivered' ? deliveryTime(delivery.deliveredAt) : deliveryTime(delivery.updatedAt ?? delivery.createdAt);
    return `
      <tr>
        <td><span class="pill ${state.tone === 'warn' ? 'wait' : state.tone}">${escape(state.label)}</span></td>
        <td>${escape(step)}<small>${escape(delivery.trigger ?? '')}</small></td>
        <td>${escape(`${delivery.action ?? ''} → ${delivery.target ?? ''}`)}${delivery.kind || delivery.required ? `<small>${escape([delivery.kind, delivery.required ? 'required' : null].filter(Boolean).join(' · '))}</small>` : ''}</td>
        <td>${escape(String(delivery.attempts ?? 0))}</td>
        <td>${detail ? escape(detail) : '<span class="muted">—</span>'}${when ? `<small>${escape(when)}</small>` : ''}</td>
        <td>${state.retryable && isDeliveryKey(delivery.key) ? `<button class="secondary" data-retry="${escape(delivery.key)}">Retry</button>` : ''}</td>
      </tr>`;
  }).join('');
  const retryable = view.deliveries.filter((delivery) => deliveryState(delivery).retryable);
  const unrecorded = unrecordedDeliveries(view.deliveries);
  const holds = view.holds ?? [];
  const held = holds.length ? `<div class="notice warn"><p>The next step waits for ${holds.length === 1 ? 'a required delivery' : `${holds.length} required deliveries`}: ${holds.map((delivery) => escape(`${delivery.action ?? ''} → ${delivery.target ?? ''} (${labels.get(delivery.phaseId ?? '') ?? delivery.phaseId ?? ''})`)).join(', ')}. `
    + (holds.some((delivery) => delivery.status !== 'delivered') ? 'Retry it once its target is fixed; its receipt is recorded when it goes out.' : 'Record its receipt.')
    + '</p></div>' : '';
  const table = view.deliveries.length ? `<div class="table-wrap"><table class="journey-deliveries">
      <thead><tr><th>State</th><th>Step</th><th>Action</th><th>Tries</th><th>Last result</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>`
    : view.loaded ? '<p class="muted">Nothing has been sent yet. Deliveries appear here after a step is submitted, approved or rejected on this machine.</p>' : '';
  return `
    <section class="journey-deliveries-section"><h2>${icon('next')}After-step actions</h2>
      <p class="muted">What this Story tells other systems when a step is submitted, approved or rejected. It pinned these when it started.</p>
      ${pinned}
      ${view.loaded ? '' : '<p class="muted">Reading the deliveries on this machine…</p>'}
      ${view.error ? `<div class="notice error"><p>${escape(view.error)}</p></div>` : ''}
      ${held}
      ${table}
      ${retryable.length > 1 ? '<p><button data-retry-all>Retry everything not delivered</button></p>' : ''}
      ${unrecorded.length ? `<p><button class="secondary" data-record-receipts>Record ${unrecorded.length === 1 ? 'its receipt' : `${unrecorded.length} receipts`}</button> <span class="muted">Commits what went out to the Story, so everyone sees it. Not while a step awaits approval.</span></p>` : ''}
      <p class="muted">Deliveries are kept on the machine that moved the Story; another machine shows its own. Only a required action holds the Story: the next step waits until its approved delivery is recorded.</p>
    </section>`;
}
