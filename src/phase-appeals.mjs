/** Immutable, exact-diff phase appeals. Scope accounting is not risk acceptance or phase approval. */
import path from 'node:path';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { branch, exactFileAtObject, head, identity } from './git.mjs';
import { canonicalJson } from './records.mjs';
import { currentSchemaVersion } from './schema-migrations.mjs';
import { buildRepositoryChangeSet, evaluateProtectedPaths, evaluateSourceBoundary } from './repository-change-set.mjs';
import { applicationChangeSetProjection, applicationPathContext } from './work-intervals.mjs';
import { verifyOpenGenerationIntent } from './generation-boundary.mjs';
import { phaseRequiresCodeDelivery } from './delivery-evidence.mjs';
import { nextPhaseGeneration } from './phase-generation.mjs';
import { isTestAutomationPath } from './source-boundary.mjs';
import { recordPlanAmendment, planAuthorities } from './plan-amendments.mjs';
import { loadActiveSpecRecords, mergePlannedClaimRecords } from './specifications.mjs';
import { actorKey, assertNoPendingPublication, sourceTreeHash, testInputTreeHash, transactStory, workDir } from './state-stores.mjs';
import { requireApprovalAuthority } from './approval-authority.mjs';
import { captureTerminalActionAuthorization } from './action-authorization.mjs';
import { consumeAndRetainHumanReview, humanReviewOriginPresent } from './human-review-origin.mjs';
import { LIFECYCLE_EVENT } from './lifecycle-event.mjs';
import { nowIso, secureRepositoryPath, SingularityFlowError, writeText } from './util.mjs';

const hash = value => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const bytesHash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const fail = (message, code = 'PHASE_APPEAL_INVALID', details = {}) => { throw new SingularityFlowError(message, { code, details }); };
const SHA = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const text = z.string().trim().min(20).max(2000).refine(value => !/[\x00-\x1f\x7f]/u.test(value));
const portablePath = z.string().max(512).refine(value => value.length > 0 && value === value.trim()
  && !/[\\:*?"<>|\x00-\x1f\x7f]/u.test(value) && !value.startsWith('/')
  && value.split('/').every(segment => segment && segment !== '.' && segment !== '..' && !/[. ]$/u.test(segment)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)));
const change = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('add-location'), clauseId: z.string().min(1).max(200), path: portablePath }).strict(),
  z.object({ kind: z.literal('add-supporting'), path: portablePath, class: z.string().min(1).max(100), reason: text }).strict()
]);
const bindingSchema = z.object({ workId: z.string(), phaseId: z.string(), generation: z.number().int().positive(),
  intentId: z.string().nullable(), policySha256: SHA, planSha256: SHA,
    sourceSha256: SHA, testInputSha256: SHA.nullable(), evidenceSha256: SHA }).strict();
