import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CAPABILITY_TEAM_REQUEST_FILE_MAX_BYTES,
  readCapabilityTeamRequestFile,
  resolveMapTeamInput
} from '../src/commands/capability.mjs';
import {
  CAPABILITY_MAP_INPUT_LIMITS, normalizeCapabilityTeamRequest
} from '../src/organisation.mjs';

const roots = [];

async function requestFile(contents) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-team-request-'));
  roots.push(root);
  const file = path.join(root, 'request.json');
  await writeFile(file, typeof contents === 'string' || Buffer.isBuffer(contents)
    ? contents : JSON.stringify(contents), { mode: 0o600 });
  return file;
}

test.after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const canonicalRequest = Object.freeze({
  teamId: 'payments-platform',
  lead: 'https://git.example.com/platform.git',
  name: 'Payments Platform',
  jiraProject: 'PAY',
  members: [{
    capabilityId: 'checkout-api',
    repositoryUrl: 'https://git.example.com/checkout-api.git',
    name: 'Checkout API'
  }],
  links: ['settlement-worker']
});

test('map-team request file ceiling cannot exceed the shared normalized aggregate ceiling', () => {
  assert.equal(CAPABILITY_TEAM_REQUEST_FILE_MAX_BYTES, CAPABILITY_MAP_INPUT_LIMITS.aggregateBytes);
});

test('map-team request files and manual flags reach the exact same domain normalizer', async () => {
  const file = await requestFile(canonicalRequest);
  const fromFile = await resolveMapTeamInput({
    positionals: ['capability', 'map-team'],
    options: { request: file, json: true }
  });
  const fromFlags = await resolveMapTeamInput({
    positionals: ['capability', 'map-team', canonicalRequest.teamId],
    options: {
      lead: canonicalRequest.lead,
      name: canonicalRequest.name,
      'jira-project': canonicalRequest.jiraProject,
      member: 'checkout-api=https://git.example.com/checkout-api.git',
      'member-name': 'checkout-api=Checkout API',
      link: 'settlement-worker',
      json: true
    }
  });

  assert.deepEqual(
    normalizeCapabilityTeamRequest(fromFile.lead, fromFile),
    normalizeCapabilityTeamRequest(fromFlags.lead, fromFlags)
  );
});

test('map-team request JSON is closed at the request and member boundaries', async () => {
  const withRootSecret = await requestFile({ ...canonicalRequest, token: 'do-not-reflect-me' });
  await assert.rejects(readCapabilityTeamRequestFile(withRootSecret), (error) => {
    assert.equal(error.code, 'CAPABILITY_TEAM_REQUEST_INVALID');
    assert.doesNotMatch(error.message, /token|do-not-reflect-me/iu);
    return true;
  });

  const withMemberSecret = await requestFile({
    ...canonicalRequest,
    members: [{ ...canonicalRequest.members[0], credential: 'also-private' }]
  });
  await assert.rejects(readCapabilityTeamRequestFile(withMemberSecret), (error) => {
    assert.equal(error.code, 'CAPABILITY_TEAM_REQUEST_INVALID');
    assert.doesNotMatch(error.message, /credential|also-private/iu);
    return true;
  });
});

test('map-team request files have a hard pre-parse byte ceiling', async () => {
  const file = await requestFile(Buffer.alloc(CAPABILITY_TEAM_REQUEST_FILE_MAX_BYTES + 1, 0x20));
  await assert.rejects(readCapabilityTeamRequestFile(file), (error) => {
    assert.ok([
      'CAPABILITY_TEAM_REQUEST_FILE_INVALID',
      'CAPABILITY_TEAM_REQUEST_FILE_LIMIT_EXCEEDED'
    ].includes(error.code));
    assert.match(error.message, /no larger than|file limit/iu);
    return true;
  });
});

test('map-team request parsing never echoes malformed JSON contents', async () => {
  const marker = 'private-request-content-must-not-appear';
  const file = await requestFile(`{"teamId":"${marker}"`);
  await assert.rejects(readCapabilityTeamRequestFile(file), (error) => {
    assert.equal(error.code, 'CAPABILITY_TEAM_REQUEST_JSON_INVALID');
    assert.doesNotMatch(error.message, new RegExp(marker, 'u'));
    return true;
  });
});

test('map-team request URLs retain the shared credential-free validation', async () => {
  const secret = 'not-for-diagnostics';
  const file = await requestFile({
    ...canonicalRequest,
    lead: `https://user:${secret}@git.example.com/platform.git`
  });
  const request = await readCapabilityTeamRequestFile(file);
  assert.throws(
    () => normalizeCapabilityTeamRequest(request.lead, request),
    (error) => {
      assert.equal(error.code, 'BOOTSTRAP_REMOTE_CONTAINS_CREDENTIAL');
      assert.doesNotMatch(error.message, new RegExp(secret, 'u'));
      return true;
    }
  );
});

test('map-team request transport cannot be mixed with manual mapping arguments', async () => {
  const file = await requestFile(canonicalRequest);
  await assert.rejects(resolveMapTeamInput({
    positionals: ['capability', 'map-team', 'shadow-team'],
    options: { request: file, lead: canonicalRequest.lead }
  }), (error) => error.code === 'CAPABILITY_TEAM_REQUEST_ARGUMENT_CONFLICT');
});
