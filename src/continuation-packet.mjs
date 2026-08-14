/**
 * What a developer needs to know when they come back. `[AMD:REQ-041]` `[AMD:REQ-042]`
 *
 * Someone leaves work mid-phase and returns a day later. Four questions, in the order they matter:
 * what was fixed when I started, what has moved since, what of mine has gone stale — and, the one
 * this spec adds, what did the specification itself change underneath me.
 *
 * Four sections, and the ordering is the design. PINNED first because it is the ground everything
 * else is measured against; AMENDED last because it is the only one that asks the reader to do
 * something. A packet that opened with the demand would bury the context needed to answer it.
 *
 * Pure: it takes facts and returns a projection. It reads no repository, runs no command, and
 * acknowledges nothing on the reader's behalf — the acknowledgment is a recorded human beat
 * `[AMD:CON-003]`, and this only says whether one is outstanding.
 */
import { SingularityFlowError } from './util.mjs';

/**
 * Evidence produced before an acknowledgment stays valid against the generation it was produced
 * under, and says so. `[AMD:CON-005]` `[AMD:REQ-042]`
 *
 * The alternative — invalidating it — would throw away work that was correct when it was done, and
 * the alternative to *that* — leaving it unlabelled — would let a reader mistake it for evidence
 * about the amended clause. Labelling is the only honest option.
 */
export function evidenceGeneration(evidence, acknowledgedGeneration) {
  const produced = Number(evidence?.generation ?? 0);
  const acknowledged = Number(acknowledgedGeneration ?? 0);
  return Object.freeze({
    generation: produced,
    current: produced >= acknowledged,
    label: produced >= acknowledged
      ? `verified against generation ${produced}`
      : `verified against generation ${produced}, before the amendment to generation ${acknowledged}`
  });
}

/**
 * Build the packet.
 *
 * `interval` is the open work interval, including any amendments carried onto it. `claims` is the
 * developer's planned claim map, so the AMENDED section can say what each changed clause means for
 * *their* work rather than in the abstract.
 */
export function continuationPacket({
  interval = null,
  changedPaths = [],
  currentConfigSha256 = null,
  currentSourceSha256 = null,
  claims = {},
  acknowledgedGeneration = null,
  clauseText = {}
} = {}) {
  if (!interval) throw new SingularityFlowError('A continuation packet needs an open work interval.', { code: 'CONTINUATION_PACKET_INVALID' });

  const pinned = Object.freeze({
    intervalId: interval.intervalId,
    phaseId: interval.phaseId,
    generation: Number(interval.generation),
    baselineCommit: interval.sourceBaseCommit,
    configurationSha256: interval.configurationSha256 ?? null,
    sourceSha256: interval.sourceSha256 ?? null,
    requiredChecks: Object.freeze([...(interval.requiredChecks ?? [])])
  });

  const sinceYouLeft = Object.freeze({
    changedPaths: Object.freeze([...changedPaths].sort()),
    // Named rather than counted, because "nothing moved" is a different message from "3 files
    // moved" and a reader should not have to read an empty list to learn which they are in.
    quiet: changedPaths.length === 0
  });

  /**
   * A pinned fact that no longer matches. Distinct from SINCE-YOU-LEFT: that is the reader's own
   * work moving, this is the ground moving under it.
   */
  const drift = [];
  if (pinned.configurationSha256 && currentConfigSha256 && pinned.configurationSha256 !== currentConfigSha256) {
    drift.push({ fact: 'configuration', pinned: pinned.configurationSha256, current: currentConfigSha256 });
  }
  if (pinned.sourceSha256 && currentSourceSha256 && pinned.sourceSha256 !== currentSourceSha256) {
    drift.push({ fact: 'source tree', pinned: pinned.sourceSha256, current: currentSourceSha256 });
  }
  const stale = Object.freeze({ drift: Object.freeze(drift), quiet: drift.length === 0 });

  /**
   * AMENDED. `[AMD:REQ-041]`
   *
   * Per changed clause: what it says now, what the developer claimed against it, and whether their
   * claim is in the blast radius. A clause the reader never claimed is still listed — they may need
   * to claim it now — but it is not what gates their submission.
   */
  const planned = claims?.claims ?? claims ?? {};
  const amendments = interval.amendments ?? [];
  const changedClauses = [...new Set(amendments.flatMap((entry) => entry.clauses ?? []))].sort();
  const clauses = changedClauses.map((clauseId) => {
    const claim = planned[clauseId] ?? planned[clauseId.toUpperCase()] ?? null;
    return Object.freeze({
      clauseId,
      text: clauseText[clauseId] ?? null,
      claimed: Boolean(claim),
      artifacts: Object.freeze([...(claim?.expectedPaths ?? [])]),
      tests: Object.freeze([...(claim?.tests ?? [])])
    });
  });

  /**
   * The acknowledgment beat. `[AMD:REQ-041]` `[AMD:AC-004]`
   *
   * Outstanding only where the amendment actually touches something the reader claimed. An
   * acknowledgment demanded for a clause nobody here is working on is a speed bump that teaches
   * people to click past the ones that matter.
   */
  const touchesMyWork = clauses.some((clause) => clause.claimed);
  const latest = amendments.at(-1) ?? null;
  const outstanding = Boolean(latest)
    && touchesMyWork
    && Number(acknowledgedGeneration ?? 0) < Number(latest.toGeneration ?? 0);

  const amended = Object.freeze({
    quiet: !amendments.length,
    amendments: Object.freeze(amendments.map((entry) => Object.freeze({ ...entry }))),
    clauses: Object.freeze(clauses),
    touchesMyWork,
    acknowledgment: Object.freeze({
      required: outstanding,
      throughGeneration: latest?.toGeneration ?? null,
      acknowledgedGeneration: acknowledgedGeneration ?? null,
      action: outstanding ? `sflow story interval acknowledge --through ${latest.toGeneration}` : null
    })
  });

  return Object.freeze({
    resultType: 'continuation-packet',
    schemaVersion: 1,
    sections: Object.freeze(['pinned', 'sinceYouLeft', 'stale', 'amended']),
    pinned,
    sinceYouLeft,
    stale,
    amended
  });
}

/**
 * Whether submission may proceed. `[AMD:AC-004]`
 *
 * Blocked only by an outstanding acknowledgment on work the reader claimed. Not by the amendment
 * existing, and not by drift — those are things to read, not things to answer.
 */
export function submissionBlockedByAmendment(packet) {
  if (!packet?.amended?.acknowledgment?.required) return null;
  const { throughGeneration } = packet.amended.acknowledgment;
  const clauses = packet.amended.clauses.filter((clause) => clause.claimed).map((clause) => clause.clauseId);
  return `The specification was amended to generation ${throughGeneration} and it changes ${clauses.join(', ')},`
    + ` which you have claimed. Acknowledge the amendment before submitting: ${packet.amended.acknowledgment.action}`;
}
