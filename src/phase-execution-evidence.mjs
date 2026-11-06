/** Read-only execution facts for every phase; never a new receipt, verdict or waiver. */
import { createHash } from 'node:crypto';
import { canonicalJson } from './records.mjs';
import { readStoryReviewPacket } from './story-lineage.mjs';
import { sourceTreeHash, testInputTreeHash } from './state-stores.mjs';
import { commitIsAncestor, exactFileAtObject } from './git.mjs';
import { readRecord } from './schema-migrations.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';
import { formatCommandRouteLines } from './model-free-commands.mjs';
import { attemptLocalIntegrationLabel, testReceiptPassing } from './code-delivery-tests.mjs';
import { SingularityFlowError } from './util.mjs';
import { phaseCorrectionTargets } from './phase-finding-policy.mjs';

const digest = value => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const SHA = /^sha256:[a-f0-9]{64}$/u;
const LIMIT = 8;
const CHECK_LIMIT = 8;
export const MAX_EXECUTION_EVIDENCE_BYTES = 24 * 1024;

export const EXECUTION_EVIDENCE_INSTRUCTION = 'Use retainedExecutionEvidence for governed command outcomes, not earlier authored prose or IDE test discovery. An IDE "No tests found" is a separate discovery failure, not a failed governed run or a pass. Current source/test-input bindings must match before reusing results; a check whose `testResult.reused` is set is that run on this same source tree, not run again because the code did not change, so cite its attempt ID and counts as you would a fresh run: no fresh run is missing. Command success alone proves neither every criterion nor visual acceptance. Reconcile contradictions explicitly in this draft, citing the packet, generation and source; preserve approved reports and decisions. If policy requires new execution or a prior-phase correction, follow the returned human/rework route, never relabel partial evidence as matched.';

function guidance(argv) {
  return safeCommandGuidance({ executable: 'singularity-flow', argv });
}

function reconciliation(workflow, phase) {
  if (!phase) return null;
  const targets = (phase.status === 'awaiting_approval' ? phaseCorrectionTargets(phase) : [])
    .filter(id => workflow.phases?.[id]);
  return {
    approvedRecordsImmutable: true, automaticAcceptance: false,
    currentDraft: phase.status === 'in_progress' && (Number(phase.generation) === 0
      || phase.generationIntent?.status === 'open') ? guidance(['appeal', 'repair-plan', '--work-id', workflow.workItem.id,
      '--phase', phase.id, '--json']) : null,
    inspect: guidance(['phase', 'show', phase.id, '--json']),
    // Same-phase technical correction plus pinned business return targets; never a new backward route.
    omittedHumanReturns: Math.max(0, targets.length - LIMIT),
    humanReturns: targets.slice(0, LIMIT)
      .map(id => ({ targetPhase: id, commandGuidance: guidance(['reject', phase.id, '--work-id',
        workflow.workItem.id, '--to', id, '--reason', '<reason>', '--fetch']) }))
  };
}

