/**
 * SCS M4: what the person asked for [SCS:REQ-040]. The prompt hook keeps the words a person types after
 * /sf-code or /sf-phase, redacted and bounded, in the Story's own local record; a subagent's task, another
 * skill and a bare step word keep nothing. The hook runs here with the payload shapes Copilot sends, through
 * the real recordRepositoryBoundaryTurn and captureMutationTurn; no model and no host are involved.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { ASKED_FOR, askedForGeneration, localAskedFor, noteAskedFor, noteTypedTurn, subagentPayload, typedArguments, typedInstruction } from '../src/asked-for.mjs';
import { captureMutationTurn } from '../src/copilot-mutation-guard.mjs';
import { recordRepositoryBoundaryTurn } from '../src/copilot-repository-boundary.mjs';

// Built, never written whole, so no scanner reads this file as holding a token.
const TOKEN = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_');

test('SCS REQ-040: the words after /sf-code or /sf-phase, redacted, at most 2,000 characters; nothing for a subagent, another skill or a step word', async () => {
  assert.equal(typedArguments('/sf-code make the timeout 10s'), 'make the timeout 10s');
  assert.equal(typedArguments('<skill-context name="sf-code">Code it.\nARGUMENTS: make the timeout 10s\n</skill-context>'), 'make the timeout 10s', 'a host\'s expanded skill');
  assert.equal(typedArguments('/sf-code'), null);
  assert.deepEqual(await typedInstruction({ prompt: '/sf-code make the timeout 10s' }, 'sf-code'), { text: 'make the timeout 10s' });
  assert.deepEqual(await typedInstruction({ prompt: '/sf-phase keep the old field name' }, 'sf-phase'), { text: 'keep the old field name' });
  const redacted = await typedInstruction({ prompt: `/sf-code use ${TOKEN} to call the API` }, 'sf-code');
  assert.ok(!redacted.text.includes(TOKEN), redacted.text);
  assert.match(redacted.text, /^use \[REDACTED\] to call the API$/u);
  const long = await typedInstruction({ prompt: `/sf-code ${'a'.repeat(ASKED_FOR.characters + 50)}` }, 'sf-code');
  assert.equal(long.text.length, ASKED_FOR.characters);
  assert.equal(long.truncated, true);
  // A subagent's task names the agent that runs it; it is never the person's prompt.
  assert.equal(subagentPayload({ agentId: 'agent-1' }), true);
  assert.equal(subagentPayload({ agent_id: 'agent-1' }), true);
  assert.equal(await typedInstruction({ prompt: '/sf-code make the timeout 10s', agentId: 'agent-1' }, 'sf-code'), null);
  assert.equal(await typedInstruction({ prompt: '/sf-code make the timeout 10s', agent_id: 'agent-1' }, 'sf-code'), null);
  assert.equal(await typedInstruction({ prompt: '/sf-next make the timeout 10s' }, 'sf-next'), null, 'another skill');
  for (const word of ['status', 'publish', 'continue', 'QF-1']) assert.equal(await typedInstruction({ prompt: `/sf-code ${word}` }, 'sf-code'), null, word);
});

test('SCS REQ-040: 20 turns a generation, each turn once, and the generation is the open one or the next', async (t) => {
  const gitDir = await mkdtemp(path.join(os.tmpdir(), 'sflow-asked-for-'));
  t.after(() => rm(gitDir, { recursive: true, force: true }));
  const subject = { workId: 'QF-1', phase: 'implement', generation: 1 };
  for (let turn = 1; turn <= ASKED_FOR.turns + 2; turn += 1) {
    await noteAskedFor(gitDir, { ...subject, text: `instruction ${turn}`, skill: 'sf-code', turnId: `turn-${turn}`, at: '2026-11-08T10:00:00.000Z' });
  }
  await noteAskedFor(gitDir, { ...subject, text: 'instruction 1 again', skill: 'sf-code', turnId: 'turn-1', at: '2026-11-08T10:00:00.000Z' });
  const kept = await localAskedFor(gitDir, subject);
  assert.equal(kept.turns.length, ASKED_FOR.turns);
  assert.equal(kept.turns[0].text, 'instruction 1', 'a turn is kept once, as first typed');
  assert.equal(kept.omitted, 2);
  assert.deepEqual(await localAskedFor(gitDir, { ...subject, generation: 2 }), { turns: [], omitted: 0 }, 'another generation has its own record');
  assert.equal(askedForGeneration({ generation: 1, generationIntent: { status: 'open', generation: 2 } }), 2);
  assert.equal(askedForGeneration({ generation: 1, generationIntent: { status: 'consumed', generation: 1 } }), 2);
  assert.equal(askedForGeneration({}), 1);
  // A capability that turned it off keeps nothing.
  const workflow = { workItem: { id: 'QF-1' }, status: 'in_progress', currentPhase: 'implement', phases: { implement: { id: 'implement', generation: 0 } },
    resolution: { capability: { policy: { typedFocus: 'off' } } } };
  assert.equal(await noteTypedTurn({ typed: { text: 'make it fast' }, skill: 'sf-code', turnId: 'off-1' }, { gitDir, workflow }), null);
});

async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-asked-for-hook-')));
  const root = path.join(directory, 'repository');
  await mkdir(path.join(root, 'src'), { recursive: true });
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(directory, 'machine', 'mode.json');
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Asked Tester'); git('config', 'user.email', 'asked@example.test');
  await writeFile(path.join(root, 'src/app.js'), 'export const timeout = 5;\n');
  const phase = { id: 'implementation', status: 'in_progress', generation: 0, writeScope: 'source-and-artifact',
    generationPolicy: { task: 'code', requirement: 'required' }, generationIntent: { status: 'open', generation: 1 } };
  const definition = { workItemRoot: 'singularity/work-items', governance: { protectedPaths: [] } };
  const workflow = { workItem: { id: 'ASK-1' }, status: 'in_progress', currentPhase: phase.id, phaseOrder: [phase.id], phases: { [phase.id]: phase }, resolution: {} };
  const workflowFile = path.join(root, definition.workItemRoot, 'ASK-1', 'workflow.json');
  await mkdir(path.dirname(workflowFile), { recursive: true });
  await writeFile(workflowFile, JSON.stringify(workflow));
  git('add', '.'); git('commit', '-qm', 'baseline');
  const accepted = { definition, workflow };
  /** One prompt of one Copilot session, as the userPromptSubmitted hook receives it. */
  const prompt = (payload) => recordRepositoryBoundaryTurn({ cwd: root, timestamp: Date.now(), ...payload }, {
    captureMutation: (value, record) => captureMutationTurn(value, record, { resolveRoot: async () => root, load: async () => accepted }) });
  const subject = { workId: 'ASK-1', phase: 'implementation', generation: 1 };
  return { directory, root, workflow, prompt, recorded: () => localAskedFor(path.join(root, '.git'), subject) };
}

