/**
 * The Code Explainer's host against a `vscode` stub: what it asks the editor's language services, and what it falls back
 * to when they give nothing. Real VS Code, 2026-11-24: a JavaScript file showed "No call hierarchy", callers and callees 0,
 * while TypeScript and Java had them. The editor's answers here are shaped as the TypeScript extension gives them for
 * JavaScript (a `const` arrow function is a Variable; a document symbol carries both `location` and `selectionRange`).
 */
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { realpathSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUB = '__sflowCodeExplainerVscode';
const KIND = { Function: 11, Variable: 12 };

const position = (line, character) => ({ line, character });
const range = (startLine, startCharacter, endLine, endCharacter) => ({ start: position(startLine, startCharacter), end: position(endLine, endCharacter) });
const uriOf = (fsPath) => ({ fsPath, path: fsPath, scheme: 'file', toString: () => `file://${fsPath}` });

let loaded = null;
/** views/code-explainer.ts (and the CLI error it reads refusals from) bundled with `vscode` left to a stub this test drives. */
function loadHost() {
  loaded ??= (async () => {
    const api = {
      ViewColumn: { Active: 1, Beside: 2 },
      Uri: { file: (fsPath) => uriOf(fsPath), joinPath: (base, ...parts) => uriOf(path.join(base.fsPath, ...parts)) },
      Position: class { constructor(line, character) { this.line = line; this.character = character; } },
      Range: class { constructor(start, end) { this.start = start; this.end = end; } },
      RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
      extensions: { getExtension: () => undefined },
      env: {},
      providers: {},
      commands: { executeCommand: async (id, ...args) => api.providers[id]?.(...args) },
      workspace: {
        getConfiguration: () => ({ get: (_key, fallback) => fallback }),
        onDidSaveTextDocument: () => ({ dispose() {} }),
        openTextDocument: async (uri) => {
          const text = await readFile(uri.fsPath, 'utf8');
          return { uri, languageId: /\.[cm]?js$/u.test(uri.fsPath) ? 'javascript' : 'plaintext', getText: () => text };
        },
        findFiles: async () => []
      },
      panels: [],
      window: {
        createWebviewPanel: () => {
          const listeners = [];
          const disposers = [];
          const panel = { visible: true, posted: [], listeners,
            webview: { html: '', cspSource: 'stub', asWebviewUri: (uri) => uri,
              postMessage: async (message) => { panel.posted.push(message); return true; },
              onDidReceiveMessage: (listener) => { listeners.push(listener); return { dispose() {} }; } },
            reveal() {}, onDidChangeViewState: () => ({ dispose() {} }),
            onDidDispose: (listener) => { disposers.push(listener); return { dispose() {} }; },
            send: (message) => Promise.all(listeners.map((listener) => listener(message))),
            dispose: () => disposers.forEach((listener) => listener()) };
          api.panels.push(panel);
          return panel;
        }
      }
    };
    globalThis[STUB] = api;
    const shim = 'data:text/javascript,' + encodeURIComponent(`const api = globalThis.${STUB};
      export const ViewColumn = api.ViewColumn, Uri = api.Uri, Position = api.Position, Range = api.Range, RelativePattern = api.RelativePattern,
        extensions = api.extensions, env = api.env, commands = api.commands, workspace = api.workspace, window = api.window;`);
    register('data:text/javascript,' + encodeURIComponent(`
      export async function resolve(specifier, context, nextResolve) {
        if (specifier === 'vscode') return { url: ${JSON.stringify(shim)}, shortCircuit: true };
        return nextResolve(specifier, context);
      }`));
    const out = await mkdtemp(path.join(os.tmpdir(), 'sflow-code-explainer-host-'));
    process.once('exit', () => rmSync(out, { recursive: true, force: true }));
    const entry = `export * from ${JSON.stringify(path.join(REPOSITORY, 'apps/vscode/src/views/code-explainer.ts'))};
      export { CliError } from ${JSON.stringify(path.join(REPOSITORY, 'apps/vscode/src/cli/runner.ts'))};`;
    // Some of what it bundles is CommonJS that requires Node's own modules.
    await build({ stdin: { contents: entry, resolveDir: REPOSITORY, loader: 'ts', sourcefile: 'code-explainer-entry.ts' }, bundle: true, platform: 'node',
      format: 'esm', external: ['vscode'], outfile: path.join(out, 'code-explainer.mjs'), logLevel: 'silent',
      banner: { js: "import { createRequire as __sflowRequire } from 'node:module'; const require = __sflowRequire(import.meta.url);" } });
    return { api, module: await import(pathToFileURL(path.join(out, 'code-explainer.mjs')).href) };
  })();
  return loaded;
}

/** A JavaScript repository with no jsconfig.json: greet calls format, main calls greet, shout (a const arrow) calls greet. */
const FILES = {
  'src/greet.mjs': "import { format } from './format.mjs';\n\nexport function greet(name) {\n  return format(`Hello, ${name}`);\n}\n\nexport const shout = (name) => greet(name).toUpperCase();\n",
  'src/format.mjs': 'export function format(text) {\n  return text.trim();\n}\n',
  'src/main.mjs': "import { greet } from './greet.mjs';\n\nexport function main() {\n  console.log(greet('world'));\n}\n"
};
/** The outline the TypeScript extension gives each file: `const shout = (…) =>` is a Variable, not a Function. */
const OUTLINE = {
  'src/greet.mjs': [['greet', KIND.Function, range(2, 0, 4, 1), range(2, 16, 2, 21)], ['shout', KIND.Variable, range(6, 13, 6, 56), range(6, 13, 6, 18)]],
  'src/format.mjs': [['format', KIND.Function, range(0, 0, 2, 1), range(0, 16, 0, 22)]],
  'src/main.mjs': [['main', KIND.Function, range(2, 0, 4, 1), range(2, 16, 2, 20)]]
};

async function repository(files = FILES) {
  const root = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), 'sflow-cx-js-')));
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  return root;
}

