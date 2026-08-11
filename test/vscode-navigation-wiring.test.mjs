/**
 * The footer links, traced end to end.
 *
 * Five links, and five separate ways for one to be a dead button: the page could emit an attribute
 * the script does not read; the script could post a shape the panel does not recognise; the panel
 * could resolve a destination the map does not hold; the map could name a command the manifest never
 * contributes; and the manifest could contribute a command nothing registers a handler for.
 *
 * The last two are the ones that bite, because both look fine in isolation. `contributes.commands`
 * is a declaration, not an implementation, and a command registered only after a governed repository
 * resolves does not exist for the pages that can open before one does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = path.join(root, 'apps', 'vscode');

const manifest = JSON.parse(await readFile(path.join(extensionRoot, 'package.json'), 'utf8'));
const extensionSource = await readFile(path.join(extensionRoot, 'src', 'extension.ts'), 'utf8');
const { NAV_COMMANDS, NAV_DESTINATIONS, footerNav, navigationTarget, NAV_SCRIPT, page, VSCODE_API_SCRIPT } =
  await import('../apps/vscode/src/views/webview.ts');

test('what the page emits is what the script reads', () => {
  const rendered = footerNav(null);
  const emitted = [...rendered.matchAll(/data-nav="([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(emitted.sort(), Object.keys(NAV_DESTINATIONS).sort());
  assert.match(NAV_SCRIPT, /\.page-nav \[data-nav\]/);
  assert.match(NAV_SCRIPT, /dataset\.nav/);
});

test('a scripted page acquires the VS Code API exactly once and shares it with footer navigation', () => {
  const rendered = page('Test', '<main>Body</main>', "default-src 'none'", 'nonce',
    'const vscode = window.__sfVscode; vscode.postMessage({ type: "ready" });');
  assert.equal(rendered.split('acquireVsCodeApi()').length - 1, 1);
  assert.ok(rendered.indexOf(VSCODE_API_SCRIPT.trim()) < rendered.indexOf('const vscode = window.__sfVscode'));
  assert.equal(rendered.match(/<script nonce="nonce">/g)?.length, 3,
    'API acquisition, screen behavior, and shared navigation run in isolated script elements');
  assert.ok(rendered.indexOf('const vscode = window.__sfVscode') < rendered.indexOf(NAV_SCRIPT.trim()));
  assert.match(NAV_SCRIPT, /window\.__sfVscode\.postMessage/);
  assert.doesNotMatch(NAV_SCRIPT, /acquireVsCodeApi/);
});

test('screen failures cannot prevent the shared navigation bridge from loading', () => {
  const rendered = page('Broken widget', '<main>Body</main>', "default-src 'none'", 'nonce',
    'throw new Error("screen widget failed");');
  const widget = rendered.indexOf('screen widget failed');
  const widgetEnd = rendered.indexOf('</script>', widget);
  const navigation = rendered.indexOf(NAV_SCRIPT.trim());
  assert.ok(widget >= 0 && widgetEnd > widget);
  assert.ok(navigation > widgetEnd,
    'the navigation listener is in a later script element and still runs after a widget exception');
});

test('what the script posts is what the panels resolve', () => {
  // The script posts { type: 'navigate', to }. Anything else must be left for the panel's own
  // contract — a footer that swallowed another panel's messages would be far worse than a dead link.
  for (const destination of Object.keys(NAV_DESTINATIONS)) {
    assert.equal(navigationTarget({ type: 'navigate', to: destination }), NAV_COMMANDS[destination]);
  }
  assert.equal(navigationTarget({ type: 'approve', id: 'PHASE-1' }), null);
  assert.equal(navigationTarget({ type: 'navigate', to: 'not-a-destination' }), null);
  assert.equal(navigationTarget({ type: 'navigate' }), null);
  assert.equal(navigationTarget(null), null);
  // A destination must not be resolvable from an inherited property.
  assert.equal(navigationTarget({ type: 'navigate', to: 'toString' }), null);
});

test('every destination is contributed by the manifest', () => {
  const contributed = new Set(manifest.contributes.commands.map((entry) => entry.command));
  for (const [destination, command] of Object.entries(NAV_COMMANDS)) {
    assert.ok(contributed.has(command), `${destination} points at ${command}, which is not contributed`);
  }
});

test('every destination has a handler, not just a declaration', () => {
  // Contributed and registered are different things, and only one of them answers a click.
  for (const [destination, command] of Object.entries(NAV_COMMANDS)) {
    const registered = extensionSource.includes(`registerCommand('${command}'`)
      || extensionSource.includes(`'${command}':`);
    assert.ok(registered, `${destination} points at ${command}, which nothing registers`);
  }
});

test('following a link is guarded, because three destinations register late', () => {
  // Journey, Approvals and Configuration are registered only once a governed repository resolves,
  // while Help and Diagnostics are registered before that and can both be opened with no workspace
  // selected. Executing an unregistered command raises VS Code's raw "command not found", so the
  // destination is checked when it is followed rather than assumed when it is drawn.
  const earlyReturn = extensionSource.indexOf('return unavailable(resolved.label');
  assert.ok(earlyReturn > 0, 'expected the degraded-state early return to still exist');

  const late = Object.entries(NAV_COMMANDS).filter(([, command]) => {
    const at = extensionSource.indexOf(`registerCommand('${command}'`) >= 0
      ? extensionSource.indexOf(`registerCommand('${command}'`)
      : extensionSource.indexOf(`'${command}':`);
    return at > earlyReturn;
  });
  assert.ok(late.length > 0, 'if every destination now registers early, this guard can be simplified');

  // Which is why no panel may execute a destination directly.
  assert.doesNotMatch(extensionSource, /executeCommand\(navigation\)/);
});
