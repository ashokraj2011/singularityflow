/**
 * An SFlow command typed without its program: a paid Copilot CLI run (2026-11-14) ran `story intent-amendment
 * propose --file …` and `env -C <repo> story …`, got the guard's generic tool-form refusal twice, and gave up on the
 * route. The refusal names the command it meant; the call stays refused, on both hosts' payloads.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recordRepositoryBoundaryTurn, repositoryToolGuard } from '../src/copilot-repository-boundary.mjs';
import { captureMutationTurn, mutationToolGuard } from '../src/copilot-mutation-guard.mjs';
import { MISSING_PROGRAM_CODE } from '../src/copilot-missing-program.mjs';
import { ownToolRepair } from '../src/copilot-review-completion.mjs';

async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-missing-program-')));
  const root = path.join(directory, 'repository');
  await mkdir(path.join(root, 'src'), { recursive: true });
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(directory, 'machine', 'mode.json');
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const git = (args) => assert.equal(spawnSync('git', args, { cwd: root, encoding: 'utf8' }).status, 0, args.join(' '));
  git(['init', '-q']); git(['config', 'user.name', 'Missing Program Tester']); git(['config', 'user.email', 'missing-program@example.test']);
  await writeFile(path.join(root, 'src', 'App.jsx'), 'export const value = 1;\n');
  const phase = { id: 'custom-step', status: 'in_progress', generation: 0, writeScope: 'artifact-only', generationPolicy: { task: 'document', requirement: 'required' } };
  const definition = { workItemRoot: 'singularity/work-items', governance: { protectedPaths: ['policy'] } };
  const workflow = { workItem: { id: 'PMC-1' }, currentPhase: phase.id, phaseOrder: [phase.id], phases: { [phase.id]: phase }, resolution: {} };
  await mkdir(path.join(root, definition.workItemRoot, 'PMC-1'), { recursive: true });
  await writeFile(path.join(root, definition.workItemRoot, 'PMC-1', 'workflow.json'), JSON.stringify(workflow));
  git(['add', '.']); git(['commit', '-qm', 'fixture']);
  const accepted = { definition, workflow };
  const enter = async (skill, sessionId) => {
    const payload = { cwd: root, sessionId, prompt: skill };
    await recordRepositoryBoundaryTurn(payload, { captureMutation: (turnPayload, record) => captureMutationTurn(turnPayload, record,
      { resolveRoot: async () => root, load: async () => accepted }) });
    return payload;
  };
  return { root, enter };
}

const DRAFT = '/tmp/drafts/PMC-1.md';

test('a command family without its program is refused with the command it meant, on Copilot CLI\'s payload', async (t) => {
  const f = await fixture(t);
  const amend = await enter(f, '/sf-amend PMC-1', 'amend-turn');
  const shell = (command) => mutationToolGuard({ ...amend, toolName: 'bash', toolArgs: { command, cwd: f.root } });
  for (const [typed, meant] of [
    [`story intent-amendment propose --file ${DRAFT}`, `singularity-flow story intent-amendment propose --file ${DRAFT}`],
    // The accepted ways to set the bound cwd keep their prefix; the command after it is what was meant.
    [`env -C ${f.root} story intent-amendment propose --file ${DRAFT}`, `env -C ${f.root} singularity-flow story intent-amendment propose --file ${DRAFT}`],
    [`cd ${f.root} && story intent-amendment status --json`, `cd ${f.root} && singularity-flow story intent-amendment status --json`],
    // An alias the registry accepts is a family too.
    ['next-steps --for-agent --json', 'singularity-flow next-steps --for-agent --json']
  ]) {
    const refusal = await shell(typed);
    assert.equal(refusal.permissionDecision, 'deny', typed);
    const head = typed.replace(/^(?:env -C \S+ |cd \S+ && )/u, '').split(' ')[0];
    assert.ok(refusal.permissionDecisionReason.startsWith(`${MISSING_PROGRAM_CODE}: \`${head}\` is not a program: run it as \`${meant}\`.`), refusal.permissionDecisionReason);
    assert.match(refusal.permissionDecisionReason, /Correct the tool form in this turn/u);
    assert.doesNotMatch(refusal.permissionDecisionReason, /PHASE_MUTATION_TOOL_PROTOCOL|use native file-read tools/u);
    // Its route is the command itself, run in this turn: no other skill.
    assert.equal(refusal.next.length, 1, typed);
    assert.equal(refusal.next[0].command, meant.replace(/^(?:env -C \S+ |cd \S+ && )/u, ''));
    assert.equal(refusal.next[0].copilotCommand, null);
    assert.match(refusal.permissionDecisionReason, new RegExp(`- Shell: ${meant.replace(/^(?:env -C \S+ |cd \S+ && )/u, '').replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&')}$`, 'mu'));
  }
  // A chain names its first command, to run on its own.
  const chained = await shell(`story intent-amendment status --json | head -n 5`);
  assert.ok(chained.permissionDecisionReason.startsWith(`${MISSING_PROGRAM_CODE}: \`story\` is not a program: run it as \`singularity-flow story intent-amendment status --json\`, on its own, with no chain or pipe.`),
    chained.permissionDecisionReason);
  // The turn repairs it itself: a tool form, not a blocker.
  assert.match(ownToolRepair({ toolName: 'bash' }, chained), /^PHASE_MUTATION_SFLOW_PROGRAM_MISSING: the tool form was refused, nothing else/u);
});

// /sf-submit's turn is kernel-only: it runs SFlow commands and nothing else. /sf-next was one until OSA Stage 4 made it do
// the current step's own work (D2, OSA:REQ-025); its turn runs shell commands under the authoring file checks, as /sf-phase.
test('VS Code\'s run_in_terminal gets the same refusal', async (t) => {
  const f = await fixture(t);
  const next = await enter(f, '/sf-submit', 'vscode-submit');
  const refusal = await repositoryToolGuard({ session_id: next.sessionId, cwd: f.root, hook_event_name: 'PreToolUse',
    tool_name: 'run_in_terminal', tool_input: { command: 'nextsteps --for-agent --json', explanation: 'Next steps', isBackground: false } });
  assert.equal(refusal.permissionDecision, 'deny');
  assert.ok(refusal.permissionDecisionReason.startsWith(`${MISSING_PROGRAM_CODE}: \`nextsteps\` is not a program: run it as \`singularity-flow nextsteps --for-agent --json\`.`),
    refusal.permissionDecisionReason);
});

test('only the words change: a program, a builtin, an unknown word, an unaccepted cwd and the CLI itself keep their refusals', async (t) => {
  const f = await fixture(t);
  const next = await enter(f, '/sf-submit', 'negatives');
  const shell = (command) => mutationToolGuard({ ...next, toolName: 'bash', toolArgs: { command, cwd: f.root } });
  const outside = path.join(path.dirname(f.root), 'elsewhere');
  await mkdir(outside);
  // `sync` is a family and a program on this PATH (/bin/sync); `help` is the shell's own.
  for (const command of ['sync', 'help', 'storyx intent-amendment propose', `cd ${outside} && story intent-amendment status`]) {
    const refusal = await shell(command);
    assert.equal(refusal.permissionDecision, 'deny', command);
    assert.doesNotMatch(refusal.permissionDecisionReason, new RegExp(MISSING_PROGRAM_CODE, 'u'), command);
  }
  const own = await shell('singularity-flow story intent-amendment decide AMD-001 --decision approve --confirm AMD-001');
  assert.match(own.permissionDecisionReason, /^PHASE_MUTATION_OPERATION_NOT_ALLOWED: an intent amendment is decided by a person/u);
  // An authoring turn runs repository shell commands under its file checks: the shell itself says the word is not found.
  // /sf-next is one since OSA Stage 4 (D2); a person's own decision stays refused there too.
  for (const [skill, session] of [['/sf-phase', 'authoring'], ['/sf-next', 'next-authoring']]) {
    const author = await enter(f, skill, session);
    const guard = (command) => mutationToolGuard({ ...author, toolName: 'bash', toolArgs: { command, cwd: f.root } });
    assert.notEqual((await guard('story intent-amendment status --json')).permissionDecision, 'deny', skill);
    assert.match((await guard('singularity-flow story intent-amendment decide AMD-001 --decision approve --confirm AMD-001')).permissionDecisionReason,
      /^PHASE_MUTATION_OPERATION_NOT_ALLOWED: an intent amendment is decided by a person/u, skill);
  }
});

const enter = (f, skill, sessionId) => f.enter(skill, sessionId);