export const PhaseAppealSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('phase-appeal'),
  id: z.string().regex(/^APL-[a-f0-9]{24}$/u), binding: bindingSchema, reason: text,
  changes: z.array(change).min(1).max(50),
  diff: z.array(z.object({ path: portablePath, status: z.enum(['added', 'modified']), beforeSha256: SHA.nullable(),
    afterSha256: SHA, before: z.string().max(262144), after: z.string().max(262144) }).strict()).min(1).max(50),
  author: z.object({ actor: z.string(), provenance: z.literal('configured-git-identity-not-proof-of-tool-authorship') }).strict(),
  baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/u), capturedHead: z.string().regex(/^[a-f0-9]{40,64}$/u),
  requestedDisposition: z.literal('account-scope'), limitations: z.array(z.string()), packetSha256: SHA
}).strict();
export const PhaseAppealDecisionSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('phase-appeal-decision'),
  appealId: z.string().regex(/^APL-[a-f0-9]{24}$/u), packetSha256: SHA,
  decision: z.enum(['account-scope', 'request-changes']), reason: text,
  actor: z.string().min(1).max(256), authorityGroup: z.string().min(1).max(256),
  identityAssurance: z.string().max(100).nullable(), reviewAssurance: z.literal('live-terminal-exact-diff-review'),
  authorizationId: z.string().min(1).max(256), amendmentId: z.string().max(100).nullable(),
  at: z.string().datetime(), testsWaived: z.literal(false), phaseApproved: z.literal(false)
}).strict();
export const phaseAppealDecisionHash = hash;
async function boundedFile(root, relative, limit, label) {
  const secured = await secureRepositoryPath(root, relative, { mustExist: true, type: 'file', label });
  const handle = await open(secured.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit || before.ino !== secured.entry.ino || before.dev !== secured.entry.dev) fail(`${label} is unsafe or exceeds its byte budget.`, 'PHASE_APPEAL_INTEGRITY');
    const buffer = Buffer.alloc(limit + 1); let count = 0;
    while (count <= limit) {
      const read = await handle.read(buffer, count, buffer.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
      if (count > limit) fail(`${label} grew past its byte budget.`, 'PHASE_APPEAL_INTEGRITY');
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || count !== after.size) fail(`${label} changed while being captured.`, 'PHASE_APPEAL_STALE');
    return buffer.subarray(0, count);
  } finally { await handle.close(); }
}

function core(packet) { const value = structuredClone(packet); delete value.packetSha256; return value; }
export function validatePhaseAppeal(packet) {
  const parsed = PhaseAppealSchema.safeParse(packet);
  if (!parsed.success || hash(core(packet)) !== packet?.packetSha256) fail('Appeal schema or exact packet hash is invalid.', 'PHASE_APPEAL_INTEGRITY');
  if (new Set(packet.changes.map(entry => entry.path)).size !== packet.changes.length
      || canonicalJson(packet.changes.map(entry => entry.path).sort()) !== canonicalJson(packet.diff.map(entry => entry.path).sort())
      || packet.diff.some(entry => bytesHash(Buffer.from(entry.after)) !== entry.afterSha256
        || Buffer.byteLength(entry.before) > 262144 || Buffer.byteLength(entry.after) > 262144
        || entry.before.includes('\0') || entry.after.includes('\0')
        || (entry.status === 'added' && (entry.beforeSha256 !== null || entry.before !== ''))
        || (entry.status === 'modified' && entry.beforeSha256 === null)
        || (entry.beforeSha256 !== null && bytesHash(Buffer.from(entry.before)) !== entry.beforeSha256))) {
    fail('Appeal paths or before/after bytes do not match the packet.', 'PHASE_APPEAL_INTEGRITY');
  }
  if (packet.diff.reduce((sum, entry) => sum + Buffer.byteLength(entry.before) + Buffer.byteLength(entry.after), 0) > 2 * 1024 * 1024) fail('Appeal diff exceeds its retained byte budget.', 'PHASE_APPEAL_INTEGRITY');
  if (Buffer.byteLength(canonicalJson(packet)) > 3 * 1024 * 1024) fail('The encoded appeal exceeds its retained byte budget. Split this review.', 'PHASE_APPEAL_TOO_LARGE');
  return packet;
}

function generation(phase) {
  return phase.generationIntent?.status === 'open' ? Number(phase.generationIntent.generation)
    : phase.status === 'in_progress' && !phase.generationIntent ? nextPhaseGeneration(phase) : Math.max(1, Number(phase.generation));
}
async function currentBinding(root, config, workflow, phase, plan) {
  return { workId: workflow.workItem.id, phaseId: phase.id, generation: generation(phase),
    intentId: phase.generationIntent?.id ?? null,
    policySha256: hash({ resolution: workflow.resolution, policy: phase.approvalPolicy, boundary: phase.sourceBoundary }),
    planSha256: hash({ plan, amendments: workflow.planAmendments ?? [] }),
    sourceSha256: await sourceTreeHash(root, config, workflow), testInputSha256: await testInputTreeHash(root, config, workflow),
    evidenceSha256: hash({ checks: phase.checks ?? [], testPolicy: workflow.testPolicy ?? null,
      deliveryEvidence: phase.deliveryEvidence ?? null }) };
}
const activePlan = async (root, config, workflow) => mergePlannedClaimRecords(
  (await loadActiveSpecRecords(workDir(root, config, workflow.workItem.id), workflow)).planned ?? []);

