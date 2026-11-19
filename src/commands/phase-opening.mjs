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

/**
 * Refuse a rollover confirmation that is not the previewed one, through the one check every copied confirmation takes
 * (text-lines.mjs assertConfirmation): a copying slip is told apart from a changed step, and the current value travels.
 */
export async function staleRollover(supplied, expected, message, preview) {
  if (supplied === expected) return;
  (await import('../text-lines.mjs')).assertConfirmation(supplied, expected, { code: 'GENERATION_ROLLOVER_STALE', message, details: preview,
    fail: (words, code, details) => { throw refuse(words, code, details); } });
}

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
 * The kernel is handed the step's task fact as every view reads it (workflow-task-outcome.mjs readTaskOutcome: a change the
 * person typed, what the submission waits to see accounted for), and with `config` its retained review, as the views read
 * it: without them a typed change's or a review's next version was named as the old version's submission, and
 * /sf-submit submitted it while the person's yes waited (review of the opening flow, 2026-11-17).
 */
export async function kernelRoute(root, workflow, phase, { config = null } = {}) {
  const [{ decisionRoutes, stepSnapshotOf, reviewFactOf }, { stepState }, { observeOpening }, { readTaskOutcome }] = await Promise.all([
    import('../step-decision.mjs'), import('../kernel/step-state.mjs'), import('../story-version-acceptance.mjs'), import('../workflow-task-outcome.mjs')]);
  const task = await readTaskOutcome(root, workflow, phase).catch(() => null);
  const review = config ? await retainedReview(root, config, workflow, phase) : null;
  const decision = stepState(stepSnapshotOf({ workflow, phase, opening: observeOpening(root, workflow, phase), task: task?.outcome ? task : null,
    changeRequested: task?.changeRequested === true, askedFor: task?.askedFor ?? null, ...(review ? { review: reviewFactOf(phase, review), reviewOwed: true } : {}) }));
  const [route] = decisionRoutes(decision, workflow, phase);
  return { decision, route: route ? { command: route.command ?? null, copilotCommand: route.copilotCommand ?? null, skill: route.skill ?? null,
    label: route.detail ?? null } : null };
}

/** The published step's retained review, read as next steps reads it; null when none is owed, or on any doubt. */
async function retainedReview(root, config, workflow, phase) {
  const { sourceReviewRequired } = await import('../source-review-policy.mjs');
  if (phase.status !== 'in_progress' || !(Number(phase.generation) > 0) || !sourceReviewRequired(workflow, phase.id)) return null;
  return (await import('../source-review-lifecycle.mjs')).readSourceReviewStatus(root, config, workflow, phase.id).catch(() => null);
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
  let grant = await consent.readGrant(commonDir, digest);
  // A yes another person gave never stands for this one: their own new answer is preferred, and that grant is dropped on
  // the refusal it makes, so it is not met again for its 30 minutes (review of the opening flow, 2026-11-17).
  const foreign = grant?.principal && principal && !consent.samePrincipal(grant.principal, principal) ? grant : null;
  if (foreign) {
    await consent.dropGrant(commonDir, digest);
    grant = typed || !(await boundTurnStories(root)).includes(workflow.workItem.id) ? null : grant;
  }
  if (grant) return { principal, receipt: consent.consentReceipt(commonDir, { proposal, digest, surface: grant.surface, question: grant.question,
    answer: grant.answer, principal: grant.principal ?? principal,
    assurance: grant.surface === 'confirm-code' ? 'host-confirm-code' : grant.surface === 'decisions-card' ? 'host-card' : 'host-answer',
    session: grant.session, turnId: grant.turnId, host: grant.host, confirmedAt: Date.parse(grant.grantedAt) }) };
  if (typed) return { principal, receipt: consent.consentReceipt(commonDir, { proposal, digest, surface: 'terminal', question, principal,
    assurance: 'terminal-tty', host: 'terminal' }) };
  if (!(await boundTurnStories(root)).includes(workflow.workItem.id)) return { principal, receipt: consent.consentReceipt(commonDir, {
    proposal, digest, surface: 'terminal', question, principal, assurance: 'terminal-command', host: 'terminal' }) };
  return { principal, receipt: null };
}

