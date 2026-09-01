import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';

import {
  autoPlanHash, createAutoPlan, ratifyAutoPlan, readAutoPlan
} from '../src/auto/auto-plan.mjs';
import { buildAutoPlanPacket } from '../src/auto/auto-plan-packet.mjs';
import { loadDefinition } from '../src/config.mjs';
import { canonicalJson } from '../src/records.mjs';

const cli = path.resolve('bin/singularity-flow.mjs');

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Auto Tester' }
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-auto-plan-security-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Auto Tester'], root);
  run('git', ['config', 'user.email', 'auto@example.com'], root);
  run(process.execPath, [cli, 'init'], root);
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.git.publish = 'off';
  workflow.auto.enabled = true;
  workflow.models.providers['copilot-cli'] = {
    type: 'copilot-cli', executable: process.execPath, promptTransport: 'acp-stdio', arguments: []
  };
  workflow.auto.ceilings = { tokenBudget: { maximum: 30000, assurance: 'best-available' } };
  workflow.workTypes.feature.auto = {
    eligibility: 'bounded', allowedPaces: ['phase'], defaultUntil: 'first-human-boundary'
  };
  await writeFile(workflowPath, YAML.stringify(workflow));
  await writeFile(path.join(root, 'app.mjs'), 'export const value = 1;\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'configure Auto'], root);
  const remote = `${root}.git`;
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  return root;
}

const proposal = {
  title: 'Change the application value', workType: 'feature',
  assumptions: [], unresolvedDecisions: [], predictedPaths: ['app.mjs'],
  acceptanceCriteria: ['The exported value changes.'], suggestedUntil: 'first-human-boundary'
};

test('Auto Plan persists a credential-free repository identity and fingerprint', async (t) => {
  const root = await repository(t);
  const plan = await createAutoPlan(root, 'Change the exported value.', proposal, {
    definition: await loadDefinition(root), workId: 'AUT-SAFE-REMOTE', workType: 'feature', fromBranch: 'main'
  });
  assert.match(plan.repositories[0].remoteFingerprint, /^[a-f0-9]{64}$/);
  assert.match(plan.bindings.repositoryFingerprint, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(plan), /password|token@/i);
});

test('Auto Plan ratification accepts the exact derived review packet digest', async (t) => {
  const root = await repository(t);
  const plan = await createAutoPlan(root, 'Change the exported value.', proposal, {
    definition: await loadDefinition(root), workId: 'AUT-PACKET-RATIFY', workType: 'feature', fromBranch: 'main'
  });
  assert.equal(plan.schemaVersion, 2);
  assert.deepEqual(plan.confirmation, { protocol: 'packet-v1' });
  const packet = buildAutoPlanPacket(plan);
  await assert.rejects(
    () => ratifyAutoPlan(root, plan.planId, plan.planSha256),
    (error) => error.code === 'AUTO_PLAN_CONFIRMATION_REQUIRED'
  );
  const ratified = await ratifyAutoPlan(root, plan.planId, packet.packetSha256);
  assert.equal(ratified.authorization.planId, plan.planId);
  assert.equal(ratified.authorization.planSha256, plan.planSha256);
});