/** Project a hash-verified packet's outcomes; never credit arbitrary live workflow.checks. */
export function projectExecutionPacket(packet, phase, current, { checkLimit = CHECK_LIMIT, epochVerified = false } = {}) {
  const tests = (packet.checks ?? []).filter(check => check?.kind === 'test');
  const policyCurrent = canonicalJson(packet.checks ?? []) === canonicalJson(phase.checks ?? [])
    && (!phase.testCommandRevalidation || epochVerified);
  const checks = tests.slice(0, checkLimit).map(check => {
    const sourceBound = SHA.test(check.sourceTreeSha256 ?? '')
      && check.sourceTreeSha256 === packet.sourceTreeSha256
      && current.ancestor(check.sourceCommit, packet.evidenceCommit);
    const testInputsBound = (check.testInputSha256 ?? null) === (packet.testInputSha256 ?? null);
    const binding = !sourceBound || !testInputsBound ? 'unbound'
      : !policyCurrent ? 'superseded'
      : current.status !== 'available' ? 'unavailable'
        : check.sourceTreeSha256 !== current.sourceTreeSha256
          || (packet.testInputSha256 ?? null) !== current.testInputSha256 ? 'stale' : 'matched';
    const processPassed = check.status === 'passed' && check.exitCode === 0 && !check.signal
      && !check.timedOut && !check.infrastructureUnavailable;
    return { commandId: check.id, workingDirectory: check.workingDirectory ?? '.',
      outcome: processPassed ? 'passed' : check.status === 'passed' ? 'invalid' : check.status ?? 'unavailable',
      exitCode: check.exitCode ?? null, sourceCommit: check.sourceCommit ?? null,
      sourceTreeSha256: check.sourceTreeSha256 ?? null, testInputSha256: check.testInputSha256 ?? null,
      ...(check.testRuntime ? { recordedRuntimeSha256: check.testRuntime.sha256 ?? null } : {}),
      startedAt: check.startedAt ?? null, completedAt: check.completedAt ?? null,
      ...(check.reusedFrom ? { reusedFrom: { attemptId: check.reusedFrom.attemptId, phase: check.reusedFrom.phase, generation: check.reusedFrom.generation ?? null,
        commit: check.reusedFrom.commit ?? null } } : {}),
      binding, commandSuccessReusable: processPassed && binding === 'matched',
      criterionVerdict: 'not-established-by-command-success' };
  });
  return { phase: phase.id, generation: packet.generation, phaseStatus: phase.status,
    packetSha256: packet.packetSha256, evidenceCommit: packet.evidenceCommit,
    sourceCommit: packet.sourceCommit, sourceTreeSha256: packet.sourceTreeSha256,
    testInputSha256: packet.testInputSha256 ?? null, status: tests.length ? 'retained' : 'no-governed-tests-in-this-packet',
    checks, omittedChecks: Math.max(0, tests.length - checks.length) };
}

/**
 * A run a document step reused rather than ran again [TCE:REQ-080]: read from its own record at this
 * packet's commit, so the counts and the binding are the run's, never a copy of a claim. It keeps its
 * evidence only when that record is the same run on this same source tree; on anything less it is
 * left out, and the check reads as having no structured result.
 */
export function reusedExecutionDetails(root, packet, testPolicy, itemRelative, listed = []) {
  return (packet.checks ?? []).filter(check => check?.kind === 'test' && check.reusedFrom?.attemptId && !listed.includes(check.id)).slice(0, CHECK_LIMIT).flatMap(check => {
    const source = check.reusedFrom;
    const relative = source.receiptPath ?? `${itemRelative}/context/code-delivery/tests/attempts/${source.phase}/${source.attemptId}.json`;
    let bytes = null;
    try { bytes = exactFileAtObject(root, packet.evidenceCommit, relative, { regularOnly: true, maximumBytes: 8 * 1024 * 1024 }); } catch { return []; }
    if (!bytes) return [];
    let receipt;
    let sha256;
    // A receipt's digest is over its canonical form (attemptSha256), as the code step's own reference holds it.
    try {
      const value = JSON.parse(bytes.toString('utf8'));
      sha256 = createHash('sha256').update(canonicalJson(value)).digest('hex');
      receipt = readRecord('test-execution', value).record;
    } catch { return []; }
    if (receipt.attemptId !== source.attemptId || receipt.workId !== packet.workId || receipt.status !== 'passed' || receipt.exitCode !== 0
        || receipt.candidate?.treeSha256 !== check.sourceTreeSha256 || check.sourceTreeSha256 !== packet.sourceTreeSha256
        || (receipt.candidate?.testInputSha256 ?? null) !== (check.testInputSha256 ?? null)
        || (source.receiptSha256 && source.receiptSha256 !== sha256)) return [];
    return [{ attemptId: receipt.attemptId, commandId: check.id, path: relative, sha256, status: receipt.status, adapter: receipt.adapter, counts: receipt.tests,
      assurance: receipt.assurance, reused: { recordedBy: receipt.phase, generation: receipt.generation, commit: receipt.candidate.commit, treeSha256: receipt.candidate.treeSha256 },
      meetsPinnedCountPolicy: testReceiptPassing(receipt, testPolicy?.minimumDiscovered ?? 1, testPolicy?.minimumPassed ?? 1) && receipt.tests?.skipped === 0,
      criterionVerdict: 'requires-bound-witness-evaluation' }];
  });
}

