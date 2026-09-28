/** XPL2 performance boundaries that hold on every host: no N+1 work, no hover work, measured bytes. */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { EXPLORER_SCRIPT } from '../apps/vscode/src/views/change-explorer.ts';
import { XPL2_DEFAULT_MAXIMUM_BYTES } from '../src/comprehension/xpl2/command.mjs';
import { cliJson, createChangeRepository, isolatedHome } from './helpers/xpl2-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lines = (count, render) => `${Array.from({ length: count }, (_, index) => render(index + 1)).join('\n')}\n`;

async function changedFiles(t, count) {
  const baseline = {};
  const change = {};
  for (let index = 0; index < count; index += 1) {
    const file = `src/part-${String(index).padStart(3, '0')}.ts`;
    baseline[file] = lines(40, (line) => `export const value${line} = ${line};`);
    change[file] = lines(40, (line) => line === 5 || line === 30 ? `export const value${line} = ${line * 10};` : `export const value${line} = ${line};`);
  }
  return createChangeRepository(t, { baseline, change });
}

function probe(repository, home, args) {
  const result = cliJson(repository, home, [...args]);
  assert.equal(result.status, 0, result.stderr);
  // The subprocess probe reports one line on stderr; it is set per call so nothing else changes.
  return result;
}

test('XPL2-AC-060 No N+1 or hover work: counts stay flat and wire bytes are measured after serialization', async (t) => {
  const home = await isolatedHome(t);
  const small = await changedFiles(t, 4);
  const large = await changedFiles(t, 30);
  const count = (repository, args) => {
    process.env.SINGULARITY_FLOW_SUBPROCESS_PROBE = '1';
    try {
      const result = probe(repository, home, args);
      const match = /^subprocesses:\s+(\d+)\s+calls/mu.exec(result.stderr);
      assert.ok(match, `the subprocess probe reported nothing for ${args.join(' ')}`);
      return { calls: Number(match[1]), json: result.json };
    } finally {
      delete process.env.SINGULARITY_FLOW_SUBPROCESS_PROBE;
    }
  };
  const subjects = [
    ['explain', '--subject', 'change', '--json'],
    ['explain', '--subject', 'gap', '--json'],
    ['explain', '--subject', 'line', '--path', 'src/part-000.ts', '--line', '5', '--json']
  ];
  const code = count(small.root, ['explain', 'code', '--json']).calls;
  for (const args of subjects) {
    const four = count(small.root, args).calls;
    const thirty = count(large.root, args).calls;
    // Seven and a half times the files, the same processes: nothing is spawned per file or unit.
    assert.equal(thirty, four, `${args.slice(0, 3).join(' ')} spawned ${four} then ${thirty}`);
    assert.ok(four <= code, `${args.slice(0, 3).join(' ')} reuses the capture explain code already pays for (${four} vs ${code})`);
  }

  // The default bound is the initial wire payload goal, measured on the serialized explanation.
  assert.equal(XPL2_DEFAULT_MAXIMUM_BYTES, 64 * 1024);
  const bounded = count(large.root, ['explain', '--subject', 'change', '--json']).json.data;
  assert.equal(bounded.wire.measure, 'compact-utf8-json');
  assert.equal(bounded.wire.bytes, Buffer.byteLength(JSON.stringify(bounded.explanation), 'utf8'));
  assert.ok(bounded.wire.bytes <= bounded.wire.maximumBytes);
  assert.equal(bounded.explanation.delivery.complete, false, 'sixty hunks do not fit one initial page');
  assert.equal(bounded.explanation.delivery.reason, 'bounded-delivery');
  assert.ok(bounded.explanation.delivery.returnedUnits < bounded.explanation.delivery.totalUnits);
  assert.equal(bounded.explanation.inventory.counts.changeUnits, 60, 'counts keep the whole authorized set');
  const raised = count(large.root, ['explain', '--subject', 'change', '--max-bytes', String(1024 * 1024), '--json']).json.data;
  assert.equal(raised.explanation.delivery.complete, true);
  assert.equal(raised.explanation.inventory.units.length, 60);

  // The page does nothing on hover: it listens only for explicit clicks, keys, typing and choices,
  // and only those post to the host.
  const listeners = [...EXPLORER_SCRIPT.matchAll(/addEventListener\('([a-z]+)'/gu)].map((match) => match[1]);
  assert.deepEqual([...new Set(listeners)].sort(), ['change', 'click', 'input', 'keydown']);
  assert.doesNotMatch(EXPLORER_SCRIPT, /mouse(over|enter|move)|pointer(over|enter|move)|focusin|onmouse/u);

  // The engine modules are pure: no process, network or Git module reaches them.
  const directory = path.join(root, 'src/comprehension/xpl2');
  for (const file of (await readdir(directory)).filter((name) => name.endsWith('.mjs') && name !== 'command.mjs')) {
    const source = await readFile(path.join(directory, file), 'utf8');
    const imports = [...source.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gmu)].map((match) => match[1]);
    for (const specifier of imports) {
      assert.doesNotMatch(specifier, /child_process|node:(net|http|https|dgram|worker_threads)|git\.mjs|model-[a-z-]+\.mjs|model-providers\/|copilot/u,
        `${file} imports ${specifier}`);
    }
  }
});
