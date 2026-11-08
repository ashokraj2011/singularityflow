import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { readXlsx } from '../src/findings/workbook/xlsx.mjs';
import { matchHeaders, normalizeRow } from '../src/findings/register/format.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { environment as isolatedEnvironment } from './helpers/run-and-test-fixture.mjs';

// CQF M6 piece 5: findings report, the update for the security team and the TLM owners in their own
// workbook format. A person sends it; nothing is sent. Made-up repositories and IDs.

const engine = fileURLToPath(new URL('..', import.meta.url));
const bin = path.join(engine, 'bin', 'singularity-flow.mjs');
const contextEnv = (cwd) => isolatedEnvironment(path.join(path.dirname(cwd), `.test-context-${path.basename(cwd)}`));
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const run = (cwd, args) => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', timeout: childTimeout(120_000),
  env: { ...contextEnv(cwd), SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1' } });
const json = (cwd, args) => {
  const result = run(cwd, [...args, '--json']);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
};

test('findings report writes the same workbook format with each item\'s SFlow state, Story and evidence; it reads back and sends nothing (CQF:REQ-069)', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-findings-report-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
  const bare = path.join(directory, 'example-org', 'orders-api.git');
  const root = path.join(directory, 'orders-api');
  await mkdir(path.dirname(bare), { recursive: true });
  await mkdir(root);
  git(directory, 'init', '-q', '--bare', '-b', 'main', bare);
  git(root, 'init', '-q', '-b', 'main');
  await writeFile(path.join(root, '.nvmrc'), '22.4.1\n');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Orders');
  git(root, 'remote', 'add', 'origin', bare);
  git(root, 'push', '-q', 'origin', 'main');
  // A closed Story that addressed TLM-1, on its own branch.
  git(root, 'switch', '-q', '-c', 'ORD-5');
  await mkdir(path.join(root, 'singularity', 'work-items', 'ORD-5'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'work-items', 'ORD-5', 'workflow.json'), JSON.stringify({ status: 'closed', completion: { evaluatedAt: '2026-11-08T09:00:00.000Z' } }));
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Closed');
  git(root, 'switch', '-q', 'main');

  await writeFile(path.join(directory, 'in.csv'), 'ID,Component,Repository,Target version,Current version,Ecosystem,Due date\nTLM-1,node,orders-api,22,18,runtime,2026-12-31\nTLM-2,express,orders-api,5.1.0,4.18.2,npm,\n');
  json(root, ['findings', 'import', path.join(directory, 'in.csv'), '--feed', 'tlm', '--source', 'tlm-owners']);
  json(root, ['findings', 'link', 'ORD-5', '--address', 'TLM-1']);

  const out = path.join(directory, 'update.xlsx');
  const report = json(root, ['findings', 'report', '--out', out]);
  assert.equal(report.sent, false);
  assert.match(report.note, /Nothing was sent/u);
  assert.deepEqual(report.storiesClosed, [{ id: 'TLM-1', to: 'closed', story: 'ORD-5' }], 'the closed Story\'s item moved, proven by .nvmrc');
  assert.equal(report.counts.tlm.byState.closed, 1);

  const sheets = readXlsx(await readFile(out));
  assert.deepEqual(sheets.map((sheet) => sheet.name), ['Security', 'TLM']);
  const tlm = sheets[1];
  const headers = tlm.rows[0].cells.map((cell) => cell.value);
  assert.deepEqual(headers.slice(-4), ['SFlow state', 'Story', 'Evidence', 'Updated']);
  const rows = Object.fromEntries(tlm.rows.slice(1).map((row) => [row.cells[0].value, row.cells]));
  const at = (cells, header) => cells[headers.indexOf(header)]?.value;
  assert.equal(at(rows['TLM-1'], 'SFlow state'), 'Closed');
  assert.equal(at(rows['TLM-1'], 'Story'), 'ORD-5');
  assert.match(at(rows['TLM-1'], 'Evidence'), /^Proven on main: .nvmrc pins 22\.4\.1\.$/u);
  assert.equal(at(rows['TLM-2'], 'SFlow state'), 'Open');
  // The same format: the report imports again as the team's own sheet, its extra columns unused.
  const { indexes, missing, unknown } = matchHeaders('tlm', tlm.rows[0].cells);
  assert.deepEqual(missing, []);
  assert.deepEqual(unknown, ['SFlow state', 'Story', 'Evidence', 'Updated']);
  assert.equal(normalizeRow('tlm', tlm.rows[1], indexes).item.repository, 'orders-api');

  const again = run(root, ['findings', 'report', '--out', out, '--json']);
  assert.notEqual(again.status, 0);
  assert.match(again.stdout + again.stderr, /FINDINGS_OUTPUT_EXISTS/u, 'a report never overwrites a file');
  assert.equal(json(root, ['findings', 'list', '--state', 'all']).items.find((item) => item.id === 'TLM-1').state, 'closed', 'the register says what the report says');
});
