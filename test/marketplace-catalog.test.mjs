/**
 * The marketplace page, like an app store [owner, 2026-11-25]: `marketplace catalog` lists every item of every trusted
 * marketplace and what is installed here, each installed, with an update, not installed, only here or not approved
 * yet, with whole commands for preview, install, update and remove.
 * The marketplaces are a local Git repository made from test/fixtures/sdlc-marketplace and an index served from a
 * fixture folder: nothing here uses a network.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';

import { analyzeMarketplaceCatalog, CATALOG_STATUSES, indexItems, marketplaceCatalogLines, newerInNewest, repositoryItems } from '../src/marketplace-catalog.mjs';
import { journeyRepository } from './helpers/route-follower.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'test/fixtures/sdlc-marketplace');
const sha = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');
const fixtureText = (relative) => readFileSync(path.join(FIXTURE, relative), 'utf8');
const COMMIT = /\b[0-9a-f]{40}\b/u;

/** Every action is one whole command: SFlow's, with no placeholder left for a person to fill in. */
function assertWholeCommands(catalog) {
  for (const item of catalog.items) {
    for (const [name, step] of Object.entries(item.actions)) {
      assert.match(step.command, /^singularity-flow [a-z]/u, `${item.key} ${name}`);
      assert.doesNotMatch(step.command, /<|>|\.\.\.|…|\{|\}/u, `${item.key} ${name}: ${step.command}`);
      assert.ok(step.label.length > 10 && step.label.length <= 72, `${item.key} ${name}: ${step.label}`);
    }
  }
}

// ------------------------------------------------------------------------------------------------ pure

