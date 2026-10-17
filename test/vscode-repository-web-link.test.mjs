/**
 * An onboarded capability's repository, linked to its GitHub page, traced end to end.
 *
 * Four ways for the link to be dead or wrong: the remote could be converted into a page that does
 * not exist (or one on another host); the shared script could fail to post the click; a panel that
 * renders the link could ignore the message; or a panel could open whatever URL a page sent rather
 * than one it derived itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = path.join(root, 'apps/vscode/src/views');
const source = (relative) => readFile(path.join(root, 'apps/vscode/src', relative), 'utf8');

const { NAV_SCRIPT, repositoryWebLink, repositoryWebTarget, repositoryWebUrl } = await import(path.join(views, 'webview.ts'));

/** The public host, assembled as repository-source hygiene requires (scripts/check.mjs). */
const GITHUB = ['github', 'com'].join('.');
const PAGE = `https://${GITHUB}/acme/payments-api`;

test('GitHub remotes in SSH, scp, git and HTTPS form become the repository page', () => {
  for (const remote of [
    `git@${GITHUB}:acme/payments-api.git`,
    `${GITHUB}:acme/payments-api`,
    `ssh://git@${GITHUB}/acme/payments-api.git`,
    `ssh://git@ssh.${GITHUB}:443/acme/payments-api.git`,
    `git://${GITHUB}/acme/payments-api.git`,
    `https://${GITHUB}/acme/payments-api.git`,
    `https://${GITHUB}/acme/payments-api/`,
    ` https://www.${GITHUB}/acme/payments-api `
  ]) assert.equal(repositoryWebUrl(remote), PAGE, remote);
  assert.equal(repositoryWebUrl(`https://${GITHUB.replace('g', 'G').replace('h', 'H')}/Acme/Payments.API`),
    `https://${GITHUB}/Acme/Payments.API`,
    'the host is normalized; owner and repository keep the case GitHub was given');
});

test('anything that is not one GitHub repository shows nothing new', () => {
  for (const remote of [
    null, undefined, 42, '', 'https://git.example.corp/acme/platform.git', 'git@gitlab.example:acme/api.git',
    `https://${GITHUB}/acme`, `https://${GITHUB}/acme/api/tree/main`, `https://${GITHUB}/acme/..`,
    `https://user:secret@${GITHUB}/acme/api.git`, `https://${GITHUB}/acme/api.git?ref=main`,
    `https://${GITHUB}/acme/api#readme`, 'file:///work/api', '/work/api', 'C:\\work\\api',
    `https://${GITHUB}/-acme/api`, `https://${GITHUB}/acme/a%20b`, 'javascript:alert(1)',
    `https://${GITHUB}.example.corp/acme/api.git`
  ]) assert.equal(repositoryWebUrl(remote), null, String(remote));
  assert.equal(repositoryWebLink('https://git.example.corp/acme/platform.git'), '');
});

test('the link names its page and carries it for the shared click handler', () => {
  assert.equal(repositoryWebLink(`git@${GITHUB}:acme/payments-api.git`),
    ` <span class="help-link repository-web-link" data-repository-web="${PAGE}" role="link" tabindex="0" title="Open ${GITHUB}/acme/payments-api in the browser">${GITHUB}/acme/payments-api</span>`);
  assert.doesNotMatch(repositoryWebLink(PAGE), /<a\b|href=/,
    'an anchor would also be opened by VS Code\'s own webview link handling: the page would open twice');
});

test('a panel opens only the GitHub page it derives itself', () => {
  const message = (url) => ({ type: 'open-repository-web', url });
  assert.equal(repositoryWebTarget(message(PAGE)), PAGE);
  assert.equal(repositoryWebTarget(message('https://evil.example/acme/payments-api')), null);
  assert.equal(repositoryWebTarget(message(`git@${GITHUB}:acme/payments-api.git`)), null,
    'a page sends the derived page, never a remote for the host to reinterpret');
  assert.equal(repositoryWebTarget(message(`${PAGE}/settings`)), null);
  assert.equal(repositoryWebTarget({ type: 'navigate', to: 'help' }), null);
  assert.equal(repositoryWebTarget({ type: 'open-repository-web' }), null);
  assert.equal(repositoryWebTarget(null), null);
});

test('the shared footer script posts a click, Enter or Space on a repository link to the panel', () => {
  const listeners = [];
  const posted = [];
  const document = { addEventListener: (type, listener) => listeners.push([type, listener]) };
  const window = { __sfVscode: { postMessage: (value) => posted.push(value) } };
  new Function('document', 'window', NAV_SCRIPT)(document, window);
  const link = { dataset: { repositoryWeb: PAGE } };
  const target = { closest: (selector) => (selector === '[data-repository-web]' ? link : null) };
  let prevented = 0;
  const fire = (type, extra = {}) => {
    for (const [kind, listener] of listeners) {
      if (kind === type) listener({ target, preventDefault: () => { prevented += 1; }, ...extra });
    }
  };
  fire('click');
  fire('keydown', { key: 'Enter' });
  fire('keydown', { key: ' ' });
  fire('keydown', { key: 'a' });
  assert.deepEqual(posted, Array(3).fill({ type: 'open-repository-web', url: PAGE }));
  assert.equal(prevented, 2, 'Enter and Space are consumed so Space does not also scroll the page');
});

test('every page that draws the link is hosted by a panel that opens it', async () => {
  const hosts = {
    'capability-page.ts': 'views/capabilities.ts',
    'workspaces-page.ts': 'views/workspaces-panel.ts',
    'workspace-form.ts': 'views/workspace-panel.ts',
    'map-capability-form.ts': 'views/bootstrap-panel.ts'
  };
  const renderers = [];
  for (const name of await readdir(views)) {
    if (name.endsWith('.ts') && name !== 'webview.ts'
      && /\brepositoryWebLink\b/.test(await readFile(path.join(views, name), 'utf8'))) renderers.push(name);
  }
  assert.deepEqual(renderers.sort(), Object.keys(hosts).sort(), 'a new page drawing the link needs a host here');
  for (const host of Object.values(hosts)) {
    const text = await source(host);
    assert.match(text, /const repositoryWeb = repositoryWebTarget\(raw\);\s*if \(repositoryWeb\) return void openRepositoryWeb\(repositoryWeb\);/, host);
    assert.doesNotMatch(text, /nav: false/, `${host} must keep the shared footer script that posts the click`);
  }
  assert.match(await source('views/navigate.ts'),
    /export async function openRepositoryWeb\(url: string\)[^{]*\{\s*await vscode\.env\.openExternal\(vscode\.Uri\.parse\(url\)\);/);
});

test('the reads behind the pages carry each repository URL through to the link', async () => {
  assert.match(await source('views/capabilities.ts'), /this\.store\.current\.snapshot\?\.portfolio\?\.repositories \?\? \{\}/,
    'the Capabilities page resolves repository IDs against the approved portfolio');
  assert.match(await source('extension.ts'),
    /\.map\(\(\{ id, name, depth, ancestors, repository, url \}\) => \(\{\s*id, name, depth, ancestors, repository, url\s*\}\)\)/,
    'Workspaces keeps the clone URL that `capability organisation --json` already returns');
});
