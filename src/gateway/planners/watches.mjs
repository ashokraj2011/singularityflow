/**
 * Watches: "tell me when this moves", answered from records rather than remembered. `[INT:CON-101]`
 *
 * A watch is a machine-local, identity-scoped note of a subject, a predicate from a closed set, and
 * the subject's governed state when the watch was made. Nothing evaluates it in the background —
 * there is no daemon here to go wrong quietly. `watch.list` compares each baseline with the work
 * records as they are now, so "fired" is a deterministic fact about two observations and not a
 * notification someone has to trust was delivered.
 *
 * `watch.create` and `watch.revoke` are mutations of the local store only: `contextChanged` and
 * nothing else. Their planners compute the exact record they would write; the executors below are
 * the only code that writes it, and run only after a host confirmation receipt redeems.
 */
import { randomUUID } from 'node:crypto';

import { SingularityFlowError } from '../../util.mjs';
import { gatewayStoreEntries, updateGatewayStore } from '../local-store.mjs';
import { planDescriptor, plannerActor } from '../plan-descriptor.mjs';
import { effects, noEffects, plannerNavigation, preservedAll, sflowResult } from '../result.mjs';
import { resolveWorkRecord, workRecords } from '../work-records.mjs';

/** What a watch can wait for. Closed: a predicate a reader cannot enumerate is a predicate nobody can audit. */
export const WATCH_PREDICATES = Object.freeze(['material-event', 'phase-changed', 'needs-my-decision', 'recovery-required']);

function observation(item) {
  return {
    phase: item.phase ?? null,
    generation: item.generation ?? 0,
    status: item.status ?? null,
    group: item.group,
    lastMaterialEventAt: item.lastMaterialEvent?.at ?? null
  };
}

/** `fired`, `quiet` or `unknown` — and unknown is never rendered as quiet. */
export function evaluateWatch(watch, item) {
  if (!item) return { state: 'unknown', current: null };
  const current = observation(item);
  const base = watch.baseline ?? {};
  const fired = {
    'material-event': current.lastMaterialEventAt !== base.lastMaterialEventAt,
    'phase-changed': current.phase !== base.phase || current.generation !== base.generation,
    'needs-my-decision': current.group === 'waiting-on-you',
    'recovery-required': current.group === 'recovery-required'
  }[watch.predicate];
  return { state: fired ? 'fired' : 'quiet', current };
}

function refusal(operationId, code, slots = {}) {
  return sflowResult({
    kind: 'refusal',
    operation: { id: operationId, classification: 'read' },
    outcome: { status: 'refused', messageId: 'gateway.refused', slots },
    effects: noEffects(),
    why: [{ code, source: 'deterministic', slots }],
    preserved: preservedAll('watch.nothing-was-carried-out'),
    restState: 'blocked'
  });
}

export async function watchList({ subject = null, root = null, context = {}, env = process.env } = {}) {
  const actorId = plannerActor(context);
  if (!actorId) return refusal('watch.list', 'watch.no-actor');
  const watches = await gatewayStoreEntries('watches', actorId, { env });
  const records = root && watches.length ? await workRecords(root, { includeCompleted: true, ...context }) : null;
  const evaluated = watches.map((watch) => {
    const item = records ? resolveWorkRecord(records, { workId: watch.subject.id, workKind: watch.subject.kind }) : null;
    return { ...watch, ...evaluateWatch(watch, item) };
  });
  const fired = evaluated.filter((watch) => watch.state === 'fired');
  return sflowResult({
    kind: 'read',
    operation: { id: 'watch.list', classification: 'read' },
    subject,
    outcome: { status: 'succeeded', messageId: 'gateway.read', slots: { watches: String(watches.length), fired: String(fired.length) } },
    effects: noEffects(),
    why: [{ code: 'watch.from-local-store', source: 'deterministic', slots: { count: String(watches.length) } }],
    warnings: evaluated.some((watch) => watch.state === 'unknown')
      ? [{ code: 'watch.subject-not-visible', source: 'unavailable', slots: {
        count: String(evaluated.filter((watch) => watch.state === 'unknown').length) } }]
      : [],
    next: [
      ...fired.map((watch, index) => plannerNavigation({
        handle: `watch:open:${watch.id}`, id: `watch:open:${watch.id}`, label: watch.subject.id, rank: index,
        kind: 'read', reasonCode: 'watch.fired', confirmation: 'none', interaction: 'navigation', executable: false,
        slots: { predicate: watch.predicate },
        fallback: { label: 'See this work', command: `sflow status --work-id ${watch.subject.id}` }
      }, 'work.continue', { workId: watch.subject.id, workKind: watch.subject.kind })),
      ...evaluated.map((watch, index) => plannerNavigation({
        handle: `watch:revoke:${watch.id}`, id: `watch:revoke:${watch.id}`, label: `Stop watching ${watch.subject.id}`,
        rank: fired.length + index, kind: 'plan', reasonCode: 'watch.revocable', confirmation: 'host-confirm',
        interaction: 'form', emphasis: 'link', executable: false
      }, 'watch.revoke', { watchId: watch.id }))
    ],
    restState: evaluated.length ? null : 'informational',
    data: {
      watches: evaluated.map((watch) => ({
        id: watch.id, subject: watch.subject, predicate: watch.predicate, createdAt: watch.createdAt,
        state: watch.state, baseline: watch.baseline, current: watch.current
      })),
      store: 'machine-local'
    }
  });
}

