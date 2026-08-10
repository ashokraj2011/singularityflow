import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const actor = 'Initiative Owner';
const actorEmail = 'initiative.owner@example.com';

function execute(root, args, { allowFailure = false, confirm = null, profile = 'initiative-lite' } = {}) {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    SINGULARITY_FLOW_TEST_IDENTITY: actor,
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ agent: 'product-owner' }),
    SINGULARITY_FLOW_TEST_INITIATIVE_SELECTION: JSON.stringify({ profile }),
    ...(confirm ? { SINGULARITY_FLOW_TEST_INITIATIVE_CONFIRM: confirm } : {})
  };
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8', env });
  if (!allowFailure && result.status !== 0) throw new Error(`${args.join(' ')} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function repository({ grounding = 'off' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-initiative-cli-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', actor]);
  git(root, ['config', 'user.email', actorEmail]);
  await writeFile(path.join(root, 'README.md'), '# Lead\n');
  execute(root, ['init']);
  const portfolioFile = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
  portfolio.git.publish = 'off';
  for (const authority of Object.values(portfolio.approvalAuthorities)) authority.members = [{ name: actor, email: actorEmail }];
  await writeFile(portfolioFile, YAML.stringify(portfolio));
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.worldModel.grounding = grounding;
  await writeFile(workflowFile, YAML.stringify(workflow));
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'Initialize']);
  return root;
}

test('initiative CLI starts, prepares, publishes, records evidence, approves, and reports', async () => {
  const root = await repository();
  const started = execute(root, ['initiative', 'start', 'INIT-CLI', '--title', 'CLI initiative']);
  assert.match(started.stdout, /Initiative INIT-CLI started as initiative-lite/);
  assert.equal(git(root, ['branch', '--show-current']), 'INIT-CLI');

  const prepared = execute(root, ['initiative', 'phase', 'define']);
  assert.match(prepared.stdout, /Prepared 3 define documents/);
  assert.match(prepared.stdout, /Governed Copilot prompt:/);
  const context = execute(root, ['initiative', 'context', 'define']);
  assert.match(context.stdout, /Governed Copilot prompt — INIT-CLI\/define generation 1/);
  assert.match(context.stdout, /Selected governed agent: Product owner \(product-owner\)/);
  assert.match(git(root, ['ls-files']), /prompt-context-define-gen1\.json/);
  const documents = execute(root, ['initiative', 'documents', 'define']);
  assert.match(documents.stdout, /--- BEGIN .*business-case\.md ---/);
  assert.match(documents.stdout, /CLI initiative|INIT-CLI/);

  execute(root, ['initiative', 'phase', 'publish', 'define']);
  await writeFile(path.join(root, 'approval.md'), '# Approved by product owner\n');
  execute(root, ['initiative', 'evidence', 'add', 'business-case-approved', '--assurance', 'human-approved', '--path', 'approval.md']);
  execute(root, ['initiative', 'evidence', 'add', 'scope-agreed', '--assurance', 'human-approved', '--path', 'approval.md']);

  const blocked = execute(root, ['initiative', 'approve', 'phase', '--acknowledge-self-approval'], { allowFailure: true, confirm: 'define:phase' });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /business-case has 0\/1 approvals/);
  const outputApproval = execute(root, ['initiative', 'approve', 'business-case', '--acknowledge-self-approval'], { confirm: 'define:business-case' });
  assert.match(`${outputApproval.stdout}\n${outputApproval.stderr}`, /self-approval/);
  const phaseApproval = execute(root, ['initiative', 'approve', 'phase', '--acknowledge-self-approval'], { confirm: 'define:phase' });
  assert.match(phaseApproval.stdout, /Current phase: plan/);

  const status = JSON.parse(execute(root, ['initiative', 'status', '--json']).stdout);
  assert.equal(status.initiative.phases.define.status, 'approved');
  assert.equal(status.initiative.currentPhase, 'plan');
  const report = JSON.parse(execute(root, ['initiative', 'report', '--format', 'json']).stdout);
  assert.equal(report.identityAssurance, 'configured-local');
  assert.equal(report.approvals.selfApprovals.length, 2);
  assert.equal(report.approvals.recent.length, 2);
  assert.equal(report.approvals.recent[0].actorEmail, actorEmail);
  assert.equal(report.approvals.byPhase.define.length, 2);
  assert.equal(report.evidence.byAssurance['human-approved'], 2);
  const gate = JSON.parse(execute(root, ['initiative', 'gate', '--json']).stdout);
  assert.equal(gate.valid, true);
  const next = JSON.parse(execute(root, ['initiative', 'next', '--json']).stdout);
  assert.equal(next[0].action, 'prepare');
  assert.match(next[0].command, /initiative phase plan/);
  assert.match(git(root, ['log', '--format=%s']), /\[INIT-CLI\]\[initiative:define\]\[approve\] phase/);
  assert.match(git(root, ['ls-files']), /singularity\/initiatives\/INIT-CLI\/evidence\/files\//);
});

test('Initiative start pins the refreshed configured-remote profile and world model', async () => {
  const source = await repository();
  const workflowPath = path.join(source, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.git.remote = 'company';
  await writeFile(workflowPath, YAML.stringify(workflow));
  git(source, ['add', 'singularity/workflow.yml']);
  git(source, ['commit', '-m', 'Configure corporate remote']);

  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-initiative-fresh-base-'));
  const remote = path.join(parent, 'remote.git');
  const clone = path.join(parent, 'clone');
  git(parent, ['clone', '--bare', source, remote]);
  git(parent, ['clone', remote, clone]);
  git(clone, ['remote', 'rename', 'origin', 'company']);
  git(clone, ['config', 'user.name', actor]);
  git(clone, ['config', 'user.email', actorEmail]);

  const portfolioPath = path.join(source, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioPath, 'utf8'));
  portfolio.initiativeProfiles['remote-lite'] = {
    ...portfolio.initiativeProfiles['initiative-lite'],
    label: 'Remote initiative profile'
  };
  await writeFile(portfolioPath, YAML.stringify(portfolio));
  const worldModelPath = path.join(source, 'singularity/world-model/manifest.json');
  await mkdir(path.dirname(worldModelPath), { recursive: true });
  await writeFile(worldModelPath, JSON.stringify({ marker: 'remote-initiative-world-model' }, null, 2));
  git(source, ['add', 'singularity/portfolio.yml', 'singularity/world-model/manifest.json']);
  git(source, ['commit', '-m', 'Publish remote Initiative profile and world model']);
  git(source, ['push', remote, 'main']);

  execute(clone, ['initiative', 'start', 'INIT-FRESH', '--fetch', '--profile', 'remote-lite', '--title', 'Fresh Initiative']);

  const state = JSON.parse(await readFile(path.join(clone, 'singularity/initiatives/INIT-FRESH/state.json'), 'utf8'));
  assert.equal(state.initiative.profile, 'remote-lite');
  assert.equal(state.initiative.profileLabel, 'Remote initiative profile');
  const inheritedModel = JSON.parse(await readFile(path.join(clone, 'singularity/world-model/manifest.json'), 'utf8'));
  assert.equal(inheritedModel.marker, 'remote-initiative-world-model');
  assert.equal(git(clone, ['branch', '--show-current']), 'INIT-FRESH');
});

test('initiative Copilot selection receipts preserve the explicit profile while the phase agent is automatic', async () => {
  const root = await repository();
  const begun = JSON.parse(execute(root, ['initiative', 'choices', 'begin', 'start', 'INIT-RECEIPT', '--json']).stdout);
  assert.deepEqual(begun.choiceSets.map((choice) => choice.id), ['initiative-profile']);
  const ready = JSON.parse(execute(root, ['initiative', 'choices', 'answer', begun.token, 'initiative-profile', 'initiative-lite', '--json']).stdout);
  assert.equal(ready.ready, true);
  const started = execute(root, ['initiative', 'start', 'INIT-RECEIPT', '--selection-receipt', begun.token]);
  assert.match(started.stdout, /Initiative INIT-RECEIPT started/);
});

test('generic governed action planning preserves Initiative identity and commands', async () => {
  const root = await repository();
  execute(root, ['initiative', 'start', 'INIT-ACTION', '--title', 'Initiative action routing']);

  const plan = JSON.parse(execute(root, ['action', 'plan', '--json']).stdout);
  assert.deepEqual(plan.subject, { kind: 'initiative', id: 'INIT-ACTION' });
  assert.equal(plan.state, 'in_progress');
  assert.ok(plan.actions.length > 0);
  assert.match(plan.actions[0].command, /singularity-flow initiative phase define/);
  assert.doesNotMatch(plan.actions[0].command, /singularity-flow prepare/);
});

test('initiative resume materializes an Initiative that exists only on a remote branch', async () => {
  const source = await repository();
  execute(source, ['initiative', 'start', 'INIT-REMOTE', '--title', 'Remote-only initiative']);

  const remoteParent = await mkdtemp(path.join(os.tmpdir(), 'sflow-initiative-remote-'));
  const remote = path.join(remoteParent, 'origin.git');
  git(remoteParent, ['init', '--bare', remote]);
  git(source, ['remote', 'add', 'origin', remote]);
  git(source, ['push', 'origin', 'main:main', 'INIT-REMOTE:INIT-REMOTE']);

  const cloneParent = await mkdtemp(path.join(os.tmpdir(), 'sflow-initiative-resume-'));
  const clone = path.join(cloneParent, 'lead');
  git(cloneParent, ['clone', '--single-branch', '--branch', 'main', remote, clone]);
  git(clone, ['config', 'user.name', actor]);
  git(clone, ['config', 'user.email', actorEmail]);

  assert.equal(git(clone, ['branch', '--show-current']), 'main');
  assert.equal(git(clone, ['branch', '--list', 'INIT-REMOTE']), '', 'the Initiative has no local branch before resume');
  assert.equal(
    git(clone, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/INIT-REMOTE']),
    '',
    'the single-branch clone has not fetched the Initiative ref'
  );

  const resumed = execute(clone, ['initiative', 'resume', 'INIT-REMOTE', '--fetch']);
  assert.match(resumed.stdout, /Resumed INIT-REMOTE at define with governed agent product-owner/);
  assert.equal(git(clone, ['branch', '--show-current']), 'INIT-REMOTE');
  assert.equal(
    git(clone, ['rev-parse', 'HEAD']),
    git(clone, ['rev-parse', 'origin/INIT-REMOTE']),
    'resume materializes the exact remote lifecycle branch'
  );
  const state = JSON.parse(await readFile(path.join(clone, 'singularity/initiatives/INIT-REMOTE/state.json'), 'utf8'));
  assert.equal(state.initiative.id, 'INIT-REMOTE');
});

test('Epic Planning approval is an explicit business review, available outside the desktop', async () => {
  // Planning approval used to throw "must be reviewed and approved in the Singularity Flow desktop
  // UI", so the plan could not be approved from every surface. It is available here now, while the
  // self-approval acknowledgement remains explicit.
  const root = await repository();
  execute(root, ['initiative', 'start', 'EPIC-UI', '--title', 'UI approval boundary'], {
    profile: 'epic-planning'
  });
  const stateFile = path.join(root, 'singularity/initiatives/EPIC-UI/state.json');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  state.currentPhase = 'epic-planning';
  state.phases['epic-intake'].status = 'approved';
  state.phases['epic-requirements'].status = 'approved';
  state.phases['epic-planning'].status = 'awaiting_approval';
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  git(root, ['add', stateFile]);
  git(root, ['commit', '-m', 'Prepare exact Planning review']);

  const direct = execute(root, ['initiative', 'approve', 'phase'], {
    allowFailure: true,
    confirm: 'epic-planning:phase'
  });
  assert.notEqual(direct.status, 0);
  assert.doesNotMatch(direct.stderr, /desktop UI/, 'planning approval is no longer desktop-only');

  const alias = execute(root, ['epic', 'planning', 'approve', '--epic', 'EPIC-UI'], {
    allowFailure: true,
    confirm: 'epic-planning:phase'
  });
  assert.notEqual(alias.status, 0);
  assert.doesNotMatch(alias.stderr, /desktop UI/);
});

test('initiative phase generation enforces repository world-model composition for Copilot', async () => {
  const root = await repository({ grounding: 'enforce' });
  execute(root, ['initiative', 'start', 'INIT-GROUNDED']);
  const before = git(root, ['rev-parse', 'HEAD']);
  const result = execute(root, ['initiative', 'phase', 'define'], { allowFailure: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /wm ensure --phase define/);
  assert.match(result.stderr, /grounding is not ready/i);
  assert.equal(git(root, ['rev-parse', 'HEAD']), before);
  assert.equal(git(root, ['status', '--short']), '');
});

test('initiative CLI remains inert when portfolio configuration is absent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-no-portfolio-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', actor]);
  git(root, ['config', 'user.email', actorEmail]);
  await writeFile(path.join(root, 'README.md'), '# Existing repository\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'Initial']);
  const result = execute(root, ['initiative', 'status'], { allowFailure: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No singularity\/portfolio\.yml exists/);
  assert.equal(git(root, ['status', '--short']), '');
});

test('an Epic chooses which of its phase optional outputs it will produce', async () => {
  // A profile describes a delivery model, not one Epic. discover-define pins a requirement document
  // plus three long-form business artifacts; carrying all four on every Epic is ceremony, and there
  // was no way to say so — the phase could not be approved until every one of them existed.
  const root = await repository();
  const started = spawnSync(process.execPath, [bin, 'initiative', 'start', 'INIT-OUT', '--title', 'Output selection'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SINGULARITY_FLOW_TEST_IDENTITY: actor,
      SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ agent: 'product-owner' }),
      SINGULARITY_FLOW_TEST_INITIATIVE_SELECTION: JSON.stringify({ profile: 'enterprise-delivery' })
    }
  });
  assert.equal(started.status, 0, started.stderr);
  const stateFile = path.join(root, 'singularity/initiatives/INIT-OUT/state.json');
  const read = async () => JSON.parse(await readFile(stateFile, 'utf8'));

  const before = await read();
  assert.equal(before.currentPhase, 'discover-define');
  const outputs = before.resolution.phases.find((phase) => phase.id === 'discover-define').outputs;
  assert.deepEqual(outputs.filter((output) => output.required !== false).map((output) => output.id), ['requirements']);
  assert.deepEqual(outputs.filter((output) => output.required === false).map((output) => output.id), ['business-case', 'opportunity-brief', 'product-roadmap']);

  const listed = execute(root, ['initiative', 'outputs', 'discover-define']);
  assert.match(listed.stdout, /\[x\] requirements/);
  assert.match(listed.stdout, /\[ \] business-case/);

  // Governance cannot be narrowed away: the required document stays.
  const refused = execute(root, ['initiative', 'outputs', 'discover-define', '--include', 'business-case'], { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stdout}${refused.stderr}`, /'requirements' is required by profile 'enterprise-delivery'/);

  // Ceremony can: this Epic takes the requirement document and a business case, nothing else.
  const chosen = execute(root, ['initiative', 'outputs', 'discover-define', '--include', 'requirements,business-case', '--reason', 'Small change; the roadmap adds nothing.']);
  assert.match(chosen.stdout, /discover-define will produce requirements, business-case/);

  const after = await read();
  assert.deepEqual(after.phases['discover-define'].outputSelection.included, ['requirements', 'business-case']);
  const event = after.history.at(-1);
  assert.equal(event.event, 'initiative_outputs_selected');
  assert.match(event.detail, /→ requirements, business-case/);
  assert.match(event.detail, /Small change/);
  assert.ok(event.actor, 'the change records who made it');

  // And the phase now asks for two documents rather than four.
  const status = execute(root, ['initiative', 'status']);
  assert.doesNotMatch(status.stdout, /product-roadmap/);
});