/** Does not run tests, alter source, stage files or infer that Copilot authored a diff. */
export async function preparePhaseAppeal(root, config, workflow, { phaseId = workflow.currentPhase, changes, reason } = {}) {
  const phase = workflow.phases?.[phaseId];
  if (!phase || phaseId !== workflow.currentPhase || workflow.status !== 'in_progress'
      || phase.status !== 'in_progress' || !phaseRequiresCodeDelivery(phase)
      || phase.writeScope !== 'source-and-artifact' || phase.generationIntent?.status !== 'open'
      || branch(root) !== workflow.workItem.branch) {
    fail('Scope appeals require the current open code-delivery generation. For published/submitted work, inspect recovery and create an authorized successor; do not rewrite history.', 'PHASE_APPEAL_LIFECYCLE',
      { recoveryCommand: `singularity-flow recover ${workflow.workItem.id} --phase ${phaseId ?? workflow.currentPhase} --json` });
  }
  const parsed = z.object({ changes: z.array(change).min(1).max(50), reason: text }).strict().safeParse({ changes, reason });
  if (!parsed.success) fail('List 1–50 unique exact portable paths and substantive reasons. Wildcards, traversal, controls and unknown fields are not allowed.');
  changes = parsed.data.changes; reason = parsed.data.reason;
  if (new Set(changes.map(entry => entry.path)).size !== changes.length) fail('An appeal cannot list a path twice.');
  const plan = await activePlan(root, config, workflow);
  if (!planAuthorities(workflow).length) fail('No pinned plan approval authority can account for these paths. Ask the workflow owner to configure one.', 'PHASE_APPEAL_AUTHORITY_UNAVAILABLE');
  // The existing closed amendment policy validates clause identities and supporting classes.
  recordPlanAmendment(structuredClone(workflow), { changes, reason, actor: actorKey(identity(root)), authorityGroup: 'preview', at: nowIso(), plan });
  const intent = await verifyOpenGenerationIntent(root, workflow, phase);
  const set = applicationChangeSetProjection(await buildRepositoryChangeSet(root, { baseCommit: intent.baseline.commit }), applicationPathContext(config, workflow));
  const protectedViolations = evaluateProtectedPaths(set, [
    ...(config.governance?.protectedPaths ?? []), ...(workflow.resolution?.capability?.policy?.protectedPaths ?? [])
  ]).violations;
  const outside = evaluateSourceBoundary(set, phase.sourceBoundary ?? 'unrestricted', { phaseId, allowedPath: isTestAutomationPath }).violations;
  const diff = [];
  let total = 0;
  for (const entry of changes) {
    const selected = set.entries.find(item => item.newPath === entry.path);
    if (!selected || !['added', 'modified'].includes(selected.status) || selected.newContent?.kind !== 'regular-file'
        || protectedViolations.some(item => item.path === entry.path) || outside.some(item => item.path === entry.path)) {
      fail(`Cannot account for '${entry.path}' here. Governance/protected paths, boundary changes, links, renames and deletions require the owning configuration or reviewed recovery process.`, 'PHASE_APPEAL_PATH_UNSUPPORTED');
    }
    const secured = await secureRepositoryPath(root, entry.path, { mustExist: true, type: 'file', label: 'Appealed file' });
    if (secured.entry.size > 262144) fail('An appealed file exceeds 256 KiB. Split the review; never truncate an approved diff.', 'PHASE_APPEAL_TOO_LARGE');
    const after = await boundedFile(root, entry.path, 262144, 'Appealed file');
    const before = exactFileAtObject(root, intent.baseline.commit, entry.path, { maximumBytes: 262144 }) ?? Buffer.alloc(0);
    if (after.includes(0) || before.includes(0) || !Buffer.from(after.toString('utf8')).equals(after) || !Buffer.from(before.toString('utf8')).equals(before)) {
      fail('Binary or non-UTF-8 changes require a separate qualified review; they are not silently omitted.', 'PHASE_APPEAL_PATH_UNSUPPORTED');
    }
    total += after.length + before.length;
    if (total > 2 * 1024 * 1024) fail('Appeal diff exceeds 2 MiB. Split it into bounded reviews.', 'PHASE_APPEAL_TOO_LARGE');
    diff.push({ path: entry.path, status: selected.status, beforeSha256: selected.status === 'added' ? null : bytesHash(before),
      afterSha256: bytesHash(after), before: before.toString('utf8'), after: after.toString('utf8') });
  }
  const binding = await currentBinding(root, config, workflow, phase, plan);
  const value = { schemaVersion: currentSchemaVersion('phase-appeal'), kind: 'phase-appeal', id: `APL-${hash({ binding, changes, reason, diff }).slice(7, 31)}`,
    binding, changes, reason, diff, author: { actor: actorKey(identity(root)), provenance: 'configured-git-identity-not-proof-of-tool-authorship' },
    baseCommit: intent.baseline.commit, capturedHead: head(root), requestedDisposition: 'account-scope',
    limitations: ['Scope accounting claims no new requirement or passing test.', 'Existing phase, test, traceability and independent-review gates still apply.',
      'An authorized human reviews the exact bytes. This does not prove independent tool authorship.', 'Intent changes and risk decisions use their separate governed workflows.'] };
  return validatePhaseAppeal({ ...value, packetSha256: hash(value) });
}

