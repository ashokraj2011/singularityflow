/**
 * The organisation's marketplace, M3 [OMK §8, docs/SPEC-OMK-ORG-MARKETPLACE-v1.md]: an item its marketplace deprecated or
 * retired that is still used here (the library, an agent's imports, a workflow made from it or attaching it, an open
 * Story) is flagged on every surface, with its replacement through the same reviewed import, and is never removed or
 * blocked: the catalog and its terminal lines, the Marketplace and All skills pages, the skill catalog, a task's plan
 * line, `check` (from what is kept, never fetched), a Story's start line, Workflow Studio's view of the workflow, and a
 * Copilot session's start.
 *
 * The marketplace is a local Git repository made from test/fixtures/sdlc-marketplace (test/helpers/sdlc-marketplace.mjs):
 * nothing here uses a network.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { deprecatedInUseOf, inUseOf, inUseSessionWords, inUseWords, itemUses, replacementOf, workflowInUseWords } from '../src/marketplace-in-use.mjs';
import { itemLifecycle, parseLifecycleRecord } from '../src/marketplace-lifecycle.mjs';
import { analyzeMarketplaceCatalog, marketplaceCatalogLines, repositoryItems } from '../src/marketplace-catalog.mjs';
import { analyzeSkillCatalog, skillCatalogLines } from '../src/skill-catalog.mjs';
import { chooseTaskSkills, librarySkillCandidate, marketplaceSkillCandidate, planSkillWords, taskSkillChooser } from '../src/task-skills.mjs';
import { loadDefinition } from '../src/config.mjs';
import { composeTask } from '../src/task-composition.mjs';
import { marketplaceCatalogFrom, marketplacePageHtml, studioTargetFor } from '../apps/vscode/src/views/marketplace-page.ts';
import { allSkillsPageHtml, skillCatalogFrom } from '../apps/vscode/src/views/all-skills-page.ts';
import { WORKFLOW_STUDIO_SCRIPT } from '../apps/vscode/src/views/workflow-studio-page.ts';
import { journeyRepository, startStory } from './helpers/route-follower.mjs';
import { copySampleMarketplace, SAMPLE_MARKETPLACE } from './helpers/sdlc-marketplace.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = YAML.parse(readFileSync(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
const STEWARDS = '@acme/marketplace-stewards';
const sha = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');
const json = (text) => JSON.parse(text);
const COMMIT_ID = /\b[0-9a-f]{40}\b/u;

/** A guarded lifecycle record, as M1 reads one. */
const lifecycle = (state, { replacedBy = null, sunset = null, at = '2026-11-20', from = 'ga' } = {}) => itemLifecycle({
  file: parseLifecycleRecord({ state, ...(replacedBy || sunset ? { deprecation: { ...(replacedBy ? { 'replaced-by': replacedBy } : {}), ...(sunset ? { sunset } : {}) } } : {}),
    history: [{ from, to: state, at, 'approved-by': [STEWARDS] }] }), guard: { covered: true, owners: [STEWARDS] } });
const NO_USES = Object.freeze({ library: [], agents: [], workflows: [], openStories: [] });

// ------------------------------------------------------------------------------------------------ what counts as in use

test('in use here: the library, an agent\'s imports, a workflow made from it or attaching it, and an open Story; an archived workflow is not [OMK:REQ-040]', () => {
  const text = 'a'.repeat(64);
  const imports = {
    'library-skill:web-e2e': { kind: 'library-skill', target: { id: 'web-e2e' }, sha256: text, source: { kind: 'marketplace-skill', marketplace: 'acme', entry: 'web-e2e' } },
    'skill:qa-bot:web-e2e': { kind: 'skill', target: { id: 'web-e2e', agent: 'qa-bot' }, source: { kind: 'marketplace-skill', marketplace: 'acme', entry: 'web-e2e' } },
    'library-skill:other': { kind: 'library-skill', target: { id: 'other' }, source: { kind: 'marketplace-skill', marketplace: 'shared', entry: 'web-e2e' } },
    'workflow:qa-tests': { kind: 'workflow', workflow: 'qa-tests', source: { kind: 'marketplace-agent', marketplace: 'acme', agent: 'qa-agent' } },
    'workflow:old-tests': { kind: 'workflow', workflow: 'old-tests', source: { kind: 'marketplace-agent', marketplace: 'acme', agent: 'qa-agent' } },
    'template:release-notes': { kind: 'template', target: { id: 'release-notes' }, source: { kind: 'marketplace', marketplace: 'acme', entry: 'release-notes' } }
  };
  const workflows = { 'qa-tests': { archived: false }, 'old-tests': { archived: true }, 'web-flow': { archived: false } };
  const attachments = [{ id: 'web-e2e', workflow: 'web-flow', phases: [] }, { id: 'web-e2e', agent: 'reviewer', phases: ['implementation'] }, { id: 'web-e2e', workflow: 'old-tests', phases: [] }];
  const openStories = [{ workId: 'S-1', workflow: 'qa-tests', skills: [], sha256: [] }, { workId: 'S-2', workflow: 'other', skills: [], sha256: [text] },
    { workId: 'S-3', workflow: 'other', skills: ['web-e2e'], sha256: [] }, { workId: 'S-4', workflow: 'other', skills: [], sha256: ['b'.repeat(64)] }];
  const given = { imports, library: new Set(['web-e2e', 'other']), workflows, attachments, openStories };
  assert.deepEqual(itemUses({ marketplace: 'acme', kind: 'skill', name: 'web-e2e' }, given),
    { library: ['web-e2e'], agents: ['qa-bot', 'reviewer'], workflows: ['web-flow'], openStories: ['S-2', 'S-3'] });
  assert.deepEqual(itemUses({ marketplace: 'acme', kind: 'agent', name: 'qa-agent' }, given), { library: [], agents: [], workflows: ['qa-tests'], openStories: ['S-1'] });
  assert.deepEqual(itemUses({ marketplace: 'acme', kind: 'template', name: 'release-notes' }, given), { library: ['release-notes'], agents: [], workflows: [], openStories: [] });
  // A library skill the library no longer holds is not in use by it; an item of another marketplace is not this one.
  assert.deepEqual(itemUses({ marketplace: 'acme', kind: 'skill', name: 'web-e2e' }, { ...given, library: new Set(), openStories: [] }),
    { library: [], agents: ['qa-bot'], workflows: [], openStories: [] });
  assert.deepEqual(itemUses({ marketplace: 'acme', kind: 'skill', name: 'unknown' }, given), NO_USES);
});