test('restart returns an Epic to its first phase without touching its branch or Story models', async () => {
  // Starting over used to mean deleting the branch and starting a new Epic — which threw away the
  // identity, the pinned sources, and the repository world model along with the mistake.
  const root = await repository();
  execute(root, ['initiative', 'start', 'INIT-AGAIN', '--title', 'Restartable']);
  const stateFile = path.join(root, 'singularity/initiatives/INIT-AGAIN/state.json');
  const read = async () => JSON.parse(await readFile(stateFile, 'utf8'));

  // A world model on the Epic branch is the thing that must survive.
  await mkdir(path.join(root, 'singularity/world-model/views'), { recursive: true });
  await writeFile(path.join(root, 'singularity/world-model/views/business.md'), '# business view\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'World model']);
  const worldModelCommit = git(root, ['rev-parse', 'HEAD']);

  execute(root, ['initiative', 'phase']);
  const authored = await read();
  const firstPhase = authored.phaseOrder[0];
  assert.ok(Object.values(authored.phases[firstPhase].outputs).some((output) => output.sha256), 'the first attempt produced something');

  // Confirmed with the public --confirm escape rather than the test-only environment variable, so
  // this exercises the same path a GUI takes instead of a backdoor only the suite can reach.
  const restarted = execute(root, ['initiative', 'restart', 'INIT-AGAIN',
    '--reason', 'Wrong scope; starting over.', '--confirm', 'INIT-AGAIN']);
  assert.match(restarted.stdout, /INIT-AGAIN restarted at/);
  assert.match(restarted.stdout, /Epic branch and sources kept, Story-branch world models unchanged/);

  const after = await read();
  assert.equal(after.currentPhase, firstPhase);
  assert.equal(after.status, 'in_progress');
  for (const output of Object.values(after.phases[firstPhase].outputs)) assert.equal(output.sha256, null, 'artifacts from the abandoned attempt are gone');

  // The branch is the same branch, and the world model commit is still reachable from it.
  assert.equal(git(root, ['branch', '--show-current']), 'INIT-AGAIN');
  assert.equal(git(root, ['merge-base', '--is-ancestor', worldModelCommit, 'HEAD']) , '');
  assert.equal(await readFile(path.join(root, 'singularity/world-model/views/business.md'), 'utf8'), '# business view\n');

  // Identity and history survive: the record of the first attempt is why anyone can explain the second.
  assert.equal(after.initiative.id, 'INIT-AGAIN');
  assert.equal(after.initiative.createdAt, authored.initiative.createdAt);
  assert.ok(after.history.some((entry) => entry.event === 'initiative_started'));
  const event = after.history.at(-1);
  assert.equal(event.event, 'initiative_restarted');
  assert.match(event.detail, /Wrong scope/);
  assert.match(event.detail, /artifacts? discarded/);
});

test('a destructive initiative action refuses the wrong --confirm value and names both', async () => {
  // The escape must not become a way to confirm something you did not read. The flag has to carry
  // the exact identifier, and a mismatch has to say what was expected and what arrived.
  const root = await repository();
  execute(root, ['initiative', 'start', 'INIT-GUARD', '--title', 'Guarded']);
  const refused = execute(root, ['initiative', 'restart', 'INIT-GUARD',
    '--reason', 'Testing the guard.', '--confirm', 'INIT-WRONG'], { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /requires exact confirmation 'INIT-GUARD'/);
  assert.match(refused.stderr, /--confirm received 'INIT-WRONG'/);

  // And the state is untouched: the guard fires before anything is discarded.
  const state = JSON.parse(await readFile(path.join(root, 'singularity/initiatives/INIT-GUARD/state.json'), 'utf8'));
  assert.ok(!state.history.some((entry) => entry.event === 'initiative_restarted'));
});

test('without a terminal and without --confirm, the refusal names the escape', async () => {
  const root = await repository();
  execute(root, ['initiative', 'start', 'INIT-HINT', '--title', 'Hinted']);
  // No SINGULARITY_FLOW_TEST_INITIATIVE_CONFIRM, no TTY: previously a dead end with no way forward.
  const refused = spawnSync(process.execPath, [bin, 'initiative', 'restart', 'INIT-HINT', '--reason', 'r'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, SINGULARITY_FLOW_TEST_IDENTITY: actor } });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /pass --confirm INIT-HINT/);
});

