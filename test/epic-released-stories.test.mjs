import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import { createInitiative, initiativeDir, saveInitiative } from '../src/initiative-state.mjs';
import { run } from '../src/util.mjs';

process.env.NODE_ENV = 'test';
process.env.SINGULARITY_FLOW_TEST_IDENTITY = 'Initiative Owner';
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const ACTOR_EMAIL = 'initiative.owner@example.com';
const EPIC = 'EPIC-REL';
const STORIES = [`${EPIC}-STORY-001`, `${EPIC}-STORY-002`];

function flow(root, args, { allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: root, encoding: 'utf8', input: '', env: { ...process.env, SINGULARITY_FLOW_NO_MODEL: '1' }
  });
  if (!allowFailure && result.status !== 0) throw new Error(`singularity-flow ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

const REQUIREMENTS = `# Requirements Specification — ${EPIC}

## Requirements

### REQ-001

- Statement: The cart shall show the discounted total for a valid coupon code.
- Priority: Must

### REQ-002

- Statement: The cart shall refuse an expired coupon code and keep the original total.
- Priority: Must

### REQ-003

- Statement: A second coupon code shall replace the first.
- Priority: Must

## Acceptance criteria

### AC-001

- Given: a cart with one item
- When: the customer enters a valid coupon code
- Then: the cart shows the discounted total
- Requirements: REQ-001

### AC-002

- Given: a cart with one item
- When: the customer enters an expired coupon code
- Then: the cart says "This coupon has expired"
- Requirements: REQ-002

### AC-003

- Given: a cart with a coupon applied
- When: the customer enters a second coupon code
- Then: only the second coupon applies
- Requirements: REQ-003

## Open questions and decisions

| ID | Question or decision | Status | Resolution | Decided by | Date |
| --- | --- | --- | --- | --- | --- |
| D-001 | Only one coupon per order | Decided | The newest coupon replaces the previous one | Product owner | 2026-10-30 |
`;

/**
 * One repository that is both the Epic's lead and its Stories' repository (the local Epic route),
 * with an approved Epic Planning package of two Stories, released by the real `epic create-stories`.
 * Release commits its own `[epic:branches]` record on the Epic branch after cutting the Stories,
 * so the Epic branch head is not the base either Story's seed pins.
 */
async function releasedEpic() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-epic-released-'));
  const remote = path.join(base, 'app.git');
  const root = path.join(base, 'app');
  run('git', ['init', '--bare', '-b', 'main', remote], { cwd: base });
  await mkdir(root);
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Initiative Owner'], { cwd: root });
  run('git', ['config', 'user.email', ACTOR_EMAIL], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# App\n');
  await initializeDefinition(root);
  const portfolioFile = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
  for (const authority of Object.values(portfolio.approvalAuthorities)) authority.members = [{ name: 'Initiative Owner', email: ACTOR_EMAIL }];
  portfolio.repositories = { app: { url: remote, defaultBranch: 'main', required: true } };
  await writeFile(portfolioFile, YAML.stringify(portfolio));
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.worldModel.grounding = 'off';
  await writeFile(workflowFile, YAML.stringify(workflow));
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'Initialize'], { cwd: root });
  run('git', ['remote', 'add', 'origin', remote], { cwd: root });
  run('git', ['push', '-u', 'origin', 'main'], { cwd: root });

  run('git', ['switch', '-c', EPIC], { cwd: root });
  const created = await createInitiative(root, { id: EPIC, profile: 'epic-planning' });
  const initiative = created.initiative;
  const directory = initiativeDir(root, created.portfolio, EPIC);
  const write = async (relative, body) => {
    const target = path.join(directory, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
    return { sha256: createHash('sha256').update(body).digest('hex'), bytes: Buffer.byteLength(body) };
  };
  for (const [phaseId, outputId, body] of [
    ['epic-requirements', 'requirements-specification', REQUIREMENTS],
    ['epic-requirements', 'requirements-traceability', 'version: 1\n'],
    ['epic-requirements', 'impact-analysis', 'version: 1\nrepositories: {}\n'],
    ['epic-planning', 'parent-specification', '# Parent specification\n']
  ]) {
    const output = initiative.phases[phaseId].outputs[outputId];
    Object.assign(output, { ...(await write(output.path, body)), status: 'approved', generation: 1 });
  }
  const specifications = [];
  for (const [planId, purpose] of [['STORY-001', 'Apply one valid coupon; refuse an expired one.'], ['STORY-002', 'A second coupon replaces the first.']]) {
    const relative = `stories/${planId}/story-spec.md`;
    const pinned = await write(`artifacts/epic-planning/${relative}`, `# Story Specification — ${planId}\n\n## Purpose and boundary\n\n${purpose}\n`);
    specifications.push({ planId, path: relative, ...pinned });
  }
  const index = initiative.phases['epic-planning'].outputs['story-specification-index'];
  Object.assign(index, { ...(await write(index.path, YAML.stringify({ version: 1, epicId: EPIC, stories: specifications }))), status: 'approved', generation: 1 });
  for (const phaseId of ['epic-intake', 'epic-requirements', 'epic-planning']) initiative.phases[phaseId].status = 'approved';
  initiative.currentPhase = 'epic-publish';
  await saveInitiative(root, created.portfolio, initiative);
  await writeFile(path.join(directory, 'breakdown.yml'), YAML.stringify({
    version: 2, initiativeId: EPIC,
    epics: [{ planId: 'EPIC-001', title: 'Coupons', stories: [
      { planId: 'STORY-001', workId: STORIES[0], title: 'Apply a coupon code', repository: 'app',
        requirements: ['REQ-001', 'REQ-002'], acceptanceCriteria: ['AC-001', 'AC-002'], blocking: true, suggestedWorkType: 'feature' },
      { planId: 'STORY-002', workId: STORIES[1], title: 'Replace a coupon', repository: 'app',
        requirements: ['REQ-003'], acceptanceCriteria: ['AC-003'], blocking: true, suggestedWorkType: 'feature' }
    ] }]
  }));
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', `[${EPIC}] Approve planning`], { cwd: root });
  run('git', ['push', '-u', 'origin', EPIC], { cwd: root });
  const released = JSON.parse(flow(root, ['epic', 'create-stories', '--epic', EPIC, '--confirm', EPIC, '--json']).stdout);
  assert.equal(released.materialization.status, 'complete', JSON.stringify(released.materialization));
  return { root, remote };
}

