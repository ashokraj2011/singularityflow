/**
 * JSON serialization of a command result.
 *
 * Carries no terminal-only formatting: no padding, no arrows, no rank columns, no rendered
 * sentences. A JSON client gets codes and slots and renders its own words, which is the whole point
 * of keeping the wording in a catalog. The rendered `headline` is offered once, explicitly named as
 * a convenience, so a consumer that only wants to echo something has one without every client
 * reimplementing the catalog.
 */
import { MESSAGES } from './messages.mjs';
import { preservedEverything } from './command-result.mjs';

export function renderCommandResultJson(result) {
  const message = MESSAGES[result.outcome.messageId];
  return JSON.stringify({
    ...result,
    rendered: {
      headline: message ? message.headline(result.outcome.slots ?? {}) : result.outcome.messageId,
      preservedEverything: preservedEverything(result)
    }
  }, null, 2);
}
