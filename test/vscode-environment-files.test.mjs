/**
 * Environment files in VS Code: the page's rows, the actions each status offers, the exact argv of
 * every `env files` command, the run pre-flight, and the entries from Run & test and the Run/Debug
 * Configurations editor. [docs/SPEC-ENVIRONMENT-FILES-v1.md, milestone 2]
 *
 * The fixtures have the shape the spec's command table gives `env files --json`: per file
 * { repository, app, environment, path, kind, template, source, location, status, excluded }.
 * Everything here is pure: no `vscode`, no process, no file is read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (name) => path.join(root, 'apps', 'vscode', 'src', name);
const model = await import(source('views/environment-files-model.ts'));
const { environmentFilesHtml, ENVIRONMENT_FILES_SCRIPT, ENVIRONMENT_FILES_STYLE } = await import(source('views/environment-files-page.ts'));
const runModel = await import(source('views/run-and-test-model.ts'));
const { runAndTestHtml } = await import(source('views/run-and-test-page.ts'));
const { tabsRegionHtml } = await import(source('views/run-configurations-page.ts'));
const { commandClass } = await import(source('cli/client.ts'));

const STORE = '/Users/someone/shop/.git/singularity-flow/environment-files/v1';
/** A secret a real file could hold; it must never reach a row, the page or a message. */
const SECRET = 'Zk3q9Vb7Lp2Xw8Rt5Ny1Hc6Md4Gs0Jf';
const file = (overrides = {}) => ({
  repository: 'shop', app: 'payments-api', environment: 'dev', path: 'services/api/src/main/resources/application-dev.yml', kind: 'declared',
  template: 'services/api/src/main/resources/application-dev.example.yml', source: 'store',
  location: `${STORE}/dev/services/api/src/main/resources/application-dev.yml`, status: 'placed-here', excluded: true, ...overrides
});
const FILES = [
  file(),
  file({ app: 'payments-web', path: 'apps/web/.env.dev', template: 'apps/web/.env.dev.example', source: null, location: null, status: 'missing', excluded: false }),
  file({ app: null, path: '.env.local', kind: 'personal', template: null, location: `${STORE}/dev/.env.local`, status: 'ready', excluded: null }),
  file({ environment: 'uat', app: 'payments-web', path: 'apps/web/.env.uat', template: null, source: 'linked', location: '/Users/someone/secrets/web-uat.env', status: 'linked' }),
  file({ environment: 'uat', path: 'services/api/src/main/resources/application-uat.yml', template: 'services/api/src/main/resources/application-uat.example.yml',
    source: null, location: null, status: 'unmanaged', excluded: false })
];
const answer = (files = FILES, extra = {}) => ({ resultType: 'command-result', data: { resultType: 'sflow-env-files', schemaVersion: 1, files, ...extra } });
const reading = (files = FILES, extra = {}) => model.environmentFilesFrom(answer(files, extra));
const HERE = { activeRepository: 'shop', scope: 'repository' };

test('env files reads (the list, a location, suggestions) are reads; every action that changes a file is not', async () => {
  const reads = [['env', 'files', '--json'], ['env', 'files', 'dev', '--json'], ['env', 'files', '--workspace', '--json'], ['env', 'files', 'uat', '--repository', 'shop', '--json'],
    ['env', 'files', 'path', 'dev', '.env.dev', '--json'], ['env', 'files', 'suggest', '--json']];
  const changes = [['env', 'files', 'create', 'dev', '.env.dev', '--from-template', '--json'], ['env', 'files', 'link', 'dev', '.env.dev', '--to', '/x/y', '--json'],
    ['env', 'files', 'unlink', 'dev', '.env.dev', '--json'], ['env', 'files', 'adopt', 'dev', '.env.dev', '--json'], ['env', 'files', 'add', 'dev', '.env.local', '--personal', '--json'],
    ['env', 'files', 'remove', 'dev', '.env.local', '--personal', '--json'], ['env', 'files', 'root', 'uat', '/x', '--json'], ['env', 'files', 'root', 'uat', '--clear', '--json'],
    ['env', 'files', 'place', 'dev', '--json']];
  for (const args of reads) assert.equal(commandClass(args), 'read', args.join(' '));
  for (const args of changes) assert.equal(commandClass(args), 'mutation', args.join(' '));
  assert.equal(commandClass(['env', 'bind', 'dev', '--stdin']), 'mutation', 'the rest of env is unchanged');
  const client = await readFile(source('cli/client.ts'), 'utf8');
  const cacheable = client.slice(client.indexOf('function cacheableRead'), client.indexOf('export function commandClass'));
  assert.match(cacheable, /!\(args\[0\] === 'env' && args\[1\] === 'files'\)/, 'a list is never replayed from the read cache');
});