/**
 * The person's yes on the decisions card kept on this clone for this exact proposal, as a preview says it, or null: the
 * preview's confirmation then opens the version with it and the person is not asked again [D3, OSA Stage 4].
 */
export async function keptConsent(root, digest) {
  const [{ readGrant }, { commonDir }] = await Promise.all([import('../story-version-consent.mjs'), directories(root)]);
  const grant = await readGrant(commonDir, digest).catch(() => null);
  return grant?.surface === 'decisions-card' ? { kept: true, surface: grant.surface, expiresAt: grant.expiresAt } : null;
}

/** What a preview's next action says once the person's yes is kept: its confirmation, asked nothing again. */
export const keptReason = (version) => `The person's yes to version ${version} is kept from the decisions card: run this confirmation now, without asking them again.`;

/** The person answers the proposal's question in their own terminal; true only on their typed yes. */
export async function askAtTerminal(question) {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return false;
  const { createInterface } = await import('node:readline/promises');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await terminal.question(`${question} Type yes to start it, or press Enter to cancel: `)).trim().toLowerCase() === 'yes'; }
  finally { terminal.close(); }
}

/**
 * Open a successor on the person's yes: their consent receipt, then the one opening operation. `open(workflow, phase)`
 * makes the step's own opening inside the governed commit. The author's own correction is asked too; `settled` is the one
 * exception, a review's findings on a version only the reviewer has seen (owner, 2026-11-19).
 */