test('Auto Plan is not startable when its endpoint exceeds phase or model ceilings', async (t) => {
  const root = await repository(t);
  const phaseLimited = await createAutoPlan(root, 'Run the complete feature rail.', {
    ...proposal, suggestedUntil: 'story-complete'
  }, {
    definition: await loadDefinition(root), workId: 'AUT-ENDPOINT-PHASE-LIMIT',
    workType: 'feature', fromBranch: 'main', until: 'story-complete'
  });
  assert.equal(phaseLimited.safety.startable, false);
  assert.ok(phaseLimited.safety.reasons.some((reason) => (
    /endpoint requires 7 phase execution\(s\).*maximumPhases 3/.test(reason)
  )));
  assert.ok(phaseLimited.safety.reasons.some((reason) => (
    /endpoint requires at least 7 model invocation\(s\).*maximumModelInvocations 6/.test(reason)
  )));

  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.auto.ceilings.maximumPhases = 10;
  workflow.auto.ceilings.maximumModelInvocations = 2;
  await writeFile(workflowPath, YAML.stringify(workflow));
  run('git', ['add', 'singularity/workflow.yml'], root);
  run('git', ['commit', '-m', 'isolate model ceiling feasibility'], root);
  run('git', ['push', 'origin', 'main'], root);
  const modelLimited = await createAutoPlan(root, 'Run another complete feature rail.', {
    ...proposal, suggestedUntil: 'story-complete'
  }, {
    definition: await loadDefinition(root), workId: 'AUT-ENDPOINT-MODEL-LIMIT',
    workType: 'feature', fromBranch: 'main', until: 'story-complete'
  });
  assert.equal(modelLimited.safety.startable, false);
  assert.ok(!modelLimited.safety.reasons.some((reason) => /maximumPhases/.test(reason)));
  assert.ok(modelLimited.safety.reasons.some((reason) => (
    /endpoint requires at least [1-9][0-9]* model invocation\(s\).*maximumModelInvocations 2/.test(reason)
  )));
});

test('Auto Plan preflights deterministic verification for every code phase before its endpoint', async (t) => {
  const root = await repository(t);
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.auto.ceilings.maximumPhases = 10;
  workflow.auto.ceilings.maximumModelInvocations = 10;
  await writeFile(workflowPath, YAML.stringify(workflow));
  run('git', ['add', 'singularity/workflow.yml'], root);
  run('git', ['commit', '-m', 'allow complete rail feasibility check'], root);
  run('git', ['push', 'origin', 'main'], root);

  const plan = await createAutoPlan(root, 'Run the complete feature rail.', {
    ...proposal, suggestedUntil: 'story-complete'
  }, {
    definition: await loadDefinition(root), workId: 'AUT-ENDPOINT-VERIFY-ALL',
    workType: 'feature', fromBranch: 'main', until: 'story-complete'
  });
  assert.equal(plan.safety.startable, false);
  assert.ok(plan.safety.reasons.includes(
    "phase 'implementation' has no deterministic delivery-quality command"
  ));
  assert.ok(!plan.safety.reasons.includes(
    "phase 'intake' has no deterministic delivery-quality command"
  ));
});

test('attachment-only model transport remains available to legacy callers but cannot start Auto', async (t) => {
  const root = await repository(t);
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.models.providers['copilot-cli'].promptTransport = 'attachment';
  await writeFile(workflowPath, YAML.stringify(workflow));
  run('git', ['add', 'singularity/workflow.yml'], root);
  run('git', ['commit', '-m', 'configure legacy attachment transport'], root);
  run('git', ['push', 'origin', 'main'], root);
  const plan = await createAutoPlan(root, 'Change the exported value.', proposal, {
    definition: await loadDefinition(root), workId: 'AUT-ATTACHMENT-UNSTARTABLE',
    workType: 'feature', fromBranch: 'main'
  });
  assert.equal(plan.executionHost.driver.promptTransport, 'attachment');
  assert.equal(plan.safety.startable, false);
  assert.ok(plan.safety.reasons.some((reason) => /path-scope-transport/.test(reason)));
  await assert.rejects(
    () => ratifyAutoPlan(root, plan.planId, buildAutoPlanPacket(plan).packetSha256),
    (error) => error.code === 'AUTO_PLAN_NOT_STARTABLE'
  );
});

test('a schema-v1 Plan is retained unchanged but cannot authorize execution', async (t) => {
  const root = await repository(t);
  const current = await createAutoPlan(root, 'Change the exported value.', proposal, {
    definition: await loadDefinition(root), workId: 'AUT-LEGACY-RATIFY', workType: 'feature', fromBranch: 'main'
  });
  const legacy = structuredClone(current);
  legacy.schemaVersion = 1;
  delete legacy.confirmation;
  legacy.planSha256 = autoPlanHash(legacy);
  const target = path.join(root, '.git/singularity-flow/auto-plans', `${legacy.planId}.json`);
  const bytes = canonicalJson(legacy);
  await writeFile(target, bytes);
  await assert.rejects(
    () => ratifyAutoPlan(root, legacy.planId, legacy.planSha256),
    (error) => error.code === 'AUTO_PLAN_LEGACY_UNSUPPORTED'
      && /new Auto Plan/i.test(error.details?.nextAction ?? '')
  );
  assert.equal(await readFile(target, 'utf8'), bytes);
});

