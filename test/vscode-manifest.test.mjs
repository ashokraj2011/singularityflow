/**
 * What package.json promises, and whether the extension can deliver it.
 *
 * Three bugs in a row had the same shape: the manifest declared something and `activate()` did not
 * provide it in every state. A view contributed with no provider, which VS Code reports as "no data
 * provider registered". Commands contributed but registered after an early return, which reports as
 * "command not found". Views added without their activation events, so the extension never woke and
 * all three views were empty at once.
 *
 * Every one of those was invisible to a green suite, because the suite tested what was built rather
 * than what the manifest promised. These read the manifest and hold the source to it, so a promise
 * nothing keeps is a failing test rather than a support question.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = path.join(packageRoot, 'apps', 'vscode');
const manifest = JSON.parse(await readFile(path.join(extensionRoot, 'package.json'), 'utf8'));

/** Every TypeScript source of the extension, concatenated. */
async function sources() {
  const read = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    const parts = await Promise.all(entries.map((entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? read(target) : readFile(target, 'utf8');
    }));
    return parts.join('\n');
  };
  return read(path.join(extensionRoot, 'src'));
}

const source = await sources();
const viewContainer = manifest.contributes.viewsContainers.activitybar
  .find((container) => container.id === 'singularityFlowNavigator');
const contributedViews = manifest.contributes.views.singularityFlowNavigator;
const views = contributedViews.map((view) => view.id);
const commands = manifest.contributes.commands.map((command) => command.command);
const activation = manifest.activationEvents ?? [];

test('the activity view opens as one compact enterprise navigation surface', () => {
  assert.equal(viewContainer.title, 'SINGULARITY FLOW');
  assert.equal(manifest.contributes.views.singularityFlow, undefined,
    'the versioned container intentionally discards the stale pre-refresh sidebar sizing');
  const contributed = contributedViews;

  /**
   * One view, and it is the one people see.
   *
   * Five native tree views used to sit beside it, gated on `singularityFlow.legacyNavigation` — a
   * context key set nowhere in the extension, so not one of them had ever rendered for anybody. The
   * previous version of this test asserted them by name and justified them as adapters that "only
   * adapt the tested native read model", which was true and was the whole problem: they existed to
   * be tested. Eight host tests reached their providers through `createTreeView`, so deleting the
   * dead surface read as a regression, and it survived on that basis.
   *
   * The providers were never the dead part — they feed this webview, and the host tests now reach
   * them through `sidebar.sourceFor()`, which is the route that corresponds to something on screen.
   */
  assert.deepEqual(contributed.map(({ id }) => id), ['singularityFlow.navigation']);
  assert.equal(contributed[0].type, 'webview', 'the visible navigation is one styled webview');
  assert.ok(!contributed.some((view) => view.when),
    'a contributed view gated on a condition nothing sets is a view nobody can open');
});

test('every contributed view can wake the extension', () => {
  // VS Code fires onView only for views that are actually visible. A view without its own event
  // means a person who collapsed the others sees a sidebar of empty views and no way to fill them —
  // which is exactly what happened when two views were added beside the lifecycle one.
  const missing = views.filter((id) => !activation.includes(`onView:${id}`));
  assert.deepEqual(missing, [], `${missing.join(', ')} cannot wake the extension`);
});

test('every contributed command is registered somewhere in activation', () => {
  // A contributed command with no registerCommand is offered by the palette and answers "command
  // not found" — a sentence about the extension's internals rather than about the repository.
  const missing = commands.filter((command) => {
    const id = command.replace('singularityFlow.', '');
    return !source.includes(`registerCommand('${command}'`)
      && !source.includes(`'${command}'`)
      && !source.includes(`'singularityFlow.${id}'`);
  });
  assert.deepEqual(missing, []);
});

test('every menu entry points at a command that exists', () => {
  // A menu entry naming an uncontributed command is a button that renders and does nothing.
  const referenced = Object.values(manifest.contributes.menus)
    .flat()
    .map((entry) => entry.command)
    .filter(Boolean);
  const unknown = [...new Set(referenced)].filter((command) => !commands.includes(command));
  assert.deepEqual(unknown, []);
});

