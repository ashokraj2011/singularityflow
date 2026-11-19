/** Publication-only Story gateway. No authoring, test execution or approval engines are loaded. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { commitAndPublish } from './story-publication-service.mjs';
export { assertNoPendingPublication } from './story-publication-pending.mjs';

/**
 * A decision's advice record (advice-outcomes.mjs), appended by the first Story transaction made while it is set, in that
 * transaction's own commit [owner, 2026-11-19, Q13]: one write point, and the record writers stay as they are.
 */
export const decisionAdvice = new AsyncLocalStorage();

export class StoryPublicationStore {
  constructor(root, definition) { this.root = root; this.definition = definition; }
  publish(workflow, event, message, paths = [], options = {}) {
    return commitAndPublish(this.root, this.definition, workflow, event, message, paths, options);
  }
  async transact(workflow, event, message, transition, { paths = [], ...options } = {}) {
    if (typeof transition !== 'function') throw new TypeError('Story transaction requires a transition function.');
    const prior = structuredClone(workflow);
    let value;
    const publication = await this.publish(workflow, event, message, paths, {
      ...options, rollbackWorkflow: prior,
      beforeStateWrite: async (...publicationContext) => {
        value = await transition(workflow, ...publicationContext);
        const advice = decisionAdvice.getStore();
        if (advice && !advice.written) {
          advice.written = true;
          advice.append(workflow, value);
        }
        return value;
      }
    });
    return { value, publication };
  }
}

export function transactStory(root, definition, workflow, event, message, transition, options = {}) {
  return new StoryPublicationStore(root, definition).transact(workflow, event, message, transition, options);
}
