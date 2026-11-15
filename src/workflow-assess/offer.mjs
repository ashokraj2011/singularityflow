/**
 * `workflow build start --assess ID`: the assessment's suggestions as a change build of that
 * workflow (SPEC-WIA). Each suggestion with moves is checked before it is offered: its moves must fit
 * like any proposal, Workflow Studio must be able to save what they leave, and `workflow check` and
 * the assessment run again on that result; one that would add a problem is listed with the reason
 * and not offered. Each offered one is a proposal by SFlow with the size and findings before and
 * after; a person accepts or declines each, or every one SFlow decided itself at once
 * (`acceptAllSflow`). Nothing changes until the build's proposal is reviewed and activated.
 */
import { createHash } from 'node:crypto';
import { SingularityFlowError } from '../util.mjs';
import { applyMoves, validateMoves } from '../workflow-build/moves.mjs';
import { draftOf, planFor, repositoryOf, withRepository } from '../workflow-build/engine.mjs';
import { readWorkflowBuild, saveWorkflowBuild } from '../workflow-build/store.mjs';

const candidateId = (finding, choice) => `ac-${createHash('sha256').update(JSON.stringify([finding, choice])).digest('hex').slice(0, 10)}`;
const problemKey = (entry) => JSON.stringify([entry.code, entry.subject?.step ?? entry.steps?.[0] ?? null, entry.location?.file ?? null, entry.quote ?? entry.title ?? null]);

/** What an assessment of one workflow says, in brief: its size and its counts. */
export function assessmentSummary(result) {
  const workflow = result?.workflows?.[0];
  if (!workflow) return null;
  return { bytes: workflow.size?.bytes ?? 0, tokens: workflow.size?.tokens ?? 0, teamBytes: workflow.size?.team?.bytes ?? 0, counts: workflow.counts, verdict: workflow.verdict?.level ?? null };
}

/** The problems `workflow check` and the assessment find in one workflow, by what they are about. */
function problemsOf(check, assessment) {
  return [...(check?.workflows?.[0]?.findings ?? []), ...(check?.repository?.findings ?? []).filter((entry) => entry.blocksStart),
    ...(assessment?.workflows?.[0]?.findings ?? [])].filter((entry) => entry.severity === 'problem');
}

// Moves that change only an agent's, a skill's or an instruction's text: `workflow check` judges none
// of it as a problem (flow, ownership, templates and configuration stay), so only the assessment runs.
const TEXT_ONLY = new Set(['agent.edit', 'skill.edit', 'instruction.edit']);

/**
 * The check and the assessment of the workflow as `draft` leaves it, staged; the repository's own
 * when the draft changes nothing. `moves` that change only text skip the check (TEXT_ONLY).
 */
async function staged(repository, draft, model, workflowId, moves = null) {
  const { checkWorkflowConfiguration } = await import('../workflow-check.mjs');
  const { assessWorkflows } = await import('./index.mjs');
  const checked = !moves || moves.some((move) => !TEXT_ONLY.has(move.move));
  const inspect = async (candidate) => {
    const check = checked ? await checkWorkflowConfiguration(candidate, { workflows: [workflowId] }) : null;
    return { check, assessment: await assessWorkflows(candidate, { workflows: [workflowId], applicationRoot: repository, model: check?.studioModel ?? null }) };
  };
  const { changeSet, plan } = await planFor(repository, draft, model, { inspect });
  if (!changeSet.changes.length) return { valid: true, ...(await inspect(repository)) };
  if (!plan.valid) return { valid: false, message: plan.problems[0]?.message ?? 'Workflow Studio cannot save it.' };
  return { valid: true, ...plan.inspection };
}

/**
 * The files text-only moves leave, as `{ file: text }` over the repository's own, or null when one
 * is not a plain edit of a file this build has not changed (a copy, an edit whose text occurs more
 * than once in the file): that one is staged instead.
 */
