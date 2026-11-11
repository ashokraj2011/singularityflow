/**
 * Draft N+1 on request for every authored step, not only code (2026-11-12). A document step published and
 * not yet submitted: the person asks /sf-phase for a change, the agent offers to start the next draft for
 * it, the person confirms, and the change is made in the same step. Draft 1 stays as published.
 */
import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { publishedPlanningStory, implementationPlan, CLI } from './helpers/submitted-planning-story.mjs';
import { recordRepositoryBoundaryTurn } from '../src/copilot-repository-boundary.mjs';
import { captureMutationTurn, mutationToolGuard } from '../src/copilot-mutation-guard.mjs';
import { phaseNeedsGeneration } from '../src/sequence.mjs';
import { fileURLToPath } from 'node:url';

const WORK = 'REDRAFT-DOC-1';
const ASKED = 'name who owns the rollback in the risks section';
const TYPED = `planning ${ASKED}`;
const json = (result) => JSON.parse(result.stdout);
const workflowOf = async (item) => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));

test('a change the person asks for after a document step is published opens draft 2 in the same step, only on their confirmation', async (t) => {
  const story = await publishedPlanningStory(t, WORK);
  const { root, cli, run, item, git } = story;
  const before = await workflowOf(item);
  assert.equal(before.phases.planning.generation, 1);
  assert.equal(before.currentPhase, 'planning');
  const publishedHead = git('rev-parse', 'HEAD');
  const plan = path.join(item, 'artifacts/planning/plan.md');
  const published = await readFile(plan, 'utf8');

  // Nothing asked yet: the step offers both ways, submit first, then its next draft for a change.
  const offered = json(cli('nextsteps', '--json'));
  const commands = offered.actions.map((entry) => entry.command);
  assert.ok(commands.some((command) => /^singularity-flow submit planning/u.test(command)), JSON.stringify(commands));
  assert.ok(commands.includes('singularity-flow phase rollover planning --reason "<what to change>" --json'), JSON.stringify(commands));
  const unasked = run(process.execPath, [CLI, '--no-model', 'phase', 'rollover', 'planning', '--json'], { allowFailure: true });
  assert.notEqual(unasked.status, 0);
  const refusal = JSON.parse(unasked.stdout);
  assert.equal(refusal.error.code, 'GENERATION_CHANGE_NOT_REQUESTED');
  assert.match(refusal.error.message, /Say what to change: \/sf-phase planning <what to change>/u);
  assert.equal(refusal.remediationPlan.steps[0].command, 'singularity-flow phase rollover planning --reason "<what to change>" --json');

  // The person types /sf-phase with what to change; the prompt hook keeps the words for draft 2.
  const hook = { cwd: await realpath(root), sessionId: 'redraft-doc', prompt: `/sf-phase ${TYPED}` };
  await recordRepositoryBoundaryTurn(hook, { captureMutation: (payload, record) => captureMutationTurn(payload, record, { resolveRoot: async () => hook.cwd }) });
  // The published draft stays locked to the agent until the person confirms.
  const edit = await mutationToolGuard({ ...hook, toolName: 'edit', toolArgs: { path: path.join(hook.cwd, path.relative(root, plan)), old_str: '## Approach', new_str: '## Approach and owner' } });
  assert.equal(edit.permissionDecision, 'deny', JSON.stringify(edit));

  // The /sf-phase entry leads with starting draft 2 for it, and its preview runs in that turn.
  const entry = json(cli('phase', 'enter', '--compose', '--for-agent', '--json'));
  assert.equal(entry.act.do.shell, 'singularity-flow phase rollover planning --json', JSON.stringify(entry.act));
  const shell = (command) => mutationToolGuard({ ...hook, toolName: 'bash', toolArgs: { command, cwd: hook.cwd } });
  assert.deepEqual(await shell('singularity-flow phase rollover planning --json'), {}, 'the preview runs in the /sf-phase turn');
  const preview = json(cli('phase', 'rollover', 'planning', '--json'));
  assert.equal(preview.kind, 'requested-change');
  assert.deepEqual([preview.fromGeneration, preview.toGeneration], [1, 2]);
  assert.deepEqual(preview.requestedChange.requests, [TYPED]);
  assert.equal(preview.copilotCommand, `/sf-confirm phase rollover planning --confirm ${preview.confirmation}`);

  // Without the person's confirmation nothing happens.
  const stale = run(process.execPath, [CLI, '--no-model', 'phase', 'rollover', 'planning', '--confirm', `sha256:${'0'.repeat(64)}`, '--json'], { allowFailure: true });
  assert.notEqual(stale.status, 0);
  assert.match(stale.stdout + stale.stderr, /GENERATION_ROLLOVER_STALE/u);
  assert.deepEqual(await workflowOf(item), before);
  assert.equal(git('rev-parse', 'HEAD'), publishedHead);

  const opened = json(cli('phase', 'rollover', 'planning', '--confirm', preview.confirmation, '--json'));
  assert.equal(opened.mutates, true);
  assert.deepEqual(opened.opened, { generation: 2, status: 'open' });
  assert.equal(opened.next.copilotCommand, '/sf-phase planning');
  const reopened = await workflowOf(item);
  assert.equal(phaseNeedsGeneration(reopened, reopened.phases.planning), true, 'draft 2 is open in the same step');
  assert.equal(reopened.currentPhase, 'planning');
  assert.equal(reopened.phases.planning.status, 'in_progress');

  // Draft 2 is authored in the step and published; draft 1's bytes are intact at its publication.
  cli('prepare', 'planning');
  await writeFile(plan, implementationPlan(WORK).replace('Risk is a wrong constant; rollback restores the previous module.',
    'Risk is a wrong constant; the planning owner rolls back by restoring the previous module.'));
  cli('artifact', 'scan', '--phase', 'planning');
  cli('phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place');
  const after = await workflowOf(item);
  assert.equal(after.phases.planning.generation, 2);
  assert.equal(git('show', `${publishedHead}:singularity/work-items/${WORK}/artifacts/planning/plan.md`), published.trimEnd());
});

test('every authoring skill makes a change asked for after publication in its own step, on the person\'s yes', async () => {
  const skills = ['sflow-phase', 'sflow-code', 'sflow-design', 'sflow-requirements', 'sflow-release', 'sflow-document-intake', 'sflow-scenario-check'];
  for (const name of skills) {
    const text = await readFile(fileURLToPath(new URL(`../plugin/skills/${name}/SKILL.md`, import.meta.url)), 'utf8');
    assert.match(text, /A change asked for after publication \(typed after this skill\)(?:, or files changed after it,)? is made here: offer "start draft N\+1 for this change", run entry's `singularity-flow phase rollover <phase> --json` preview/u, name);
    assert.match(text, /and its confirmation only on their yes/u, name);
    // Offered before the published step's ordinary next, so a request is never relayed away.
    assert.ok(text.indexOf('start draft N+1 for this change') < text.search(/`retained-generation`: relay `next`|Otherwise unchanged publication: relay `next`/u), name);
  }
});
