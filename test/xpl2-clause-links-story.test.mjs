/**
 * End to end, with no injected fixture: a real Story whose approved intake declares two criteria
 * (one citing the other), then code and a test written with `@clause` and `@ac` comments. The
 * explanation must show those links in every surface that reads the capture: the change and clause
 * subject views, `explain code`, and the snapshot VS Code leases. Singularity Flow's own records
 * written by the Story stay out of all of them.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');
const WORK = 'CX-1';

function machine(home) {
  return {
    ...process.env, NODE_ENV: 'test', HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    SINGULARITY_FLOW_TEST_IDENTITY: 'Clause Link Tester', SINGULARITY_FLOW_NO_MODEL: '1',
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

/** A Story at its implementation step, with tagged code and a tagged test written but not published. */
async function storyWithTaggedChange(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-clause-story-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-clause-home-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(`${root}.git`, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });
  const env = machine(home);
  const git = (...args) => runIn(root, env, 'git', args);
  const cli = (...args) => runIn(root, env, process.execPath, [CLI, '--no-model', ...args]);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Clause Link Tester');
  git('config', 'user.email', 'clause-links@example.test');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await writeFile(path.join(root, 'src/value.mjs'), 'export function value() {\n  return 1;\n}\n');
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
  git('commit', '-qm', 'Initialize the clause-link fixture');
  git('init', '-q', '--bare', '-b', 'main', `${root}.git`);
  git('remote', 'add', 'origin', `${root}.git`);
  git('push', '-q', '-u', 'origin', 'main');
  const plan = JSON.parse(cli('precheck', '--run', '--scope', 'dependency-test', '--json')).data.plan;
  cli('precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', plan.planId, '--json');
  cli('start', WORK, '--from-branch', 'main', '--work-type', 'classic-delivery',
    '--title', 'Return the approved value', '--description', 'Explain the clause links of a real change.');
  const item = path.join(root, 'singularity/work-items', WORK);
  cli('prepare', 'intake');
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), [
    `# ${WORK} — Classic delivery intake`, '',
    '## Request and outcome', '', 'Return the approved new value 2 to every caller; retain the exported API.', '',
    '## Scope and constraints', '', 'Change only the value module and its executable unit test.', '',
    '## Acceptance criteria', '',
    '| Clause | Observable outcome |', '|---|---|',
    `| [${WORK}:AC-001] | value() returns 2. |`,
    `| [${WORK}:AC-002] | Callers still import value by name, as ${WORK}:AC-001 assumes. |`, '',
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
  await writeFile(path.join(root, 'src/value.mjs'),
    `// @clause:${WORK}:AC-001 returns the approved value 2 instead of 1\nexport function value() {\n  return 2;\n}\n`);
  await writeFile(path.join(root, 'test/value.test.mjs'), [
    "import test from 'node:test';", "import assert from 'node:assert/strict';", "import { value } from '../src/value.mjs';",
    `// @ac:${WORK}:AC-001`, "test('value', () => assert.equal(value(), 2));", ''
  ].join('\n'));
  return { root, cli };
}

test('a real Story\'s change explains its clause links on every surface, without its own records', { timeout: 300_000 }, async (t) => {
  const { cli } = await storyWithTaggedChange(t);

  const change = JSON.parse(cli('explain', '--subject', 'change', '--json')).data.explanation;
  const of = (kind) => change.statements.filter((entry) => entry.kind === kind);
  assert.deepEqual(change.inventory.files.map((file) => file.path).sort(), ['src/value.mjs', 'test/value.test.mjs']);
  assert.ok(of('singularity-files-hidden')[0]?.arguments.entries > 0, 'the Story\'s own records are counted');
  assert.match(of('clause-declared').map((entry) => entry.text).join('\n'), /CX-1:AC-001 is declared at .*intake\.md:\d+: “value\(\) returns 2\.”/u);
  assert.deepEqual(of('clause-cites').map((entry) => [entry.arguments.clauseId, entry.arguments.cited]), [['CX-1:AC-002', 'CX-1:AC-001']]);
  assert.deepEqual(of('clause-tag').map((entry) => ({ ...entry.arguments })), [{
    clauseId: 'CX-1:AC-001', path: 'src/value.mjs', line: 1, placement: 'added', note: 'returns the approved value 2 instead of 1'
  }]);
  assert.deepEqual(of('acceptance-tag').map((entry) => [entry.arguments.path, entry.arguments.line, entry.arguments.placement]),
    [['test/value.test.mjs', 4, 'added']]);
  assert.equal(change.attention.filter((entry) => entry.category === 'missing-explanation').length, 0);

  const clause = JSON.parse(cli('explain', '--subject', 'clause', '--id', 'CX-1:AC-001', '--json')).data.explanation;
  const selected = new Set(clause.selection.nodes);
  const fileNode = clause.inventory.files.find((file) => file.path === 'src/value.mjs').fileId;
  const testNode = clause.nodes.find((node) => node.kind === 'test' && node.label === 'test/value.test.mjs').id;
  for (const id of ['clause:CX-1:AC-001', 'clause:CX-1:AC-002', fileNode, testNode]) assert.ok(selected.has(id), id);

  const code = JSON.parse(cli('explain', 'code', '--json')).data.explanation;
  assert.deepEqual([...new Set(code.whyEachChange.map((unit) => unit.location.pathAfter))].sort(), ['src/value.mjs', 'test/value.test.mjs']);
  assert.ok(code.scope.hiddenEntries > 0);

  // The snapshot VS Code leases carries the same view.
  const leased = JSON.parse(cli('snapshot', '--include', 'comprehension', '--json')).comprehension;
  assert.equal(leased.explanationView.explanationSetSha256, change.explanationSetSha256);
  assert.ok(leased.explanationView.relationships.some((edge) => edge.type === 'source-tags-clause' && edge.to === 'clause:CX-1:AC-001'));
});
