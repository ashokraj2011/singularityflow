import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sidebarBody } from '../apps/vscode/src/views/sidebar-page.ts';
import { codeOnly } from './source-text.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const view = overrides => ({ navigation: { workspace: { name: 'Workspace', repository: 'repo' }, next: null },
  freshness: null, loading: false, pending: null, active: null, favorites: [], ...overrides });
const menu = html => html.split('<details class="main-menu"')[1].split('</details>')[0];
const switchRow = html => menu(html).match(/<button[^>]*data-action="prompt-log-toggle"[\s\S]*?<\/button>/)?.[0] ?? null;

test('the main menu shows the prompt log as a labelled switch with its state in words', () => {
  const on = switchRow(sidebarBody(view({ promptLog: 'on' })));
  assert.match(on, /role="switch" aria-checked="true"/);
  assert.match(on, /<span class="nav-label">Prompt log<\/span><span class="switch-state">On<\/span>/);
  assert.match(on, /class="switch-track on" aria-hidden="true"/);

  const off = switchRow(sidebarBody(view({ promptLog: 'off' })));
  assert.match(off, /aria-checked="false"/);
  assert.match(off, /<span class="switch-state">Off<\/span>/);
  assert.doesNotMatch(off, /disabled/);

  // While the host reads or changes the setting the switch says so instead of guessing.
  const checking = switchRow(sidebarBody(view({ promptLog: null })));
  assert.match(checking, /<span class="switch-state">Checking…<\/span>/);
  assert.match(checking, / disabled>/);

  // A failed read stays clickable: the command reports the real reason.
  const unavailable = switchRow(sidebarBody(view({ promptLog: 'unavailable' })));
  assert.match(unavailable, /<span class="switch-state">Unavailable<\/span>/);
  assert.doesNotMatch(unavailable, /disabled/);

  assert.equal(switchRow(sidebarBody(view())), null, 'no repository, no prompt log switch');
});

test('the switch does the opposite of what it shows, and is read only after a confirmed snapshot', async () => {
  const [sidebar, extension, manifest] = await Promise.all([
    readFile(path.join(root, 'apps/vscode/src/views/sidebar.ts'), 'utf8'),
    readFile(path.join(root, 'apps/vscode/src/extension.ts'), 'utf8').then(codeOnly),
    readFile(path.join(root, 'apps/vscode/package.json'), 'utf8').then(JSON.parse)
  ]);
  assert.match(sidebar, /'prompt-log-toggle': 'singularityFlow\.togglePromptLog'/);
  assert.ok(manifest.contributes.commands.some(entry => entry.command === 'singularityFlow.togglePromptLog'));

  const toggle = extension.slice(extension.indexOf("'singularityFlow.togglePromptLog': async () =>"),
    extension.indexOf('showRefusal(error, { headline: \'Could not change the prompt log\' })'));
  // A switch does the opposite of what it shows; it reads the setting only when it shows nothing certain.
  assert.match(toggle, /const shown = sidebar\.promptLogState;/);
  assert.match(toggle, /const enable = shown === 'on' \? false : shown === 'off' \? true\s*: !\(await client\.run<\{ enabled: boolean \}>\(\['prompt-log', 'status', '--json'\]\)\)\.enabled;/);
  assert.match(toggle, /\['prompt-log', enable \? 'on' : 'off', '--json'\]/);
  assert.match(toggle, /if \(!repositoryEpoch\.isCurrent\(scope\)\) return;/,
    'a result for a repository the window has left must not repaint the switch');

  const auxiliary = extension.slice(extension.indexOf('const startAuxiliaryReadsAfterConfirmedSnapshot'),
    extension.indexOf('const discover = ()', extension.indexOf('const startAuxiliaryReadsAfterConfirmedSnapshot')));
  assert.match(auxiliary, /void refreshPromptLog\(scope\);/, 'status is read once per confirmed repository, off the activation path');
  assert.match(extension, /client\.useRepository\(canonicalTarget\);\s*sidebar\.setPromptLog\(null\);/,
    'a workspace switch must not keep showing the previous repository\'s setting');
});
