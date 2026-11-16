/**
 * SPEC-OSA v1.1 Stage 2: the commands that open a step's version, each through the one opening operation
 * (story-version-opening.mjs) [OSA:REQ-030–REQ-034]:
 * - `phase begin` opens version 1 of a code step (no consent), promotes a verified legacy local opening of version 1, and
 *   settles an opening the operation already made; a successor is never opened here;
 * - `phase rollover <step>` previews a successor for any reason (a person's return, a review's corrections, a requested
 *   change, changed published files, a legacy local opening) with the question the person answers, and
 *   `phase rollover <step> --confirm <value>` opens it on their yes;
 * - `prepare` opens version 1 of a code step the same way before it prepares, and refuses to open a successor itself;
 * - `phase opening <step>` shows what this checkout knows of the step's opening, and `--reconcile` settles it.
 * The old working-copy-only opening (a local `generationIntent` with no commit) is gone.
 */
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

const refuse = (message, code, details = {}) => new SingularityFlowError(message, { code, details });
const opening = () => import('../story-version-opening.mjs');

async function directories(root) {
  const { gitDirectories } = await import('../story-version-acceptance.mjs');
  const found = gitDirectories(root);
  if (found) return found;
  const { gitDir, gitCommonDir } = await import('../git.mjs');
  return { gitDir: gitDir(root), commonDir: gitCommonDir(root) };
}

/**
 * The step's legal next action as the kernel decides it and the host renders it (phase-mutation-contract.mjs), as this
 * checkout observes the opening [OSA:REQ-001, REQ-022]: refusals and results name it, never a route built here.
 */
export async function kernelRoute(root, workflow, phase) {
  const [{ decisionRoutes, stepSnapshotOf }, { stepState }, { observeOpening }] = await Promise.all([
    import('../phase-mutation-contract.mjs'), import('../kernel/step-state.mjs'), import('../story-version-acceptance.mjs')]);
  const decision = stepState(stepSnapshotOf({ workflow, phase, opening: observeOpening(root, workflow, phase) }));
  const [route] = decisionRoutes(decision, workflow, phase);
  return { decision, route: route ? { command: route.command ?? null, copilotCommand: route.copilotCommand ?? null, skill: route.skill ?? null,
    label: route.detail ?? null } : null };
}

/** The identity opening a version here, as this machine resolves it: never a value a model passed. */
async function principalHere(root) {
  return (await import('../git.mjs')).actionActor(root);
}

/** Why `phase` needs its next version, in the opening's words. */
async function reasonOf(workflow, phase, fallback) {
  const [{ versionFactsOf }, { versionNeed }] = await Promise.all([import('../phase-generation-need.mjs'), import('../kernel/step-versions.mjs')]);
  const need = versionNeed(versionFactsOf(workflow, phase));
  return { REWORK: 'rework', REJECTED: 'rejected', AMENDMENT: 'amendment', AUTHOR_CONFLICT: 'author-conflict' }[need] ?? fallback;
}

/** The proposal as the Story stands now, bound to its local lifecycle revision. */
export async function proposalNow(root, workflow, phase, options = {}) {
  const [{ versionProposal }, { head }] = await Promise.all([opening(), import('../git.mjs')]);
  return versionProposal(workflow, phase, { ...options, lifecycleRevision: head(root) });
}

/**
 * Keep a preview's proposal on this clone, sealed, so the hook that hears the person's answer can bind it to this exact
 * proposal (story-version-consent.mjs). Returns the question the person is asked.
 */
export async function recordPreview(root, { proposal, digest, question, confirmation }) {
  const [{ machineLocalPublicationIntegrityKey }, { recordProposal }] = await Promise.all([
    import('../publication-machine-integrity.mjs'), import('../story-version-consent.mjs')]);
  await machineLocalPublicationIntegrityKey(root, { create: true });
  const { commonDir } = await directories(root);
  const principal = await principalHere(root);
  await recordProposal(commonDir, { proposal, digest, question, confirmation,
    principal: { name: principal?.name ?? null, email: principal?.email ?? null, login: principal?.login ?? null } });
  return question;
}