test('a local Epic activates the first phase agent without a role picker', async () => {
  const root = await repository();
  const bare = (args) => spawnSync(process.execPath, [bin, ...args],
    { cwd: root, encoding: 'utf8', env: { ...process.env, SINGULARITY_FLOW_TEST_IDENTITY: actor } });
  const local = ['epic', 'start', '--local', '--title', 'Local Epic',
    '--description', 'Described', '--goal', 'A goal'];

  const started = bare(local);
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  // The session lives under .git, not in the tree, so read it from there.
  const session = JSON.parse(await readFile(path.join(root, '.git/singularity-flow/session.json'), 'utf8'));
  assert.equal(session.agent, 'product-owner');
  assert.equal(session.agentSource, 'phase-default');
});

test('approval harvests knowledge from the approved artifact, in the same commit', async () => {
  // Harvest existed but nothing called it except an explicit `knowledge harvest`, so in every real
  // Epic the store stayed empty and the feed-forward into later phases had nothing to feed. And no
  // path committed knowledge at all: the records survived only as untracked files, which every
  // governed command afterwards refuses to run against.
  const root = await repository();
  execute(root, ['initiative', 'start', 'INIT-KNOW', '--title', 'Knowledge carrier']);
  execute(root, ['initiative', 'phase', 'define']);

  const artifact = path.join(root, 'singularity/initiatives/INIT-KNOW/artifacts/define/business-case.md');
  await writeFile(artifact, `${await readFile(artifact, 'utf8')}
## Decisions to revisit

| Decision | Why it may need revisiting |
|---|---|
| Ship behind a flag first | The rollout depends on error rates we cannot predict |

## Still unknown

| Open question | What would resolve it |
|---|---|
| Whether the vendor supports batch mode | A written answer from the vendor |
`);
  execute(root, ['initiative', 'phase', 'publish', 'define']);

  const before = JSON.parse(execute(root, ['knowledge', 'list', '--json']).stdout);
  assert.deepEqual(before, [], 'nothing is harvested before the artifact is approved');

  const approved = execute(root, ['initiative', 'approve', 'business-case', '--acknowledge-self-approval'],
    { confirm: 'define:business-case' });
  assert.match(approved.stdout, /Recorded 2 knowledge entries/);

  const after = JSON.parse(execute(root, ['knowledge', 'list', '--json']).stdout);
  assert.equal(after.length, 2);
  assert.deepEqual(after.map((entry) => entry.record.type).sort(), ['decision', 'uncertainty']);
  // Provenance points at the exact approved artifact, not just the phase.
  assert.equal(after[0].record.provenance[0].artifact, 'artifacts/define/business-case.md');
  assert.equal(after[0].record.provenance[0].workId, 'INIT-KNOW');

  // The records are committed with the approval, and the checkout is left clean.
  assert.equal(git(root, ['status', '--porcelain']), '', 'approval leaves no untracked knowledge behind');
  const committed = git(root, ['show', '--name-only', '--format=', 'HEAD']);
  assert.match(committed, /singularity\/knowledge\/records\//, 'knowledge landed in the approval commit');

  // And it feeds forward: the next composed prompt carries it as evidence.
  const context = execute(root, ['initiative', 'context', 'define']).stdout;
  assert.match(context, /Prior knowledge/);
  assert.match(context, /Whether the vendor supports batch mode/);
});

test('approving a phase bundle harvests its artifacts, not only individually approved outputs', async () => {
  // A profile signs off either an artifact or the phase bundle containing it. Harvest read only
  // individually-approved outputs, so for every bundle-approving profile — which is most of them —
  // it found nothing, and the store stayed empty exactly where it was designed to fill.
  const root = await repository();
  execute(root, ['initiative', 'start', 'INIT-BUNDLE', '--title', 'Bundle harvest']);
  execute(root, ['initiative', 'phase', 'define']);

  const artifact = path.join(root, 'singularity/initiatives/INIT-BUNDLE/artifacts/define/scope-and-outcomes.md');
  await writeFile(artifact, `${await readFile(artifact, 'utf8')}
## Still unknown

| Open question | What would resolve it |
|---|---|
| Whether the vendor supports batch mode | A written answer from the vendor |
`);
  execute(root, ['initiative', 'phase', 'publish', 'define']);
  await writeFile(path.join(root, 'approval.md'), '# Approved\n');
  execute(root, ['initiative', 'evidence', 'add', 'business-case-approved', '--assurance', 'human-approved', '--path', 'approval.md']);
  execute(root, ['initiative', 'evidence', 'add', 'scope-agreed', '--assurance', 'human-approved', '--path', 'approval.md']);
  execute(root, ['initiative', 'approve', 'business-case', '--acknowledge-self-approval'], { confirm: 'define:business-case' });

  // scope-and-outcomes is never approved on its own — only the phase bundle is.
  const state = JSON.parse(await readFile(path.join(root, 'singularity/initiatives/INIT-BUNDLE/state.json'), 'utf8'));
  assert.notEqual(state.phases.define.outputs['scope-and-outcomes'].status, 'approved');

  const approved = execute(root, ['initiative', 'approve', 'phase', '--acknowledge-self-approval'], { confirm: 'define:phase' });
  assert.match(approved.stdout, /Recorded 1 knowledge entry/);

  const entries = JSON.parse(execute(root, ['knowledge', 'list', '--json']).stdout);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].record.type, 'uncertainty');
  assert.equal(entries[0].record.provenance[0].artifact, 'artifacts/define/scope-and-outcomes.md');
  // Committed with the approval, leaving nothing of the store untracked. (The scratch approval.md
  // this test writes at the repository root is its own litter, so the check is scoped to the store.)
  assert.equal(git(root, ['status', '--porcelain', 'singularity/knowledge']), '');
  assert.match(git(root, ['show', '--name-only', '--format=', 'HEAD']), /singularity\/knowledge\/records\//);
});