const PIECES = { agent: 'a'.repeat(64), manifest: 'b'.repeat(64), skills: { 'web-xray-creation': 'c'.repeat(64) } };
function sample() {
  return {
    marketplaces: [
      { id: 'acme', label: 'Acme', kind: 'repository', commit: 'e'.repeat(40), warning: null, items: repositoryItems({
        skills: [
          { name: 'requirements-writer', version: '1.2.0', description: 'Numbered requirements.', tags: ['requirements', 'ga'], pdlcTasks: ['requirements-analysis'], lifecycleState: 'approved', sha256: '1'.repeat(64) },
          { name: 'web-e2e-test-generation', version: '1.0.0', description: 'Playwright tests.', tags: ['web'], pdlcTasks: ['e2e-testing'], lifecycleState: 'approved', sha256: '2'.repeat(64) },
          { name: 'web-xray-creation', version: '1.0.0', description: 'Xray cases.', tags: ['web'], pdlcTasks: [], lifecycleState: 'proposed', sha256: 'c'.repeat(64) },
          { name: 'house-style', version: '2.0.0', description: 'A marketplace house style.', tags: [], pdlcTasks: [], lifecycleState: 'approved', sha256: '3'.repeat(64) }],
        agents: [
          { name: 'qa-agent', version: '1.1.0', description: 'QA.', tags: ['web'], lifecycleState: 'approved', skills: ['web-xray-creation'], text: 'agent text', manifestSha256: '6'.repeat(64) },
          { name: 'product-agent', version: '1.0.0', description: 'Product.', tags: [], lifecycleState: 'deprecated', skills: [], text: 'product text', manifestSha256: 'd'.repeat(64) }] }) },
      { id: 'shared', label: 'Shared', kind: 'index', warning: null, items: indexItems({ entries: [
        { id: 'a11y-review', kind: 'skill', version: '1.0.0', label: 'Accessibility review', tags: ['web'], sha256: '4'.repeat(64) },
        { id: 'a11y-review', kind: 'skill', version: '1.10.0', label: 'Accessibility review', tags: ['web'], sha256: '5'.repeat(64) },
        { id: 'release-notes', kind: 'template', version: '1.1.0', label: 'Release notes', sha256: '6'.repeat(64) },
        { id: 'reviewer', kind: 'agent', version: '1.0.0', label: 'Reviewer', sha256: '7'.repeat(64) },
        { id: 'nightly', kind: 'workflow', version: '1.0.0', label: 'Nightly checks', url: 'https://catalog.example.org/nightly.json', sha256: 'e'.repeat(64) },
        { id: 'docs-server', kind: 'mcp-server', version: '1.1.0', label: 'Docs server', sha256: '8'.repeat(64) },
        { id: 'jira-server', kind: 'mcp-server', version: '2.0.0', label: 'Jira server', sha256: '9'.repeat(64) },
        { id: 'lint-source', kind: 'generated', version: '1.0.0', label: 'Lint report', urlTemplate: 'https://catalog.example.org/lint/{workId}.md', phase: 'design', target: 'artifacts/design/lint.md' },
        { id: 'review-notes', kind: 'generated', version: '1.0.0', urlTemplate: 'https://catalog.example.org/review/{workId}.md', phase: 'review', target: 'artifacts/review/notes.md' },
        { id: 'deploy-log', kind: 'generated', version: '1.0.0', urlTemplate: 'https://catalog.example.org/deploy/{workId}.md', phase: 'deploy', target: 'artifacts/deploy/log.md' },
        { id: 'coverage', kind: 'generated', version: '1.0.0', urlTemplate: 'https://catalog.example.org/coverage/{workId}.md', phase: 'design', target: 'artifacts/design/coverage.md' }] }) },
      { id: 'broken', label: 'Old catalog', kind: 'repository', commit: 'f'.repeat(40), warning: 'Marketplace Old catalog (broken) could not be read, so its items are not listed.', items: [] }
    ],
    library: [{ id: 'requirements-writer', label: 'Requirements writer', description: 'Numbered requirements.', tags: [] },
      { id: 'web-e2e-test-generation', label: 'Web tests', description: '', tags: [] }, { id: 'house-style', label: 'House style', description: 'Our naming rules.', tags: [] },
      { id: 'old-checks', label: 'Old checks', description: '', tags: [] }, { id: 'broken-skill', label: 'Broken skill', description: '', tags: [] }],
    imports: {
      'library-skill:requirements-writer': { kind: 'library-skill', target: { id: 'requirements-writer' }, sha256: '0'.repeat(64),
        source: { kind: 'marketplace-skill', marketplace: 'acme', entry: 'requirements-writer', version: '1.0.0', commit: '9'.repeat(40) } },
      'library-skill:web-e2e-test-generation': { kind: 'library-skill', target: { id: 'web-e2e-test-generation' }, sha256: '2'.repeat(64),
        source: { kind: 'marketplace-skill', marketplace: 'acme', entry: 'web-e2e-test-generation', version: '1.0.0', commit: 'e'.repeat(40) } },
      'library-skill:old-checks': { kind: 'library-skill', target: { id: 'old-checks' }, sha256: '8'.repeat(64),
        source: { kind: 'marketplace-skill', marketplace: 'acme', entry: 'old-checks', version: '0.1.0' } },
      'library-skill:broken-skill': { kind: 'library-skill', target: { id: 'broken-skill' }, sha256: '8'.repeat(64),
        source: { kind: 'marketplace-skill', marketplace: 'broken', entry: 'broken-skill', version: '0.1.0' } },
      'skill:developer/web-xray-creation': { kind: 'skill', target: { agent: 'developer', id: 'web-xray-creation', phases: ['design'] }, sha256: 'c'.repeat(64),
        source: { kind: 'marketplace-skill', marketplace: 'acme', entry: 'web-xray-creation', version: '1.0.0' } },
      'workflow:qa-flow': { kind: 'workflow', workflow: 'qa-flow', pieces: { ...PIECES, agent: sha('agent text') },
        source: { kind: 'marketplace-agent', marketplace: 'acme', agent: 'qa-agent', version: '1.0.0', commit: '9'.repeat(40) } },
      'workflow:product-flow': { kind: 'workflow', workflow: 'product-flow', pieces: { agent: sha('product text'), manifest: 'd'.repeat(64), skills: {} },
        source: { kind: 'marketplace-agent', marketplace: 'acme', agent: 'product-agent', version: '1.0.0', commit: '9'.repeat(40) } },
      'workflow:legacy-flow': { kind: 'workflow', workflow: 'legacy-flow', pieces: PIECES,
        source: { kind: 'marketplace-agent', marketplace: 'retired', agent: 'legacy-agent', version: '0.5.0' } },
      'template:release-notes': { kind: 'template', target: { id: 'release-notes' }, sha256: '9'.repeat(64),
        source: { kind: 'marketplace', marketplace: 'shared', entry: 'release-notes', version: '1.0.0' } },
      'agent:house-reviewer': { kind: 'agent', target: { id: 'house-reviewer' }, sha256: '9'.repeat(64), source: { kind: 'url', url: 'https://example.org/reviewer.agent.md' } },
      'mcp-server:docs-server': { kind: 'mcp-server', target: { id: 'docs-server', agents: ['architect', 'developer'], phases: ['design'] }, sha256: '0'.repeat(64),
        source: { kind: 'marketplace', marketplace: 'shared', entry: 'docs-server', version: '1.0.0' } },
      'generated:architect/coverage': { kind: 'generated', target: { agent: 'architect', id: 'coverage', phase: 'design', path: 'artifacts/design/coverage.md' }, sha256: null,
        source: { kind: 'marketplace', marketplace: 'shared', entry: 'coverage', version: '1.0.0', urlTemplate: 'https://catalog.example.org/coverage/{workId}.md' } },
      'generated:developer/build-notes': { kind: 'generated', target: { agent: 'developer', id: 'build-notes', phase: 'design', path: 'artifacts/design/build.md' }, sha256: null,
        source: { kind: 'url', urlTemplate: 'https://example.org/build/{workId}.md' } }
    },
    workflows: { 'qa-flow': { label: 'QA flow', archived: false }, 'product-flow': { label: 'Product flow', archived: true },
      'legacy-flow': { label: 'Legacy flow', archived: false }, feature: { label: 'Feature', archived: false } },
    steps: { design: { label: 'Design', agent: 'architect' }, review: { label: 'Review', agent: null } },
    unapproved: [{ id: 'pending', label: 'Pending catalog', kind: 'index', change: 'added', words: 'Trusted only in your working copy.' }]
  };
}

