import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { findingsImportArgv, findingsListArgv, findingsListFrom, importSummary } from '../apps/vscode/src/views/findings-model.ts';
import { FINDINGS_FORMAT, FINDINGS_SCRIPT, findingsPageHtml } from '../apps/vscode/src/views/findings-page.ts';
import { COLUMNS } from '../src/findings/register/format.mjs';

// CQF:REQ-070 in VS Code: the Findings view (Security and TLM tabs, due dates, the Story addressing each
// item) and the "Upload security or TLM findings…" command. Made-up items.

const list = findingsListFrom({
  location: 'state-branch', repository: 'example-org/orders-api', state: 'active', total: 3,
  lastImport: { importId: 'IMP-20261108T100000-abcdef', at: '2026-11-08T10:00:00.000Z', source: 'security-team', file: 'findings.xlsx' },
  items: [
    { id: 'SEC-11', feed: 'security', state: 'in-story', stateLabel: 'In a Story', severity: 'high', dueAt: '2026-11-01', label: '<img src=x onerror=alert(1)>', story: 'ORD-1', file: 'src/orders.js', line: 9, repository: 'orders-api', source: 'security-team' },
    { id: 'SEC-12', feed: 'security', state: 'open', stateLabel: 'Open', severity: 'medium', dueAt: '2027-01-15', label: 'Weak hash', story: null, repository: 'orders-api', source: 'security-team' },
    { id: 'TLM-21', feed: 'tlm', state: 'open', stateLabel: 'Open', severity: null, dueAt: '2026-10-01', label: 'express 4.18.2 → 5.1.0', story: null, component: 'express', currentVersion: '4.18.2', targetVersion: '5.1.0', endOfLifeAt: '2026-09-30', repository: 'orders-api', source: 'tlm-owners' }
  ]
});
const view = (overrides = {}) => ({ list, tab: 'security', all: false, busy: false, error: null, notice: null, today: '2026-11-08', ...overrides });

test('the Security tab shows each finding with its due date, state and the Story that addresses it; text is data', () => {
  const html = findingsPageHtml(view());
  assert.match(html, /data-tab="security"\s+aria-selected="true"/u);
  assert.match(html, /Security <span class="sf-tag">2<\/span>/u);
  assert.match(html, /TLM <span class="sf-tag">1<\/span>/u);
  assert.match(html, /<tr data-finding="SEC-11"[\s\S]*class="fnd-overdue"[^>]*>2026-11-01<\/td>[\s\S]*In a Story<\/td><td><code>ORD-1<\/code>/u, 'past its due date, and in Story ORD-1');
  assert.ok(!html.includes('<img src=x'), 'a label never becomes markup');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.match(html, /<button type="button" data-upload>Upload security or TLM findings…<\/button>/u);
  assert.match(html, /Last import IMP-20261108T100000-abcdef from security-team/u);
});

test('the TLM tab shows component, versions, end of life and due date', () => {
  const html = findingsPageHtml(view({ tab: 'tlm' }));
  assert.match(html, /data-findings-table="tlm"/u);
  assert.match(html, /<td>express<\/td>\s*<td>4\.18\.2 → 5\.1\.0<\/td><td>2026-09-30<\/td>/u);
  assert.ok(!html.includes('data-finding="SEC-12"'));
  assert.match(findingsPageHtml(view({ list: { ...list, items: [], location: 'none' } })), /Nothing has been imported/u);
});

test('the page posts tab, upload, template, refresh and include-closed; the commands run the CLI\'s own import and list', () => {
  for (const type of ['findings.tab', 'findings.upload', 'findings.template', 'findings.refresh', 'findings.all']) assert.ok(FINDINGS_SCRIPT.includes(`'${type}'`), type);
  assert.ok(FINDINGS_SCRIPT.includes('window.__sfVscode') && !FINDINGS_SCRIPT.includes('acquireVsCodeApi'));
  assert.deepEqual(findingsImportArgv('/tmp/x.csv', 'tlm'), ['findings', 'import', '/tmp/x.csv', '--feed', 'tlm', '--json']);
  assert.deepEqual(findingsListArgv(true), ['findings', 'list', '--state', 'all', '--limit', '2000', '--json']);
  assert.equal(importSummary({ importId: 'IMP-1', file: { name: 'a.xlsx' }, source: 'upload', rejected: [], ignoredSheets: [], store: 'state-branch',
    storeMessage: 'This remote is treated as private.', feeds: { security: { imported: 4, added: 3, updated: 1, rejected: 1, otherRepositories: 0 } } }),
  'Security: 4 imported (3 new, 1 updated), 1 rejected. This remote is treated as private.');
});