function executionDetails(root, packet, testPolicy, itemRelative) {
  const references = packet.submissionEvidence?.testExecutions ?? [];
  return [...references.slice(0, CHECK_LIMIT).map(reference => {
    // readStoryReviewPacket already verified these exact immutable bytes and their bound digests.
    // Read at evidenceCommit, never the mutable result path or an IDE's cached report.
    if (reference.kind === 'phase-validation-observation') return {
      commandId: reference.commandId, path: reference.path, sha256: reference.sha256,
      status: reference.status, assurance: 'risk-observation-not-a-passing-test' };
    const bytes = exactFileAtObject(root, packet.evidenceCommit, reference.path,
      { regularOnly: true, maximumBytes: 8 * 1024 * 1024 });
    const receipt = readRecord('test-execution', JSON.parse(bytes.toString('utf8'))).record;
    const matchingChecks = (packet.checks ?? []).filter(check => check.id === reference.commandId && check.kind === 'test');
    const check = matchingChecks[0];
    if (receipt.workId !== packet.workId || receipt.phase !== packet.phase
        || Number(receipt.generation) !== Number(packet.generation)
        || receipt.commandId !== reference.commandId || receipt.status !== reference.status
        || matchingChecks.length !== 1 || receipt.candidate?.commit !== check.sourceCommit
        || receipt.candidate?.treeSha256 !== check.sourceTreeSha256
        || (receipt.candidate?.testInputSha256 ?? null) !== (check.testInputSha256 ?? null)
        || receipt.process?.status !== check.status || receipt.process?.exitCode !== check.exitCode) {
      throw new SingularityFlowError('Retained execution identity differs.', { code: 'STORY_REVIEW_EVIDENCE_INVALID' });
    }
    return { attemptId: receipt.attemptId, commandId: receipt.commandId, path: reference.path, sha256: reference.sha256,
      status: receipt.status, adapter: receipt.adapter, counts: receipt.tests,
      assurance: receipt.assurance,
      ...(receipt.evidenceClass === 'local-integration' ? {
        evidenceClass: receipt.evidenceClass, environment: receipt.boundEnvironment?.name ?? null,
        ranBy: receipt.ranBy ?? null, label: attemptLocalIntegrationLabel(receipt)
      } : {}),
      meetsPinnedCountPolicy: testReceiptPassing(receipt, testPolicy?.minimumDiscovered ?? 1, testPolicy?.minimumPassed ?? 1)
        && receipt.tests?.skipped === 0,
      criterionVerdict: 'requires-bound-witness-evaluation' };
  }), ...reusedExecutionDetails(root, packet, testPolicy, itemRelative, references.map(reference => reference.commandId))];
}

/**
 * Runs an earlier step recorded that a person who approves a step up to this one decided to reuse
 * for it (`decision evidence-reuse`), each labelled with who recorded it and who reused it, and
 * whether its source binding still holds now. Empty, with nothing read, when there is none.
 */
async function reusedEvidence(root, definition, workflow, eligible, phase, current, diagnostics) {
  if (!phase?.id || !(workflow?.evidenceReuses ?? []).some(entry => !entry.revokes && eligible.has(entry.phase))) return [];
  try {
    const { activeEvidenceReuse, observeEvidenceReuseSource } = await import('./evidence-reuse.mjs');
    const observed = await observeEvidenceReuseSource(root, definition, workflow, current.status === 'available'
      ? { sourceTreeSha256: current.sourceTreeSha256, testInputSha256: current.testInputSha256 } : {});
    const reuse = activeEvidenceReuse(workflow, phase.id, { at: new Date().toISOString(), observed, through: true });
    return [...reuse.active, ...reuse.lapsed].slice(0, LIMIT);
  } catch (error) {
    diagnostics.push({ phase: phase.id, code: error.code ?? 'EVIDENCE_REUSE_UNAVAILABLE', status: 'unavailable' });
    return [];
  }
}