/**
 * The person's sealed yes to `proposal`, from where it reached SFlow [§7.1]:
 * - a grant the host's hook kept from their answer to the question tool, or from the /sf-confirm code they typed;
 * - `typed`: their yes typed into this process at their own terminal;
 * - the exact confirmation run outside every Copilot turn bound to this Story's checkout: their own terminal.
 * Otherwise null: a command a Copilot turn ran without the person's answer reaching SFlow opens nothing.
 */
export async function consentFor(root, workflow, { proposal, digest, question, typed = false }) {
  const [consent, { boundTurnStories }] = await Promise.all([import('../story-version-consent.mjs'), import('../story-routing.mjs')]);
  const { commonDir } = await directories(root);
  const principal = await principalHere(root);
  const grant = await consent.readGrant(commonDir, digest);
  if (grant) return { principal, receipt: consent.consentReceipt(commonDir, { proposal, digest, surface: grant.surface, question: grant.question,
    answer: grant.answer, principal: grant.principal ?? principal, assurance: grant.surface === 'confirm-code' ? 'host-confirm-code' : 'host-answer',
    session: grant.session, turnId: grant.turnId, host: grant.host, confirmedAt: Date.parse(grant.grantedAt) }) };
  if (typed) return { principal, receipt: consent.consentReceipt(commonDir, { proposal, digest, surface: 'terminal', question, principal,
    assurance: 'terminal-tty', host: 'terminal' }) };
  if (!(await boundTurnStories(root)).includes(workflow.workItem.id)) return { principal, receipt: consent.consentReceipt(commonDir, {
    proposal, digest, surface: 'terminal', question, principal, assurance: 'terminal-command', host: 'terminal' }) };
  return { principal, receipt: null };
}

/** The person answers the proposal's question in their own terminal; true only on their typed yes. */
export async function askAtTerminal(question) {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return false;
  const readline = await import('node:readline/promises');
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await terminal.question(`${question} Type yes to start it, or press Enter to cancel: `)).trim().toLowerCase() === 'yes'; }
  finally { terminal.close(); }
}

/**
 * Open a successor on the person's yes: their consent receipt, then the one opening operation. `open(workflow, phase)`
 * makes the step's own opening inside the governed commit. `settled` is the one named exception the owner decided: the
 * author's own correction of its unreviewed draft, settled for the person with an undo [owner, 2026-11-13].
 */
export async function openSuccessor(root, config, workflow, phase, { proposal, digest, question, open, typed = false, operationId = null, settled = null, fault = null }) {
  // Only the first opening of version 1 needs no yes [§7.2]; the owner's settled own correction is its own record.
  const owed = proposal.consent !== 'not-required' && !settled;
  const found = owed ? await consentFor(root, workflow, { proposal, digest, question, typed }) : { principal: await principalHere(root), receipt: null };
  if (owed && !found.receipt) {
    const { route } = await kernelRoute(root, workflow, phase);
    throw refuse(`Starting version ${proposal.version} of ${phase.id} is the person's yes, and none reached SFlow for it. Nothing was opened. `
      + `Ask them "${question}" with your question tool, then run this confirmation again; or they preview it in their own terminal, which asks them.`,
    'VERSION_CONSENT_REQUIRED', { phase: phase.id, version: proposal.version, question, ...(route ? { nextAction: route } : {}) });
  }
  const { openVersion } = await opening();
  const session = await (await import('../session.mjs')).loadSession(root, { required: false }).catch(() => null);
  return openVersion(root, config, workflow, phase, { proposal, digest, receipt: found.receipt, principal: found.principal, operationId, open, fault,
    agent: session?.workId === workflow.workItem.id ? session.agent ?? null : null, ...(settled ? { settled } : {}) });
}

