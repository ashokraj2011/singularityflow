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
import { resolveHelp } from '../../help-service.mjs';
import { noEffects, plannerNavigation, preservedAll, sflowResult } from '../result.mjs';

/** The ceiling on a served body. Beyond it the reader gets a preview and a handle `[INT:CON-037]`. */
export const EXPLAIN_PREVIEW_BYTES = 4000;

const FALLBACK = Object.freeze({ label: 'List every topic', command: 'sflow explain' });

function suggestion(topicId, index, reasonCode) {
  return plannerNavigation({
    handle: `topic:${topicId}`,
    id: `topic:${topicId}`,
    label: topicId,
    rank: index,
    kind: 'clarification',
    reasonCode,
    confirmation: 'none',
    interaction: 'read',
    /** The topic this suggestion would open, named where every other surface reads topics from. */
    topic: topicId,
    executable: false,
    fallback: FALLBACK
  }, 'help.explain', { question: topicId, topic: topicId });
}

function ask(messageSlots, topicIds, reasonCode, why, helpIntent) {
  return sflowResult({
    kind: 'clarification',
    operation: { id: 'help.explain', classification: 'read' },
    outcome: { status: 'succeeded', messageId: 'gateway.clarification', slots: messageSlots },
    effects: noEffects(),
    why,
    next: topicIds.map((topicId, index) => suggestion(topicId, index, reasonCode)),
    restState: topicIds.length ? null : 'informational',
    data: { helpIntent }
  });
}

export async function helpExplain({ arguments: args = {}, subject = null } = {}) {
  const query = args.topic ?? args.question ?? '';
  const resolved = await resolveHelp(query, { maxBytes: EXPLAIN_PREVIEW_BYTES });
  const helpIntent = resolved.helpIntent;

  if (resolved.status === 'ambiguous') {
    return ask({ query }, resolved.candidates.map((topic) => topic.id), 'explain.ambiguous', [
      { code: 'explain.ambiguous', source: 'registry', slots: { count: resolved.candidates.length } }
    ], helpIntent);
  }

  if (resolved.status !== 'resolved') {
    /**
     * A question the documentation does not answer is answered as such.
     *
     * Serving the nearest topic would be the friendlier-looking behaviour and the more dangerous
     * one: a cited answer to a question nobody asked reads exactly like a cited answer to the
     * question they did ask.
     */
    return ask({ query }, resolved.candidates.map((topic) => topic.id), 'explain.no-match', [
      { code: 'explain.no-match', source: 'unavailable', slots: { query } }
    ], helpIntent);
  }

  const topic = resolved.topic;
  const served = resolved.served;
  const handle = resolved.handle;

  // The shared resolver refuses before returning if the topic tree and stamped manifest differ.
  // Reaching this line therefore means the citation is bound to this packaged catalog.
  const stamped = resolved.provenance.docsContentSha256;

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
      slots: { topic: topic.id, version: String(topic.version), matchedBy: resolved.matchedBy }
    }],
    next: [suggestion(topic.id, 0, 'explain.cited')],
    restState: 'informational',
    data: {
      topic: topic.id,
      title: topic.title,
      handle,
      matchedBy: resolved.matchedBy,
      helpIntent,
      // Bounded by construction: a truncated body says so, and the handle expands it on request.
      body: served.text,
      bytes: served.bytes,
      bodySha256: served.sha256,
      truncated: Boolean(served.truncated),
      // Only present when there is more to fetch, which is when the preview stopped short.
      expandHandle: served.handle ?? null,
      sections: Object.freeze([...served.sections]),
      docsSourceCommit: resolved.provenance.docsSourceCommit,
      docsContentSha256: stamped,
      citation: resolved.citation,
      related: resolved.related,
      handoff: resolved.handoff
    }
  });
}

// ---------------------------------------------------------------------------------------------------
// `sflow explain`, the explicit path to the same service, in the same contract. `[INT:CON-021]` `[INT:IFC-020]`
//
// The CLI and the planner both answer from `resolveHelp`, and since the v2 reset `[INT:CON-042]` the
// CLI's envelope is `sflow-result` v2 as well. Its `data` keeps the CLI's own fields — `served`,
// `citation`, `topic`, `provenance`, `here` — because the documentation skills and the editor read
// exactly those; what changed is the envelope around them, which now carries the six-key effects
// record, catalogued reasons, and next actions with a stable id and a fallback route.
//
// A CLI process holds no handle authority, so its next actions carry `cli:` placeholders. They name
// the action for display and focus and are never redeemable: a host that dispatches one is refused
// by the kernel as unknown, and the fallback command is the route.
// ---------------------------------------------------------------------------------------------------

function topicAction(topicId, index, reasonCode, { label = `Read ${topicId}` } = {}) {
  return {
    handle: `cli:explain:${topicId}`,
    id: `explain:${topicId}`,
    label,
    rank: index,
    kind: 'read',
    reasonCode,
    confirmation: 'none',
    interaction: 'read',
    topic: topicId,
    executable: false,
    fallback: { label, command: topicId === 'index' ? 'sflow explain' : `sflow explain ${topicId}` }
  };
}

