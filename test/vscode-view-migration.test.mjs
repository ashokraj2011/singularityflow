/**
 * After a new build, VS Code offers once per repository to replace retired World Model view names:
 * a preview of the exact rewrite, the confirmed rewrite, then the configuration review to publish it.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { VIEW_MIGRATION_KEY, offerViewMigration, retiredViewNames, viewMigrationPreview } = await import(path.join(root, 'apps', 'vscode', 'src', 'view-migration.ts'));

const planned = {
  operation: 'wm-migrate-views', status: 'planned', dryRun: true, changes: 5, confirmation: 'MIGRATE 5 VIEWS abc123',
  files: [
    { path: 'singularity/workflow.yml', changes: [
      { location: 'worldModel.format', from: 'legacy-v3', to: 'registered-v4' },
      { location: 'worldModel.views', from: 'business', to: 'biz.rules' },
      { location: 'worldModel.views', from: 'release', to: null },
      { location: 'worldModel.views', from: null, to: 'dev.hotspots@4' }
    ] },
    { path: '.github/agents/architect.agent.md', changes: [{ location: 'sflow-world-model-views', from: 'architecture', to: 'arch.contracts' }] }
  ]
};

/** A host whose answers are scripted, recording what it was asked and run. */
function host({ answers = [], results = {}, memory = {} } = {}) {
  const calls = { run: [], inform: [], warn: [], documents: [], published: 0, log: [] };
  return {
    calls, memory,
    run: async (args) => {
      calls.run.push(args);
      const key = args.includes('--dry-run') ? 'dry' : 'confirm';
      const result = results[key];
      if (result instanceof Error) throw result;
      return result;
    },
    log: (line) => calls.log.push(line),
    inform: async (message, ...actions) => { calls.inform.push({ message, actions }); return answers.shift(); },
    warn: async (message) => { calls.warn.push(message); },
    showDocument: async (markdown) => { calls.documents.push(markdown); },
    publish: async () => { calls.published += 1; },
    remembered: (key) => memory[key],
    remember: async (key, value) => { memory[key] = value; }
  };
}

