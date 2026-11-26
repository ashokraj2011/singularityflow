/**
 * Every skill on one page [owner, 2026-11-25]: `skill catalog` lists the repository's skill library and each marketplace
 * it trusts, with what each skill is for, the /sf-task kinds that would pick it, whether the library has it and whether
 * its marketplace has a newer one, who uses it, the skills that look alike and the steps none covers.
 * The marketplaces are a local Git repository made from test/fixtures/sdlc-marketplace, a folder that does not exist,
 * and an index served from a fixture folder: nothing here uses a network.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';

import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { ALIKE, alikeness, analyzeSkillCatalog, skillCatalogLines, skillWords } from '../src/skill-catalog.mjs';
import { journeyRepository } from './helpers/route-follower.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = YAML.parse(readFileSync(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
const FIXTURE = path.join(ROOT, 'test/fixtures/sdlc-marketplace');

const librarySkill = (id, description, tags) => ({ id, label: id, description, tags, sha256: `${id}-bytes` });
const fixtureSkill = (name, version, overrides = {}) => {
  const own = YAML.parse(readFileSync(path.join(FIXTURE, 'skills', name, 'apm.yml'), 'utf8'));
  return { name, version: version ?? own.version, description: own.description, tags: own.tags, pdlcTasks: own['pdlc-tasks'], lifecycleState: own['lifecycle-state'], ...overrides };
};
const PLAYWRIGHT = librarySkill('web-playwright-tests',
  'Generate Playwright end-to-end tests in TypeScript from the test steps, reusing the existing page objects and accessible locators.', ['task:e2e-testing', 'web', 'playwright']);

function sample({ kinds = ['web'] } = {}) {
  return {
    library: [
      PLAYWRIGHT,
      librarySkill('house-style', 'Follow the team\'s naming and layout rules in new code.', ['task:api-implementation']),
      librarySkill('requirements-writer', 'Turn a feature brief into numbered requirements.', [])
    ],
    imports: { 'library-skill:requirements-writer': { kind: 'library-skill', source: { kind: 'marketplace-skill', marketplace: 'acme', entry: 'requirements-writer',
      version: '1.0.0', tasks: ['requirements-analysis'], tags: ['requirements', 'product', 'ga'], lifecycleState: 'approved' } } },
    marketplaces: [{ id: 'acme', label: 'Acme', kind: 'repository', warning: null, skills: [
      fixtureSkill('web-e2e-test-generation'), fixtureSkill('web-xray-creation'), fixtureSkill('android-xray-creation'),
      fixtureSkill('requirements-writer', '1.2.0')] }],
    definition: structuredClone(BASE),
    kinds,
    uses: new Map([['web-playwright-tests', { agents: [{ id: 'developer', label: 'Developer', steps: ['implementation'] }], workflows: [{ id: 'feature', steps: [] }] }]]),
    stories: [{ workId: 'TASK-4', kind: 'fix', skills: [{ id: 'web-playwright-tests', steps: ['implementation'] }] }]
  };
}

test('each skill is one row: where it comes from, what it is for, who it is for, whether the library has it', () => {
  const catalog = analyzeSkillCatalog(sample());
  assert.equal(catalog.resultType, 'skill-catalog');
  assert.deepEqual(catalog.rows.map((row) => row.key), [
    'library:house-style', 'library:requirements-writer', 'library:web-playwright-tests',
    'market:acme/android-xray-creation', 'market:acme/requirements-writer', 'market:acme/web-e2e-test-generation', 'market:acme/web-xray-creation']);
  const byKey = new Map(catalog.rows.map((row) => [row.key, row]));
  const e2e = byKey.get('market:acme/web-e2e-test-generation');
  // The fixture's generally available item [OMK §11].
  assert.deepEqual([e2e.source, e2e.marketplace, e2e.marketplaceLabel, e2e.version, e2e.lifecycle, e2e.readiness],
    ['marketplace', 'acme', 'Acme', '1.0.0-pdlc', 'ga', 'ready']);
  assert.deepEqual([e2e.intents, e2e.tasks, e2e.softwareKinds], [['code'], ['e2e-testing', 'ui-test-automation'], ['web']]);
  assert.deepEqual(e2e.tags, ['ga', 'playwright', 'test-automation', 'web']);
  assert.deepEqual([e2e.inLibrary, e2e.libraryVersion, e2e.newerVersion], [false, null, null]);
  assert.deepEqual(e2e.actions, { preview: 'singularity-flow import preview "market:acme/web-e2e-test-generation" --as skill --json', reference: 'market:acme/web-e2e-test-generation' });
  const proposed = byKey.get('market:acme/web-xray-creation');
  assert.deepEqual([proposed.lifecycle, proposed.readiness, proposed.intents], ['proposed', 'unreviewed', ['requirements']]);
  // The library's copy names where it came from, and both rows say its marketplace has a newer version.
  const imported = byKey.get('library:requirements-writer');
  assert.deepEqual([imported.marketplace, imported.version, imported.inLibrary, imported.newerVersion, imported.intents], ['acme', '1.0.0', true, '1.2.0', ['requirements']]);
  assert.deepEqual(imported.actions, { show: 'singularity-flow skill show requirements-writer' });
  const newer = byKey.get('market:acme/requirements-writer');
  assert.deepEqual([newer.inLibrary, newer.libraryVersion, newer.newerVersion], [true, '1.0.0', '1.2.0']);
  assert.equal(newer.actions.preview, 'singularity-flow import preview "market:acme/requirements-writer" --as skill --json', 'a newer version is previewed through the import');
  const same = analyzeSkillCatalog({ ...sample(), marketplaces: [{ ...sample().marketplaces[0], skills: [fixtureSkill('requirements-writer', '1.0.0')] }] });
  const current = same.rows.find((row) => row.key === 'market:acme/requirements-writer');
  assert.deepEqual([current.newerVersion, current.actions], [null, { show: 'singularity-flow skill show requirements-writer' }], 'the same version opens the library copy');
  // Who uses it: agents and workflows from the skill master, and the task Stories whose composition chose it.
  assert.deepEqual(byKey.get('library:web-playwright-tests').usedBy, {
    agents: [{ id: 'developer', label: 'Developer', steps: ['implementation'] }], workflows: [{ id: 'feature', steps: [] }],
    tasks: [{ workId: 'TASK-4', kind: 'fix', steps: ['implementation'] }] });
  assert.deepEqual(catalog.summary.bySource, { acme: 4, library: 3 });
  assert.deepEqual(catalog.summary.byLifecycle, { approved: 3, ga: 1, 'not marked': 2, proposed: 1 });
  assert.equal(catalog.summary.byIntent.code, 3);
  assert.deepEqual([catalog.summary.skills, catalog.summary.notInLibrary, catalog.summary.newerAvailable], [7, 3, 1]);
  assert.equal(catalog.repository.words, 'This repository is a web app.');
  assert.ok(!JSON.stringify(catalog).includes('-bytes'), 'no hash of a skill reaches the page');
  assert.deepEqual(analyzeSkillCatalog(sample()), catalog, 'the same skills and repository, the same page');
});

test('the /sf-task kinds that would pick a skill are the chooser\'s: the library first, a marketplace only for a step it has nothing for', () => {
  const catalog = analyzeSkillCatalog(sample());
  const byKey = new Map(catalog.rows.map((row) => [row.key, row]));
  const picked = (key) => byKey.get(key).pickedBy.map(({ kind, how, intents }) => [kind, how, intents.join(' ')]);
  // Every kind with a code step uses the library's web skill; the marketplace's is not offered beside it.
  assert.deepEqual(picked('library:web-playwright-tests'), [['fix', 'used', 'code'], ['feature', 'used', 'code'], ['change', 'used', 'code'],
    ['refactor', 'used', 'code'], ['tests', 'used', 'code'], ['chore', 'used', 'code']]);
  assert.equal(byKey.get('library:web-playwright-tests').pickedBy[0].words, 'A fix task uses it in its code step.');
  assert.deepEqual(picked('market:acme/web-e2e-test-generation'), []);
  // A skill for no kind of software is picked only when the person's words name it: no kind picks it on its own.
  assert.deepEqual(picked('library:house-style'), []);
  assert.deepEqual(picked('library:requirements-writer'), []);
  // The library has nothing for a web app's requirements step, so the marketplace's proposed skill is offered there.
  assert.deepEqual(picked('market:acme/web-xray-creation'), [['feature', 'new', 'requirements']]);
  assert.equal(byKey.get('market:acme/web-xray-creation').pickedBy[0].words, 'A feature task offers it for its requirements step; it is not in the library yet.');
  // A skill for another kind of software is never picked here.
  assert.deepEqual(picked('market:acme/android-xray-creation'), []);
  const mobile = analyzeSkillCatalog(sample({ kinds: ['mobile'] }));
  assert.deepEqual(mobile.rows.find((row) => row.key === 'market:acme/android-xray-creation').pickedBy.map((pick) => pick.kind), ['feature']);
  // A kind the team runs as its own workflow picks no skill, and says so.
  const used = analyzeSkillCatalog({ ...sample(), definition: Object.assign(structuredClone(BASE), { tasks: { use: { fix: 'chore' } } }) });
  assert.deepEqual(used.summary.tasksNotComposed.map((entry) => entry.kind), ['fix']);
  assert.match(used.summary.tasksNotComposed[0].why, /runs every fix task as the chore workflow/u);
});

test('skills that look alike share a step and a kind of software and most of their words; steps no skill covers are gaps', () => {
  const catalog = analyzeSkillCatalog(sample());
  assert.deepEqual(catalog.summary.overlaps.map((overlap) => overlap.skills), [['library:web-playwright-tests', 'market:acme/web-e2e-test-generation']]);
  const [overlap] = catalog.summary.overlaps;
  assert.deepEqual([overlap.intents, overlap.softwareKinds], [['code'], ['web']]);
  assert.ok(overlap.alike >= ALIKE.text * 100, `${overlap.alike}% alike`);
  assert.match(overlap.why, /^web-playwright-tests and web-e2e-test-generation are both for code steps for a web app, and their names, descriptions and tags share .*playwright.*\(\d+% alike\)\.$/u);
  assert.deepEqual(catalog.rows.find((row) => row.id === 'web-playwright-tests').overlaps, ['market:acme/web-e2e-test-generation']);
  // Xray for web and for Android read alike, but are for different kinds of software: not an overlap.
  const xray = alikeness(skillWords(fixtureSkill('web-xray-creation').description), skillWords(fixtureSkill('android-xray-creation').description));
  assert.ok(xray.score >= ALIKE.text, 'their words alone would say alike');
  assert.equal(catalog.summary.overlaps.some((entry) => entry.ids.includes('android-xray-creation')), false);
  // Names alone: most of their words shared.
  const named = analyzeSkillCatalog({ ...sample(), library: [...sample().library, librarySkill('web-e2e-test-writer', 'Writes browser checks.', ['task:e2e-testing', 'web'])] });
  const byName = named.summary.overlaps.find((entry) => entry.ids.includes('web-e2e-test-writer') && entry.ids.includes('web-e2e-test-generation'));
  assert.match(byName.why, /their names share e2e, test and web/u);
  // Coverage: each step intent this repository's workflow has, for a web app.
  const coverage = Object.fromEntries(catalog.summary.coverage.map((entry) => [entry.intent, entry.status]));
  assert.deepEqual(coverage, { intake: 'none', requirements: 'library', design: 'none', plan: 'none', code: 'library', test: 'none', review: 'none', release: 'none', report: 'none' });
  assert.deepEqual(catalog.summary.gaps.map((gap) => gap.intent), ['intake', 'design', 'plan', 'test', 'review', 'release', 'report']);
  assert.equal(catalog.summary.gaps[1].words, 'No skill in the library or a trusted marketplace is for design steps for a web app.');
  const onlyMarket = analyzeSkillCatalog({ ...sample(), library: [] });
  const requirements = onlyMarket.summary.coverage.find((entry) => entry.intent === 'requirements');
  assert.deepEqual([requirements.status, requirements.marketplace], ['marketplace', ['market:acme/requirements-writer', 'market:acme/web-xray-creation']]);
  assert.equal(requirements.words, 'Only a trusted marketplace has a skill for requirements steps for a web app: acme/requirements-writer and acme/web-xray-creation.');
  const lines = skillCatalogLines(catalog);
  assert.match(lines[0], /^7 skills: 3 in the library and 4 in marketplace acme\. This repository is a web app\.$/u);
  assert.ok(lines.includes('Skills that look alike:'));
  assert.ok(lines.some((line) => line.includes('web-xray-creation: version 1.0.0-pdlc, proposed, for requirements steps, on web, not in the library')));
});

/** The fixture marketplace as a Git repository of its own, read at the commit it is trusted at. */
async function marketplaceRepository(t) {
  const directory = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'sflow-catalog-market-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = path.join(directory, 'acme');
  await cp(FIXTURE, repository, { recursive: true });
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=Market Maintainer', '-c', 'user.email=maintainers@example.com', ...args], { cwd: repository, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'The marketplace');
  return { directory, repository, commit: git('rev-parse', 'HEAD') };
}