/** A code step's generation opened inside the governed commit, as `phase begin` opened it before. */
export function codeOpening(root, config, { adoptExisting = false, confirm = null } = {}) {
  return async (workflow, phase) => {
    const [{ beginPhaseGeneration }, { verifyOpenGenerationIntent }] = await Promise.all([import('../state-stores.mjs'), import('../generation-boundary.mjs')]);
    const opened = await beginPhaseGeneration(root, config, workflow, { phaseId: phase.id, adoptExisting, confirm });
    await verifyOpenGenerationIntent(root, workflow, phase);
    return opened;
  };
}

/** A document step's next draft reserved inside the governed commit; a step its return already reopened needs none. */
export function documentOpening() {
  return async (workflow, phase) => {
    const [{ reservePreparedDocumentSuccessor }, { versionFactsOf }, { needsVersion }, { nowIso }] = await Promise.all([
      import('../prepared-document-successor.mjs'), import('../phase-generation-need.mjs'), import('../kernel/step-versions.mjs'), import('../util.mjs')]);
    if (!needsVersion(versionFactsOf(workflow, phase)) && !reservePreparedDocumentSuccessor(workflow, phase, nowIso())) {
      throw refuse(`Phase '${phase.id}' has no published draft to start the next one from.`, 'GENERATION_ROLLOVER_UNAVAILABLE');
    }
    return null;
  };
}

/** A verified legacy local opening, promoted as it is: its intent and receipt are kept [§14]. */
function legacyOpening(root) {
  return async (workflow, phase) => {
    if (phase.generationIntent) await (await import('../generation-boundary.mjs')).verifyOpenGenerationIntent(root, workflow, phase);
    return phase.generationIntent ?? null;
  };
}

/** What a print of an opening says. */
function printOpened(options, value, words) {
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(value, null, 2));
  else console.log(words);
}

/** The step's opening as the kernel reads it, with its numbers. */
async function openingState(workflow, phase) {
  const [{ versionFactsOf }, { versionNumbers }] = await Promise.all([import('../phase-generation-need.mjs'), import('../kernel/step-versions.mjs')]);
  const facts = versionFactsOf(workflow, phase);
  return { facts, numbers: versionNumbers(facts) };
}

/** A published step a return, rejection or amendment reopened, or a legacy local successor: its opening awaits the person's yes. */
export async function successorAwaitsConsent(workflow, phase) {
  const { needsVersion } = await import('../kernel/step-versions.mjs');
  const { facts, numbers } = await openingState(workflow, phase);
  if (!numbers.ok || workflow.currentPhase !== phase.id || phase.status !== 'in_progress') return false;
  if (numbers.writing !== null) return facts.opening?.record === 'legacy' && numbers.writing > 1;
  return numbers.published >= 1 && needsVersion(facts);
}

const consentRequired = (phase, proposal, route, extra = '') => refuse(`Version ${proposal.version} of ${phase.id} is a successor: it opens only on the person's yes${extra}. Nothing was opened. `
  + 'Preview it and ask them with the step\'s own preview.', 'VERSION_CONSENT_REQUIRED', { phase: phase.id, version: proposal.version, ...(route ? { nextAction: route } : {}) });

/** `phase begin <step>`: version 1 of a code step, through the opening operation. */
export async function beginVersion(root, config, workflow, phase, options) {
  const { facts, numbers } = await openingState(workflow, phase);
  if (numbers.ok && numbers.writing !== null && facts.opening?.record === 'operation') {
    // The opening the operation made: the same opening, settled or replayed, never another.
    const { reconcileOpening } = await opening();
    const settled = await reconcileOpening(root, config, workflow, phase);
    return printOpened(options, { ...phase.generationIntent, local: false, lifecycleEvent: 'version-opened', opening: settled.outcome, replayed: true },
      `Version ${numbers.writing} of ${phase.id} is already open (operation ${settled.outcome.operationId}).`);
  }
  const legacy = numbers.ok && numbers.writing !== null && facts.opening?.record === 'legacy';
  const { proposal, digest, question } = await proposalNow(root, workflow, phase);
  if (proposal.consent === 'required') throw consentRequired(phase, proposal, (await kernelRoute(root, workflow, phase)).route,
    legacy ? ' (an older build opened it on this checkout only)' : '');
  const result = await openSuccessor(root, config, workflow, phase, { proposal, digest, question,
    open: legacy ? legacyOpening(root) : codeOpening(root, config, { adoptExisting: optionBoolean(options, 'adopt-existing') || optionBoolean(options, 'adopt-current-interval'),
      confirm: optionString(options, 'confirm') }) });
  const intent = phase.generationIntent;
  return printOpened(options, { ...intent, local: false, lifecycleEvent: 'version-opened', opening: result.outcome, replayed: result.replayed },
    `Opened ${phase.id} version ${proposal.version} on the Story's shared branch (operation ${result.outcome.operationId}).`);
}

