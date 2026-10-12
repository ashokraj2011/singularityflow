import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { constitutionPolicyChoices, renderStudioConstitution, studioConstitutions } from '../src/studio-constitution.mjs';
import { parseConstitution, constitutionPin, constitutionIndex } from '../src/constitution.mjs';
import { resolveWorkType, validateDefinition } from '../src/config.mjs';
import { buildStudioModel, planStudioChangeSet } from '../src/workflow-studio.mjs';
import { repositoryOwnedWorkflows } from './helpers/repository-owned-workflows.mjs';

const constitutionPath = 'singularity/constitution.md';
const packaged = YAML.parse(await readFile(new URL('../templates/workflow.yml', import.meta.url), 'utf8'));
function definition() {
  const raw = structuredClone(packaged);
  for (const workflow of Object.values(raw.workTypes)) workflow.constitution = { mode: 'off', path: constitutionPath };
  raw.workTypes['spec-driven-standard'].constitution.mode = 'enforce';
  return raw;
}
const judged = (id = 'ART-001', prose = 'Every delivery includes a rollback procedure.') => ({ id, type: 'judged', status: 'active', title: 'Recoverable delivery', level: 'must', evidenceRequired: true, prose });
const machine = (id = 'ART-002') => ({ id, type: 'enforced', status: 'active', title: 'Specification approval', policy: 'phases.specification.approval.minimum', prose: '' });
const editable = (article) => Object.fromEntries(Object.entries(article).filter(([key]) => ['id', 'type', 'status', 'policy', 'level', 'evidenceRequired', 'title', 'prose', 'withdrawnBy'].includes(key)));
function catalog(articles = [], text = null) {
  return { files: new Map([[constitutionPath, { path: constitutionPath, articles, text, problems: [] }]]) };
}
const render = (articles, before = catalog(), raw = definition()) => renderStudioConstitution({ path: constitutionPath, articles }, before, raw);

test('Studio seals both rule types with the existing engine and verifies effective machine values', () => {
  const raw = definition(); const resolution = resolveWorkType(validateDefinition(raw), 'spec-driven-standard');
  const text = render([judged(), machine()], catalog(), raw);
  const parsed = parseConstitution(text, { resolution, allowExample: false });
  assert.deepEqual(parsed.findings, []);
  assert.ok(parsed.articles.every(article => /^[a-f0-9]{64}$/.test(article.articleSha256)));
  assert.match(text, /Every delivery includes a rollback/);
  assert.match(text, /Effective value: 1/);
  assert.ok(constitutionPolicyChoices(resolution).every(choice => /^phases\.[\w-]+\.approval\.minimum$/.test(choice.path)));
  const again = render(parsed.articles.map(editable), catalog(parsed.articles, text), raw);
  assert.equal(again, text, 'an unchanged source round-trips without a replacement or resealing judged prose');
});

test('multiple machine articles with the same initial prose are generated under their own anchors', () => {
  const text = render([machine('ART-001'), { ...machine('ART-002'), policy: 'phases.implementation.approval.minimum' }]);
  const parsed = parseConstitution(text, { resolution: resolveWorkType(validateDefinition(definition()), 'spec-driven-standard') });
  assert.deepEqual(parsed.findings, []);
  assert.ok(parsed.articles[0].prose.includes('generated ART-001'));
  assert.ok(!parsed.articles[0].prose.includes('generated ART-002'));
  assert.ok(parsed.articles[1].prose.includes('generated ART-002'));
});

test('approved article meanings and IDs remain immutable; replacements retain withdrawn history and Story pins', () => {
  const original = render([judged()]); const articles = parseConstitution(original).articles;
  const before = catalog(articles, original);
  for (const changed of [
    { ...editable(articles[0]), prose: 'Changed rule' },
    { ...editable(articles[0]), title: 'Changed meaning' },
    { ...editable(articles[0]), level: 'should' },
    { ...editable(articles[0]), evidenceRequired: false }
  ]) assert.throws(() => render([changed], before), /immutable/);
  assert.throws(() => render([judged('ART-002')], before), /retained/);
  const constitution = { path: constitutionPath, fileSha256: 'b'.repeat(64), ...parseConstitution(original) };
  const pin = constitutionPin({ constitution, index: constitutionIndex(constitution), configurationCommit: 'a'.repeat(40) });
  const replacement = render([{ ...editable(articles[0]), status: 'withdrawn', withdrawnBy: 'ART-002' }, judged('ART-002', 'Every delivery names its rollback owner.')], before);
  const successor = parseConstitution(replacement).articles;
  assert.equal(successor[0].articleSha256, articles[0].articleSha256);
  assert.equal(successor[0].withdrawnBy, 'ART-002');
  assert.equal(successor[0].prose, articles[0].prose);
  assert.equal(pin.articles[0].status, 'active', 'old Story pin stays unchanged');
  assert.throws(() => render([{ ...editable(successor[0]), status: 'active' }, editable(successor[1])], catalog(successor, replacement)), /immutable/);
  const third = render([editable(successor[0]), { ...editable(successor[1]), status: 'withdrawn', withdrawnBy: 'ART-003' }, judged('ART-003', 'Explain rollback evidence and ownership.')], catalog(successor, replacement));
  const retained = parseConstitution(third).articles;
  assert.deepEqual(retained.map(article => article.withdrawnBy ?? null), ['ART-002', 'ART-003', null]);
  assert.equal(retained[0].articleSha256, articles[0].articleSha256);
});