export async function openSuccessor(root, config, workflow, phase, { proposal, digest, question, open, typed = false, operationId = null, fault = null, settled = null }) {
  // Only the first opening of version 1 needs no yes [§7.2]; every successor does, the author's own correction too
  // (owner, 2026-11-17) [D3, OSA:REQ-030], but for review findings only the reviewer saw (owner, 2026-11-19).
  const owed = proposal.consent !== 'not-required' && !(settled?.kind === 'review-corrections' && proposal.reason === 'review-corrections');
  const found = owed ? await consentFor(root, workflow, { proposal, digest, question, typed }) : { principal: await principalHere(root), receipt: null };
  if (owed && !found.receipt) {
    // The step's own preview, through its work command, as the views name it: never the published version's submission.
    const { route } = await kernelRoute(root, workflow, phase, { config });
    throw refuse(`Starting version ${proposal.version} of ${phase.id} is the person's yes, and none reached SFlow for it. Nothing was opened. `
      + `Ask them "${question}" with your question tool, then run this confirmation again; or they preview it in their own terminal, which asks them.`,
    'VERSION_CONSENT_REQUIRED', { phase: phase.id, version: proposal.version, question, ...(route ? { nextAction: route } : {}) });
  }
  const { openVersion } = await opening();
  const session = await (await import('../session.mjs')).loadSession(root, { required: false }).catch(() => null);
  const agent = session?.workId === workflow.workItem.id ? session.agent ?? null : null;
  const opened = await openVersion(root, config, workflow, phase, { proposal, digest, receipt: found.receipt, principal: found.principal, operationId, open, fault, agent,
    ...(settled ? { settled } : {}) });
  // A code version's Node, when the evidence names it, is pinned as the version opens, before anything runs: settled with an
  // undo, never a question (node-version-settle.mjs) [owner, 2026-11-18]. Never fails the opening.
  if ((await import('../code-delivery-policy.mjs')).phaseRequiresCodeDelivery(phase)) {
    await (await import('../settle-before-publication.mjs')).settleBeforePublication(root, config, workflow, phase,
      { actor: (await import('../git.mjs')).actionActor(root), agent }).catch(() => null);
  }
  return opened;
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
  // Nothing published, and an earlier reservation used version 1 (the kernel's `watermark` successor): its next is asked too.
  return (numbers.published >= 1 || numbers.proposedNext > 1) && needsVersion(facts);
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
  // An approved amendment is acknowledged before any version opens, so it is asked before the version question (owner, 2026-11-17).
  (await import('../source-review-policy.mjs')).assertIntentAmendmentAcknowledged(workflow);
  const { proposal, digest, question } = await proposalNow(root, workflow, phase);
  // Asked to begin a next version: its preview asks the person, in the code step's own work command [OSA:REQ-030].
  if (proposal.consent === 'required') throw consentRequired(phase, proposal, (await import('../safe-command-guidance.mjs')).safeCommandGuidance({
    argv: ['phase', 'rollover', phase.id, '--json'] }), legacy ? ' (an older build opened it on this checkout only)' : '');
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
  // prepare refuses until an approved amendment is acknowledged: that refusal comes before the version question (owner, 2026-11-17).
  (await import('../source-review-policy.mjs')).assertIntentAmendmentAcknowledged(workflow);
  // The kernel's decision for the step decides; nothing here re-derives it [OSA:REQ-001].
  const { decision, route } = await kernelRoute(root, workflow, phase);
  // A code-delivery step opens a code generation; a step that may also write application paths without delivering code (a
  // verification step's test automation) opens as a document does [Stage 3: prepare refused GENERATION_INTENT_NOT_APPLICABLE].
  const code = (await import('../code-delivery-policy.mjs')).phaseRequiresCodeDelivery(phase);
  const next = decision.next;
  // A successor for any reason, and an older build's local opening of one, opens only on the person's yes: a kernel-built
  // step's too, whose generator ran its next version with no yes before [D3, D5, Stage 2 finding 5].
  if (['open-version', 'build-version'].includes(next.operation) && next.inputs.consent === 'required') {
    throw consentRequired(phase, { version: next.inputs.version }, route, next.inputs.reason === 'legacy-promotion' ? ' (an older build opened it on this checkout only)' : '');
  }
  if (decision.kind.executionOwner === 'kernel' && !code) return null;
  // A published document's next draft is a successor too: prepare never reserves it without the person's yes. A published
  // code step with nothing reopened is refused by prepare itself (GENERATION_INTENT_ALREADY_CONSUMED), as before.
  if (!code && decision.version.published >= 1 && decision.version.writing === null) {
    // Its route is the requested change's own preview, as next steps offers it (guide.mjs), or an edited document's.
    const edited = await (await import('../phase-publication-unchanged.mjs')).documentEditedSincePublication(root, config, workflow, phase);
    const requested = (await import('../guide.mjs')).requestedSuccessorAction(workflow, phase, edited ? { changedPaths: [edited] } : { requested: true });
    throw consentRequired(phase, { version: decision.version.proposedNext }, requested ? { command: requested.command ?? null,
      copilotCommand: requested.copilotCommand ?? null, label: requested.label ?? requested.reason ?? null } : route);
  }
  if (next.operation !== 'open-version' || next.inputs.consent !== 'not-required') return null;
  // Version 1 of a document step opens through the same operation only where the owner's switch turns it on: it commits
  // and pushes at every document step's first prepare (docs/osa/stage4.md, owner decision) [OSA §4.3, §7.2].
  if (!code && !documentInitialOpening()) return null;
  // Version 1 opens here, shared before prepare writes anything; no consent is owed for it [§7.2].
  const { proposal, digest, question } = await proposalNow(root, workflow, phase);
  return openSuccessor(root, config, workflow, phase, { proposal, digest, question, open: code ? codeOpening(root, config) : documentOpening() });
}

/**
 * Whether version 1 of a document step gets its opening record through the opening operation (`shared`), as a code step's
 * does, or keeps the verified initial-version path every earlier build used (`local`, the default). Off by default until
 * the owner decides: on, every document step's first `prepare` commits the opening and pushes the Story branch.
 * `SINGULARITY_FLOW_DOCUMENT_VERSION_OPENING=shared` turns it on for this process; nothing else reads it.
 */
