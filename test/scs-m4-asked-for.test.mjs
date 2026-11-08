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
