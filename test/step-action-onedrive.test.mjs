/**
 * OneDrive and SharePoint after-step actions: the approved artifact uploaded through Microsoft
 * Graph to a folder per generation, never replacing anything; plus the storage adapters' uploads
 * of small files, whose answers are larger than the files.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { storageAdapter } from '../src/epic-sources.mjs';
import { GRAPH_BASE, deliverToOneDrive, graphDrivePath, oneDriveItemPath } from '../src/step-action-onedrive.mjs';
import { normalizeIntegrations } from '../src/step-actions.mjs';

const ENV = { SFLOW_SECRET_GRAPH_TOKEN: 'graph-token' };
const KEY = `sad_${'5'.repeat(40)}`;

function driveRecord({ target = { kind: 'onedrive', drive: 'b!lib-1', site: 'contoso.sharepoint.com,11,22', tokenSecret: 'SFLOW_SECRET_GRAPH_TOKEN' }, generation = 2, artifact } = {}) {
  const { targets } = normalizeIntegrations({ targets: { docs: target } });
  return {
    key: KEY, workId: 'STORY-9', phaseId: 'intake', generation, trigger: 'approved',
    action: { id: 'upload', on: ['approved'], target: 'docs', send: 'artifact', targetSpec: targets.docs },
    event: { story: { id: 'STORY-9' }, step: { id: 'intake', label: 'Intake' } },
    artifact: artifact ?? { path: 'singularity/work-items/STORY-9/artifacts/intake/intake.md', sha256: 'a'.repeat(64), mediaType: 'text/markdown', base64: Buffer.from('# Intake\n').toString('base64') }
  };
}

/** A Graph that remembers uploads by path and answers like the real one. */
function fakeGraph() {
  const items = new Map();
  const requests = [];
  let script = [];
  const request = async ({ url, method, headers, body }) => {
    requests.push({ url, method, headers, body });
    if (script.length) { const next = script.shift(); if (next) return { status: next, headers: {}, text: JSON.stringify({ error: { message: `scripted ${next}` } }) }; }
    if (headers.authorization !== 'Bearer graph-token') return { status: 401, headers: {}, text: JSON.stringify({ error: { message: 'InvalidAuthenticationToken' } }) };
    const target = new URL(url);
    const match = /\/root:\/(.+):\/content$/.exec(target.pathname);
    if (method !== 'PUT' || !match) return { status: 404, headers: {}, text: '{}' };
    const item = decodeURIComponent(match[1]);
    if (items.has(item) && target.searchParams.get('@microsoft.graph.conflictBehavior') === 'fail') {
      return { status: 409, headers: {}, text: JSON.stringify({ error: { code: 'nameAlreadyExists' } }) };
    }
    items.set(item, Buffer.from(body));
    return { status: 201, headers: {}, text: JSON.stringify({ id: 'item-1', name: item.split('/').pop(), webUrl: `https://contoso.sharepoint.com/sites/team/Shared%20Documents/${encodeURI(item)}` }) };
  };
  return { items, requests, request, script: (codes) => { script = [...codes]; } };
}

test('a onedrive target names its drive, an optional site and a folder per generation', () => {
  const record = driveRecord({ target: { kind: 'onedrive', drive: 'b!lib-1', folder: 'Specs/{story}/{step} g{generation}', tokenSecret: 'SFLOW_SECRET_GRAPH_TOKEN' } });
  assert.equal(oneDriveItemPath(record), 'Specs/STORY-9/intake g2/intake.md');
  assert.equal(graphDrivePath(record.action.targetSpec), '/drives/b!lib-1');
  assert.equal(graphDrivePath(driveRecord().action.targetSpec), '/sites/contoso.sharepoint.com%2C11%2C22/drives/b!lib-1');
  assert.equal(oneDriveItemPath(driveRecord()), 'sflow/STORY-9/intake/generation-2/intake.md', 'the default folder keeps each generation apart');
  const code = (target) => { try { normalizeIntegrations({ targets: { one: { kind: 'onedrive', drive: 'b!lib-1', tokenSecret: 'SFLOW_SECRET_GRAPH_TOKEN', ...target } } }); return null; } catch (error) { return error.code; } };
  assert.equal(code({}), null);
  for (const target of [{ folder: 'Specs/{story}' }, { folder: '../{generation}' }, { folder: '{secret}/{generation}' }, { drive: 'b!x/y' }, { site: 'site/../x' }, { network: 'private' }]) {
    assert.equal(code(target), 'INTEGRATION_TARGET_INVALID', JSON.stringify(target));
  }
  assert.equal(code({ tokenSecret: 'GRAPH_TOKEN' }), 'INTEGRATION_SECRET_NAME_INVALID');
});