test('each item says whether it is installed here, has an update, is not installed or is only here, with whole commands', () => {
  const catalog = JSON.parse(JSON.stringify(analyzeMarketplaceCatalog(sample())));
  assert.equal(catalog.resultType, 'marketplace-catalog');
  const byKey = new Map(catalog.items.map((item) => [item.key, item]));
  const status = (key) => byKey.get(key)?.status;
  // Skills: the same text is installed; another text or version is an update, and the row says which.
  assert.equal(status('market:acme/skill/web-e2e-test-generation'), 'installed');
  assert.equal(byKey.get('market:acme/skill/web-e2e-test-generation').statusWords, 'Installed here, the same as in marketplace Acme.');
  const newer = byKey.get('market:acme/skill/requirements-writer');
  assert.deepEqual([newer.status, newer.version, newer.installedVersion, newer.update.kind, newer.update.newer], ['update-available', '1.2.0', '1.0.0', 'version', true]);
  assert.equal(newer.update.words, 'Marketplace Acme has version 1.2.0; version 1.0.0 is installed here.');
  assert.equal(newer.actions.update.command,
    `singularity-flow import add "market:acme/requirements-writer" --as skill --id requirements-writer --sha256 ${'1'.repeat(64)} --replace --propose`);
  assert.equal(newer.actions.remove.command, 'singularity-flow skill remove requirements-writer --propose');
  assert.equal(newer.actions.preview.command, 'singularity-flow import preview "market:acme/requirements-writer" --as skill --json');
  assert.deepEqual(newer.installedAs, { as: 'library-skill', id: 'requirements-writer', importKey: 'library-skill:requirements-writer' });
  assert.deepEqual([newer.lifecycle, newer.readiness, newer.tags], ['approved', 'ready', ['ga', 'requirements']]);
  // A skill installed for one agent only, the same as the marketplace's: installed, removed from that agent.
  const forAgent = byKey.get('market:acme/skill/web-xray-creation');
  assert.deepEqual([forAgent.status, forAgent.installedAs.as, forAgent.installedAs.agent, forAgent.lifecycle, forAgent.readiness], ['installed', 'agent-skill', 'developer', 'proposed', 'unreviewed']);
  assert.equal(forAgent.actions.remove.command, 'singularity-flow imports remove skill:developer/web-xray-creation --propose');
  // The library's own skill of the same name is never replaced by a marketplace's: no install, and the row says why.
  const clash = byKey.get('market:acme/skill/house-style');
  assert.deepEqual([clash.status, clash.conflict.replaces, Object.keys(clash.actions)], ['not-installed', false, ['preview']]);
  assert.match(clash.statusWords, /has its own house-style, written in this repository/u);
  // Agents of a Git repository marketplace: installed as the workflow made from them, compared piece by piece.
  const qa = byKey.get('market:acme/agent/qa-agent');
  assert.deepEqual([qa.status, qa.installedAs.id, qa.installedAs.as, qa.update.kind], ['update-available', 'qa-flow', 'workflow', 'pieces']);
  assert.equal(qa.update.words, 'Its apm.yml changed in marketplace Acme; it is now version 1.1.0.');
  assert.deepEqual(Object.fromEntries(Object.entries(qa.actions).map(([name, step]) => [name, step.command])), {
    preview: 'singularity-flow workflow from-agent acme/qa-agent --update --review', update: 'singularity-flow workflow from-agent acme/qa-agent --update --propose',
    remove: 'singularity-flow workflow archive qa-flow --propose' });
  // An archived workflow is not installed; restoring it is its install.
  const product = byKey.get('market:acme/agent/product-agent');
  assert.deepEqual([product.status, product.installedAs.archived, product.actions.install.command, product.readiness],
    ['not-installed', true, 'singularity-flow workflow restore product-flow --propose', 'retired']);
  // The workflows here made from marketplace agents: each with its agent's state, and one whose marketplace is gone.
  const flow = byKey.get('here:workflow:qa-flow');
  assert.deepEqual([flow.kind, flow.status, flow.fromAgent, flow.update.words], ['workflow', 'update-available', { marketplace: 'acme', agent: 'qa-agent' }, qa.update.words]);
  assert.deepEqual(Object.keys(flow.actions), ['preview', 'update', 'remove']);
  assert.equal(byKey.has('here:workflow:product-flow'), false, 'an archived workflow is under its agent, not a workflow here');
  const legacy = byKey.get('here:workflow:legacy-flow');
  assert.equal(legacy.status, 'local-only');
  assert.equal(legacy.statusWords, 'Made from agent legacy-agent, it came from marketplace retired, which this repository no longer trusts; it stays until you remove it.');
  // An index: its newest version, its templates and agents by their import, a workflow it cannot install, nothing generated.
  assert.deepEqual([status('market:shared/skill/a11y-review'), byKey.get('market:shared/skill/a11y-review').version], ['not-installed', '1.10.0']);
  assert.equal(byKey.get('market:shared/skill/a11y-review').actions.install.command,
    `singularity-flow import add "market:shared/a11y-review" --as skill --id a11y-review --sha256 ${'5'.repeat(64)} --propose`);
  const template = byKey.get('market:shared/template/release-notes');
  assert.deepEqual([template.status, template.update.words], ['update-available', 'Marketplace Shared has version 1.1.0; version 1.0.0 is installed here.']);
  assert.equal(template.actions.update.command, `singularity-flow import add "market:shared/release-notes" --as template --id release-notes --sha256 ${'6'.repeat(64)} --replace --propose`);
  assert.equal(template.actions.remove.command, 'singularity-flow imports remove template:release-notes --propose');
  assert.equal(byKey.get('market:shared/agent/reviewer').actions.install.command, `singularity-flow import add "market:shared/reviewer" --as agent --sha256 ${'7'.repeat(64)} --propose`);
  // An index's workflow: `workflow import` reads a bundle from a file only, so no button, and the row says what to do.
  const nightly = byKey.get('market:shared/workflow/nightly');
  assert.deepEqual([nightly.status, nightly.importable, nightly.actions], ['not-installed', false, {}]);
  assert.equal(nightly.statusWords, 'Not installed here: SFlow imports a workflow from a bundle file, not from a marketplace\'s link. Save the bundle from '
    + 'https://catalog.example.org/nightly.json, then preview its import with singularity-flow workflow import, that file, --dry-run and --propose.');
  // An index's MCP server: added for the agents that may use its tools, which its preview shows; an update keeps them.
  const docs = byKey.get('market:shared/mcp-server/docs-server');
  assert.deepEqual([docs.kind, docs.status, docs.installedAs.agents, docs.update.words],
    ['mcp-server', 'update-available', ['architect', 'developer'], 'Marketplace Shared has version 1.1.0; version 1.0.0 is installed here.']);
  assert.equal(docs.actions.update.command,
    `singularity-flow import add "market:shared/docs-server" --as mcp-server --agents architect,developer --phases design --sha256 ${'8'.repeat(64)} --replace --propose`);
  assert.equal(docs.actions.remove.command, 'singularity-flow imports remove mcp-server:docs-server --propose');
  const jira = byKey.get('market:shared/mcp-server/jira-server');
  assert.deepEqual([jira.status, Object.keys(jira.actions)], ['not-installed', ['preview']]);
  assert.equal(jira.actions.preview.command, 'singularity-flow import preview "market:shared/jira-server" --as mcp-server --json');
  assert.match(jira.statusWords, /name the agents that may use them with --agents/u);
  // An index's generated source: fetched by the agent that drafts its step; a step no agent drafts, or none here, says so.
  const lint = byKey.get('market:shared/generated/lint-source');
  assert.deepEqual([lint.kind, lint.status, lint.statusWords], ['generated', 'not-installed',
    'Not installed here: agent architect would fetch it into artifacts/design/lint.md for each Story, when step Design starts.']);
  assert.equal(lint.actions.install.command, 'singularity-flow import add "market:shared/lint-source" --as generated --agent architect --propose');
  assert.deepEqual([byKey.get('market:shared/generated/review-notes').statusWords, Object.keys(byKey.get('market:shared/generated/review-notes').actions)],
    ['No agent drafts step Review here, so nothing would fetch it.', []]);
  assert.equal(byKey.get('market:shared/generated/deploy-log').statusWords, 'It is fetched for step deploy, which no workflow here has, so nothing would fetch it.');
  const coverage = byKey.get('market:shared/generated/coverage');
  assert.deepEqual([coverage.status, coverage.statusWords, coverage.actions.remove.command], ['installed',
    'Installed here: agent architect fetches it for each Story, the same as in marketplace Shared.', 'singularity-flow imports remove generated:architect/coverage --propose']);
  assert.deepEqual([byKey.get('here:generated:developer/build-notes').kind, byKey.get('here:generated:developer/build-notes').status], ['generated', 'local-only']);
  // Only here: written here, dropped by its marketplace, from a link, and from a marketplace that could not be read.
  assert.deepEqual([status('here:library-skill:house-style'), byKey.get('here:library-skill:house-style').statusWords],
    ['local-only', 'Written in this repository, or set up with SFlow: no marketplace has it.']);
  assert.equal(byKey.get('here:library-skill:old-checks').statusWords, 'It came from marketplace Acme, which no longer lists it; it stays until you remove it.');
  assert.equal(byKey.get('here:agent:house-reviewer').statusWords, 'It was imported from a link, not from a marketplace.');
  assert.equal(byKey.get('here:agent:house-reviewer').actions.remove.command, 'singularity-flow imports remove agent:house-reviewer --propose');
  assert.deepEqual([status('here:library-skill:broken-skill'), byKey.get('here:library-skill:broken-skill').statusWords],
    ['installed', 'Installed here from marketplace Old catalog, which could not be read just now, so an update is not known.']);
  // A marketplace trusted only in the working copy: one row, not read.
  const pending = byKey.get('marketplace:pending');
  assert.deepEqual([pending.kind, pending.status, pending.actions.approve.command], ['marketplace', 'not-approved-yet', 'singularity-flow configuration proposals']);
  assert.deepEqual(catalog.sources.map(({ id, approved, read }) => [id, approved, read]),
    [['acme', true, true], ['broken', true, false], ['shared', true, true], ['pending', false, false]]);
  assert.deepEqual(catalog.warnings, ['Marketplace Old catalog (broken) could not be read, so its items are not listed.']);
  // Every status is here, the summary counts them, and nothing a person reads names a commit.
  assert.deepEqual(CATALOG_STATUSES.filter((name) => !catalog.summary.byStatus[name]), []);
  assert.equal(catalog.summary.updates, catalog.items.filter((item) => item.status === 'update-available').length);
  assert.doesNotMatch(JSON.stringify(catalog), COMMIT);
  assertWholeCommands(catalog);
  assert.deepEqual(analyzeMarketplaceCatalog(sample()), analyzeMarketplaceCatalog(sample()), 'the same input, the same page');
});