export function renderPhaseAppeal(packet) {
  validatePhaseAppeal(packet);
  const escape = value => String(value).replaceAll('`', '\\`').replaceAll('<', '&lt;');
  return `# Phase appeal ${packet.id}\n\nStory: ${escape(packet.binding.workId)} · Phase: ${escape(packet.binding.phaseId)} · Generation: ${packet.binding.generation}\n\n`
    + `Packet: ${packet.packetSha256}\n\n## Reason\n\n${escape(packet.reason)}\n\n## Exact changes\n\n`
    + packet.diff.map(entry => `- ${escape(entry.path)}: ${entry.beforeSha256 ?? 'new file'} → ${entry.afterSha256}`).join('\n')
    + `\n\n## Validation and review\n\nNo tests were run by this appeal. Review the before/after bytes in packet.json; all normal publication tests and code reviews remain required.\n\n`
    + `## Limits\n\n${packet.limitations.map(item => `- ${item}`).join('\n')}\n`;
}
const relative = (config, workflow, id, name) => path.posix.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, 'appeals', id, name);
async function immutable(root, file, contents) {
  const secured = await secureRepositoryPath(root, file, { type: 'file', label: 'Immutable phase appeal' });
  if (secured.exists) fail('An appeal record already exists. Inspect the retained transaction; never overwrite it.', 'PHASE_APPEAL_CONFLICT');
  await mkdir(path.dirname(secured.absolute), { recursive: true });
  await writeText(secured.absolute, contents);
}
export async function submitPhaseAppeal(root, config, workflow, options) {
  const packet = await preparePhaseAppeal(root, config, workflow, options);
  const existing = (workflow.phaseAppeals ?? []).find(entry => entry.id === packet.id);
  if (existing && options.confirm === existing.packetSha256) {
    await verifyRetained(root, config, workflow, existing);
    return { status: 'already-submitted', packet: existing, stateChanged: false };
  }
  if (options.confirm !== packet.packetSha256) fail('Confirm the exact current appeal packet hash after reviewing its diff.', 'PHASE_APPEAL_STALE');
  if (existing) fail('This candidate already has a retained packet. Review its existing hash; do not rewrite it.', 'PHASE_APPEAL_CONFLICT');
  const actor = identity(root);
  const { publication } = await transactStory(root, config, workflow, { type: LIFECYCLE_EVENT.EVIDENCE_RECORDED,
    phaseId: packet.binding.phaseId, generation: packet.binding.generation, actor, agent: null,
    payload: { kind: 'phase-appeal', packetSha256: packet.packetSha256 } }, `[${workflow.workItem.id}][appeal] ${packet.id}`,
  async aggregate => {
    await assertNoPendingPublication(root, config, aggregate, 'submit a phase appeal');
    const fresh = await preparePhaseAppeal(root, config, aggregate, options);
    if (fresh.packetSha256 !== packet.packetSha256) fail('Source, policy, plan or evidence changed during capture. Review a fresh packet.', 'PHASE_APPEAL_STALE');
    await immutable(root, relative(config, aggregate, packet.id, 'packet.json'), canonicalJson(packet));
    await immutable(root, relative(config, aggregate, packet.id, 'appeal.md'), renderPhaseAppeal(packet));
    aggregate.phaseAppeals ??= []; aggregate.phaseAppeals.push(packet);
    aggregate.history.push({ at: nowIso(), actor: actorKey(actor), agent: null, event: 'phase_appeal_submitted', phase: packet.binding.phaseId, detail: packet.id });
  }, { exactWorkItemPaths: [relative(config, workflow, packet.id, 'packet.json'), relative(config, workflow, packet.id, 'appeal.md')] });
  return { status: 'submitted', packet, publication, stateChanged: true };
}