test('a fresh schema-v2 Plan cannot be stripped and rehashed as schema v1 to regain Plan-SHA confirmation', async (t) => {
  const root = await repository(t);
  const current = await createAutoPlan(root, 'Change the exported value.', proposal, {
    definition: await loadDefinition(root), workId: 'AUT-DOWNGRADE-RATIFY', workType: 'feature', fromBranch: 'main'
  });
  const downgraded = structuredClone(current);
  downgraded.schemaVersion = 1;
  delete downgraded.confirmation;
  downgraded.planSha256 = autoPlanHash(downgraded);
  await writeFile(
    path.join(root, '.git/singularity-flow/auto-plans', `${downgraded.planId}.json`),
    canonicalJson(downgraded)
  );
  await assert.rejects(
    () => ratifyAutoPlan(root, downgraded.planId, downgraded.planSha256),
    (error) => error.code === 'AUTO_PLAN_LEGACY_UNSUPPORTED'
  );
});

test('credential-bearing Plan bytes are refused before rendering or Git execution', async (t) => {
  const root = await repository(t);
  const current = await createAutoPlan(root, 'Change the exported value.', proposal, {
    definition: await loadDefinition(root), workId: 'AUT-LEGACY-REMOTE', workType: 'feature', fromBranch: 'main'
  });
  const unsafe = structuredClone(current);
  unsafe.bindings.repository = 'https://legacy-secret@example.invalid/team/repo.git';
  unsafe.repositories[0].remoteUrl = unsafe.bindings.repository;
  delete unsafe.repositories[0].remoteFingerprint;
  unsafe.planSha256 = autoPlanHash(unsafe);
  await writeFile(
    path.join(root, '.git/singularity-flow/auto-plans', `${unsafe.planId}.json`),
    canonicalJson(unsafe)
  );
  await assert.rejects(
    () => readAutoPlan(root, unsafe.planId),
    (error) => error.code === 'AUTO_PLAN_REMOTE_UNSAFE'
      && !String(error.message).includes('legacy-secret')
  );
});

test('Auto base validation freezes the reviewed remote against ambient insteadOf rewrites', async (t) => {
  const root = await repository(t);
  const reviewed = run('git', ['config', '--local', '--get', 'remote.origin.url'], root).stdout.trim();
  const decoy = `${root}-decoy.git`;
  run('git', ['init', '--bare', '-b', 'main', decoy], root);
  t.after(() => rm(decoy, { recursive: true, force: true }));
  run('git', ['config', '--local', `url.${decoy}.insteadOf`, reviewed], root);
  const plan = await createAutoPlan(root, 'Change the exported value.', proposal, {
    definition: await loadDefinition(root), workId: 'AUT-FROZEN-REMOTE', workType: 'feature', fromBranch: 'main'
  });
  assert.equal(plan.repositories[0].remoteUrl, reviewed);
  assert.match(plan.repositories[0].baseCommit, /^[a-f0-9]{40,64}$/);
});

test('Auto Plan refuses a credential-bearing HTTP remote before persisting a Plan', async (t) => {
  const root = await repository(t);
  run('git', ['remote', 'set-url', 'origin', 'https://secret-token@example.invalid/team/repo.git'], root);
  const definition = await loadDefinition(root);
  await assert.rejects(
    () => createAutoPlan(root, 'Change the exported value.', proposal, {
      definition, workId: 'AUT-UNSAFE-REMOTE', workType: 'feature', fromBranch: 'main'
    }),
    (error) => error.code === 'BOOTSTRAP_REMOTE_CONTAINS_CREDENTIAL'
      && !String(error.message).includes('secret-token')
  );
});