test('kind, marketplace and words narrow the page; the terminal shows the preview, never a hash', () => {
  const keys = (options) => analyzeMarketplaceCatalog({ ...sample(), ...options }).items.map((item) => item.key);
  assert.deepEqual(keys({ kind: 'agent' }), ['here:agent:house-reviewer', 'market:acme/agent/product-agent', 'market:acme/agent/qa-agent', 'market:shared/agent/reviewer', 'marketplace:pending']);
  assert.deepEqual(keys({ only: 'shared' }), ['market:shared/skill/a11y-review', 'market:shared/agent/reviewer', 'market:shared/workflow/nightly', 'market:shared/template/release-notes',
    'market:shared/mcp-server/docs-server', 'market:shared/mcp-server/jira-server', 'market:shared/generated/coverage', 'market:shared/generated/deploy-log',
    'market:shared/generated/lint-source', 'market:shared/generated/review-notes']);
  assert.deepEqual(keys({ kind: 'generated' }).filter((key) => !key.startsWith('marketplace:')), ['here:generated:developer/build-notes', 'market:shared/generated/coverage',
    'market:shared/generated/deploy-log', 'market:shared/generated/lint-source', 'market:shared/generated/review-notes']);
  assert.ok(keys({ only: 'shared' }).every((key) => key.startsWith('market:shared/')));
  assert.deepEqual(keys({ only: 'pending' }), ['marketplace:pending']);
  assert.deepEqual(keys({ search: 'XRAY cases' }), ['market:acme/skill/web-xray-creation']);
  const lines = marketplaceCatalogLines(analyzeMarketplaceCatalog(sample()));
  assert.match(lines[0], /^\d+ items from 2 trusted marketplaces and this repository: \d+ skills, \d+ agents, \d+ workflows, 1 template, 2 MCP servers and 5 generated sources\. \d+ update available, /u);
  assert.ok(['Skills', 'Agents', 'Workflows', 'Templates', 'MCP servers', 'Generated sources'].every((heading) => lines.includes(heading)));
  assert.ok(lines.some((line) => line.trim() === 'Next: singularity-flow import add "market:shared/lint-source" --as generated --agent architect --propose'));
  assert.ok(lines.some((line) => line.trim() === 'Next: singularity-flow import preview "market:shared/jira-server" --as mcp-server'));
  assert.ok(lines.some((line) => line.trim() === 'Next: singularity-flow import preview "market:acme/requirements-writer" --as skill'));
  assert.ok(lines.some((line) => line.trim() === 'Next: singularity-flow workflow from-agent acme/qa-agent --update --review'));
  assert.ok(lines.includes('Note: Marketplace Old catalog (broken) could not be read, so its items are not listed.'));
  assert.doesNotMatch(lines.join('\n'), /[0-9a-f]{40}/u, 'no commit and no hash in a terminal');
});

