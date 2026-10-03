/**
 * After-step deliveries, as VS Code shows them: what a Story sends to other systems when a step is
 * submitted, approved or rejected, and whether each delivery went out.
 *
 * Deliveries live in the outbox of the machine that moved the Story, not in the repository, so they
 * are not part of the snapshot. They are read with `integrations status`, and only for a Story that
 * pinned actions when it started, after one of its steps moved: a Story without actions, or a
 * refresh that changed no step, costs nothing.
 *
 * A delivery that went out can be recorded as a receipt in the Story. An action pinned as required
 * holds the next step until its approved delivery is recorded; the machine that delivers it records
 * it at once, so a hold usually means the delivery itself did not go out.
 */
import type { StoryWorkflow } from './cli/snapshot.ts';

export interface StepActionAttempt {
  at: string;
  outcome: string;
  status?: number;
  code?: string;
  detail?: string;
}

export interface StepActionDelivery {
  key: string;
  status: 'pending' | 'waiting' | 'failed' | 'delivered' | 'tampered' | 'pipeline' | string;
  workId?: string;
  phaseId?: string;
  generation?: number;
  trigger?: string;
  action?: string;
  target?: string;
  kind?: string;
  send?: string;
  /** The action was pinned as required: its approved delivery holds the next step until recorded. */
  required?: boolean;
  /** Its receipt is in this checkout (true or false), or this checkout does not hold the Story (null). */
  recorded?: boolean | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  deliveredAt?: string | null;
  nextAttemptAt?: string | null;
  attempts?: number;
  lastAttempt?: StepActionAttempt | null;
}

export interface PinnedStepAction { id: string; on: string[]; target: string; send: string; kind: string | null; required: boolean }
export interface PinnedStep { phaseId: string; label: string; actions: PinnedStepAction[] }

const DELIVERY_KEY = /^sad_[0-9a-f]{40}$/;
const TRIGGER_WORDS: Record<string, string> = { submitted: 'submitted', approved: 'approved', rejected: 'rejected' };
const SEND_WORDS: Record<string, string> = { event: 'the event', summary: 'a summary', artifact: 'the document' };

