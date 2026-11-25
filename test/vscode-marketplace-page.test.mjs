/**
 * VS Code's Marketplace page [owner, 2026-11-25: "see what is installed in local and update, like an app store"]: the
 * engine's `marketplace catalog` answer as tabs per kind, search and filters, and one row per item with its status and
 * the buttons for that status, each opening Workflow Studio's own preview, conversion review, removal or archive.
 *
 * The page is rendered from a real answer of the engine's pure analysis (src/marketplace-catalog.mjs), so the two cannot
 * drift; its script's pure parts run here in a bare context, as the page runs them. No VS Code is launched.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { MARKETPLACE_SCRIPT, marketplaceCatalogFrom, marketplacePageHtml, studioTargetFor } from '../apps/vscode/src/views/marketplace-page.ts';
import { analyzeMarketplaceCatalog, indexItems, repositoryItems } from '../src/marketplace-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');

function engineAnswer({ templates = true } = {}) {
  return JSON.parse(JSON.stringify(analyzeMarketplaceCatalog({
    marketplaces: [
      { id: 'acme', label: 'Acme', kind: 'repository', commit: 'e'.repeat(40), warning: null, items: repositoryItems({
        skills: [
          { name: 'requirements-writer', version: '1.2.0', description: 'Numbered requirements <script>alert(1)</script>.', tags: ['ga'], lifecycleState: 'approved', sha256: '1'.repeat(64) },
          { name: 'web-e2e-test-generation', version: '1.0.0', description: 'Playwright tests for web pages.', tags: ['web'], lifecycleState: 'approved', sha256: '2'.repeat(64) },
          { name: 'web-xray-creation', version: '1.0.0', description: 'Xray test cases.', tags: ['web'], lifecycleState: 'proposed', sha256: '3'.repeat(64) }],
        agents: [
          { name: 'qa-agent', version: '1.1.0', description: 'QA automation.', tags: [], lifecycleState: 'approved', skills: [], text: 'qa', manifestSha256: '4'.repeat(64) },
          { name: 'product-agent', version: '1.0.0', description: 'Product elaboration.', tags: [], lifecycleState: 'approved', skills: [], text: 'product', manifestSha256: '5'.repeat(64) },
          { name: 'docs-agent', version: '1.0.0', description: 'Docs.', tags: [], lifecycleState: 'approved', skills: [], text: 'docs', manifestSha256: '6'.repeat(64) }] }) },
      { id: 'shared', label: 'Shared', kind: 'index', warning: null, items: indexItems({ entries: [
        ...(templates ? [{ id: 'release-notes', kind: 'template', version: '1.0.0', label: 'Release notes', sha256: '7'.repeat(64) }] : []),
        { id: 'reviewer', kind: 'agent', version: '1.0.0', label: 'Reviewer', sha256: '8'.repeat(64) },
        { id: 'nightly', kind: 'workflow', version: '1.0.0', label: 'Nightly checks' },
        { id: 'docs-server', kind: 'mcp-server', version: '1.1.0', label: 'Docs server', sha256: '9'.repeat(64) },
        { id: 'jira-server', kind: 'mcp-server', version: '1.0.0', label: 'Jira server', sha256: 'a'.repeat(64) },
        { id: 'lint-source', kind: 'generated', version: '1.0.0', label: 'Lint report', urlTemplate: 'https://catalog.example.org/{workId}.md', phase: 'design', target: 'artifacts/design/lint.md' }] }) }
    ],
    library: [{ id: 'requirements-writer', label: 'Requirements writer', tags: [] }, { id: 'web-e2e-test-generation', label: 'Web tests', tags: [] },
      { id: 'house-style', label: 'House style', description: 'Our naming rules.', tags: [] }],
    imports: {
      'library-skill:requirements-writer': { kind: 'library-skill', target: { id: 'requirements-writer' }, sha256: '0'.repeat(64),
        source: { kind: 'marketplace-skill', marketplace: 'acme', entry: 'requirements-writer', version: '1.0.0', commit: '9'.repeat(40) } },
      'library-skill:web-e2e-test-generation': { kind: 'library-skill', target: { id: 'web-e2e-test-generation' }, sha256: '2'.repeat(64),
        source: { kind: 'marketplace-skill', marketplace: 'acme', entry: 'web-e2e-test-generation', version: '1.0.0' } },
      'workflow:qa-flow': { kind: 'workflow', workflow: 'qa-flow', pieces: { agent: 'x', manifest: '4'.repeat(64), skills: {} },
        source: { kind: 'marketplace-agent', marketplace: 'acme', agent: 'qa-agent', version: '1.0.0' } },
      'workflow:docs-flow': { kind: 'workflow', workflow: 'docs-flow', pieces: {}, source: { kind: 'marketplace-agent', marketplace: 'acme', agent: 'docs-agent', version: '1.0.0' } },
      ...(templates ? { 'template:release-notes': { kind: 'template', target: { id: 'release-notes' }, sha256: '7'.repeat(64),
        source: { kind: 'marketplace', marketplace: 'shared', entry: 'release-notes', version: '1.0.0' } } } : {}),
      'mcp-server:docs-server': { kind: 'mcp-server', target: { id: 'docs-server', agents: ['architect'], phases: [] }, sha256: 'b'.repeat(64),
        source: { kind: 'marketplace', marketplace: 'shared', entry: 'docs-server', version: '1.0.0' } }
    },
    workflows: { 'qa-flow': { label: 'QA flow', archived: false }, 'docs-flow': { label: 'Docs flow', archived: true } },
    steps: { design: { label: 'Design', agent: 'architect' } },
    unapproved: [{ id: 'pending', label: 'Pending catalog', kind: 'index', change: 'added', words: 'Trusted only in your working copy.' }]
  })));
}

test('the engine\'s answer is read field by field, and anything else is no page', () => {
  assert.equal(marketplaceCatalogFrom(null), null);
  assert.equal(marketplaceCatalogFrom({ resultType: 'skill-catalog', rows: [] }), null);
  const catalog = marketplaceCatalogFrom(engineAnswer());
  assert.equal(catalog.items.length, engineAnswer().items.length);
  const odd = marketplaceCatalogFrom({ resultType: 'marketplace-catalog', items: [
    { key: 'market:a/skill/x', id: 'x', kind: 'skill', status: 'installed', tags: 'web', actions: { install: { command: 7 }, remove: { command: 'singularity-flow skill remove x --propose' } } },
    { key: 'market:a/skill/y', id: 'y', kind: 'gadget', status: 'installed' }, { id: 'no-key', kind: 'skill', status: 'installed' },
    { key: 'market:a/skill/z', id: 'z', kind: 'skill', status: 'upgraded' }] });
  assert.deepEqual([odd.items.length, odd.items[0].tags, Object.keys(odd.items[0].actions), odd.items[0].installedAs, odd.items[0].source], [1, [], ['remove'], null, 'marketplace']);
});

test('each status has its buttons, and each button is one of Workflow Studio\'s own routes', () => {
  const catalog = marketplaceCatalogFrom(engineAnswer());
  const item = (key) => catalog.items.find((entry) => entry.key === key);
  const routes = (key) => Object.fromEntries(['install', 'update', 'open', 'remove', 'approve'].map((act) => [act, studioTargetFor(act, item(key))?.studio ?? null])
    .filter(([, studio]) => studio));
  // Skills: a preview of the exact text into the skill master (a replacement for an update), Studio's Delete to remove.
  assert.deepEqual(routes('market:acme/skill/web-xray-creation'), { install: { view: 'library', preview: { reference: 'market:acme/web-xray-creation', replace: false } } });
  assert.deepEqual(routes('market:acme/skill/requirements-writer'), {
    update: { view: 'library', preview: { reference: 'market:acme/requirements-writer', replace: true } },
    open: { view: 'skills', skill: 'requirements-writer' }, remove: { view: 'skills', skill: 'requirements-writer', remove: true } });
  assert.deepEqual(routes('market:acme/skill/web-e2e-test-generation'), { open: { view: 'skills', skill: 'web-e2e-test-generation' },
    remove: { view: 'skills', skill: 'web-e2e-test-generation', remove: true } });
  assert.deepEqual(routes('here:library-skill:house-style'), { open: { view: 'skills', skill: 'house-style' }, remove: { view: 'skills', skill: 'house-style', remove: true } });
  // Agents: the conversion review makes the workflow or reviews its update; Archive removes it, Restore brings an archived one back.
  assert.deepEqual(routes('market:acme/agent/product-agent'), { install: { view: 'library', agentWorkflow: { target: 'acme/product-agent', update: false } } });
  assert.deepEqual(routes('market:acme/agent/qa-agent'), { update: { view: 'library', agentWorkflow: { target: 'acme/qa-agent', update: true } },
    open: { workflowId: 'qa-flow' }, remove: { retire: { action: 'archive', selector: 'story:qa-flow' } } });
  assert.deepEqual(routes('market:acme/agent/docs-agent'), { install: { retire: { action: 'restore', selector: 'story:docs-flow' } } });
  assert.deepEqual(routes('here:workflow:qa-flow'), routes('market:acme/agent/qa-agent'), 'a workflow here and its agent take the same routes');
  // An index's agent and template: their import preview, the Library's Remove; a workflow entry has none.
  assert.deepEqual(routes('market:shared/agent/reviewer'), { install: { view: 'library', preview: { reference: 'market:shared/reviewer', replace: false, as: 'agent' } } });
  assert.deepEqual(routes('market:shared/template/release-notes'), { open: { view: 'library' }, remove: { view: 'library', removeImport: 'template:release-notes' } });
  assert.deepEqual(routes('market:shared/workflow/nightly'), {});
  // An index's MCP server: Studio's preview, which asks which agents may use its tools; a generated source: Browse, where
  // Studio asks which agent fetches it. A generated source's update is its reviewed command, so it has no button.
  assert.deepEqual(routes('market:shared/mcp-server/jira-server'), { install: { view: 'library', preview: { reference: 'market:shared/jira-server', replace: false, as: 'mcp-server' } } });
  assert.deepEqual(routes('market:shared/mcp-server/docs-server'), { update: { view: 'library', preview: { reference: 'market:shared/docs-server', replace: true, as: 'mcp-server' } },
    open: { view: 'library' }, remove: { view: 'library', removeImport: 'mcp-server:docs-server' } });
  assert.deepEqual(routes('market:shared/generated/lint-source'), { install: { view: 'library', browse: 'shared' } });
  assert.match(studioTargetFor('install', item('market:shared/generated/lint-source')).notice, /choose Set up on Lint report, then publish\.$/u);
  assert.deepEqual(routes('marketplace:pending'), { approve: { view: 'changes' } });
  assert.match(studioTargetFor('install', item('market:acme/agent/product-agent')).notice, /^Workflow Studio shows the workflow product-agent becomes\./u);
});

test('the page shows tabs, filters and one row per item with its status, and no commit, hash or root data attribute', () => {
  const html = marketplacePageHtml({ catalog: marketplaceCatalogFrom(engineAnswer()), busy: false, error: null, notice: 'Workflow Studio shows it.' });
  assert.match(html, /^<main class="mkt" id="mkt-root">/u);
  assert.doesNotMatch(html.match(/^<main[^>]*>/u)[0], /data-/u, 'the root carries no data-* attribute: a root data-mode once swallowed every click');
  assert.doesNotMatch(html, /\b[0-9a-f]{40}\b|[0-9a-f]{64}/u, 'no commit and no hash');
  assert.doesNotMatch(html, /<script>alert/u, 'every engine word is escaped');
  assert.match(html, /role="status">Workflow Studio shows it\.<\/p>/u);
  // Tabs: one per kind, each with its panel; the template tab only when there is a template.
  assert.match(html, /<div class="mkt-tabs" role="tablist" aria-label="Kinds of item">/u);
  for (const kind of ['skill', 'agent', 'workflow', 'template']) {
    assert.match(html, new RegExp(`role="tab" id="mkt-tab-${kind}" data-tab="${kind}" aria-controls="mkt-panel-${kind}"`, 'u'), kind);
    assert.match(html, new RegExp(`role="tabpanel" id="mkt-panel-${kind}" aria-labelledby="mkt-tab-${kind}"`, 'u'), kind);
  }
  assert.doesNotMatch(marketplacePageHtml({ catalog: marketplaceCatalogFrom(engineAnswer({ templates: false })), busy: false, error: null, notice: null }), /mkt-tab-template/u);
  // An MCP server and a generated source each have a tab while one is listed.
  assert.match(html, /data-tab="mcp-server"[^>]*>MCP servers <span class="mkt-count">2<\/span>/u);
  assert.match(html, /data-tab="generated"[^>]*>Generated <span class="mkt-count">1<\/span>/u);
  assert.match(html, /aria-selected="true"\s+tabindex="0">Skills <span class="mkt-count">4<\/span> <span class="mkt-badge mkt-update-available" title="1 update available">1<\/span>/u);
  // Filters by what the engine says.
  for (const id of ['mkt-search', 'mkt-status', 'mkt-marketplace', 'mkt-lifecycle']) assert.match(html, new RegExp(`id="${id}"`, 'u'), id);
  assert.match(html, /<option value="update-available">Update available<\/option>/u);
  assert.match(html, /<option value="acme">Acme<\/option>/u);
  assert.match(html, /<option value="here">Only this repository<\/option>/u);
  assert.match(html, /<option value="proposed">proposed<\/option>/u);
  // A row: its status in words (never color alone), what it says, and the buttons for that status.
  const rowOf = (key) => html.match(new RegExp(`<tr class="mkt-row" data-key="${key.replace(/[/]/gu, '\\/')}"[\\s\\S]*?</tr>`, 'u'))?.[0] ?? '';
  const buttons = (key) => [...rowOf(key).matchAll(/data-act="([a-z]+)"/gu)].map((match) => match[1]);
  assert.match(rowOf('market:acme/skill/requirements-writer'), /<span class="mkt-badge mkt-update-available">Update available<\/span><div class="mkt-words">Marketplace Acme has version 1\.2\.0; version 1\.0\.0 is installed here\.<\/div>/u);
  assert.match(rowOf('market:acme/skill/requirements-writer'), /<td>1\.2\.0 \(here 1\.0\.0\)<\/td>/u);
  assert.deepEqual(buttons('market:acme/skill/requirements-writer'), ['update', 'open', 'remove']);
  assert.deepEqual(buttons('market:acme/skill/web-e2e-test-generation'), ['open', 'remove']);
  assert.deepEqual(buttons('market:acme/skill/web-xray-creation'), ['install']);
  assert.deepEqual(buttons('here:library-skill:house-style'), ['open', 'remove']);
  assert.match(rowOf('here:library-skill:house-style'), /<span class="mkt-badge mkt-local-only">Only here<\/span>/u);
  assert.deepEqual(buttons('market:shared/workflow/nightly'), []);
  assert.match(rowOf('market:acme/skill/web-xray-creation'), /aria-label="Install web-xray-creation" title="Propose adding it to the skill library, reviewed like any change\.">Install…<\/button>/u);
  assert.match(rowOf('here:workflow:qa-flow'), /Made from agent qa-agent/u);
  // The marketplace not approved yet: above the tabs, with its way to the waiting change; never a tab row.
  assert.match(html, /<section class="mkt-pending" aria-label="Marketplaces not approved yet"><h2>Not approved yet<\/h2>[\s\S]*Pending catalog[\s\S]*data-act="approve" data-key="marketplace:pending">See waiting changes<\/button>/u);
  assert.doesNotMatch(html, /<tr class="mkt-row" data-key="marketplace:pending"/u);
  assert.match(html, /an install, update or removal shows here once its change is approved\./u);
  // Summary tiles: every status in words.
  for (const words of ['Update available', 'Installed', 'Not installed', 'Only here']) assert.match(html, new RegExp(`<span>${words}</span>`, 'u'), words);
  // Busy, failed and empty.
  assert.match(marketplacePageHtml({ catalog: null, busy: true, error: null, notice: null }), /Reading the trusted marketplaces and what is installed here/u);
  assert.match(marketplacePageHtml({ catalog: null, busy: false, error: 'Git could not read it.', notice: null }), /role="alert">Git could not read it\./u);
  const empty = marketplacePageHtml({ catalog: marketplaceCatalogFrom({ resultType: 'marketplace-catalog', items: [], sources: [] }), busy: false, error: null, notice: null });
  assert.match(empty, /This repository trusts no marketplace yet/u);
  assert.match(empty, /No workflow here was made from a marketplace agent yet/u);
});

test('the page script filters as a person asks, without a document, and is a raw string', () => {
  assert.doesNotMatch(MARKETPLACE_SCRIPT, /\$\{/u, 'a raw template must not interpolate');
  assert.doesNotMatch(MARKETPLACE_SCRIPT, /`/u, 'no backtick can end the raw string early');
  assert.doesNotMatch(MARKETPLACE_SCRIPT, /<\/script/iu);
  const window = {};
  runInNewContext(MARKETPLACE_SCRIPT, { window });
  const { factsOf, matches } = window.__marketplace;
  const html = marketplacePageHtml({ catalog: marketplaceCatalogFrom(engineAnswer()), busy: false, error: null, notice: null });
  const rows = [...html.matchAll(/<tr class="mkt-row"([^>]*)>/gu)].map((match) => factsOf(Object.fromEntries([...match[1].matchAll(/data-([a-z-]+)="([^"]*)"/gu)]
    .map(([, name, value]) => [name, value.replace(/&amp;/gu, '&').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>')]))));
  const keys = (filters, kind = 'skill') => rows.filter((row) => row.kind === kind && matches(row, filters)).map((row) => row.key);
  assert.deepEqual(keys({}), ['here:library-skill:house-style', 'market:acme/skill/requirements-writer', 'market:acme/skill/web-e2e-test-generation', 'market:acme/skill/web-xray-creation']);
  assert.deepEqual(keys({ status: 'update-available' }), ['market:acme/skill/requirements-writer']);
  assert.deepEqual(keys({ status: 'update-available' }, 'workflow'), ['here:workflow:qa-flow']);
  assert.deepEqual(keys({ marketplace: 'here' }), ['here:library-skill:house-style']);
  assert.deepEqual(keys({ lifecycle: 'proposed' }), ['market:acme/skill/web-xray-creation']);
  assert.deepEqual(keys({ search: 'PLAYWRIGHT web' }), ['market:acme/skill/web-e2e-test-generation']);
  assert.deepEqual(keys({ marketplace: 'acme', status: 'not-installed' }, 'agent'), ['market:acme/agent/docs-agent', 'market:acme/agent/product-agent']);
});

test('the host takes a row\'s key, never a reference or a command, and opens Workflow Studio\'s own routes', () => {
  const host = source('apps/vscode/src/views/marketplace.ts');
  assert.match(host, /registerMessageRouter\('singularityFlow\.marketplace', \{/u);
  for (const type of ['marketplace.refresh', 'marketplace.install', 'marketplace.update', 'marketplace.remove', 'marketplace.open', 'marketplace.approve',
    'marketplace.allSkills', 'marketplace.studio']) assert.ok(host.includes(`'${type}'`), type);
  assert.doesNotMatch(host, /stringField\(message, '(?:reference|command|path|url|target)'\)/u);
  assert.match(host, /this\.client\.run\(\['marketplace', 'catalog', '--json'\]\)/u);
  assert.match(host, /const target = item \? studioTargetFor\(act, item\) : null;/u);
  assert.match(host, /executeCommand\('singularityFlow\.openWorkflowStudio', target\.studio\)/u);
  // Coming back to the page after a button reads it again.
  assert.match(host, /onDidChangeViewState\(\(\) => \{\s*if \(this\.panel\.visible && this\.stale\) \{ this\.stale = false; this\.notice = null; void this\.load\(\); \}/u);
  // Studio checks what it is asked to open, and its page runs its own preview, review, removal, delete or archive.
  const studio = source('apps/vscode/src/views/workflow-studio.ts');
  assert.match(studio, /if \('agentWorkflow' in requested\)/u);
  assert.match(studio, /MARKETPLACE_AGENT\.test\(flow\.target\)/u);
  assert.match(studio, /IMPORT_KEY\.test\(requested\.removeImport\)/u);
  assert.match(studio, /STUDIO_AGENT_ID\.test\(requested\.browse\) \? \{ view: 'library', browse: requested\.browse \}/u);
  assert.match(studio, /preview\.as === 'mcp-server' \? \{ as: preview\.as \}/u);
  assert.match(studio, /WORKFLOW_SELECTOR\.test\(retire\.selector\)/u);
  assert.match(studio, /'studio\.marketplace': \(\) => vscode\.commands\.executeCommand\('singularityFlow\.marketplace'\)/u);
  const studioPage = source('apps/vscode/src/views/workflow-studio-page.ts');
  assert.match(studioPage, /previewAgentWorkflow\(message\.agentWorkflow\.target, message\.agentWorkflow\.target\.split\('\/'\)\[1\], \{\}, message\.agentWorkflow\.update === true\);/u);
  assert.match(studioPage, /queueImport\(\{ op: 'import\.remove', key: message\.removeImport \}/u);
  assert.match(studioPage, /if \(state\.draft\.skills && state\.draft\.skills\[message\.skill\]\) askRemoveSkill\(message\.skill\);/u);
  assert.match(studioPage, /retireWorkflow\(message\.retire\.action === 'restore' \? 'restore' : 'archive', message\.retire\.selector\);/u);
  assert.match(studioPage, /previewImport\(message\.preview\.reference, message\.preview\.as, null\);/u);
  assert.match(studioPage, /message\.preview\.as === 'mcp-server'\)\) \{/u);
  assert.match(studioPage, /post\(\{ type: 'studio\.marketplaceBrowse', id: browsed\.id \}\);/u);
  assert.equal((studioPage.match(/button\('Marketplace', function \(\) \{ post\(\{ type: 'studio\.marketplace' \}\); \}/gu) ?? []).length, 2, 'in the Library and the Skill master');
  // All skills links to it, and it to All skills: both pages stay.
  assert.match(source('apps/vscode/src/views/all-skills.ts'), /'allSkills\.marketplace': \(\) => vscode\.commands\.executeCommand\('singularityFlow\.marketplace'\)/u);
  assert.match(source('apps/vscode/src/views/all-skills-page.ts'), /data-marketplace title="[^"]+">Marketplace<\/button>/u);
  // The command is registered, needs a repository and loads its panel lazily.
  const manifest = JSON.parse(source('apps/vscode/package.json'));
  assert.ok(manifest.contributes.commands.some((command) => command.command === 'singularityFlow.marketplace' && command.title === 'Singularity Flow: Marketplace'));
  const extension = source('apps/vscode/src/extension.ts');
  assert.match(extension, /'singularityFlow\.allSkills', 'singularityFlow\.marketplace',/u);
  assert.match(extension, /'singularityFlow\.marketplace': async \(\) => lazyPanels\(\)\.MarketplacePanel\.show\(client\)/u);
  assert.match(source('apps/vscode/src/lazy-panels-runtime.ts'), /export \{ MarketplacePanel \} from '\.\/views\/marketplace\.ts';/u);
  // The page's read is a read for VS Code's command classes.
  assert.match(source('apps/vscode/src/cli/client.ts'), /if \(args\[0\] === 'marketplace'\) return \['list', 'browse', 'catalog'\]\.includes/u);
});