test('VS Code classifies every env files command as the engine does', async (t) => {
  const reads = [['env', 'files', '--json'], ['env', 'files', 'dev', '--json'], ['env', 'files', '--workspace', '--json'], ['env', 'files', 'path', 'dev', '.env.dev', '--json'],
    ['env', 'files', 'suggest', '--json']];
  const changes = [['env', 'files', 'create', 'dev', '.env.dev', '--from-template', '--json'], ['env', 'files', 'link', 'dev', '.env.dev', '--to', '/x/y', '--json'],
    ['env', 'files', 'unlink', 'dev', '.env.dev', '--json'], ['env', 'files', 'adopt', 'dev', '.env.dev', '--json'], ['env', 'files', 'add', 'dev', '.env.local', '--personal', '--json'],
    ['env', 'files', 'remove', 'dev', '.env.local', '--personal', '--json'], ['env', 'files', 'root', 'uat', '--clear', '--json'], ['env', 'files', 'place', 'dev', '--json']];
  const { ENV_SUBCOMMANDS, resolveOperation } = await import(path.join(root, 'src', 'command-registry.mjs'));
  if (!ENV_SUBCOMMANDS.includes('files')) return t.skip('this engine has no env files yet: VS Code and engine parity is checked once it does');
  const { parseArgs } = await import(path.join(root, 'src', 'util.mjs'));
  for (const args of [...reads, ...changes]) {
    assert.equal(commandClass(args), resolveOperation({ requestedCommand: args[0], ...parseArgs(args) }).classification, `engine and VS Code: ${args.join(' ')}`);
  }
});

test('the list is read flat, from its envelope, or nested by repository and app; an incomplete entry is left out and counted', () => {
  const flat = reading();
  assert.equal(flat.files.length, 5);
  assert.deepEqual(flat.environments, ['dev', 'uat']);
  assert.equal(flat.dropped, 0);
  assert.deepEqual(flat.files[1], { repository: 'shop', app: 'payments-web', environment: 'dev', path: 'apps/web/.env.dev', kind: 'declared',
    template: 'apps/web/.env.dev.example', source: null, location: null, status: 'missing', excluded: false });
  assert.deepEqual(model.environmentFilesFrom(FILES).files, flat.files, 'a bare array is a list too');

  const nested = model.environmentFilesFrom({ scope: 'workspace', environments: ['dev', 'uat', 'prod'], repositories: [
    { id: 'shop', files: [{ environment: 'dev', path: '.env.dev', status: 'ready' }],
      apps: [{ id: 'payments-web', files: [{ environment: 'dev', path: 'apps/web/.env.dev', status: 'missing', template: 'apps/web/.env.dev.example' }] }] },
    { id: 'billing', files: [{ environment: 'uat', path: 'config/settings/uat.py', status: 'linked', source: 'linked', location: '/Users/someone/billing-uat.py' }] }
  ], workspace: { files: [{ environment: 'dev', path: '.env', status: 'missing', kind: 'personal' }] }, roots: { uat: '/Volumes/secure/uat' } });
  assert.equal(nested.scope, 'workspace');
  assert.deepEqual(nested.files.map((entry) => [entry.repository, entry.app, entry.path]),
    [['shop', null, '.env.dev'], ['shop', 'payments-web', 'apps/web/.env.dev'], ['billing', null, 'config/settings/uat.py'], [null, null, '.env']]);
  assert.deepEqual(nested.environments, ['dev', 'uat', 'prod'], 'declared environments without files are tabs too');
  assert.deepEqual(nested.roots, { uat: '/Volumes/secure/uat' });
  assert.deepEqual(model.environmentFilesFrom({ files: [], roots: [{ environment: 'dev', directory: '/srv/dev' }, { environment: 'qa', directory: 'relative/not-allowed' }] }).roots,
    { dev: '/srv/dev' }, 'a folder is an absolute path');

  const odd = reading([
    file({ path: '/etc/passwd' }), file({ path: '../outside/.env' }), file({ path: 'apps/*/.env.dev' }), file({ environment: 'no spaces' }),
    file({ path: 'apps/web/.env.qa', status: 'exploded', location: 'relative/location' }), file({ repository: 'bad repo' }), { path: 'x' }, null
  ]);
  assert.equal(odd.files.length, 1, 'absolute, escaping and glob paths, bad names and non-entries are not rows');
  assert.equal(odd.dropped, 7);
  assert.equal(odd.files[0].status, 'unknown', 'an unknown status offers nothing');
  assert.equal(odd.files[0].location, null, 'a location is an absolute path or nothing');
  assert.deepEqual(model.fileActions(odd.files[0]), []);
  assert.equal(reading([file(), file()]).files.length, 1, 'one row per repository, environment and path');
  assert.equal(model.environmentFilesFrom({ resultType: 'something-else' }), null, 'not a file list at all');
  assert.equal(model.environmentFilesFrom(null), null);
});