test('a delivery uploads the approved bytes once, without replacing, and a repeat finds them there', async () => {
  const graph = fakeGraph();
  const first = await deliverToOneDrive(driveRecord(), { env: ENV, request: graph.request });
  assert.equal(first.outcome, 'delivered', first.detail);
  assert.match(first.detail, /^Uploaded sflow\/STORY-9\/intake\/generation-2\/intake\.md \(https:\/\/contoso\.sharepoint\.com\/…\)\.$/, 'the address is shortened, never the full link');
  const [sent] = graph.requests;
  assert.equal(sent.method, 'PUT');
  assert.equal(sent.url, `${GRAPH_BASE}/sites/contoso.sharepoint.com%2C11%2C22/drives/b!lib-1/root:/sflow/STORY-9/intake/generation-2/intake.md:/content?@microsoft.graph.conflictBehavior=fail`);
  assert.equal(sent.headers['content-type'], 'text/markdown');
  assert.equal(sent.headers['x-sflow-delivery'], KEY);
  assert.equal(graph.items.get('sflow/STORY-9/intake/generation-2/intake.md').toString(), '# Intake\n');

  const again = await deliverToOneDrive(driveRecord(), { env: ENV, request: graph.request });
  assert.deepEqual([again.outcome, again.detail], ['delivered', 'sflow/STORY-9/intake/generation-2/intake.md is already there.']);
  const older = await deliverToOneDrive(driveRecord({ generation: 1, artifact: { path: 'x/intake.md', sha256: null, mediaType: 'text/markdown', base64: Buffer.from('# Old\n').toString('base64') } }), { env: ENV, request: graph.request });
  assert.equal(older.outcome, 'delivered');
  assert.equal(graph.items.get('sflow/STORY-9/intake/generation-2/intake.md').toString(), '# Intake\n', 'an older generation goes to its own folder and never replaces a newer upload');
});

test('a OneDrive delivery says what a person has to do, and retries only what may pass by itself', async () => {
  const graph = fakeGraph();
  assert.deepEqual(await deliverToOneDrive(driveRecord(), { env: {}, request: graph.request }), {
    outcome: 'unavailable', code: 'STEP_ACTION_SECRET_MISSING', detail: 'Secret SFLOW_SECRET_GRAPH_TOKEN is not set on this machine.'
  });
  const expired = await deliverToOneDrive(driveRecord(), { env: { SFLOW_SECRET_GRAPH_TOKEN: 'old' }, request: graph.request });
  assert.deepEqual([expired.outcome, expired.code], ['failed', 'STEP_ACTION_GRAPH_REFUSED']);
  assert.match(expired.detail, /has expired; store a fresh one, then retry\.$/);
  graph.script([403]);
  assert.match((await deliverToOneDrive(driveRecord(), { env: ENV, request: graph.request })).detail, /cannot write to that drive/);
  graph.script([404]);
  assert.equal((await deliverToOneDrive(driveRecord(), { env: ENV, request: graph.request })).code, 'STEP_ACTION_GRAPH_NOT_FOUND');
  graph.script([429]);
  assert.equal((await deliverToOneDrive(driveRecord(), { env: ENV, request: graph.request })).outcome, 'retry');
  graph.script([503]);
  assert.equal((await deliverToOneDrive(driveRecord(), { env: ENV, request: graph.request })).outcome, 'retry');
  const timedOut = await deliverToOneDrive(driveRecord(), { env: ENV, request: async () => ({ transport: { outcome: 'retry', code: 'STEP_ACTION_TIMEOUT', detail: 'No answer within 10 seconds.' } }) });
  assert.equal(timedOut.code, 'STEP_ACTION_TIMEOUT');
  const missing = await deliverToOneDrive(driveRecord({ artifact: { path: 'big.md', sha256: null, problem: 'big.md is larger than 4 MiB, so it is not sent.' } }), { env: ENV, request: graph.request });
  assert.deepEqual([missing.outcome, missing.code, missing.detail], ['failed', 'STEP_ACTION_ARTIFACT_UNAVAILABLE', 'big.md is larger than 4 MiB, so it is not sent.']);
});

test('storage uploads of small files succeed although the answer is larger than the file', async () => {
  const reply = (status, text) => new Response(text, { status, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) } });
  const description = JSON.stringify({ id: 'item-7', eTag: '"{1,1}"', webUrl: 'https://contoso.sharepoint.com/x', padding: 'x'.repeat(4000) });
  const sharepoint = storageAdapter('docs', { type: 'sharepoint', siteId: 'site-1', driveId: 'drive-1' }, { token: 'graph-token', fetchImpl: async () => reply(201, description) });
  const stored = await sharepoint.put({ initiativeId: 'EPIC-1', filename: 'note.md', bytes: Buffer.from('tiny\n'), sha256: 'b'.repeat(64) });
  assert.equal(stored.objectId, 'item-7');
  const artifactory = storageAdapter('corporate', { type: 'artifactory', baseUrl: 'https://artifacts.example.test/artifactory', repository: 'releases' }, { token: 'a-token', fetchImpl: async () => reply(201, JSON.stringify({ repo: 'releases', path: '/x', checksums: { sha256: 'c'.repeat(64) } })) });
  const deployed = await artifactory.put({ initiativeId: 'EPIC-1', filename: 'note.md', bytes: Buffer.from('tiny\n'), sha256: 'b'.repeat(64) });
  assert.equal(deployed.version, 'b'.repeat(64));
});