test('--newest: each item says what is newer in its marketplace\'s newest commit, with the reviewed change that trusts that commit', () => {
  const input = sample();
  const acme = input.marketplaces[0];
  Object.assign(acme, { repository: 'https://git.example.com/acme/sdlc-marketplace.git', ref: 'main' });
  const skills = [
    { name: 'requirements-writer', version: '1.3.0', description: 'Numbered requirements.', tags: ['requirements', 'ga'], pdlcTasks: ['requirements-analysis'], lifecycleState: 'approved', sha256: '7'.repeat(64) },
    { name: 'web-e2e-test-generation', version: '1.0.0', description: 'Playwright tests.', tags: ['web'], pdlcTasks: ['e2e-testing'], lifecycleState: 'approved', sha256: '2'.repeat(64) },
    { name: 'web-xray-creation', version: '1.0.0', description: 'Xray cases.', tags: ['web'], pdlcTasks: [], lifecycleState: 'proposed', sha256: 'c'.repeat(64) },
    { name: 'android-checks', version: '0.1.0', description: 'New here.', tags: [], pdlcTasks: [], lifecycleState: 'proposed', sha256: 'f'.repeat(64) }];
  acme.newest = { items: repositoryItems({ skills, agents: [
    { name: 'qa-agent', version: '1.2.0', description: 'QA.', tags: ['web'], lifecycleState: 'approved', skills: ['web-xray-creation'], text: 'agent text, clearer', manifestSha256: '6'.repeat(64) },
    { name: 'product-agent', version: '1.0.0', description: 'Product.', tags: [], lifecycleState: 'deprecated', skills: [], text: 'product text', manifestSha256: 'd'.repeat(64) }] }) };
  const catalog = JSON.parse(JSON.stringify(analyzeMarketplaceCatalog({ ...input, newest: true })));
  const byKey = new Map(catalog.items.map((item) => [item.key, item]));
  const trust = 'singularity-flow marketplace add acme --repo "https://git.example.com/acme/sdlc-marketplace.git" --ref main --propose';
  // A newer version: said, with the change that trusts that commit; the status stays what the trusted commit says.
  const requirements = byKey.get('market:acme/skill/requirements-writer');
  assert.deepEqual([requirements.status, requirements.newer], ['update-available', { version: '1.3.0', gone: false, words: 'Newer version 1.3.0 in the marketplace\'s newest commit.' }]);
  assert.equal(requirements.actions.trust.command, trust);
  // Unchanged there: nothing said, no trust action.
  assert.equal(byKey.get('market:acme/skill/web-e2e-test-generation').newer, undefined);
  assert.equal(byKey.get('market:acme/skill/web-e2e-test-generation').actions.trust, undefined);
  // An agent: what it uses that changed, and its workflow here says the same.
  const qa = byKey.get('market:acme/agent/qa-agent');
  assert.equal(qa.newer.words, 'Newer version 1.2.0 in the marketplace\'s newest commit: agent.md changed.');
  assert.deepEqual([byKey.get('here:workflow:qa-flow').newer, byKey.get('here:workflow:qa-flow').actions.trust.command], [qa.newer, trust]);
  // Gone at the newest commit: said, and nothing to trust for it.
  assert.deepEqual([byKey.get('market:acme/skill/house-style').newer.gone, byKey.get('market:acme/skill/house-style').actions.trust], [true, undefined]);
  // The marketplace: what its newest commit changes, and the one command that trusts it.
  const source = catalog.sources.find((entry) => entry.id === 'acme');
  assert.deepEqual([source.newest.checked, source.newest.newer, source.newest.changed, source.newest.added], [true, true, 2, ['android-checks']]);
  assert.equal(source.newest.words, 'Its newest commit is newer than the one trusted here: 2 items changed, new there: android-checks and 1 item no longer there.');
  assert.equal(source.newest.action.command, trust);
  assert.deepEqual([catalog.summary.newer, catalog.filters.newest], [3, true]);
  assert.equal(catalog.sources.find((entry) => entry.id === 'shared').newest, undefined, 'an index is always read at its newest');
  assert.doesNotMatch(JSON.stringify(catalog), COMMIT);
  assertWholeCommands(catalog);
  // The same commit: nothing newer. Unreadable: a warning with no commit, and the page still lists the trusted items.
  acme.newest = { same: true };
  const same = analyzeMarketplaceCatalog({ ...input, newest: true });
  assert.deepEqual([same.sources.find((entry) => entry.id === 'acme').newest.words, same.summary.newer], ['Its newest commit is the one trusted here.', 0]);
  acme.newest = { error: 'The newest commit of marketplace Acme (acme) could not be read, so whether it has newer versions is not known: Git said: offline.' };
  const offline = analyzeMarketplaceCatalog({ ...input, newest: true });
  assert.ok(offline.warnings.includes(acme.newest.error));
  assert.equal(offline.items.find((item) => item.key === 'market:acme/skill/requirements-writer').status, 'update-available');
  // The terminal: each newer item, the marketplace's line with its trust command; without --newest, how to ask.
  const lines = marketplaceCatalogLines(catalog);
  assert.ok(lines.some((line) => line.trim() === 'Newer: Newer version 1.3.0 in the marketplace\'s newest commit.'));
  assert.ok(lines.includes(`Marketplace Acme: ${source.newest.words} Trust it, then update: ${trust}`));
  assert.ok(marketplaceCatalogLines(analyzeMarketplaceCatalog(sample())).includes(
    'Newer commits than the ones trusted are not read here; to see what changed there: singularity-flow marketplace catalog --newest'));
  assert.equal(newerInNewest({ kind: 'skill', version: '2.0.0', sha256: 'a'.repeat(64) }, { kind: 'skill', version: '1.9.0', sha256: 'b'.repeat(64) }).words,
    'Version 1.9.0 in the marketplace\'s newest commit.', 'an older version there is not called newer');
});