test('every menu entry keys on a view that exists', () => {
  const unknown = [];
  for (const [menu, entries] of Object.entries(manifest.contributes.menus)) {
    for (const entry of entries) {
      const match = /view == ([\w.]+)/.exec(entry.when ?? '');
      if (match && !views.includes(match[1])) unknown.push(`${menu}: ${entry.command} → ${match[1]}`);
    }
  }
  assert.deepEqual(unknown, []);
});

test('every menu entry keys on a context value the tree actually produces', () => {
  // The deepest version of the same defect: a menu keyed on a contextValue nothing emits is an
  // action that can never appear, and nothing anywhere reports it.
  //
  // Matched as a bare string literal rather than by assignment shape. A first attempt looked for
  // `contextValue: '...'` and reported two values that are emitted perfectly well — one from a
  // nested ternary spanning three lines, one passed as a function argument. A detector that has to
  // model every way a value can be written will keep finding faults in itself; what matters is
  // whether the value the menu names exists in the source at all, which a typo or a deletion breaks
  // and nothing else does.
  const emitted = new Set([...source.matchAll(/'(sflow\.[\w.]+)'/g)].map((match) => match[1]));

  const unreachable = [];
  for (const entry of manifest.contributes.menus['view/item/context'] ?? []) {
    const when = entry.when ?? '';
    const exact = /viewItem == ([\w.]+)/.exec(when);
    if (exact) {
      if (!emitted.has(exact[1])) unreachable.push(`${entry.command} → ${exact[1]}`);
      continue;
    }
    const pattern = /viewItem =~ \/([^/]+)\//.exec(when);
    if (pattern) {
      const expression = new RegExp(pattern[1].replace(/\\\\/g, '\\'));
      if (![...emitted].some((value) => expression.test(value))) {
        unreachable.push(`${entry.command} → /${pattern[1]}/`);
      }
    }
  }
  assert.deepEqual(unreachable, [], 'these actions can never appear on any tree row');
});

test('every command the source runs is one the manifest contributes', () => {
  // executeCommand on an id nothing contributes fails at the moment somebody clicks, and the
  // failure names the id rather than what was being attempted.
  const invoked = [...source.matchAll(/executeCommand\(\s*'(singularityFlow\.[\w.]+)'/g)]
    .map((match) => match[1]);
  const unknown = [...new Set(invoked)].filter((command) => !commands.includes(command));
  assert.deepEqual(unknown, []);
});

test('every command hidden from the palette is reachable or an explicit compatibility alias', () => {
  // `when: false` in commandPalette hides a command because it needs an argument. One hidden with
  // nothing invoking it is dead weight nobody can reach at all.
  const hidden = (manifest.contributes.menus.commandPalette ?? [])
    .filter((entry) => entry.when === 'false')
    .map((entry) => entry.command);
  // Reachable through a menu, through executeCommand, or by being attached to a tree row — the
  // last is how openArtifact is invoked, and a check that only knew about executeCommand called it
  // orphaned.
  const reachable = new Set([
    ...Object.entries(manifest.contributes.menus)
      .filter(([menu]) => menu !== 'commandPalette')
      .flatMap(([, entries]) => entries.map((entry) => entry.command)),
    ...[...source.matchAll(/command: ?'(singularityFlow\.[\w.]+)'/g)].map((match) => match[1]),
    ...[...source.matchAll(/executeCommand\(\s*'(singularityFlow\.[\w.]+)'/g)].map((match) => match[1])
  ]);
  // Hidden aliases may remain callable for old keybindings without occupying current navigation.
  const compatibilityAliases = new Set(['singularityFlow.openDeveloperHome']);
  const orphaned = hidden.filter((command) => !reachable.has(command) && !compatibilityAliases.has(command));
  assert.deepEqual(orphaned, []);
});
