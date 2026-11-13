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
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { refusalRemediationPlan, KNOWN_REFUSAL_CODES } from '../src/refusal-remediation.mjs';
import { codeStepTemplate, openConvergenceTemplate, registryReader, releaseDraftTemplate, returnedRoutes, routeEffect, storyCopy, walk, WORK } from './helpers/route-walker.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RATCHET = JSON.parse(readFileSync(path.join(ROOT, 'test/fixtures/known-dead-ends.json'), 'utf8'));
// Lowered as entries go. Raising one is a decision a reviewer sees, not a line in a long list.
const CEILING = Object.freeze({ walks: 0, readOnlyFirstRoutes: 173 });

const MAJOR = process.versions.node.split('.')[0];
// A Node this machine does not run, as a small script that runs the real one (project-node-version.test.mjs), and a
// package that asks for it: the run fails on the Node here and passes on that one, on any machine.
const OTHER_MAJOR = Number(MAJOR) + 100;
// What a decision changed in the code step, named in its summary written after it: the author's own correction,
// or prepublish refuses the summary [owner, 2026-11-13].
const SUMMARY = `singularity/work-items/${WORK}/artifacts/implementation/implementation-summary.md`;
const namedInSummary = (...files) => async (story) => `${await readFile(path.join(story.root, SUMMARY), 'utf8')}\nChanged for the Node its tests need: ${files.map((file) => `\`${file}\``).join(', ')}.\n`;
const onTheWrongNode = async (story) => {
  const home = path.join(story.parent, 'other-node');
  const directory = path.join(home, 'versions', 'node', `v${OTHER_MAJOR}.0.0`, 'bin');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'node'), `#!/bin/sh\nif [ "$1" = --version ]; then echo v${OTHER_MAJOR}.0.0; exit 0; fi\nFAKE_NODE=${OTHER_MAJOR} exec '${process.execPath}' "$@"\n`);
  await chmod(path.join(directory, 'node'), 0o755);
  story.env = { NVM_DIR: home };
  await story.write('package.json', JSON.stringify({ type: 'module', private: true, engines: { node: `>=${OTHER_MAJOR}` }, scripts: { test: 'node --test' } }));
  await story.write('test/value.test.mjs', `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {value} from '../src/value.mjs';\n// @ac:${WORK}:AC-001\ntest('value', () => { assert.equal(value,2); assert.equal(process.env.FAKE_NODE, '${OTHER_MAJOR}'); });\n`);
  const why = 'The package now says which Node its tests need.';
  story.cli('decision', 'plan', WORK, '--add-supporting', 'package.json=build-configuration', '--supporting-reason', why, '--reason', why);
  await story.write(SUMMARY, await namedInSummary('package.json')(story));
};
const published = (result) => result?.publishIfReady?.published === true || (result?.resultType === 'sflow-phase-publication' && result?.status === 'published');
const PREPUBLISH = 'singularity-flow phase prepublish implementation --for-agent --json --publish-if-ready';
// Since CQF M2 `appeal prepare` records its changes as departures a person decides on the list [CQF:REQ-029].
const prepared = (result) => Boolean(result?.data?.packet) || result?.data?.status === 'departure-recorded';
const unplannedHelper = async (story) => {
  await story.write('src/helper.mjs', 'export const approved = 2;\n');
  await story.write('src/value.mjs', `// @clause:${WORK}:AC-001 the module returns the approved value from its helper\nimport {approved} from './helper.mjs';\nexport const value = approved;\n`);
};