test('each status offers its actions; Open and Reveal only where a real file is, Adopt only for an unmanaged one', () => {
  const actions = (overrides) => model.fileActions(model.environmentFilesFrom([file(overrides)]).files[0]);
  assert.deepEqual(actions({ status: 'missing', source: null }), ['create', 'link']);
  assert.deepEqual(actions({ status: 'missing', source: null, template: null }), ['create-empty', 'link'], 'no template: an empty file');
  assert.deepEqual(actions({ status: 'missing', source: 'linked' }), ['link', 'unlink'], 'a linked file that went away: another one, or stop using it');
  assert.deepEqual(actions({ status: 'ready' }), ['open', 'reveal', 'link']);
  assert.deepEqual(actions({ status: 'placed-here', source: 'root' }), ['open', 'reveal', 'link']);
  assert.deepEqual(actions({ status: 'linked', source: 'linked' }), ['open', 'reveal', 'unlink']);
  assert.deepEqual(actions({ status: 'placed-here', source: 'linked' }), ['open', 'reveal', 'unlink']);
  assert.deepEqual(actions({ status: 'unmanaged', source: null }), ['adopt']);
  assert.deepEqual(actions({ status: 'ready', kind: 'personal' }), ['open', 'reveal', 'link', 'remove'], 'a personal file can be removed');
  assert.deepEqual(actions({ status: 'missing', kind: 'personal', template: null, source: null }), ['create-empty', 'link', 'remove']);
  assert.deepEqual([...model.CHANGING_ACTIONS].sort(), ['adopt', 'create', 'create-empty', 'link', 'remove', 'unlink'], 'Open and Reveal change nothing');
  assert.deepEqual(model.ACTION_LABELS, { create: 'Create from template', 'create-empty': 'Create empty file', open: 'Open', link: 'Use existing file…',
    adopt: 'Adopt', reveal: 'Reveal', unlink: 'Stop using linked file', remove: 'Remove personal file' });
});

test('every env files command is exact argv; another repository or a workspace file is named only in workspace scope', () => {
  const [ready, missing, personal, linked, unmanaged] = reading().files;
  assert.deepEqual(model.envFilesArgv(), ['env', 'files', '--json']);
  assert.deepEqual(model.envFilesArgv({ environment: 'uat', scope: 'workspace' }), ['env', 'files', 'uat', '--workspace', '--json']);
  assert.deepEqual(model.envFilesPathArgv(ready, HERE), ['env', 'files', 'path', 'dev', 'services/api/src/main/resources/application-dev.yml', '--json']);
  assert.deepEqual(model.envFilesCreateArgv(missing, true, HERE), ['env', 'files', 'create', 'dev', 'apps/web/.env.dev', '--from-template', '--json']);
  assert.deepEqual(model.envFilesCreateArgv(missing, false, HERE), ['env', 'files', 'create', 'dev', 'apps/web/.env.dev', '--json']);
  assert.deepEqual(model.envFilesLinkArgv(missing, '/Users/someone/secrets/web-dev.env', HERE),
    ['env', 'files', 'link', 'dev', 'apps/web/.env.dev', '--to', '/Users/someone/secrets/web-dev.env', '--json']);
  assert.deepEqual(model.envFilesUnlinkArgv(linked, HERE), ['env', 'files', 'unlink', 'uat', 'apps/web/.env.uat', '--json']);
  assert.deepEqual(model.envFilesAdoptArgv(unmanaged, HERE), ['env', 'files', 'adopt', 'uat', 'services/api/src/main/resources/application-uat.yml', '--json']);
  assert.deepEqual(model.envFilesAddArgv('dev', '.env.local'), ['env', 'files', 'add', 'dev', '.env.local', '--personal', '--json']);
  assert.deepEqual(model.envFilesRemoveArgv(personal, HERE), ['env', 'files', 'remove', 'dev', '.env.local', '--personal', '--json']);
  assert.deepEqual(model.envFilesRootArgv('uat', '/Volumes/secure/uat'), ['env', 'files', 'root', 'uat', '/Volumes/secure/uat', '--json']);
  assert.deepEqual(model.envFilesRootArgv('uat', null), ['env', 'files', 'root', 'uat', '--clear', '--json']);
  assert.deepEqual(model.envFilesSuggestArgv(), ['env', 'files', 'suggest', '--json']);
  assert.deepEqual(model.actionArgv('link', missing, HERE), null, 'linking needs the chosen file');
  assert.deepEqual(model.actionArgv('open', ready, HERE), model.envFilesPathArgv(ready, HERE), 'Open asks where the real file is now');

  const workspace = { activeRepository: 'shop', scope: 'workspace' };
  const billing = { ...missing, repository: 'billing' };
  assert.deepEqual(model.envFilesCreateArgv(missing, true, workspace), ['env', 'files', 'create', 'dev', 'apps/web/.env.dev', '--from-template', '--json'], 'this window\'s own repository');
  assert.deepEqual(model.envFilesCreateArgv(billing, true, workspace), ['env', 'files', 'create', 'dev', 'apps/web/.env.dev', '--from-template', '--repository', 'billing', '--json']);
  assert.deepEqual(model.envFilesPathArgv({ ...ready, repository: null }, workspace), ['env', 'files', 'path', 'dev', 'services/api/src/main/resources/application-dev.yml', '--workspace', '--json']);

  for (const bad of [() => model.envFilesAddArgv('dev', '../outside'), () => model.envFilesAddArgv('dev', '/abs/.env'), () => model.envFilesAddArgv('d e v', '.env'),
    () => model.envFilesLinkArgv(missing, 'relative/file', HERE), () => model.envFilesRootArgv('uat', 'relative'), () => model.envFilesAddArgv('dev', 'apps/*/.env')]) {
    assert.throws(bad, /is invalid/);
  }
  assert.equal(model.personalPathProblem('apps/web/.env.local'), null);
  assert.match(model.personalPathProblem('../x'), /inside the repository/);
  assert.match(model.personalPathProblem('apps/*.env'), /pattern only protects/);
  assert.match(model.personalPathProblem('  '), /Type the file/);
});

