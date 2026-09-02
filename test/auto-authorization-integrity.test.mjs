import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';

import {
  claimAutoAuthorization, createAutoPlan, finishAutoAuthorization, ratifyAutoPlan
} from '../src/auto/auto-plan.mjs';
import { buildAutoPlanPacket } from '../src/auto/auto-plan-packet.mjs';
import { loadDefinition } from '../src/config.mjs';
import { recordSha256 } from '../src/records.mjs';

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
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-auto-authorization-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Auto Tester'], root);
  run('git', ['config', 'user.email', 'auto@example.com'], root);
  run(process.execPath, [cli, 'init'], root);
  const capabilitiesPath = path.join(root, 'singularity/capabilities.yml');
  const capabilities = YAML.parse(await readFile(capabilitiesPath, 'utf8'));
  capabilities.capabilities['auto-fixture'] = {
    kind: 'delivery', parent: 'product', repository: 'auto-fixture'
  };
  await writeFile(capabilitiesPath, YAML.stringify(capabilities));
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
  run('git', ['commit', '-m', 'enable bounded auto fixture'], root);
  const remote = `${root}.git`;
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  return root;
}

function resealAuthorization(value) {
  const record = structuredClone(value);
  delete record.recordSha256;
  delete record.authorizationSha256;
  const authority = {
    schemaVersion: record.schemaVersion, kind: record.kind, mode: record.mode,
    planId: record.planId, planSha256: record.planSha256,
    actor: record.actor, identityAssurance: record.identityAssurance,
    ratifiedAt: record.ratifiedAt, expiresAt: record.expiresAt
  };
  for (const field of [
    'confirmationProtocol', 'confirmedSha256', 'packetSha256', 'validationSha256'
  ]) {
    if (record[field] != null) authority[field] = record[field];
  }
  record.authorizationSha256 = `sha256:${recordSha256(authority)}`;
  record.recordSha256 = recordSha256(record);
  return record;
}

test('Auto authorization corruption and future records fail closed without being reset', async (t) => {
  const root = await repository(t);
  const definition = await loadDefinition(root);
  const proposal = {
    title: 'Change the application value', workType: 'feature',
    assumptions: [], unresolvedDecisions: [], predictedPaths: ['app.mjs'],
    acceptanceCriteria: ['The exported value changes.'], suggestedUntil: 'first-human-boundary'
  };
  const plan = await createAutoPlan(root, 'Change the exported application value.', proposal, {
    definition, workId: 'AUT-AUTH-INTEGRITY', workType: 'feature', fromBranch: 'main'
  });
  const confirmation = buildAutoPlanPacket(plan).packetSha256;
  const ratified = await ratifyAutoPlan(root, plan.planId, confirmation);
  const target = path.join(root, '.git/singularity-flow/auto-authorizations', `${plan.planId}.json`);
  const original = await readFile(target, 'utf8');
  const valid = JSON.parse(original);

  const refuseWithoutRewrite = async (bytes, expectedCode) => {
    await writeFile(target, bytes);
    await assert.rejects(
      () => ratifyAutoPlan(root, plan.planId, confirmation),
      (error) => error.code === expectedCode
    );
    assert.equal(await readFile(target, 'utf8'), bytes);
  };

  await t.test('malformed JSON is not mistaken for a missing authorization', async () => {
    await refuseWithoutRewrite('{not-json\n', 'SCHEMA_RECORD_INVALID');
  });
  await t.test('a future schema version is preserved for a newer reader', async () => {
    await refuseWithoutRewrite(
      JSON.stringify({ ...valid, schemaVersion: valid.schemaVersion + 1 }),
      'SCHEMA_VERSION_FUTURE'
    );
  });
  await t.test('tampered lifecycle fields are rejected before consumed state is inspected', async () => {
    await refuseWithoutRewrite(JSON.stringify({ ...valid, consumedAt: new Date().toISOString() }),
      'AUTO_AUTHORIZATION_CORRUPT');
  });
  await t.test('a self-consistent record with the wrong family kind is rejected', async () => {
    await refuseWithoutRewrite(JSON.stringify(resealAuthorization({ ...valid, kind: 'auto-flight-state' })),
      'AUTO_AUTHORIZATION_CORRUPT');
  });
  await t.test('a self-consistent record for another Plan cannot occupy this Plan path', async () => {
    await refuseWithoutRewrite(JSON.stringify(resealAuthorization({
      ...valid, planId: `APL-${'A'.repeat(26)}`
    })), 'AUTO_AUTHORIZATION_CORRUPT');
  });
  await t.test('a self-consistent stale Plan hash is refused before consumed state is inspected', async () => {
    await refuseWithoutRewrite(JSON.stringify(resealAuthorization({
      ...valid,
      planSha256: `sha256:${'d'.repeat(64)}`,
      consumedAt: new Date().toISOString()
    })), 'AUTO_AUTHORIZATION_CORRUPT');
  });
  await t.test('claim verifies the stored authorization before inspecting claim state', async () => {
    const tampered = JSON.stringify({ ...valid, claimedAt: new Date().toISOString() });
    await writeFile(target, tampered);
    await assert.rejects(
      () => claimAutoAuthorization(root, plan, ratified.authorization, `AFL-${'B'.repeat(26)}`),
      (error) => error.code === 'AUTO_AUTHORIZATION_CORRUPT'
    );
    assert.equal(await readFile(target, 'utf8'), tampered);
  });
  await t.test('finish verifies the stored authorization before inspecting completion state', async () => {
    await writeFile(target, original);
    const flightId = `AFL-${'C'.repeat(26)}`;
    await claimAutoAuthorization(root, plan, ratified.authorization, flightId);
    const claimed = JSON.parse(await readFile(target, 'utf8'));
    const tampered = JSON.stringify({ ...claimed, consumedAt: new Date().toISOString() });
    await writeFile(target, tampered);
    await assert.rejects(
      () => finishAutoAuthorization(root, plan.planId, flightId, { success: true }),
      (error) => error.code === 'AUTO_AUTHORIZATION_CORRUPT'
    );
    assert.equal(await readFile(target, 'utf8'), tampered);
  });
});
