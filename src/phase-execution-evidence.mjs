/** Read-only execution facts for every phase; never a new receipt, verdict or waiver. */
import { createHash } from 'node:crypto';
import { canonicalJson } from './records.mjs';
import { readStoryReviewPacket } from './story-lineage.mjs';
import { sourceTreeHash, testInputTreeHash } from './state-stores.mjs';
import { commitIsAncestor, exactFileAtObject } from './git.mjs';
import { readRecord } from './schema-migrations.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';
import { testReceiptPassing } from './code-delivery-tests.mjs';
import { SingularityFlowError } from './util.mjs';

const digest = value => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const SHA = /^sha256:[a-f0-9]{64}$/u;
const LIMIT = 8;
const CHECK_LIMIT = 8;
export const MAX_EXECUTION_EVIDENCE_BYTES = 24 * 1024;

export const EXECUTION_EVIDENCE_INSTRUCTION = 'Use retainedExecutionEvidence for governed command outcomes, not earlier authored prose or IDE test discovery. An IDE "No tests found" is a separate discovery failure, not a failed governed run or a pass. Current source/test-input bindings must match before reusing results; command success alone proves neither every criterion nor visual acceptance. Reconcile contradictions explicitly in this draft, citing the packet, generation and source; preserve approved reports and decisions. If policy requires new execution or a prior-phase correction, follow the returned human/rework route, never relabel partial evidence as matched.';

function guidance(argv) {
  return safeCommandGuidance({ executable: 'singularity-flow', argv });
}

function reconciliation(workflow, phase) {
  if (!phase) return null;
  const targets = (phase.status === 'awaiting_approval' ? phase.approvalPolicy?.rejectTo ?? [] : [])
    .filter(id => workflow.phases?.[id]);
  return {
    approvedRecordsImmutable: true, automaticAcceptance: false,
    currentDraft: phase.status === 'in_progress' && (Number(phase.generation) === 0
      || phase.generationIntent?.status === 'open') ? guidance(['appeal', 'repair-plan', '--work-id', workflow.workItem.id,
      '--phase', phase.id, '--json']) : null,
    inspect: guidance(['phase', 'show', phase.id, '--json']),
    // Only the pinned human return targets are offered, never a fabricated backward route.
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
      binding, commandSuccessReusable: processPassed && binding === 'matched',
      criterionVerdict: 'not-established-by-command-success' };
  });
  return { phase: phase.id, generation: packet.generation, phaseStatus: phase.status,
    packetSha256: packet.packetSha256, evidenceCommit: packet.evidenceCommit,
    sourceCommit: packet.sourceCommit, sourceTreeSha256: packet.sourceTreeSha256,
    testInputSha256: packet.testInputSha256 ?? null, status: tests.length ? 'retained' : 'no-governed-tests-in-this-packet',
    checks, omittedChecks: Math.max(0, tests.length - checks.length) };
}

function executionDetails(root, packet, testPolicy) {
  return (packet.submissionEvidence?.testExecutions ?? []).slice(0, CHECK_LIMIT).map(reference => {
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
    return { commandId: receipt.commandId, path: reference.path, sha256: reference.sha256,
      status: receipt.status, adapter: receipt.adapter, counts: receipt.tests,
      assurance: receipt.assurance,
      meetsPinnedCountPolicy: testReceiptPassing(receipt, testPolicy?.minimumDiscovered ?? 1, testPolicy?.minimumPassed ?? 1)
        && receipt.tests?.skipped === 0,
      criterionVerdict: 'requires-bound-witness-evaluation' };
  });
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
        executions: executionDetails(root, packet, workflow.resolution?.codeDelivery?.tests) });
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
        assurance: execution.assurance } : { status: 'no-structured-result-in-packet', counts: null },
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
  const core = { revision: 'phase-execution-evidence-v1', workId: workflow?.workItem?.id ?? null,
    phase: phase?.id ?? null, readOnly: true, current, entries, diagnostics,
    omittedPackets,
    reconciliation: reconciliation(workflow, phase), instruction: EXECUTION_EVIDENCE_INSTRUCTION };
  return { ...core, projectionSha256: digest(core) };
}

/** Bounded, machine-derived facts; command/log strings never enter the model's instruction stream. */
export function renderExecutionEvidence(evidence) {
  if (!evidence) return '';
  return ['# Governed execution evidence', '', EXECUTION_EVIDENCE_INSTRUCTION, '',
    `Projection: ${evidence.projectionSha256}. Read-only facts; not publication, submission or human approval.`,
    'Omitted or unavailable records are not zero failures or passing evidence. Inspect the linked immutable packet if more detail is needed.',
    '', '```json', JSON.stringify({ current: evidence.current, entries: evidence.entries,
      diagnostics: evidence.diagnostics, omittedPackets: evidence.omittedPackets }), '```',
    '', 'Correction routes (subject to their normal lifecycle and human authority checks):',
    ...(evidence.reconciliation?.omittedHumanReturns ? [`Additional pinned return targets: ${evidence.reconciliation.omittedHumanReturns}; use the inspection route before deciding.`] : []),
    ...[evidence.reconciliation?.currentDraft, evidence.reconciliation?.inspect,
      ...(evidence.reconciliation?.humanReturns ?? []).map(entry => entry.commandGuidance)]
      .filter(Boolean).map(route => `- Copilot: ${route.copilotCommand ?? 'no verified equivalent'}; Shell: ${route.command}; VS Code: ${route.modelFreeCommand ?? 'not available for this action'}`)
  ].join('\n');
}

/** Refresh delivered facts while preserving an already composed generation's canonical bytes. */
export function withExecutionEvidenceRefresh(text, record, evidence) {
  if (record?.promptBudget?.executionEvidence?.projectionSha256 === evidence.projectionSha256) return text;
  return `${text.trimEnd()}\n\n# Current execution-evidence refresh\n\nThis read-only projection supersedes earlier execution observations only; the retained prompt, artifacts and approvals remain unchanged.\n\n${renderExecutionEvidence(evidence)}\n`;
}
