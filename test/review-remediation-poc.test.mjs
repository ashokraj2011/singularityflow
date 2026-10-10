import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { loadAcceptedStoryExecution } from '../src/accepted-story-execution.mjs';
import { resolveStoryExecutionContext } from '../src/story-execution-context.mjs';
import { run } from '../src/util.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function git(root, args, options = {}) {
  return run('git', args, { cwd: root, ...options }).stdout.trim();
}

function invoke(env, cwd, args, { expectStatus = 0 } = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd, env, encoding: 'utf8', timeout: 180_000
  });
  assert.equal(result.status, expectStatus,
    `singularity-flow ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

function invokeJson(env, cwd, args) {
  const result = invoke(env, cwd, [...args, '--json']);
  try { return JSON.parse(result.stdout); }
  catch (error) {
    assert.fail(`Command did not return JSON (${error.message}):\n${result.stdout}\n${result.stderr}`);
  }
}

async function createAuthorityRemote(base) {
  const seed = path.join(base, 'authority-seed');
  const remote = path.join(base, 'authority.git');
  await mkdir(seed, { recursive: true });
  git(seed, ['init', '-q', '-b', 'main']);
  git(seed, ['config', 'user.name', 'Authority Bootstrap']);
  git(seed, ['config', 'user.email', 'authority.bootstrap@example.invalid']);
  await writeFile(path.join(seed, 'README.md'), '# Review remediation authority\n');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-q', '-m', 'authority baseline']);
  git(base, ['clone', '-q', '--bare', seed, remote]);
  return { seed, remote };
}

async function customizeCapabilityProposal(root, branch) {
  git(root, ['fetch', '-q', 'origin', branch]);
  git(root, ['switch', '-q', '-c', branch, `origin/${branch}`]);
  const workflowPath = path.join(root, 'singularity', 'workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.git.publish = 'required';
  workflow.approvalSecurity = {
    profile: 'poc', allowSelfApproval: true, autoEnrollNewIdentities: false
  };
  for (const authority of Object.values(workflow.approvalAuthorities)) {
    authority.allowAnyGitIdentity = true;
  }
  delete workflow.phases.planning.artifactSet;
  workflow.workTypes['review-remediation-poc'] = {
    label: 'Review remediation POC',
    description: 'Exercises the complete saved-Story path.',
    phases: ['planning', 'verification'],
    phaseOverrides: {
      planning: { inputs: [] },
      verification: {
        inputs: ['planning'],
        approval: { rejectTo: ['planning', 'verification'] }
      }
    }
  };
  await writeFile(workflowPath, YAML.stringify(workflow));
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'review POC workflow policy']);
  const commit = git(root, ['rev-parse', 'HEAD']);
  git(root, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`]);
  git(root, ['switch', '-q', 'main']);
  return commit;
}

async function createDeliveryRemote(base) {
  const seed = path.join(base, 'delivery-seed');
  const remote = path.join(base, 'delivery.git');
  await mkdir(seed, { recursive: true });
  git(seed, ['init', '-q', '-b', 'main']);
  git(seed, ['config', 'user.name', 'Application Bootstrap']);
  git(seed, ['config', 'user.email', 'application.bootstrap@example.invalid']);
  await writeFile(path.join(seed, 'app.mjs'), 'export const serviceName = "poc-service";\n');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-q', '-m', 'application baseline']);
  git(base, ['clone', '-q', '--bare', seed, remote]);
  return { seed, remote };
}

async function writePhaseArtifact(root, accepted, phaseId, detail) {
  const phase = accepted.workflow.phases[phaseId];
  const target = path.join(
    root, accepted.definition.workItemRoot, accepted.workflow.workItem.id,
    phase.requiredArtifact.path
  );
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `# ${phase.label}\n\n## Scope\n\n${detail}\n\n## Evidence\n\n`
    + 'This public POC uses the normal publication, submission, and approval boundaries.\n');
}