async function verifyRetained(root, config, workflow, packet) {
  validatePhaseAppeal(packet);
  const file = relative(config, workflow, packet.id, 'packet.json');
  const secured = await secureRepositoryPath(root, file, { mustExist: true, type: 'file', label: 'Retained appeal' });
  if (secured.entry.size > 3 * 1024 * 1024 + 65536) fail('Retained appeal exceeds its byte budget.', 'PHASE_APPEAL_INTEGRITY');
  const bytes = await boundedFile(root, file, 3 * 1024 * 1024 + 65536, 'Retained appeal');
  const committed = exactFileAtObject(root, head(root), file, { maximumBytes: 3 * 1024 * 1024 });
  if (!retainedRecordBytesMatch(bytes, committed, packet)) fail('Retained appeal bytes are uncommitted or altered.', 'PHASE_APPEAL_INTEGRITY');
}

/** Only JSON transport CRLF is normalized. Embedded source strings and Git canonical bytes stay exact. */
function retainedRecordBytesMatch(bytes, committed, record) {
  const canonical = canonicalJson(record); const rendered = bytes.toString('utf8');
  return Buffer.from(rendered).equals(bytes) && committed?.equals(Buffer.from(canonical))
    && rendered.replaceAll('\r\n', '\n') === canonical;
}