test('the words and the replacement: offered only when its marketplace lists it and it is neither deprecated nor retired [OMK:REQ-041, REQ-042]', () => {
  const deprecated = { kind: 'skill', name: 'web-e2e', owner: { name: 'Web QA' }, lifecycleRecord: lifecycle('deprecated', { replacedBy: 'web-e2e-v2', sunset: '2027-03-31' }) };
  const v2 = { kind: 'skill', name: 'web-e2e-v2', lifecycleRecord: lifecycle('ga', { from: 'approved', at: '2026-11-15' }) };
  const uses = { library: ['web-e2e'], agents: [], workflows: ['checkout-tests', 'web-tests'], openStories: ['S-1'] };
  const used = deprecatedInUseOf(deprecated, { marketplace: 'acme', label: 'Acme', uses, items: [deprecated, v2] });
  assert.equal(used.words, 'Deprecated by Web QA on 20 Nov 2026 (supported until 31 Mar 2027); still used by the skill library, 2 workflows and 1 open Story. Use web-e2e-v2.');
  assert.deepEqual([used.state, used.replacedBy, used.sunset, used.since, used.owner], ['deprecated', 'web-e2e-v2', '2027-03-31', '2026-11-20', 'Web QA']);
  assert.deepEqual(used.replacement, { kind: 'skill', id: 'web-e2e-v2', marketplace: 'acme', offered: true, installed: false, words: 'Use web-e2e-v2.',
    preview: { command: 'singularity-flow import preview "market:acme/web-e2e-v2" --as skill --json', label: "Show the replacement web-e2e-v2's exact text before installing it." } });
  // Nothing uses it, or it is neither deprecated nor retired: nothing to say.
  assert.equal(deprecatedInUseOf(deprecated, { marketplace: 'acme', uses: NO_USES, items: [] }), null);
  assert.equal(deprecatedInUseOf(v2, { marketplace: 'acme', uses, items: [] }), null);
  // A replacement deprecated too, not listed, or already installed here is not offered, and the words say why.
  assert.equal(replacementOf(deprecated, { marketplace: 'acme', label: 'Acme', items: [{ ...v2, lifecycleRecord: lifecycle('deprecated') }] }).words,
    'Its replacement web-e2e-v2 is deprecated too, so it is not offered.');
  assert.equal(replacementOf(deprecated, { marketplace: 'acme', label: 'Acme', items: [] }).words, 'Its replacement web-e2e-v2 is not in marketplace Acme, so it is not offered here.');
  const here = replacementOf(deprecated, { marketplace: 'acme', items: [v2], installed: () => true });
  assert.deepEqual([here.offered, here.installed, here.preview, here.words], [false, true, null, 'Its replacement web-e2e-v2 is installed here too: move what uses this one to it.']);
  // A retired agent with no replacement; an agent's replacement is the workflow it becomes, through its review.
  const retired = { kind: 'agent', name: 'qa-agent', owner: { name: 'QA Guild' }, lifecycleRecord: lifecycle('retired', { from: 'deprecated', at: '2026-11-21' }) };
  assert.equal(deprecatedInUseOf(retired, { marketplace: 'acme', uses: { ...NO_USES, workflows: ['qa-tests'] } }).words,
    'Retired by QA Guild on 21 Nov 2026: no longer supported; still used by workflow qa-tests. Its marketplace names no replacement.');
  const agent = { kind: 'agent', name: 'qa-agent', owner: { name: 'QA Guild' }, lifecycleRecord: lifecycle('deprecated', { replacedBy: 'product-agent' }) };
  const product = { kind: 'agent', name: 'product-agent', lifecycleRecord: lifecycle('approved', { from: 'proposed' }) };
  const agentUse = deprecatedInUseOf(agent, { marketplace: 'acme', label: 'Acme', marketplaceKind: 'repository', uses: { ...NO_USES, workflows: ['quick-fix'] }, items: [agent, product] });
  assert.equal(agentUse.replacement.preview.command, 'singularity-flow workflow from-agent acme/product-agent --review');
  assert.equal(workflowInUseWords('Quick fix', { ...agentUse, kind: 'agent', id: 'qa-agent', marketplaceLabel: 'Acme' }),
    'Workflow Quick fix was made from agent qa-agent of marketplace Acme, which is deprecated by QA Guild on 20 Nov 2026; it runs as it is. Its replacement is product-agent: singularity-flow workflow from-agent acme/product-agent --review');
  // Deprecated only in the newest commit read (--newest), and the state recorded at import when the marketplace could not be read.
  assert.match(deprecatedInUseOf(v2, { marketplace: 'acme', uses, newest: deprecated, items: [deprecated, v2] }).words,
    /^Deprecated in the marketplace's newest commit; still used by the skill library, 2 workflows and 1 open Story\. Use web-e2e-v2\.$/u);
  assert.match(inUseWords({ state: 'deprecated', uses, recorded: true }), /names no replacement\. This is the state recorded when it was imported: its marketplace could not be read\.$/u);
  assert.equal(inUseSessionWords([{ kind: 'skill', id: 'web-e2e', state: 'deprecated', replacement: 'web-e2e-v2' }, { kind: 'agent', id: 'qa-agent', state: 'retired', replacement: null }]),
    "Still used here, though its marketplace deprecated or retired it: skill web-e2e (deprecated; use web-e2e-v2) and agent qa-agent (retired). Nothing was changed. See them and their replacements: /sf-marketplace (or in your terminal: singularity-flow marketplace catalog).");
  assert.equal(inUseSessionWords([]), null);
});

// ------------------------------------------------------------------------------------------------ the surfaces, pure

function catalogInput({ newest = false } = {}) {
  const skills = [
    { name: 'web-e2e', version: '1.0.0', tags: ['web'], pdlcTasks: ['e2e-testing'], lifecycleState: 'deprecated', sha256: '1'.repeat(64), owner: { name: 'Web QA' },
      lifecycleRecord: lifecycle('deprecated', { replacedBy: 'web-e2e-v2' }) },
    { name: 'web-e2e-v2', version: '2.0.0', tags: ['web'], pdlcTasks: ['e2e-testing'], lifecycleState: 'ga', sha256: '2'.repeat(64), owner: { name: 'Web QA' },
      lifecycleRecord: lifecycle('ga', { from: 'approved' }) },
    { name: 'old-checks', version: '0.1.0', tags: ['web'], lifecycleState: 'retired', sha256: '3'.repeat(64), lifecycleRecord: lifecycle('retired', { from: 'deprecated' }) },
    { name: 'requirements-writer', version: '1.0.0', tags: [], lifecycleState: 'approved', sha256: '5'.repeat(64), lifecycleRecord: lifecycle('approved', { from: 'proposed' }) }];
  const agents = [
    { name: 'qa-agent', version: '1.0.0', tags: [], lifecycleState: 'deprecated', skills: [], text: 'qa', manifestSha256: '4'.repeat(64), owner: { name: 'QA Guild' },
      lifecycleRecord: lifecycle('deprecated', { replacedBy: 'product-agent' }) },
    { name: 'product-agent', version: '1.0.0', tags: [], lifecycleState: 'approved', skills: [], text: 'product', manifestSha256: '6'.repeat(64),
      lifecycleRecord: lifecycle('approved', { from: 'proposed' }) }];
  const items = repositoryItems({ skills, agents });
  const market = { id: 'acme', label: 'Acme', kind: 'repository', commit: 'e'.repeat(40), repository: 'https://git.example.com/acme.git', ref: null, channel: null, warning: null, items };
  if (newest) market.newest = { items: repositoryItems({ skills: skills.map((skill) => (skill.name === 'requirements-writer'
    ? { ...skill, lifecycleState: 'deprecated', lifecycleRecord: lifecycle('deprecated', { from: 'approved' }) } : skill)), agents }) };
  const qaPieces = items.find((item) => item.name === 'qa-agent').pieces;
  return {
    marketplaces: [market], newest,
    library: [{ id: 'web-e2e', label: 'web-e2e' }, { id: 'requirements-writer', label: 'requirements-writer' }],
    imports: {
      'library-skill:web-e2e': { kind: 'library-skill', target: { id: 'web-e2e' }, sha256: '1'.repeat(64), source: { kind: 'marketplace-skill', marketplace: 'acme', entry: 'web-e2e', version: '1.0.0' } },
      'library-skill:requirements-writer': { kind: 'library-skill', target: { id: 'requirements-writer' }, sha256: '5'.repeat(64),
        source: { kind: 'marketplace-skill', marketplace: 'acme', entry: 'requirements-writer', version: '1.0.0' } },
      'workflow:qa-tests': { kind: 'workflow', workflow: 'qa-tests', pieces: qaPieces, source: { kind: 'marketplace-agent', marketplace: 'acme', agent: 'qa-agent', version: '1.0.0' } }
    },
    workflows: { 'qa-tests': { label: 'QA tests', archived: false } },
    attachments: [{ id: 'web-e2e', workflow: 'qa-tests', phases: [] }]
  };
}

test('the catalog: a deprecated item in use says who uses it, offers its replacement through the same reviewed import, and stays installed [OMK:REQ-041, REQ-042, A9]', () => {
  const catalog = JSON.parse(JSON.stringify(analyzeMarketplaceCatalog(catalogInput())));
  const byKey = new Map(catalog.items.map((item) => [item.key, item]));
  const skill = byKey.get('market:acme/skill/web-e2e');
  assert.deepEqual([skill.status, skill.deprecatedInUse.state, skill.deprecatedInUse.uses], ['installed', 'deprecated',
    { library: ['web-e2e'], agents: [], workflows: ['qa-tests'], openStories: [] }]);
  assert.equal(skill.deprecatedInUse.words, 'Deprecated by Web QA on 20 Nov 2026; still used by the skill library and workflow qa-tests. Use web-e2e-v2.');
  assert.equal(skill.actions.replace.command, 'singularity-flow import preview "market:acme/web-e2e-v2" --as skill --json');
  assert.equal(skill.deprecatedInUse.replacement.key, 'market:acme/skill/web-e2e-v2');
  assert.match(skill.deprecatedInUse.replacement.install.command, /^singularity-flow import add "market:acme\/web-e2e-v2" --as skill --id web-e2e-v2 --sha256 2{64} --propose$/u);
  assert.ok(skill.actions.remove && skill.actions.open, 'nothing is removed or blocked: its own actions stay');
  const agent = byKey.get('market:acme/agent/qa-agent');
  assert.deepEqual([agent.status, agent.deprecatedInUse.uses.workflows, agent.actions.replace.command],
    ['installed', ['qa-tests'], 'singularity-flow workflow from-agent acme/product-agent --review']);
  const made = byKey.get('here:workflow:qa-tests');
  assert.deepEqual([made.deprecatedInUse.words, made.actions.replace.command], [agent.deprecatedInUse.words, agent.actions.replace.command]);
  assert.equal(byKey.get('market:acme/skill/old-checks').deprecatedInUse, null, 'retired, but nothing here uses it');
  assert.equal(byKey.get('market:acme/skill/web-e2e-v2').deprecatedInUse, null);
  assert.equal(catalog.summary.deprecatedInUse, 2, 'the agent and its workflow count once');
  const lines = marketplaceCatalogLines(catalog);
  assert.ok(lines.includes('      In use: Deprecated by Web QA on 20 Nov 2026; still used by the skill library and workflow qa-tests. Use web-e2e-v2.'));
  assert.ok(lines.includes('      Replace with: singularity-flow import preview "market:acme/web-e2e-v2" --as skill'));
  assert.ok(lines.includes('      Replace with: singularity-flow workflow from-agent acme/product-agent --review'));
  assert.doesNotMatch(lines.join('\n'), COMMIT_ID);
  // --newest: an item deprecated only in the newest commit says so, and is not counted as deprecated in use yet.
  const newer = analyzeMarketplaceCatalog(catalogInput({ newest: true }));
  const writer = newer.items.find((item) => item.key === 'market:acme/skill/requirements-writer');
  assert.deepEqual([writer.deprecatedInUse.newest, writer.lifecycle], [true, 'approved']);
  assert.match(writer.deprecatedInUse.words, /^Deprecated in the marketplace's newest commit; still used by the skill library\./u);
  assert.equal(newer.summary.deprecatedInUse, 2);
  // An older answer (no additions): nothing is flagged.
  assert.ok(analyzeMarketplaceCatalog({ ...catalogInput(), marketplaces: [] }).items.every((item) => item.deprecatedInUse === null));
});

test('VS Code\'s Marketplace page: Deprecated · in use here, its words, the tile and filter, and Replace with… opening the replacement\'s own review [OMK:REQ-041, REQ-042]', () => {
  const read = marketplaceCatalogFrom(JSON.parse(JSON.stringify(analyzeMarketplaceCatalog(catalogInput()))));
  const skill = read.items.find((item) => item.key === 'market:acme/skill/web-e2e');
  assert.deepEqual(skill.deprecatedInUse.replacement, { kind: 'skill', id: 'web-e2e-v2', marketplace: 'acme', offered: true, words: 'Use web-e2e-v2.' });
  assert.deepEqual(studioTargetFor('replace', skill)?.studio, { view: 'library', preview: { reference: 'market:acme/web-e2e-v2', replace: false } });
  const agent = read.items.find((item) => item.key === 'market:acme/agent/qa-agent');
  assert.deepEqual(studioTargetFor('replace', agent)?.studio, { view: 'library', agentWorkflow: { target: 'acme/product-agent', update: false } });
  assert.equal(studioTargetFor('replace', read.items.find((item) => item.key === 'market:acme/skill/web-e2e-v2')), null, 'no replacement, no button');
  const html = marketplacePageHtml({ catalog: read, busy: false, error: null, notice: null });
  const rowOf = (key) => html.split('<tr class="mkt-row"').find((part) => part.includes(`data-key="${key}"`)) ?? '';
  assert.match(rowOf('market:acme/skill/web-e2e'), /<span class="mkt-badge mkt-in-use">Deprecated · in use here<\/span>/u);
  assert.match(rowOf('market:acme/skill/web-e2e'), /<div class="mkt-words mkt-in-use-words">Deprecated by Web QA on 20 Nov 2026; still used by the skill library and workflow qa-tests\. Use web-e2e-v2\.<\/div>/u);
  assert.match(rowOf('market:acme/skill/web-e2e'), /data-act="replace" data-key="market:acme\/skill\/web-e2e"[^>]*>Replace with…<\/button>/u);
  assert.match(rowOf('here:workflow:qa-tests'), /data-act="replace"[^>]*>Replace with…<\/button>/u);
  assert.match(rowOf('market:acme/skill/web-e2e'), /data-in-use="1"/u);
  assert.match(html, /<div class="mkt-tile mkt-tile-in-use"><strong>2<\/strong><span>Deprecated in use<\/span><\/div>/u);
  assert.match(html, /<input type="checkbox" id="mkt-in-use"> Deprecated in use/u);
  assert.doesNotMatch(html, /\b[0-9a-f]{40}\b|[0-9a-f]{64}/u, 'no commit and no hash');
  const host = readFileSync(path.join(ROOT, 'apps/vscode/src/views/marketplace.ts'), 'utf8');
  assert.match(host, /'marketplace\.replace': \(message\) => this\.act\('replace', stringField\(message, 'key'\)\)/u);
});

test('the skill catalog and All skills: a deprecated library skill in use, its users, and Replace with… [OMK:REQ-041, REQ-042]', () => {
  const listed = (name, state, extra = {}) => ({ name, version: '1.0.0', description: `${name}.`, tags: ['web'], pdlcTasks: ['e2e-testing'], lifecycleState: state,
    owner: { name: 'Web QA', words: 'Owner: Web QA' }, lifecycleRecord: lifecycle(state, extra), findings: [] });
  const input = (marketplace) => ({ library: [{ id: 'web-e2e', label: 'web-e2e', description: '', tags: [], sha256: 'x' }],
    imports: { 'library-skill:web-e2e': { kind: 'library-skill', target: { id: 'web-e2e' }, sha256: 'x', source: { kind: 'marketplace-skill', marketplace: 'acme',
      entry: 'web-e2e', version: '1.0.0', tasks: ['e2e-testing'], tags: ['web'], lifecycleState: 'ga' } } },
    marketplaces: [marketplace], definition: structuredClone(BASE), kinds: ['web'],
    uses: new Map([['web-e2e', { agents: [{ id: 'reviewer', label: 'Reviewer', steps: [] }], workflows: [{ id: 'qa-tests', steps: [] }] }]]),
    openStories: [{ workId: 'S-9', workflow: 'other', skills: ['web-e2e'], sha256: [] }] });
  const catalog = analyzeSkillCatalog(input({ id: 'acme', label: 'Acme', kind: 'repository', warning: null,
    skills: [listed('web-e2e', 'deprecated', { replacedBy: 'web-e2e-v2' }), listed('web-e2e-v2', 'ga', { from: 'approved' })] }));
  const row = catalog.rows.find((entry) => entry.key === 'library:web-e2e');
  assert.deepEqual(row.deprecatedInUse.uses, { library: ['web-e2e'], agents: ['reviewer'], workflows: ['qa-tests'], openStories: ['S-9'] });
  assert.equal(row.deprecatedInUse.words, 'Deprecated by Web QA on 20 Nov 2026; still used by the skill library, agent reviewer, workflow qa-tests and 1 open Story. Use web-e2e-v2.');
  assert.deepEqual([row.deprecatedInUse.replacement.reference, row.actions.replace], ['market:acme/web-e2e-v2', 'singularity-flow import preview "market:acme/web-e2e-v2" --as skill --json']);
  assert.equal(catalog.rows.find((entry) => entry.key === 'market:acme/web-e2e').deprecatedInUse.words, row.deprecatedInUse.words, 'its marketplace row says the same');
  assert.equal(catalog.summary.deprecatedInUse, 1);
  const lines = skillCatalogLines(catalog);
  assert.ok(lines.some((line) => line.trim() === `In use: ${row.deprecatedInUse.words}`));
  assert.ok(lines.some((line) => line.trim() === 'Replace with: singularity-flow import preview "market:acme/web-e2e-v2" --as skill'));
  // Its marketplace could not be read: the state its import recorded counts, said so (here: ga, so nothing).
  const unread = analyzeSkillCatalog(input({ id: 'acme', label: 'Acme', kind: 'repository', warning: 'Marketplace acme could not be read.', skills: [] }));
  assert.equal(unread.rows.find((entry) => entry.key === 'library:web-e2e').deprecatedInUse, null);
  const page = skillCatalogFrom(JSON.parse(JSON.stringify(catalog)));
  const read = page.rows.find((entry) => entry.key === 'library:web-e2e');
  assert.deepEqual(read.deprecatedInUse.replacement, { id: 'web-e2e-v2', reference: 'market:acme/web-e2e-v2' });
  const html = allSkillsPageHtml({ catalog: page, busy: false, error: null, notice: null });
  assert.match(html, /<span class="ask-pill ask-in-use">Deprecated · in use here<\/span>/u);
  assert.match(html, /<button type="button" data-replace="library:web-e2e"[^>]*>Replace with…<\/button>/u);
  // Only a marketplace reference is ever previewed.
  const forged = JSON.parse(JSON.stringify(catalog));
  forged.rows.find((entry) => entry.key === 'library:web-e2e').deprecatedInUse.replacement.reference = 'https://elsewhere.example.test/skill';
  assert.equal(skillCatalogFrom(forged).rows.find((entry) => entry.key === 'library:web-e2e').deprecatedInUse.replacement, null);
  const host = readFileSync(path.join(ROOT, 'apps/vscode/src/views/all-skills.ts'), 'utf8');
  assert.match(host, /'allSkills\.replace': \(message\) => this\.replace\(stringField\(message, 'key'\)\)/u);
});

test('a task\'s plan line: a deprecated library skill is named where it would have fitted, with its replacement, which is offered when it fits [OMK:REQ-041, A4]', () => {
  const composition = composeTask(structuredClone(BASE), { kind: 'fix' });
  const code = composition.steps.find((step) => step.intent === 'code').id;
  const imported = { source: { kind: 'marketplace-skill', marketplace: 'acme', entry: 'web-e2e', tasks: ['e2e-testing'], tags: ['web'], lifecycleState: 'ga' } };
  const deprecated = librarySkillCandidate({ id: 'web-e2e', tags: [], sha256: 'x' }, imported, { trusted: { name: 'web-e2e', owner: { name: 'Web QA' },
    lifecycleRecord: lifecycle('deprecated', { replacedBy: 'web-e2e-v2' }) } });
  assert.deepEqual([deprecated.lifecycle, deprecated.state, deprecated.replacedBy], ['retired', 'deprecated', 'web-e2e-v2']);
  const v2 = marketplaceSkillCandidate({ name: 'web-e2e-v2', tags: ['web'], pdlcTasks: ['e2e-testing'], version: '2.0.0', owner: { name: 'Web QA' },
    lifecycleRecord: lifecycle('ga', { from: 'approved' }) }, 'acme');
  const chosen = chooseTaskSkills(composition, { candidates: [deprecated, v2], kinds: ['web'] });
  assert.deepEqual(chosen.skills, []);
  assert.deepEqual(chosen.offers.map((offer) => offer.id), ['web-e2e-v2']);
  assert.equal(planSkillWords(chosen.byStep[code]), ' (not web-e2e: it is deprecated by Web QA; web-e2e-v2 replaces it; with web-e2e-v2 from acme (Web QA), new here: add it?)');
  // For software the task does not touch it would not have fitted, so the plan line does not name it.
  assert.deepEqual(chooseTaskSkills(composition, { candidates: [deprecated], kinds: ['backend'] }).byStep, {});
  // The team's own workflow keeps a skill it attaches, and the plan line says so as §5.3 writes it.
  assert.equal(planSkillWords([{ id: 'web-e2e-test-generation', status: 'deprecated-attached', state: 'deprecated', owner: 'Web QA', replacedBy: 'web-e2e-test-generation-v2' }]),
    ' (web-e2e-test-generation is deprecated by Web QA: web-e2e-test-generation-v2 replaces it)');
  assert.equal(planSkillWords([{ id: 'old-checks', status: 'deprecated', state: 'retired', owner: null, replacedBy: null }]), ' (not old-checks: it is retired)');
});

test('inUseOf: every deprecated or retired item read, by marketplace, kind and name, only when something here uses it [OMK:REQ-041]', () => {
  const input = catalogInput();
  const found = inUseOf({ marketplaces: input.marketplaces, imports: input.imports, library: input.library.map((skill) => skill.id), workflows: input.workflows,
    attachments: input.attachments });
  assert.deepEqual(found.map((item) => [item.key, item.state, item.replacement?.id ?? null]),
    [['market:acme/agent/qa-agent', 'deprecated', 'product-agent'], ['market:acme/skill/web-e2e', 'deprecated', 'web-e2e-v2']]);
});

// ------------------------------------------------------------------------------------------------ as a person runs it

const WEB_PACKAGE = JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' }, dependencies: { react: '^18.3.1' } });

/**
 * The sample marketplace with web-e2e-test-generation deprecated (web-e2e-test-generation-v2 replaces it) and
 * qa-test-automation-agent deprecated (product-agent replaces it), as a Git repository.
 */
async function deprecatingMarketplace(t) {
  const directory = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'sflow-omk-in-use-market-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = await copySampleMarketplace(path.join(directory, 'acme'));
  const write = (relative, text) => writeFile(path.join(repository, relative), text);
  const replace = async (relative, pattern, text) => write(relative, (await readFile(path.join(repository, relative), 'utf8')).replace(pattern, text));
  await write('skills/web-e2e-test-generation/lifecycle.yml', YAML.stringify({ state: 'deprecated',
    deprecation: { 'replaced-by': 'web-e2e-test-generation-v2', reason: 'v2 uses role locators.', sunset: '2027-03-31' },
    history: [{ to: 'proposed', at: '2026-09-05', by: '@acme/web-qa' }, { from: 'proposed', to: 'approved', at: '2026-10-02', 'approved-by': [STEWARDS] },
      { from: 'approved', to: 'ga', at: '2026-11-01', 'approved-by': [STEWARDS] }, { from: 'ga', to: 'deprecated', at: '2026-11-20', 'approved-by': [STEWARDS] }] }));
  await replace('skills/web-e2e-test-generation/apm.yml', /^lifecycle-state: .*$/mu, 'lifecycle-state: deprecated');
  await write('agents/qa-test-automation-agent/lifecycle.yml', YAML.stringify({ state: 'deprecated', deprecation: { 'replaced-by': 'product-agent' },
    history: [{ to: 'proposed', at: '2026-09-16', by: '@acme/qa-guild' }, { from: 'proposed', to: 'approved', at: '2026-10-02', 'approved-by': [STEWARDS] },
      { from: 'approved', to: 'deprecated', at: '2026-11-22', 'approved-by': [STEWARDS] }] }));
  await replace('agents/qa-test-automation-agent/apm.yml', /^lifecycle-state: .*$/mu, 'lifecycle-state: deprecated');
  const v2 = path.join(repository, 'skills', 'web-e2e-test-generation-v2');
  await mkdir(v2, { recursive: true });
  await writeFile(path.join(v2, 'SKILL.md'), '---\nname: web-e2e-test-generation-v2\ndescription: Generate Playwright end-to-end tests with role locators.\n---\n\n# Web E2E tests, v2\n\nWrite Playwright tests that find elements by their role.\n');
  await writeFile(path.join(v2, 'apm.yml'), YAML.stringify({ name: 'web-e2e-test-generation-v2', version: '2.0.0', description: 'Generate Playwright end-to-end tests with role locators.',
    type: 'skill', tags: ['web', 'playwright'], 'pdlc-tasks': ['e2e-testing'], 'lifecycle-state': 'ga',
    owner: { team: 'web-qa', name: 'Web QA', handle: '@acme/web-qa', issues: 'https://git.example.com/acme/sdlc-marketplace/issues' } }));
  await writeFile(path.join(v2, 'lifecycle.yml'), YAML.stringify({ state: 'ga', history: [{ to: 'proposed', at: '2026-10-20', by: '@acme/web-qa' },
    { from: 'proposed', to: 'approved', at: '2026-11-02', 'approved-by': [STEWARDS] }, { from: 'approved', to: 'ga', at: '2026-11-15', 'approved-by': [STEWARDS] }] }));
  const manifest = YAML.parse(await readFile(path.join(repository, 'apm.yml'), 'utf8'));
  manifest.marketplace.packages.push({ name: 'web-e2e-test-generation-v2', description: 'Generate Playwright end-to-end tests with role locators.',
    source: './skills/web-e2e-test-generation-v2', include_prerelease: true });
  await writeFile(path.join(repository, 'apm.yml'), YAML.stringify(manifest));
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=Market Maintainer', '-c', 'user.email=maintainers@example.com', ...args], { cwd: repository, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'The marketplace deprecates web-e2e-test-generation and qa-test-automation-agent');
  return { directory, repository, commit: git('rev-parse', 'HEAD') };
}

const textOf = (node) => [node.textContent ?? node.text ?? '', ...(node.children ?? []).map(textOf)].join(' ').replace(/\s+/gu, ' ');
const nodes = (node) => [node, ...(node.children ?? []).flatMap(nodes)];

/** Workflow Studio's page script with a document just big enough to render, and what it posts. */
function studio(model) {
  const listeners = {};
  const posted = [];
  const element = (tag) => ({ tag, attributes: {}, children: [], style: {}, handlers: {}, textContent: '',
    setAttribute(name, value) { this.attributes[name] = value; }, appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, handler) { this.handlers[type] = handler; } });
  const window = { __sfVscode: { postMessage: (message) => posted.push(message) }, addEventListener(type, listener) { listeners[type] = listener; } };
  new Function('window', 'document', WORKFLOW_STUDIO_SCRIPT)(window, { getElementById: () => null, querySelector: () => null, createElement: element, createTextNode: (text) => ({ text }) });
  listeners.message({ data: { type: 'studio.model', model } });
  return { page: window.__workflowStudio, posted };
}

test('as a person runs it: check says not checked until a listing is kept, then warns from it offline; the catalog, the plan, Studio, a session\'s start and a Story\'s start say it; nothing is removed [OMK §8, A9]', async (t) => {
  const acme = await deprecatingMarketplace(t);
  const e2eText = readFileSync(path.join(SAMPLE_MARKETPLACE, 'skills/web-e2e-test-generation/SKILL.md'), 'utf8');
  const story = await journeyRepository(t, {
    files: {
      'package.json': WEB_PACKAGE,
      'singularity/skill-library/web-e2e-test-generation/SKILL.md': e2eText,
      'singularity/imports.lock.yml': YAML.stringify({ version: 1, imports: {
        'library-skill:web-e2e-test-generation': { kind: 'library-skill', target: { id: 'web-e2e-test-generation', path: 'singularity/skill-library/web-e2e-test-generation/SKILL.md' },
          sha256: sha(e2eText), source: { kind: 'marketplace-skill', marketplace: 'acme', repository: acme.repository, commit: acme.commit, entry: 'web-e2e-test-generation',
            version: '1.0.0-pdlc', tasks: ['e2e-testing', 'ui-test-automation'], tags: ['web', 'playwright'], lifecycleState: 'ga' } },
        // The team's workflow made from the marketplace's agent (MCR's record), deprecated since.
        'workflow:qa-tests': { kind: 'workflow', workflow: 'qa-tests', source: { kind: 'marketplace-agent', marketplace: 'acme', repository: acme.repository, commit: acme.commit,
          agent: 'qa-test-automation-agent', version: '1.0.0-pdlc' } } } })
    },
    configure: (configuration) => {
      configuration.marketplaces = { acme: { label: 'Acme', repository: acme.repository, commit: acme.commit } };
      configuration.workTypes['qa-tests'] = { label: 'QA tests', phases: ['intake', 'implementation', 'verification', 'conformance'] };
      configuration.workTypes['web-checks'] = { label: 'Web checks', phases: ['intake', 'implementation', 'verification', 'conformance'] };
    }
  });
  // The team's workflow attaches the skill: written once the workflow exists (init checks every attachment's workflow).
  await story.write('singularity/skill-library/attachments.yml', YAML.stringify({ attachments: [{ skill: 'web-e2e-test-generation', workflow: 'qa-tests', steps: ['implementation'] },
    { skill: 'web-e2e-test-generation', workflow: 'web-checks', steps: ['implementation'] }] }));
  story.git('add', '-A');
  story.git('commit', '-qm', 'Attach web-e2e-test-generation to QA tests');
  story.git('push', '-q', 'origin', 'main');
  story.git('push', '-q', 'origin', 'main:sflow/config');
  const checkData = () => { const result = json(story.cli('check', '--json')); return { result, data: result.data ?? result }; };

  // Nothing kept yet: check never reads the marketplace, and says what it did not check, with the read that keeps it.
  const first = checkData();
  assert.deepEqual(first.data.marketplaceInUse.items, []);
  assert.match(first.data.marketplaceInUse.notChecked[0].words, /^Not checked: what marketplace Acme deprecated or retired, because its list of items at the commit trusted here is not on this computer yet\.$/u);
  assert.ok(JSON.stringify(first.result).includes('singularity-flow marketplace catalog --marketplace acme'));
  const keptFile = path.join(story.root, '.git', 'singularity-flow', 'marketplace-in-use.json');
  assert.deepEqual(JSON.parse(await readFile(keptFile, 'utf8')).items, [], 'nothing found, nothing for a session to say');

  // The catalog reads the marketplace at the commit trusted here, flags both, offers each replacement, and keeps what it found.
  const catalog = json(story.cli('marketplace', 'catalog', '--json'));
  const byKey = new Map(catalog.items.map((item) => [item.key, item]));
  const skill = byKey.get('market:acme/skill/web-e2e-test-generation');
  assert.deepEqual([skill.status, skill.deprecatedInUse.state, skill.deprecatedInUse.uses.library, skill.deprecatedInUse.uses.workflows],
    ['installed', 'deprecated', ['web-e2e-test-generation'], ['qa-tests', 'web-checks']]);
  assert.equal(skill.deprecatedInUse.words, 'Deprecated by Web QA on 20 Nov 2026 (supported until 31 Mar 2027); still used by the skill library and 2 workflows. Use web-e2e-test-generation-v2.');
  assert.equal(skill.actions.replace.command, 'singularity-flow import preview "market:acme/web-e2e-test-generation-v2" --as skill --json');
  const agent = byKey.get('market:acme/agent/qa-test-automation-agent');
  assert.deepEqual([agent.deprecatedInUse.uses.workflows, agent.actions.replace.command], [['qa-tests'], 'singularity-flow workflow from-agent acme/product-agent --review']);
  assert.equal(catalog.summary.deprecatedInUse, 2);
  assert.doesNotMatch(JSON.stringify(catalog), COMMIT_ID);
  const text = story.cli('marketplace', 'catalog');
  assert.match(text, /^ {6}In use: Deprecated by Web QA on 20 Nov 2026 \(supported until 31 Mar 2027\); still used by the skill library and 2 workflows\. Use web-e2e-test-generation-v2\.$/mu);
  assert.match(text, /^ {6}Replace with: singularity-flow workflow from-agent acme\/product-agent --review$/mu);

  // From here on the marketplace cannot be reached: everything below reads what was kept.
  await rename(acme.repository, `${acme.repository}-away`);
  const offline = checkData();
  assert.deepEqual(offline.data.marketplaceInUse.items.map((item) => [item.key, item.state]),
    [['market:acme/agent/qa-test-automation-agent', 'deprecated'], ['market:acme/skill/web-e2e-test-generation', 'deprecated']]);
  assert.deepEqual(offline.data.marketplaceInUse.notChecked, []);
  const said = JSON.stringify(offline.result);
  assert.ok(said.includes('Warning: skill web-e2e-test-generation is deprecated, still used here'));
  assert.ok(said.includes('singularity-flow import preview \\"market:acme/web-e2e-test-generation-v2\\" --as skill'));
  assert.ok(said.includes('Warning: agent qa-test-automation-agent is deprecated, still used here'));

  // A Copilot session's start says it once, from what was kept.
  const started = story.raw(['hook', 'session-start'], { input: JSON.stringify({ cwd: story.root, sessionId: 'in-use-kept', source: 'startup' }) });
  assert.equal(started.status, 0, started.stderr);
  assert.match(json(started.stdout).additionalContext, /Tell the person this once, in plain words, before other work; never change or remove what it names without their yes: Still used here, though its marketplace deprecated or retired it: agent qa-test-automation-agent \(deprecated; use product-agent\) and skill web-e2e-test-generation \(deprecated; use web-e2e-test-generation-v2\)\. Nothing was changed\./u);

  // A task's plan: the deprecated library skill is not used; its replacement, from the kept listing, is offered.
  const plan = json(story.cli('work', 'fix the checkout button', '--kind', 'fix', '--json'));
  assert.match(plan.plan, /\(not web-e2e-test-generation: it is deprecated by Web QA; web-e2e-test-generation-v2 replaces it; with web-e2e-test-generation-v2 from acme \(Web QA\), new here: add it\?\)/u);
  assert.equal(plan.skills, undefined);
  assert.deepEqual(plan.offers.map((offer) => offer.id), ['web-e2e-test-generation-v2']);

  // The team's own workflow as the plan runs as it is: the plan line names the deprecated skill it attaches. (A workflow
  // made from a marketplace agent is that agent's plan, which a task never offers once it is deprecated.)
  const definition = await loadDefinition(story.root);
  const own = await taskSkillChooser(story.root, definition)(composeTask(definition, { kind: 'fix', workflow: { workflow: 'web-checks' } }));
  assert.deepEqual([own.skills, own.offers], [[], []]);
  assert.equal(planSkillWords(own.byStep.implementation), ' (web-e2e-test-generation is deprecated by Web QA: web-e2e-test-generation-v2 replaces it)');

  // Workflow Studio's view of the workflow: both, and Make a workflow from the replacement opens the agent's conversion review.
  const model = json(story.cli('workflow', 'studio', '--json'));
  const quick = model.workflows.find((workflow) => workflow.id === 'qa-tests');
  assert.deepEqual(quick.deprecatedInUse.map((item) => [item.kind, item.id, item.replacement]), [
    ['agent', 'qa-test-automation-agent', { kind: 'agent', id: 'product-agent', target: 'acme/product-agent' }],
    ['skill', 'web-e2e-test-generation', { kind: 'skill', id: 'web-e2e-test-generation-v2', reference: 'market:acme/web-e2e-test-generation-v2' }]]);
  assert.deepEqual(model.workflows.find((workflow) => workflow.id === 'web-checks').deprecatedInUse.map((item) => item.id), ['web-e2e-test-generation']);
  assert.ok(model.workflows.filter((workflow) => !['qa-tests', 'web-checks'].includes(workflow.id)).every((workflow) => !workflow.deprecatedInUse));
  const { page, posted } = studio(model);
  const notes = page.inUseNotes('qa-tests');
  assert.equal(notes.length, 2);
  assert.match(textOf(notes[0]), /Workflow QA tests was made from agent qa-test-automation-agent of marketplace Acme, which is deprecated by QA Guild on 22 Nov 2026; it runs as it is\./u);
  nodes(notes[0]).find((node) => node.tag === 'button' && textOf(node).trim() === 'Make a workflow from the replacement').handlers.click();
  assert.deepEqual(posted.at(-1), { type: 'studio.agentWorkflowPreview', target: 'acme/product-agent', answers: {} });
  nodes(notes[1]).find((node) => node.tag === 'button' && textOf(node).trim() === 'Preview the replacement').handlers.click();
  assert.deepEqual(posted.at(-1), { type: 'studio.importPreview', reference: 'market:acme/web-e2e-test-generation-v2', as: 'skill' });

  // A Story's start line: the workflow runs as it is, and the line names the way to the replacement.
  const start = startStory(story, 'S-1', { workType: 'qa-tests', title: 'Change the value', description: 'Return 2.' });
  assert.match(start, /^Readiness advisory: Workflow QA tests was made from agent qa-test-automation-agent of marketplace Acme, which is deprecated by QA Guild on 22 Nov 2026; it runs as it is\. Its replacement is product-agent: singularity-flow workflow from-agent acme\/product-agent --review$/mu);
  assert.match(start, /^Readiness advisory: Workflow QA tests attaches skill web-e2e-test-generation of marketplace Acme, which is deprecated by Web QA on 20 Nov 2026; it runs as it is\. Its replacement is web-e2e-test-generation-v2: singularity-flow import preview "market:acme\/web-e2e-test-generation-v2" --as skill$/mu);
  // The open Story counts as a use; nothing was removed or changed.
  const during = checkData();
  for (const item of during.data.marketplaceInUse.items) assert.deepEqual(item.words.includes('1 open Story'), true, item.key);
  assert.equal(await story.read('singularity/skill-library/web-e2e-test-generation/SKILL.md'), e2eText, 'it stays in the library');
  assert.match(await story.read('singularity/imports.lock.yml'), /workflow:qa-tests/u);
  await rename(`${acme.repository}-away`, acme.repository);
});