test('the retired names and the preview come from the dry run; format settings are not view names', () => {
  assert.deepEqual(retiredViewNames(planned), ['business', 'release', 'architecture']);
  const preview = viewMigrationPreview(planned);
  assert.match(preview, /5 references in 2 files would change in your working tree\. Nothing is published until you review and publish the change\./u);
  assert.match(preview, /\| worldModel\.views \| `business` \| `biz\.rules` \|/u);
  assert.match(preview, /\| worldModel\.views \| `release` \| removed \(no current view\) \|/u);
  assert.match(preview, /\| worldModel\.views \| — \| `dev\.hotspots@4` \(added\) \|/u);
  assert.match(preview, /## \.github\/agents\/architect\.agent\.md/u);
});

test('Preview, then Replace, rewrites with the dry run\'s confirmation and opens the review to publish', async () => {
  const migrated = { ...planned, status: 'migrated', applied: true, dryRun: undefined };
  const fake = host({ answers: ['Preview', 'Replace', 'Review & publish'], results: { dry: { data: planned }, confirm: migrated } });
  assert.equal(await offerViewMigration(fake, { repository: '/repo', build: 'b1' }), 'migrated');
  assert.deepEqual(fake.calls.run, [['wm', 'migrate-views', '--dry-run', '--json'], ['wm', 'migrate-views', '--confirm', 'MIGRATE 5 VIEWS abc123', '--json']]);
  assert.match(fake.calls.inform[0].message, /still names retired World Model views \(business, release, architecture\), which phase prompts ignore\. Replace them with the current views\?/u);
  assert.deepEqual(fake.calls.inform[0].actions, ['Replace', 'Preview', 'Not now']);
  assert.equal(fake.calls.documents.length, 1);
  assert.match(fake.calls.inform[2].message, /^Replaced 5 retired view references in 2 files in your working tree\. Review and publish the change so new Stories use it\.$/u);
  assert.equal(fake.calls.published, 1);
  assert.deepEqual(fake.memory[VIEW_MIGRATION_KEY], { '/repo': 'b1' });
});

test('it asks once per build and repository; Not now is remembered, and a new build asks again', async () => {
  const fake = host({ answers: ['Not now'], results: { dry: planned } });
  assert.equal(await offerViewMigration(fake, { repository: '/repo', build: 'b1' }), 'declined');
  assert.equal(await offerViewMigration(fake, { repository: '/repo', build: 'b1' }), 'skipped-recent');
  assert.equal(fake.calls.run.length, 1, 'no second dry run in the same build');
  fake.calls.inform.length = 0;
  assert.equal(await offerViewMigration(fake, { repository: '/other', build: 'b1' }), 'declined', 'another repository is asked');
  assert.equal(await offerViewMigration(fake, { repository: '/repo', build: 'b2' }), 'declined', 'a new build asks again');
  assert.equal(fake.calls.run.filter((args) => args.includes('--confirm')).length, 0, 'nothing is rewritten without Replace');
});

test('a current repository is not asked, the palette command says so, and failures are reported, not thrown', async () => {
  const current = host({ results: { dry: { status: 'current', changes: 0, files: [] } } });
  assert.equal(await offerViewMigration(current, { repository: '/repo', build: 'b1' }), 'current');
  assert.equal(current.calls.inform.length, 0);
  assert.equal(await offerViewMigration(current, { repository: '/repo', build: 'b1', force: true }), 'current');
  assert.match(current.calls.inform[0].message, /names no retired World Model views/u);

  const broken = host({ answers: ['Replace'], results: { dry: planned, confirm: new Error('WM_MIGRATE_VIEWS_INVALID') } });
  assert.equal(await offerViewMigration(broken, { repository: '/repo', build: 'b1' }), 'failed');
  assert.match(broken.calls.warn[0], /were not replaced: WM_MIGRATE_VIEWS_INVALID/u);
  const unreadable = host({ results: { dry: new Error('not governed') } });
  assert.equal(await offerViewMigration(unreadable, { repository: '/repo', build: 'b1' }), 'failed');
  assert.equal(unreadable.calls.warn.length, 0, 'the after-install pass only logs');
  assert.equal(await offerViewMigration(host(), { repository: null, build: 'b1' }), 'no-repository');
});

test('the extension offers it after the install checks and from the command palette', async () => {
  const extension = await readFile(path.join(root, 'apps', 'vscode', 'src', 'extension.ts'), 'utf8');
  assert.match(extension, /void productChecks\s*\.then\(\(\) => backgroundWork\.waitUntilIdle\(\{ signal: activationSignal \}\)\)\s*\.then\(\(\) => offerViewMigration\(viewMigrationHost, \{ repository: store\.current\.snapshot\?\.repository\?\.root \?\? client\.repository \?\? null, build: loadedBuild \}\)\)/u);
  assert.match(extension, /'singularityFlow\.migrateWorldModelViews': async \(\) => \{\s*const outcome = await offerViewMigration\(viewMigrationHost, \{[^}]*force: true \}\);/u);
  assert.match(extension, /publish: async \(\) => \{\s*await refreshAfterKnownMutation\(\);\s*return vscode\.commands\.executeCommand\('singularityFlow\.publishConfiguration'\);/u, 'the publish flow sees the rewritten files');
  assert.match(extension, /registerTextDocumentContentProvider\('sflow-view-migration'/u, 'the preview is read-only');
  const manifest = JSON.parse(await readFile(path.join(root, 'apps', 'vscode', 'package.json'), 'utf8'));
  assert.ok(manifest.contributes.commands.some((entry) => entry.command === 'singularityFlow.migrateWorldModelViews' && entry.title === 'Singularity Flow: Replace Retired World Model Views'));
});
