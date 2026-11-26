/**
 * `work behaviour keep|accept` [ITW:REQ-015]: the person's choice at a refactor's behaviour change in its code step
 * (refactor-behaviour.mjs finds the change and stops the code step's publication). Apart from that module so the code
 * step's gate, which VS Code's runtime bundles through state.mjs, never reaches the task-change code (task-amendment.mjs).
 */
import { nowIso, SingularityFlowError } from './util.mjs';
import { BEHAVIOUR_CHOICES, behaviourCommands, named, noteLine, stepName, versionBehaviourChange } from './refactor-behaviour.mjs';

function refused(code, message, nextAction) {
  return new SingularityFlowError(message, { code, details: { nextAction } });
}

/**
 * `work behaviour keep|accept` [ITW:REQ-015]: the person's choice at a refactor's behaviour change in its code step. Keep
 * records it for the version being written (`behaviourDecisions`, a DECISION_MADE commit) and the author goes on; accept
 * returns the code step to the plan and the task becomes a change (task-amendment.mjs acceptBehaviourAtCode). The step's
 * approvers decide it, as they would return it. Refused, with where the task stands, when nothing waits for it.
 */
export async function decideBehaviour(root, choice, { workId = null, generation = null, reason = null } = {}) {
  const [{ loadAcceptedStoryExecution }, { identity }] = await Promise.all([import('./accepted-story-execution.mjs'), import('./git.mjs')]);
  let { config, workflow } = await loadAcceptedStoryExecution(root, workId);
  const id = workflow.workItem.id;
  const status = { command: `singularity-flow work status ${id}`, label: `See where ${id} stands.` };
  if (!BEHAVIOUR_CHOICES.includes(choice)) {
    throw refused('TASK_BEHAVIOUR_CHOICE_UNKNOWN', `Say keep or accept: singularity-flow work behaviour keep --work-id ${id} keeps the old behaviour, accept takes the new one.`,
      { command: behaviourCommands(id).keep, label: 'Keep the old behaviour.' });
  }
  const phase = workflow.phases?.[workflow.currentPhase];
  const found = phase ? await versionBehaviourChange(root, config, workflow, phase) : null;
  // The card's choice is for the version it showed: a newer one is asked again.
  if (found && generation != null && Number(generation) !== found.generation) {
    throw refused('TASK_BEHAVIOUR_NOTHING_TO_DECIDE', `${id}'s ${stepName(phase)} is at version ${found.generation} now, not ${generation}: decide what it changes on the card again.`,
      { command: `singularity-flow decisions ${id}`, label: 'See the decisions card again.' });
  }
  if (!found?.undecided.length) {
    throw refused('TASK_BEHAVIOUR_NOTHING_TO_DECIDE', `${id} has no behaviour change waiting for a person: ${workflow.resolution?.composition?.kind === 'refactor'
      ? `no run of ${stepName(phase)}'s version being written changed what passed before the change, or it is decided` : `it is not a refactor (${workflow.resolution?.composition?.kind ?? 'not a task'})`}.`, status);
  }
  const actor = identity(root);
  const [{ requireApprovalAuthority }, { actorKey }] = await Promise.all([import('./approval-authority.mjs'), import('./state-stores.mjs')]);
  // The step's approvers decide it, as they would return it.
  const authority = requireApprovalAuthority(workflow.resolution?.approvalAuthorities ?? config.approvalAuthorities, phase.approvalPolicy, actor);
  const checks = found.undecided;
  if (choice === 'accept') {
    const accepted = await (await import('./task-amendment.mjs')).acceptBehaviourAtCode(root, workflow.workItem.id, phase.id, { checks, actor });
    ({ workflow } = await loadAcceptedStoryExecution(root, id));
    return behaviourResult(workflow, { choice, checks, words: accepted.line, changeId: accepted.changeId, changeRequest: accepted.changeRequest });
  }
  const [{ LIFECYCLE_EVENT }, { transactStory }] = await Promise.all([import('./lifecycle-event.mjs'), import('./state-stores.mjs')]);
  const by = actorKey(actor);
  // Keeping the old behaviour puts back each existing test the version changed, as it was before the change: what it
  // expects is the person's, and they kept it. The code is the author's to restore.
  const restored = await restoreExistingTests(root, workflow, phase, found.tests);
  const { value: record } = await transactStory(root, config, workflow, {
    type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: phase.id, generation: found.generation, actor, agent: null,
    authorityGroup: authority.authorityGroup, payload: { decision: 'refactor-behaviour', choice }
  }, `[${id}][phase:${phase.id}][behaviour] keep the old behaviour`, async (aggregate) => {
    aggregate.behaviourDecisions ??= [];
    const entry = { id: `BHV-${String(aggregate.behaviourDecisions.length + 1).padStart(3, '0')}`, phase: phase.id, generation: found.generation, choice,
      checks, ...(reason ? { reason: String(reason).slice(0, 1000) } : {}), actor: by, authorityGroup: authority.authorityGroup ?? null, at: nowIso() };
    aggregate.behaviourDecisions.push(entry);
    aggregate.history.push({ at: entry.at, actor: by, agent: null, event: 'refactor_behaviour_kept', phase: phase.id,
      detail: `${entry.id}: the old behaviour of ${named(checks)} is kept; ${stepName(phase)} version ${found.generation} restores it.` });
    return entry;
  }, { exactWorkItemPaths: [] });
  ({ workflow } = await loadAcceptedStoryExecution(root, id));
  return behaviourResult(workflow, { choice, checks, decision: record.id, ...(restored.length ? { restored } : {}),
    words: `You kept the old behaviour: ${named(checks)} must pass as ${checks.length === 1 ? 'it did' : 'they did'} before the change.${restored.length
      ? ` SFlow put back what ${named(restored)} expected before the change.` : ''} ${stepName(phase)} goes on and restores the rest.` });
}

/**
 * Each existing test the version changed or removed, written back as it was at the Story's base; their paths. A removed
 * test comes back whole. A changed one gets back every part of it that says what it expects, from the file's
 * zero-context patch against the base (git.mjs pathPatchSince), while a part where the version only added or changed
 * comments and blank lines stays the author's (a criterion's tag says nothing it expects), as the edit was found.
 */
async function restoreExistingTests(root, workflow, phase, tests = []) {
  if (!tests.length) return [];
  const [{ storyBaseCommit }, { committedFileBytes, pathPatchSince }, { mkdir, readFile, writeFile }, path] = await Promise.all([
    import('./verification/base-run.mjs'), import('./git.mjs'), import('node:fs/promises'), import('node:path')]);
  const base = storyBaseCommit(workflow, phase);
  const restored = [];
  for (const entry of tests) {
    const bytes = base ? committedFileBytes(root, base, entry.path) : null;
    if (!bytes) continue;
    const target = path.join(root, entry.path);
    if (!target.startsWith(`${root}${path.sep}`)) continue;
    const now = entry.removed ? null : await readFile(target, 'utf8').catch(() => null);
    const diff = now == null ? null : pathPatchSince(root, base, null, [entry.path]);
    const text = diff == null ? null : expectationsRestored(now, diff);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text ?? bytes);
    restored.push(entry.path);
  }
  return restored;
}

