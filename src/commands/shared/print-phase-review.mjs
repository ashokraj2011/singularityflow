/** Extracted command implementation; governance remains in the existing kernel APIs. */
import * as style from '../../style.mjs';
import { approvalCheckLines, blockingCommitLines, owedDecisionLines } from '../../owed-decisions.mjs';
import { printCommandRoutes } from './print-command-routes.mjs';
import { witnessNames } from '../../wel-review.mjs';

/**
 * Report the artifacts a phase produced.
 *
 * The full body used to be printed unconditionally, and `viewDocument` allows a megabyte, so one
 * `submit` ran to several hundred lines of which about twenty-five were the result — the commit SHA
 * and the next step at opposite ends of the wall. The default is now the inventory: what was
 * produced, where it is, and how to read it. `--show-artifact` prints the bodies.
 *
 * Only the terminal is affected. `--json` never reached this function.
 */
export function printPhaseReview(review, { showArtifact = false } = {}) {
  console.log(`\n${style.heading('Generated documents ready for review')} ${style.detail(style.fields(review.workId, review.phase, `generation ${review.generation}`))}`);
  // The step's route, not a record of who produced this generation: that is its authorship. The
  // automatic route is what every step that names no skill drafts on, so repeating it on every
  // submit, approve and review says nothing; it is printed only with the warning that a configured
  // choice was ignored. `--json` keeps every route field.
  if (review.policyVerified === false) console.log(`Drafting route withheld: ${review.policyReason}`);
  else if (review.effectiveAuthoringSkill
      && (review.authoringSkillSource !== 'automatic' || review.authoringSkillWarning)) {
    console.log(`Drafting skill: ${review.effectiveAuthoringSkill} (${review.authoringSkillSource})`);
    if (review.authoringSkillWarning) console.log(`  ${review.authoringSkillWarning}`);
  }
  if (review.testEvidence) {
    console.log(`Test evidence: ${review.testEvidence.status} · ${review.testEvidence.executions} module execution(s) · ${review.testEvidence.attempts} attempt(s)`);
    console.log(`  ${review.testEvidence.notice}`);
    for (const risk of review.testEvidence.acceptedRisks ?? []) console.warn(`  Accepted risk: ${risk.words}`);
    if (review.testEvidence.assertionCheck) (review.testEvidence.assertionCheck.status === 'satisfied' ? console.log : console.warn)(`  ${review.testEvidence.assertionCheck.words}`);
    for (const narrowing of review.testEvidence.acceptedNarrowings ?? []) console.warn(`  Accepted narrowing: ${narrowing.words}`);
    if (review.testEvidence.acceptance) {
      console.log(`Acceptance evidence: ${review.testEvidence.acceptance.statement}`);
      for (const criterion of review.testEvidence.acceptance.criteria) {
        console.log(`  ${criterion.clauseId} ${criterion.status}${criterion.status === 'met' ? ` (${criterion.assurance})` : ''}`);
        for (const witness of criterion.witnesses) console.log(`    - ${witness.words}`);
      }
      for (const proof of review.testEvidence.acceptance.proof ?? []) (proof.tests && !proof.silent ? console.log : console.warn)(`  ${proof.words}`);
      for (const tag of review.testEvidence.acceptance.unattachedTags) {
        console.warn(`  The tag for ${tag.clauseIds.join(', ')} at ${tag.testSource}${tag.line ? `:${tag.line}` : ''} is not on a test, so it binds nothing.`);
      }
      if (review.testEvidence.acceptance.skippedTests > 0) {
        console.warn(`  ${review.testEvidence.acceptance.skippedTests} test(s) were skipped; a skipped test verifies nothing.`);
      }
    }
  }
  if (review.testScope) console.warn(review.testScope.words);
  // What the scanners recorded and the required checks' results: evidence for the reviewer [CQF:REQ-055].
  if (review.qualityFindings?.words) console.log(`Findings: ${review.qualityFindings.words}`);
  if (review.requiredChecks?.words) console.log(review.requiredChecks.words);
  for (const run of [...(review.stepTestRuns ?? []), ...(review.reusedTestRuns ?? [])]) console.log(`Test run ${run.words}.`);
  for (const entry of review.flakyTestRuns ?? []) console.warn(`Flaky: ${entry.words}. It refuses nothing.`);
  // Changed-line coverage, a line per file and per clause, or that it was not measured [CQF:REQ-031, REQ-034].
  const coverage = review.changedLineCoverage;
  if (coverage) (coverage.status !== 'measured' || coverage.below ? console.warn : console.log)([coverage.words, ...(coverage.lines ?? []).map((line) => `  ${line}`)].join('\n'));
  for (const entry of review.reusedTestEvidence ?? []) {
    if (entry.state === 'active') console.log(`Reused test evidence: ${entry.label}`);
    else console.warn(`Reused test evidence lapsed: ${entry.label}`);
  }
  // A person reads what was found, never a digest (owner, 2026-11-11); `--json` keeps each one.
  if (review.evidenceConsistency) {
    console.log(`\n${style.heading('Evidence consistency')}`);
    for (const line of review.evidenceConsistency.summary) console.log(`  ${line}`);
  }
  if (review.attributionLabels?.length) {
    console.log(`\n${style.heading('SF Guard labels')} ${style.detail('who wrote the changed lines, as recorded; a label decides nothing')}`);
    for (const line of review.attributionLabels) console.log(`  ${line}`);
  }
  // Each witness by the name approve takes (wel-review.mjs witnessNames): its criterion, numbered among several.
  const witnessName = witnessNames(review.witnessReview?.mappings);
  for (const mapping of review.witnessReview?.mappings ?? []) {
    const safe = (value) => String(value ?? 'unavailable')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '�');
    const name = witnessName.get(mapping.mappingSha256) ?? mapping.clauseId;
    console.log(`\n  Witness ${safe(name)} (accepted as adequate on approval unless decided with --witness-mapping ${safe(name)}=...)`);
    console.log(`    Clause: ${safe(mapping.clauseId)} · ${safe(mapping.clauseStatus)}`);
    console.log(`    Test: ${safe(mapping.test ?? mapping.sourcePath)}${mapping.slot ? ` · slot ${safe(mapping.slot)}` : ''}`);
    console.log(`    Behavior: ${safe(mapping.clauseFields?.behavior)}`);
    console.log(`    Observable: ${safe(mapping.clauseFields?.observable)}`);
    console.log(`    Exact clause:\n${safe(mapping.clauseText).split('\n').map((line) => `      ${line}`).join('\n')}`);
  }
  owedDecisionLines(review.owedDecisions).forEach((line) => console.log(line));
  approvalCheckLines(review.approvalCheck).forEach((line) => console.warn(line));
  blockingCommitLines(review.blockingCommits).forEach((line) => console.warn(line));
  if (!review.documents.length) {
    console.log('No generated documents are registered for this phase.');
    return;
  }
  for (const [index, document] of review.documents.entries()) {
    console.log(`\n${style.bold(`[${index + 1}] ${document.label}`)} ${style.detail(`(${document.id})`)}`);
    console.log(`  ${document.path}`);
    console.log(`  ${style.detail(style.fields(
      document.kind ?? 'artifact',
      document.mimeType ?? 'unknown',
      `${document.size ?? 'unknown'} bytes`
    ))}`);
    if (document.error) console.warn(`  Warning: document preview unavailable: ${document.error}`);
    else if (document.binary) console.log(`  Binary document: open ${document.absolutePath}`);
    else if (document.display?.mode === 'reference-preview') {
      console.log(`  ${style.detail(`Reference: ${document.display.reference}`)}`);
      if (showArtifact) {
        const body = document.display.full ?? document.display.preview;
        const truncated = document.display.full == null && document.display.truncated;
        console.log(`\n${body}${truncated ? `\n… preview truncated at policy limit; use the sfref handle for the full document (maximum inline bytes ${document.display.fullDocumentMaximumBytes}) …` : ''}`);
      }
    }
    else if (document.content != null && showArtifact) {
      console.log(`\n--- BEGIN ${document.path} ---`);
      process.stdout.write(document.content.endsWith('\n') ? document.content : `${document.content}\n`);
      console.log(`--- END ${document.path} ---`);
    }
  }
  if (review.upstreamDiscrepancies?.length) {
    console.log(`\n${style.heading('Upstream discrepancies')} ${style.detail(`${review.upstreamDiscrepancies.length} recorded; each needs its producer phase to return, amend or accept the risk`)}`);
    // Items are kept whole; the review shows each one's start (the artifact holds all of it).
    for (const item of review.upstreamDiscrepancies) {
      const text = item.text.length > 300 ? `${item.text.slice(0, 299)}…` : item.text;
      console.log(`  - ${item.phase ? `${item.phase}: ` : '(no single earlier owning step named) '}${text.replace(/\s*\n\s*/gu, ' ')}`);
    }
    console.log(`  File them for their owners: singularity-flow upstream-issue raise --from-artifact`);
  }
  if (review.upstreamIssues?.length) {
    console.log(`\n${style.heading('Open upstream issues')} ${style.detail(`${review.upstreamIssues.length} waiting for an earlier step's approvers; the Story completes only when each is decided`)}`);
    for (const item of review.upstreamIssues) console.log(`  - ${item.id} ${item.phase} (${item.about}): ${item.problem}${item.supersededBy ? ` [superseded by ${item.supersededBy}]` : ''}\n    ${item.decide}`);
  }
  const readable = review.documents.filter((document) => !document.error && !document.binary && document.content != null);
  const viewRoute = review.handoff?.find((entry) => entry.optional && entry.skill === '/sf-phase-documents');
  if (viewRoute && !showArtifact) {
    console.log('');
    printCommandRoutes(viewRoute, { label: style.action('View phase documents before submitting') });
    if (readable.length) console.log(style.detail(`Add --show-artifact to print ${readable.length === 1 ? 'the document' : `all ${readable.length} documents`} here instead.`));
  } else if (readable.length && !showArtifact) {
    console.log('');
    printCommandRoutes(`singularity-flow documents view <id> --work-id ${review.workId}`, { label: style.action('Read them') });
  }
}
