/**
 * What a webview is allowed to say to the extension. `[UXH:REQ-134]` `[UXH:AC-014]`
 *
 * A webview is a separate document. Everything arriving from one is input, and the extension host
 * side of `postMessage` is the widest attack surface this product has — it runs with the extension's
 * privileges and is reachable by any script that reaches the page.
 *
 * The boundary is already careful about *types*: 26 of 27 handlers take `raw: unknown` and coerce
 * field by field. What none of them has is a **closed set**. Each is a chain of
 * `if (message.type === '…')` with no final else, so a message naming an unrecognised type is
 * silently ignored — indistinguishable from one that was handled — and nothing anywhere can answer
 * "what does this panel accept?". That question is the one a reviewer, a fuzzer and the next
 * maintainer all need, and an if-chain cannot answer it.
 *
 * ## What this adds
 *
 * A router built from an enumerated map. The keys *are* the contract: unknown types are refused and
 * reported rather than dropped, and the accepted set is readable at a glance and assertable by test.
 *
 * ## What it deliberately does not do
 *
 * It does not validate field shapes. Per-field coercion already exists at every site and is written
 * against what each message means; replacing it with a generic schema language would be a large,
 * risky rewrite of working code to gain uniformity rather than safety. The gap being closed here is
 * the open type set, which is the part with no defence at all.
 */

/** A message as it arrives: an object with a string `type`, and nothing else assumed. */
export type InboundMessage = Readonly<Record<string, unknown>> & { readonly type: string };

/** What the host does with a message it does not recognise. */
export type UnknownMessageReport = (type: string, panel: string) => void;

/**
 * Narrow an arbitrary `postMessage` payload, or reject it.
 *
 * Null for anything that is not an object with a string `type` — including arrays, which are
 * objects and would otherwise reach a handler as one.
 */
export function inboundMessage(raw: unknown): InboundMessage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const type = (raw as { type?: unknown }).type;
  if (typeof type !== 'string' || !type) return null;
  return raw as InboundMessage;
}

/**
 * Route a payload against an enumerated set of handlers.
 *
 * `handlers` is the panel's contract: its keys are exactly the messages the panel accepts, and a
 * type outside them is reported rather than ignored. Reporting matters more than refusing — a
 * silently dropped message looks identical to a handled one, so the bug it hides is a button that
 * does nothing and a maintainer who cannot tell whether the message arrived.
 */
export function createMessageRouter<T extends Record<string, (message: InboundMessage) => unknown>>(
  panel: string,
  handlers: T,
  onUnknown: UnknownMessageReport = () => {}
): { readonly accepts: readonly string[]; route(raw: unknown): unknown } {
  const accepts = Object.freeze(Object.keys(handlers));
  return {
    /** The contract, readable and assertable. This is the property the if-chains could not offer. */
    accepts,
    route(raw: unknown): unknown {
      const message = inboundMessage(raw);
      if (!message) {
        onUnknown('(malformed)', panel);
        return undefined;
      }
      const handler = handlers[message.type];
      if (!handler) {
        onUnknown(message.type, panel);
        return undefined;
      }
      return handler(message);
    }
  };
}

/**
 * Read a string field, or null.
 *
 * `null` rather than `''` because an absent field and an empty one are different, and the coercion
 * `String(value ?? '')` — which several handlers use — turns `undefined`, `null`, `0` and `false`
 * into strings a handler will then act on.
 */
export function stringField(message: InboundMessage, name: string): string | null {
  const value = message[name];
  return typeof value === 'string' && value ? value : null;
}

/**
 * Read a non-negative integer field strictly, or null.
 *
 * Strict because the values this reads are used as array indices. `Number.isInteger` refuses a
 * float, a numeric string and `NaN`, and the lower bound refuses a negative — which in JavaScript
 * would not throw, would simply find nothing, and would leave the reason obscure. A caller still
 * looks the result up in its own collection; this only guarantees the shape.
 */
export function integerField(message: InboundMessage, name: string): number | null {
  const value = message[name];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Read a boolean field strictly: only `true` is true, so a truthy string is not. */
export function booleanField(message: InboundMessage, name: string): boolean {
  return message[name] === true;
}

/**
 * Read a field constrained to a known set.
 *
 * The check a tab or mode switch needs: anything outside the enumeration is null, so a message
 * cannot put a panel into a state the panel does not have.
 */
export function enumField<T extends string>(
  message: InboundMessage, name: string, allowed: readonly T[]
): T | null {
  const value = message[name];
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : null;
}

/**
 * What each migrated panel accepts, so the set is inspectable from outside it. `[UXH:REQ-134]`
 *
 * The property `[UXH:AC-014]` actually asks for is that the accepted messages are *enumerable* — a
 * reviewer, a fuzzer and the next maintainer all need to ask a panel what it speaks, and an
 * if-chain cannot answer. Registering here makes the answer available without reaching into any
 * panel's closure.
 *
 * It began in `result-panel.ts`, which was the right place while one panel was migrated and the
 * wrong one the moment a second needed it: a registry every panel writes to does not belong inside
 * one of them. Here it sits beside the router that populates it and imports nothing.
 */
export const acceptedMessages = new Map<string, readonly string[]>();

/**
 * Where an unrecognised message goes.
 *
 * The output channel rather than a toast: this is a developer-facing fact about a contract
 * mismatch, not something a reader did wrong, and a modal for it would train people to dismiss
 * modals. Silence is the one option ruled out — a silently dropped message looks exactly like a
 * handled one, so the bug it hides is a control that does nothing.
 */
export function reportUnknownMessage(type: string, source: string): void {
  console.warn(`[singularity-flow] ${source} received an unrecognised message: ${type}`);
}

/**
 * Register a panel's contract and return its router. `[UXH:REQ-134]` `[UXH:AC-014]`
 *
 * One call rather than three lines repeated 24 times, and the registration cannot be forgotten:
 * a panel that builds a router without registering it is enumerable from inside its own closure
 * and nowhere else, which is the state every panel was already in.
 */
export function registerMessageRouter<T extends Record<string, (message: InboundMessage) => unknown>>(
  panel: string,
  handlers: T
): { readonly accepts: readonly string[]; route(raw: unknown): unknown } {
  const router = createMessageRouter(panel, handlers, reportUnknownMessage);
  acceptedMessages.set(panel, router.accepts);
  return router;
}
