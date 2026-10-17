/**
 * The build engine: proposals, decisions, answers, the check and finishing.
 *
 * - `propose` records one proposal (moves, why, the lines it relied on, the items it uses) and any
 *   questions. Its moves are checked against the repository and the build's draft, and the whole
 *   draft with them must still make a configuration Workflow Studio can save.
 * - `decide` accepts or declines a proposal; only a person decides. Accepting checks it again
 *   against the current draft, so a proposal an earlier one overtook is marked stale, not applied.
 * - `answer` records a person's choice for a question.
 * - `check` explains and checks the workflow as the accepted moves leave it (workflow check on the
 *   staged configuration) and says which found items are not used or left out yet.
 * - `finish` writes nothing itself: `--propose` runs Workflow Studio's own apply with the build's
 *   change set, so the result is one reviewed proposal; `--out` writes a portable workflow bundle.
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { SingularityFlowError } from '../util.mjs';
import { applyMoves, initialDraft, invalidMoves, lowerDraft, validateMoves } from './moves.mjs';
import { readWorkflowBuild, saveWorkflowBuild, workflowBuildPaths, writePrivate } from './store.mjs';

const PROPOSAL_FIELDS = ['title', 'why', 'moves', 'evidence', 'items', 'questions'];
const QUESTION_FIELDS = ['question', 'choices', 'blocking', 'about'];

function fail(code, message, details = undefined) {
  throw new SingularityFlowError(message, { code, details });
}

const kebab = (value) => String(value ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 60);
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

async function withRepository(root, fn) {
  const { withApprovedConfigurationRead } = await import('../approved-configuration-reader.mjs');
  const { buildStudioModel } = await import('../workflow-studio.mjs');
  return withApprovedConfigurationRead(root, async () => fn(await buildStudioModel(root)), { preferAuthority: true });
}

/** The repository a build is for: the one it was started in, else the one this command runs in. */
function repositoryOf(record, root) {
  const chosen = record.repository?.root ?? root;
  if (!chosen) fail('WORKFLOW_BUILD_REPOSITORY_REQUIRED', 'This build has no repository yet. Run this inside the repository the workflow is for.');
  return chosen;
}

/** The ID of the workflow the build makes: from its name, not one the repository has. */
function targetWorkflow(record, model) {
  if (record.goal.workflow) return record.goal.workflow;
  const taken = new Set(model.workflows.map((workflow) => workflow.id));
  const stem = kebab(record.goal.label) || 'new-workflow';
  let id = stem;
  for (let index = 2; taken.has(id); index += 1) id = `${stem}-${index}`;
  return id;
}

export function draftOf(record, model) {
  return record.proposals.filter((proposal) => proposal.status === 'accepted')
    .reduce((draft, proposal) => applyMoves(draft, proposal.moves), initialDraft(record, model));
}