test('the page groups by repository then app under environment tabs, with each file\'s status, source, location and template', () => {
  const view = model.buildEnvironmentFilesView(reading(), { appNames: { 'payments-api': 'Payments API' }, activeRepository: 'shop' });
  assert.equal(view.environment, 'dev', 'the first environment, with nothing asked or remembered');
  assert.deepEqual(view.tabs, [{ name: 'dev', total: 3, missing: 1, selected: true }, { name: 'uat', total: 2, missing: 0, selected: false }]);
  assert.deepEqual(view.repositories.map((group) => [group.label, group.total, group.missing, group.apps.map((app) => app.label)]),
    [['shop (this window)', 3, 1, ['Payments API (payments-api)', 'payments-web', 'Whole repository']]]);
  const html = environmentFilesHtml(view);
  assert.match(html, /role="tab" class="ef-tab" data-ef-environment="dev" aria-selected="true">dev <small class="muted">3 · 1 missing<\/small>/);
  assert.match(html, /data-ef-status="missing">[\s\S]*?<code class="ef-path">apps\/web\/\.env\.dev<\/code>[\s\S]*?<span class="pill bad" data-ef-badge>Missing<\/span>/);
  assert.match(html, /<dt>Template<\/dt><dd><code>apps\/web\/\.env\.dev\.example<\/code><\/dd>/);
  assert.match(html, /<dt>Kept in<\/dt><dd>Private store on this computer<\/dd><dt>Real file<\/dt><dd><code class="ef-location">\/Users\/someone\/shop\/\.git\/singularity-flow\/environment-files\/v1\/dev\/services/);
  assert.match(html, /<dt>Git<\/dt><dd>Git ignores it in this clone \(\.git\/info\/exclude\)<\/dd>/);
  assert.match(html, /data-ef-kind="personal">Personal, this computer only/);
  assert.match(html, /data-ef-action="create" data-ef-key="[^"]+">Create from template<\/button>/);
  assert.match(html, /Set folder for dev…<\/button>/);
  assert.doesNotMatch(html, /data-ef-workspace="root-clear"/, 'Clear only when a folder is set');
  assert.doesNotMatch(html, /application-uat/, 'only the selected environment\'s files');

  const uat = model.buildEnvironmentFilesView(reading(FILES, { roots: { uat: '/Volumes/secure/uat' } }), { environment: 'uat', remembered: 'dev' });
  assert.equal(uat.environment, 'uat', 'the requested environment wins over the remembered one');
  const uatHtml = environmentFilesHtml(uat);
  assert.match(uatHtml, /<strong>Folder for uat<\/strong> <code class="ef-location">\/Volumes\/secure\/uat<\/code>/);
  assert.match(uatHtml, /data-ef-workspace="root-clear">Clear<\/button>/);
  assert.match(uatHtml, /data-ef-status="unmanaged">[\s\S]*?Not managed[\s\S]*?Adopt moves it into the private store and links it back/);
  assert.match(uatHtml, /data-ef-status="linked">[\s\S]*?A file you chose[\s\S]*?\/Users\/someone\/secrets\/web-uat\.env[\s\S]*?Stop using linked file/);

  const asked = model.buildEnvironmentFilesView(reading(), { environment: 'qa' });
  assert.deepEqual(asked.tabs.map((tab) => tab.name), ['dev', 'uat', 'qa'], 'an environment a run asked for is a tab even with no files');
  assert.match(environmentFilesHtml(asked), /No environment files for qa\./);
  assert.equal(model.buildEnvironmentFilesView(reading(), { remembered: 'uat' }).environment, 'uat');
  const nothing = environmentFilesHtml(model.buildEnvironmentFilesView(reading([])));
  assert.match(nothing, /No environment files\.[\s\S]*Declare for the team drafts them/);
  assert.match(nothing, /data-ef-workspace="suggest">[\s\S]*Declare for the team<\/button>/, 'with nothing declared, the team\'s draft is still offered');
  assert.doesNotMatch(nothing, /data-ef-workspace="add"/, 'a personal file needs an environment');

  const workspace = model.buildEnvironmentFilesView(model.environmentFilesFrom([
    file({ repository: 'billing', path: 'config/.env.dev' }), file({ repository: null, app: null, path: '.env' }), file({ path: '.env.dev' })
  ]), { activeRepository: 'shop', scope: 'workspace' });
  assert.deepEqual(workspace.repositories.map((group) => [group.id, group.label, group.apps.map((app) => app.label)]),
    [['shop', 'shop (this window)', ['payments-api']], ['billing', 'billing', ['payments-api']], ['', 'Workspace', ['Workspace root']]],
    'this window\'s repository first, workspace-level files last');
});