/**
 * Before `prepare` writes anything: version 1 of a code step opens through the operation; a successor never opens here,
 * only on the person's yes through `phase rollover` [D3, OSA:REQ-030]. A step already open, or with nothing to open, passes.
 */
export async function openBeforePrepare(root, config, workflow, phase) {
  if (workflow.currentPhase !== phase.id || phase.status !== 'in_progress' || phase.generationPolicy?.requirement === 'none') return null;
  // The kernel's decision for the step decides; nothing here re-derives it [OSA:REQ-001].
  const { decision, route } = await kernelRoute(root, workflow, phase);
  const code = decision.kind.changeCapabilities.includes('application');
  if (decision.kind.executionOwner === 'kernel' && !code) return null;
  const next = decision.next;
  // A successor for any reason, and an older build's local opening of one, opens only on the person's yes.
  if (['open-version', 'build-version'].includes(next.operation) && next.inputs.consent === 'required') {
    throw consentRequired(phase, { version: next.inputs.version }, route, next.inputs.reason === 'legacy-promotion' ? ' (an older build opened it on this checkout only)' : '');
  }
  // A published document's next draft is a successor too: prepare never reserves it without the person's yes. A published
  // code step with nothing reopened is refused by prepare itself (GENERATION_INTENT_ALREADY_CONSUMED), as before.
  if (!code && decision.version.published >= 1 && decision.version.writing === null) {
    // Its route is the requested change's own preview, as next steps offers it (guide.mjs).
    const requested = (await import('../guide.mjs')).requestedSuccessorAction(workflow, phase, { requested: true });
    throw consentRequired(phase, { version: decision.version.proposedNext }, requested ? { command: requested.command ?? null,
      copilotCommand: requested.copilotCommand ?? null, label: requested.label ?? requested.reason ?? null } : route);
  }
  // Version 1 of a code step opens here, shared before prepare writes anything.
  if (!code || next.operation !== 'open-version' || next.inputs.consent !== 'not-required') return null;
  const { proposal, digest, question } = await proposalNow(root, workflow, phase);
  return openSuccessor(root, config, workflow, phase, { proposal, digest, question, open: codeOpening(root, config) });
}

/**
 * `phase rollover <step>` for a published code step whose files changed after publication (recovery-plan.mjs's plan): the
 * preview shows the proposal and its question, and `--confirm` opens it on the person's yes, adopting exactly the reviewed
 * change set. Returns `{ preview, outcome, replayed }` once opened, or null when only the preview was given.
 */