const INDEX = 'https://catalog.example.org/sflow-marketplace.json';
const WEB_PACKAGE = JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' }, dependencies: { react: '^18.3.1' } });
const skillText = (id, description, tags) => ['---', `name: ${id}`, `description: ${description}`, 'metadata:', `  sflow-tags: [${tags.join(', ')}]`, '---', '',
  '1. Do the work.', ''].join('\n');

test('skill catalog reads the library and every trusted marketplace once per commit; one it cannot read is a warning', async (t) => {
  const acme = await marketplaceRepository(t);
  const fixtures = path.join(acme.directory, 'served');
  await mkdir(path.join(fixtures, 'catalog.example.org'), { recursive: true });
  await writeFile(path.join(fixtures, 'catalog.example.org', 'sflow-marketplace.json'), JSON.stringify({ format: 'sflow-marketplace@1', name: 'Shared catalog', entries: [
    { id: 'a11y-review', kind: 'skill', version: '1.0.0', label: 'Accessibility review', description: 'Check a web change against WCAG.', tags: ['web', 'accessibility'],
      phases: ['conformance'], url: 'https://catalog.example.org/a11y-1.md', sha256: 'a'.repeat(64) },
    { id: 'a11y-review', kind: 'skill', version: '1.10.0', label: 'Accessibility review', description: 'Check a web change against WCAG 2.2 AA.', tags: ['web', 'accessibility'],
      phases: ['conformance'], url: 'https://catalog.example.org/a11y.md', sha256: 'b'.repeat(64) },
    { id: 'release-template', kind: 'template', version: '1.0.0', label: 'Release notes', url: 'https://catalog.example.org/release.md', sha256: 'c'.repeat(64) }] }));
  const missing = path.join(acme.directory, 'no-such-marketplace');
  const story = await journeyRepository(t, {
    env: { SINGULARITY_FLOW_TEST_REMOTE_FIXTURES: fixtures },
    files: {
      'package.json': WEB_PACKAGE,
      'singularity/skill-library/web-smoke-checks/SKILL.md': skillText('web-smoke-checks', 'Check each changed web page in a browser before the code step is handed in.', ['task:e2e-testing', 'web', 'playwright']),
      'singularity/skill-library/requirements-writer/SKILL.md': skillText('requirements-writer', 'Turn a feature brief into numbered requirements.', ['task:requirements-analysis']),
      'singularity/imports.lock.yml': YAML.stringify({ version: 1, imports: { 'library-skill:requirements-writer': { kind: 'library-skill', target: { id: 'requirements-writer' },
        source: { kind: 'marketplace-skill', marketplace: 'acme', repository: acme.repository, entry: 'requirements-writer', version: '0.9.0', tasks: ['requirements-analysis'], tags: ['requirements'], lifecycleState: 'approved' } } } }),
      'singularity/work-items/TASK-7/workflow.json': JSON.stringify({ schemaVersion: currentSchemaVersion('story-workflow'), workItem: { id: 'TASK-7', workType: 'task-fix' },
        resolution: { composition: { kind: 'fix', workType: 'task-fix', steps: [{ id: 'implementation', intent: 'code', label: 'Code' }], skills: [{ id: 'web-smoke-checks', steps: ['implementation'], sha256: 'd'.repeat(64) }] } } })
    },
    configure: (configuration) => {
      configuration.marketplaces = {
        acme: { label: 'Acme', repository: acme.repository, commit: acme.commit },
        broken: { label: 'Old catalog', repository: missing, commit: 'e'.repeat(40) },
        shared: { label: 'Shared', index: INDEX }
      };
    }
  });
  const catalog = JSON.parse(story.cli('skill', 'catalog', '--json'));
  assert.equal(catalog.resultType, 'skill-catalog');
  // The library holds the skills SFlow sets up with it, and this repository's two.
  const library = catalog.rows.filter((row) => row.source === 'library').map((row) => row.id);
  assert.ok(library.includes('web-smoke-checks') && library.includes('requirements-writer'), library.join(', '));
  assert.deepEqual(catalog.sources.map(({ id, kind, read, skills }) => [id, kind, read, skills]),
    [['library', 'library', true, library.length], ['acme', 'repository', true, 7], ['broken', 'repository', false, 0], ['shared', 'index', true, 1]]);
  const broken = catalog.sources.find((source) => source.id === 'broken');
  assert.match(broken.warning, /^Marketplace Old catalog \(broken\) could not be read: this computer could not reach .* with Git at the commit this repository trusts, so its skills are not listed\.$/u);
  assert.doesNotMatch(JSON.stringify(catalog), /\b[0-9a-f]{40}\b/u, 'no commit ID is shown to a person');
  assert.deepEqual(catalog.warnings, [broken.warning]);
  assert.deepEqual(catalog.repository.softwareKinds, ['web']);
  const byKey = new Map(catalog.rows.map((row) => [row.key, row]));
  // The index's newest version of each skill; its template is not a skill.
  const a11y = byKey.get('market:shared/a11y-review');
  assert.deepEqual([a11y.version, a11y.intents, a11y.softwareKinds, a11y.inLibrary, a11y.actions.reference], ['1.10.0', ['review'], ['web'], false, 'market:shared/a11y-review']);
  assert.equal(byKey.has('market:shared/release-template'), false);
  const imported = byKey.get('market:acme/requirements-writer');
  assert.deepEqual([imported.inLibrary, imported.libraryVersion, imported.newerVersion], [true, '0.9.0', '1.0.0-pdlc']);
  assert.equal(byKey.get('library:requirements-writer').newerVersion, '1.0.0-pdlc');
  assert.deepEqual(byKey.get('library:web-smoke-checks').usedBy.tasks, [{ workId: 'TASK-7', kind: 'fix', steps: ['implementation'] }]);
  assert.deepEqual(byKey.get('library:web-smoke-checks').pickedBy.map((pick) => pick.kind), ['fix', 'feature', 'change', 'refactor', 'tests', 'chore']);
  assert.equal(catalog.summary.coverage.find((entry) => entry.intent === 'review').status, 'marketplace');
  // The listing at the trusted commit is kept in the clone's Git folder: the marketplace is not read again.
  const kept = path.join(story.root, '.git', 'singularity-flow', 'task-marketplace-skills');
  const [file] = (await readdir(kept)).filter((name) => !name.startsWith('index-'));
  assert.equal(JSON.parse(await readFile(path.join(kept, file), 'utf8')).format, 'sflow-task-marketplace-skills/v3');
  await rm(acme.repository, { recursive: true, force: true });
  const again = JSON.parse(story.cli('skill', 'catalog', '--marketplace', 'acme', '--json'));
  assert.deepEqual(again.sources.map(({ id, read, skills }) => [id, read, skills]), [['library', true, library.length], ['acme', true, 7]], 'one marketplace, read from its kept listing');
  assert.deepEqual(again.rows.filter((row) => row.source === 'marketplace'), catalog.rows.filter((row) => row.marketplace === 'acme' && row.source === 'marketplace'));
  // In a terminal: plain lines, the warning among them.
  const text = story.cli('skill', 'catalog');
  assert.ok(text.startsWith(`${library.length + 8} skills: ${library.length} in the library, 7 in marketplace acme, none in marketplace broken (not read) and 1 in marketplace shared. This repository is a web app.\n`), text.split('\n')[0]);
  assert.match(text, /^Note: Marketplace Old catalog \(broken\) could not be read/mu);
  // Unknown marketplaces and forms are refused with the command that lists them all.
  const unknown = story.raw(['skill', 'catalog', '--marketplace', 'nope', '--json']);
  assert.notEqual(unknown.status, 0);
  assert.match(`${unknown.stdout}${unknown.stderr}`, /SKILL_CATALOG_MARKETPLACE_UNKNOWN/u);
  assert.match(`${unknown.stdout}${unknown.stderr}`, /It trusts acme, broken and shared\./u);
  const extra = story.raw(['skill', 'catalog', 'web-smoke-checks', '--json']);
  assert.notEqual(extra.status, 0);
  assert.match(`${extra.stdout}${extra.stderr}`, /SKILL_CATALOG_USAGE/u);
  assert.equal(story.git('status', '--porcelain'), '', 'reading the catalog writes nothing in the checkout');
});

