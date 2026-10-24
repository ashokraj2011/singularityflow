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
import { classifyHelpIntent } from '../../help-intents.mjs';
import { catalogued } from '../catalog.mjs';
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
// Where a piece of work stands, answered from its record. `[DOC:REQ-020]` `[INT:REQ-061]`
//
// "Why is my Story blocked?" is a question about state, and the documentation cannot answer it: live
// (2026-10-24), it came back as a list of every topic, and Copilot needed five more calls to reach
// the record. The kernel reads the work the way `sflow_next` does — the named Story, else the one
// checked out, else the only open one — and these build the answer from what it read. The state
// plane is cited by revision and the documentation only by topic, never blended `[DOC:REQ-022]`.
// ---------------------------------------------------------------------------------------------------

/**
 * The topic that explains each blocker `work-records.mjs` reports: a pointer one more
 * `sflow_explain` follows, not an excerpt.
 */
export const BLOCKER_TOPICS = Object.freeze({
  'publication-pending': 'recovery',
  'publication-marker-unreadable': 'recovery',
  'approvals-outstanding': 'approvals',
  'required-artifact-missing': 'artifacts-and-generation'
});

const EXPLAIN_READ = Object.freeze({ id: 'help.explain', classification: 'read' });

/**
 * One work item's state as the answer: phase, status, blockers, the next action its record
 * computes, and, while a phase awaits approval, the decision.
 *
 * The decision is a person's. It is described (`data.decision`) and offered only as the ceremony
 * destination, which the contract keeps unexecutable; the one executable action is the read the
 * record computed. `chosen` says how the item was picked when nobody named it, and `subject` carries
 * the revision the record was read at.
 */
export function explainWorkResult({
  question, item, lead = [], chosen = [], decision = null, binding = {}, subject = { kind: item.kind, id: item.id }
}) {
  const blockers = (item.blockers ?? []).map((blocker) => ({
    blocker,
    code: catalogued(`work.blocked.${blocker}`, 'work.blocked.unrecognised'),
    topic: BLOCKER_TOPICS[blocker] ?? null
  }));
  const awaitingDecision = item.status === 'awaiting_approval';
  const revision = binding.sourceCommit ?? null;
  const next = [...lead, ...(decision ? [decision] : [])].map((action, rank) => ({ ...action, rank }));
  return sflowResult({
    kind: 'read',
    operation: EXPLAIN_READ,
    subject,
    outcome: {
      status: 'succeeded', messageId: 'gateway.explained-work',
      slots: { work: item.id, phase: item.phase ?? 'none', status: item.status ?? 'none' }
    },
    effects: noEffects(),
    why: [
      { code: 'explain.situation-from-state', source: 'lifecycle', reference: revision, slots: { subject: item.id } },
      ...chosen,
      ...blockers.map((entry) => ({ code: entry.code, source: 'lifecycle', reference: item.id, slots: { blocker: entry.blocker } })),
      ...(awaitingDecision ? [{ code: 'readiness.awaiting-a-human-decision', source: 'lifecycle', reference: item.id,
        slots: { phase: item.phase ?? 'none' } }] : [])
    ],
    next,
    restState: next.length ? null : 'informational',
    data: {
      helpIntent: classifyHelpIntent(question) ?? 'concept',
      answeredFrom: 'work-records',
      work: {
        kind: item.kind, id: item.id, title: item.title, phase: item.phase, phaseLabel: item.phaseLabel,
        status: item.status, generation: item.generation, group: item.group, whyVisible: item.whyVisible,
        branch: item.branch, rail: item.rail ?? [], lastMaterialEvent: item.lastMaterialEvent ?? null,
        blockers,
        nextAction: item.nextAction
          ? { ...item.nextAction, handle: lead.find((action) => action.id === `work:${item.id}`)?.handle ?? null }
          : null
      },
      decision: awaitingDecision ? {
        operation: 'review.open', phase: item.phase, decidedBy: 'person',
        availableToActor: item.group === 'waiting-on-you', executable: false
      } : null,
      citation: { plane: 'state', subject: item.id, branch: binding.branch ?? null, revision }
    }
  });
}

/**
 * Which work? Several are open and none is current, or the one named is not here.
 *
 * Asked back with the open work and each item's next action, never with documentation topics, and
 * never by answering about a different item than the one named.
 */
export function explainWhichWorkResult({ question, named = null, why = [], lead = [], work }) {
  return sflowResult({
    kind: 'clarification',
    operation: EXPLAIN_READ,
    subject: named ? { kind: named.kind ?? 'story', id: named.id } : null,
    outcome: { status: 'succeeded', messageId: 'gateway.clarification', slots: { query: question } },
    effects: noEffects(),
    why,
    next: lead.map((action, rank) => ({ ...action, rank })),
    restState: lead.length ? null : 'informational',
    data: { helpIntent: classifyHelpIntent(question) ?? 'concept', answeredFrom: 'work-records', work }
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
