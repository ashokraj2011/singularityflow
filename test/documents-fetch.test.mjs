import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { loadConfig, loadWorkflow } from '../src/state.mjs';
import { fetchRemoteDocument, listRemoteDocuments } from '../src/documents.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function run(command, args, cwd, { allowFailure = false } = {}) {
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Fetch Tester', SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }) };
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
const flow = (root, args, options = {}) => run(process.execPath, [bin, ...args], root, options);

// Minimal Microsoft Graph stand-in. The SharePoint adapter calls three shapes of URL:
// .../items/{id}/content (bytes), .../{root|root:...}/children (listing), .../items/{id} (metadata).
function jsonResponse(object) {
  const text = JSON.stringify(object);
  return { ok: true, status: 200, headers: { get: (name) => name.toLowerCase() === 'content-length' ? String(Buffer.byteLength(text)) : name.toLowerCase() === 'content-type' ? 'application/json' : null }, arrayBuffer: async () => Buffer.from(text) };
}
function bytesResponse(buffer, mimeType) {
  return { ok: true, status: 200, headers: { get: (name) => ({ 'content-length': String(buffer.length), 'content-type': mimeType, etag: '"v1"' })[name.toLowerCase()] ?? null }, arrayBuffer: async () => buffer };
}
const SPEC_BYTES = Buffer.from('# Customer summary spec\nFetched from OneDrive for Business.\n');
async function graphFetch(url) {
  if (url.endsWith('/content')) return bytesResponse(SPEC_BYTES, 'text/markdown');
  if (url.includes('/children')) return jsonResponse({ value: [
    { id: 'item-1', name: 'summary-spec.md', size: SPEC_BYTES.length, file: { mimeType: 'text/markdown' } },
    { id: 'folder-1', name: 'designs', folder: { childCount: 2 } }
  ] });
  return jsonResponse({ id: 'item-1', name: 'summary-spec.md', size: SPEC_BYTES.length, file: { mimeType: 'text/markdown' }, eTag: '"v1"' });
}

