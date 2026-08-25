/**
 * Structural facts reach the first page, or the bounded context is a file listing.
 *
 * Measured on a real repository before this fix: 237 facts, of which 225 were `builtin-text`
 * file-inventory entries and 12 were genuine structure — and the injected 50-fact first page was
 * file inventory end to end. The one page models ever see carried the least informative kind.
 * The fixture here reproduces that shape deliberately: a large crowd of alphabetically-earlier
 * non-source files in front of a handful of Java sources.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  astContext, factSelectionRank, orderFactsStructuralFirst
} from '../src/ast-intelligence.mjs';
import { initializeDefinition } from '../src/config.mjs';
import { requiredStructuralPromptContext } from '../src/structural-prompt-context.mjs';

const MAX_FACTS = 50;

async function repository({ crowd = 110 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-ast-first-'));
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'AST First']);
  git(['config', 'user.email', 'ast@example.test']);
  // The crowd: alphabetically earlier than any source path, one file fact each, no structure.
  for (let index = 0; index < crowd; index += 1) {
    await writeFile(path.join(root, `aaa-${String(index).padStart(3, '0')}.txt`), `note ${index}\n`);
  }
  // The structure, alphabetically last so canonical order buries it.
  await mkdir(path.join(root, 'zzz', 'src'), { recursive: true });
  await writeFile(path.join(root, 'zzz', 'src', 'Main.java'), [
    'package zzz;',
    'import java.util.List;',
    'public class Main {',
    '  public static int add(int a, int b) { return a + b; }',
    '}',
    ''
  ].join('\n'));
  await writeFile(path.join(root, 'zzz', 'src', 'Helper.java'), [
    'package zzz;',
    'public class Helper {',
    '  public String greet(String name) { return "hi " + name; }',
    '}',
    ''
  ].join('\n'));
  git(['add', '.']);
  git(['commit', '-q', '-m', 'fixture']);
  return root;
}

test('the rank order is the specified one, and stable within a rank', () => {
  const facts = [
    { kind: 'file', path: 'a.txt' },
    { kind: 'symbol', extractor: { stage: 'semantic' }, name: 's1' },
    { kind: 'symbol', extractor: { id: 'builtin-text' }, name: 't1' },
    { kind: 'import', extractor: { stage: 'syntax' }, name: 'i1' },
    { kind: 'file', path: 'b.txt' },
    { kind: 'relationship', extractor: { id: 'builtin-text' }, name: 't2' }
  ];
  assert.deepEqual(facts.map(factSelectionRank), [3, 0, 2, 1, 3, 2]);
  const ordered = orderFactsStructuralFirst(facts);
  assert.deepEqual(ordered.map((fact) => fact.name ?? fact.path),
    ['s1', 'i1', 't1', 't2', 'a.txt', 'b.txt'],
    'semantic, then syntax, then text structure, then files — original order kept inside each rank');
});

test('structural facts reach the first page even behind 110 earlier files', async () => {
  const root = await repository();
  const result = await astContext(root, {
    all: true, priority: 'structural-first', 'max-facts': MAX_FACTS, 'max-output-bytes': 256 * 1024
  });

  const structural = result.facts.filter((fact) => fact.kind !== 'file');
  const files = result.facts.filter((fact) => fact.kind === 'file');

  assert.ok(structural.length >= 1, 'no structural fact reached the first page');
  assert.ok(result.facts.length <= MAX_FACTS, `page exceeded the fact cap: ${result.facts.length}`);

  // File inventory fills the remainder, never the space structure needed: every structural fact
  // available in the envelope is on this page, ahead of every file fact.
  const available = result.page?.available ?? result.facts.length;
  const firstFileIndex = result.facts.findIndex((fact) => fact.kind === 'file');
  const lastStructuralIndex = result.facts.map((fact) => fact.kind !== 'file').lastIndexOf(true);
  assert.ok(firstFileIndex === -1 || lastStructuralIndex < firstFileIndex,
    'a file-inventory fact was ranked ahead of a structural fact');
  assert.ok(files.length < result.facts.length,
    'file inventory occupied the whole page while structural facts exist');
  assert.ok(available > MAX_FACTS, 'fixture must overflow one page for the test to mean anything');
});

test('ordering, page hash, and byte budget are deterministic across runs', async () => {
  const root = await repository({ crowd: 60 });
  const options = { all: true, priority: 'structural-first', 'max-facts': 40, 'max-output-bytes': 64 * 1024 };
  const first = await astContext(root, { ...options });
  const second = await astContext(root, { ...options });
  assert.deepEqual(
    second.facts.map((fact) => [fact.kind, fact.path ?? fact.name]),
    first.facts.map((fact) => [fact.kind, fact.path ?? fact.name])
  );
  assert.equal(second.provenance?.evidence?.outputs?.page?.factsSha256,
    first.provenance?.evidence?.outputs?.page?.factsSha256, 'page hash drifted between identical runs');
  assert.ok(first.page.outputBytes <= 64 * 1024, 'byte budget exceeded');
});

test('a continuation cursor replays the bound ordering', async () => {
  const root = await repository({ crowd: 70 });
  const first = await astContext(root, {
    all: true, priority: 'structural-first', 'max-facts': 10, 'max-output-bytes': 256 * 1024
  });
  assert.ok(first.nextCursor, 'fixture must paginate');
  assert.ok(first.facts.some((fact) => fact.kind !== 'file'), 'page one lost the structure');
  const second = await astContext(root, { cursor: first.nextCursor });
  // Page two continues the same ordered sequence: nothing structural may appear after the file
  // inventory began, and no fact repeats across the boundary.
  const boundary = [...first.facts, ...second.facts];
  const firstFile = boundary.findIndex((fact) => fact.kind === 'file');
  const lastStructural = boundary.map((fact) => fact.kind !== 'file').lastIndexOf(true);
  assert.ok(firstFile === -1 || lastStructural < firstFile, 'the continuation reshuffled the selection');
  // Keyed on the whole serialized fact: hand-picked key fields collided on facts that legitimately
  // share them (two import facts serialize with neither path nor name), reporting phantom repeats.
  const keys = boundary.map((fact) => JSON.stringify(fact));
  assert.equal(new Set(keys).size, keys.length, 'a fact repeated across the page boundary');
});

test('the composed prompt page leads with structure and says how much it carries', async () => {
  const root = await repository();
  await initializeDefinition(root);
  const workflow = {
    currentPhase: 'implementation',
    phases: { implementation: { id: 'implementation', generation: 1 } },
    resolution: { intelligence: { worldModel: 'inherit', ast: 'required-context', agentBriefs: 'inherit' } },
    workItem: { id: 'AST-FIRST-1' }
  };
  const context = await requiredStructuralPromptContext(root, workflow);
  assert.match(context.text, /Bounded repository structural context/);
  assert.match(context.text, /·\s+\d+ structural/, 'the header does not disclose the structural count');
  const structural = Number(context.text.match(/·\s+(\d+) structural/)[1]);
  assert.ok(structural >= 1, 'the injected page carries no structural facts');
  assert.doesNotMatch(context.text, /"kind": "file"/,
    'file inventory leaked into a structural prompt after structural facts were available');
});

test('disabled or unavailable AST still composes without failing the workflow', async () => {
  const root = await repository({ crowd: 3 });
  const preference = path.join(root, 'ast-preference.json');
  await writeFile(preference, JSON.stringify({ schemaVersion: 1, mode: 'off' }));
  const saved = process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE;
  process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE = preference;
  try {
    const workflow = {
      currentPhase: 'implementation',
      phases: { implementation: { id: 'implementation', generation: 1 } },
      resolution: { intelligence: { worldModel: 'inherit', ast: 'required-context', agentBriefs: 'inherit' } },
      workItem: { id: 'AST-FIRST-2' }
    };
    const context = await requiredStructuralPromptContext(root, workflow);
    assert.equal(context.text, '', 'a disabled AST must not inject a block');
    assert.ok(context.warnings.length >= 1, 'the fallback must be disclosed, not silent');
  } finally {
    if (saved === undefined) delete process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE;
    else process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE = saved;
  }
});