/** Compact phase-agnostic projection, derived solely from this Story's latest retained generations. */
export async function phaseExecutionEvidence(root, definition, workflow, phase) {
  const order = workflow?.phaseOrder ?? [];
  const position = order.indexOf(phase?.id);
  const eligible = new Set(position < 0 ? [] : order.slice(0, position + 1));
  const candidates = order.filter(id => eligible.has(id) && workflow.phases?.[id]?.status !== 'skipped')
    .map(id => ({ phase: workflow.phases[id], entry: [...(workflow.lineage?.submissions ?? [])].reverse()
      .find(entry => entry.phase === id && Number(entry.generation) === Number(workflow.phases[id].generation)) }))
    .filter(({ entry }) => entry);
  // Keep test producers ahead of unrelated no-test packets: a long custom workflow must not
  // forget the tested delivery merely because eight later document-only phases intervened.
  // Live checks select relevant packets only; their outcomes still require immutable replay.
  const priority = candidate => candidate.phase.checks?.some(check => check.kind === 'test')
    || candidate.phase.deliveryEvidence?.testExecutions?.length ? 1 : 0;
  const selected = [...candidates].sort((left, right) => priority(right) - priority(left)
    || order.indexOf(right.phase.id) - order.indexOf(left.phase.id)).slice(0, LIMIT)
    .sort((left, right) => order.indexOf(left.phase.id) - order.indexOf(right.phase.id));
  let current = { status: 'not-needed', sourceTreeSha256: null, testInputSha256: null };
  const packets = [];
  const diagnostics = [];
  for (const candidate of selected) {
    try {
      const packet = await readStoryReviewPacket(root, definition, workflow, candidate.entry.packetSha256);
      if (packet.workId !== workflow.workItem.id || packet.phase !== candidate.phase.id
          || Number(packet.generation) !== Number(candidate.phase.generation)) {
        throw new SingularityFlowError('Foreign packet.', { code: 'STORY_REVIEW_EVIDENCE_INVALID' });
      }
      let epochVerified = false;
      if (candidate.phase.testCommandRevalidation) {
        try {
          const { verifyTestCommandEpochValidation } = await import('./test-command-epoch.mjs');
          epochVerified = (await verifyTestCommandEpochValidation(root, definition, workflow,
            candidate.phase, { packet }))?.status === 'passed';
        } catch (error) { diagnostics.push({ phase: candidate.phase.id,
          code: error.code ?? 'TCA_EPOCH_VALIDATION_REQUIRED', status: 'unavailable' }); }
      }
      packets.push({ ...candidate, packet, epochVerified,
        executions: executionDetails(root, packet, workflow.resolution?.codeDelivery?.tests, `${definition.workItemRoot ?? 'singularity/work-items'}/${workflow.workItem.id}`) });
    } catch (error) {
      // A missing/shallow history is evidence unavailable, never a new gate on draft repair.
      diagnostics.push({ phase: candidate.phase.id, generation: candidate.entry.generation,
        code: error.code ?? 'RETAINED_EXECUTION_EVIDENCE_UNAVAILABLE', status: 'unavailable' });
    }
  }
  if (packets.some(({ packet }) => packet.checks?.some(check => check.kind === 'test'))) {
    try { current = { status: 'available', sourceTreeSha256: await sourceTreeHash(root, definition, workflow),
      testInputSha256: await testInputTreeHash(root, definition, workflow) }; }
    catch (error) { current.status = 'unavailable'; diagnostics.push({
      phase: phase.id, code: error.code ?? 'CURRENT_EXECUTION_BINDING_UNAVAILABLE', status: 'unavailable' }); }
  }
  const entries = packets.map(({ phase: producer, entry, packet, epochVerified, executions }) => {
    const projected = projectExecutionPacket(packet, producer, { ...current,
      ancestor: (commit, evidenceCommit) => Boolean(commit && commitIsAncestor(root, commit, evidenceCommit)) }, { epochVerified });
    return { ...projected, checks: projected.checks.map(check => {
      const execution = executions.find(record => record.commandId === check.commandId);
      return { ...check, testResult: execution ? { status: execution.status, counts: execution.counts ?? null,
        assurance: execution.assurance, ...(execution.reused ? { reused: execution.reused } : {}) } : { status: 'no-structured-result-in-packet', counts: null },
        structuredTestsReusable: check.commandSuccessReusable && execution?.meetsPinnedCountPolicy === true };
    }), path: entry.path, executions,
      omittedExecutions: Math.max(0, (packet.submissionEvidence?.testExecutions?.length ?? 0) - executions.length) };
  });
  let omittedPackets = Math.max(0, candidates.length - selected.length);
  // Never arbitrarily slice control text or a JSON record. Omit complete older packet projections,
  // with an explicit count, so this shared handoff cannot crowd the authoring contract out.
  while (entries.length && Buffer.byteLength(JSON.stringify({ current, entries, diagnostics })) > MAX_EXECUTION_EVIDENCE_BYTES) {
    entries.shift(); omittedPackets += 1;
  }
  const reusedTestEvidence = await reusedEvidence(root, definition, workflow, eligible, phase, current, diagnostics);
  const core = { revision: 'phase-execution-evidence-v1', workId: workflow?.workItem?.id ?? null,
    phase: phase?.id ?? null, readOnly: true, current, entries, diagnostics,
    omittedPackets, ...(reusedTestEvidence.length ? { reusedTestEvidence } : {}),
    reconciliation: reconciliation(workflow, phase), instruction: EXECUTION_EVIDENCE_INSTRUCTION };
  return { ...core, projectionSha256: digest(core) };
}