export async function changedFilesSuccessor(root, config, workflow, phase, plan, options) {
  const [{ safeCommandGuidance }, { printCommandRoutes }] = await Promise.all([import('../safe-command-guidance.mjs'), import('./shared/print-command-routes.mjs')]);
  const expected = plan.blocker.details.rolloverConfirmation;
  const route = safeCommandGuidance(plan.action);
  if (!route) throw refuse('The reviewed rollover action has no validated Shell and Copilot route. Re-run recovery before changing state.',
    'GENERATION_ROLLOVER_ROUTE_UNAVAILABLE', { action: plan.action });
  const supplied = optionString(options, 'confirm');
  const changeSetDigest = plan.blocker.details.changeSetDigest ?? null;
  const proposed = await proposalNow(root, workflow, phase, { reason: 'changed-after-publication', confirmation: expected, adoption: changeSetDigest });
  const preview = { schemaVersion: 1, workId: workflow.workItem.id, phase: phase.id, fromGeneration: phase.generation,
    toGeneration: proposed.proposal.version, question: proposed.question, confirmation: expected, changeSetDigest,
    currentResultDigest: plan.blocker.details.currentResultDigest, command: route.command, executable: route.executable, argv: route.argv,
    skill: route.skill, copilotCommand: route.copilotCommand, platformCommands: route.platformCommands, mutates: Boolean(supplied) };
  let typed = false;
  if (!supplied) {
    await recordPreview(root, { ...proposed, confirmation: expected });
    if (optionBoolean(options, 'json')) { console.log(JSON.stringify(preview, null, 2)); return null; }
    if (!await askAtTerminal(proposed.question)) {
      console.log(proposed.question);
      console.log('To start it, confirm its code below, in Copilot or in your own terminal.');
      printCommandRoutes(route, { label: 'Continue' });
      console.log('Nothing was changed.');
      return null;
    }
    typed = true;
  } else if (supplied !== expected) {
    throw refuse('This confirmation is not the current one: the files changed since the preview. Preview again; nothing was opened.',
      'GENERATION_ROLLOVER_STALE', preview);
  }
  const opened = await openSuccessor(root, config, workflow, phase, { ...proposed, typed,
    open: codeOpening(root, config, { adoptExisting: Boolean(changeSetDigest), confirm: changeSetDigest }) });
  return { preview, outcome: opened.outcome, replayed: opened.replayed };
}

/**
 * `phase rollover <step>` for a step a person's return, a rejection, an amendment or a legacy local opening reopened, code
 * or document: the preview asks the person, and `--confirm` opens it on their yes [D3, OSA:REQ-030].
 */
export async function returnedSuccessorRollover(root, config, workflow, phase, options) {
  const [{ numbers, facts }, { phaseRequiresCodeDelivery }, { safeCommandGuidance }, { printCommandRoutes }, { route: own }] = await Promise.all([
    openingState(workflow, phase), import('../code-delivery-policy.mjs'), import('../safe-command-guidance.mjs'), import('./shared/print-command-routes.mjs'),
    kernelRoute(root, workflow, phase)]);
  const legacy = numbers.ok && numbers.writing !== null && facts.opening?.record === 'legacy';
  const reason = legacy ? 'legacy-promotion' : await reasonOf(workflow, phase, 'requested-change');
  // The value the person confirms is this proposal's own digest: the step, its numbers and the Story revision it is made on.
  const unbound = await proposalNow(root, workflow, phase, { reason });
  const confirmation = unbound.digest;
  const { proposal, digest, question } = await proposalNow(root, workflow, phase, { reason, confirmation });
  const code = phaseRequiresCodeDelivery(phase);
  // The step's own work command asks it (the kernel's open-version route for this step).
  const skill = own?.skill ?? null;
  const confirmArgv = ['phase', 'rollover', phase.id, '--confirm', confirmation];
  const route = safeCommandGuidance({ argv: confirmArgv, skill });
  const preview = { schemaVersion: 1, resultType: 'sflow-generation-rollover', kind: 'returned', reason, workId: workflow.workItem.id, phase: phase.id,
    fromGeneration: proposal.from.published, toGeneration: proposal.version, question, confirmation,
    preserved: proposal.from.published ? `Version ${proposal.from.published} stays as published.` : 'Nothing published changes.',
    command: route?.command ?? null, executable: route?.executable ?? null, argv: route?.argv ?? null, skill: route?.skill ?? null,
    copilotCommand: route?.copilotCommand ?? null, platformCommands: route?.platformCommands ?? null,
    nextAction: route ? { command: route.command, copilotCommand: route.copilotCommand,
      reason: `Ask the person "${question}" with your question tool; only on their Yes run this confirmation.` } : null, mutates: false };
  let supplied = optionString(options, 'confirm');
  let typed = false;
  if (!supplied) {
    await recordPreview(root, { proposal, digest, question, confirmation });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(preview, null, 2));
    if (await askAtTerminal(question)) { supplied = confirmation; typed = true; }
    else {
      console.log(question);
      printCommandRoutes(safeCommandGuidance({ argv: ['phase', 'rollover', phase.id], skill }), { label: 'To start it, run this in your own terminal, which asks you, or ask Copilot' });
      return console.log('Nothing was changed.');
    }
  }
  if (supplied !== confirmation) throw refuse('The confirmation is not the current one: the step or the Story changed since the preview. Preview again (its JSON carries the current confirmation).',
    'GENERATION_ROLLOVER_STALE', preview);
  const result = await openSuccessor(root, config, workflow, phase, { proposal, digest, question, typed,
    open: legacy ? legacyOpening(root) : code ? codeOpening(root, config) : documentOpening() });
  const value = { ...preview, mutates: true, nextAction: null, opening: result.outcome, replayed: result.replayed,
    ...(code ? {} : { opened: { generation: proposal.version, status: 'open' } }), next: (await kernelRoute(root, workflow, phase)).route };
  return printOpened(options, value, `Opened ${phase.id} version ${proposal.version}. ${preview.preserved}`);
}

