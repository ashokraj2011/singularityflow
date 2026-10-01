import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import { registerEpicSource, registerEpicTextSource } from '../src/epic-sources.mjs';
import { materializeInitiative } from '../src/initiative-repositories.mjs';
import { createInitiative, initiativeDir, saveInitiative } from '../src/initiative-state.mjs';
import { run } from '../src/util.mjs';

process.env.NODE_ENV = 'test';
process.env.SINGULARITY_FLOW_TEST_IDENTITY = 'Initiative Owner';
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const ACTOR_EMAIL = 'initiative.owner@example.com';
const EPIC = 'INIT-SRCS';
const PDF = Buffer.from('%PDF-1.4\n% ledger brief\n');

function flow(root, args, { allowFailure = false } = {}) {
  const env = { ...process.env, SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }) };
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8', env, input: '' });
  if (!allowFailure && result.status !== 0) throw new Error(`singularity-flow ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

/** One repository that is the Epic's lead and its Story's repository, with four Epic sources. */
async function releasedStory() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-epic-sources-'));
  const remote = path.join(base, 'app.git');
  const root = path.join(base, 'app');
  run('git', ['init', '--bare', '-b', 'main', remote], { cwd: base });
  await mkdir(root);
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Initiative Owner'], { cwd: root });
  run('git', ['config', 'user.email', ACTOR_EMAIL], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# App\n');
  await initializeDefinition(root);
  const portfolioFile = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
  for (const authority of Object.values(portfolio.approvalAuthorities)) authority.members = [{ name: 'Initiative Owner', email: ACTOR_EMAIL }];
  portfolio.repositories = { app: { url: remote, defaultBranch: 'main', required: true } };
  portfolio.storage = { defaultProvider: 'local-files', providers: { 'local-files': { type: 'local' } } };
  await writeFile(portfolioFile, YAML.stringify(portfolio));
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.worldModel.grounding = 'off'; workflow.approvalSecurity = { profile: 'poc' };
  workflow.repositoryReadiness.requiredBeforeStory = false;
  await writeFile(workflowFile, YAML.stringify(workflow));
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'Initialize lead'], { cwd: root });
  run('git', ['remote', 'add', 'origin', remote], { cwd: root });
  run('git', ['push', '-u', 'origin', 'main'], { cwd: root });

  run('git', ['switch', '-c', EPIC], { cwd: root });
  const created = await createInitiative(root, { id: EPIC, profile: 'initiative-lite' });
  created.initiative.phases.define.status = 'approved';
  created.initiative.phases.plan.status = 'approved';
  created.initiative.phases.build.status = 'in_progress';
  created.initiative.currentPhase = 'build';
  const directory = initiativeDir(root, created.portfolio, EPIC);
  const output = Object.values(created.initiative.phases.define.outputs)[0];
  const body = `# Approved business case for ${EPIC}\n`;
  await mkdir(path.dirname(path.join(directory, output.path)), { recursive: true });
  await writeFile(path.join(directory, output.path), body);
  Object.assign(output, { status: 'approved', sha256: createHash('sha256').update(body).digest('hex'), generation: 1 });
  await saveInitiative(root, created.portfolio, created.initiative);

  const files = await mkdtemp(path.join(os.tmpdir(), 'sflow-epic-files-'));
  await writeFile(path.join(files, 'brief.pdf'), PDF);
  await writeFile(path.join(files, 'mockup.png'), Buffer.from('not really a png, but pinned\n'));
  const brief = (await registerEpicSource(root, { initiativeId: EPIC, filePath: path.join(files, 'brief.pdf'), label: 'Ledger brief', mimeType: 'application/pdf' })).record;
  const notes = (await registerEpicTextSource(root, { initiativeId: EPIC, text: 'Workshop: show the ledger total first.', label: 'Workshop notes' })).record;
  const forged = await registerEpicTextSource(root, { initiativeId: EPIC, text: 'An older note.', label: 'Old notes' });
  const mockup = (await registerEpicSource(root, { initiativeId: EPIC, filePath: path.join(files, 'mockup.png'), label: 'Checkout mockup', mimeType: 'image/png' })).record;
  // One record is edited after it was pinned, and one blob's bytes are swapped: neither may import.
  const recordFile = path.join(root, forged.manifest.sources.find((entry) => entry.sourceId === forged.record.sourceId).recordPath);
  await writeFile(recordFile, `${JSON.stringify({ ...JSON.parse(await readFile(recordFile, 'utf8')), name: 'Forged notes' }, null, 2)}\n`);
  await writeFile(path.join(directory, 'sources/blobs', mockup.sha256, mockup.filename), Buffer.from('swapped bytes\n'));

  await writeFile(path.join(directory, 'breakdown.yml'), YAML.stringify({
    version: 1, initiativeId: EPIC,
    epics: [{ id: 'EPIC-1', title: 'Ledger', stories: [{ id: 'APP-1', title: 'Story APP-1', repository: 'app', blocking: true }] }]
  }));
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', `[${EPIC}][epic:init] governance artifacts`], { cwd: root });
  run('git', ['push', '-u', 'origin', `HEAD:${EPIC}`], { cwd: root });
  const released = await materializeInitiative(root, EPIC, { confirmation: EPIC });
  assert.equal(released.failures.length, 0, JSON.stringify(released.failures));

  const story = path.join(base, 'story');
  run('git', ['clone', '--branch', 'APP-1', remote, story], { cwd: base });
  run('git', ['config', 'user.name', 'Initiative Owner'], { cwd: story });
  run('git', ['config', 'user.email', ACTOR_EMAIL], { cwd: story });
  flow(story, ['start', 'APP-1']);
  return { story, brief, notes, forged: forged.record, mockup };
}

