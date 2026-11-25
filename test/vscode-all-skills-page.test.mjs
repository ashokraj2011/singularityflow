/**
 * VS Code's All skills page [owner, 2026-11-25]: the engine's `skill catalog` answer as a summary, filters, a sortable
 * table and a detail row per skill, whose actions name a row and reuse Workflow Studio's own routes.
 *
 * The page is rendered from a real answer of the engine's pure analysis (src/skill-catalog.mjs), so the two cannot drift;
 * its script's pure parts run here in a bare context, as the page runs them.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import YAML from 'yaml';

import { ALL_SKILLS_SCRIPT, allSkillsPageHtml, libraryWords, skillCatalogFrom } from '../apps/vscode/src/views/all-skills-page.ts';
import { analyzeSkillCatalog, unapprovedMarketplaces } from '../src/skill-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = YAML.parse(readFileSync(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
const source = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');

function engineAnswer() {
  const skill = (name, version, extra = {}) => ({ name, version, description: `${name} does its work.`, tags: [], pdlcTasks: [], lifecycleState: 'approved', ...extra });
  return JSON.parse(JSON.stringify(analyzeSkillCatalog({
    library: [
      { id: 'web-playwright-tests', label: 'Web Playwright tests', description: 'Generate Playwright end-to-end tests for web pages, reusing page objects.', tags: ['task:e2e-testing', 'web', 'playwright'] },
      { id: 'requirements-writer', label: 'Requirements writer', description: 'Turn a brief into numbered requirements <script>alert(1)</script>.', tags: ['task:requirements-analysis'] }
    ],
    imports: { 'library-skill:requirements-writer': { kind: 'library-skill', source: { kind: 'marketplace-skill', marketplace: 'acme', version: '1.0.0', commit: 'f'.repeat(40) } } },
    marketplaces: [
      { id: 'acme', label: 'Acme', kind: 'repository', warning: null, skills: [
        skill('web-e2e-test-generation', '1.0.0', { description: 'Generate Playwright end-to-end tests for web pages, reusing the page objects.', tags: ['web', 'playwright'], pdlcTasks: ['e2e-testing'] }),
        skill('web-xray-creation', '1.0.0', { tags: ['web', 'xray'], pdlcTasks: ['test-case-creation'], lifecycleState: 'proposed' }),
        skill('requirements-writer', '1.2.0', { pdlcTasks: ['requirements-analysis'] })] },
      { id: 'broken', label: 'Old catalog', kind: 'repository', warning: 'Marketplace Old catalog (broken) could not be read, so its skills are not listed.', skills: [] }
    ],
    definition: structuredClone(BASE),
    kinds: ['web'],
    uses: new Map([['web-playwright-tests', { agents: [{ id: 'developer', label: 'Developer', steps: ['implementation'] }], workflows: [] }]]),
    stories: [{ workId: 'TASK-4', kind: 'fix', skills: [{ id: 'web-playwright-tests', steps: ['implementation'] }] }]
  })));
}

test('the engine\'s answer is read field by field, and anything else is no catalog', () => {
  assert.equal(skillCatalogFrom(null), null);
  assert.equal(skillCatalogFrom({ resultType: 'skill-master', skills: [] }), null);
  const catalog = skillCatalogFrom(engineAnswer());
  assert.deepEqual(catalog.rows.map((row) => row.key), ['library:requirements-writer', 'library:web-playwright-tests',
    'market:acme/requirements-writer', 'market:acme/web-e2e-test-generation', 'market:acme/web-xray-creation']);
  const odd = skillCatalogFrom({ resultType: 'skill-catalog', rows: [{ key: 'library:x', id: 'x', intents: 'code', usedBy: null, pickedBy: [{ kind: 'fix' }] }, { id: 'no-key' }] });
  assert.deepEqual([odd.rows.length, odd.rows[0].intents, odd.rows[0].usedBy.agents, odd.rows[0].pickedBy[0].steps, odd.rows[0].source], [1, [], [], [], 'marketplace']);
  const newer = catalog.rows.find((row) => row.key === 'market:acme/requirements-writer');
  assert.equal(libraryWords(newer), 'Yes (1.0.0) · newer: 1.2.0');
  assert.equal(libraryWords(catalog.rows.find((row) => row.key === 'market:acme/web-xray-creation')), 'No');
});

test('the page shows the summary, the filters, one row and one detail per skill, with no commit, hash or root data attribute', () => {
  const catalog = skillCatalogFrom(engineAnswer());
  const html = allSkillsPageHtml({ catalog, busy: false, error: null, notice: null });
  assert.match(html, /^<main class="ask" id="ask-root">/u, 'the root carries no data-* attribute: a root data-mode once swallowed every click');
  assert.doesNotMatch(html.match(/^<main[^>]*>/u)[0], /data-/u);
  assert.doesNotMatch(html, /\b[0-9a-f]{40}\b/u, 'no commit');
  assert.doesNotMatch(html, /<script>alert/u, 'every engine word is escaped');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  // The summary: counts, sources (one not read), the steps the library does not cover, and the look-alikes.
  assert.match(html, /<strong>5<\/strong><span>skills<\/span>/u);
  assert.match(html, /<strong>1<\/strong><span>look alike<\/span>/u);
  assert.match(html, /Old catalog: <span class="ask-warn">not read<\/span>/u);
  assert.match(html, /could not be read, so its skills are not listed/u, 'the warning is shown');
  assert.match(html, /No skill in the library or a trusted marketplace is for design steps for a web app\./u);
  assert.match(html, /web-playwright-tests and web-e2e-test-generation are both for code steps for a web app/u);
  // The filters each filter by what the engine says.
  for (const id of ['ask-search', 'ask-source', 'ask-lifecycle', 'ask-intent', 'ask-kind', 'ask-missing', 'ask-newer', 'ask-overlap']) assert.match(html, new RegExp(`id="${id}"`, 'u'), id);
  assert.match(html, /<option value="acme">Acme<\/option>/u);
  assert.doesNotMatch(html, /<option value="broken">/u, 'a marketplace not read offers no filter');
  assert.match(html, /<option value="proposed">proposed<\/option>/u);
  assert.match(html, /<option value="code">code<\/option>/u);
  assert.match(html, /<option value="web">Web app<\/option>/u);
  for (const sort of ['name', 'source', 'lifecycle', 'intent', 'library', 'used']) assert.match(html, new RegExp(`data-sort="${sort}"`, 'u'), sort);
  assert.equal((html.match(/<tr class="ask-row"/gu) ?? []).length, 5);
  assert.equal((html.match(/<tr class="ask-detail"[^>]* hidden>/gu) ?? []).length, 5, 'each detail starts closed');
  // Detail: what it is for, who picks it, who uses it, and the actions each row may take.
  assert.match(html, /A fix task uses it in its code step\./u);
  assert.match(html, /Agent Developer in implementation/u);
  assert.match(html, /Task TASK-4 \(fix\) in implementation/u);
  assert.match(html, /data-preview="market:acme\/web-e2e-test-generation"[^>]*>Preview and add<\/button>/u);
  assert.match(html, /data-preview="market:acme\/requirements-writer"[^>]*>Preview the newer version<\/button>/u);
  assert.doesNotMatch(html, /data-preview="library:/u, 'a library skill is not previewed for import');
  assert.match(html, /data-open="library:web-playwright-tests">Open in Skill master<\/button>/u);
  assert.match(html, /data-open="market:acme\/requirements-writer">Open in Skill master<\/button>/u, 'a marketplace skill the library has opens the library copy');
  assert.doesNotMatch(html, /data-open="market:acme\/web-xray-creation"/u);
  // Busy, failed and empty.
  assert.match(allSkillsPageHtml({ catalog: null, busy: true, error: null, notice: null }), /Reading the library and the trusted marketplaces/u);
  assert.match(allSkillsPageHtml({ catalog: null, busy: false, error: 'Git could not read it.', notice: null }), /role="alert">Git could not read it\./u);
  assert.match(allSkillsPageHtml({ catalog: skillCatalogFrom({ resultType: 'skill-catalog', rows: [] }), busy: false, error: null, notice: null }), /No skills yet/u);
});

test('the page script filters and sorts as a person asks, without a document, and is a raw string', () => {
  assert.doesNotMatch(ALL_SKILLS_SCRIPT, /\$\{/u, 'a raw template must not interpolate');
  assert.doesNotMatch(ALL_SKILLS_SCRIPT, /`/u, 'no backtick can end the raw string early');
  assert.doesNotMatch(ALL_SKILLS_SCRIPT, /<\/script/iu);
  const window = {};
  runInNewContext(ALL_SKILLS_SCRIPT, { window });
  const { factsOf, matches, compareRows } = window.__allSkills;
  const html = allSkillsPageHtml({ catalog: skillCatalogFrom(engineAnswer()), busy: false, error: null, notice: null });
  // The rows as the page reads them: each <tr>'s data attributes, as the DOM's dataset names them.
  const rows = [...html.matchAll(/<tr class="ask-row"([^>]*)>/gu)].map((match) => factsOf(Object.fromEntries([...match[1].matchAll(/data-([a-z-]+)="([^"]*)"/gu)]
    .map(([, name, value]) => [name.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase()), value.replace(/&amp;/gu, '&').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>')]))));
  const keys = (filters) => rows.filter((row) => matches(row, filters)).map((row) => row.key);
  assert.equal(keys({}).length, 5);
  assert.deepEqual(keys({ source: 'library' }), ['library:requirements-writer', 'library:web-playwright-tests']);
  assert.deepEqual(keys({ lifecycle: 'proposed' }), ['market:acme/web-xray-creation']);
  assert.deepEqual(keys({ intent: 'code' }), ['library:web-playwright-tests', 'market:acme/web-e2e-test-generation']);
  assert.deepEqual(keys({ kind: 'any' }), ['library:requirements-writer', 'market:acme/requirements-writer']);
  assert.deepEqual(keys({ missing: true }), ['market:acme/web-e2e-test-generation', 'market:acme/web-xray-creation']);
  assert.deepEqual(keys({ newer: true }), ['library:requirements-writer', 'market:acme/requirements-writer']);
  assert.deepEqual(keys({ overlap: true }), ['library:web-playwright-tests', 'market:acme/web-e2e-test-generation']);
  assert.deepEqual(keys({ search: 'PLAYWRIGHT pages' }), ['library:web-playwright-tests', 'market:acme/web-e2e-test-generation']);
  assert.deepEqual(keys({ source: 'acme', missing: true, intent: 'requirements' }), ['market:acme/web-xray-creation']);
  const sorted = (sort) => [...rows].sort((left, right) => compareRows(left, right, sort)).map((row) => row.name);
  assert.deepEqual(sorted({ by: 'name' }), ['requirements-writer', 'requirements-writer', 'web-e2e-test-generation', 'web-playwright-tests', 'web-xray-creation']);
  assert.deepEqual(sorted({ by: 'name', descending: true }).at(0), 'web-xray-creation');
  assert.deepEqual(sorted({ by: 'intent' }).slice(0, 3), ['requirements-writer', 'requirements-writer', 'web-xray-creation']);
  assert.deepEqual(sorted({ by: 'library' }).slice(-2), ['web-e2e-test-generation', 'web-xray-creation'], 'not in the library last');
  assert.deepEqual(sorted({ by: 'used' })[0], 'web-playwright-tests');
  assert.deepEqual(sorted(null), rows.map((row) => row.name), 'unsorted keeps the engine\'s order');
});

test('the host takes a row\'s key, never a reference or a command, and opens Workflow Studio\'s own routes', () => {
  const host = source('apps/vscode/src/views/all-skills.ts');
  assert.match(host, /registerMessageRouter\('singularityFlow\.allSkills', \{/u);
  for (const type of ['allSkills.refresh', 'allSkills.preview', 'allSkills.open', 'allSkills.skillMaster']) assert.ok(host.includes(`'${type}'`), type);
  assert.doesNotMatch(host, /stringField\(message, '(?:reference|command|path|url)'\)/u);
  assert.match(host, /this\.client\.run\(\['skill', 'catalog', '--json'\]\)/u);
  assert.match(host, /'singularityFlow\.openWorkflowStudio',\s*\{ view: 'library', preview: \{ reference: row\.actions\.reference, replace: row\.inLibrary \} \}/u);
  assert.match(host, /'singularityFlow\.openWorkflowStudio', \{ view: 'skills', skill: row\.id \}/u);
  // Studio checks what it is asked to open, and its page previews the skill for the skill master or searches for it.
  const studio = source('apps/vscode/src/views/workflow-studio.ts');
  assert.match(studio, /MARKET_SKILL_REFERENCE = \/\^market:/u);
  assert.match(studio, /'studio\.allSkills': \(\) => vscode\.commands\.executeCommand\('singularityFlow\.allSkills'\)/u);
  const studioPage = source('apps/vscode/src/views/workflow-studio-page.ts');
  assert.match(studioPage, /skillLibrary\.as = 'library-skill';[^\n]*\n\s*state\.view = 'library'; state\.returnTo = null; previewImport\(message\.preview\.reference, 'library-skill', null\);/u);
  assert.match(studioPage, /message\.view === 'skills' && typeof message\.skill === 'string'\) \{ state\.searches\.skills = message\.skill;/u);
  assert.match(studioPage, /button\('All skills', function \(\) \{ post\(\{ type: 'studio\.allSkills' \}\); \}/u);
  // The command is registered, needs a repository and loads its panel lazily.
  const manifest = JSON.parse(source('apps/vscode/package.json'));
  assert.ok(manifest.contributes.commands.some((command) => command.command === 'singularityFlow.allSkills' && command.title === 'Singularity Flow: All Skills'));
  const extension = source('apps/vscode/src/extension.ts');
  assert.match(extension, /'singularityFlow\.lessons', 'singularityFlow\.allSkills',/u);
  assert.match(extension, /'singularityFlow\.allSkills': async \(\) => lazyPanels\(\)\.AllSkillsPanel\.show\(client\)/u);
  assert.match(source('apps/vscode/src/lazy-panels-runtime.ts'), /export \{ AllSkillsPanel \} from '\.\/views\/all-skills\.ts';/u);
});

test('a marketplace trusted only in the working copy is never shown as trusted: its row says it is not approved yet', () => {
  const approved = { acme: { id: 'acme', label: 'Acme', repository: '/srv/acme', commit: 'a'.repeat(40) } };
  const working = { shared: { id: 'shared', label: 'Shared catalog', index: 'https://catalog.example.org/index.json', allowedOrigins: [] },
    acme: { ...approved.acme, commit: 'b'.repeat(40) } };
  const unapproved = unapprovedMarketplaces(approved, working);
  assert.deepEqual(unapproved.map(({ id, change }) => [id, change]), [['acme', 'changed'], ['shared', 'added']]);
  assert.deepEqual(unapprovedMarketplaces(approved, approved), [], 'the same trust is nothing to say');
  const catalog = skillCatalogFrom(JSON.parse(JSON.stringify(analyzeSkillCatalog({ library: [], definition: structuredClone(BASE), kinds: [], unapproved,
    marketplaces: [{ id: 'acme', label: 'Acme', kind: 'repository', warning: null, skills: [] }] }))));
  assert.deepEqual(catalog.sources.map(({ id, read, approved: ok }) => [id, read, ok]), [['library', true, true], ['acme', true, true], ['shared', false, false]]);
  const html = allSkillsPageHtml({ catalog, busy: false, error: null, notice: null });
  assert.match(html, /<li>Shared catalog: <span class="ask-warn">not approved yet<\/span> <span class="ask-dim">Trusted only in your working copy of workflow\.yml, and not approved yet/u);
  assert.match(html, /<li>Acme: 0 skills <span class="ask-dim">Your working copy of workflow\.yml reads it elsewhere \(another commit or index\), and that is not approved yet/u);
  assert.doesNotMatch(html, /<option value="shared">/u, 'a source not approved is no filter choice');
});