// ------------------------------------------------------------------------------------------------ read, as Stories do

/** The fixture marketplace as a Git repository of its own. */
async function marketplaceRepository(t) {
  const directory = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'sflow-store-market-')));
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
  return { directory, repository, git, commit: git('rev-parse', 'HEAD') };
}

const INDEX = 'https://catalog.example.org/sflow-marketplace.json';
const WEB_PACKAGE = JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' }, dependencies: { react: '^18.3.1' } });
const skillText = (id, description) => ['---', `name: ${id}`, `description: ${description}`, '---', '', '1. Do the work.', ''].join('\n');
/** The pieces a workflow made from the QA agent records, as `workflow from-agent` makes them from the same files. */
function qaPieces() {
  const skills = ['android-ui-test-creation', 'android-unit-test', 'android-xray-creation', 'web-e2e-test-generation', 'web-xray-creation'];
  return { agent: sha(fixtureText('agents/qa-test-automation-agent/agent.md')), manifest: sha(fixtureText('agents/qa-test-automation-agent/apm.yml')),
    skills: Object.fromEntries(skills.map((name) => [name, sha(fixtureText(`skills/${name}/SKILL.md`))])) };
}

test('marketplace catalog reads what the approved configuration trusts once per commit, and an update shows once the marketplace changes and its trust moves', async (t) => {
  const acme = await marketplaceRepository(t);
  const served = path.join(acme.directory, 'served');
  await mkdir(path.join(served, 'catalog.example.org'), { recursive: true });
  await writeFile(path.join(served, 'catalog.example.org', 'sflow-marketplace.json'), JSON.stringify({ format: 'sflow-marketplace@1', name: 'Shared catalog', entries: [
    { id: 'a11y-review', kind: 'skill', version: '1.10.0', label: 'Accessibility review', description: 'Check a web change against WCAG 2.2 AA.', tags: ['web'],
      url: 'https://catalog.example.org/a11y.md', sha256: 'b'.repeat(64) },
    { id: 'release-notes', kind: 'template', version: '1.1.0', label: 'Release notes', url: 'https://catalog.example.org/release.md', sha256: 'c'.repeat(64) },
    { id: 'reviewer', kind: 'agent', version: '1.0.0', label: 'Reviewer', url: 'https://catalog.example.org/reviewer.agent.md', sha256: 'd'.repeat(64) }] }));
  const requirements = fixtureText('skills/requirements-writer/SKILL.md');
  const story = await journeyRepository(t, {
    env: { SINGULARITY_FLOW_TEST_REMOTE_FIXTURES: served },
    files: {
      'package.json': WEB_PACKAGE,
      'singularity/skill-library/requirements-writer/SKILL.md': requirements,
      'singularity/skill-library/web-xray-creation/SKILL.md': skillText('web-xray-creation', 'An older copy of the Xray skill.'),
      'singularity/skill-library/house-style/SKILL.md': skillText('house-style', 'Follow the team\'s naming rules.'),
      'singularity/imports.lock.yml': YAML.stringify({ version: 1, imports: {
        'library-skill:requirements-writer': { kind: 'library-skill', target: { id: 'requirements-writer', path: 'singularity/skill-library/requirements-writer/SKILL.md' },
          sha256: sha(requirements), source: { kind: 'marketplace-skill', marketplace: 'acme', repository: acme.repository, commit: acme.commit, entry: 'requirements-writer', version: '1.0.0-pdlc' } },
        'library-skill:web-xray-creation': { kind: 'library-skill', target: { id: 'web-xray-creation', path: 'singularity/skill-library/web-xray-creation/SKILL.md' },
          sha256: sha('an older text'), source: { kind: 'marketplace-skill', marketplace: 'acme', repository: acme.repository, entry: 'web-xray-creation', version: '0.9.0' } },
        'workflow:chore': { kind: 'workflow', workflow: 'chore', pieces: qaPieces(), target: { id: 'qa-test-automation-agent' },
          source: { kind: 'marketplace-agent', marketplace: 'acme', repository: acme.repository, commit: acme.commit, agent: 'qa-test-automation-agent', version: '1.0.0-pdlc', answers: {} } },
        'template:release-notes': { kind: 'template', target: { id: 'release-notes' }, sha256: 'c'.repeat(64),
          source: { kind: 'marketplace', marketplace: 'shared', entry: 'release-notes', version: '1.1.0' } } } })
    },
    configure: (configuration) => {
      configuration.marketplaces = { acme: { label: 'Acme', repository: acme.repository, commit: acme.commit }, shared: { label: 'Shared', index: INDEX } };
    }
  });
  // The approved configuration: sflow/config on the repository's remote, as main is now.
  story.git('push', '-q', 'origin', 'main:sflow/config');
  // This checkout's workflow.yml also trusts a marketplace that is not approved yet.
  const configuration = YAML.parse(await story.read('singularity/workflow.yml'));
  configuration.marketplaces.pending = { label: 'Pending catalog', index: 'https://pending.example.org/sflow-marketplace.json' };
  await story.write('singularity/workflow.yml', YAML.stringify(configuration));

  const catalog = JSON.parse(story.cli('marketplace', 'catalog', '--json'));
  assert.equal(catalog.resultType, 'marketplace-catalog');
  const byKey = new Map(catalog.items.map((item) => [item.key, item]));
  const state = (key) => [byKey.get(key)?.status, byKey.get(key)?.statusWords];
  assert.deepEqual(state('market:acme/skill/requirements-writer'), ['installed', 'Installed here, the same as in marketplace Acme.']);
  assert.deepEqual(state('market:acme/skill/web-xray-creation'), ['update-available', 'Marketplace Acme has version 1.0.0-pdlc; version 0.9.0 is installed here.']);
  assert.deepEqual(state('market:acme/skill/web-e2e-test-generation'), ['not-installed', 'Not installed here.']);
  assert.deepEqual(state('market:acme/agent/qa-test-automation-agent'), ['installed', 'Installed here as workflow Chore, the same as in marketplace Acme.']);
  assert.deepEqual(state('market:acme/agent/product-agent'), ['not-installed', 'Not installed here: it becomes a workflow through its conversion review.']);
  assert.equal(byKey.get('here:workflow:chore').status, 'installed');
  assert.deepEqual(state('here:library-skill:house-style'), ['local-only', 'Written in this repository, or set up with SFlow: no marketplace has it.']);
  assert.deepEqual(state('market:shared/skill/a11y-review'), ['not-installed', 'Not installed here.']);
  assert.deepEqual(state('market:shared/template/release-notes'), ['installed', 'Installed here, the same as in marketplace Shared.']);
  assert.equal(byKey.get('market:shared/agent/reviewer').status, 'not-installed');
  assert.deepEqual(state('marketplace:pending'), ['not-approved-yet',
    'Trusted only in your working copy of workflow.yml, and not approved yet: Stories do not use it, so its items are not read.']);
  assert.deepEqual(catalog.sources.map(({ id, approved, read, items }) => [id, approved, read, items]),
    [['acme', true, true, 9], ['shared', true, true, 3], ['pending', false, false, 0]]);
  assert.deepEqual(catalog.warnings, []);
  assert.doesNotMatch(JSON.stringify(catalog), COMMIT, 'no commit ID reaches the page');
  assertWholeCommands(catalog);

  // The install and update commands add exactly what the import preview shows.
  const install = byKey.get('market:acme/skill/web-e2e-test-generation').actions.install.command;
  const preview = JSON.parse(story.cli('import', 'preview', 'market:acme/web-e2e-test-generation', '--as', 'skill', '--json'));
  assert.equal(install, `${preview.addCommand} --propose`);
  assert.equal(preview.sha256, sha(fixtureText('skills/web-e2e-test-generation/SKILL.md')));
  const update = byKey.get('market:acme/skill/web-xray-creation').actions.update.command;
  assert.equal(update, `${JSON.parse(story.cli('import', 'preview', 'market:acme/web-xray-creation', '--as', 'skill', '--json')).addCommand} --replace --propose`);

  // Narrowed: by kind, by marketplace (one not approved is its row alone), by words; refused with the way back.
  const kinds = JSON.parse(story.cli('marketplace', 'catalog', '--kind', 'agent', '--json'));
  assert.deepEqual(kinds.items.map((item) => item.key), ['market:acme/agent/product-agent', 'market:acme/agent/qa-test-automation-agent', 'market:shared/agent/reviewer', 'marketplace:pending']);
  const shared = JSON.parse(story.cli('marketplace', 'catalog', '--marketplace', 'shared', '--json'));
  assert.deepEqual(shared.sources.map((source) => source.id), ['shared']);
  assert.ok(shared.items.every((item) => item.marketplace === 'shared'));
  assert.deepEqual(JSON.parse(story.cli('marketplace', 'catalog', '--marketplace', 'pending', '--json')).items.map((item) => item.key), ['marketplace:pending']);
  assert.deepEqual(JSON.parse(story.cli('marketplace', 'catalog', '--search', 'xray android', '--json')).items.map((item) => item.key), ['market:acme/skill/android-xray-creation']);
  const unknown = story.raw(['marketplace', 'catalog', '--marketplace', 'nope', '--json']);
  assert.notEqual(unknown.status, 0);
  assert.match(`${unknown.stdout}${unknown.stderr}`, /MARKETPLACE_CATALOG_UNKNOWN/u);
  assert.match(`${unknown.stdout}${unknown.stderr}`, /It trusts acme and shared\./u);
  for (const args of [['marketplace', 'catalog', 'acme'], ['marketplace', 'catalog', '--kind', 'nope'], ['marketplace', 'catalog', '--status', 'installed']]) {
    const refused = story.raw([...args, '--json']);
    assert.notEqual(refused.status, 0, args.join(' '));
    assert.match(`${refused.stdout}${refused.stderr}`, /MARKETPLACE_CATALOG_USAGE/u, args.join(' '));
  }
  // In a terminal: plain lines, the next preview, no hash.
  const text = story.cli('marketplace', 'catalog');
  assert.match(text.split('\n')[0], /^\d+ items from 2 trusted marketplaces and this repository: /u);
  assert.match(text, /^ {6}Next: singularity-flow import preview "market:acme\/web-e2e-test-generation" --as skill$/mu);
  assert.doesNotMatch(text, /[0-9a-f]{40}/u);

  // The marketplace changes two skills; the repository moves its trust to that commit, as a reviewed change does.
  await story.must('git', ['checkout', '--', 'singularity/workflow.yml']);
  await writeFile(path.join(acme.repository, 'skills/requirements-writer/SKILL.md'), `${requirements}\nNumber every assumption too.\n`);
  const xray = path.join(acme.repository, 'skills/web-xray-creation/SKILL.md');
  await writeFile(xray, `${await readFile(xray, 'utf8')}\nAlways name the browser and its version in each test case.\n`);
  acme.git('commit', '-qam', 'Requirements and web Xray: clearer');
  const moved = acme.git('rev-parse', 'HEAD');
  // Before the trust moves, only --newest reads that commit: what is newer there, and the reviewed change that trusts it.
  const plain = JSON.parse(story.cli('marketplace', 'catalog', '--json'));
  assert.deepEqual([plain.items.filter((item) => item.newer).length, plain.sources.find((source) => source.id === 'acme').newest], [0, undefined]);
  const checked = JSON.parse(story.cli('marketplace', 'catalog', '--newest', '--json'));
  const newer = new Map(checked.items.filter((item) => item.newer).map((item) => [item.key, item.newer.words]));
  assert.deepEqual(Object.fromEntries(newer), {
    'market:acme/skill/requirements-writer': 'A changed text in the marketplace\'s newest commit.',
    'market:acme/skill/web-xray-creation': 'A changed text in the marketplace\'s newest commit.',
    'market:acme/agent/product-agent': 'Skill requirements-writer changed in the marketplace\'s newest commit.',
    'market:acme/agent/qa-test-automation-agent': 'Skill web-xray-creation changed in the marketplace\'s newest commit.',
    'here:workflow:chore': 'Skill web-xray-creation changed in the marketplace\'s newest commit.' });
  const trustCommand = `singularity-flow marketplace add acme --repo ${JSON.stringify(acme.repository)} --propose`;
  assert.equal(checked.items.find((item) => item.key === 'market:acme/skill/requirements-writer').actions.trust.command, trustCommand);
  assert.deepEqual(checked.sources.find((source) => source.id === 'acme').newest, { checked: true, newer: true, changed: 4, added: [],
    words: 'Its newest commit is newer than the one trusted here: 4 items changed.',
    action: { command: trustCommand, label: 'Propose trusting its newest commit; then update its items here.' } });
  assert.doesNotMatch(JSON.stringify(checked), COMMIT, 'no commit ID reaches the page, the newest one included');
  const checkedText = story.cli('marketplace', 'catalog', '--newest');
  assert.match(checkedText, /^ {6}Newer: A changed text in the marketplace's newest commit\.$/mu);
  assert.ok(checkedText.includes(`Trust it, then update: ${trustCommand}`));
  assert.doesNotMatch(checkedText, /[0-9a-f]{40}/u);
  const flagged = story.raw(['marketplace', 'catalog', '--newest=yes', '--json']);
  assert.notEqual(flagged.status, 0);
  const trusted = YAML.parse(await story.read('singularity/workflow.yml'));
  trusted.marketplaces.acme.commit = moved;
  await story.write('singularity/workflow.yml', YAML.stringify(trusted));
  story.git('commit', '-qam', 'Trust the newer marketplace commit');
  story.git('push', '-q', 'origin', 'main:sflow/config');
  const after = new Map(JSON.parse(story.cli('marketplace', 'catalog', '--json')).items.map((item) => [item.key, item]));
  const changed = after.get('market:acme/skill/requirements-writer');
  assert.deepEqual([changed.status, changed.update.kind, changed.update.words], ['update-available', 'text',
    'Marketplace Acme has a changed text at the same version, 1.0.0-pdlc; the copy installed here is the earlier one.']);
  assert.match(changed.actions.update.command, new RegExp(`--sha256 ${sha(`${requirements}\nNumber every assumption too.\n`)} --replace --propose$`, 'u'));
  const agent = after.get('market:acme/agent/qa-test-automation-agent');
  assert.deepEqual([agent.status, agent.update.words], ['update-available', 'Skill web-xray-creation changed in marketplace Acme.']);
  assert.equal(agent.actions.update.command, 'singularity-flow workflow from-agent acme/qa-test-automation-agent --update --propose');
  assert.equal(after.get('here:workflow:chore').status, 'update-available');
  assert.equal(after.has('marketplace:pending'), false);
  // One read per commit: the agents and skills of each commit read (the newest one read by --newest is the one now trusted).
  const kept = path.join(story.root, '.git', 'singularity-flow', 'task-marketplace-agents');
  const files = await readdir(kept);
  assert.equal(files.length, 2);
  for (const file of files) assert.equal(JSON.parse(await readFile(path.join(kept, file), 'utf8')).format, 'sflow-task-marketplace-agents/v2');
  await rm(acme.repository, { recursive: true, force: true });
  assert.deepEqual(JSON.parse(story.cli('marketplace', 'catalog', '--marketplace', 'acme', '--json')).items.map((item) => [item.key, item.status]),
    [...after.values()].filter((item) => item.marketplace === 'acme').map((item) => [item.key, item.status]), 'read again from what was kept');
  assert.equal(story.git('status', '--porcelain'), '', 'reading the page writes nothing in the checkout');
});