test('skill catalog lists what the approved configuration trusts; a working-copy change not approved yet is said so on its row, never read', async (t) => {
  const acme = await marketplaceRepository(t);
  const empty = path.join(acme.directory, 'served-nothing');
  await mkdir(empty, { recursive: true });
  const story = await journeyRepository(t, {
    env: { SINGULARITY_FLOW_TEST_REMOTE_FIXTURES: empty },
    files: { 'package.json': WEB_PACKAGE },
    configure: (configuration) => { configuration.marketplaces = { acme: { label: 'Acme', repository: acme.repository, commit: acme.commit } }; }
  });
  // The approved configuration: sflow/config on the repository's remote, as main is now.
  story.git('push', '-q', 'origin', 'main:sflow/config');
  // This checkout's workflow.yml, not approved: it stops trusting acme, trusts an index, and has a skill of its own.
  const configuration = YAML.parse(await story.read('singularity/workflow.yml'));
  configuration.marketplaces = { shared: { label: 'Shared', index: INDEX } };
  await story.write('singularity/workflow.yml', YAML.stringify(configuration));
  await story.write('singularity/skill-library/web-smoke-checks/SKILL.md', skillText('web-smoke-checks', 'Check each changed web page in a browser.', ['task:e2e-testing', 'web']));
  const catalog = JSON.parse(story.cli('skill', 'catalog', '--json'));
  assert.deepEqual(catalog.sources.map(({ id, read, approved, skills }) => [id, read, approved, skills]),
    [['library', true, true, catalog.sources[0].skills], ['acme', true, true, 7], ['shared', false, false, 0]]);
  assert.equal(catalog.sources.find((source) => source.id === 'acme').notApproved,
    'Your working copy of workflow.yml stops trusting it, and that is not approved yet: Stories still use it.');
  assert.equal(catalog.sources.find((source) => source.id === 'shared').notApproved,
    'Trusted only in your working copy of workflow.yml, and not approved yet: Stories do not use it, so its skills are not read.');
  assert.deepEqual(catalog.warnings, [], 'the index trusted only here is never read');
  assert.ok(!catalog.rows.some((row) => row.marketplace === 'shared'));
  assert.ok(!catalog.rows.some((row) => row.id === 'web-smoke-checks'), 'the library Stories use, not this checkout\'s edit');
  const kept = path.join(story.root, '.git', 'singularity-flow', 'task-marketplace-skills');
  assert.ok(!(await readdir(kept)).some((name) => name.startsWith('index-')), 'no index listing was read or kept');
  const text = story.cli('skill', 'catalog');
  assert.match(text.split('\n')[0], /7 in marketplace acme and none in marketplace shared \(not approved yet\)\./u);
  assert.match(text, /^Note: marketplace shared: Trusted only in your working copy of workflow\.yml, and not approved yet/mu);
  const waiting = story.raw(['skill', 'catalog', '--marketplace', 'shared', '--json']);
  assert.notEqual(waiting.status, 0);
  assert.match(`${waiting.stdout}${waiting.stderr}`, /SKILL_CATALOG_MARKETPLACE_NOT_APPROVED/u);
  assert.match(`${waiting.stdout}${waiting.stderr}`, /singularity-flow configuration proposals/u);
});