/**
 * `now` with each hunk of `diff` (the file's zero-context patch against its base) that changes what the test expects put back
 * as the base had it; hunks of comments and blank lines alone stay as written. Null when the diff cannot be read, so the
 * caller writes the base file whole. Pure.
 */
export function expectationsRestored(now, diff) {
  const lines = String(now).split('\n');
  const hunks = [];
  for (const line of String(diff).split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (header) { hunks.push({ at: Number(header[1]), count: header[2] == null ? 1 : Number(header[2]), removed: [], added: [] }); continue; }
    const hunk = hunks.at(-1);
    if (!hunk) continue;
    if (line.startsWith('-')) hunk.removed.push(line.slice(1));
    else if (line.startsWith('+')) hunk.added.push(line.slice(1));
  }
  if (!hunks.length || hunks.some((hunk) => hunk.added.length !== hunk.count)) return null;
  const out = [];
  let next = 1;
  for (const hunk of hunks) {
    // A hunk that adds nothing removes lines after line `at`; one that adds lines starts at `at`.
    const upTo = hunk.count === 0 ? hunk.at : hunk.at - 1;
    if (upTo < next - 1) return null;
    out.push(...lines.slice(next - 1, upTo));
    out.push(...([...hunk.removed, ...hunk.added].every(noteLine) ? hunk.added : hunk.removed));
    next = upTo + hunk.count + 1;
  }
  out.push(...lines.slice(next - 1));
  return out.join('\n');
}

/** The result of the person's choice: their words and the task's next step, as the step's own route names it. */
async function behaviourResult(workflow, { choice, checks, words, ...rest }) {
  const [{ stepRoute }, { withTaskRoute }] = await Promise.all([import('./step-decision.mjs'), import('./safe-command-guidance.mjs')]);
  const phase = workflow.phases?.[workflow.currentPhase] ?? null;
  const route = phase ? withTaskRoute(workflow, stepRoute(workflow, phase)) : null;
  return { schemaVersion: 1, resultType: 'sflow-task-behaviour', id: workflow.workItem.id, kind: workflow.resolution?.composition?.kind ?? null, choice, checks,
    ...rest, words, phase: phase?.id ?? null,
    ...(route?.command ? { nextAction: { command: route.command, copilotCommand: route.copilotCommand ?? route.skill ?? null,
      label: `Carry ${workflow.workItem.id} on: ${stepName(phase)}.` } } : {}) };
}