function validateProposal(payload, record) {
  const findings = [];
  const add = (at, code, message) => findings.push({ at, code, message });
  if (!plain(payload)) { add('$', 'BUILD_PROPOSAL_SHAPE', 'A proposal is an object with title, why, moves, evidence, items and questions.'); return findings; }
  for (const field of Object.keys(payload)) if (!PROPOSAL_FIELDS.includes(field)) add(field, 'BUILD_PROPOSAL_FIELD_UNKNOWN', `A proposal has no field '${field}'.`);
  const moves = payload.moves ?? [];
  const questions = payload.questions ?? [];
  if (!Array.isArray(moves) || !Array.isArray(questions)) add('$', 'BUILD_PROPOSAL_SHAPE', 'moves and questions are lists.');
  if (!moves.length && !questions.length) add('moves', 'BUILD_PROPOSAL_EMPTY', 'A proposal has at least one move or one question.');
  if (moves.length && (typeof payload.title !== 'string' || !payload.title.trim() || payload.title.length > 120)) add('title', 'BUILD_PROPOSAL_SHAPE', 'title says the piece in one line of at most 120 characters.');
  if (moves.length && (typeof payload.why !== 'string' || !payload.why.trim() || payload.why.length > 2000)) add('why', 'BUILD_PROPOSAL_SHAPE', 'why says, in plain words, why this piece belongs in the workflow.');
  const files = new Map((record.capture?.files ?? []).map((file) => [file.path, file]));
  (Array.isArray(payload.evidence) ? payload.evidence : payload.evidence == null ? [] : [null]).forEach((span, index) => {
    const at = `evidence[${index}]`;
    if (!plain(span) || typeof span.path !== 'string') { add(at, 'BUILD_EVIDENCE_SHAPE', `${at} is { path, startLine, endLine } from the build's capture.`); return; }
    if (span.path.startsWith('configuration:')) return;
    const file = files.get(span.path);
    if (!file) { add(`${at}.path`, 'BUILD_EVIDENCE_UNKNOWN', `'${span.path}' is not a file this build captured.`); return; }
    if (file.screening !== 'clean') add(`${at}.path`, 'BUILD_EVIDENCE_WITHHELD', `'${span.path}' was withheld; it cannot be evidence.`);
    if (!Number.isInteger(span.startLine) || !Number.isInteger(span.endLine) || span.startLine < 1 || span.endLine < span.startLine || span.endLine > (file.lines ?? 0)) {
      add(`${at}`, 'BUILD_EVIDENCE_SPAN', `Lines ${span.startLine}-${span.endLine} are not inside '${span.path}' (1-${file.lines ?? 0}).`);
    }
  });
  const items = new Set(record.items.map((entry) => entry.id));
  for (const [index, item] of (Array.isArray(payload.items) ? payload.items : []).entries()) {
    if (!items.has(item)) add(`items[${index}]`, 'BUILD_ITEM_UNKNOWN', `The build has no item '${item}'.`);
  }
  for (const [index, move] of (Array.isArray(moves) ? moves : []).entries()) {
    if (plain(move) && String(move.move).startsWith('item.') && !items.has(move.item)) add(`moves[${index}].item`, 'BUILD_ITEM_UNKNOWN', `The build has no item '${move.item}'.`);
  }
  for (const [index, question] of (Array.isArray(questions) ? questions : []).entries()) {
    const at = `questions[${index}]`;
    if (!plain(question)) { add(at, 'BUILD_QUESTION_SHAPE', `${at} is { question, choices, blocking }.`); continue; }
    for (const field of Object.keys(question)) if (!QUESTION_FIELDS.includes(field)) add(`${at}.${field}`, 'BUILD_QUESTION_SHAPE', `A question has no field '${field}'.`);
    if (typeof question.question !== 'string' || !question.question.trim() || question.question.length > 400) add(`${at}.question`, 'BUILD_QUESTION_SHAPE', 'question is one sentence of at most 400 characters.');
    if (!Array.isArray(question.choices) || question.choices.length < 2 || question.choices.length > 8
        || question.choices.some((choice) => typeof choice !== 'string' || !choice.trim() || choice.length > 200)) add(`${at}.choices`, 'BUILD_QUESTION_CHOICES', 'Offer 2 to 8 concrete choices.');
    if (typeof question.blocking !== 'boolean') add(`${at}.blocking`, 'BUILD_QUESTION_SHAPE', 'blocking is true when the workflow cannot be finished without the answer.');
  }
  return findings;
}

/** The plan for a draft, refused with the Studio's own problems when it could not be saved. */
async function planFor(root, draft, model, { inspect = null } = {}) {
  const { planStudioChangeSet } = await import('../workflow-studio.mjs');
  const changeSet = lowerDraft(draft, model);
  if (!changeSet.changes.length) return { changeSet, plan: { valid: true, changed: false, problems: [], warnings: [], summary: [], files: [] } };
  return { changeSet, plan: await planStudioChangeSet(root, changeSet, { inspect }) };
}

function turn(by, kind, text, extra = {}) {
  return { at: new Date().toISOString(), by, kind, text, ...extra };
}