/** Bounded, machine-derived facts; command/log strings never enter the model's instruction stream. */
export function renderExecutionEvidence(evidence) {
  if (!evidence) return '';
  // An approved step that retained no governed tests has no results to reuse: name it in one line
  // with its packet path, which carries the packet digest a release evidence index cites. Its commits
  // and tree hash stay in the read model and the composition record.
  const untested = (evidence.entries ?? []).filter(entry => !entry.checks?.length && !entry.executions?.length);
  const tested = (evidence.entries ?? []).filter(entry => !untested.includes(entry));
  const facts = tested.length || evidence.diagnostics?.length || evidence.omittedPackets;
  return ['# Governed execution evidence', '', EXECUTION_EVIDENCE_INSTRUCTION, '',
    `Projection: ${evidence.projectionSha256}. Read-only facts; not publication, submission or human approval.`,
    'Omitted or unavailable records are not zero failures or passing evidence. Inspect the linked immutable packet if more detail is needed.',
    ...(untested.length ? ['', `Retained no test results: ${untested.map(entry => `${entry.phase} generation ${entry.generation}${entry.path ? ` (\`${entry.path}\`)` : ''}`).join(', ')}.`] : []),
    // Reused runs are cited by their labels in the evidence-consistency section only, so the prompt
    // states each label once; the read model keeps them in reusedTestEvidence.
    ...(facts ? ['', '```json', JSON.stringify({ current: evidence.current, entries: tested,
      diagnostics: evidence.diagnostics, omittedPackets: evidence.omittedPackets }), '```']
      : untested.length ? [] : ['', 'No earlier step retained test results.']),
    '', 'Correction routes (subject to their normal lifecycle and human authority checks):',
    ...(evidence.reconciliation?.omittedHumanReturns ? [`Additional pinned return targets: ${evidence.reconciliation.omittedHumanReturns}; use the inspection route before deciding.`] : []),
    ...[evidence.reconciliation?.currentDraft, evidence.reconciliation?.inspect,
      ...(evidence.reconciliation?.humanReturns ?? []).map(entry => entry.commandGuidance)]
      .filter(Boolean).flatMap(route => [...formatCommandRouteLines(route, { markdown: true }), ''])
  ].join('\n');
}

/** Refresh delivered facts while preserving an already composed generation's canonical bytes. */
export function withExecutionEvidenceRefresh(text, record, evidence) {
  if (record?.promptBudget?.executionEvidence?.projectionSha256 === evidence.projectionSha256) return text;
  return `${text.trimEnd()}\n\n# Current execution-evidence refresh\n\nThis read-only projection supersedes earlier execution observations only; the retained prompt, artifacts and approvals remain unchanged.\n\n${renderExecutionEvidence(evidence)}\n`;
}