test('FIX:AC-605 complete public review-remediation path survives a second checkout', {
  timeout: 360_000
}, async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-review-remediation-poc-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const authority = await createAuthorityRemote(base);
  const delivery = await createDeliveryRemote(base);
  const operator = path.join(base, 'operator');
  git(base, ['clone', '-q', '--branch', 'main', authority.remote, operator]);
  git(operator, ['config', 'user.name', 'POC Operator']);
  git(operator, ['config', 'user.email', 'poc.operator@example.invalid']);

  const machine = path.join(base, 'machine');
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    NO_COLOR: '1',
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(machine, 'leads.json'),
    SINGULARITY_FLOW_ORGANISATION_CACHE: path.join(machine, 'organisation-cache'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(machine, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(machine, 'active-workspace.json'),
    SINGULARITY_FLOW_BOOTSTRAP_STATE: path.join(machine, 'bootstrap'),
    SINGULARITY_FLOW_BOOTSTRAP_MIN_DISK_BYTES: '1',
    SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(machine, 'transport-outbox'),
    // Prove that the isolated capability checkout cannot borrow presentation identity globally.
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(machine, 'empty-global-gitconfig')
  };

  const mapped = invokeJson(env, operator, [
    'capability', 'map', 'poc-service', '--lead', authority.remote,
    '--name', 'POC Service', '--kind', 'delivery', '--repository', delivery.remote
  ]);
  const proposalCommit = await customizeCapabilityProposal(operator, mapped.branch);
  const activated = invokeJson(env, operator, [
    'capability', 'activate', mapped.branch, '--lead', authority.remote,
    '--confirm', proposalCommit, '--acknowledge-unprotected'
  ]);
  assert.equal(activated.status, 'activated');
  assert.equal(activated.audit.recorded, true);
  assert.equal(activated.projection.published, true);
  assert.equal(activated.portability.portable, true);
  assert.ok(activated.portability.outcomes.some((entry) => entry.repository === delivery.remote));
  assert.equal(git(authority.remote, [
    'show', '-s', '--format=%an <%ae>', activated.audit.ledgerCommit
  ]), 'POC Operator <poc.operator@example.invalid>');
  assert.match(git(delivery.remote, [
    'show', 'state:singularity/capability-authority.json'
  ]), /poc-service/);

  const prepared = invokeJson(env, operator, [
    'workspace', 'prepare', authority.remote, '--id', 'review-remediation-poc',
    '--name', 'Review Remediation POC', '--base', path.join(base, 'workspaces'),
    '--capability', 'poc-service', '--lead-capability', 'poc-service', '--clone', '--initialize'
  ]);
  assert.equal(prepared.status, 'waiting-user');
  const bootstrapped = invokeJson(env, operator, [
    'workspace', 'bootstrap', 'resume', prepared.bootstrapId,
    '--confirm', 'review-remediation-poc'
  ]);
  assert.equal(bootstrapped.status, 'ready');
  const deliveryRepository = Object.values(bootstrapped.result.workspace.repositories)
    .find((entry) => entry.capabilities?.includes('poc-service'));
  assert.ok(deliveryRepository, JSON.stringify(bootstrapped.result.workspace.repositories));
  const first = path.join(bootstrapped.result.workspace.path, deliveryRepository.path);
  git(first, ['config', 'user.name', 'POC Operator']);
  git(first, ['config', 'user.email', 'poc.operator@example.invalid']);
  const selected = invokeJson(env, operator, [
    'workspace', 'use', 'review-remediation-poc', '--repository', deliveryRepository.id
  ]);
  assert.equal(selected.repositoryPath, first);
  const workId = 'FIX-POC-605';
  const started = invokeJson(env, first, [
    'start', workId, '--title', 'Review remediation public POC',
    '--description', 'Prove portable saved instructions across checkouts.',
    '--acceptance-criteria', 'The exact saved Story closure remains enforceable.',
    '--from-branch', 'main', '--work-type', 'review-remediation-poc',
    '--capability', 'poc-service'
  ]);
  assert.equal(started.outcome.status, 'succeeded');
  assert.equal(started.data.currentPhase, 'planning');
  assert.equal(started.data.publication.pushed, true);

  let accepted = await loadAcceptedStoryExecution(first, workId);
  assert.equal(accepted.workflow.workflowSnapshot?.revision, 1);
  const firstExecution = await resolveStoryExecutionContext(
    first, accepted.definition, accepted.workflow,
    { agentId: 'architect', phaseId: 'planning', executionCatalog: accepted.executionCatalog }
  );
  assert.equal(firstExecution.identity.mode, 'workflow-snapshot');
  assert.match(firstExecution.identity.snapshotHash, /^sha256:[a-f0-9]{64}$/);

  await writePhaseArtifact(
    first, accepted, 'planning',
    'The reviewed plan adds an exact, reviewed change to the POC service.'
  );
  invoke(env, first, [
    'phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place'
  ]);
  invoke(env, first, ['submit', 'planning', '--skip-checks']);
  invoke(env, first, ['approve', 'planning', '--yes']);

  const second = path.join(base, 'machine-b');
  git(base, ['clone', '-q', '--branch', workId, delivery.remote, second]);
  git(second, ['config', 'user.name', 'POC Operator']);
  git(second, ['config', 'user.email', 'poc.operator@example.invalid']);
  invoke(env, second, ['resume', workId]);
  const liveAgentPath = path.join(second, '.github', 'agents', 'architect.agent.md');
  const liveAgent = await readFile(liveAgentPath, 'utf8');
  await writeFile(liveAgentPath, `${liveAgent}\nLIVE_AGENT_REPLACEMENT_MUST_NOT_RUN\n`);
  accepted = await loadAcceptedStoryExecution(second, workId);
  const secondExecution = await resolveStoryExecutionContext(
    second, accepted.definition, accepted.workflow,
    { agentId: 'architect', phaseId: 'planning', executionCatalog: accepted.executionCatalog }
  );
  assert.deepEqual(secondExecution.identity, firstExecution.identity);
  assert.equal(secondExecution.agent.text.includes('LIVE_AGENT_REPLACEMENT_MUST_NOT_RUN'), false);
  await writeFile(liveAgentPath, liveAgent);

  const applicationPath = path.join(second, 'app.mjs');
  const changedApplication = `${await readFile(applicationPath, 'utf8')}\nexport const reviewed = true;\n`;
  await writeFile(applicationPath, changedApplication);

  git(second, ['add', 'app.mjs']);
  git(second, ['commit', '-q', '-m', 'implement exact POC source change']);
  invoke(env, second, ['prepare', 'verification']);
  accepted = await loadAcceptedStoryExecution(second, workId);
  await writePhaseArtifact(
    second, accepted, 'verification',
    'The committed source change satisfies the approved plan.'
  );
  invoke(env, second, [
    'phase', 'publish', 'verification', '--authored', 'human', '--channel', 'manual-in-place'
  ]);
  invoke(env, second, ['submit', 'verification', '--skip-checks']);
  invoke(env, second, ['approve', 'verification', '--yes']);
  accepted = await loadAcceptedStoryExecution(second, workId);
  assert.equal(accepted.workflow.phases.verification.status, 'approved');
});
