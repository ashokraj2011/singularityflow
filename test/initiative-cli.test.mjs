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
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ persona: 'product-owner' }),
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
  assert.match(context.stdout, /Selected working lens: Product owner/i);
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

test('initiative Copilot selection receipts preserve explicit profile and persona choices', async () => {
  const root = await repository();
  const begun = JSON.parse(execute(root, ['initiative', 'choices', 'begin', 'start', 'INIT-RECEIPT', '--json']).stdout);
  assert.deepEqual(begun.choiceSets.map((choice) => choice.id), ['initiative-profile', 'persona']);
  execute(root, ['initiative', 'choices', 'answer', begun.token, 'initiative-profile', 'initiative-lite', '--json']);
  const ready = JSON.parse(execute(root, ['initiative', 'choices', 'answer', begun.token, 'persona', 'product-owner', '--json']).stdout);
  assert.equal(ready.ready, true);
  const started = execute(root, ['initiative', 'start', 'INIT-RECEIPT', '--selection-receipt', begun.token]);
  assert.match(started.stdout, /Initiative INIT-RECEIPT started/);
});

test('Epic Planning approval is an explicit business review, available outside the desktop', async () => {
  // Planning approval used to throw "must be reviewed and approved in the Singularity Flow desktop
  // UI", so the plan could not be approved without Electron at all. It is available here now, but the
  // guard the desktop applied travels with it: approving your own plan requires saying so.
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
  assert.match(result.stderr, /wm build --views "business" --focus "initiative phase define"/);
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
      SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ persona: 'product-owner' }),
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

  const restarted = execute(root, ['initiative', 'restart', 'INIT-AGAIN', '--reason', 'Wrong scope; starting over.'], { confirm: 'INIT-AGAIN' });
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
