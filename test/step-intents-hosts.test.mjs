/**
 * Generated workflows walked end to end on both hosts (slow lane; step intents spec §9.4, Stage 6). Each is a workflow a
 * person could make (test/helpers/generated-workflows.mjs: built from intents with random step IDs and random mixes of
 * document, code and no-code steps, review, approval, questions and test commands, and passed by the walk every change
 * runs). A real Story of it is driven by the route follower (test/helpers/route-follower.mjs) the way Copilot CLI drives
 * it and the way VS Code's chat does (its page tools on the extension's own pages, test/helpers/vscode-host.mjs), from
 * `start` to the Story's end, by the routes SFlow returns and nothing else, with a scripted agent, reviewer and person
 * (test/helpers/generated-journey.mjs). It fails on any loop, circle, dead end, route a host lacks, or stop that is not a
 * person's real decision. The same workflows also go through `workflow walk`, the Story walk a workflow build's verify
 * runs before it finishes, which found the dead end the walk on change now stops (a step citing a code step nobody approves).
 *
 * SINGULARITY_FLOW_GENERATED_HOST_SEEDS names the seeds (comma-separated); the default is a small fixed set. A run over
 * many seeds: SINGULARITY_FLOW_GENERATED_HOST_COUNT=N walks N seeds from SINGULARITY_FLOW_GENERATED_SEED.
 *
 * Not wired: the daily paid real-Story run. It would take one generated workflow a day from here (generatedWorkflow with
 * the date as its seed, applyGenerated and addGeneratedAgent in its repository's setup), alternating hosts; the owner has
 * not approved its VS Code lane or the extra cost.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { newAgentFile } from '../src/agent-file.mjs';
import { initializeDefinition } from '../src/config.mjs';
import { walkWorkflows } from '../src/workflow-walk/walk.mjs';

import { addGeneratedAgent, firstClause, generatedAgent, generatedPerson } from './helpers/generated-journey.mjs';
import { applyGenerated, GENERATED_AGENT, GENERATED_WORK_TYPE, generatedAgentFile, generatedWorkflow } from './helpers/generated-workflows.mjs';
import { report } from './helpers/journey-scripts.mjs';
import { followRoutes, formatTrail, journeyRepository, storyRecord } from './helpers/route-follower.mjs';
import { slowLane } from './helpers/slow-lane.mjs';
import { vscodeHost } from './helpers/vscode-host.mjs';

// A small fixed set: a code workflow with review, a code-free one, and one with review off, questions off and its tests configured.
const DEFAULT_SEEDS = [16, 13, 25];
const FIRST = Number(process.env.SINGULARITY_FLOW_GENERATED_SEED ?? 20261121);
const SEEDS = process.env.SINGULARITY_FLOW_GENERATED_HOST_SEEDS ? process.env.SINGULARITY_FLOW_GENERATED_HOST_SEEDS.split(',').map(Number)
  : process.env.SINGULARITY_FLOW_GENERATED_HOST_COUNT ? Array.from({ length: Number(process.env.SINGULARITY_FLOW_GENERATED_HOST_COUNT) }, (_, index) => FIRST + index)
    : DEFAULT_SEEDS;

/** One generated workflow's Story, from `start` to its end, as `host` drives it. */
async function walkGenerated(t, seed, host) {
  const generated = generatedWorkflow(seed);
  const W = `GEN-${seed}`;
  const story = await journeyRepository(t, { configure: (configuration) => applyGenerated(configuration, generated) });
  await addGeneratedAgent(story, generated);
  Object.assign(story, { workId: W, item: `singularity/work-items/${W}` });
  const walk = await followRoutes(story, {
    label: `generated ${seed} on ${host}`, host, ...(host === 'vscode' ? { vscode: await vscodeHost(story, { person: { clause: () => firstClause(story, W) } }) } : {}),
    start: { shell: `singularity-flow start ${W} --from-branch main --work-type ${GENERATED_WORK_TYPE} --title "Return the approved value" --description "The value module must return 2."` },
    agent: generatedAgent(W), person: generatedPerson(story, W),
    done: ({ record }) => record?.status === 'closed',
    maxSteps: 40 + generated.ids.length * 30
  });
  t.diagnostic(generated.where);
  t.diagnostic(formatTrail(walk.trail));
  return { generated, walk, story };
}

for (const seed of SEEDS) {
  for (const host of ['cli', 'vscode']) {
    test(`a generated workflow (seed ${seed}) walks end to end as ${host === 'cli' ? 'Copilot CLI' : "VS Code's chat"} drives it: no loop, no dead end, no stop that is not a person's`,
      slowLane({ timeout: 2_400_000 }), async (t) => {
        const { generated, walk, story } = await walkGenerated(t, seed, host);
        assert.equal(walk.reached, true, `${generated.where}\n${report(walk)}`);
        assert.deepEqual(walk.findings, [], `${generated.where}\n${report(walk)}`);
        const record = storyRecord(story);
        // Every step was walked: approved, completed by its submission, or skipped by a route the workflow took.
        for (const id of generated.ids) assert.ok(['approved', 'completed', 'skipped'].includes(record.phases[id]?.status), `${generated.where}: ${id} is ${record.phases[id]?.status}\n${report(walk)}`);
      });
  }
}

for (const seed of SEEDS) {
  test(`a generated workflow (seed ${seed}) walks with workflow walk, the Story walk a build's verify runs: no stop`, slowLane({ timeout: 1_800_000 }), async (t) => {
    const generated = generatedWorkflow(seed);
    const folder = await mkdtemp(path.join(os.tmpdir(), 'sflow-generated-walk-'));
    t.after(() => rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    await initializeDefinition(folder);
    const file = path.join(folder, 'singularity/workflow.yml');
    await writeFile(file, YAML.stringify(applyGenerated(YAML.parse(await readFile(file, 'utf8')), generated)));
    await mkdir(path.join(folder, 'singularity/agents'), { recursive: true });
    await writeFile(path.join(folder, 'singularity/agents', `${GENERATED_AGENT}.agent.md`), generatedAgentFile(newAgentFile, generated.ids));
    const result = await walkWorkflows(folder, { configurationRoot: folder, workflow: GENERATED_WORK_TYPE, totalSeconds: 1200 });
    const [walked] = result.workflows;
    t.diagnostic(generated.where);
    const said = JSON.stringify({ stops: walked.stops, notJudged: walked.steps.flatMap((step) => step.notJudged) }, null, 1);
    assert.equal(walked.outcome, 'completed', `${generated.where}\n${said}`);
    assert.deepEqual(walked.stops, [], generated.where);
  });
}