/** Record a proposal and its questions; see the module comment. */
export async function proposeToBuild(id, payload, { root = null, by = 'copilot', env = process.env } = {}) {
  if (!['copilot', 'you'].includes(by)) fail('WORKFLOW_BUILD_USAGE', "A proposal is by copilot or you.");
  const record = await readWorkflowBuild(id, { env });
  const shape = validateProposal(payload, record);
  if (shape.length) throw invalidMoves(shape);
  const repository = repositoryOf(record, root);
  const moves = payload.moves ?? [];
  await withRepository(repository, async (model) => {
    record.repository ??= { root: repository, label: path.basename(repository) };
    record.goal.workflow = targetWorkflow(record, model);
    const draft = draftOf(record, model);
    const findings = validateMoves(moves, { model, draft });
    if (findings.length) throw invalidMoves(findings);
    if (moves.some((move) => !move.move.startsWith('item.'))) {
      const { plan } = await planFor(repository, applyMoves(draft, moves), model);
      if (!plan.valid) throw invalidMoves(plan.problems.map((problem) => ({ at: 'workflow', code: problem.code, message: problem.message })));
    }
  });
  const proposal = moves.length ? {
    id: `p-${record.proposals.length + 1}`, by, title: payload.title.trim(), why: payload.why.trim(), moves,
    evidence: payload.evidence ?? [], items: payload.items ?? [], status: 'pending', createdAt: new Date().toISOString()
  } : null;
  if (proposal) {
    record.proposals.push(proposal);
    record.conversation.push(turn(by, 'proposal', proposal.title, { proposal: proposal.id }));
  }
  const questions = (payload.questions ?? []).map((question, index) => ({
    id: `q-${record.questions.length + index + 1}`, by, question: question.question.trim(), choices: question.choices.map((choice) => choice.trim()),
    blocking: question.blocking, ...(question.about ? { about: question.about } : {}), createdAt: new Date().toISOString()
  }));
  for (const question of questions) {
    record.questions.push(question);
    record.conversation.push(turn(by, 'question', question.question, { question: question.id }));
  }
  const saved = await saveWorkflowBuild(record, { env });
  return { record: saved, proposal, questions };
}

/** Accept or decline a pending proposal; a person decides. */
export async function decideInBuild(id, proposalId, { accept, reason = null, root = null, env = process.env } = {}) {
  const record = await readWorkflowBuild(id, { env });
  const proposal = record.proposals.find((entry) => entry.id === proposalId);
  if (!proposal) fail('WORKFLOW_BUILD_PROPOSAL_UNKNOWN', `Build ${id} has no proposal '${proposalId}'.`);
  if (proposal.status !== 'pending') fail('WORKFLOW_BUILD_PROPOSAL_DECIDED', `Proposal ${proposalId} is already ${proposal.status}.`);
  const now = new Date().toISOString();
  if (!accept) {
    Object.assign(proposal, { status: 'declined', decidedAt: now, ...(reason ? { reason } : {}) });
    record.conversation.push(turn('you', 'decision', `Declined ${proposal.title}${reason ? `: ${reason}` : '.'}`, { proposal: proposalId }));
    return saveWorkflowBuild(record, { env });
  }
  const repository = repositoryOf(record, root);
  let stale = null;
  await withRepository(repository, async (model) => {
    const draft = draftOf(record, model);
    const findings = validateMoves(proposal.moves, { model, draft });
    if (!findings.length && proposal.moves.some((move) => !move.move.startsWith('item.'))) {
      const { plan } = await planFor(repository, applyMoves(draft, proposal.moves), model);
      if (!plan.valid) findings.push(...plan.problems.map((problem) => ({ at: 'workflow', code: problem.code, message: problem.message })));
    }
    if (findings.length) stale = findings;
  });
  if (stale) {
    Object.assign(proposal, { status: 'stale', decidedAt: now, findings: stale });
    record.conversation.push(turn('sflow', 'decision', `${proposal.title} no longer fits the workflow: ${stale[0].message}`, { proposal: proposalId }));
    await saveWorkflowBuild(record, { env });
    fail('WORKFLOW_BUILD_PROPOSAL_STALE', `Proposal ${proposalId} no longer fits what the build has accepted since: ${stale[0].message} Ask for a new proposal.`, { findings: stale });
  }
  Object.assign(proposal, { status: 'accepted', decidedAt: now });
  const used = new Set(proposal.items);
  for (const item of record.items) {
    const change = applyMoves({ items: {}, workflow: { phases: [], decisions: [] }, steps: {}, overrides: {}, actions: {} }, proposal.moves.filter((move) => move.item === item.id)).items[item.id];
    if (change) Object.assign(item, change);
    else if (used.has(item.id) && item.status === 'open') item.status = 'confirmed';
  }
  record.conversation.push(turn('you', 'decision', `Accepted ${proposal.title}.`, { proposal: proposalId }));
  return saveWorkflowBuild(record, { env });
}

