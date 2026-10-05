/** Read-only cohort planning and exact, human-reviewed scope confirmation. Never runs tests. */
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { captureTerminalActionAuthorization } from '../action-authorization.mjs';
import { requireApprovalAuthority } from '../approval-authority.mjs';
import { evaluateCodeDeliveryPreflight, phaseRequiresCodeDelivery, resolveDeliveryQualityCommands } from '../delivery-evidence.mjs';
import { head, identity, repoRoot } from '../git.mjs';
import { commandResult, effects, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { StoryStateStore, sourceTreeHash, storyPublicationPending, workDir } from '../state-stores.mjs';
import { sealTrpRecord } from '../test-recovery-policy.mjs';
import { appendTrpAuthorityReceipt, appendTrpRecord, consumeTrpAuthority, trpAuthorityReview } from '../test-recovery-store.mjs';
import { loadTrpDeliveryAgreement, resolveTrpDeliverySelection, trpSelectionAuthorityContext,
  trpSelectionPublicPreview } from '../trp-delivery-selection.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';
import { verifyWorkflowSnapshot } from '../workflow-snapshots.mjs';

const fail = (message, code, details = {}) => { throw new SingularityFlowError(message, { code, details }); };
const reference = ({ kind, id, recordSha256 }) => ({ kind, id, recordSha256 });
const legalRecovery = (workId) => ({ id: 'inspect-publication', label: 'Inspect the pending Story publication',
  command: 'recover', args: [workId, '--json'] });

function selectedPhase(workflow, phaseId) {
  const selected = phaseId ?? workflow.currentPhase;
  const phase = workflow.phases?.[selected];
  if (!phase || selected !== workflow.currentPhase) fail('Select the current Story phase for a test-selection plan.', 'TRP_SELECTION_PHASE_INVALID');
  if (!phaseRequiresCodeDelivery(phase)) fail('This selection pilot supports code-delivery phases only.', 'TRP_SELECTION_PHASE_UNSUPPORTED');
  return phase;
}

async function resolvePlan(root, config, workflow, { phaseId = null, confirmation = null, createdAt } = {}) {
  const snapshot = await verifyWorkflowSnapshot(root, config, workflow, { requireAccepted: true });
  if (!snapshot.enrolled) fail('Test selection requires an accepted Story workflow snapshot.', 'TRP_SELECTION_SNAPSHOT_REQUIRED');
  const agreement = await loadTrpDeliveryAgreement(root, config, workflow);
  if (!agreement) fail('This Story has no pinned Test and Recovery Agreement.', 'TRP_NOT_ENABLED');
  const phase = selectedPhase(workflow, phaseId);
  let evidence;
  // An unchanged published generation retains its generation number. A new candidate uses
  // ordinary delivery preflight, including its existing source/test/specification checks.
  const published = phase.deliveryEvidence;
  if (published && Number(published.generation) === Number(phase.generation)
    && published.sourceTreeSha256 === await sourceTreeHash(root, config, workflow)
    && phase.generationIntent?.status !== 'open') evidence = published;
  else evidence = await evaluateCodeDeliveryPreflight(root, config, workflow, phase);
  const commands = await resolveDeliveryQualityCommands(root, { ...phase, deliveryEvidence: evidence },
    { executionMode: workflow.resolution?.testExecutionMode });
  const selection = await resolveTrpDeliverySelection(root, config, workflow, phase, evidence, commands,
    { previewOnly: true, confirmation, ...(createdAt ? { createdAt } : {}) });
  if (!selection.preview) fail('No structured test commands are available for this phase.', 'TRP_TEST_SELECTION_COMMAND_REQUIRED');
  return { agreement, phase, ...selection };
}

/** No quality/dependency commands are executed, files written, or state advanced by this preview. */
export async function planStoryTestSelection(root, config, workflow, { phaseId = null } = {}) {
  const resolved = await resolvePlan(root, config, workflow, { phaseId });
  const pending = await storyPublicationPending(root, config, workflow.workItem.id, { migrate: false });
  return { schemaVersion: 1, resultType: 'story-test-selection-plan', workId: workflow.workItem.id,
    status: pending ? 'publication-pending' : resolved.preview.ready ? 'ready' : 'blocked',
    phaseId: resolved.phase.id, planDigest: resolved.preview.planDigest,
    preview: trpSelectionPublicPreview(resolved.preview), selection: resolved.selection,
    observedOutcome: 'not-run', executed: false, pending: pending ?? null,
    legalActions: pending ? [legalRecovery(workflow.workItem.id)] : resolved.preview.requiredConfirmation.length ? [{
      id: 'confirm-test-selection', label: 'Review this exact expansion in a direct terminal', command: 'story',
      args: ['test-policy', 'confirm', '--work-id', workflow.workItem.id, '--phase', resolved.phase.id,
        '--confirm', resolved.preview.planDigest]
    }] : [] };
}

/** A supplied digest selects the card. Only live terminal presentation can authorize it. */
export async function confirmStoryTestSelection(root, config, workflow, { phaseId = null, confirmation = null } = {}) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(confirmation ?? '')) fail('First inspect the plan, then select its exact --confirm digest.', 'TRP_TEST_SELECTION_CONFIRMATION_REQUIRED');
  const pending = await storyPublicationPending(root, config, workflow.workItem.id, { migrate: false });
  if (pending) fail('Recover the exact pending Story publication before confirming another selection.',
    'TRP_PUBLICATION_PENDING', { pending, legalActions: [legalRecovery(workflow.workItem.id)] });
  const initialHead = head(root);
  const resolved = await resolvePlan(root, config, workflow, { phaseId, confirmation });
  if (resolved.preview.planDigest !== confirmation) fail('The test-selection plan changed. Review the new exact plan.',
    'TRP_TEST_SELECTION_CONFIRMATION_STALE', { preview: trpSelectionPublicPreview(resolved.preview) });
  if (!resolved.preview.ready) fail('Resolve the plan blockers before confirming its scope.',
    'TRP_TEST_SELECTION_BLOCKED', { preview: trpSelectionPublicPreview(resolved.preview) });
  if (resolved.authorityVerified) return { status: 'already-confirmed', workId: workflow.workItem.id,
    planDigest: confirmation, executed: false, stateChanged: false };
  if (!resolved.preview.requiredConfirmation.length) return { status: 'confirmation-not-required',
    workId: workflow.workItem.id, planDigest: confirmation, executed: false, stateChanged: false };
  const authority = trpSelectionAuthorityContext(workflow, resolved.phase, resolved.agreement);
  const actor = identity(root);
  requireApprovalAuthority(authority.pinnedAuthorities, { authorities: authority.delegation.authorities }, actor);
  const principal = String(actor.email ?? actor.login ?? '').trim().toLowerCase();
  if (!principal) fail('A named delegated reviewer is required.', 'TRP_AUTHORITY_REQUIRED');
  const selection = sealTrpRecord({ ...resolved.selection, issuer: { principal, channel: 'terminal' } });
  const review = trpAuthorityReview(selection, authority.policy);
  const authorization = await captureTerminalActionAuthorization(root, review.plan, review.action, { label: 'Confirm test scope' });
  if (!authorization) return { status: 'cancelled', workId: workflow.workItem.id, planDigest: confirmation, executed: false, stateChanged: false };
  const store = new StoryStateStore(root, config);
  const transaction = await store.transact(workflow, {
    type: 'test-selection-confirmed', phaseId: resolved.phase.id,
    payload: { planDigest: confirmation, agreementSha256: resolved.agreement.recordSha256,
      generation: selection.subject.generation, validationEpoch: selection.subject.validationEpoch }
  }, `Confirm exact test selection for ${workflow.workItem.id}`, async (current) => {
    const fresh = await resolvePlan(root, config, current, { phaseId: resolved.phase.id,
      confirmation, createdAt: selection.createdAt });
    const freshSelection = sealTrpRecord({ ...fresh.selection, issuer: selection.issuer });
    if (!fresh.preview.ready || fresh.preview.planDigest !== confirmation
      || freshSelection.recordSha256 !== selection.recordSha256) fail('The candidate or test policy changed during review. Review a fresh plan.', 'TRP_TEST_SELECTION_CONFIRMATION_STALE');
    const freshAuthority = trpSelectionAuthorityContext(current, fresh.phase, fresh.agreement);
    const witness = await consumeTrpAuthority(root, { record: selection, ...freshAuthority, review, token: authorization.token });
    const workRoot = workDir(root, config, current.workItem.id);
    await appendTrpRecord(workRoot, selection);
    const saved = await appendTrpAuthorityReceipt(workRoot, witness);
    const entry = { planDigest: confirmation, phaseId: selection.subject.phaseId, generation: selection.subject.generation,
      validationEpoch: selection.subject.validationEpoch, confirmedAt: saved.receipt.issuedAt,
      selection: reference(selection), authorityReceipt: reference(saved.receipt) };
    current.testRecovery.selectionConfirmations ??= [];
    current.testRecovery.selectionConfirmations.push(entry);
    return entry;
  }, { expectedLocalHead: initialHead });
  const afterPending = await storyPublicationPending(root, config, workflow.workItem.id, { migrate: false });
  return { schemaVersion: 1, resultType: 'story-test-selection-confirmation',
    status: afterPending ? 'publication-pending' : 'confirmed', workId: workflow.workItem.id,
    planDigest: confirmation, confirmation: transaction.value, publication: transaction.publication,
    pending: afterPending ?? null, executed: false, stateChanged: true, observedOutcome: 'not-run',
    legalActions: afterPending ? [legalRecovery(workflow.workItem.id)] : [] };
}

