import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (name) => path.join(packageRoot, 'apps', 'vscode', 'src', name);
const { EMPTY_MAP_FORM, MAP_CAPABILITY_SCRIPT, mapCapabilityHtml, mapCommand, mapProblems } = await import(pathToFileURL(source('views/map-capability-form.ts')).href);
const { capabilityArgv, capabilityDetail } = await import(pathToFileURL(source('views/capability-model.ts')).href);
const { bodyHtml, readEdits } = await import(pathToFileURL(source('views/capability-page.ts')).href);

const APP_ID_PROBLEM = 'An App ID cannot contain spaces and has at most 64 characters.';
const form = (overrides = {}) => ({
  ...EMPTY_MAP_FORM,
  lead: 'https://git.example/platform.git', loaded: true,
  capabilityId: 'payments', repositoryUrl: 'https://git.example/platform.git',
  inspectionStatus: 'not-onboarded', inspectionComplete: true,
  inspectionBoundRepositoryUrl: 'https://git.example/platform.git',
  inspectionBoundLeadUrl: 'https://git.example/platform.git',
  ...overrides
});

test('Map a capability offers an App ID beside Jira and Teams and sends it only when typed', () => {
  assert.deepEqual(mapProblems(form()), []);
  assert.equal(mapCommand(form()).includes('--app-id'), false);
  const typed = form({ appId: ' APP-1234 ' });
  assert.deepEqual(mapProblems(typed), []);
  const command = mapCommand(typed);
  assert.equal(command[command.indexOf('--app-id') + 1], 'APP-1234');
  assert.match(mapCapabilityHtml(typed), /<label>App ID <input type="text" value=" APP-1234 " data-map="appId"/);
  assert.ok(mapProblems(form({ appId: 'APP 1234' })).includes(APP_ID_PROBLEM));
  assert.ok(mapProblems(form({ appId: 'x'.repeat(65) })).includes(APP_ID_PROBLEM));
  // Typed values are recorded without a redraw, so the page checks the App ID itself: a corrected
  // value must clear its problem and unblock the proposal without waiting for another render.
  const spaced = mapCapabilityHtml(form({ appId: 'APP 1234' }));
  assert.match(spaced, /<li data-map-app-id-problem>An App ID cannot contain spaces/);
  assert.doesNotMatch(spaced, /data-map-static-problem>An App ID/);
  assert.match(mapCapabilityHtml(typed), /<li data-map-app-id-problem hidden><\/li>/);
  assert.match(MAP_CAPABILITY_SCRIPT, /dataset\?\.map === 'appId'\) syncAppIdValidation/);
  // A literal, not an interpolation: a computed template keeps the whole script in every bundle.
  assert.ok(MAP_CAPABILITY_SCRIPT.includes(`'${APP_ID_PROBLEM}'`), 'the page and the panel say the same thing');
  assert.doesNotThrow(() => new Function(MAP_CAPABILITY_SCRIPT));
});

test('every option the Map form sends is one a saved mapping can be restored with', async () => {
  const panel = await readFile(source('views/bootstrap-panel.ts'), 'utf8');
  const declared = panel.match(/const MAP_SINGLE_VALUE_OPTIONS = new Set\(\[([\s\S]*?)\]\);/u)?.[1];
  assert.ok(declared, 'the panel names the options it restores');
  const restorable = new Set([...declared.matchAll(/'(--[a-z-]+)'/gu)].map((match) => match[1]));
  const everything = form({
    name: 'Payments', parent: 'commerce', sourceRoots: 'src', sharedRoots: 'shared',
    sourceHashExcludedRoots: 'generated', testConfigurationPaths: 'test/app.yml',
    cloneMode: 'blobless-sparse', sparseCone: 'src', cloneFallback: 'refuse',
    metadata: [{ key: 'tier', value: '1' }], jiraProject: 'PAY', appId: 'APP-1', teams: 'Payments'
  });
  const sent = mapCommand(everything).slice(3).filter((value) => value.startsWith('--'));
  assert.ok(sent.includes('--app-id'));
  for (const flag of sent.filter((value) => value !== '--json' && value !== '--metadata')) {
    assert.ok(restorable.has(flag), `${flag} is sent, so a saved mapping holding it must be restorable`);
  }
});

const tree = [{
  id: 'payments', name: 'Payments', kind: 'collection', delivery: false, repository: null,
  metadata: {}, jira: { projectKey: 'PAY' }, appId: 'APP-1001', teams: [], owns: [],
  policy: {}, effectivePolicy: {}, children: []
}];

test('the capability page shows and edits the App ID through capability set --app-id', () => {
  assert.equal(capabilityDetail(tree, 'payments').appId, 'APP-1001');
  const html = bodyHtml(tree, 'payments', null);
  assert.match(html, /<th>Jira<\/th><th>App ID<\/th><th>Teams<\/th>/);
  assert.match(html, /<code>APP-1001<\/code>/);
  assert.match(html, /value="APP-1001" data-field="appId"/);
  assert.equal(readEdits({ appId: 'APP-2002', unknown: 'x' }).appId, 'APP-2002');
  const argv = capabilityArgv('set', 'payments', { appId: ' APP-2002 ' });
  assert.equal(argv[argv.indexOf('--app-id') + 1], 'APP-2002');
  const cleared = capabilityArgv('set', 'payments', { appId: '' });
  assert.equal(cleared[cleared.indexOf('--app-id') + 1], '', 'an emptied field clears the App ID');
  assert.equal(capabilityDetail([{ ...tree[0], appId: undefined }], 'payments').appId, null);
});

test('the capability page shows and sends what a plain chat may do with secrets', () => {
  const tree = (declared, effective) => [{ id: 'payments', name: 'Payments', kind: 'delivery', policy: declared, effectivePolicy: effective, children: [] }];
  const detail = (declared, effective) => capabilityDetail(tree(declared, effective), 'payments');
  assert.deepEqual(detail({}, {}).plainChatSecrets, { declared: null, effective: 'refuse' }, 'refused when nothing says otherwise');
  assert.deepEqual(detail({}, { plainChatSecrets: 'allow' }).plainChatSecrets, { declared: null, effective: 'allow' }, 'an ancestor can allow');
  assert.deepEqual(detail({ plainChatSecrets: 'refuse' }, { plainChatSecrets: 'refuse' }).plainChatSecrets, { declared: 'refuse', effective: 'refuse' });
  const argv = capabilityArgv('set', 'payments', { plainChatSecrets: 'allow' });
  assert.equal(argv[argv.indexOf('--plain-chat-secrets') + 1], 'allow');
  assert.equal(capabilityArgv('set', 'payments', { name: 'Payments' }).includes('--plain-chat-secrets'), false);
});