/** The exact watch record `watch.create` would write. A read. */
export async function watchCreatePlan({ arguments: args = {}, root = null, context = {}, env = process.env } = {}) {
  const actorId = plannerActor(context);
  if (!actorId) throw new SingularityFlowError('A watch needs the actor it belongs to.', { code: 'WATCH_NO_ACTOR' });
  if (!WATCH_PREDICATES.includes(args.predicate)) {
    throw new SingularityFlowError(`'${args.predicate}' is not a watch predicate.`, {
      code: 'WATCH_PREDICATE_UNKNOWN', details: { known: WATCH_PREDICATES }
    });
  }
  if (!root) throw new SingularityFlowError('A watch is made against the repository it reads.', { code: 'WATCH_NO_ROOT' });
  const item = resolveWorkRecord(await workRecords(root, { includeCompleted: true, ...context }), { workId: args.subjectId });
  if (!item) throw new SingularityFlowError(`'${args.subjectId}' is not visible work here.`, { code: 'WATCH_SUBJECT_UNKNOWN' });
  const existing = await gatewayStoreEntries('watches', actorId, { env });
  if (existing.some((watch) => watch.subject.id === item.id && watch.predicate === args.predicate)) {
    throw new SingularityFlowError(`You already watch ${item.id} for ${args.predicate}.`, { code: 'WATCH_EXISTS' });
  }
  return planDescriptor({
    effects: { contextChanged: true },
    idempotencyKey: `watch.create:${actorId}:${item.kind}:${item.id}:${args.predicate}`,
    preview: {
      action: 'create-watch',
      subject: { kind: item.kind, id: item.id, title: item.title },
      predicate: args.predicate,
      baseline: observation(item),
      store: 'machine-local'
    }
  });
}

export async function watchRevokePlan({ arguments: args = {}, context = {}, env = process.env } = {}) {
  const actorId = plannerActor(context);
  if (!actorId) throw new SingularityFlowError('A watch needs the actor it belongs to.', { code: 'WATCH_NO_ACTOR' });
  const watch = (await gatewayStoreEntries('watches', actorId, { env })).find((entry) => entry.id === args.watchId);
  if (!watch) throw new SingularityFlowError(`'${args.watchId}' is not one of your watches.`, { code: 'WATCH_UNKNOWN' });
  return planDescriptor({
    effects: { contextChanged: true },
    idempotencyKey: `watch.revoke:${actorId}:${watch.id}`,
    preview: { action: 'revoke-watch', watchId: watch.id, subject: watch.subject, predicate: watch.predicate, store: 'machine-local' }
  });
}

function completed(operationId, slots, data) {
  return sflowResult({
    kind: 'read',
    operation: { id: operationId, classification: 'mutation' },
    outcome: { status: 'succeeded', messageId: 'gateway.completed', slots },
    effects: effects({ contextChanged: true }),
    why: [{ code: 'watch.local-store-changed', source: 'deterministic', slots }],
    preserved: [{ code: 'watch.governed-state-untouched', source: 'deterministic', scope: 'stateChanged' },
      { code: 'watch.governed-state-untouched', source: 'deterministic', scope: 'gitRefsChanged' }],
    restState: 'complete',
    data
  });
}

/** Write exactly the reviewed record. Runs only after a receipt redeems. */
export async function watchCreateExecute({ plan, context = {}, env = process.env } = {}) {
  const actorId = plannerActor(context);
  const preview = plan.review.preview;
  const entry = {
    id: `wat_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    actorId,
    subject: preview.subject,
    predicate: preview.predicate,
    baseline: preview.baseline,
    createdAt: new Date().toISOString()
  };
  await updateGatewayStore('watches', (entries) => [...entries, entry], { env });
  return completed('watch.create', { watch: entry.id, subject: entry.subject.id }, { watch: entry });
}

export async function watchRevokeExecute({ plan, context = {}, env = process.env } = {}) {
  const actorId = plannerActor(context);
  const { watchId } = plan.review.preview;
  await updateGatewayStore('watches', (entries) => entries.filter((entry) => !(entry.id === watchId && entry.actorId === actorId)), { env });
  return completed('watch.revoke', { watch: watchId }, { revoked: watchId });
}
