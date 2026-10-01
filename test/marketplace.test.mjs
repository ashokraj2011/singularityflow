import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import {
  marketplaceEntriesView, normalizeMarketplaces, parseMarketplaceIndex, selectMarketplaceEntry
} from '../src/marketplace.mjs';
import { checkImportSources, previewImport, readStagedImport } from '../src/asset-import.mjs';
import { planStudioChangeSet, STUDIO_CHANGE_SET_SCHEMA } from '../src/workflow-studio.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Market Tester' };
delete env.SINGULARITY_FLOW_TEST_REMOTE_FIXTURES;
const INDEX = 'https://catalog.example.org/sflow-marketplace.json';
const MARKET = normalizeMarketplaces({ acme: { label: 'Acme', index: INDEX, allowedOrigins: ['https://cdn.example.org'] } }).acme;

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function response(content, { status = 200 } = {}) {
  const bytes = Buffer.from(content);
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, arrayBuffer: async () => bytes };
}
const served = (values) => async (url) => (Object.hasOwn(values, url) ? response(values[url]) : response('missing', { status: 404 }));
const index = (entries) => JSON.stringify({ format: 'sflow-marketplace@1', name: 'Acme catalog', publisher: 'Acme', entries });

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-market-'));
  run('git', ['init', '-b', 'main'], root); run('git', ['config', 'user.name', 'Market Tester'], root); run('git', ['config', 'user.email', 'market@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Market\n');
  run(process.execPath, [bin, 'init'], root);
  const file = path.join(root, 'singularity/workflow.yml');
  const document = YAML.parseDocument(await readFile(file, 'utf8'));
  document.setIn(['marketplaces'], document.createNode({ acme: { label: 'Acme', index: INDEX, allowedOrigins: ['https://cdn.example.org'] } }));
  await writeFile(file, document.toString());
  run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'initialize'], root);
  return root;
}

test('marketplace configuration is exact: HTTPS indexes, origins without paths, no unknown fields', () => {
  assert.deepEqual(MARKET, { id: 'acme', label: 'Acme', index: INDEX, allowedOrigins: ['https://cdn.example.org'] });
  assert.throws(() => normalizeMarketplaces({ acme: { index: 'http://catalog.example.org/i.json' } }), /public HTTPS/);
  assert.throws(() => normalizeMarketplaces({ acme: { index: INDEX, allowedOrigins: ['https://cdn.example.org/files'] } }), /must be an origin/);
  assert.throws(() => normalizeMarketplaces({ acme: { index: INDEX, token: 'x' } }), /unknown field 'token'/);
  assert.throws(() => normalizeMarketplaces({ Acme: { index: INDEX } }), /kebab-case/);
});

test('an index pins every file by hash and cannot widen where files come from', () => {
  const good = { id: 'checklist', kind: 'skill', version: '1.0.0', label: 'Checklist', url: 'https://cdn.example.org/c.md', sha256: 'a'.repeat(64) };
  const parsed = parseMarketplaceIndex(Buffer.from(index([good, { id: 'future', kind: 'plugin-bundle' }])), MARKET);
  assert.equal(parsed.entries.length, 1);
  assert.deepEqual(parsed.ignored, ['future'], 'kinds this build does not know are listed as ignored, not refused');
  assert.throws(() => parseMarketplaceIndex(Buffer.from(JSON.stringify({ format: 'other', entries: [] })), MARKET), /sflow-marketplace@1/);
  assert.throws(() => parseMarketplaceIndex(Buffer.from(index([{ ...good, sha256: undefined }])), MARKET), /pin its content with a sha256/);
  assert.throws(() => parseMarketplaceIndex(Buffer.from(index([{ ...good, url: 'https://elsewhere.example.net/c.md' }])), MARKET), { code: 'MARKETPLACE_ORIGIN_REFUSED' });
  assert.throws(() => parseMarketplaceIndex(Buffer.from(index([{ id: 'feed', kind: 'generated', urlTemplate: 'https://elsewhere.example.net/{workId}.md', phase: 'design', target: 'artifacts/design/f.md' }])), MARKET), { code: 'MARKETPLACE_ORIGIN_REFUSED' });
  assert.throws(() => parseMarketplaceIndex(Buffer.from(index([good, good])), MARKET), /repeats skill:checklist@1\.0\.0/);
  const versions = parseMarketplaceIndex(Buffer.from(index([{ ...good, version: '1.9.0' }, { ...good, version: '1.10.0', sha256: 'b'.repeat(64) }])), MARKET);
  assert.equal(selectMarketplaceEntry(versions, 'acme', 'checklist').version, '1.10.0', 'versions compare numerically');
  assert.equal(selectMarketplaceEntry(versions, 'acme', 'checklist', '1.9.0').sha256, 'a'.repeat(64));
  assert.throws(() => selectMarketplaceEntry(versions, 'acme', 'checklist', '2.0.0'), /no version 2\.0\.0/);
  assert.equal(marketplaceEntriesView(versions, { search: 'CHECK' }).length, 2);
});

