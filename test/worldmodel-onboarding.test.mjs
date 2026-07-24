import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { ensureRepositoryWorldModelViews, initializeDefinition, loadDefinition } from '../src/config.mjs';
import { portfolioWorldModelViews, validatePortfolio } from '../src/initiative-config.mjs';
import { bootstrapDesktopPortfolio } from '../src/desktop.mjs';

const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout;
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wm-onboard-'));
  await mkdir(path.join(root, '.git'), { recursive: true });
  git(['init', '-b', 'main'], root);
  git(['config', 'user.name', 'Onboard Tester'], root);
  git(['config', 'user.email', 'onboard@example.com'], root);
  await initializeDefinition(root);
  return root;
}

async function stripWorldModel(root) {
  const file = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(file, 'utf8'));
  delete definition.worldModel;
  // Re-serialize with a distinctive comment we can assert survives a later self-heal edit.
  await writeFile(file, `# hand-authored config\n${YAML.stringify(definition)}`);
}

test('portfolioWorldModelViews returns the sorted union of initiative-phase views', async () => {
  const portfolio = validatePortfolio(YAML.parse(await readFile(path.join(packageRoot, 'templates/portfolio.yml'), 'utf8')));
  const views = portfolioWorldModelViews(portfolio);
  for (const view of ['business', 'architecture', 'development', 'testing', 'release', 'operations', 'security']) {
    assert.ok(views.includes(view), `expected union to include ${view}`);
  }
  assert.deepEqual(views, [...views].sort());
});

test('ensureRepositoryWorldModelViews declares missing views, preserves comments, and is idempotent', async () => {
  const root = await repository();
  await stripWorldModel(root);

  const declared = await ensureRepositoryWorldModelViews(root, ['business', 'security']);
  // The declared set covers both the requested views and every view the repo's own
  // phases/personas already reference, so loadDefinition stays valid.
  assert.ok(declared.includes('business') && declared.includes('security'));
  assert.ok(declared.includes('architecture'), 'repo-referenced views are included');
  assert.deepEqual(declared, [...declared].sort());
  const text = await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8');
  assert.match(text, /# hand-authored config/, 'existing comment is preserved');
  const definition = await loadDefinition(root);
  assert.deepEqual(definition.worldModel.views, declared);

  // Idempotent: already covered → no rewrite, returns the current declared set.
  const again = await ensureRepositoryWorldModelViews(root, ['business']);
  assert.deepEqual(again, declared);
});

test('portfolio bootstrap self-heals a repo with no worldModel block instead of failing', async () => {
  const root = await repository();
  await stripWorldModel(root);
  const portfolioFile = path.join(root, 'singularity/portfolio.yml');
  if (existsSync(portfolioFile)) await rm(portfolioFile);
  await writeFile(path.join(root, 'README.md'), '# Onboard\n');
  git(['add', '-A'], root);
  git(['commit', '-m', 'initialize'], root);

  const result = await bootstrapDesktopPortfolio(root, {
    approvalEmail: 'onboard@example.com',
    repository: { id: 'app', url: 'https://example.com/app.git' }
  });
  assert.equal(result.path, 'singularity/portfolio.yml');

  const definition = await loadDefinition(root);
  const portfolio = validatePortfolio(YAML.parse(await readFile(portfolioFile, 'utf8')));
  for (const view of portfolioWorldModelViews(portfolio)) {
    assert.ok(definition.worldModel.views.includes(view), `workflow.yml now declares ${view}`);
  }
});

test('bootstrap installs initiative templates missing from a repository initialized earlier', async () => {
  const root = await repository();
  await stripWorldModel(root);
  // Simulate a repository created before the initiatives/ templates shipped: the templates root
  // exists (so a directory-level copy-if-missing is skipped) but the subtree is absent.
  await rm(path.join(root, 'singularity/templates/initiatives'), { recursive: true, force: true });
  assert.ok(!existsSync(path.join(root, 'singularity/templates/initiatives')));
  const portfolioFile = path.join(root, 'singularity/portfolio.yml');
  if (existsSync(portfolioFile)) await rm(portfolioFile);
  await writeFile(path.join(root, 'README.md'), '# Templates\n');
  git(['add', '-A'], root);
  git(['commit', '-m', 'initialize'], root);

  await bootstrapDesktopPortfolio(root, {
    approvalEmail: 'onboard@example.com',
    repository: { id: 'app', url: 'https://example.com/app.git' }
  });

  // Every template the portfolio's phases reference now exists in the repository.
  const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
  const referenced = new Set();
  for (const phase of Object.values(portfolio.initiativePhases ?? {})) {
    for (const output of phase.outputs ?? []) if (output.template) referenced.add(output.template);
  }
  assert.ok(referenced.has('initiatives/epic/source-catalog.md'), 'fixture should reference the epic templates');
  for (const template of referenced) {
    assert.ok(existsSync(path.join(root, 'singularity/templates', template)), `missing template ${template}`);
  }
});