const worktreeOf = (root, workId) => run('git', ['worktree', 'list', '--porcelain'], { cwd: root }).stdout
  .split(/\n\n/u).find((entry) => entry.includes(`branch refs/heads/${workId}\n`) || entry.endsWith(`branch refs/heads/${workId}`))
  ?.match(/^worktree (.+)$/mu)?.[1];

test('released Epic Stories start side by side from one checkout, and each first step sees its pinned Epic context',
  { timeout: 120_000 }, async () => {
    const { root, remote } = await releasedEpic();
    const epicHead = run('git', ['rev-parse', `origin/${EPIC}`], { cwd: root }).stdout.trim();
    const seed = YAML.parse(run('git', ['--git-dir', remote, 'show', `${STORIES[0]}:singularity/seeds/${STORIES[0]}.yml`], { cwd: root }).stdout);
    assert.notEqual(seed.story.baseCommit, epicHead, 'release committed on the Epic branch after the seed pinned its base');

    // Release used to be the end of the road: epic next offered only the report.
    const offered = JSON.parse(flow(root, ['epic', 'next', '--epic', EPIC, '--json']).stdout);
    assert.deepEqual(offered.filter((action) => action.action === 'start').map((action) => action.command),
      STORIES.map((workId) => `singularity-flow start ${workId} --isolated-worktree --from-branch ${EPIC}`));

    // Both from the Epic checkout, as isolated worktrees: the second one used to need a second clone,
    // because the launch observed the moved Epic head and refused "Selected base moved".
    for (const workId of STORIES) {
      const started = flow(root, ['start', workId, '--isolated-worktree', '--from-branch', EPIC, '--json'], { allowFailure: true });
      assert.equal(started.status, 0, `${workId}\n${started.stdout}\n${started.stderr}`);
      assert.equal(JSON.parse(started.stdout).outcome.status, 'succeeded');
    }
    assert.equal(run('git', ['branch', '--show-current'], { cwd: root }).stdout.trim(), EPIC, 'the launch checkout stays on the Epic');
    const checkouts = STORIES.map((workId) => worktreeOf(root, workId));
    assert.ok(checkouts.every(Boolean) && checkouts[0] !== checkouts[1], JSON.stringify(checkouts));
    for (const workId of STORIES) {
      const published = run('git', ['--git-dir', remote, 'log', '--format=%s', '-2', workId], { cwd: root }).stdout;
      assert.match(published, new RegExp(`\\[${workId}\\]\\[init\\][\\s\\S]*\\[seed\\]`), 'each Story starts on its own released seed');
    }
    const after = JSON.parse(flow(root, ['epic', 'next', '--epic', EPIC, '--json']).stdout);
    assert.deepEqual(after.filter((action) => action.action === 'start'), [], 'a started Story is no longer offered');

    // The first step's composed prompt carries the Story's own allocation, the Epic's decisions and
    // its Story specification, quoted only after each file matched the hash the seed pins.
    const entered = JSON.parse(flow(checkouts[0], ['phase', 'enter', '--compose', '--for-agent', '--json']).stdout);
    const result = JSON.parse(await readFile(entered.agentOutput.path, 'utf8'));
    const prompt = await readFile(result.context.text.textFile, 'utf8');
    const epicContext = prompt.slice(prompt.indexOf('## Pinned Epic context'));
    assert.ok(prompt.indexOf('## Pinned Epic context') > prompt.indexOf('# Pinned Story source'), 'inside the pinned Story source section');
    assert.match(epicContext, /The cart shall show the discounted total for a valid coupon code\./);
    assert.match(epicContext, /When: the customer enters an expired coupon code/);
    assert.match(epicContext, /\| D-001 \| Only one coupon per order \| Decided \| The newest coupon replaces the previous one \|/);
    assert.match(epicContext, /Apply one valid coupon; refuse an expired one\./);
    assert.match(epicContext, new RegExp(`singularity/story-context/${STORIES[0]}/requirements\\.md\` \\(requirements\\) · \`${seed.governedContext[0].sha256.slice(0, 12)}\` verified`));
    assert.doesNotMatch(prompt, /REQ-003|AC-003|A second coupon code shall replace the first/, 'only this Story\'s allocation');
  });