test('unsafe paths, fake machine policies, collisions, nested anchors and malformed rules are refused', () => {
  for (const unsafe of ['../constitution.md', 'singularity/work-items/x/evidence/constitution.md', '/constitution.md', 'singularity\\constitution.md']) {
    assert.throws(() => renderStudioConstitution({ path: unsafe, articles: [judged()] }, catalog(), definition()), /portable Markdown/);
  }
  assert.throws(() => render([judged(), judged()]), /already used/);
  assert.throws(() => render([machine(), { ...judged(), id: 'lower-case' }]), /stable ID/);
  assert.throws(() => render([{ ...machine(), policy: 'made.up' }]), /supported machine/);
  assert.throws(() => render([{ ...machine(), prose: 'The model automatically proves every test.' }]), /generated, not authored/);
  assert.throws(() => render([{ ...judged(), prose: '## [ART-999] Hidden article\nRule' }]), /another article heading/);
  assert.throws(() => render([{ ...judged(), evidenceRequired: 'yes' }]), /true or false/);
  assert.throws(() => render([{ ...judged(), unreviewed: 'override' }]), /unsupported fields/);
  assert.throws(() => render([{ ...judged(), status: 'withdrawn', withdrawnBy: 'ART-999' }]), /replacement/);
  assert.throws(() => render([{ ...judged(), status: 'withdrawn', withdrawnBy: 'ART-002' }, { ...judged('ART-002'), status: 'withdrawn', withdrawnBy: 'ART-001' }]), /cycle/);
  assert.throws(() => render([]), /1–100/);
});

test('invalid workflow modes are visible diagnostics, not a crash or a silently reset policy', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-constitution-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const raw = definition(); raw.workTypes['spec-driven-standard'].constitution.mode = 'enfroce';
  const result = await studioConstitutions(root, raw);
  const file = result.files.get(constitutionPath);
  assert.equal(file.workflows.find(workflow => workflow.id === 'spec-driven-standard').mode, 'invalid');
  assert.ok(file.problems.some(message => message.includes('enfroce')));
  assert.equal(file.present, false);
});

test('article editing retains existing header comments, metadata and introductory guidance', () => {
  const source = render([judged()]).replace('articles:\n', '# Team approval guidance\ndescription: Our engineering rules\narticles:\n')
    .replace('# Constitution\n', '# Engineering constitution\n\nContact the architecture group before proposing an exception.\n');
  const before = catalog(parseConstitution(source).articles, source);
  const next = render([...before.files.get(constitutionPath).articles.map(editable), judged('ART-002', 'Explain operational ownership.')], before);
  assert.match(next, /# Team approval guidance/); assert.match(next, /description: Our engineering rules/);
  assert.match(next, /# Engineering constitution/); assert.match(next, /Contact the architecture group/);
  assert.deepEqual(parseConstitution(next).findings, []);
});

test('shared machine rules must agree across enabled workflows, but Off profiles do not constrain them', () => {
  const raw = definition();
  raw.workTypes['constitution-other'] = structuredClone(raw.workTypes['spec-driven-standard']);
  raw.workTypes['constitution-other'].phaseOverrides ||= {};
  raw.workTypes['constitution-other'].phaseOverrides.specification ||= {};
  raw.workTypes['constitution-other'].phaseOverrides.specification.approval = { group: 'product-approvers', minimum: 2 };
  assert.throws(() => render([machine()], catalog(), raw), /effective value.*changed|same effective value/s);
  raw.workTypes['constitution-other'].constitution.mode = 'off';
  assert.match(render([machine()], catalog(), raw), /Effective value: 1/);
});

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Constitution Tester' } });
  assert.equal(result.status, 0, result.stdout + result.stderr); return result.stdout;
}
async function repository(t, { owned = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-constitution-editor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Constitution Tester'], root); run('git', ['config', 'user.email', 'constitution@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Constitution editor\n');
  run(process.execPath, [new URL('../bin/singularity-flow.mjs', import.meta.url).pathname, 'init'], root);
  if (owned) await repositoryOwnedWorkflows(root);
  run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'fixture'], root);
  return root;
}
const changes = (model, items) => ({ schema: 'sflow-studio-change-set@1', base: model.base, changes: items });

