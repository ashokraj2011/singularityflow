/**
 * `help.explain`: bounded, cited answers from the documentation package. `[INT:IFC-016]`
 *
 * The first planner with a real implementation, and deliberately this one: it needs no repository,
 * no network and no model, so it proves the whole path — resolve, handle, revalidate, route, result
 * — against real data rather than a fixture.
 *
 * It answers only from compiled topics `[DOC:REQ-014]`, and every statement carries its source class
 * and a resolvable handle `[INT:REQ-037]`. The one thing it will not do is guess: an unmatched
 * question becomes a clarification with the nearest topic IDs, never the closest topic served as if
 * it were the answer.
 */
import { docsHandle, servedBody } from '../../commands/explain.mjs';
import { docsManifest } from '../../docs-manifest.mjs';
import { loadTopics, nearestTopicIds, resolveTopic } from '../../docs-topics.mjs';
import { noEffects, sflowResult } from '../result.mjs';

/** The ceiling on a served body. Beyond it the reader gets a preview and a handle `[INT:CON-037]`. */
export const EXPLAIN_PREVIEW_BYTES = 4000;

const FALLBACK = Object.freeze({ label: 'List every topic', command: 'sflow explain' });

function suggestion(topicId, index, reasonCode) {
  return {
    handle: `topic:${topicId}`,
    label: topicId,
    rank: index,
    kind: 'clarification',
    reasonCode,
    confirmation: 'none',
    executable: false,
    fallback: FALLBACK
  };
}

function ask(messageSlots, topicIds, reasonCode, why) {
  return sflowResult({
    kind: 'clarification',
    operation: { id: 'help.explain', classification: 'read' },
    outcome: { status: 'succeeded', messageId: 'gateway.clarification', slots: messageSlots },
    effects: noEffects(),
    why,
    next: topicIds.map((topicId, index) => suggestion(topicId, index, reasonCode)),
    restState: topicIds.length ? null : 'informational'
  });
}

export async function helpExplain({ arguments: args = {}, subject = null } = {}) {
  const topics = await loadTopics();
  const manifest = docsManifest();
  const query = args.topic ?? args.question ?? '';
  const resolved = resolveTopic(topics, query);

  if (resolved.status === 'ambiguous') {
    return ask({ query }, resolved.candidates, 'explain.ambiguous', [
      { code: 'explain.ambiguous', source: 'registry', slots: { count: resolved.candidates.length } }
    ]);
  }

  if (resolved.status !== 'resolved') {
    /**
     * A question the documentation does not answer is answered as such.
     *
     * Serving the nearest topic would be the friendlier-looking behaviour and the more dangerous
     * one: a cited answer to a question nobody asked reads exactly like a cited answer to the
     * question they did ask.
     */
    const nearest = nearestTopicIds(topics, query, 3);
    return ask({ query }, nearest.length ? nearest : topics.slice(0, 3).map((topic) => topic.id), 'explain.no-match', [
      { code: 'explain.no-match', source: 'unavailable', slots: { query } }
    ]);
  }

  const topic = resolved.topic;
  const served = servedBody(topic, { maxBytes: EXPLAIN_PREVIEW_BYTES });
  const handle = docsHandle(topic);

  /**
   * `manifestMatch` is the honest field, carried through as a warning rather than dropped.
   *
   * It says whether the bytes being served are the ones this build stamped. A citation from edited
   * bytes is worse than no citation, because it looks like evidence.
   */
  const stamped = manifest ? manifest.contentSha256 : null;
  const warnings = stamped ? [] : [{
    code: 'explain.unstamped-docs',
    source: 'unavailable',
    slots: { topic: topic.id }
  }];

  return sflowResult({
    kind: 'read',
    operation: { id: 'help.explain', classification: 'read' },
    subject,
    outcome: { status: 'succeeded', messageId: 'gateway.explained', slots: { topic: topic.id, title: topic.title } },
    effects: noEffects(),
    why: [{
      code: 'explain.cited',
      source: 'evidence',
      reference: handle,
      slots: { topic: topic.id, version: String(topic.version), matchedBy: resolved.how }
    }],
    warnings,
    next: [suggestion(topic.id, 0, 'explain.cited')],
    restState: 'informational',
    data: {
      topic: topic.id,
      title: topic.title,
      handle,
      matchedBy: resolved.how,
      // Bounded by construction: a truncated body says so, and the handle expands it on request.
      body: served.text,
      bytes: served.bytes,
      bodySha256: served.sha256,
      truncated: Boolean(served.truncated),
      // Only present when there is more to fetch, which is when the preview stopped short.
      expandHandle: served.handle ?? null,
      sections: Object.freeze([...served.sections]),
      docsSourceCommit: manifest?.sourceCommit ?? null,
      docsContentSha256: stamped
    }
  });
}