/** Record a person's answer to a question. */
export async function answerInBuild(id, questionId, choice, { env = process.env } = {}) {
  const record = await readWorkflowBuild(id, { env });
  const question = record.questions.find((entry) => entry.id === questionId);
  if (!question) fail('WORKFLOW_BUILD_QUESTION_UNKNOWN', `Build ${id} has no question '${questionId}'.`);
  const chosen = question.choices.find((entry) => entry.toLowerCase() === String(choice ?? '').trim().toLowerCase());
  if (!chosen) fail('WORKFLOW_BUILD_ANSWER_INVALID', `'${choice}' is not one of: ${question.choices.map((entry) => `'${entry}'`).join(', ')}.`);
  question.answer = { choice: chosen, at: new Date().toISOString() };
  record.conversation.push(turn('you', 'answer', `${question.question} ${chosen}`, { question: questionId }));
  return saveWorkflowBuild(record, { env });
}

/** Found items that are not used or left out yet, as one onboarding finding. */
function onboardingFindings(record) {
  const open = record.items.filter((entry) => entry.foundBy !== 'workflow' && entry.status === 'open' && entry.kind !== 'withheld');
  if (!open.length) return [];
  const listed = open.slice(0, 8).map((entry) => `${entry.name} (${entry.kind})`).join(', ');
  return [{
    id: 'f-onboarding-open', code: 'BUILD_ITEMS_OPEN', area: 'onboarding', severity: 'warning',
    title: `${open.length} ${open.length === 1 ? 'thing' : 'things'} found in the material ${open.length === 1 ? 'is' : 'are'} not used or left out yet`,
    detail: `${listed}${open.length > 8 ? `, and ${open.length - 8} more` : ''}.`,
    fix: { text: 'Use each one in a proposal, or leave it out with a reason (item.leaveOut).' }, subject: {}
  }];
}

/** Explain and check the workflow as the accepted moves leave it. Writes nothing to a repository. */
export async function checkBuild(id, { root = null, env = process.env } = {}) {
  const record = await readWorkflowBuild(id, { env });
  const repository = repositoryOf(record, root);
  const { checkWorkflowConfiguration } = await import('../workflow-check.mjs');
  const result = await withRepository(repository, async (model) => {
    record.goal.workflow = targetWorkflow(record, model);
    const draft = draftOf(record, model);
    const workflowId = draft.workflow.id;
    const { changeSet, plan } = await planFor(repository, draft, model,
      { inspect: (candidate) => checkWorkflowConfiguration(candidate, { workflows: [workflowId] }) });
    return { draft, changeSet, plan };
  });
  const { draft, changeSet, plan } = result;
  const inspection = plan.inspection ?? null;
  const onboarding = onboardingFindings(record);
  const findings = [...(inspection?.workflows?.[0]?.findings ?? []), ...onboarding];
  const counts = Object.fromEntries(['problem', 'warning', 'note'].map((severity) => [severity, findings.filter((entry) => entry.severity === severity).length
    + (severity === 'problem' ? plan.problems.length : 0)]));
  const openQuestions = record.questions.filter((question) => !question.answer);
  const ready = Boolean(draft.workflow.phases.length) && plan.valid && counts.problem === 0 && !openQuestions.some((question) => question.blocking);
  record.check = { at: new Date().toISOString(), counts, ready };
  await saveWorkflowBuild(record, { env });
  return {
    schemaVersion: 1, resultType: 'workflow-build-check',
    build: { id: record.id, label: record.goal.label, workflow: draft.workflow.id },
    draft: { workflow: { id: draft.workflow.id, label: draft.workflow.label, phases: draft.workflow.phases, decisions: draft.workflow.decisions.length },
      newSteps: Object.keys(draft.steps), newAgents: Object.keys(draft.agents), newSkills: Object.keys(draft.skills),
      newInstructions: Object.keys(draft.instructions), newGroups: Object.keys(draft.groups) },
    changeSet,
    plan: { valid: plan.valid, problems: plan.problems, warnings: plan.warnings, summary: plan.summary, files: plan.files.map((file) => ({ path: file.path, action: file.action })) },
    explanation: inspection?.workflows?.[0]?.explanation ?? null,
    findings, counts,
    repositoryFindings: inspection?.repository?.findings ?? [],
    pending: record.proposals.filter((proposal) => proposal.status === 'pending').map((proposal) => ({ id: proposal.id, title: proposal.title, by: proposal.by })),
    questions: openQuestions,
    ready,
    guide: (await import('./moves.mjs')).movesGuide()
  };
}

