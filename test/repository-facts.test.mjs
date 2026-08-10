/**
 * Facts about a repository, and the test the generated world model could never pass.
 *
 * The model's `Facts` blocks were its most valuable content and its least verifiable: on the calc
 * POC they carried every path, line number and command the reading agent would act on, a model
 * wrote them, and nothing ever checked one. So the point of deriving them is not only speed — it is
 * that "does this claim resolve in the repository?" becomes a question with an answer.
 *
 * The last test asks exactly that, of every path and every `path:line` produced.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { worldModelSourceSnapshot } from '../src/grounding.mjs';
import {
  deriveRepositoryFacts, extractImports, extractSymbols, renderFactsDigest
} from '../src/repository-facts.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-facts-'));
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Facts Tester');
  git('config', 'user.email', 'facts@example.com');

  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'facts-fixture',
    main: 'src/index.js',
    bin: { one: 'bin/run.js', two: 'bin/run.js' },
    scripts: { build: 'node build.js', test: 'node --test' },
    dependencies: { react: '^18.0.0', express: '^4.0.0' },
    devDependencies: { vitest: '^1.0.0' }
  }, null, 2));
  await mkdir(path.join(root, 'src/util'), { recursive: true });
  await mkdir(path.join(root, 'bin'), { recursive: true });
  await mkdir(path.join(root, 'tests'), { recursive: true });
  await writeFile(path.join(root, 'bin/run.js'), 'import "../src/index.js";\n');
  await writeFile(path.join(root, 'src/util/shared.js'), 'export const SHARED = 1;\nexport function help() {}\n');
  await writeFile(path.join(root, 'src/index.js'),
    'import { SHARED } from "./util/shared.js";\n\nexport class App {}\n\nexport async function start() { return SHARED; }\n');
  await writeFile(path.join(root, 'src/other.js'), 'import { help } from "./util/shared.js";\nexport const other = help;\n');
  await writeFile(path.join(root, 'tests/app.test.js'), 'import "../src/index.js";\n');
  git('add', '-A');
  git('commit', '-m', 'fixture');
  return root;
}

test('exported top-level declarations are found, with their line', () => {
  const source = [
    'const private = 1;',            // not exported
    'export const KEY = 2;',
    'export async function run() {}',
    'export default class Thing {}',
    '  export const indented = 3;'   // not at column zero
  ].join('\n');
  const symbols = extractSymbols(source, 'src/sample.js');
  assert.deepEqual(symbols.map((symbol) => symbol.name), ['KEY', 'run', 'Thing']);
  assert.equal(symbols[0].at, 'src/sample.js:2');
  assert.equal(symbols[1].kind, 'function');
  assert.equal(symbols[2].kind, 'class');
});

test('imports are found in every form the codebase actually uses', () => {
  const source = [
    'import { a } from "./a.mjs";',
    'import "./side-effect.js";',
    'const b = require("../b");',
    'export { c } from "./c.js";',
    'import type { D } from "./d.ts";'
  ].join('\n');
  assert.deepEqual(extractImports(source).sort(),
    ['../b', './a.mjs', './c.js', './d.ts', './side-effect.js']);
});

test('the manifest is read for what it declares, not just its name', async () => {
  const root = await repository();
  const facts = await deriveRepositoryFacts(root, await worldModelSourceSnapshot(root, {}), { churn: false });

  // `bin` mapped two command names onto one file. That is one entry point.
  assert.deepEqual(facts.entryPoints.map((entry) => entry.path).sort(), ['bin/run.js', 'src/index.js']);
  // Every command cites its own line, so a citation is worth following.
  const lines = facts.commands.map((command) => command.declaredAt);
  assert.equal(new Set(lines).size, lines.length, 'commands share a citation');
  assert.deepEqual(facts.commands.map((command) => command.command).sort(), ['npm run build', 'npm run test']);
  // Frameworks come from declared dependencies — there was no detection of any kind before.
  assert.deepEqual(facts.frameworks, ['Express', 'React', 'Vitest']);
});

test('the import graph names what the repository actually depends on', async () => {
  const root = await repository();
  const facts = await deriveRepositoryFacts(root, await worldModelSourceSnapshot(root, {}), { churn: false });
  // "Hotspot" used to be the model's impression. This is a count: shared.js is imported by index
  // and other; index.js by the bin script and the test. Both are 2, so the ranking ties — and the
  // tie must break the same way every run, or the digest would churn without the repository
  // changing.
  assert.deepEqual(facts.mostImported.slice(0, 2), [
    { path: 'src/index.js', importedBy: 2 },
    { path: 'src/util/shared.js', importedBy: 2 }
  ]);
  assert.deepEqual(facts.tests, ['tests/app.test.js']);
});

test('a file that was not read is named, never reported as empty', async () => {
  const root = await repository();
  // Something too large to scan. Saying "this module exports nothing" would be a claim; saying
  // "I did not read this module" is not, and only one of them is true.
  await writeFile(path.join(root, 'src/huge.js'), `${'// filler\n'.repeat(60_000)}export const real = 1;\n`);
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['-c', 'user.email=f@e.com', '-c', 'user.name=F', 'commit', '-m', 'huge'], { cwd: root });

  const facts = await deriveRepositoryFacts(root, await worldModelSourceSnapshot(root, {}), { churn: false });
  assert.ok(facts.unindexed.includes('src/huge.js'));
  assert.equal(facts.counts.unindexed, 1);
  assert.ok(!facts.symbols.some((symbol) => symbol.at.startsWith('src/huge.js')));
  assert.match(renderFactsDigest(facts), /not_indexed: 1/);
});

test('the digest is a page, not the database behind it', async () => {
  const root = await repository();
  const facts = await deriveRepositoryFacts(root, await worldModelSourceSnapshot(root, {}), { churn: false });
  const digest = renderFactsDigest(facts);
  // The full fact set for a real repository is ~200 KB — bigger than the world model it improves
  // on. That belongs on disk; this is what goes in a prompt.
  assert.ok(Buffer.byteLength(digest) < 8 * 1024, `digest is ${Buffer.byteLength(digest)} bytes`);
  assert.match(digest, /^```yaml/);
  assert.match(digest, /```$/);
});

test('every derived fact resolves in the repository it describes', async () => {
  // The claim the generated world model made constantly and never had to justify. Run against this
  // repository, which is large and real, rather than the fixture.
  const facts = await deriveRepositoryFacts(packageRoot, await worldModelSourceSnapshot(packageRoot, {}), { churn: false });
  const tracked = new Set(
    spawnSync('git', ['ls-files'], { cwd: packageRoot, encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
  );

  for (const entry of facts.entryPoints) {
    assert.ok(tracked.has(entry.path), `entry point does not exist: ${entry.path}`);
  }
  for (const symbol of facts.symbols.slice(0, 200)) {
    const [file, lineNumber] = symbol.at.split(':');
    assert.ok(tracked.has(file), `symbol cites a file that does not exist: ${symbol.at}`);
    const text = await readFile(path.join(packageRoot, file), 'utf8');
    const source = text.split('\n')[Number(lineNumber) - 1];
    assert.ok(source !== undefined, `symbol cites a line past the end of the file: ${symbol.at}`);
    assert.ok(source.includes(symbol.name), `line ${symbol.at} does not contain ${symbol.name}: ${source}`);
  }
  for (const command of facts.commands) {
    const [file, lineNumber] = command.declaredAt.split(':');
    const text = await readFile(path.join(packageRoot, file), 'utf8');
    assert.ok(text.split('\n')[Number(lineNumber) - 1] !== undefined, `command cites a missing line: ${command.declaredAt}`);
  }
});