/** Pending/stale appeals remain visible; a request for changes cannot suppress the underlying gate. */
export async function phaseAppealStatus(root, config, workflow, phase = null) {
  if ((workflow.phaseAppeals !== undefined && !Array.isArray(workflow.phaseAppeals))
      || (workflow.phaseAppealDecisions !== undefined && !Array.isArray(workflow.phaseAppealDecisions))) fail('Appeal state must be append-only lists.', 'PHASE_APPEAL_INTEGRITY');
  const packets = workflow.phaseAppeals ?? [];
  if (new Set(packets.map(packet => packet.id)).size !== packets.length
      || (workflow.phaseAppealDecisions ?? []).some(record => !PhaseAppealDecisionSchema.safeParse(record).success
        || !packets.some(packet => packet.id === record.appealId))) fail('Duplicate appeals, orphan decisions or invalid decision schemas are not authority.', 'PHASE_APPEAL_INTEGRITY');
  const items = [];
  for (const packet of workflow.phaseAppeals ?? []) {
    if (phase && packet.binding?.phaseId !== phase.id) continue;
    await verifyRetained(root, config, workflow, packet);
    const decision = (workflow.phaseAppealDecisions ?? []).filter(entry => entry.appealId === packet.id).at(-1) ?? null;
    if (decision) {
      if ((workflow.phaseAppealDecisions ?? []).filter(entry => entry.appealId === packet.id).length !== 1
          || !['account-scope', 'request-changes'].includes(decision.decision)
          || decision.packetSha256 !== packet.packetSha256 || decision.testsWaived !== false || decision.phaseApproved !== false
          || !decision.actor || !decision.authorityGroup || !decision.authorizationId
          || decision.reviewAssurance !== 'live-terminal-exact-diff-review') fail('The appeal decision has invalid authority/binding fields.', 'PHASE_APPEAL_INTEGRITY');
      const file = relative(config, workflow, packet.id, 'decision.json');
      const safe = await secureRepositoryPath(root, file, { mustExist: true, type: 'file', label: 'Retained appeal decision' });
      if (safe.entry.size > 16384) fail('Appeal decision exceeds its byte limit.', 'PHASE_APPEAL_INTEGRITY');
      const bytes = await boundedFile(root, file, 16384, 'Retained appeal decision');
      const committed = exactFileAtObject(root, head(root), file, { maximumBytes: 16384 });
      if (!retainedRecordBytesMatch(bytes, committed, decision)) fail('The appeal decision is not the exact committed record.', 'PHASE_APPEAL_INTEGRITY');
      if (decision.decision === 'account-scope') {
        const amendment = (workflow.planAmendments ?? []).find(entry => entry.id === decision.amendmentId);
        if (!amendment || canonicalJson(amendment.changes) !== canonicalJson(packet.changes)
            || amendment.actor !== decision.actor || amendment.authorityGroup !== decision.authorityGroup) fail('Scope accounting lacks its bound authorized plan amendment.', 'PHASE_APPEAL_INTEGRITY');
      }
    }
    const current = workflow.phases?.[packet.binding.phaseId];
    const relevant = current && workflow.currentPhase === current.id && ['in_progress', 'awaiting_approval'].includes(current.status)
      && packet.binding.generation === generation(current);
    let status = decision?.decision ?? (relevant ? 'needs-human' : 'historical');
    if (relevant && decision && !await humanReviewOriginPresent(root, decision)) status = 'needs-reattestation';
    if (relevant && decision?.decision === 'request-changes') {
      const unchanged = await Promise.all(packet.diff.map(async entry => {
        const safe = await secureRepositoryPath(root, entry.path, { type: 'file', label: 'Requested correction' });
        return safe.exists && safe.entry.size <= 262144 && bytesHash(await boundedFile(root, entry.path, 262144, 'Requested correction')) === entry.afterSha256;
      }));
      if (unchanged.some(Boolean) && status !== 'needs-reattestation') status = 'correction-required';
    }
    items.push({ id: packet.id, packetSha256: packet.packetSha256, phaseId: packet.binding.phaseId,
      generation: packet.binding.generation, status,
      relevant, decision, decisionSha256: decision ? hash(decision) : null,
      path: relative(config, workflow, packet.id, 'appeal.md'), changes: packet.changes,
      command: `singularity-flow appeal show ${packet.id} --json`, skill: '/sf-appeal' });
  }
  return { status: items.some(entry => entry.relevant && ['needs-human', 'correction-required', 'needs-reattestation'].includes(entry.status)) ? 'needs-human' : 'ready', items };
}