async function textOverlay(repository, model, draft, moves) {
  if (Object.values(draft.texts ?? {}).some((entry) => entry.edits.length) || moves.some((move) => !TEXT_ONLY.has(move.move) || move.copy)) return null;
  const { configurationReadRoot } = await import('../configuration-read-scope.mjs');
  const { readFile } = await import('node:fs/promises');
  const path = (await import('node:path')).default;
  const overlay = new Map();
  for (const move of moves) {
    const file = move.move === 'agent.edit' ? model.agents.find((agent) => agent.id === move.agent)?.path
      : move.move === 'skill.edit' ? (model.skills ?? []).find((skill) => skill.id === move.skill)?.path
        : (model.instructions ?? []).find((item) => item.id === move.instruction)?.path;
    if (!file) return null;
    const text = overlay.get(file) ?? await readFile(path.join(configurationReadRoot(repository), file), 'utf8').catch(() => null);
    if (text == null || text.split(move.old).length !== 2) return null;
    overlay.set(file, text.replace(move.old, () => move.new ?? ''));
  }
  return overlay;
}

/**
 * Why a candidate is not offered, or its effect when it is. A text-only candidate is judged on its
 * edited text in this process (no check judges agent, skill or instruction text as a problem);
 * Workflow Studio's own save check runs when the person accepts it, and verify runs everything again.
 */
async function judged({ repository, model, draft, moves, workflowId, baseline }) {
  const findings = validateMoves(moves, { model, draft });
  if (findings.length) return { notOffered: `Its moves do not fit the workflow as it is: ${findings[0].message}` };
  const overlay = await textOverlay(repository, model, draft, moves);
  const after = overlay
    ? { valid: true, check: null, assessment: await (await import('./index.mjs')).assessWorkflows(repository, { workflows: [workflowId], model, overlay }) }
    : await staged(repository, applyMoves(draft, moves), model, workflowId, moves);
  if (!after.valid) return { notOffered: `Workflow Studio could not save the workflow it leaves: ${after.message}` };
  const known = new Set(problemsOf(baseline.check, baseline.assessment).map(problemKey));
  const added = problemsOf(after.check ?? baseline.check, after.assessment).filter((entry) => !known.has(problemKey(entry)));
  if (added.length) return { notOffered: `It would add a problem: ${added[0].title}${added.length > 1 ? `, and ${added.length - 1} more` : ''}.` };
  return { effect: { before: assessmentSummary(baseline.assessment), after: assessmentSummary(after.assessment) } };
}

/** One candidate per way a suggestion can be made: its change, or each choice a person makes between. */
function candidatesOf(finding) {
  const suggestion = finding.suggestion ?? {};
  const base = { finding: finding.id, code: finding.code, severity: finding.severity, title: finding.title, why: `${finding.detail} ${suggestion.text ?? ''}`.trim(),
    location: finding.location ?? null, quote: finding.quote ?? null };
  const choices = [
    ...(suggestion.moves?.length ? [{ id: 'change', label: suggestion.text, moves: suggestion.moves, decidedBy: suggestion.decidedBy ?? 'person' }] : []),
    ...(suggestion.alternatives ?? []).filter((choice) => choice.moves?.length).map((choice) => ({ id: choice.id, label: choice.label, moves: choice.moves, decidedBy: 'person' }))
  ];
  if (!choices.length) {
    return [{ ...base, id: candidateId(finding.id, 'none'), choice: null, moves: [], decidedBy: suggestion.decidedBy ?? 'person',
      notOffered: suggestion.covered ? `The same change as ${suggestion.covered} makes it.`
        : suggestion.blocked ?? 'No move makes this change by itself: Copilot can draft the rewrite (workflow assess --read), for you to accept.' }];
  }
  return choices.map((choice) => ({ ...base, id: candidateId(finding.id, choice.id), choice: choice.id, ...(choices.length > 1 ? { choiceLabel: choice.label } : {}),
    moves: choice.moves, decidedBy: choice.decidedBy, notOffered: null }));
}

/**
 * Assess a change build's workflow, check every suggestion against it, and record the ones that pass
 * as pending proposals by SFlow. Run once, when the build starts; the record is saved.
 */