export function isDeliveryKey(value: unknown): value is string {
  return typeof value === 'string' && DELIVERY_KEY.test(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** The actions a Story pinned when it started, step by step, in the order its steps run. */
export function pinnedStepActions(workflow: StoryWorkflow | null | undefined): PinnedStep[] {
  const phases = (workflow?.resolution as { phases?: unknown } | undefined)?.phases;
  if (!Array.isArray(phases)) return [];
  return phases.flatMap((phase): PinnedStep[] => {
    if (!phase || typeof phase !== 'object') return [];
    const entry = phase as { id?: unknown; label?: unknown; afterStep?: unknown };
    const phaseId = text(entry.id);
    if (!phaseId || !Array.isArray(entry.afterStep)) return [];
    const actions = entry.afterStep.flatMap((raw): PinnedStepAction[] => {
      if (!raw || typeof raw !== 'object') return [];
      const action = raw as { id?: unknown; on?: unknown; target?: unknown; send?: unknown; required?: unknown; targetSpec?: { kind?: unknown } };
      const id = text(action.id); const target = text(action.target);
      if (!id || !target || !Array.isArray(action.on)) return [];
      return [{ id, target, on: action.on.filter((trigger): trigger is string => typeof trigger === 'string'),
        send: text(action.send) ?? 'event', kind: text(action.targetSpec?.kind), required: action.required === true }];
    });
    return actions.length ? [{ phaseId, label: text(entry.label) ?? phaseId, actions }] : [];
  });
}

export function storyUsesStepActions(workflow: StoryWorkflow | null | undefined): boolean {
  return pinnedStepActions(workflow).length > 0;
}

/** One pinned action in words: "On approved, sends the event to team-events". */
export function pinnedActionLine(action: PinnedStepAction): string {
  return `On ${action.on.map((trigger) => TRIGGER_WORDS[trigger] ?? trigger).join(' or ')}, sends ${SEND_WORDS[action.send] ?? action.send} to ${action.target}`
    + (action.required ? '; the next step waits for it' : '');
}

/** Where a delivery stands, in words, and whether retrying it now can help. */
export function deliveryState(delivery: StepActionDelivery): { label: string; tone: 'ok' | 'wait' | 'warn' | 'bad'; retryable: boolean } {
  switch (delivery.status) {
    case 'delivered': return { label: delivery.recorded ? 'Delivered and recorded' : 'Delivered', tone: 'ok', retryable: false };
    case 'waiting': return { label: 'Waits for the commit to be pushed', tone: 'wait', retryable: false };
    // A pipeline delivers it from the pushed commit; its receipt arrives with the branch.
    case 'pipeline': return delivery.recorded
      ? { label: 'Recorded by the pipeline', tone: 'ok', retryable: false }
      : { label: 'A pipeline delivers it', tone: 'wait', retryable: false };
    case 'failed': return { label: 'Not delivered', tone: 'bad', retryable: true };
    case 'tampered': return { label: 'Changed on disk; never sent', tone: 'bad', retryable: false };
    default: {
      const outcome = delivery.lastAttempt?.outcome;
      if (outcome === 'unavailable') return { label: 'Not ready on this machine', tone: 'warn', retryable: true };
      if (outcome === 'retry') return { label: 'Will retry', tone: 'warn', retryable: true };
      return { label: 'Sending', tone: 'wait', retryable: true };
    }
  }
}

/** What the last attempt said: an HTTP status and the receiver's or the engine's reason. */
export function deliveryDetail(delivery: StepActionDelivery): string | null {
  const last = delivery.lastAttempt;
  if (!last) return null;
  const parts = [last.status ? `HTTP ${last.status}` : null, last.outcome === 'delivered' ? null : (last.detail ?? last.code ?? null)];
  return parts.filter(Boolean).join(': ') || null;
}

/**
 * A step's status and generation, for every step. A lifecycle transition changes it; an unrelated
 * refresh does not, so it decides when deliveries are worth reading again.
 */
export function transitionFingerprint(workflow: StoryWorkflow | null | undefined): string {
  if (!workflow?.workItem?.id) return '';
  return [workflow.workItem.id, ...(workflow.phaseOrder ?? []).map((id) => {
    const phase = workflow.phases?.[id] as { status?: string; generation?: number } | undefined;
    return `${id}:${phase?.status ?? ''}:${phase?.generation ?? 0}`;
  })].join('|');
}

/** The deliveries a person should hear about once: tried and not delivered, or tampered with. */
export function undeliveredNotice(deliveries: readonly StepActionDelivery[], announced: ReadonlySet<string>): { keys: string[]; message: string } | null {
  const fresh = deliveries.filter((delivery) => !announced.has(delivery.key) && (delivery.status === 'failed' || delivery.status === 'tampered'
    || (delivery.status === 'pending' && Boolean(delivery.lastAttempt) && delivery.lastAttempt?.outcome !== 'delivered')));
  if (!fresh.length) return null;
  const first = fresh[0]!;
  const what = first.action && first.target ? `${first.action} → ${first.target}` : first.key;
  const why = first.status === 'tampered' ? 'its record changed on disk' : deliveryDetail(first) ?? deliveryState(first).label.toLowerCase();
  const failed = fresh.some((delivery) => delivery.status === 'failed');
  const holds = fresh.some((delivery) => delivery.required && delivery.trigger === 'approved');
  return {
    keys: fresh.map((delivery) => delivery.key),
    message: `${fresh.length} after-step ${fresh.length === 1 ? 'action was' : 'actions were'} not delivered (${what}: ${why}). `
      + (failed ? 'Fix the target, then retry.' : 'It is retried later; you can retry now.')
      + (holds ? ' The next step waits for it.' : '')
  };
}

export function stepActionStatusArgs(workId: string): string[] {
  return ['integrations', 'status', '--work-id', workId, '--all', '--json'];
}

export function stepActionRetryArgs(keys: readonly string[]): string[] {
  return ['integrations', 'retry', ...keys.filter(isDeliveryKey), '--json'];
}

export function stepActionRecordArgs(): string[] {
  return ['integrations', 'record', '--json'];
}

/** Deliveries that went out but whose receipt this checkout does not hold yet. */
export function unrecordedDeliveries(deliveries: readonly StepActionDelivery[]): StepActionDelivery[] {
  return deliveries.filter((delivery) => delivery.status === 'delivered' && delivery.recorded === false);
}

/**
 * The required approved deliveries that hold the next step: those of a step whose current approved
 * generation they belong to, not yet delivered and recorded. An older generation holds nothing.
 */
export function heldBy(deliveries: readonly StepActionDelivery[], workflow: StoryWorkflow | null | undefined): StepActionDelivery[] {
  return deliveries.filter((delivery) => {
    if (!delivery.required || delivery.trigger !== 'approved' || !delivery.phaseId) return false;
    const phase = workflow?.phases?.[delivery.phaseId] as { status?: string; generation?: number } | undefined;
    if (phase?.status !== 'approved' || phase.generation !== delivery.generation) return false;
    return !(delivery.status === 'delivered' && delivery.recorded === true);
  });
}

function deliveriesFrom(value: unknown): StepActionDelivery[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is StepActionDelivery => Boolean(entry) && typeof entry === 'object'
    && isDeliveryKey((entry as { key?: unknown }).key) && typeof (entry as { status?: unknown }).status === 'string');
}

interface RetryReport { delivered?: unknown[]; retrying?: unknown[]; failed?: unknown[]; unavailable?: unknown[] }
interface RecordData { receipts?: unknown[]; skipped?: unknown[]; recorded?: number }

export interface DeliveryClient { run<T = unknown>(args: string[]): Promise<T> }

export interface StoryDeliveries { deliveries: StepActionDelivery[]; loaded: boolean; error: string | null }

/**
 * Reads deliveries for the Stories that send actions and says when they change. One read serves
 * the notification and the Journey, so a transition costs at most one `integrations status`.
 */
export class StepActionDeliveryMonitor {
  private readonly stories = new Map<string, StoryDeliveries & { fingerprint: string }>();
  private readonly announced = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly reading = new Map<string, Promise<void>>();
  private readonly followUps = new Set<string>();
  private readonly client: DeliveryClient;
  private readonly notify: (notice: { keys: string[]; message: string }, workId: string) => void;
  private readonly schedule: (callback: () => void, ms: number) => void;

  constructor(
    client: DeliveryClient,
    notify: (notice: { keys: string[]; message: string }, workId: string) => void,
    schedule: (callback: () => void, ms: number) => void = (callback, ms) => { setTimeout(callback, ms); }
  ) {
    this.client = client;
    this.notify = notify;
    this.schedule = schedule;
  }

  deliveriesFor(workId: string): StoryDeliveries {
    const story = this.stories.get(workId);
    return story ? { deliveries: story.deliveries, loaded: story.loaded, error: story.error } : { deliveries: [], loaded: false, error: null };
  }

  onDidUpdate(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  /**
   * Called on every snapshot change; reads only when this Story sends actions and a step moved, or
   * `readiness` changed (a hold that clears when a required delivery is recorded moves no step).
   */
  observe(workflow: StoryWorkflow | null | undefined, readiness = ''): void {
    const workId = workflow?.workItem?.id;
    if (!workId || !storyUsesStepActions(workflow)) return;
    const fingerprint = `${transitionFingerprint(workflow)}|${readiness}`;
    if (this.stories.get(workId)?.fingerprint === fingerprint) return;
    void this.refresh(workId, fingerprint);
  }

  /** Read this Story's deliveries now. Concurrent calls share one read. */
  refresh(workId: string, fingerprint?: string): Promise<void> {
    const running = this.reading.get(workId);
    if (running) return running;
    const read = this.read(workId, fingerprint ?? this.stories.get(workId)?.fingerprint ?? '')
      .finally(() => { this.reading.delete(workId); });
    this.reading.set(workId, read);
    return read;
  }

  private async read(workId: string, fingerprint: string): Promise<void> {
    const previous = this.stories.get(workId);
    try {
      const result = await this.client.run<{ data?: { deliveries?: unknown } }>(stepActionStatusArgs(workId));
      const deliveries = deliveriesFrom(result?.data?.deliveries).filter((delivery) => !delivery.workId || delivery.workId === workId);
      this.stories.set(workId, { deliveries, loaded: true, error: null, fingerprint });
      const notice = undeliveredNotice(deliveries, this.announced);
      if (notice) {
        for (const key of notice.keys) this.announced.add(key);
        this.notify(notice, workId);
      }
      // A transition made in a terminal is seen as soon as it commits, before its deliveries are
      // tried. Look once more after the command's delivery budget, so their outcome is not missed.
      const untried = deliveries.some((delivery) => delivery.status === 'pending' && !delivery.lastAttempt);
      const followUp = `${workId}\0${fingerprint}`;
      if (untried && !this.followUps.has(followUp)) {
        this.followUps.add(followUp);
        this.schedule(() => { void this.refresh(workId); }, 20_000);
      }
    } catch (error) {
      this.stories.set(workId, { deliveries: previous?.deliveries ?? [], loaded: true, error: (error as Error).message, fingerprint });
    }
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { /* one view's failure never stops another's update */ }
    }
  }

  /** Retry deliveries this Story listed; returns a sentence saying what happened. */
  async retry(workId: string, keys: readonly string[]): Promise<string> {
    const known = new Set(this.deliveriesFor(workId).deliveries.map((delivery) => delivery.key));
    const chosen = [...new Set(keys)].filter((key) => isDeliveryKey(key) && known.has(key));
    if (!chosen.length) return 'There is nothing to retry for this Story.';
    const result = await this.client.run<{ data?: { report?: RetryReport; receipts?: { count?: number } | null } }>(stepActionRetryArgs(chosen));
    const report = result?.data?.report ?? {};
    const count = (list: unknown[] | undefined) => (Array.isArray(list) ? list.length : 0);
    await this.refresh(workId);
    const delivered = count(report.delivered);
    const open = count(report.retrying) + count(report.failed) + count(report.unavailable);
    const recorded = result?.data?.receipts?.count ? ' Its receipt is recorded, so the next step can start.' : '';
    if (!open) return (delivered === 1 ? 'Delivered.' : `Delivered all ${delivered}.`) + recorded;
    return `${delivered ? `${delivered} delivered; ` : ''}${open} still not delivered. Journey shows why.${recorded}`;
  }

  /** Commit a receipt for each delivery of the checked-out Story that went out; returns a sentence. */
  async record(workId: string): Promise<string> {
    const result = await this.client.run<{ data?: RecordData }>(stepActionRecordArgs());
    await this.refresh(workId);
    const written = Array.isArray(result?.data?.receipts) ? result.data.receipts.length : 0;
    if (written) return `Recorded ${written} ${written === 1 ? 'receipt' : 'receipts'} in the Story.`;
    const skipped = Array.isArray(result?.data?.skipped) ? result.data.skipped.length : 0;
    return skipped ? `Nothing was recorded: ${skipped} ${skipped === 1 ? 'delivery does' : 'deliveries do'} not match what the Story pinned.` : 'Nothing to record.';
  }
}