export async function assertPhaseAppealsResolved(root, config, workflow, phase) {
  if (workflow.phaseAppeals === undefined && workflow.phaseAppealDecisions === undefined) return;
  const status = await phaseAppealStatus(root, config, workflow, phase);
  if (status.status !== 'ready') fail('This phase has an unresolved exact-diff appeal. Review it, account for eligible scope, or request changes and repair the original finding. No check was waived.', 'PHASE_APPEAL_REVIEW_REQUIRED',
    { appeals: status.items, recoveryCommand: `singularity-flow appeal list --phase ${phase.id} --json`, skill: '/sf-appeal' });
}

/** The same exact card is consumed inside the locked/journaled Story transaction. */
export async function decidePhaseAppeal(root, config, workflow, { id, decision, reason, confirm } = {}) {
  if (!['account-scope', 'request-changes'].includes(decision) || !text.safeParse(reason).success) fail('Choose account-scope or request-changes and give a substantive reason. Risk and intent approvals are separate.');
  const packet = (workflow.phaseAppeals ?? []).find(entry => entry.id === id);
  if (!packet) fail('No retained appeal has that exact ID.', 'PHASE_APPEAL_NOT_FOUND');
  await verifyRetained(root, config, workflow, packet);
  if (confirm !== packet.packetSha256) fail('Review and confirm the exact retained packet hash.', 'PHASE_APPEAL_STALE');
  if ((workflow.phaseAppealDecisions ?? []).some(entry => entry.appealId === id)) fail('This immutable appeal already has a decision. Prepare a successor packet for changed work.', 'PHASE_APPEAL_ALREADY_DECIDED');
  const phase = workflow.phases[packet.binding.phaseId];
  if (workflow.currentPhase !== phase.id || phase.status !== 'in_progress' || generation(phase) !== packet.binding.generation) fail('Use authorized recovery before deciding an appeal outside the current open generation.', 'PHASE_APPEAL_LIFECYCLE');
  if (decision === 'account-scope') {
    const fresh = await preparePhaseAppeal(root, config, workflow, { phaseId: phase.id, changes: packet.changes, reason: packet.reason });
    // Appeal publication is a metadata-only commit: capturedHead is observational, not source freshness.
    if (canonicalJson(fresh.binding) !== canonicalJson(packet.binding) || canonicalJson(fresh.diff) !== canonicalJson(packet.diff)) fail('Appealed source, test inputs, policy, plan or evidence changed. Request changes and prepare a fresh packet.', 'PHASE_APPEAL_STALE');
  }
  const actor = identity(root);
  const groups = planAuthorities(workflow);
  if (!groups.length) fail('This Story has no pinned plan authority. Preserve the appeal and ask the configuration owner.', 'PHASE_APPEAL_AUTHORITY_UNAVAILABLE');
  const authority = requireApprovalAuthority(workflow.resolution?.approvalAuthorities ?? config.approvalAuthorities,
    { mode: 'required', authorities: groups, requiredAuthorities: [], minimum: 1 }, actor);
  const card = { plan: { planId: id, planHash: hash({ packet: packet.packetSha256, decision, reason, actor, authority }),
    subject: { workId: workflow.workItem.id, phaseId: phase.id }, revision: head(root), packet, decision, reason,
    testsWaived: false, phaseApproved: false }, action: { actionId: `${id}-${decision}`, confirmation: { required: true } } };
  const grant = await captureTerminalActionAuthorization(root, card.plan, card.action, { label: `Review ${id}` });
  if (!grant) return { status: 'cancelled', stateChanged: false };
  const { value, publication } = await transactStory(root, config, workflow, { type: LIFECYCLE_EVENT.DECISION_MADE,
    phaseId: phase.id, generation: packet.binding.generation, actor, agent: null,
    authorityGroup: authority.authorityGroup, payload: { decision: 'phase-appeal', appealId: id, packetSha256: packet.packetSha256 } },
  `[${workflow.workItem.id}][appeal:${decision}] ${id}`, async aggregate => {
    await assertNoPendingPublication(root, config, aggregate, 'decide a phase appeal');
    if (decision === 'account-scope') {
      const fresh = await preparePhaseAppeal(root, config, aggregate, { phaseId: phase.id, changes: packet.changes, reason: packet.reason });
      if (canonicalJson(fresh.binding) !== canonicalJson(packet.binding) || canonicalJson(fresh.diff) !== canonicalJson(packet.diff)) fail('Candidate changed during human review.', 'PHASE_APPEAL_STALE');
    }
    let amendment = null;
    if (decision === 'account-scope') amendment = recordPlanAmendment(aggregate, { changes: packet.changes, reason,
      actor: actorKey(actor), authorityGroup: authority.authorityGroup, identityAssurance: authority.identityAssurance ?? null,
      at: nowIso(), plan: await activePlan(root, config, aggregate) });
    const record = PhaseAppealDecisionSchema.parse({ schemaVersion: currentSchemaVersion('phase-appeal-decision'), kind: 'phase-appeal-decision', appealId: id, packetSha256: packet.packetSha256,
      decision, reason, actor: actorKey(actor), authorityGroup: authority.authorityGroup,
      identityAssurance: authority.identityAssurance ?? null, reviewAssurance: 'live-terminal-exact-diff-review',
      authorizationId: grant.authorizationId, amendmentId: amendment?.id ?? null, at: nowIso(), testsWaived: false, phaseApproved: false });
    await consumeAndRetainHumanReview(root, record, card, grant.token);
    await immutable(root, relative(config, aggregate, id, 'decision.json'), canonicalJson(record));
    aggregate.phaseAppealDecisions ??= []; aggregate.phaseAppealDecisions.push(record);
    aggregate.history.push({ at: record.at, actor: record.actor, agent: null, event: 'phase_appeal_decided', phase: phase.id, detail: `${id}: ${decision}` });
    return record;
  }, { exactWorkItemPaths: [relative(config, workflow, id, 'decision.json')] });
  return { status: decision, decision: value, publication, stateChanged: true,
    next: `singularity-flow phase prepublish ${phase.id} --json`, testsWaived: false, phaseApproved: false };
}

