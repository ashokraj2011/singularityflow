import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ID = 'demo-check-repair-close';
const PHASES = ['demo-intake', 'demo-check', 'demo-repair', 'demo-close'];
const AGENTS = ['demo-intake-analyst', 'demo-code-checker', 'demo-code-repairer', 'demo-story-closer'];

// A real Story on the demo workflow, with the channel chosen once at intake: the check's decision
// reuses it, so the check is submitted without being asked again and a web Story skips the repair.
test('a real Story chooses the channel once and a later decision routes on it without asking again', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-decision-reuse-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeDefinition(root);
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Demo Reviewer',
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.git/test-active-workspace.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.git/test-workspaces.json'),
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: ID, agent: AGENTS[0] }) };
  delete env.NODE_TEST_CONTEXT;
  const run = (command, args, { allowFailure = false } = {}) => {
    const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 120000 });
    if (!allowFailure) assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return allowFailure ? result : result.stdout;
  };
  run('git', ['init', '-b', 'main']); run('git', ['config', 'user.name', 'Demo Reviewer']);
  run('git', ['config', 'user.email', 'demo@example.test']);
  await writeFile(path.join(root, 'README.md'), '# Demo fixture\n');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off'; config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  const [check] = config.workTypes[ID].decisions;
  const close = check.routes.find((route) => route.to === 'demo-close');
  config.workTypes[ID].decisions = [
    { id: 'by-channel', after: 'demo-intake', kind: 'branch', label: 'Which channel?', inputs: [{ name: 'channel', label: 'Channel', values: ['web', 'mobile'] }],
      routes: [{ id: 'web', label: 'Web', when: { channel: 'web' }, to: 'next' }, { id: 'mobile', label: 'Mobile', to: 'next' }] },
    { ...check, inputs: [{ name: 'channel', from: 'by-channel' }], maxRounds: undefined,
      routes: [{ ...close, when: { channel: 'web' } }, { id: 'mobile-repair', label: 'Mobile goes through repair', to: 'demo-repair' }] },
    config.workTypes[ID].decisions[1]
  ];
  delete config.workTypes[ID].decisions[1].maxRounds;
  await writeFile(configPath, YAML.stringify(config));
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, 'src/screen.mjs'), 'export const title = "Approved screen";\n');
  await writeFile(path.join(root, 'test/screen.test.mjs'), `import test from 'node:test';
import assert from 'node:assert/strict';
import { title } from '../src/screen.mjs';
test('DEMO-001 shows the approved title', () => assert.equal(title, 'Approved screen'));
`);
  run('git', ['add', '.']); run('git', ['commit', '-m', 'Initialize demo fixture']);
  const remote = `${root}.git`;
  t.after(() => rm(remote, { recursive: true, force: true }));
  run('git', ['init', '--bare', '-b', 'main', remote]);
  run('git', ['remote', 'add', 'origin', remote]); run('git', ['push', '-u', 'origin', 'main']);
  const cli = (...args) => run(process.execPath, [path.join(ROOT, 'bin/singularity-flow.mjs'), '--no-model', ...args]);
  cli('start', 'REUSE-1', '--from-branch', 'main', '--work-type', ID, '--title', 'Check the screen title', '--description', 'Check the web title before closing.');
  const workRoot = path.join(root, 'singularity/work-items/REUSE-1');
  const readState = async () => JSON.parse(await readFile(path.join(workRoot, 'workflow.json'), 'utf8'));
  assert.deepEqual((await readState()).resolution.decisions.find((decision) => decision.id === 'demo-check-result').reuses.map((input) => [input.name, input.from, input.values]),
    [['channel', 'by-channel', ['web', 'mobile']]]);
  cli('wm', 'compose', '--phase', PHASES[0]);
  const responsePath = path.resolve(root, run('git', ['rev-parse', '--git-path', 'singularity-flow/clarification-responses/demo-intake.json']).trim());
  await mkdir(path.dirname(responsePath), { recursive: true });
  await writeFile(responsePath, JSON.stringify({ responses: [{
    question: 'What observable behavior, tool and repair scope are agreed?',
    answer: 'DEMO-001 must show Approved screen. Use node --test test/screen.test.mjs locally. Repair src/screen.mjs only if the title assertion fails. No browser or production access is required; human approval remains required.'
  }] }));
  cli('clarification', 'record', PHASES[0], '--response-file', responsePath);
  cli('prepare', PHASES[0]);
  await writeFile(path.join(workRoot, 'artifacts/demo-intake/intake.md'), `# Demo title acceptance
## Approved sources
The Story description requests testing the documented screen title before any repair. A screenshot is not required for this exact text assertion.
## Scope and acceptance criteria
[REUSE-1:AC-001] The screen title equals Approved screen. Repair is limited to src/screen.mjs; no dependency or policy change is authorized.
## Scenario matrix
DEMO-001 checks AC-001 through the named executable assertion DEMO-001 shows the approved title in test/screen.test.mjs.
## Test environment and commands
Run node --test test/screen.test.mjs locally. No browser, remote service or production data is needed. Intake does not execute tests.
## Planned implementation evidence
| Clause | Expected paths | Planned tests |
| --- | --- | --- |
| REUSE-1:AC-001 | \`src/screen.mjs\` | \`test/screen.test.mjs\` |
## Routing and human checkpoints
The channel is web. Check existing behavior first; a web Story closes after a human-approved check, a mobile one is repaired and rechecked. Closing documents and final human approval end the Story.
`);
  cli('phase', 'publish', PHASES[0]);
  const unasked = run(process.execPath, [path.join(ROOT, 'bin/singularity-flow.mjs'), '--no-model', 'submit', PHASES[0]], { allowFailure: true });
  assert.match(unasked.stderr + unasked.stdout, /--decision channel=<web\|mobile>/u, 'the step that knows the channel records it');
  cli('submit', PHASES[0], '--decision', 'channel=web');
  cli('approve', PHASES[0], '--yes');
  assert.equal((await readState()).currentPhase, PHASES[1]);
  // A person published intake with a recorded answer: the gate re-checks that bound record too, and
  // one that no longer verifies only warns (it was never bound), so a Story is not held at its end.
  const gate = () => JSON.parse(run(process.execPath, [path.join(ROOT, 'bin/singularity-flow.mjs'), '--no-model', 'gate', '--json'], { allowFailure: true }).stdout);
  const checked = gate();
  assert.ok(checked.passes.includes(`clarification audit committed: ${PHASES[0]} generation 1`), checked.passes.join('\n'));
  const recordPath = path.join(workRoot, 'context', `clarifications-${PHASES[0]}-gen1.json`);
  const recorded = await readFile(recordPath, 'utf8');
  await writeFile(recordPath, JSON.stringify({ ...JSON.parse(recorded), completed: false }, null, 2));
  const loose = gate();
  assert.equal(loose.findings?.some((finding) => /^gate\.clarification/u.test(finding.code ?? '')) ?? false, false, JSON.stringify(loose.findings));
  assert.match(loose.warnings.join('\n'), new RegExp(`${PHASES[0]} generation 1 clarification record is not bound`, 'u'));
  await writeFile(recordPath, recorded);
  const scope = JSON.parse(cli('evidence', 'scope', '--json')).data.scope;
  for (const item of scope.items.filter((entry) => entry.disposition === 'unresolved')) {
    cli('decision', 'scope', '--item', item.id, '--as', 'included', '--clause', 'REUSE-1:AC-001',
      '--reason', 'The approved exact screen-title criterion carries the requested acceptance behavior.');
  }
  env.SINGULARITY_FLOW_TEST_SELECTION = JSON.stringify({ workType: ID, agent: AGENTS[1] });
  cli('prepare', PHASES[1]);
  const testedCommit = run('git', ['rev-parse', 'HEAD']).trim();
  await writeFile(path.join(workRoot, 'artifacts/demo-check/check-results.md'), `# Current code acceptance check
## Pinned inputs and tested revision
Approved intake REUSE-1, repository revision ${testedCommit}. Product source and test bytes are unchanged.
## Test execution and evidence
Executed node --test test/screen.test.mjs, exit 0; one assertion ran and passed.
## Source and visual comparison
The exported screen title equals the approved documented value. No visual assertion or browser access is required for this scenario.
## Scenario results
[REUSE-1:AC-001] DEMO-001 shows the approved title: passed. Actual title Approved screen matches the expected exact title; no required case was skipped.
## Verdict and repair request
verdict=pass. All required assertions executed successfully against current bytes; no repair is proposed.
## Human checkpoint
Pending authorized review of this exact report and no-additional-implementation applicability. The agent does not approve or close the Story.
`);
  cli('phase', 'publish', PHASES[1]);
  cli('submit', PHASES[1]);
  assert.equal((await readState()).phases[PHASES[1]].decisionInputs ?? null, null, 'nothing was asked again at submit');
  cli('decision', 'applicability', '--responsibility', 'implement', '--reason', 'The web channel closes after a fresh passing check; no additional implementation is needed to close.');
  cli('approve', PHASES[1], '--yes');
  const after = await readState();
  assert.equal(after.currentPhase, PHASES[3], 'the web Story goes on to Close, on the channel chosen at intake');
  assert.equal(after.phases[PHASES[2]].status, 'skipped');
});