/**
 * A confirmation run again for an opening it already made (a lost reply, a retried command): the same operation, its
 * original outcome, with no new commit and no question [OSA:REQ-033]. Null when `confirmation` opened nothing here.
 */
export async function replayConfirmed(root, config, workflow, phase, confirmation, options) {
  if (typeof confirmation !== 'string') return null;
  const [{ readProposalRecord }, o] = await Promise.all([import('../story-version-consent.mjs'), opening()]);
  const { commonDir } = await directories(root);
  const record = await readProposalRecord(commonDir, confirmation);
  if (!record || record.proposal?.workId !== workflow.workItem.id || record.proposal?.phase !== phase.id) return null;
  const operationId = o.operationIdOf(record.digest);
  const checkpoint = await o.openingCheckpoint(root, workflow.workItem.id, operationId);
  // Nothing of it was committed (stopped before its reservation): the confirmation runs the operation again.
  if (phase.versionOpening?.operationId !== operationId && (!checkpoint || checkpoint.state === 'prepared')) return null;
  const settled = await o.reconcileOpening(root, config, workflow, phase, { operationId });
  return printOpened(options, { schemaVersion: 1, resultType: 'sflow-generation-rollover', kind: 'replayed', workId: workflow.workItem.id, phase: phase.id,
    fromGeneration: record.proposal.from?.published ?? null, toGeneration: record.proposal.version, question: record.question, confirmation,
    mutates: false, replayed: true, opening: settled.outcome, next: (await kernelRoute(root, workflow, phase)).route },
  `Version ${record.proposal.version} of ${phase.id} was already opened by this confirmation; nothing new was opened.`) ?? true;
}

/** `phase opening <step> [--reconcile]`: what this checkout knows of the opening; `--reconcile` settles it as the same operation. */
export async function openingCommand(root, config, workflow, phase, options) {
  const { inspectOpening, reconcileOpening } = await opening();
  if (optionBoolean(options, 'reconcile')) {
    const operationId = optionString(options, 'operation') ?? undefined;
    const settled = await reconcileOpening(root, config, workflow, phase, operationId ? { operationId } : {});
    const value = { ...(await inspectOpening(root, workflow, phase)), settled: settled.checkpoint, outcome: settled.outcome,
      next: (await kernelRoute(root, workflow, phase)).route };
    return printOpened(options, value, `Version ${settled.outcome.version} of ${phase.id} is accepted on the shared Story branch.`);
  }
  const value = await inspectOpening(root, workflow, phase);
  return printOpened(options, value, value.opening
    ? `Version ${value.opening.version} of ${phase.id}: ${value.checkpoint?.state ?? 'not observed here'}; writer fence ${value.opening.writer.fence}${value.opening.writer.current ? ' (this checkout)' : ' (another checkout)'}.`
    : `${phase.id} has no version opened by the opening operation.`);
}
