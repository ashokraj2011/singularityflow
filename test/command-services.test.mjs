import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  commandLayerSource, commandModuleFiles, withoutComments
} from './helpers/command-source.mjs';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const services = async () => (await readdir(path.join(SRC, 'commands')))
  .filter((name) => name.endsWith('.mjs'))
  .map((name) => path.join(SRC, 'commands', name));
const modules = async () => (await commandModuleFiles())
  .map((name) => path.join(SRC, name));
const helpers = async () => (await commandModuleFiles())
  .filter((name) => path.dirname(name) !== 'commands')
  .map((name) => path.join(SRC, name));

/**
 * A module that uses `path.join` without importing `path` parses fine, passes every static guard,
 * and throws `path is not defined` the first time that branch runs. Extracting a service out of
 * `cli.mjs` is exactly when it happens: the named imports come with the code and the default ones
 * are left behind in the file it came from.
 *
 * This caught the real thing — `story.mjs` shipped 14 uses of `path` and one of `YAML` with neither
 * imported, and only the end-to-end fixture noticed, on one branch out of seven.
 */
test('every command module imports the default modules it uses', async () => {
  const defaults = [
    { name: 'path', from: "'node:path'" },
    { name: 'os', from: "'node:os'" },
    { name: 'YAML', from: "'yaml'" },
    { name: 'readline', from: "'node:readline/promises'" }
  ];
  for (const file of await modules()) {
    const text = withoutComments(await readFile(file, 'utf8'));
    // Strip string and template literals before looking for uses: `'../fast-path.mjs'` contains
    // `path.` and is not a reference to the module. Imports go too, so declaring it never counts as
    // using it.
    const code = text
      .replace(/^import[\s\S]*?from '[^']+';$/gm, '')
      .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
    for (const { name, from } of defaults) {
      if (!new RegExp(`(?<![\\w.$])${name}\\.`).test(code)) continue;
      assert.match(text, new RegExp(`^import ${name} from ${from};`, 'm'),
        `${path.basename(file)} uses ${name}. but never imports it`);
    }
  }
});

/**
 * A nested command module is an implementation detail of a root service, not another dispatcher
 * entrypoint. It still has to be reached from one of those services or it is dead command code.
 */
test('every nested command helper is reached from a command service', async () => {
  const roots = await Promise.all((await services()).map(async (file) => ({
    file,
    source: withoutComments(await readFile(file, 'utf8'))
  })));
  for (const helper of await helpers()) {
    const reached = roots.some(({ file, source }) => {
      const relative = path.relative(path.dirname(file), helper).split(path.sep).join('/');
      const specifier = relative.startsWith('.') ? relative : `./${relative}`;
      return source.includes(`from '${specifier}'`) || source.includes(`import('${specifier}')`);
    });
    assert.ok(reached,
      `${path.relative(path.join(SRC, 'commands'), helper)} is reached from no command service`);
  }
});

/**
 * The services a command can load. Three routes count: the dispatcher's own thunks; the command
 * registry, which maps a command name to its module for the commands that are declared rather than
 * hand-wired; and a reached service loading a sibling on demand for one of its own subcommands, as
 * `story test-policy amend` loads `story-test-amendment.mjs`. Only reached services count as
 * loaders, so a service that only an unreached service loads is still dead.
 */
function reachedServices({ cli, registry, sources }) {
  const reached = new Set([...sources.keys()].filter((name) =>
    cli.includes(`./commands/${name}`) || registry.includes(`./commands/${name}`)));
  for (let grew = true; grew;) {
    grew = false;
    for (const name of sources.keys()) {
      if (reached.has(name)) continue;
      if ([...reached].some((loader) => sources.get(loader).includes(`import('./${name}')`))) {
        reached.add(name);
        grew = true;
      }
    }
  }
  return reached;
}

/**
 * A service must be reachable. The point of the split is that the dispatcher loads a service only
 * when its command runs — which also means a service nothing dispatches is dead weight that no
 * test would otherwise notice, because its own unit tests import it directly.
 */
test('every command service is reached from the dispatcher', async () => {
  const cli = withoutComments(await readFile(path.join(SRC, 'cli.mjs'), 'utf8'));
  const registry = withoutComments(await readFile(path.join(SRC, 'command-registry.mjs'), 'utf8'));
  const sources = new Map(await Promise.all((await services()).map(async (file) =>
    [path.basename(file), withoutComments(await readFile(file, 'utf8'))])));
  // The kernel is shared spine rather than a service, so it is imported, not dispatched.
  assert.match(cli, /from '\.\/commands\/kernel\.mjs'/, 'the router no longer uses the shared kernel');
  sources.delete('kernel.mjs');
  const reached = reachedServices({ cli, registry, sources });
  const unreached = [...sources.keys()].filter((name) => !reached.has(name));
  assert.deepEqual(unreached, [], `${unreached.join(', ')} ${unreached.length === 1 ? 'is' : 'are'} reachable `
    + 'from neither the dispatcher, the command registry, nor a reached service');
});

test('a service only an unreached service loads is not reached', () => {
  const sources = new Map([
    ['story.mjs', "const { run } = await import('./story-sub.mjs');"],
    ['story-sub.mjs', ''],
    ['orphan.mjs', "const { run } = await import('./orphan-sub.mjs');"],
    ['orphan-sub.mjs', '']
  ]);
  const reached = reachedServices({
    cli: "story: async () => (await import('./commands/story.mjs')).storyCommand()", registry: '', sources
  });
  assert.deepEqual([...reached].sort(), ['story-sub.mjs', 'story.mjs']);
});

/**
 * Services are loaded on demand, so a static import of one from the router would put its whole
 * dependency graph back into startup and quietly undo the split.
 */
test('the router imports services lazily, never statically', async () => {
  const cli = withoutComments(await readFile(path.join(SRC, 'cli.mjs'), 'utf8'));
  for (const match of cli.matchAll(/^import[^\n]*from '(\.\/commands\/[^']+)';$/gm)) {
    assert.equal(match[1], './commands/kernel.mjs',
      `${match[1]} is imported statically; use await import() so it loads only when its command runs`);
  }
});

/** The story service really did leave the router, rather than being copied beside it. */
test('the story service is not still in the router', async () => {
  const cli = await readFile(path.join(SRC, 'cli.mjs'), 'utf8');
  assert.doesNotMatch(cli, /^(export )?async function storyConvergeCommand/m);
  const layer = await commandLayerSource();
  assert.match(layer, /^export async function storyConvergeCommand/m, 'the handler must still exist somewhere');
});