export async function offerAssessment(record, { root = null, env = process.env } = {}) {
  const repository = repositoryOf(record, root);
  const workflowId = record.goal.assess.workflow;
  const { assessWorkflows } = await import('./index.mjs');
  const outcome = await withRepository(repository, async (model) => {
    const assessment = await assessWorkflows(repository, { workflows: [workflowId] });
    const view = assessment.workflows[0];
    if (!view || view.error) throw new SingularityFlowError(`${workflowId} cannot be assessed: ${view?.error ?? assessment.verdict?.text}`, { code: 'WORKFLOW_ASSESS_UNREADABLE' });
    const draft = draftOf(record, model);
    const baseline = await staged(repository, draft, model, workflowId);
    const candidates = view.findings.flatMap(candidatesOf);
    for (const candidate of candidates) {
      if (candidate.notOffered || !candidate.moves.length) continue;
      Object.assign(candidate, await judged({ repository, model, draft, moves: candidate.moves, workflowId, baseline }));
    }
    return { candidates, before: assessmentSummary(assessment), verdict: view.verdict };
  });
  const now = new Date().toISOString();
  for (const candidate of outcome.candidates.filter((entry) => !entry.notOffered && entry.moves.length)) {
    const proposal = { id: `p-${record.proposals.length + 1}`, by: 'sflow', title: (candidate.choiceLabel ? `${candidate.title}: ${candidate.choiceLabel}` : candidate.title).slice(0, 200),
      why: candidate.why.slice(0, 2000), moves: candidate.moves, evidence: [], items: [], status: 'pending', createdAt: now,
      candidate: candidate.id, finding: candidate.finding, decidedBy: candidate.decidedBy, ...(candidate.effect ? { effect: candidate.effect } : {}) };
    record.proposals.push(proposal);
    candidate.proposal = proposal.id;
  }
  record.assess = { workflow: workflowId, checkedAt: now, before: outcome.before, verdict: outcome.verdict,
    candidates: outcome.candidates.map((entry) => ({ ...entry, proposal: entry.proposal ?? null })) };
  const ready = outcome.candidates.filter((entry) => entry.proposal);
  const mine = ready.filter((entry) => entry.decidedBy === 'sflow');
  const waiting = outcome.candidates.filter((entry) => !entry.proposal);
  record.conversation.push({ at: now, by: 'sflow', kind: 'assess', text: `${outcome.verdict.text} `
    + (ready.length ? `Checked and offered, each for you to accept or decline: ${ready.map((entry) => `${entry.proposal} ${entry.choiceLabel ? `${entry.title} (${entry.choiceLabel})` : entry.title}`).join('; ')}.` : 'Nothing SFlow can change by itself.')
    + (mine.length ? ` ${mine.length} of them only make the text say what the steps already do; accept them all at once with workflow build decide --build ${record.id} --accept --all.` : '')
    + (waiting.length ? ` Not offered, with why: ${waiting.map((entry) => `${entry.title} (${entry.notOffered})`).join('; ')}` : '') });
  return saveWorkflowBuild(record, { env });
}

/**
 * Accept every pending proposal SFlow offered and decided itself, in order, each checked against the
 * ones accepted before it; one that no longer fits is marked stale and named. An assess build's are
 * checked together by one Workflow Studio plan; a simplify build's (or any set that plan refuses) one
 * at a time, as `workflow build decide` checks each.
 */
export async function acceptAllSflow(id, { root = null, env = process.env } = {}) {
  const { acceptProposals, decideInBuild } = await import('../workflow-build/engine.mjs');
  const record = await readWorkflowBuild(id, { env });
  const pending = record.proposals.filter((proposal) => proposal.status === 'pending' && proposal.by === 'sflow' && proposal.decidedBy !== 'person');
  if (!pending.length) throw new SingularityFlowError(`Build ${id} has no pending change SFlow decided itself; decide the rest one at a time with --proposal.`, { code: 'WORKFLOW_BUILD_NOTHING_PENDING' });
  if (!record.goal.simplify) {
    const outcome = await acceptProposals(id, pending.map((proposal) => proposal.id), { root, env });
    if (outcome.together) return outcome;
  }
  const accepted = [];
  const stale = [];
  for (const proposal of pending) {
    try { await decideInBuild(id, proposal.id, { accept: true, root, env }); accepted.push(proposal.id); }
    catch (error) {
      if (error?.code !== 'WORKFLOW_BUILD_PROPOSAL_STALE') throw error;
      stale.push({ id: proposal.id, reason: error.details?.findings?.[0]?.message ?? error.message });
    }
  }
  return { record: await readWorkflowBuild(id, { env }), accepted, stale };
}