const EXPLAIN_OPERATION = Object.freeze({ id: 'explain', classification: 'read' });

export function explainIndexResult(topics, provenance) {
  return sflowResult({
    kind: 'read',
    operation: EXPLAIN_OPERATION,
    outcome: { status: 'succeeded', messageId: 'gateway.explained', slots: { topic: 'index', title: 'Documentation topics' } },
    effects: noEffects(),
    why: [{ code: 'explain.index', source: 'evidence', reference: 'docs/topics', slots: { count: String(topics.length) } }],
    next: topics.slice(0, 3).map((topic, index) => topicAction(topic.id, index, 'explain.index')),
    restState: topics.length ? null : 'informational',
    data: {
      provenance: {
        topic: 'index', topicVersion: 1,
        docsSourceCommit: provenance?.docsSourceCommit ?? null,
        docsContentSha256: provenance?.docsContentSha256 ?? null
      },
      topics: topics.map((topic) => ({ id: topic.id, title: topic.title, version: topic.version }))
    }
  });
}

/** Ambiguous or unmatched: a question back, never the nearest topic served as the answer. */
export function explainClarificationResult(resolution) {
  const ambiguous = resolution.status === 'ambiguous';
  const ids = ambiguous
    ? resolution.candidates.slice(0, 5).map((topic) => topic.id)
    : resolution.candidates.map((topic) => topic.id);
  return sflowResult({
    kind: 'clarification',
    operation: EXPLAIN_OPERATION,
    outcome: {
      status: 'refused', messageId: 'gateway.clarification',
      slots: { query: resolution.query, ...(ambiguous ? { count: String(resolution.candidates.length) } : {}) }
    },
    effects: noEffects(),
    why: [ambiguous
      ? { code: 'explain.ambiguous', source: 'registry', reference: 'docs/topics',
        slots: { query: resolution.query, count: String(resolution.candidates.length) } }
      : { code: 'explain.no-match', source: 'unavailable', reference: 'help-and-docs', slots: { query: resolution.query } }],
    preserved: preservedAll('explain.nothing-was-carried-out'),
    next: [
      ...ids.map((id, index) => topicAction(id, index, ambiguous ? 'explain.ambiguous' : 'explain.no-match')),
      ...(ambiguous ? [] : [topicAction('index', ids.length, 'explain.no-match', { label: 'List every topic' })])
    ],
    data: ambiguous
      ? { query: resolution.query, candidates: resolution.candidates.map((topic) => topic.id), helpIntent: resolution.helpIntent }
      : { query: resolution.query, nearest: ids, helpIntent: resolution.helpIntent }
  });
}

export function explainServedResult(resolution, { wantsHere = false, here = null, situation = null } = {}) {
  const { topic, provenance, served } = resolution;
  return sflowResult({
    kind: 'read',
    operation: EXPLAIN_OPERATION,
    outcome: {
      status: 'succeeded', messageId: 'gateway.explained',
      slots: { topic: topic.id, title: topic.title, version: String(topic.version), ...(here ? { subject: here.subject } : {}) }
    },
    effects: noEffects(),
    why: [
      { code: 'explain.cited', source: 'evidence', reference: served.handle ?? topic.id,
        slots: { topic: topic.id, version: String(topic.version), matchedBy: resolution.matchedBy ?? 'id' } },
      // Two planes, two citations, never blended `[DOC:REQ-022]` `[INT:CON-010]`.
      ...(here ? [{ code: 'explain.situation-from-state', source: 'lifecycle', reference: here.revision ?? null,
        slots: { subject: here.subject } }] : []),
      // Degrading is explained, not silent: the reader asked for their situation and did not get it.
      ...(wantsHere && !here ? [{ code: 'explain.subject-unresolved', source: 'unavailable', reference: 'docs/topics',
        slots: { reason: situation?.reason ?? 'unknown' } }] : [])
    ],
    next: resolution.related.map((entry, index) => topicAction(entry.id, index, 'explain.cited')),
    restState: resolution.related.length ? null : 'informational',
    data: {
      resolvedBy: resolution.matchedBy,
      helpIntent: resolution.helpIntent,
      provenance,
      citation: resolution.citation,
      topic: {
        id: topic.id, title: topic.title, version: topic.version, sha256: topic.sha256,
        file: topic.file,
        commands: [...topic.commands], related: [...topic.related], aliases: [...topic.aliases]
      },
      served: { text: served.text, bytes: served.bytes, truncated: served.truncated, sha256: served.sha256, handle: served.handle },
      here: here
        ? { plane: 'state', subject: here.subject, phase: here.phase, status: here.status, revision: here.revision, branch: here.branch, lines: here.lines }
        : null,
      // `unreadable` is not the same as "you are not in a story", and collapsing the two is what hid
      // this feature being dead.
      hereUnavailable: wantsHere && !here ? { reason: situation?.reason ?? 'unknown', detail: situation?.detail ?? null } : null
    }
  });
}
