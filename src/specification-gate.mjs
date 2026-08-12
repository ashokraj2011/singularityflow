/**
 * Where the marker and quality policies stop being opinions. `[SPK:REQ-051]` `[SPK:REQ-065]`
 *
 * `clarification-markers.mjs` and `specification-quality.mjs` can already decide what is wrong with a
 * specification. Until something calls them at a transaction boundary that is *all* they can do —
 * which is exactly the defect this codebase keeps rediscovering: a policy declared, validated, and
 * never reaching a consumer. This module is the consumer.
 *
 * Its only interesting property is where it is called from. `[SPK:REQ-065]` asks that a blocking
 * marker stop publication or submission **before any state mutation**, and the reason is behavioural
 * rather than technical: if writing an honest `[NEEDS CLARIFICATION: ...]` costs a half-published
 * generation to unwind, people stop writing them and put a plausible sentence there instead. The
 * gate has to be cheap to hit.
 *
 * The two policies partition the findings rather than each seeing all of them. Markers are pinned
 * separately from specification quality `[SPK:REQ-064]`, so one unresolved marker reported once as a
 * marker failure and again as a quality failure would read as two problems and leave the author
 * unsure which gate they are standing in front of.
 *
 * Both default to `off`. A Story that pinned neither sees no new behaviour at all.
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { markerQuestionHash } from './clarification-markers.mjs';
import { answeredMarkerHashes, readClarificationRecord, resolvedClarificationPolicy } from './clarifications.mjs';
import {
  MARKER_FINDING_KINDS, STARTER_CHECKLIST, analyzeSpecification, evaluateSpecificationQuality,
  policyHash, specificationQualityPolicy, validateChecklistDecisions
} from './specification-quality.mjs';
import { matchApprovalAuthority } from './approval-authority.mjs';
import { exists } from './util.mjs';

/** The marker half of the pinned clarification policy `[SPK:REQ-064]`. */
export function resolvedMarkerPolicy(definition, workflow, phase) {
  return resolvedClarificationPolicy(definition, workflow, phase).markers;
}

/**
 * The pinned specification-quality policy `[SPK:REQ-050]`.
 *
 * Same three-way fallback as the clarification policy — resolution first, then the phase's own
 * pin, then the definition — because a Story's resolution is the record of what it agreed to, and
 * a later edit to the shared workflow must not retroactively change a Story already in flight.
 */
export function resolvedSpecificationQualityPolicy(definition, workflow, phase) {
  const resolved = workflow.resolution?.phases?.find((entry) => entry.id === phase.id);
  return specificationQualityPolicy(
    resolved?.specificationQuality ?? phase.specificationQuality ?? definition.phases?.[phase.id]?.specificationQuality ?? {}
  );
}

/**
 * The markers this phase carried at its last recorded generation.
 *
 * Needed to tell a *resolved* marker from a *deleted* one `[SPK:REQ-067]`: without the previous
 * generation's list there is nothing for a vanished question to have vanished from, and quietly
 * removing the question would look identical to answering it.
 */
export function previousMarkers(phase, generation) {
  const records = [...(phase?.markers ?? [])]
    .filter((record) => Number.isInteger(record.generation) && record.generation < generation)
    .sort((left, right) => left.generation - right.generation);
  return records.at(-1)?.open ?? [];
}

/**
 * Every marker question this Story has an answer on record for.
 *
 * `pending` carries the clarification record for the generation being published, which has been
 * verified but not yet folded into `phase.clarifications` — omitting it would make an answer given
 * in this very turn invisible to the gate that turn has to pass.
 */
export function recordedMarkerAnswers(phase, pending = null) {
  const hashes = [
    ...(phase?.clarifications ?? []).flatMap((record) => record.markers ?? []),
    ...answeredMarkerHashes(pending)
  ];
  return [...new Set(hashes.map((hash) => markerQuestionHash(hash)).filter(Boolean))]
    .map((questionHash) => ({ questionHash }));
}

const EMPTY = Object.freeze({
  applies: false, markerMode: 'off', qualityMode: 'off',
  errors: [], warnings: [], open: [], report: null, record: null
});

/**
 * Evaluate both policies against an artifact on disk.
 *
 * Returns rather than throws. The caller decides what a failure means at its own boundary, which
 * keeps this module free of any opinion about publication order — and lets `spec analyze` reuse the
 * identical evaluation to *show* a reader what a publish would say.
 */