test('untrusted, busy and unsupported pages change nothing; the page escapes everything and never holds contents', () => {
  const untrusted = environmentFilesHtml(model.buildEnvironmentFilesView(reading(), { trusted: false }));
  assert.match(untrusted, /data-ef-untrusted/);
  assert.match(untrusted, /data-ef-action="create"[^>]*disabled title="Trust this workspace to change files">Create from template/);
  assert.match(untrusted, /data-ef-action="open" data-ef-key="[^"]+">Open<\/button>/, 'Open still works');
  assert.match(untrusted, /data-ef-workspace="root-set" disabled>/);
  const busy = environmentFilesHtml(model.buildEnvironmentFilesView(reading(), { busy: true }));
  assert.ok(!/data-ef-action="open" data-ef-key="[^"]+">/.test(busy), 'every action waits while one runs');
  const unsupported = environmentFilesHtml(model.buildEnvironmentFilesView(null, { unsupported: true }));
  assert.match(unsupported, /This Singularity Flow has no environment files commands\./);
  assert.equal(model.environmentFilesUnsupported({ result: { error: { code: 'UNKNOWN_SUBCOMMAND' } } }), true);
  assert.equal(model.environmentFilesUnsupported({ message: 'Unknown subcommand: env files' }), true);
  assert.equal(model.environmentFilesUnsupported({ result: { error: { code: 'ENV_FILE_MISSING' } }, message: 'unknown command' }), false);

  // Whatever an engine answer carries, only paths and statuses become rows.
  const leaky = reading([file({ contents: `PASSWORD=${SECRET}`, value: SECRET, preview: SECRET, path: '<b>apps/web/.env.dev</b>'.replace(/[<>]/g, '') })]);
  const view = model.buildEnvironmentFilesView(leaky);
  assert.ok(!JSON.stringify(view).includes(SECRET), 'no field of the view can hold what a file contains');
  assert.ok(!environmentFilesHtml(view).includes(SECRET));
  const hostile = environmentFilesHtml(model.buildEnvironmentFilesView(reading([file({ app: '<img src=x onerror=alert(1)>', location: '/tmp/"><script>x</script>' })])));
  assert.doesNotMatch(hostile, /<img src=x|<script>x/);
});

