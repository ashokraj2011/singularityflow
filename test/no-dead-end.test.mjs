/**
 * No dead ends: a refusal leads somewhere. `test/dead-end-routes.test.mjs` checks that a route is well
 * formed; this checks that it helps.
 *
 * - The walk: a bot with no model (test/helpers/route-walker.mjs) meets a fault taken from a real run,
 *   on the real binary, and does only what SFlow returned. It must reach the step's outcome or a
 *   person's command that really runs, never return to the same refusal on the same state, never be
 *   left with nothing or with only reads unless the refusal names who decides, and be told the truth.
 * - The static layer: each known refusal's first route is classified, and the read-only ones listed.
 *
 * What is wrong today stays visible in fixtures/known-dead-ends.json, each entry with its reason, and
 * that list only shrinks. A new dead end fails here. So does a fixed one, until its entry is removed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { refusalRemediationPlan, KNOWN_REFUSAL_CODES } from '../src/refusal-remediation.mjs';
import { codeStepTemplate, openConvergenceTemplate, registryReader, returnedRoutes, routeEffect, storyCopy, walk, WORK } from './helpers/route-walker.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RATCHET = JSON.parse(readFileSync(path.join(ROOT, 'test/fixtures/known-dead-ends.json'), 'utf8'));
// Lowered as entries go. Raising one is a decision a reviewer sees, not a line in a long list.
const CEILING = Object.freeze({ walks: 19, readOnlyFirstRoutes: 181 });

const MAJOR = process.versions.node.split('.')[0];
const failingOnThisNode = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {value} from '../src/value.mjs';\n// @ac:${WORK}:AC-001\ntest('value', () => { assert.equal(value,2); assert.notEqual(process.versions.node.split('.')[0], '${MAJOR}'); });\n`;
const published = (result) => result?.publishIfReady?.published === true || (result?.resultType === 'sflow-phase-publication' && result?.status === 'published');
const PREPUBLISH = 'singularity-flow phase prepublish implementation --for-agent --json --publish-if-ready';
const prepared = (result) => Boolean(result?.data?.packet);
const unplannedHelper = async (story) => {
  await story.write('src/helper.mjs', 'export const approved = 2;\n');
  await story.write('src/value.mjs', `// @clause:${WORK}:AC-001 the module returns the approved value from its helper\nimport {approved} from './helper.mjs';\nexport const value = approved;\n`);
};

// Each one a fault a real run met; `real` says where it came from in the logs' ranking.
const SCENARIOS = Object.freeze([
  { id: 'node-version', real: 'a real Story: tests fail only on this Node; CODE_TEST_FAILED ranks first',
    setup: (story) => story.write('test/value.test.mjs', failingOnThisNode), start: PREPUBLISH, reached: published },
  { id: 'chain-under-another-node', real: 'a real Story: the same check, tried under another Node with a PATH prefix',
    setup: (story) => story.write('test/value.test.mjs', failingOnThisNode), reached: published,
    guard: { prompt: '/sf-code', toolArgs: { command: `PATH="/opt/tool/node@22/bin:$PATH" ${PREPUBLISH}` } } },
  { id: 'plan-hold-on-unnamed-path', real: 'a changed path no plan row names', setup: unplannedHelper, start: PREPUBLISH, reached: published,
    answers: { CLAUSE: `${WORK}:AC-001`, why: 'The small helper implements the already approved return value.' } },
  { id: 'appeal-for-a-file-not-there-yet', real: 'a real Story: the person chose a pin, and the appeal blamed protected paths', reached: prepared,
    start: "singularity-flow appeal prepare --phase implementation --add-supporting .nvmrc=build-configuration --supporting-reason 'Tests fail on this Node, so the repository pins one.' --reason 'The person chose a pinned Node version for this Story.' --for-agent --json",
    reasons: { PHASE_APPEAL_PATH_UNSUPPORTED: { mustMatch: /does not exist/u, mustNotMatch: /Protected paths/u, because: 'nothing here is protected: the file does not exist yet' } } },
  { id: 'appeal-with-no-changes-listed', real: 'a real Story: a bare appeal prepare, which lost the choice', reached: prepared,
    start: 'singularity-flow appeal prepare --phase implementation --for-agent --json' },
  { id: 'appeal-with-no-supporting-reason', real: 'SINGULARITY_FLOW_ERROR: 12 dead-end hits, the code with no plan of its own', reached: prepared,
    start: "singularity-flow appeal prepare --phase implementation --add-supporting .nvmrc=build-configuration --reason 'The person chose a pinned Node version for this Story.' --for-agent --json" },
  { id: 'chain-in-the-decision-turn', real: 'a chain refused inside the turn that owns the decision',
    guard: { prompt: `/sf-decide ${WORK}`, toolArgs: { command: `singularity-flow decision plan ${WORK} --add-location ${WORK}:AC-001=src/a.mjs --reason "The first file implements the clause." && singularity-flow decision plan ${WORK} --add-location ${WORK}:AC-001=src/b.mjs --reason "The second file implements the clause."` } } },
  { id: 'decision-outside-its-turn', real: 'PHASE_MUTATION_OPERATION_NOT_ALLOWED: 3 hits, 0 advanced', setup: unplannedHelper,
    guard: { prompt: '/sf-code', toolArgs: { command: `singularity-flow decision plan ${WORK} --add-location ${WORK}:AC-001=src/helper.mjs --reason "The small helper implements the already approved return value."` } } },
  { id: 'edit-in-a-read-turn', real: 'PHASE_MUTATION_TURN_READ_ONLY: 14 hits, 0 advanced', guard: { prompt: '/sf-next', toolName: 'edit', toolArgs: { path: 'src/value.mjs' } } },
  { id: 'looking-for-node-is-not-a-repository-search', real: 'a real Story: ls on a Node path, refused as a repository search',
    guard: { prompt: '/sf-code', toolArgs: { command: 'ls -l /opt/tool/node@22/bin/node' } },
    reasons: { GUARD_PROSE: { mustNotMatch: /discover a repository/u, because: 'it looked for a tool, and no repository' } } },
  { id: 'dirty-checkout-at-approval', real: 'LIFECYCLE_WORKTREE_REVIEW_REQUIRED: 3 of 3 stopped, and each session ended', personFlags: ['--yes'],
    setup: async (story) => {
      story.cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
      story.cli('submit', 'implementation');
      await story.write('NOTES.md', 'A note left in the checkout.\n');
    }, start: `singularity-flow approve implementation --work-id ${WORK} --yes --json`, reached: (result) => result?.status === 'approved' },
  { id: 'convergence-with-items-open', real: 'STORY_TERMINAL_READINESS_REFUSED and /sf-converge: open items wait for a person', template: 'convergence', phase: 'convergence',
    start: 'singularity-flow phase prepublish convergence --for-agent --json --publish-if-ready', reached: published,
    answers: { choice: 'deferred', reason: 'The person keeps this for a later Story.' } }
]);

const keyOf = (entry) => `${entry.kind}:${entry.code}`;

test('a route is what a result returned, and its effect comes from what it runs', async () => {
  const isRead = await registryReader();
  const effect = (route) => routeEffect(route, isRead);
  assert.equal(effect({ command: 'singularity-flow recover --phase build --json', skill: '/sf-recover' }), 'read-only');
  assert.equal(effect({ skill: '/sf-recover' }), 'read-only');
  assert.equal(effect({ command: 'singularity-flow phase publish build --authored human --channel manual-in-place' }), 'can-change');
  assert.equal(effect({ command: 'singularity-flow phase prepublish build --for-agent --json' }), 'read-only');
  assert.equal(effect({ command: 'singularity-flow phase prepublish build --for-agent --json --publish-if-ready' }), 'can-change');
  assert.equal(effect({ skill: '/sf-code' }), 'can-change');
  assert.equal(effect({ command: `singularity-flow decision plan ${WORK} --add-location A=b --reason why`, skill: '/sf-decide' }), 'person-decision');
  assert.equal(effect({ command: 'singularity-flow prepare convergence', skill: '/sf-converge' }), 'can-change', 'the command says what it is, whichever skill it came under');
  assert.equal(effect({ command: `singularity-flow recover ${WORK} --set-aside --confirm sha256:abc` }), 'person-decision');
  assert.equal(effect({ skill: '/sf-decide' }), 'person-decision');
  assert.equal(effect({ command: `singularity-flow cancel ${WORK} --reason x`, skill: '/sf-cancel' }), 'gives-up');
  assert.equal(effect({ command: 'singularity-flow sync' }), 'machine-finishing');
  assert.deepEqual(returnedRoutes({ act: { do: { shell: 'singularity-flow recover --json', copilot: '/sf-recover' }, said: 'Run singularity-flow approve build now.', fix: ['singularity-flow reject'] },
    remediationPlan: { steps: [{ command: 'singularity-flow recover --json', skill: '/sf-recover' }, { label: 'words only' }, { command: 'singularity-flow phase show build', skill: '/sf-phase-documents' }] },
    next: ['singularity-flow prepare build'], commands: { publish: null }, resolution: { issues: [{ choices: [{ commandGuidance: { command: 'singularity-flow decision plan X', copilotCommand: '/sf-decide' } }] }] } })
    .map((route) => route.command), ['singularity-flow recover --json', 'singularity-flow phase show build', 'singularity-flow prepare build', 'singularity-flow decision plan X'],
  'words never count as a route');
});

test('every walk reaches its outcome or a person, or its dead end is on the list', slowLane({ timeout: 900_000 }), async (t) => {
  const templates = { code: await codeStepTemplate(t), convergence: await openConvergenceTemplate(t) };
  for (const scenario of SCENARIOS) {
    await t.test(scenario.id, async (sub) => {
      const story = await storyCopy(sub, templates[scenario.template ?? 'code']);
      await scenario.setup?.(story);
      const result = await walk(story, scenario);
      const seen = result.findings.map(keyOf).sort();
      const listed = Object.keys(RATCHET.walks[scenario.id] ?? {}).sort();
      const context = `${scenario.id}: ${result.outcome}\n${result.trail.map((step) => JSON.stringify(step)).join('\n')}\n${JSON.stringify(result.findings, null, 1)}`;
      assert.deepEqual(seen.filter((key) => !listed.includes(key)), [], `a new dead end: fix it, this list only shrinks\n${context}`);
      assert.deepEqual(listed.filter((key) => !seen.includes(key)), [], `no longer a dead end: remove it from known-dead-ends.json\n${context}`);
      if (result.outcome === 'dead-end') assert.ok(listed.length, `a dead end with nothing listed\n${context}`);
    });
  }
});

test('the first route of each known refusal is classified, and the read-only ones are on the list', async () => {
  const details = { workId: 'W-1', phase: 'build', phaseId: 'build', currentPhase: 'build', documentId: 'DOC-001', decidableStep: 'plan',
    issue: 'UPI-001', workType: 'feature', upstreamPhases: ['plan'], producerPhase: 'plan', restorable: true, paths: ['a.txt'],
    recoveryCommand: 'singularity-flow recover W-1 --json', errors: ['x'], authorities: ['product'], capabilityId: 'web-app',
    checkoutPath: '/tmp/checkout', storyId: 'W-1', expectedWorkId: 'W-1' };
  const isRead = await registryReader();
  const readOnly = new Set();
  for (const code of KNOWN_REFUSAL_CODES) {
    const plan = refusalRemediationPlan(Object.assign(new Error('refused'), { code, details }), ['phase', 'prepublish', 'build', '--work-id', 'W-1']);
    const first = plan.steps.find((entry) => entry.command || entry.skill);
    const effect = first ? routeEffect({ command: first.command ?? null, skill: first.skill ?? null }, isRead) : 'none';
    if (effect === 'read-only' || effect === 'none') readOnly.add(code);
  }
  const listed = new Set(RATCHET.readOnlyFirstRoutes.flatMap((group) => group.codes));
  assert.deepEqual([...readOnly].filter((code) => !listed.has(code)).sort(), [], 'a refusal whose first route only reads: give it a way through, this list only shrinks');
  assert.deepEqual([...listed].filter((code) => !readOnly.has(code)).sort(), [], 'no longer read-only: remove it from known-dead-ends.json');
});

test('the dead-end list says why for each entry, and only shrinks', () => {
  const walks = Object.entries(RATCHET.walks).flatMap(([scenario, entries]) => Object.entries(entries).map(([key, reason]) => [`${scenario} ${key}`, reason]));
  const groups = RATCHET.readOnlyFirstRoutes.map((group) => [group.codes.join(' '), group.reason]);
  for (const [key, reason] of [...walks, ...groups]) assert.ok(typeof reason === 'string' && reason.length >= 20, `${key} needs its reason`);
  assert.ok(walks.length <= CEILING.walks, `${walks.length} walks listed, ceiling ${CEILING.walks}`);
  const first = RATCHET.readOnlyFirstRoutes.flatMap((group) => group.codes);
  assert.equal(new Set(first).size, first.length, 'a code listed twice');
  assert.ok(first.length <= CEILING.readOnlyFirstRoutes, `${first.length} first routes listed, ceiling ${CEILING.readOnlyFirstRoutes}`);
  const scenarios = new Set(SCENARIOS.map((scenario) => scenario.id));
  assert.deepEqual(Object.keys(RATCHET.walks).filter((id) => !scenarios.has(id)), [], 'a listed walk with no scenario');
});