export async function evaluateSpecificationGate(root, definition, workflow, phase, {
  generation = phase.generation, artifactRelativePath, namespace = null, pendingClarification = null
} = {}) {
  const markerMode = resolvedMarkerPolicy(definition, workflow, phase).mode;
  const quality = resolvedSpecificationQualityPolicy(definition, workflow, phase);
  if (markerMode === 'off' && quality.mode === 'off') return EMPTY;

  const absolute = path.join(root, artifactRelativePath);
  // A missing artifact is not this gate's failure to report. `validatePhase` already refuses a
  // generation with no required artifact, and saying so twice in different words helps nobody.
  if (!(await exists(absolute))) return { ...EMPTY, markerMode, qualityMode: quality.mode };

  /**
   * The answers recorded for the generation being examined, loaded here rather than demanded of the
   * caller.
   *
   * `publishGeneration` has already verified this record and hands it in. Every other caller —
   * `spec analyze` above all — would have had to remember to load it, and the one that forgot would
   * report "0 answered" for a question that was answered ten seconds ago, then disagree with the
   * gate at the moment the author checked. Loading it here is what makes the two the same answer.
   */
  const pending = pendingClarification ?? await readClarificationRecord(root, definition, workflow, phase, generation);

  const markdown = await readFile(absolute, 'utf8');
  const report = analyzeSpecification(markdown, {
    artifactPath: artifactRelativePath,
    phase: phase.id,
    generation,
    policy: quality,
    namespace,
    previousMarkers: previousMarkers(phase, generation),
    answers: recordedMarkerAnswers(phase, pending)
  });

  // The analyzer has already extracted, reconciled and phrased the marker findings. Taking its
  // messages rather than re-deriving them through `evaluateMarkerPolicy` means a reader sees one
  // wording of a problem, and there is one place the marker rules live.
  const markerMessages = report.findings
    .filter((finding) => MARKER_FINDING_KINDS.includes(finding.kind))
    .map((finding) => finding.message);
  const markerErrors = markerMode === 'block' ? markerMessages : [];
  const markerWarnings = markerMode === 'warn' ? markerMessages : [];
  const qualityVerdict = evaluateSpecificationQuality(report, { exclude: MARKER_FINDING_KINDS });

  return {
    applies: true,
    markerMode,
    qualityMode: quality.mode,
    checklist: quality.checklist,
    report,
    open: report.markers.open,
    errors: [...markerErrors, ...qualityVerdict.errors],
    warnings: [...markerWarnings, ...qualityVerdict.warnings],
    // What the phase remembers, so the next generation can tell resolution from deletion.
    record: {
      generation,
      artifactPath: artifactRelativePath,
      artifactSha256: report.binding.artifactSha256,
      policySha256: report.binding.policySha256,
      markerMode,
      qualityMode: quality.mode,
      open: report.markers.open,
      findings: report.findings.length
    }
  };
}

/**
 * The reviewer's checklist, evaluated against one approval. `[SPK:REQ-060]` `[SPK:REQ-061]` `[SPK:REQ-181]`
 *
 * `validateChecklistDecisions` already answers "is every article decided, and is every exception
 * reasoned?" — pure, and rightly ignorant of who is asking. What it cannot answer is whether *this
 * identity* may take an exception, so that lives here, where the actor and the configured
 * authorities are both in hand.
 *
 * `CON-030` is the reason none of this can be defaulted or inferred. A model may summarize the
 * evidence for a reviewer, but the confirmation attributed to a human identity has to come from that
 * human — so an absent article is a refusal, never a `satisfied`.
 */
export function evaluateApprovalChecklist({
  policy, decisions = [], authorities = null, actor = null, checklist = STARTER_CHECKLIST
} = {}) {
  const resolved = specificationQualityPolicy(policy ?? {});
  if (resolved.mode === 'off') return { required: false, mode: 'off', errors: [], warnings: [], decisions: [] };

  const validated = validateChecklistDecisions(decisions, { checklist, mode: resolved.mode });
  const errors = [...validated.errors];
  const warnings = [...validated.warnings];

  if (resolved.exceptionAuthority) {
    const taken = decisions.filter((entry) => entry.decision && entry.decision !== 'satisfied');
    if (taken.length) {
      // `.authorized`, not truthiness: the matcher always returns an object, and a refusal is a
      // populated `{ authorized: false, reason }` rather than a null. Checking the object meant the
      // authority never gated anything — the same shape of miss this whole module exists to close.
      const matched = matchApprovalAuthority(authorities, { authorities: [resolved.exceptionAuthority] }, actor);
      if (!matched.authorized) {
        const message = `recording ${taken.length === 1 ? 'an exception' : 'exceptions'} on ${taken.map((entry) => `'${entry.article}'`).join(', ')} requires membership of the '${resolved.exceptionAuthority}' authority`;
        (resolved.mode === 'enforce' ? errors : warnings).push(message);
      }
    }
  }

  return {
    required: resolved.mode === 'enforce',
    mode: resolved.mode,
    checklist: checklist.id,
    checklistSha256: policyHash(resolved, checklist),
    errors,
    warnings,
    decisions: decisions.map((entry) => ({
      article: entry.article,
      decision: entry.decision,
      ...(entry.reason ? { reason: String(entry.reason).trim() } : {})
    }))
  };
}

/**
 * Exceptions recorded on earlier approvals of this phase. `[SPK:REQ-059]`
 *
 * A reviewer deciding whether to accept "no stated latency numbers" a second time should be able to
 * see that it was accepted once already, and why. An exception that silently repeats is how a
 * temporary allowance becomes the standard.
 */
export function priorChecklistExceptions(phase) {
  return (phase?.approvals ?? [])
    .filter((approval) => !approval.invalidatedAt && Array.isArray(approval.checklist))
    .flatMap((approval) => approval.checklist
      .filter((entry) => entry.decision && entry.decision !== 'satisfied')
      .map((entry) => ({
        article: entry.article,
        decision: entry.decision,
        reason: entry.reason ?? null,
        generation: approval.generation ?? null,
        actor: approval.actor?.login ?? approval.actor?.email ?? approval.actor?.name ?? null,
        at: approval.at ?? null
      })));
}

/**
 * The one-line account a status surface can show. `[SPK:REQ-065]`
 *
 * Warn mode has to be visible somewhere or it is indistinguishable from `off`, and a reviewer who
 * only learns about an open question at the approval screen has already read the artifact once
 * believing it settled.
 */
export function markerSummary(phase) {
  const latest = [...(phase?.markers ?? [])].sort((left, right) => left.generation - right.generation).at(-1);
  if (!latest?.open?.length) return null;
  return {
    generation: latest.generation,
    mode: latest.markerMode,
    count: latest.open.length,
    questions: latest.open.map((marker) => marker.question)
  };
}