test('a marketplace import is verified against the published hash and keeps the entry kind', async () => {
  const root = await repository();
  const skill = '# Accessibility review\n\n- Label every control.\n';
  const entry = { id: 'a11y-review', kind: 'skill', version: '1.0.0', label: 'Accessibility review', url: 'https://cdn.example.org/a11y.md', sha256: sha256(skill) };
  const fetchImpl = served({ [INDEX]: index([entry]), 'https://cdn.example.org/a11y.md': skill });
  const preview = await previewImport(root, 'market:acme/a11y-review', { fetchImpl });
  assert.equal(preview.as, 'skill');
  assert.equal(preview.sha256, sha256(skill));
  assert.deepEqual(preview.marketplace, { id: 'acme', entry: 'a11y-review', version: '1.0.0', label: 'Accessibility review', description: null, phases: [] });
  assert.equal((await readStagedImport(root, preview.sha256)).source.kind, 'marketplace');
  await assert.rejects(() => previewImport(root, 'market:acme/a11y-review', { as: 'template', fetchImpl }), { code: 'IMPORT_KIND_INVALID' });
  await assert.rejects(() => previewImport(root, 'market:other/a11y-review', { fetchImpl }), { code: 'MARKETPLACE_UNKNOWN' });
  const lying = served({ [INDEX]: index([entry]), 'https://cdn.example.org/a11y.md': `${skill}\nInjected.\n` });
  await assert.rejects(() => previewImport(root, 'market:acme/a11y-review', { fetchImpl: lying }), { code: 'MARKETPLACE_CONTENT_MISMATCH' });

  const changes = [{ op: 'import.skill', agent: 'architect', id: 'a11y-review', source: 'market:acme/a11y-review', sha256: preview.sha256, phases: ['design'] }];
  const applied = await planStudioChangeSet(root, { schema: STUDIO_CHANGE_SET_SCHEMA, changes }, { write: true, fetchImpl });
  assert.equal(applied.valid, true, JSON.stringify(applied.problems));
  const agent = await readFile(path.join(root, '.github/agents/architect.agent.md'), 'utf8');
  assert.match(agent, /\| a11y-review \| https:\/\/cdn\.example\.org\/a11y\.md \| design \| no \|/);
  const ledger = YAML.parse(await readFile(path.join(root, 'singularity/imports.lock.yml'), 'utf8'));
  assert.deepEqual(
    (({ kind, marketplace, entry: id, version }) => ({ kind, marketplace, id, version }))(ledger.imports['skill:architect/a11y-review'].source),
    { kind: 'marketplace', marketplace: 'acme', id: 'a11y-review', version: '1.0.0' }
  );

  const newer = '# Accessibility review\n\n- Label every control.\n- Reach everything by keyboard.\n';
  const next = served({ [INDEX]: index([entry, { ...entry, version: '1.1.0', url: 'https://cdn.example.org/a11y-2.md', sha256: sha256(newer) }]), 'https://cdn.example.org/a11y-2.md': newer });
  const [checked] = await checkImportSources(root, { fetchImpl: next });
  assert.equal(checked.status, 'newer version available');
  assert.equal(checked.updateCommand, `singularity-flow import add "market:acme/a11y-review@1.1.0" --as skill --agent architect --id a11y-review --phases design --sha256 ${sha256(newer)} --replace`);
});

test('trusting and dropping a marketplace are reviewed configuration changes', async () => {
  const root = await repository();
  const plan = (changes, options) => planStudioChangeSet(root, { schema: STUDIO_CHANGE_SET_SCHEMA, changes }, options);
  const duplicate = await plan([{ op: 'marketplace.add', id: 'acme', index: INDEX }]);
  assert.equal(duplicate.problems[0].code, 'STUDIO_MARKETPLACE_EXISTS');
  const added = await plan([{ op: 'marketplace.add', id: 'team', label: 'Team catalog', index: 'https://team.example.org/index.json' }], { write: true });
  assert.equal(added.valid, true, JSON.stringify(added.problems));
  let workflow = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  assert.deepEqual(workflow.marketplaces.team, { label: 'Team catalog', index: 'https://team.example.org/index.json' });
  const refused = await plan([{ op: 'marketplace.add', id: 'bad', index: 'https://localhost/index.json' }]);
  assert.match(refused.problems[0].message, /public Internet host/);
  await plan([{ op: 'marketplace.remove', id: 'team' }, { op: 'marketplace.remove', id: 'acme' }], { write: true });
  workflow = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  assert.equal(workflow.marketplaces, undefined, 'an empty marketplaces block is removed');
});