/** Clone/key loss is recoverable without rewriting a historical packet or pretending host proof travelled in Git. */
export async function attestPhaseAppeal(root, config, workflow, { id, confirm } = {}) {
  await phaseAppealStatus(root, config, workflow);
  const record = (workflow.phaseAppealDecisions ?? []).find(entry => entry.appealId === id);
  const packet = (workflow.phaseAppeals ?? []).find(entry => entry.id === id);
  if (!record || !packet) fail('Choose an appeal with a retained human decision.', 'PHASE_APPEAL_NOT_FOUND');
  if (confirm !== hash(record)) fail('Confirm the exact retained decision hash from appeal show.', 'PHASE_APPEAL_STALE');
  const actor = identity(root);
  requireApprovalAuthority(workflow.resolution?.approvalAuthorities ?? config.approvalAuthorities,
    { mode: 'required', authorities: [record.authorityGroup], requiredAuthorities: [], minimum: 1 }, actor);
  const card = { plan: { planId: `attest-${id}`, planHash: hash(record), subject: { workId: workflow.workItem.id, phaseId: packet.binding.phaseId },
    revision: head(root), record, packet, reviewer: actorKey(actor) }, action: { actionId: `attest-${id}`, confirmation: { required: true } } };
  const grant = await captureTerminalActionAuthorization(root, card.plan, card.action, { label: `Re-review ${id}` });
  if (!grant) return { status: 'cancelled', stateChanged: false };
  await verifyRetained(root, config, workflow, packet);
  await phaseAppealStatus(root, config, workflow);
  await consumeAndRetainHumanReview(root, record, card, grant.token);
  return { status: 'review-origin-restored', stateChanged: false, localFilesChanged: true, historicalRecordsChanged: false,
    next: `singularity-flow appeal preflight --phase ${packet.binding.phaseId} --json` };
}