/** Finish: one reviewed proposal through Workflow Studio's apply, or a portable bundle. */
export async function finishBuild(id, { propose = false, out = null, root = null, json = false, env = process.env } = {}) {
  if (Boolean(propose) === Boolean(out)) fail('WORKFLOW_BUILD_USAGE', 'Finish with --propose (one reviewed proposal) or --out FILE (a portable workflow bundle).');
  const result = await checkBuild(id, { root, env });
  if (!result.plan.valid || !result.changeSet.changes.length) {
    fail('WORKFLOW_BUILD_NOT_READY', result.changeSet.changes.length
      ? `The workflow cannot be saved yet: ${result.plan.problems[0]?.message}` : 'The build has no steps yet; accept a proposal that adds them first.');
  }
  const record = await readWorkflowBuild(id, { env });
  const repository = repositoryOf(record, root);
  const paths = await workflowBuildPaths(id, { env });
  if (out) {
    const { planStudioChangeSet } = await import('../workflow-studio.mjs');
    const { compileWorkflowBundle, readWorkflowBundle, writeWorkflowBundle } = await import('../workflow-transfer.mjs');
    let bundle = null;
    await withRepository(repository, () => planStudioChangeSet(repository, result.changeSet, {
      inspect: async (candidate) => { bundle = await compileWorkflowBundle(candidate, [result.build.workflow]); }
    }));
    const target = path.resolve(out);
    await writeWorkflowBundle(bundle, target);
    const reread = await readWorkflowBundle(target);
    record.finished = { at: new Date().toISOString(), kind: 'bundle', path: target, bundleSha256: reread.bundleSha256 };
    record.conversation.push(turn('sflow', 'finished', `Wrote the workflow bundle ${path.basename(target)}; import it with Workflow Studio's Import.`));
    await saveWorkflowBuild(record, { env });
    return { kind: 'bundle', path: target, bundleSha256: reread.bundleSha256, check: result };
  }
  // Studio's own apply: the same review, authority and saved drafts as Publish in Workflow Studio.
  const file = path.join(paths.directory, 'change-set.json');
  await writePrivate(file, `${JSON.stringify(result.changeSet, null, 2)}\n`);
  const previous = process.cwd();
  process.chdir(repository);
  try {
    await (await import('../commands/legacy.mjs')).run(['workflow', 'studio', 'apply', '--change-set', file, '--propose', ...(json ? ['--json'] : [])]);
  } finally { process.chdir(previous); }
  record.finished = { at: new Date().toISOString(), kind: 'proposal', changeSetSha256: `sha256:${(await import('node:crypto')).createHash('sha256').update(await readFile(file)).digest('hex')}` };
  record.conversation.push(turn('sflow', 'finished', 'Created one configuration proposal from this build. Review and activate it in Workflow Studio\'s Changes.'));
  await saveWorkflowBuild(record, { env });
  return { kind: 'proposal', check: result };
}