export const DOCUMENT_VERSION_OPENING_DEFAULT = 'local';
export function documentInitialOpening(env = process.env) {
  return (String(env.SINGULARITY_FLOW_DOCUMENT_VERSION_OPENING ?? '').trim() || DOCUMENT_VERSION_OPENING_DEFAULT) === 'shared';
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
    const kept = await keptConsent(root, proposed.digest);
    if (optionBoolean(options, 'json')) {
      console.log(JSON.stringify(kept ? { ...preview, consent: kept, nextAction: { command: route.command, copilotCommand: route.copilotCommand, reason: keptReason(proposed.proposal.version) } } : preview, null, 2));
      return null;
    }
    if (!await askAtTerminal(proposed.question)) {
      console.log(proposed.question);
      console.log('To start it, confirm its code below, in Copilot or in your own terminal.');
      printCommandRoutes(route, { label: 'Continue' });
      console.log('Nothing was changed.');
      return null;
    }
    typed = true;
  } else {
    await staleRollover(supplied, expected, 'This confirmation is not the current one: the files changed since the preview. Preview again; nothing was opened.', preview);
  }
  const opened = await openSuccessor(root, config, workflow, phase, { ...proposed, typed,
    open: codeOpening(root, config, { adoptExisting: Boolean(changeSetDigest), confirm: changeSetDigest }) });
  return { preview, outcome: opened.outcome, replayed: opened.replayed };
}

/**
 * The step's preview as a person runs it in their own terminal, which asks them the proposal's question [D3, OSA:REQ-030];
 * `json`: as an agent runs it, which then asks the person with its question tool.
 */
export async function askingRoute(phaseId, skill = null, { json = false } = {}) {
  return (await import('../safe-command-guidance.mjs')).safeCommandGuidance({ argv: ['phase', 'rollover', phaseId, ...(json ? ['--json'] : [])], skill });
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
  const reason = legacy ? 'legacy-promotion' : await reasonOf(workflow, phase, numbers.published >= 1 ? 'requested-change' : 'watermark');
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
    const kept = await keptConsent(root, digest);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(kept && preview.nextAction
      ? { ...preview, consent: kept, nextAction: { ...preview.nextAction, reason: keptReason(proposal.version) } } : preview, null, 2));
    if (await askAtTerminal(question)) { supplied = confirmation; typed = true; }
    else {
      console.log(question);
      printCommandRoutes(await askingRoute(phase.id, skill), { label: 'To start it, run this in your own terminal, which asks you, or ask Copilot' });
      return console.log('Nothing was changed.');
    }
  }
  await staleRollover(supplied, confirmation, 'The confirmation is not the current one: the step or the Story changed since the preview. Preview again (its JSON carries the current confirmation).', preview);
  const result = await openSuccessor(root, config, workflow, phase, { proposal, digest, question, typed,
    open: legacy ? legacyOpening(root) : code ? codeOpening(root, config) : documentOpening() });
  // What follows is the kernel's next for the open version: writing it, in this same turn.
  const after = (await kernelRoute(root, workflow, phase)).route;
  const value = { ...preview, mutates: true, nextAction: after, opening: result.outcome, replayed: result.replayed,
    ...(code ? {} : { opened: { generation: proposal.version, status: 'open' } }), next: after };
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
  // Refused, and its commit set aside since (`sync --set-aside`): no longer this confirmation's opening, so it is not
  // replayed; replaying its refusal named `sync --set-aside` again, forever (review of the opening flow, 2026-11-17).
  if (checkpoint?.state === 'refused' && checkpoint.commit) {
    const { commitIsAncestor, head } = await import('../git.mjs');
    if (!commitIsAncestor(root, checkpoint.commit, head(root))) return null;
  }
  const settled = await o.reconcileOpening(root, config, workflow, phase, { operationId });
  return printOpened(options, { schemaVersion: 1, resultType: 'sflow-generation-rollover', kind: 'replayed', workId: workflow.workItem.id, phase: phase.id,
    fromGeneration: record.proposal.from?.published ?? null, toGeneration: record.proposal.version, question: record.question, confirmation,
    mutates: false, replayed: true, opening: settled.outcome, nextAction: (await kernelRoute(root, workflow, phase)).route },
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