test('both commands are contributed, are repository commands with handlers, and load lazily', async () => {
  const manifest = JSON.parse(await readFile(new URL('../apps/vscode/package.json', import.meta.url), 'utf8'));
  const titles = Object.fromEntries(manifest.contributes.commands.map((command) => [command.command, command.title]));
  assert.equal(titles['singularityFlow.findings'], 'Singularity Flow: Findings');
  assert.equal(titles['singularityFlow.uploadFindings'], 'Singularity Flow: Upload security or TLM findings…');
  const extension = await readFile(new URL('../apps/vscode/src/extension.ts', import.meta.url), 'utf8');
  const repositoryCommands = extension.slice(extension.indexOf('const REPOSITORY_COMMANDS = ['), extension.indexOf('];', extension.indexOf('const REPOSITORY_COMMANDS = [')));
  assert.ok(repositoryCommands.includes("'singularityFlow.findings', 'singularityFlow.uploadFindings'"));
  assert.match(extension, /'singularityFlow\.uploadFindings': async \(\) => \{\n\s+const \{ uploadFindings, FindingsPanel, findingsImportSummary \} = lazyPanels\(\);/u);
  const lazy = await readFile(new URL('../apps/vscode/src/lazy-panels-runtime.ts', import.meta.url), 'utf8');
  assert.match(lazy, /export \{ FindingsPanel, uploadFindings \} from '\.\/views\/findings\.ts';/u);
});

// A person with nothing imported yet needs the file's shape before the upload, in the page itself.
test('the page says what to upload, with the importer\'s own columns, and what the example workbook is', async () => {
  for (const feed of ['security', 'tlm']) {
    assert.deepEqual([...FINDINGS_FORMAT[feed].required], COLUMNS[feed].filter((column) => column.required).map((column) => column.header), `${feed} required`);
    assert.deepEqual([...FINDINGS_FORMAT[feed].optional], COLUMNS[feed].filter((column) => !column.required).map((column) => column.header), `${feed} optional`);
  }
  const empty = findingsPageHtml(view({ list: { ...list, items: [], lastImport: null, location: 'state-branch' } }));
  assert.match(empty, /<details class="fnd-format" data-findings-format open><summary>What to upload: the file format<\/summary>/u, 'open while nothing is imported');
  assert.match(empty, /sheet named <strong>Security<\/strong>, a sheet named <strong>TLM<\/strong>/u);
  assert.match(empty, /<tr><td>Security<\/td><td><code>ID<\/code>, <code>Title<\/code>, <code>Severity<\/code>, <code>Repository<\/code><\/td>/u);
  assert.match(empty, /<tr><td>TLM<\/td><td><code>ID<\/code>, <code>Component<\/code>, <code>Repository<\/code>, <code>Target version<\/code><\/td>/u);
  assert.match(empty, /data-template title="[^"]+">Save an example workbook…<\/button>/u);
  assert.match(empty, /<strong>Save an example workbook…<\/strong> writes an <code>\.xlsx<\/code> in this format/u);
  assert.match(empty, /data-findings-empty>Nothing has been imported for this repository\./u, 'an empty state branch is nothing imported, not an empty tab');
  assert.match(findingsPageHtml(view()), /<details class="fnd-format" data-findings-format><summary>/u, 'closed once items are shown');
  assert.match(findingsPageHtml(view({ list: { ...list, items: list.items.filter((item) => item.feed === 'security') }, tab: 'tlm' })),
    /data-findings-empty>No open TLM items for this repository\./u);
  const panel = await readFile(new URL('../apps/vscode/src/views/findings.ts', import.meta.url), 'utf8');
  assert.match(panel, /title: 'Save an example findings workbook'[\s\S]{0,200}'sflow-findings-example\.xlsx'/u);
});