test('SCS REQ-040: the prompt hook keeps a person\'s /sf-code words in the Story\'s local record, never in the turn record, and never a subagent\'s', async (t) => {
  const f = await fixture(t);
  await f.prompt({ sessionId: 'person', prompt: `/sf-code make the timeout 10s and use ${TOKEN}` });
  let recorded = await f.recorded();
  assert.deepEqual(recorded.turns.map((entry) => [entry.skill, entry.text]), [['sf-code', 'make the timeout 10s and use [REDACTED]']]);
  // The turn records the hooks share hold no typed words.
  const boundaries = path.join(f.directory, 'machine', 'copilot-boundaries');
  for (const name of await readdir(boundaries)) {
    if (!name.endsWith('.json')) continue;
    const bytes = await readFile(path.join(boundaries, name), 'utf8');
    assert.ok(!bytes.includes('timeout 10s') && !bytes.includes(TOKEN), name);
  }
  // A subagent's task, a plain prompt and another skill keep nothing.
  await f.prompt({ sessionId: 'person', prompt: '/sf-code rename the module', agentId: 'subagent-7' });
  await f.prompt({ sessionId: 'person', prompt: 'make it 20s instead' });
  await f.prompt({ sessionId: 'person', prompt: '/sf-next make it 30s' });
  // A host's expanded skill context is the same person's prompt.
  await f.prompt({ sessionId: 'person', prompt: '<skill-context name="sf-phase">Author the step.\nARGUMENTS: keep the old error text\n</skill-context>' });
  recorded = await f.recorded();
  assert.deepEqual(recorded.turns.map((entry) => entry.text), ['make the timeout 10s and use [REDACTED]', 'keep the old error text']);
  assert.ok(!JSON.stringify(recorded).includes(TOKEN));
  // Turned off by the capability: nothing more is kept.
  f.workflow.resolution = { capability: { policy: { typedFocus: 'off' } } };
  await f.prompt({ sessionId: 'person', prompt: '/sf-code log every retry' });
  assert.equal((await f.recorded()).turns.length, 2);
});

// ---------------------------------------------------------------------------------------------------
// [SCS:REQ-041] Prepublish copies the words into the Story as "Asked for", committed with it.