test('a Story released from an Epic lists the Epic\'s sources and imports a verified copy of one', async () => {
  const { story, brief, notes, forged, mockup } = await releasedStory();
  const listed = flow(story, ['documents', 'list']).stdout;
  assert.match(listed, new RegExp(`Epic ${EPIC} sources not imported yet[\\s\\S]*${brief.sourceId}  Ledger brief \\(application/pdf\\)`));
  assert.match(listed, new RegExp(`${notes.sourceId}  Workshop notes`));
  assert.match(listed, new RegExp(`failed verification[\\s\\S]*${forged.sourceId}  Old notes: its record does not match the hash the Epic manifest pins`));

  flow(story, ['documents', 'fetch', '--provider', 'epic', '--ref', brief.sourceId]);
  flow(story, ['documents', 'fetch', '--provider', 'epic', '--ref', notes.sourceId.toLowerCase(), '--name', 'Epic workshop notes', '--phases', 'intake']);
  const workflow = JSON.parse(await readFile(path.join(story, 'singularity/work-items/APP-1/workflow.json'), 'utf8'));
  const documents = JSON.parse(flow(story, ['documents', 'list', '--json']).stdout).filter((item) => item.id?.startsWith('DOC-'));
  assert.deepEqual(documents.map((item) => [item.id, item.name, item.remote?.source, item.remote?.objectId]), [
    ['DOC-001', 'Ledger brief', 'epic-source', brief.sourceId],
    ['DOC-002', 'Epic workshop notes', 'epic-source', notes.sourceId]
  ]);
  assert.equal(documents[0].remote.epicId, EPIC);
  assert.equal(documents[0].remote.commit, workflow.workItem.baseCommit);
  assert.deepEqual(documents[1].phases, ['intake']);
  assert.deepEqual(await readFile(path.join(story, documents[0].path)), PDF);
  assert.equal(await readFile(path.join(story, documents[1].path), 'utf8'), 'Workshop: show the ledger total first.\n');
  assert.equal(documents[0].sha256, brief.sha256);

  const after = flow(story, ['documents', 'list']).stdout;
  assert.doesNotMatch(after, new RegExp(`  ${brief.sourceId}  `), 'an imported source is no longer offered');
  assert.match(after, new RegExp(`${mockup.sourceId}  Checkout mockup`));

  const swapped = flow(story, ['documents', 'fetch', '--provider', 'epic', '--ref', mockup.sourceId], { allowFailure: true });
  assert.notEqual(swapped.status, 0);
  assert.match(swapped.stderr, /does not match the SHA-256 the Epic pins, so it was not imported/);
  const tampered = flow(story, ['documents', 'fetch', '--provider', 'epic', '--ref', forged.sourceId], { allowFailure: true });
  assert.match(tampered.stderr, /cannot be imported: its record does not match the hash the Epic manifest pins/);
  const unknown = flow(story, ['documents', 'fetch', '--provider', 'epic', '--ref', 'SRC-000000000000'], { allowFailure: true });
  assert.match(unknown.stderr, new RegExp(`has no active source 'SRC-000000000000'\\. Its sources: .*${notes.sourceId} \\(Workshop notes\\)`));
  assert.equal(JSON.parse(flow(story, ['documents', 'list', '--json']).stdout).filter((item) => item.id?.startsWith('DOC-')).length, 2,
    'refused imports add nothing');
  assert.match(flow(story, ['gate'], { allowFailure: true }).stdout, /document integrity: 2 supporting inputs/);
  // The editor reads the same view to offer what is left to import.
  const browsed = JSON.parse(flow(story, ['documents', 'browse', '--provider', 'epic', '--json']).stdout);
  assert.equal(browsed.epicId, EPIC);
  assert.equal(browsed.commit, workflow.workItem.baseCommit);
  assert.deepEqual(browsed.entries.map((entry) => [entry.id, entry.name, entry.imported]).sort(), [
    [brief.sourceId, 'Ledger brief', true], [mockup.sourceId, 'Checkout mockup', false], [notes.sourceId, 'Workshop notes', true]
  ].sort());
  assert.deepEqual(browsed.rejected.map((entry) => entry.sourceId), [forged.sourceId]);
});