export async function storyTestSelectionCommand(positionals, options) {
  const action = positionals[2] ?? 'plan';
  if (!['plan', 'confirm'].includes(action) || positionals.length > 4) fail('Choose story test-policy plan or confirm with at most one Story ID.', 'TRP_SELECTION_ARGUMENT_INVALID');
  const positional = positionals[3] ?? null;
  const optionId = optionString(options, 'work-id');
  if (positional && optionId && positional !== optionId) fail('The positional Story ID and --work-id disagree.', 'TRP_SELECTION_ARGUMENT_INVALID');
  const root = repoRoot();
  const { config, workflow } = await loadAcceptedStoryExecution(root, optionId ?? positional);
  const input = { phaseId: optionString(options, 'phase'), confirmation: optionString(options, 'confirm') };
  const data = action === 'plan' ? await planStoryTestSelection(root, config, workflow, input)
    : await confirmStoryTestSelection(root, config, workflow, input);
  return emitCommandResult(commandResult({
    operation: { id: `story.test-policy.${action}`, classification: action === 'plan' ? 'read' : 'mutation' },
    outcome: succeeded(action === 'plan' ? 'story.test-policy.selection-planned'
      : data.stateChanged ? 'story.test-policy.selection-confirmed' : 'story.test-policy.selection-unchanged', { status: data.status }),
    effects: data.stateChanged ? effects({ stateChanged: true, filesChanged: true,
      publicationCreated: true, externalSystemsChanged: Boolean(data.publication?.pushed) }) : noEffects(),
    restState: data.status === 'confirmed' ? 'complete' : 'informational', data
  }), { json: optionBoolean(options, 'json'), restStateWhenIdle: null });
}
