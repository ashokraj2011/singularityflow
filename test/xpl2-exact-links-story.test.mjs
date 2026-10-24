/**
 * End to end, with no injected fixture: a real Story whose implementation step is published,
 * submitted and approved. Its code-delivery bindings, recorded test attempts and criterion
 * witnesses must reach every surface that reads the capture, exactly as their owners recorded them,
 * and a later edit of the bound file must stop the binding from joining the new change.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { slowLane } from './helpers/slow-lane.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');
const WORK = 'XL-1';

function machine(home) {
  return {
    ...process.env, NODE_ENV: 'test', HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    SINGULARITY_FLOW_TEST_IDENTITY: 'Exact Link Tester', SINGULARITY_FLOW_NO_MODEL: '1',
    SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1', GIT_TERMINAL_PROMPT: '0',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(home, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(home, 'active-workspace.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(home, 'leads.json'),
    SINGULARITY_FLOW_REPOSITORY_CATALOG: path.join(home, 'repository-catalog')
  };
}

function runIn(cwd, env, command, args) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

/** A Story whose implementation, with two clauses bound to one source file, is approved. */
async function approvedImplementation(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-exact-story-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-exact-home-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(`${root}.git`, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });
  const env = machine(home);
  const git = (...args) => runIn(root, env, 'git', args);
  const cli = (...args) => runIn(root, env, process.execPath, [CLI, '--no-model', ...args]);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Exact Link Tester');
  git('config', 'user.email', 'exact-links@example.test');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await writeFile(path.join(root, 'src/value.mjs'), 'export function value() {\n  return 1;\n}\n\nexport function other() {\n  return 0;\n}\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), [
    "import test from 'node:test';", "import assert from 'node:assert/strict';", "import { value } from '../src/value.mjs';",
    "test('value', () => assert.equal(value(), 1));", ''
  ].join('\n'));
  cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(configPath, YAML.stringify(config));
  git('add', '.');
  git('commit', '-qm', 'Initialize the exact-link fixture');
  git('init', '-q', '--bare', '-b', 'main', `${root}.git`);
  git('remote', 'add', 'origin', `${root}.git`);
  git('push', '-q', '-u', 'origin', 'main');
  const plan = JSON.parse(cli('precheck', '--run', '--scope', 'dependency-test', '--json')).data.plan;
  cli('precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', plan.planId, '--json');
  cli('start', WORK, '--from-branch', 'main', '--work-type', 'classic-delivery',
    '--title', 'Return the approved value', '--description', 'Bind two clauses to one changed file.');
  const item = path.join(root, 'singularity/work-items', WORK);
  cli('prepare', 'intake');
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), [
    `# ${WORK} — Classic delivery intake`, '',
    '## Request and outcome', '', 'Return the approved new value 2 to every caller; retain the exported API.', '',
    '## Scope and constraints', '', 'Change only the value module and its executable unit test.', '',
    '## Acceptance criteria', '',
    '| Clause | Observable outcome |', '|---|---|',
    `| [${WORK}:AC-001] | value() returns 2. |`,
    `| [${WORK}:AC-002] | Callers still import other by name. |`, '',
    '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests |', '|---|---|---|',
    `| \`${WORK}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`,
    `| \`${WORK}:AC-002\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`, '',
    '## Initial evidence', '', 'The baseline module and executable test at the pinned main revision.', ''
  ].join('\n'));
  cli('wm', 'compose', '--phase', 'intake');
  cli('clarification', 'record', 'intake', '--question', 'Is 2 the approved value?', '--answer', 'Yes; keep the interface.');
  cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'intake');
  cli('approve', 'intake', '--yes');
  cli('prepare', 'implementation');
  await writeFile(path.join(root, 'src/value.mjs'), [
    `// @clause:${WORK}:AC-001 returns the approved value 2 instead of 1`, 'export function value() {', '  return 2;', '}', '',
    `// @clause:${WORK}:AC-002 keeps the named export other for existing callers`, 'export function other() {', '  return 0;', '}', ''
  ].join('\n'));
  await writeFile(path.join(root, 'test/value.test.mjs'), [
    "import test from 'node:test';", "import assert from 'node:assert/strict';", "import { other, value } from '../src/value.mjs';",
    `// @ac:${WORK}:AC-001`, "test('value', () => assert.equal(value(), 2));",
    `// @ac:${WORK}:AC-002`, "test('other', () => assert.equal(other(), 0));", ''
  ].join('\n'));
  const summary = path.join(item, 'artifacts/implementation/implementation-summary.md');
  await writeFile(summary, (await readFile(summary, 'utf8')).replace(/TODO:[^\n]*/gu,
    'The clause-tagged value module and acceptance-tagged unit tests deliver the approved value 2.'));
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'implementation');
  cli('approve', 'implementation', '--yes');
  return { root, cli };
}

