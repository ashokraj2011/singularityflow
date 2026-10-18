import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { describeCapability } from '../src/bootstrap.mjs';
import {
  assertCapabilityAppId, CAPABILITIES_PATH, capabilityTree, editCapability, validateCapabilities
} from '../src/capabilities.mjs';
import { readCapabilityTeamRequestFile, resolveMapTeamInput } from '../src/commands/capability.mjs';
import { normalizeCapabilityTeamRequest } from '../src/organisation.mjs';

const roots = [];
async function scratch() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-app-id-'));
  roots.push(root);
  return root;
}
test.after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const map = (appId) => ({
  version: 1,
  capabilities: { payments: { name: 'Payments', kind: 'collection', parent: null, ...(appId === undefined ? {} : { appId }) } }
});

test('an App ID is optional text without spaces, and a hand-written number reads as the same ID', () => {
  assert.equal(capabilityTree(validateCapabilities(map(undefined)))[0].appId, null);
  assert.equal(capabilityTree(validateCapabilities(map('APP-1234')))[0].appId, 'APP-1234');
  assert.equal(capabilityTree(validateCapabilities(map(12345)))[0].appId, '12345');
  for (const refused of ['APP 1234', '', 'x'.repeat(65), true, ['APP-1']]) {
    assert.throws(() => validateCapabilities(map(refused)), /Capability 'payments'\.appId must be text without spaces/);
  }
  assert.equal(assertCapabilityAppId('x'.repeat(64)), 'x'.repeat(64));
  assert.throws(() => assertCapabilityAppId('APP\t1'), { code: 'CAPABILITY_APP_ID_INVALID' });
});

test('the capability editor sets and clears an App ID and refuses one with spaces', async () => {
  const root = await scratch();
  await mkdir(path.join(root, 'singularity'));
  const file = path.join(root, CAPABILITIES_PATH);
  await writeFile(file, '# Ours.\nversion: 1\ncapabilities:\n  payments:\n    name: Payments\n    kind: collection\n    parent: null\n');

  await editCapability(root, 'payments', { appId: '00123' });
  const written = await readFile(file, 'utf8');
  assert.match(written, /^# Ours\.$/m, 'the rest of the file keeps its layout');
  assert.equal(YAML.parse(written).capabilities.payments.appId, '00123', 'a numeric-looking ID stays text');

  await assert.rejects(() => editCapability(root, 'payments', { appId: 'APP 1' }), /must be text without spaces/);
  assert.equal(await readFile(file, 'utf8'), written, 'a refused edit leaves the map as it was');

  await editCapability(root, 'payments', { appId: '' });
  assert.equal(Object.hasOwn(YAML.parse(await readFile(file, 'utf8')).capabilities.payments, 'appId'), false);
});

test('bootstrap writes the App ID into the first capability only when one is given', async () => {
  const root = await scratch();
  await mkdir(path.join(root, 'singularity'));
  const base = { capabilityId: 'payments', capabilityName: 'Payments', kind: 'collection', repositoryId: 'payments', jiraProject: 'PAY', teams: [] };
  await describeCapability(root, { ...base, appId: 'APP-7' });
  assert.equal(YAML.parse(await readFile(path.join(root, CAPABILITIES_PATH), 'utf8')).capabilities.payments.appId, 'APP-7');
  await describeCapability(root, base);
  assert.equal(Object.hasOwn(YAML.parse(await readFile(path.join(root, CAPABILITIES_PATH), 'utf8')).capabilities.payments, 'appId'), false);
});

test('a team request carries the App ID from flags and from a request file alike, and refuses spaces', async () => {
  const lead = 'https://git.example.com/platform.git';
  const fromFlags = await resolveMapTeamInput({
    positionals: ['capability', 'map-team', 'payments'],
    options: { lead, name: 'Payments', 'app-id': ' APP-9 ', member: 'checkout=https://git.example.com/checkout.git', json: true }
  });
  const root = await scratch();
  const file = path.join(root, 'request.json');
  await writeFile(file, JSON.stringify({
    teamId: 'payments', lead, name: 'Payments', appId: 'APP-9',
    members: [{ capabilityId: 'checkout', repositoryUrl: 'https://git.example.com/checkout.git', name: 'checkout' }], links: []
  }), { mode: 0o600 });
  const fromFile = await readCapabilityTeamRequestFile(file);
  assert.equal(normalizeCapabilityTeamRequest(lead, fromFlags).appId, 'APP-9');
  assert.deepEqual(normalizeCapabilityTeamRequest(lead, fromFile), normalizeCapabilityTeamRequest(lead, fromFlags));
  assert.equal(normalizeCapabilityTeamRequest(lead, { ...fromFile, appId: null }).appId, null);
  assert.throws(() => normalizeCapabilityTeamRequest(lead, { ...fromFile, appId: 'APP 9' }),
    { code: 'CAPABILITY_TEAM_APP_ID_INVALID' });
  await assert.rejects(() => resolveMapTeamInput({
    positionals: ['capability', 'map-team'], options: { request: file, 'app-id': 'APP-9' }
  }), { code: 'CAPABILITY_TEAM_REQUEST_ARGUMENT_CONFLICT' });
});