test('a constitution and workflow applicability are checked and written atomically without touching Story data', async (t) => {
  const root = await repository(t); const model = await buildStudioModel(root);
  const mode = { op: 'constitution.policy', id: 'repo-spec-driven-standard', mode: 'enforce' };
  const ops = changes(model, [{ op: 'constitution.set', path: constitutionPath, articles: [judged()] }, mode]);
  assert.match(model.base.constitutionsSha256, /^[a-f0-9]{64}$/);
  const priorWorkflow = await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8');
  const dry = await planStudioChangeSet(root, ops);
  assert.equal(dry.valid, true, JSON.stringify(dry.problems));
  assert.equal(existsSync(path.join(root, constitutionPath)), false);
  assert.equal(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'), priorWorkflow);
  assert.deepEqual(dry.files.map(file => file.path).sort(), [constitutionPath, 'singularity/workflow.yml'].sort());
  const applied = await planStudioChangeSet(root, ops, { write: true });
  assert.equal(applied.valid, true, JSON.stringify(applied.problems));
  const fresh = await buildStudioModel(root); const file = fresh.constitutions.find(file => file.path === constitutionPath);
  assert.equal(file.present, true); assert.equal(file.articles[0].evidenceRequired, true);
  assert.equal(file.workflows.find(workflow => workflow.id === mode.id).mode, 'enforce');
  assert.ok(applied.written.every(file => !file.includes('work-items') && !file.includes('workflow.json')));
  const off = await planStudioChangeSet(root, changes(fresh, [{ ...mode, mode: 'off' }]));
  assert.equal(off.valid, true, JSON.stringify(off.problems));
  assert.deepEqual(off.files.map(file => file.path), ['singularity/workflow.yml'], 'Off never deletes the constitution');
  await writeFile(path.join(root, constitutionPath), (await readFile(path.join(root, constitutionPath), 'utf8')) + '\n');
  await assert.rejects(planStudioChangeSet(root, changes(fresh, [{ ...mode, mode: 'off' }])), /constitution changed since Studio loaded/);
  await assert.rejects(planStudioChangeSet(root, ops), error => error.code === 'STUDIO_BASE_CHANGED');
});

test('enabling a missing constitution and changing seeded settings fail closed; creating its file is allowed', async (t) => {
  const root = await repository(t, { owned: false }); const model = await buildStudioModel(root);
  const file = model.constitutions.find(file => file.path === constitutionPath);
  assert.ok(file.workflows.find(workflow => workflow.id === 'spec-driven-standard').editable === false);
  const policy = { op: 'constitution.policy', id: 'spec-driven-standard', mode: 'enforce' };
  const missing = await planStudioChangeSet(root, changes(model, [policy]));
  assert.equal(missing.valid, false); assert.match(missing.problems[0].message, /Define the constitution/);
  const seeded = await planStudioChangeSet(root, changes(model, [{ op: 'constitution.set', path: constitutionPath, articles: [judged()] }, policy]));
  assert.equal(seeded.valid, false); assert.match(JSON.stringify(seeded.problems), /seeded/i);
  const define = await planStudioChangeSet(root, changes(model, [{ op: 'constitution.set', path: constitutionPath, articles: [judged()] }]));
  assert.equal(define.valid, true, JSON.stringify(define.problems));
  assert.deepEqual(define.files.map(file => file.path), [constitutionPath]);
});

test('malformed, hand-edited and symlinked existing constitutions cannot be silently recreated', async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, constitutionPath), 'Broken frontmatter\n');
  let model = await buildStudioModel(root);
  const ops = [{ op: 'constitution.set', path: constitutionPath, articles: [judged()] }];
  assert.ok(model.constitutions.find(file => file.path === constitutionPath).problems.length);
  assert.equal((await planStudioChangeSet(root, changes(model, ops))).valid, false);
  const sealed = render([judged()]);
  await writeFile(path.join(root, constitutionPath), sealed.replace('Every delivery', 'Changed delivery'));
  model = await buildStudioModel(root);
  assert.equal((await planStudioChangeSet(root, changes(model, ops))).valid, false);
  await rm(path.join(root, constitutionPath));
  const outside = path.join(root, 'README.md');
  await symlink(outside, path.join(root, constitutionPath));
  const loaded = await studioConstitutions(root, YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8')));
  assert.ok(loaded.files.get(constitutionPath).problems.length, 'even an in-repository symlink must not alias unrelated bytes');
});