test('the page and model never read, write or send a file: no file system, no contents', async () => {
  for (const name of ['views/environment-files-model.ts', 'views/environment-files-page.ts', 'views/environment-files.ts']) {
    const text = await readFile(source(name), 'utf8');
    assert.doesNotMatch(text, /from 'node:fs|require\('fs|readFile|writeFile|createReadStream|fs\.promises/, `${name} touches no file itself`);
    assert.doesNotMatch(text, /(?:^|[{,;(]\s*)contents?\??\s*:/m, `${name} has no contents field`);
  }
  const controller = await readFile(source('views/environment-files.ts'), 'utf8');
  assert.match(controller, /openTextDocument\(vscode\.Uri\.file\(location\)\)/, 'Open opens the real file the engine names, in an editor tab');
  assert.match(controller, /showTextDocument\(document, \{ preview: false \}\)/);
});

test('the narrow layout stacks a file\'s actions under it, and its rules come after the ones they override', () => {
  const style = ENVIRONMENT_FILES_STYLE;
  const media = style.indexOf('@media (max-width: 640px)');
  assert.ok(media > 0);
  for (const rule of ['.ef-file { display:grid', '.ef-file > .ef-actions { grid-column:2', '.ef-facts { display:grid', '.ef-workspace { display:flex']) {
    const at = style.indexOf(rule);
    assert.ok(at >= 0 && at < media, `${rule} is before the narrow rules that override it`);
  }
  const narrow = style.slice(media);
  assert.match(narrow, /\.ef-file \{ grid-template-columns:minmax\(0,1fr\); \}/);
  assert.match(narrow, /\.ef-file > \.ef-actions \{ grid-column:1; grid-row:auto; flex-direction:row; flex-wrap:wrap; \}/);
  assert.equal(style.slice(media).match(/@media/g).length, 1, 'the narrow block is the last thing in the style');
});

test('the page script posts only what the markup names; a disabled button posts nothing', () => {
  assert.doesNotThrow(() => new Function(ENVIRONMENT_FILES_SCRIPT));
  const listeners = {};
  const posted = [];
  const window = { __sfVscode: { postMessage: (message) => posted.push(message) } };
  const document = { addEventListener: (type, listener) => { (listeners[type] ??= []).push(listener); } };
  new Function('window', 'document', ENVIRONMENT_FILES_SCRIPT)(window, document);
  const element = (dataset, extra = {}) => ({ dataset, ...extra });
  const click = (target) => { for (const listener of listeners.click) listener({ target: { closest: () => target }, preventDefault() {} }); };
  click(element({ efAction: 'create', efKey: '["shop","dev","apps/web/.env.dev"]' }));
  click(element({ efAction: 'adopt', efKey: 'k' }, { disabled: true }));
  click(element({ efWorkspace: 'root-set' }));
  click(element({ efEnvironment: 'uat' }));
  click(element({ efScope: 'workspace' }));
  click(element({ efRefresh: '' }));
  assert.deepEqual(posted, [
    { type: 'envFiles.action', action: 'create', key: '["shop","dev","apps/web/.env.dev"]' },
    { type: 'envFiles.workspace', action: 'root-set' },
    { type: 'envFiles.environment', environment: 'uat' },
    { type: 'envFiles.scope', scope: 'workspace' },
    { type: 'envFiles.refresh' }
  ]);
  const { files } = reading();
  assert.equal(model.fileByKey(files, model.fileKey(files[1])), files[1]);
  assert.equal(model.fileByKey(files, '["shop","dev","nope"]'), null);
  assert.equal(model.fileByKey(files, { not: 'a key' }), null);
});

test('Declare for the team shows the engine\'s environments.yml draft and the proposal command; VS Code writes neither', () => {
  const draft = 'environments:\n  dev:\n    localFiles: [apps/web/.env.dev]\n';
  const suggestion = model.suggestionFrom({ data: { candidates: [
    { framework: 'Node', environment: 'dev', path: 'apps/web/.env.dev', template: 'apps/web/.env.dev.example' },
    { framework: 'Spring', environment: 'uat', path: 'services/api/src/main/resources/application-uat.yml', template: null },
    { framework: 'Bad', path: '/etc/hosts' }
  ], draft } });
  assert.deepEqual(suggestion.candidates.map((entry) => entry.path), ['apps/web/.env.dev', 'services/api/src/main/resources/application-uat.yml']);
  assert.equal(suggestion.draft, draft);
  assert.equal(suggestion.command, 'singularity-flow configuration save singularity/environments.yml --propose');
  const fromObject = model.suggestionFrom({ localFiles: { dev: ['apps/web/.env.dev', '../escape'], uat: { localFiles: ['services/api/application-uat.yml'] } },
    proposal: { command: 'singularity-flow configuration save singularity/environments.yml --propose --message "Declare environment files"' } });
  assert.equal(fromObject.draft, 'environments:\n  dev:\n    localFiles:\n      - apps/web/.env.dev\n  uat:\n    localFiles:\n      - services/api/application-uat.yml\n');
  assert.match(fromObject.command, /--message "Declare environment files"$/);
  assert.equal(model.suggestionFrom({ proposalCommand: 'rm -rf /', candidates: [] }).command, model.PROPOSE_ENVIRONMENTS_COMMAND, 'only a singularity-flow command is shown');
  assert.equal(model.suggestionFrom({ resultType: 'x' }), null);
  const html = environmentFilesHtml(model.buildEnvironmentFilesView(reading(), { suggestion }));
  assert.match(html, /<pre class="ef-draft" data-ef-draft><code>environments:\n  dev:\n    localFiles: \[apps\/web\/\.env\.dev\]\n<\/code><\/pre>/);
  assert.match(html, /data-ef-workspace="copy-draft">Copy the additions/);
  assert.match(html, /<code>singularity-flow configuration save singularity\/environments\.yml --propose<\/code> <button[^>]*data-ef-workspace="copy-command">Copy/);
  assert.match(html, /VS Code never writes singularity\/environments\.yml\./);
});

test('before a run: the files of its environment it places, by repository, app, source roots or working directory', () => {
  const files = reading([
    file({ path: 'services/api/application-dev.yml', status: 'missing', app: 'payments-api', template: 'services/api/application-dev.example.yml' }),
    file({ path: 'apps/web/.env.dev', status: 'missing', app: null, template: null }),
    file({ path: '.env', status: 'missing', app: null, template: '.env.example' }),
    file({ path: 'apps/web/.env.local', status: 'ready', app: null }),
    file({ repository: 'billing', path: 'billing/.env.dev', status: 'missing', app: null }),
    file({ repository: null, path: 'workspace/.env', status: 'missing', app: null }),
    file({ environment: 'uat', path: 'apps/web/.env.uat', status: 'missing', app: null })
  ]).files;
  const paths = (scope) => model.missingForRun(files, { environment: 'dev', capability: 'payments-web', repositories: ['shop'], ...scope }).map((entry) => entry.path);
  assert.deepEqual(paths({ sourceRoots: [], workingDirectories: [] }), ['services/api/application-dev.yml', 'apps/web/.env.dev', '.env'],
    'no roots: the whole repository; never another repository, a workspace-level file or another environment');
  assert.deepEqual(paths({ sourceRoots: ['apps/web'] }), ['apps/web/.env.dev'], 'a monorepo app: its source roots');
  assert.deepEqual(paths({ sourceRoots: [], workingDirectories: ['apps/web'] }), ['apps/web/.env.dev'], 'no source roots: the start entry\'s working directory');
  assert.deepEqual(paths({ sourceRoots: [], workingDirectories: ['apps/web', '.'] }), ['services/api/application-dev.yml', 'apps/web/.env.dev', '.env'], '"." is the repository root');
  assert.deepEqual(model.missingForRun(files, { environment: 'dev', capability: 'payments-api', repositories: ['shop'], sourceRoots: ['apps/web'] }).map((entry) => entry.path),
    ['services/api/application-dev.yml', 'apps/web/.env.dev'], 'a file the engine names for the capability is its file');
  assert.deepEqual(model.missingForRun(files, { environment: 'dev', capability: 'payments-web', repositories: [], sourceRoots: ['billing'] }).map((entry) => entry.path),
    ['billing/.env.dev'], 'a capability naming no repository is not filtered by one');
  assert.deepEqual(model.missingForRun(files, { environment: 'dev', capability: 'payments-web', repositories: ['shop'], sourceRoots: ['apps'] })[0],
    { repository: 'shop', environment: 'dev', path: 'apps/web/.env.dev', template: null, commands: [] });

  assert.deepEqual(model.environmentFileCounts(files, { capability: 'payments-web', repositories: ['shop'], sourceRoots: [], workingDirectories: [] }, ['dev', 'uat', 'qa']), [
    { environment: 'dev', total: 4, missing: 3, words: '4 files · 3 missing' }, { environment: 'uat', total: 1, missing: 1, words: '1 file · 1 missing' }
  ], 'an environment with no file is not counted');
});

test('a missing file is said plainly with the two fixes; the engine\'s ENV_FILE_MISSING refusal reads the same', () => {
  const one = [{ repository: 'shop', environment: 'dev', path: 'apps/web/.env.dev', template: 'apps/web/.env.dev.example', commands: [] }];
  assert.equal(model.preflightMessage({ kind: 'start', label: 'web' }, 'dev', one),
    'web was not started: environment dev needs apps/web/.env.dev, which is missing on this computer. Create it from its template apps/web/.env.dev.example, or use an existing file. Nothing ran.');
  assert.deepEqual(model.preflightButtons(one), ['Create from template', 'Use existing file…', 'Open Environment Files']);
  const bare = [{ ...one[0], template: null }];
  assert.equal(model.preflightMessage({ kind: 'debug', label: 'web' }, 'dev', bare),
    'web was not started with its debugger: environment dev needs apps/web/.env.dev, which is missing on this computer. Create it, or use an existing file. Nothing ran.');
  assert.deepEqual(model.preflightButtons(bare), ['Use existing file…', 'Open Environment Files'], 'no template: no Create from template');
  const two = [...one, { repository: 'shop', environment: 'dev', path: '.env', template: '.env.example', commands: [] }];
  assert.equal(model.preflightMessage({ kind: 'tests', label: 'Tests for payments-web' }, 'dev', two),
    'Tests for payments-web were not run: environment dev needs 2 files that are missing on this computer: apps/web/.env.dev, .env. Create them from their templates, or use existing files, on Environment Files. Nothing ran.');
  assert.deepEqual(model.preflightButtons(two), ['Create from template', 'Open Environment Files']);
  assert.match(model.preflightMessage({ kind: 'start', label: 'web', exitCode: 1 }, 'dev', one), /^web ended with exit code 1: environment dev needs apps\/web\/\.env\.dev[\s\S]*existing file\.$/);
  assert.ok(!model.preflightMessage({ kind: 'start', label: 'web' }, 'dev', one).includes(SECRET));

  const refused = model.missingFromRefusal({ schemaVersion: 1, status: 'failed', error: { code: 'ENV_FILE_MISSING', message: 'Environment file missing.',
    details: { environment: 'dev', path: 'apps/web/.env.dev', template: 'apps/web/.env.dev.example',
      commands: ['singularity-flow env files create dev apps/web/.env.dev --from-template', 'singularity-flow env files link dev apps/web/.env.dev --to <FILE>', 'rm -rf /'] } } });
  assert.deepEqual(refused, [{ repository: null, environment: 'dev', path: 'apps/web/.env.dev', template: 'apps/web/.env.dev.example',
    commands: ['singularity-flow env files create dev apps/web/.env.dev --from-template', 'singularity-flow env files link dev apps/web/.env.dev --to <FILE>'] }]);
  assert.deepEqual(model.missingFromRefusal({ error: { code: 'ENV_FILE_MISSING', details: { environment: 'uat', files: [{ path: 'a/.env.uat' }, { path: '/abs' }] } } })
    .map((entry) => [entry.environment, entry.path]), [['uat', 'a/.env.uat']]);
  assert.deepEqual(model.missingFromRefusal({ error: { code: 'APP_COMMAND_CHANGED', details: { environment: 'dev', path: 'x' } } }), []);
  assert.deepEqual(model.missingAsFile(one[0]), { repository: 'shop', app: null, environment: 'dev', path: 'apps/web/.env.dev', kind: 'declared',
    template: 'apps/web/.env.dev.example', source: null, location: null, status: 'missing', excluded: null });
  assert.equal(model.locationFrom({ data: { location: '/Users/someone/x/.env.dev' } }), '/Users/someone/x/.env.dev');
  assert.equal(model.locationFrom({ location: 'relative/path' }), null);
});

test('Run & test counts each environment\'s files and opens the page at one; an engine without env files shows nothing', () => {
  const capability = { id: 'payments-web', name: 'Payments web', kind: 'delivery', delivery: true, repository: 'shop', repositories: ['shop'], sourceRoots: ['apps/web'], children: [] };
  const plan = [{ capability: 'payments-web', repository: 'shop', id: 'web', name: null, type: null, argv: ['npm', 'run', 'dev'], workingDirectory: 'apps/web', url: null, ready: null,
    environments: [{ name: 'dev', status: 'bound', default: true }, { name: 'uat', status: 'bound', default: false }], commandSha256: `sha256:${'a'.repeat(64)}`,
    arguments: {}, resolvedArgv: {}, launch: {}, debug: null, debugIssue: null }];
  const files = reading([file({ app: null, path: 'apps/web/.env.dev', status: 'missing' }), file({ app: null, path: 'apps/web/.env.local', status: 'ready' }),
    file({ app: null, environment: 'uat', path: 'apps/web/.env.uat', status: 'linked', source: 'linked' }), file({ app: null, path: 'services/api/.env.dev', status: 'missing' })]).files;
  const view = runModel.buildRunAndTestView(capability, 'here', { plan, environmentFiles: files, environment: 'uat' });
  assert.deepEqual(view.environmentFiles, [
    { environment: 'dev', words: '2 files · 1 missing', missing: 1, current: false }, { environment: 'uat', words: '1 file', missing: 0, current: true }
  ], 'only the files a run of this capability places');
  const html = runAndTestHtml(view);
  assert.match(html, /<p class="rt-env-files">[\s\S]*Environment files:<\/span> <button type="button" class="link rt-env-missing" data-rt="env-files" data-rt-capability="payments-web" data-rt-environment="dev">dev: 2 files · 1 missing<\/button>/);
  assert.match(html, /data-rt="env-files" data-rt-capability="payments-web" data-rt-environment="uat">uat: 1 file<\/button>/);
  const none = runAndTestHtml(runModel.buildRunAndTestView(capability, 'here', { plan, environmentFiles: [] }));
  assert.match(none, /data-rt="env-files" data-rt-capability="payments-web" data-rt-environment="dev">none declared; open Environment Files<\/button>/);
  assert.doesNotMatch(runAndTestHtml(runModel.buildRunAndTestView(capability, 'here', { plan, environmentFiles: null })), /rt-env-files/,
    'an engine without env files: nothing to count or open');
});

test('the Run/Debug Configurations editor links each environment tab to its files', () => {
  const entry = { id: 'api', type: 'spring-boot', environments: ['dev', 'uat'] };
  const state = (tab) => ({ capability: 'payments-api', draft: { configurations: [{ key: 'k1', entry }] }, block: {}, facts: [], selected: 'k1', tab });
  assert.match(tabsRegionHtml(state('uat')), /<button type="button" class="link" data-cf-action="env-files" data-cf-environment="uat">Environment files for uat…<\/button>/);
  assert.match(tabsRegionHtml(state('base')), /data-cf-environment="dev">Environment files for dev…<\/button>/, 'Base: the default environment');
});