async function codeStep(t) {
  const { repository, startQuickFix } = await import('./helpers/run-and-test-fixture.mjs');
  const repo = await repository(t, { implementCommands: false });
  // A code step the agent authors, as /sf-code does, with a person's approval.
  const configPath = path.join(repo.root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.phases.implement.approval = { mode: 'required', authorities: ['engineering-reviewers'], minimum: 1, rejectTo: ['intake'] };
  config.phases.implement.generation = { requirement: 'required', task: 'code' };
  await writeFile(configPath, YAML.stringify(config));
  repo.must('git', ['add', 'singularity/workflow.yml']);
  repo.must('git', ['commit', '-m', 'An agent-authored code step with a human review in this fixture']);
  await startQuickFix(repo);
  repo.sflow('prepare', 'implement');
  await writeFile(path.join(repo.root, 'src/value.mjs'), '// @clause:QF-1:AC-001 return the approved value\nexport const value = 2;\n');
  await writeFile(path.join(repo.root, 'test/value.test.mjs'), ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", '// @ac:QF-1:AC-001', "test('returns two', () => assert.equal(value, 2));", ''].join('\n'));
  repo.sflow('prepare', 'implement');
  const state = async () => JSON.parse(await readFile(path.join(repo.root, 'singularity/work-items/QF-1/workflow.json'), 'utf8'));
  /** What the prompt hook writes for one typed turn of the step's generation. */
  const typed = async (text, turnId) => {
    const phase = (await state()).phases.implement;
    await noteAskedFor(path.join(repo.root, '.git'), { workId: 'QF-1', phase: 'implement', generation: askedForGeneration(phase), text, skill: 'sf-code', turnId,
      at: new Date().toISOString() });
  };
  return { repo, state, typed };
}

test('SCS REQ-041: prepublish copies what the person asked for into the Story in one commit, once, and publication carries it', async (t) => {
  const { repo, state, typed } = await codeStep(t);
  await typed('make the value 2, not 3', 'turn-a');
  await typed('keep the module name', 'turn-b');
  const commits = () => Number(repo.must('git', ['rev-list', '--count', 'HEAD']).trim());
  const before = commits();
  const checked = repo.sflowJson('phase', 'prepublish', 'implement', '--for-agent');
  assert.equal(checked.status, 0, JSON.stringify(checked.value));
  assert.deepEqual(checked.value.askedFor.instructions.map((entry) => [entry.instruction, entry.text, entry.recorded]),
    [[1, 'make the value 2, not 3', true], [2, 'keep the module name', true]]);
  assert.match(checked.value.askedFor.words, /\(1\) "make the value 2, not 3"; \(2\) "keep the module name"/u);
  let recorded = await state();
  assert.deepEqual(recorded.askedFor.map((entry) => [entry.phase, entry.instruction, entry.text, entry.turn]),
    [['implement', 1, 'make the value 2, not 3', 'turn-a'], ['implement', 2, 'keep the module name', 'turn-b']]);
  assert.equal(commits(), before + 1, 'one Story commit');
  assert.match(repo.must('git', ['log', '-1', '--format=%s']), /\[QF-1\]\[asked-for\] implement generation/u);
  const committed = JSON.parse(repo.must('git', ['show', 'HEAD:singularity/work-items/QF-1/workflow.json']));
  assert.equal(committed.askedFor.length, 2, 'committed with the Story');
  // Nothing new typed: the next prepublish copies nothing and commits nothing.
  repo.sflowJson('phase', 'prepublish', 'implement', '--for-agent');
  assert.equal(commits(), before + 1);
  // A turn typed after it is numbered on; publication copies it when no prepublish did.
  await typed('log the value', 'turn-c');
  const published = repo.sflowJson('phase', 'publish', 'implement', '--authored', 'governed-agent');
  recorded = await state();
  assert.deepEqual(recorded.askedFor.map((entry) => entry.instruction), [1, 2, 3], JSON.stringify(published.value).slice(0, 2000));
});

test('SCS REQ-041: policy.typedFocus folds one way, and off copies nothing', async () => {
  const { foldCapabilityPolicy } = await import('../src/capabilities.mjs');
  const { pendingAskedFor } = await import('../src/asked-for-records.mjs');
  assert.equal(foldCapabilityPolicy({}, {}).typedFocus, undefined, 'unset stays unset');
  assert.equal(foldCapabilityPolicy({}, { typedFocus: 'off' }).typedFocus, 'off');
  assert.equal(foldCapabilityPolicy({ typedFocus: 'on' }, { typedFocus: 'off' }).typedFocus, 'off', 'any capability may turn it off');
  assert.throws(() => foldCapabilityPolicy({ typedFocus: 'off' }, { typedFocus: 'on' }), { code: 'CAPABILITY_POLICY_LOOSENED' });
  assert.throws(() => foldCapabilityPolicy({}, { typedFocus: 'yes' }), { code: 'CAPABILITY_POLICY_INVALID' });
  const workflow = { workItem: { id: 'QF-1' }, resolution: { capability: { policy: { typedFocus: 'off' } } } };
  assert.deepEqual(await pendingAskedFor('/nonexistent', workflow, { id: 'implement' }), { generation: null, entries: [], omitted: 0 });
});