/** The editor's language services for `root`: symbols always; call hierarchy as `calls` says. */
function languageServices(api, root, { outline = OUTLINE, calls = 'answer' } = {}) {
  const asked = { prepare: [], incoming: [], outgoing: [] };
  const relative = (uri) => path.relative(root, uri.fsPath).split(path.sep).join('/');
  const item = (file, name) => {
    const [, kind, extent, selection] = outline[file].find((entry) => entry[0] === name);
    return { name, kind, detail: '', uri: uriOf(path.join(root, file)), range: extent, selectionRange: selection };
  };
  api.providers = {
    'vscode.executeDocumentSymbolProvider': (uri) => (outline[relative(uri)] ?? []).map(([name, kind, extent, selection]) => ({
      name, detail: '', kind, range: extent, selectionRange: selection, children: [], location: { uri, range: extent } })),
    'vscode.prepareCallHierarchy': (uri, at) => {
      asked.prepare.push([relative(uri), at.line, at.character]);
      if (calls === 'never') return new Promise(() => {});
      if (calls === 'none') return undefined;
      // Asked at the declaration's first column, the service answers nothing; at the name, the function.
      const found = (outline[relative(uri)] ?? []).find((entry) => entry[3].start.line === at.line && entry[3].start.character === at.character);
      return found ? [item(relative(uri), found[0])] : [];
    },
    'vscode.provideIncomingCalls': (target) => {
      asked.incoming.push(target.name);
      return target.name === 'greet' ? [{ from: item('src/main.mjs', 'main'), fromRanges: [range(3, 14, 3, 19)] }] : [];
    },
    'vscode.provideOutgoingCalls': (target) => {
      asked.outgoing.push(target.name);
      if (target.name === 'greet') return [{ to: item('src/format.mjs', 'format'), fromRanges: [range(3, 9, 3, 15)] }];
      if (target.name === 'shout') return [{ to: item('src/greet.mjs', 'greet'), fromRanges: [range(6, 30, 6, 35)] }];
      return [];
    },
    'vscode.executeReferenceProvider': () => [],
    'vscode.executeHoverProvider': () => []
  };
  return asked;
}