// Each one a fault a real run met; `real` says where it came from in the logs' ranking, and `meets` is
// what the walk must run into, so a fault that stopped firing cannot pass as a route that works.
const SCENARIOS = Object.freeze([
  { id: 'session-current-with-an-option-it-does-not-take', meets: 'SESSION_AGENT_OPTIONS_INVALID', real: 'SESSION_AGENT_OPTIONS_INVALID: the session ended there, with help as its route',
    start: 'singularity-flow session current --for-agent --json --fetch', reached: (result) => result?.ready === true },
  { id: 'review-source-status-as-an-agent-asks', meets: null, real: 'REVIEW_SOURCE_OPTIONS_INVALID: 4 hits, 0 advanced: every command takes --for-agent, and this read refused it',
    start: 'singularity-flow review-source status implementation --for-agent --json', reached: (result) => Boolean(result?.outcome ?? result?.status ?? result?.required !== undefined) },
  { id: 'release-on-a-reused-run', meets: 'next', real: 'a real Story: Release marked every clause partial because Verification reused its runs', template: 'release', phase: 'release',
    start: 'singularity-flow phase prepublish release --for-agent --json --publish-if-ready', reached: published },
  { id: 'release-says-less-than-the-record', meets: 'CONFORMANCE_BLOCKING_VERDICTS', real: 'a real Story: "raise one against implementation", with nothing wrong with Implementation', template: 'releasePartial', phase: 'release',
    setup: (story) => { story.cli('phase', 'publish', 'release', '--authored', 'human', '--channel', 'manual-in-place'); story.cli('submit', 'release'); },
    start: `singularity-flow approve release --work-id ${WORK} --yes --json`,
    reasons: { CONFORMANCE_BLOCKING_VERDICTS: { mustNotMatch: /raise one against/u, mustMatch: /reads it satisfied/u, because: 'the record reads these clauses satisfied, so nothing shows the step before it at fault' } } },
  { id: 'node-version', meets: 'CODE_TEST_FAILED', real: 'a real Story: tests fail only on this Node; CODE_TEST_FAILED ranks first',
    setup: onTheWrongNode, start: PREPUBLISH, reached: published,
    // The pin creates .nvmrc after the summary was written: the author says so, as on the real Story [owner, 2026-11-13].
    writes: { '/sf-code': { [SUMMARY]: namedInSummary('.nvmrc') } } },
  { id: 'nvmrc-names-a-node-not-here', meets: 'CODE_TEST_FAILED', real: 'the .nvmrc is the answer already, and names a Node this machine does not have',
    setup: async (story) => {
      await onTheWrongNode(story);
      await story.write('.nvmrc', `${OTHER_MAJOR + 50}\n`);
      const why = 'The repository says which Node its tests need.';
      story.cli('decision', 'plan', WORK, '--add-supporting', '.nvmrc=build-configuration', '--supporting-reason', why, '--reason', why);
      await story.write(SUMMARY, await namedInSummary('.nvmrc')(story));
    }, start: PREPUBLISH, reached: published },
  // /sf-appeal with nothing to appeal: it said to go back to /sf-code, which could not change the Node either.
  { id: 'appeal-with-none-open', meets: 'next', real: 'a real Story: the chain /sf-code, /sf-appeal, /sf-code on a Node only a person can pin',
    setup: async (story) => { await onTheWrongNode(story); story.raw(PREPUBLISH.split(' ').slice(1), story.env); },
    start: 'singularity-flow appeal preflight --phase implementation --for-agent --json',
    reached: (result) => (result?.next ?? []).some((entry) => /^\/sf-decide/u.test(entry.copilotCommand ?? entry.commandGuidance?.copilotCommand ?? '')) && /No appeal is open/u.test(JSON.stringify(result)) },
  { id: 'test-fails-for-a-real-bug', meets: 'CODE_TEST_FAILED', real: 'the same refusal when the code is at fault: a route that can change the state has a way through',
    setup: (story) => story.write('src/value.mjs', `// @clause:${WORK}:AC-001 returns the approved value to every caller\nexport const value = 3;\n`), start: PREPUBLISH, reached: published,
    writes: { '/sf-code': { 'src/value.mjs': `// @clause:${WORK}:AC-001 returns the approved value to every caller\nexport const value = 2;\n` } } },
  { id: 'chain-under-another-node', meets: 'PHASE_MUTATION_SHELL_COMMAND_UNVERIFIED', real: 'a real Story: the same check, tried under another Node with a PATH prefix',
    setup: onTheWrongNode, reached: published,
    guard: { prompt: '/sf-code', toolArgs: { command: `PATH="/opt/tool/node@${OTHER_MAJOR}/bin:$PATH" ${PREPUBLISH}` } } },
  // Since CQF M2 the agent's prepublish records the path as a departure and publishes: no person stops it here,
  // and the step's approval waits for them instead [CQF:REQ-021, REQ-022].
  { id: 'plan-hold-on-unnamed-path', meets: null, real: 'a changed path no plan row names', setup: unplannedHelper, start: PREPUBLISH, reached: published,
    answers: { CLAUSE: `${WORK}:AC-001`, why: 'The small helper implements the already approved return value.' } },
  { id: 'appeal-for-a-file-not-there-yet', meets: 'PHASE_APPEAL_PATH_UNSUPPORTED', real: 'a real Story: the person chose a pin, and the appeal blamed protected paths', reached: prepared,
    start: "singularity-flow appeal prepare --phase implementation --add-supporting .nvmrc=build-configuration --supporting-reason 'Tests fail on this Node, so the repository pins one.' --reason 'The person chose a pinned Node version for this Story.' --for-agent --json",
    writes: { PHASE_APPEAL_PATH_UNSUPPORTED: { '.nvmrc': '22\n' } },
    reasons: { PHASE_APPEAL_PATH_UNSUPPORTED: { mustMatch: /does not exist/u, mustNotMatch: /Protected paths/u, because: 'nothing here is protected: the file does not exist yet' } } },
  { id: 'appeal-with-no-changes-listed', meets: 'PHASE_APPEAL_INVALID', real: 'a real Story: a bare appeal prepare, which lost the choice', reached: prepared,
    setup: unplannedHelper, start: 'singularity-flow appeal prepare --phase implementation --for-agent --json',
    answers: { CLAUSE: `${WORK}:AC-001`, PATH: 'src/helper.mjs', REASON: 'The small helper implements the already approved return value.' },
    reasons: { PHASE_APPEAL_INVALID: { mustMatch: /needs what to account for[^]*src\/helper\.mjs/u, because: 'a bare prepare names what it needs and which paths' } } },
  { id: 'appeal-with-no-supporting-reason', meets: 'PHASE_APPEAL_INVALID', real: 'SINGULARITY_FLOW_ERROR: 12 dead-end hits, the code with no plan of its own', reached: prepared,
    setup: (story) => story.write('.nvmrc', '22\n'), answers: { WHY: 'Tests fail on this Node, so the repository pins one.' },
    start: "singularity-flow appeal prepare --phase implementation --add-supporting .nvmrc=build-configuration --reason 'The person chose a pinned Node version for this Story.' --for-agent --json" },
  { id: 'chain-in-the-decision-turn', meets: 'PHASE_MUTATION_SHELL_COMMAND_UNVERIFIED', real: 'a chain refused inside the turn that owns the decision',
    guard: { prompt: `/sf-decide ${WORK}`, toolArgs: { command: `singularity-flow decision plan ${WORK} --add-location ${WORK}:AC-001=src/a.mjs --reason "The first file implements the clause." && singularity-flow decision plan ${WORK} --add-location ${WORK}:AC-001=src/b.mjs --reason "The second file implements the clause."` } } },
  { id: 'decision-outside-its-turn', meets: 'PHASE_MUTATION_OPERATION_NOT_ALLOWED', real: 'PHASE_MUTATION_OPERATION_NOT_ALLOWED: 3 hits, 0 advanced', setup: unplannedHelper,
    guard: { prompt: '/sf-code', toolArgs: { command: `singularity-flow decision plan ${WORK} --add-location ${WORK}:AC-001=src/helper.mjs --reason "The small helper implements the already approved return value."` } } },
  { id: 'edit-in-a-read-turn', meets: 'PHASE_MUTATION_PATH_DENIED', real: 'PHASE_MUTATION_TURN_READ_ONLY in older builds: 14 hits, 0 advanced', guard: { prompt: '/sf-next', toolName: 'edit', toolArgs: { path: 'src/value.mjs' } } },
  { id: 'delegating-in-a-read-turn', meets: 'PHASE_MUTATION_DELEGATION_NOT_ALLOWED', real: 'PHASE_MUTATION_DELEGATION_NOT_ALLOWED: 2 hits, 0 advanced',
    guard: { prompt: '/sf-next', toolName: 'task', toolArgs: { prompt: 'Work on the code step.' } } },
  // Allowed now: looking at one named path is no search, and copilot-repository-boundary.test.mjs holds that real searches stay refused.
  { id: 'looking-for-node-is-not-a-repository-search', meets: null, real: 'a real Story: ls on a Node path, refused as a repository search',
    guard: { prompt: '/sf-code', toolArgs: { command: 'ls -l /opt/tool/node@22/bin/node' } } },
  { id: 'dirty-checkout-at-approval', meets: 'LIFECYCLE_WORKTREE_REVIEW_REQUIRED', real: 'LIFECYCLE_WORKTREE_REVIEW_REQUIRED: 3 of 3 stopped, and each session ended', personFlags: ['--yes'],
    setup: async (story) => {
      story.cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
      story.cli('submit', 'implementation');
      await story.write('NOTES.md', 'A note left in the checkout.\n');
    }, start: `singularity-flow approve implementation --work-id ${WORK} --yes --json`, reached: (result) => result?.status === 'approved' },
  { id: 'convergence-with-items-open', meets: 'ask-person', real: 'open items at convergence wait for a person, on /sf-converge', template: 'convergence', phase: 'convergence',
    start: 'singularity-flow phase prepublish convergence --for-agent --json --publish-if-ready', reached: published,
    answers: { choice: 'deferred', reason: 'The person keeps this for a later Story.' } },
  { id: 'ending-with-items-open', meets: 'STORY_TERMINAL_READINESS_REFUSED', real: 'STORY_TERMINAL_READINESS_REFUSED: 3 hits, 2 stopped, 0 advanced', template: 'ending', phase: 'convergence',
    setup: (story) => {
      for (const item of JSON.parse(story.cli('story', 'adjudications', '--json').stdout).items) story.cli('story', 'adjudicate', item.id, '--disposition', 'deferred', '--reason', 'The person keeps this for a later Story.');
      story.cli('phase', 'prepublish', 'convergence', '--for-agent', '--json', '--publish-if-ready');
    }, start: `singularity-flow story advance --work-id ${WORK}`, reached: (result) => result?.phaseStatus === 'awaiting_approval',
    answers: { 'what-is-wrong': 'The second requirement has no test of its own.' } }
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
  // The ending: a work type whose last step is convergence, so the final check comes up there.
  const endAtConvergence = (configuration) => {
    const workType = configuration.workTypes['spec-driven-standard'];
    workType.phases = workType.phases.slice(0, workType.phases.indexOf('convergence') + 1);
    for (const dropped of ['verification', 'release']) delete workType.phaseOverrides?.[dropped];
  };
  const needed = new Set(SCENARIOS.filter((entry) => !process.env.WALK_ONLY || process.env.WALK_ONLY.split(',').includes(entry.id)).map((entry) => entry.template ?? 'code'));
  const build = (name, make) => (needed.has(name) ? make() : null);
  const templates = { code: await build('code', () => codeStepTemplate(t)), convergence: await build('convergence', () => openConvergenceTemplate(t)),
    ending: await build('ending', () => openConvergenceTemplate(t, { configure: endAtConvergence })),
    release: await build('release', () => releaseDraftTemplate(t)), releasePartial: await build('releasePartial', () => releaseDraftTemplate(t, { verdict: 'partial' })) };
  // A person fixing one route walks only that one: WALK_ONLY=a,b. The full list is what the suite holds.
  const only = process.env.WALK_ONLY?.split(',');
  for (const scenario of SCENARIOS.filter((entry) => !only || only.includes(entry.id))) {
    await t.test(scenario.id, async (sub) => {
      const story = await storyCopy(sub, templates[scenario.template ?? 'code']);
      await scenario.setup?.(story);
      const result = await walk(story, scenario);
      const seen = result.findings.map(keyOf).sort();
      const listed = Object.keys(RATCHET.walks[scenario.id] ?? {}).sort();
      const context = `${scenario.id}: ${result.outcome}\n${result.trail.map((step) => JSON.stringify(step)).join('\n')}\n${JSON.stringify(result.findings, null, 1)}`;
      assert.ok(result.trail.some((step) => step.code === scenario.meets || step.act === scenario.meets), `the fault no longer fires, so this walk proves nothing: it should meet ${scenario.meets}\n${context}`);
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
    checkoutPath: '/tmp/checkout', storyId: 'W-1', expectedWorkId: 'W-1',
    setAside: { command: 'singularity-flow recover W-1 --set-aside --confirm sha256:abc', paths: ['a.txt'] } };
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
