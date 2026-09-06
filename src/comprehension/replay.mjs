import { beatKinds, narrationBeats } from '../narration/beats.mjs';
import { recordSha256 } from '../records.mjs';
import { SingularityFlowError } from '../util.mjs';

export const CMP_REPLAY_FOCUS_TYPES = Object.freeze(['all', 'phase', 'kind']);

const MAXIMUM_REPLAY_EVENTS = 1000;
const MAXIMUM_FOCUS_VALUE = 128;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_PHASE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const GIT_OBJECT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

function sha256(value) {
  return `sha256:${recordSha256(value)}`;
}

function focus(focusType, focusValue) {
  const type = focusType ?? 'all';
  if (!CMP_REPLAY_FOCUS_TYPES.includes(type)) {
    throw new SingularityFlowError(
      `Unknown comprehension replay focus '${type}'. Use ${CMP_REPLAY_FOCUS_TYPES.join(', ')}.`,
      { code: 'CMP_REPLAY_QUERY_INVALID' }
    );
  }
  const value = String(focusValue ?? '').trim();
  if (type === 'all') {
    if (value) throw new SingularityFlowError('Comprehension replay focus all takes no value.', {
      code: 'CMP_REPLAY_QUERY_INVALID'
    });
    return { type, value: null };
  }
  if (!value || value.length > MAXIMUM_FOCUS_VALUE || value.includes('\0')) {
    throw new SingularityFlowError(`Comprehension replay focus ${type} requires one bounded value.`, {
      code: 'CMP_REPLAY_QUERY_INVALID'
    });
  }
  if (type === 'phase' && !SAFE_PHASE.test(value)) {
    throw new SingularityFlowError('Comprehension replay phase focus requires one exact phase identifier.', {
      code: 'CMP_REPLAY_QUERY_INVALID'
    });
  }
  if (type === 'kind' && !beatKinds().includes(value)) {
    throw new SingularityFlowError(
      `Unknown Story replay kind '${value}'. Use one of: ${beatKinds().join(', ')}.`,
      { code: 'CMP_REPLAY_QUERY_INVALID' }
    );
  }
  return { type, value };
}

function matches(event, selected) {
  if (selected.type === 'all') return true;
  if (selected.type === 'phase') return event.phase === selected.value;
  return event.kind === selected.value;
}

function project(beat) {
  if (!ISO_INSTANT.test(String(beat.at ?? '')) || Number.isNaN(Date.parse(beat.at))
      || (beat.phase !== null && !SAFE_PHASE.test(String(beat.phase)))
      || (beat.generation !== null
        && (!Number.isSafeInteger(beat.generation) || beat.generation < 0))
      || !['lifecycle', 'operational'].includes(beat.source.stream)
      || (beat.source.eventId !== null && !SAFE_IDENTIFIER.test(String(beat.source.eventId)))
      || (beat.source.commit !== null && !GIT_OBJECT.test(String(beat.source.commit)))) {
    throw new SingularityFlowError('Comprehension replay found malformed data in the normalized Story history.', {
      code: 'CMP_REPLAY_SOURCE_INVALID'
    });
  }
  const core = {
    kind: beat.kind,
    at: beat.at,
    phase: beat.phase,
    generation: beat.generation,
    transition: beat.kind === 'story.reopened' ? 'lifecycle-reopen' : 'forward-lifecycle',
    causalProvenance: 'unavailable',
    provenance: beat.source.stream === 'lifecycle'
      ? 'attested-lifecycle'
      : 'operational-history',
    source: {
      stream: beat.source.stream,
      eventId: beat.source.eventId,
      commit: beat.source.commit
    }
  };
  return { ...core, eventSha256: sha256(core) };
}

/**
 * Build a content-free, deterministic Story replay projection.
 *
 * This intentionally consumes the shared normalized beat vocabulary. It does not read SGOS Process
 * runtime records, mutate a Process, or include operational detail, actors, prompts, transcripts,
 * or model-authored summaries.
 */
export function buildComprehensionReplay(workflow, {
  focusType = 'all',
  focusValue = null
} = {}) {
  if (!workflow?.workItem?.id || !Array.isArray(workflow.history)
      || !Array.isArray(workflow.publicationProjections ?? [])) {
    throw new SingularityFlowError('Comprehension replay requires one readable governed Story history.', {
      code: 'CMP_REPLAY_SOURCE_INVALID'
    });
  }
  const selected = focus(focusType, focusValue);
  const all = narrationBeats(workflow).map(project).filter((event) => matches(event, selected));
  const events = all.slice(0, MAXIMUM_REPLAY_EVENTS);
  const core = {
    schemaVersion: 1, // schema-transient: read-only Story replay projection; never persisted
    kind: 'comprehension-story-replay',
    authoritative: false,
    authority: 'existing-history-projection',
    lifecycleGate: false,
    mutatesProcess: false,
    workId: workflow.workItem.id,
    focus: selected,
    events,
    counts: {
      matched: all.length,
      returned: events.length,
      lifecycle: events.filter((event) => event.source.stream === 'lifecycle').length,
      operational: events.filter((event) => event.source.stream === 'operational').length
    },
    truncated: all.length > events.length,
    exclusions: [
      'actors', 'operational-detail', 'prompts', 'transcripts', 'model-summaries', 'sgos-process-state'
    ]
  };
  return freezeDeep({ ...core, replaySha256: sha256(core) });
}