async function repository({ withEnvironmentDeclaration = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-fetch-'));
  run('git', ['init', '-b', 'main'], root); run('git', ['config', 'user.name', 'Fetch Tester'], root); run('git', ['config', 'user.email', 'fetch@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Fetch\n'); flow(root, ['init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off'; config.worldModel.grounding = 'off'; config.documents.allowedPhases = ['intake'];
  config.storage = { defaultProvider: 'onedrive', providers: { onedrive: { type: 'sharepoint', tenantId: 't', clientId: 'c', siteId: 's', driveId: 'd' } } };
  await writeFile(configPath, YAML.stringify(config));
  if (withEnvironmentDeclaration) {
    await writeFile(path.join(root, 'singularity', 'environments.yml'), [
      'schemaVersion: 1',
      'environments:',
      '  qa:',
      '    requires:',
      '      - { name: API_TOKEN, kind: secret }',
      '    localFiles:',
      '      - .env.qa',
      'checks: {}',
      'neverCommit:',
      '  - "**/*.local.yml"',
      ''
    ].join('\n'));
  }
  run('git', ['add', 'README.md', 'singularity', '.github/agents'], root); run('git', ['commit', '-m', 'initialize'], root);
  const remote = `${root}.git`;
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  flow(root, ['start', 'DOCS-9', '--from-branch', 'main', '--title', 'OneDrive intake']);
  return root;
}

test('documents fetch materializes OneDrive bytes into the work item with provider provenance', async () => {
  const root = await repository();
  const config = await loadConfig(root);
  const workflow = await loadWorkflow(root, config, 'DOCS-9');
  const runtime = { fetchImpl: graphFetch, token: 'fake-graph-token' };

  const browse = await listRemoteDocuments(config, { providerId: 'onedrive', runtime });
  assert.equal(browse.providerType, 'sharepoint');
  assert.deepEqual(browse.entries.map((entry) => entry.name), ['summary-spec.md', 'designs']);
  assert.equal(browse.entries[1].folder, true);

  const [record] = await fetchRemoteDocument(root, config, workflow, { providerId: 'onedrive', remoteRef: 'item-1', runtime });
  assert.equal(record.type, 'file');
  assert.equal(record.sourceName, 'summary-spec.md');
  assert.equal(record.mimeType, 'text/markdown');
  assert.equal(record.sha256.length, 64);
  assert.equal(record.remote.source, 'sharepoint');
  assert.equal(record.remote.providerId, 'onedrive');
  assert.equal(record.remote.ref, 'item-1');

  const absolute = path.join(root, record.path);
  assert.ok(existsSync(absolute), 'fetched bytes are written into inputs/DOC-nnn/');
  assert.equal(await readFile(absolute, 'utf8'), SPEC_BYTES.toString('utf8'));

  const manifest = JSON.parse(await readFile(path.join(root, 'singularity/work-items/DOCS-9/documents.json'), 'utf8'));
  assert.equal(manifest.documents.length, 1);
  assert.equal(manifest.documents[0].remote.providerId, 'onedrive');
});

test('documents fetch is blocked outside an allowed document phase', async () => {
  const root = await repository();
  const config = await loadConfig(root);
  const workflow = await loadWorkflow(root, config, 'DOCS-9');
  // Current phase (intake) is in progress but no longer an allowed document phase.
  workflow.resolution = { ...workflow.resolution, documents: { ...(workflow.resolution?.documents ?? {}), allowedPhases: ['requirements'] } };
  await assert.rejects(
    () => fetchRemoteDocument(root, config, workflow, { providerId: 'onedrive', remoteRef: 'item-1', runtime: { fetchImpl: graphFetch, token: 'x' } }),
    /Documents may be added only during/
  );
});

test('documents fetch rejects an unknown provider', async () => {
  const root = await repository();
  const config = await loadConfig(root);
  const workflow = await loadWorkflow(root, config, 'DOCS-9');
  await assert.rejects(
    () => fetchRemoteDocument(root, config, workflow, { providerId: 'nope', remoteRef: 'item-1', runtime: {} }),
    /Unknown or unconfigured storage provider/
  );
});

test('documents fetch refuses environment-local names, secrets, and unscannable text before mutation', async (t) => {
  const secret = `ghp_${'q'.repeat(36)}`;
  for (const scenario of [
    {
      name: 'environment-local name', filename: '.env.qa',
      bytes: Buffer.from('SAFE_NAME=value\n'),
      code: 'ENVIRONMENT_LOCAL_CONTENT_REFUSED', absent: 'SAFE_NAME=value'
    },
    {
      name: 'secret-bearing text', filename: 'review-notes.md',
      bytes: Buffer.from(`# Notes\n\ntoken = "${secret}"\n`),
      code: 'SECRET_DETECTED', absent: secret
    },
    {
      name: 'invalid UTF-8 text', filename: 'review-notes.md',
      bytes: Buffer.from([0x23, 0x20, 0xff, 0x0a]),
      code: 'DOCUMENT_CONTENT_UNSCANNABLE', absent: null
    },
    {
      name: 'NUL-bearing text', filename: 'review-notes.md',
      bytes: Buffer.from('# Notes\n\0hidden\n'),
      code: 'DOCUMENT_CONTENT_UNSCANNABLE', absent: 'hidden'
    }
  ]) {
    await t.test(scenario.name, async () => {
      const root = await repository({ withEnvironmentDeclaration: true });
      const config = await loadConfig(root);
      const workflow = await loadWorkflow(root, config, 'DOCS-9');
      const beforeStatus = run('git', ['status', '--short'], root).stdout;
      const fetchImpl = async (url) => {
        if (url.endsWith('/content')) return bytesResponse(scenario.bytes, 'text/markdown');
        return jsonResponse({
          id: 'item-1', name: scenario.filename, size: scenario.bytes.length,
          file: { mimeType: 'text/markdown' }, eTag: '"v1"'
        });
      };
      await assert.rejects(
        () => fetchRemoteDocument(root, config, workflow, {
          providerId: 'onedrive', remoteRef: 'item-1',
          runtime: { fetchImpl, token: 'fake-graph-token' }
        }),
        (error) => {
          assert.equal(error?.code, scenario.code);
          if (scenario.absent) assert.doesNotMatch(error.message, new RegExp(scenario.absent));
          return true;
        }
      );
      assert.equal(run('git', ['status', '--short'], root).stdout, beforeStatus);
      assert.equal(existsSync(
        path.join(root, 'singularity/work-items/DOCS-9/documents.json')
      ), false);
    });
  }
});