test('a real approved implementation reaches every surface as exact bound lines, recorded runs and witnesses', slowLane({ timeout: 300_000 }), async (t) => {
  const { root, cli } = await approvedImplementation(t);
  const explain = (...args) => JSON.parse(cli('explain', ...args, '--json')).data.explanation;

  // The current step has moved on; the bindings still belong to the code, so they still join.
  const change = explain('--subject', 'change');
  const exact = change.relationships.filter((edge) => edge.type === 'binding-covers-unit');
  const valueUnit = change.inventory.units.find((unit) => unit.path === 'src/value.mjs');
  assert.deepEqual(exact.map((edge) => [edge.from, edge.to, edge.qualifier]).sort(), [
    [`clause:${WORK}:AC-001`, valueUnit.nodeId, 'accepted'], [`clause:${WORK}:AC-002`, valueUnit.nodeId, 'accepted']
  ]);
  assert.equal(change.inventory.counts.causeBoundUnits, 1, 'two exact bindings, one unit');
  assert.match(change.statements.find((entry) => entry.kind === 'exact-cause').text,
    /that the implementation code-delivery receipt \(generation 1\) binds to XL-1:AC-00[12], as delivered hunks of its planned path src\/value\.mjs; the author's explanation: “/u);
  assert.ok(!change.statements.some((entry) => entry.kind === 'cause-not-recorded' && entry.about === valueUnit.nodeId));
  assert.equal(change.relationships.filter((edge) => edge.type === 'decision-covers-binding').length, 2);

  // The implementation step's own records: the bound attempts and each criterion's witness.
  const implementation = explain('--subject', 'change', '--work-id', WORK, '--phase', 'implementation');
  assert.equal(implementation.sources.find((source) => source.id === 'SRC-DELIVERY').properties.applicability, 'current',
    'the delivered bytes are the captured bytes, so the record is current');
  const witnesses = implementation.statements.filter((entry) => entry.kind === 'witness-result');
  assert.equal(witnesses.length, 2);
  for (const entry of witnesses) {
    assert.match(entry.text, /is the recorded witness for XL-1:AC-00[12]: it passed in attempt TA-[a-f0-9]{20} of /u);
    assert.match(entry.text, /It is bound to one exact test declaration and reached its own occurrence observed in a local run\./u);
  }
  assert.equal(implementation.relationships.filter((edge) => edge.type === 'test-occurrence-in-run').length, 2);
  assert.ok(implementation.statements.some((entry) => entry.kind === 'test-attempt' && /\(submission\) of .* passed, 2 passed, 0 failed, 0 skipped; it follows attempt TA-/u.test(entry.text)));

  // A bound changed line names its binding; the generation lists its attempts in their lineage.
  const line = explain('--subject', 'line', '--path', 'src/value.mjs', '--line', '3');
  assert.ok(line.derived.some((entry) => entry.kind === 'line-binding' && /binds to XL-1:AC-001, XL-1:AC-002\./u.test(entry.text)));
  const generation = explain('--subject', 'generation', '--work-id', WORK, '--phase', 'implementation', '--gen', '1');
  const attempts = generation.derived.filter((entry) => entry.kind === 'test-attempt');
  assert.ok(attempts.length >= 2, 'the preflight and submission attempts');
  assert.match(generation.derived.map((entry) => entry.text).join('\n'), /The prompt log on this machine is off/u);

  // The snapshot VS Code leases carries the same exact links.
  const leased = JSON.parse(cli('snapshot', '--include', 'comprehension', '--json')).comprehension;
  assert.equal(leased.explanationView.explanationSetSha256, change.explanationSetSha256);

  // Editing the bound file after approval: the binding describes another change now.
  await writeFile(path.join(root, 'src/value.mjs'), (await readFile(path.join(root, 'src/value.mjs'), 'utf8')).replace('return 0;', 'return 3;'));
  const edited = explain('--subject', 'change');
  assert.equal(edited.relationships.filter((edge) => edge.type === 'binding-covers-unit').length, 0);
  assert.equal(edited.statements.filter((entry) => entry.kind === 'binding-not-joined').length, 2);
  assert.ok(edited.attention.some((entry) => entry.reason === 'source-scope-mismatch'));
});
