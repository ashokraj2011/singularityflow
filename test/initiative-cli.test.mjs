import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const actor = 'Initiative Owner';
const actorEmail = 'initiative.owner@example.com';

function execute(root, args, { allowFailure = false, confirm = null } = {}) {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    SINGULARITY_FLOW_TEST_IDENTITY: actor,
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ persona: 'product-owner' }),
    SINGULARITY_FLOW_TEST_INITIATIVE_SELECTION: JSON.stringify({ profile: 'initiative-lite' }),
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
  const portfolioFile = path.join(root, '.singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
  portfolio.git.publish = 'off';
  for (const authority of Object.values(portfolio.approvalAuthorities)) authority.members = [{ name: actor, email: actorEmail }];
  await writeFile(portfolioFile, YAML.stringify(portfolio));
  const workflowFile = path.join(root, '.singularity/workflow.yml');
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
  assert.match(context.stdout, /Selected persona: Product owner/i);
  assert.match(git(root, ['ls-files']), /prompt-context-define-gen1\.json/);
  const documents = execute(root, ['initiative', 'documents', 'define']);
  assert.match(documents.stdout, /--- BEGIN .*business-case\.md ---/);
  assert.match(documents.stdout, /CLI initiative|INIT-CLI/);

  execute(root, ['initiative', 'phase', 'publish', 'define']);
  await writeFile(path.join(root, 'approval.md'), '# Approved by product owner\n');
  execute(root, ['initiative', 'evidence', 'add', 'business-case-approved', '--assurance', 'human-approved', '--path', 'approval.md']);
  execute(root, ['initiative', 'evidence', 'add', 'scope-agreed', '--assurance', 'human-approved', '--path', 'approval.md']);

  const blocked = execute(root, ['initiative', 'approve', 'phase'], { allowFailure: true, confirm: 'define:phase' });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /business-case has 0\/1 approvals/);
  const outputApproval = execute(root, ['initiative', 'approve', 'business-case'], { confirm: 'define:business-case' });
  assert.match(`${outputApproval.stdout}\n${outputApproval.stderr}`, /self-approval/);
  const phaseApproval = execute(root, ['initiative', 'approve', 'phase'], { confirm: 'define:phase' });
  assert.match(phaseApproval.stdout, /Current phase: plan/);

  const status = JSON.parse(execute(root, ['initiative', 'status', '--json']).stdout);
  assert.equal(status.initiative.phases.define.status, 'approved');
  assert.equal(status.initiative.currentPhase, 'plan');
  const report = JSON.parse(execute(root, ['initiative', 'report', '--format', 'json']).stdout);
  assert.equal(report.identityAssurance, 'configured-local');
  assert.equal(report.approvals.selfApprovals.length, 2);
  assert.equal(report.evidence.byAssurance['human-approved'], 2);
  const gate = JSON.parse(execute(root, ['initiative', 'gate', '--json']).stdout);
  assert.equal(gate.valid, true);
  const next = JSON.parse(execute(root, ['initiative', 'next', '--json']).stdout);
  assert.equal(next[0].action, 'prepare');
  assert.match(next[0].command, /initiative phase plan/);
  assert.match(git(root, ['log', '--format=%s']), /\[INIT-CLI\]\[initiative:define\]\[approve\] phase/);
  assert.match(git(root, ['ls-files']), /\.singularity\/initiatives\/INIT-CLI\/evidence\/files\//);
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
  assert.match(result.stderr, /No \.singularity\/portfolio\.yml exists/);
  assert.equal(git(root, ['status', '--short']), '');
});