/** The CLI as the host reads it; `knowledge(args)` answers `wm knowledge calls`. */
function fakeClient(root, { knowledge = () => ({ edges: [], counts: { calls: 0, byName: 0, resolved: 0 } }), files = Object.keys(FILES) } = {}) {
  const calls = [];
  return { calls, repository: root,
    run: async (args) => {
      calls.push(args);
      if (args[0] === 'lessons') return { lessons: [] };
      if (args[0] === 'explain') return { repository: { files: files.map((file) => ({ path: file })) } };
      if (args[0] === 'wm') return knowledge(args);
      return {};
    } };
}

function fakeStore(root) {
  return {
    current: { snapshot: { repository: { root }, revision: { slices: {} }, workflow: null, comprehension: null } },
    acquireSlices: async () => ({ renew() {}, dispose() {} }),
    refresh: async () => {},
    onDidChange: () => ({ dispose() {} })
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
/** Until the build posts its last model (progress null), or `until` holds. */
async function settled(panel, until = () => panel.posted.some((message) => message.type === 'cx.model' && message.progress === null)) {
  for (let index = 0; index < 20000 && !until(); index += 1) await tick();
  assert.ok(until(), 'the build finished');
  return panel.posted.filter((message) => message.type === 'cx.model').at(-1)?.model;
}

async function explain({ focus = null, mode = null, client, root }) {
  const { api, module } = await loadHost();
  const context = { extensionUri: uriOf(REPOSITORY) };
  module.CodeExplainerPanel.show(context, fakeStore(root), client, { focus, mode });
  const panel = api.panels.at(-1);
  await panel.send({ type: 'cx.ready' });
  return { api, module, panel };
}

const symbolNamed = (model, name) => model.symbols.find((symbol) => symbol.name === name);
const names = (model, ids) => ids.map((id) => model.symbols.find((symbol) => symbol.id === id)?.name).sort();

test('a JavaScript function gets the editor\'s callers and callees, asked at its name', async (t) => {
  const root = await repository(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const { api } = await loadHost();
  const asked = languageServices(api, root);
  const client = fakeClient(root);
  const { panel } = await explain({ focus: { path: 'src/greet.mjs', line: 4 }, client, root });
  t.after(() => panel.dispose());
  const model = await settled(panel);
  assert.deepEqual(asked.prepare[0], ['src/greet.mjs', 2, 16], 'at the name, from the selection range, never column 0');
  const greet = symbolNamed(model, 'greet');
  assert.equal(greet.role, 'focus');
  assert.equal(greet.callStatus, 'complete');
  assert.deepEqual(names(model, greet.callers), ['main']);
  assert.deepEqual(names(model, greet.callees), ['format']);
  assert.equal(model.intelligence.languages.find((entry) => entry.language === 'javascript')?.calls, 'available');
  assert.ok(!client.calls.some((args) => args[0] === 'wm'), 'the editor answered, so Singularity Flow\'s analysis is not read');
});

test('a const arrow function, which the editor calls a Variable, is asked about too', async (t) => {
  const root = await repository(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const { api } = await loadHost();
  const asked = languageServices(api, root);
  const { panel } = await explain({ focus: { path: 'src/greet.mjs', line: 7 }, client: fakeClient(root), root });
  t.after(() => panel.dispose());
  const model = await settled(panel);
  assert.deepEqual(asked.prepare, [['src/greet.mjs', 6, 13]]);
  const shout = symbolNamed(model, 'shout');
  assert.equal(shout.kind, 'function');
  assert.equal(shout.callStatus, 'complete');
  assert.deepEqual(names(model, shout.callees), ['greet']);
});

test('with no call hierarchy for JavaScript, its calls come from Singularity Flow\'s analysis of the folder, marked by name', async (t) => {
  const root = await repository(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const { api } = await loadHost();
  languageServices(api, root, { calls: 'none' });
  const end = (file, name, line, last) => ({ file, name, qualifiedName: name, kind: 'function', line, start: line, end: last });
  const client = fakeClient(root, { knowledge: () => ({ edges: [
    { from: end('src/main.mjs', 'main', 3, 5), to: end('src/greet.mjs', 'greet', 3, 5), line: 4, how: 'by-name' },
    { from: end('src/greet.mjs', 'greet', 3, 5), to: end('src/format.mjs', 'format', 1, 3), line: 4, how: 'by-name' }
  ], counts: { calls: 2, byName: 2, resolved: 0 } }) });
  const { panel } = await explain({ focus: { path: 'src/greet.mjs', line: 4 }, client, root });
  t.after(() => panel.dispose());
  const model = await settled(panel);
  assert.deepEqual(client.calls.filter((args) => args[0] === 'wm'), [['wm', 'knowledge', 'calls', '--area', 'src', '--json']], 'the folder, never the whole repository');
  const greet = symbolNamed(model, 'greet');
  assert.equal(greet.callStatus, 'analysis');
  assert.deepEqual(names(model, greet.callers), ['main']);
  assert.deepEqual(names(model, greet.callees), ['format']);
  assert.equal(model.intelligence.languages.find((entry) => entry.language === 'javascript')?.calls, 'analysis', 'not "No call hierarchy"');
  assert.ok(model.intelligence.notes.some((note) => /Calls for JavaScript come from Singularity Flow's analysis of the committed code \(matched by name\)/u.test(note)),
    model.intelligence.notes.join('\n'));
});

test('a repository too large for one knowledge build is asked by the folders that hold the files', async (t) => {
  const files = { 'lib/a/one.mjs': "import { two } from '../../pkg/b/two.mjs';\n\nexport function one() {\n  return two();\n}\n",
    'pkg/b/two.mjs': 'export function two() {\n  return 2;\n}\n' };
  const outline = { 'lib/a/one.mjs': [['one', KIND.Function, range(2, 0, 4, 1), range(2, 16, 2, 19)]],
    'pkg/b/two.mjs': [['two', KIND.Function, range(0, 0, 2, 1), range(0, 16, 0, 19)]] };
  const root = await repository(files); t.after(() => rmSync(root, { recursive: true, force: true }));
  const { api, module } = await loadHost();
  languageServices(api, root, { outline, calls: 'none' });
  const end = (file, name, line, last) => ({ file, name, qualifiedName: name, kind: 'function', line, start: line, end: last });
  const client = fakeClient(root, { files: Object.keys(files), knowledge: (args) => {
    if (!args.includes('--area')) {
      throw new module.CliError('This repository has 4209 code files, more than one knowledge build reads.', 1, '',
        { error: { code: 'KNOWLEDGE_SCOPE_TOO_LARGE', message: 'This repository has 4209 code files, more than one knowledge build reads.' } });
    }
    return args.includes('lib/a') ? { edges: [{ from: end('lib/a/one.mjs', 'one', 3, 5), to: end('pkg/b/two.mjs', 'two', 1, 3), line: 4, how: 'by-name' }],
      counts: { calls: 1, byName: 1, resolved: 0 } } : { edges: [], counts: { calls: 0, byName: 0, resolved: 0 } };
  } });
  // No Story change and no line: the map of the whole worktree, every function a seed.
  const { panel } = await explain({ client, root });
  t.after(() => panel.dispose());
  const model = await settled(panel);
  assert.equal(model.view, 'full');
  assert.deepEqual(client.calls.filter((args) => args[0] === 'wm').map((args) => args.slice(3, -1)), [[], ['--area', 'lib/a'], ['--area', 'pkg/b']]);
  const [one, two] = [symbolNamed(model, 'one'), symbolNamed(model, 'two')];
  assert.deepEqual([one.callStatus, two.callStatus], ['analysis', 'analysis']);
  assert.deepEqual(names(model, one.callees), ['two']);
  assert.deepEqual(names(model, two.callers), ['one']);
  // The pure parts: subfolders by their files, and the analysis read as the editor is, 40 calls each way at most.
  assert.deepEqual(module.subfolderGroups(['src/a/x.mjs', 'src/a/y/z.mjs', 'src/b/w.mjs', 'src/top.mjs', 'other/q.mjs'], 'src'),
    [{ area: 'src/a', files: ['src/a/x.mjs', 'src/a/y/z.mjs'] }, { area: 'src/b', files: ['src/b/w.mjs'] }]);
  assert.deepEqual(module.subfolderGroups(['top.mjs'], ''), [], 'a file directly in the folder cannot be asked for alone');
  const call = (from, to) => ({ from: { path: 'a.mjs', name: from, kind: 11, range: { start: 1, end: 2 }, selection: { line: 1, character: 0 } },
    to: { path: 'b.mjs', name: to, kind: 11, range: { start: 1, end: 2 }, selection: { line: 1, character: 0 } }, sites: [1] });
  const many = Array.from({ length: 50 }, (_, index) => call(`caller${index}`, 'popular'));
  assert.equal(module.boundedCalls(many, 40).length, 40);
  assert.equal(module.boundedCalls([call('x', 'y'), call('x', 'z')], 1).length, 1, 'out of one function, too');
});

test('a language whose service does not answer its first call-hierarchy question in time is not asked again; its files get the analysis', async (t) => {
  const files = { 'lib/a/one.mjs': 'export function one() {\n  return 1;\n}\n', 'lib/a/two.mjs': 'export function two() {\n  return 2;\n}\n' };
  const outline = { 'lib/a/one.mjs': [['one', KIND.Function, range(0, 0, 2, 1), range(0, 16, 0, 19)]],
    'lib/a/two.mjs': [['two', KIND.Function, range(0, 0, 2, 1), range(0, 16, 0, 19)]] };
  const root = await repository(files); t.after(() => rmSync(root, { recursive: true, force: true }));
  const { api } = await loadHost();
  const asked = languageServices(api, root, { outline, calls: 'never' });
  const client = fakeClient(root, { files: Object.keys(files) });
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const { panel } = await explain({ client, root });
  t.after(() => panel.dispose());
  await settled(panel, () => asked.prepare.length > 0);
  for (let index = 0; index < 200; index += 1) await tick();
  assert.equal(asked.prepare.length, 1, 'asked alone, first');
  mock.timers.tick(20_000);
  const model = await settled(panel);
  assert.equal(asked.prepare.length, 1, 'the second function is not asked: it would wait the full time for nothing');
  assert.deepEqual(client.calls.filter((args) => args[0] === 'wm'), [['wm', 'knowledge', 'calls', '--area', 'lib/a', '--json']]);
  assert.ok(model.intelligence.notes.some((note) => /^The JavaScript language service gave no call hierarchy in 20 s, so its other functions were not asked\./u.test(note)),
    model.intelligence.notes.join('\n'));
  assert.deepEqual(model.symbols.filter((symbol) => ['one', 'two'].includes(symbol.name)).map((symbol) => symbol.callStatus), ['unavailable', 'unavailable']);
});

test('"Explain the change" opens on My change: the first model carries the place, and an open explainer is told at once', async (t) => {
  const root = await repository(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const { api, module } = await loadHost();
  languageServices(api, root);
  assert.equal(module.codeExplainerMode({ mode: 'change' }), 'change');
  for (const other of [undefined, null, 'change', { mode: 'elsewhere' }, uriOf(root)]) assert.equal(module.codeExplainerMode(other), null);
  const client = fakeClient(root);
  const { panel } = await explain({ mode: 'change', client, root });
  t.after(() => panel.dispose());
  const model = await settled(panel);
  const models = panel.posted.filter((message) => message.type === 'cx.model');
  assert.equal(models[0].mode, 'change', 'the first model names the place');
  assert.ok(models.slice(1).every((message) => message.mode === null), 'once');
  assert.equal(model.view, 'delta', 'My change builds the change, never the full map first');
  assert.ok(!client.calls.some((args) => args[0] === 'explain'), 'the worktree was not listed for a map');
  // Already open: told at once, as choosing My change on the page does.
  const context = { extensionUri: uriOf(REPOSITORY) };
  module.CodeExplainerPanel.show(context, fakeStore(root), client, { mode: 'change' });
  assert.deepEqual(panel.posted.at(-1), { type: 'cx.mode', mode: 'change' });
  assert.equal(api.panels.at(-1), panel, 'the one panel');
  // The page shows the place it is given, with the first model or on its own message.
  const page = await readFile(path.join(REPOSITORY, 'src/code-intelligence/code-explainer-view.mjs'), 'utf8');
  assert.match(page, /if \(MODES\.indexOf\(message\.mode\) >= 0\) setMode\(message\.mode\);\n\s+else if \(fresh && !view\.mode\) setMode\(/u);
  assert.match(page, /\} else if \(message\.type === 'cx\.mode'\) \{\n[^\n]*\n\s+if \(model && MODES\.indexOf\(message\.mode\) >= 0\) setMode\(message\.mode\);/u);
});
