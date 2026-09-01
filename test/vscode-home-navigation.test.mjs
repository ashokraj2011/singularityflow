import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (...parts) => path.join(root, 'apps', 'vscode', 'src', ...parts);
const { buildLifecycleTree } = await import(source('views', 'tree-model.ts'));
const { RESULT_CARD_SCRIPT } = await import(source('views', 'result-card-page.ts'));

test('Lifecycle does not render duplicate My Work or display-only workflow menus', () => {
  const roots = buildLifecycleTree({
    initiative: null,
    initiatives: [],
    workItems: [],
    definition: { workTypes: { feature: { label: 'Feature', phases: ['intake', 'implementation'] } } },
    portfolio: { initiativeProfiles: { epic: { label: 'Epic planning', phases: ['define', 'plan'] } } }
  });
  assert.deepEqual(roots.map((node) => node.id), ['no-initiative', 'start-intake', 'workspace:impact']);
  assert.equal(roots.some((node) => node.id === 'developer-home'), false);
  assert.equal(roots.some((node) => node.id === 'workflows'), false);
});

test('Talk to SFlow remains a compatible hidden alias while My Work is the visible command', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'apps', 'vscode', 'package.json'), 'utf8'));
  const hidden = manifest.contributes.menus.commandPalette.find(
    (entry) => entry.command === 'singularityFlow.openDeveloperHome'
  );
  assert.equal(hidden?.when, 'false');
  assert.ok(manifest.contributes.commands.some((entry) => entry.command === 'singularityFlow.myWork'));

  const extension = await readFile(source('extension.ts'), 'utf8');
  assert.match(extension,
    /'singularityFlow\.openDeveloperHome':[^;]*executeCommand\('singularityFlow\.myWork'\)/s);
});

test('My Work results provide Back history and a direct route home', async () => {
  assert.match(RESULT_CARD_SCRIPT, /data-result-nav/);
  assert.match(RESULT_CARD_SCRIPT, /result\.back/);
  assert.match(RESULT_CARD_SCRIPT, /result\.home/);

  const panel = await readFile(source('views', 'result-panel.ts'), 'utf8');
  assert.match(panel, /'result\.back':/);
  assert.match(panel, /'result\.home':/);
  assert.match(panel, /history\.pop\(\)/);
  assert.match(panel, /executeCommand\('singularityFlow\.myWork'\)/);

  const extension = await readFile(source('extension.ts'), 'utf8');
  assert.match(extension, /historyMode: 'push'/);
  assert.match(extension, /historyMode: 'replace'/);
});

test('Auto card actions are validated against the rendered card and only prefilled', async () => {
  assert.match(RESULT_CARD_SCRIPT, /sflow\.auto\.action/);
  const panel = await readFile(source('views', 'result-panel.ts'), 'utf8');
  assert.match(panel, /current\.auto\.flatMap\(\(card\) => card\.actions\)/);
  assert.match(panel, /binding\.epoch !== repositoryBinding\?\.epoch/);
  const extension = await readFile(source('extension.ts'), 'utf8');
  assert.match(extension, /onAutoResultAction/);
  assert.match(extension, /name: 'Singularity Flow Auto review', cwd: repositoryRoot/);
  assert.match(extension, /terminal\.sendText\(command, false\)/);
  assert.doesNotMatch(extension, /onAutoResultAction[\s\S]{0,500}terminal\.sendText\(command, true\)/);
});
