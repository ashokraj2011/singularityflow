/**
 * A document step's files it cannot hold (office, 2026-11-27).
 *
 * Planning was published, then a settings.json changed in the checkout. Its submission was refused with a plan decision
 * as the route; /sf-decide said nothing waited and sent the person back to submit, which was refused again. A Java
 * extension had written .vscode/settings.json. An editor's own settings stop no step: not a document step's submission
 * or approval, nor a code step's start, plan question or approval. Any other file is the code base's: a document step
 * never stops for it and leaves it in the checkout, and the code step takes it up, listed as changed by you
 * [WCB:REQ-004 to REQ-007, docs/SPEC-WCB-WATCH-CODE-BASE-v1.md].
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function execute(command, args, cwd, { allowFailure = false } = {}) {
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Base Tester',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'chore', agent: 'developer' }) };
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env, timeout: childTimeout(180_000) });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}
const flow = (cwd, args, options) => execute(process.execPath, [bin, ...args], cwd, options);
// The fixture's own back-to-back merge, fetch and worktree commands must not start Git's detached
// auto-maintenance: two overlapping repacks deleted objects ("Could not read <sha>"), the race SFlow's
// own Git children already avoid (withoutAutomaticGitMaintenance).
const git = (cwd, ...args) => execute('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], cwd).stdout.trim();

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-base-moves-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(`${root}.git`, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Base Tester');
  git(root, 'config', 'user.email', 'base.tester@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# Ledger\n');
  flow(root, ['init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.approvalSecurity = { profile: 'poc' };
  config.worldModel.grounding = 'off';
  config.repositoryReadiness = { ...config.repositoryReadiness, requiredBeforeStory: false };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  // Not a review test: this fixture's Stories are unreviewed on purpose. Every step's review is walked in
  // review-every-step-cli.test.mjs.
  for (const workType of Object.values(config.workTypes ?? {})) workType.sourceReview = { mode: 'off' };
  await writeFile(configPath, YAML.stringify(config));
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'initial');
  git(root, 'init', '-q', '--bare', '-b', 'main', `${root}.git`);
  // The remote's receive-pack starts its own maintenance after every push unless told not to.
  for (const [key, value] of [['maintenance.auto', 'false'], ['gc.auto', '0']]) git(`${root}.git`, 'config', key, value);
  git(root, 'remote', 'add', 'origin', `${root}.git`);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  return root;
}

async function classicStory(t, W, { approveIntake = true } = {}) {
  const root = await repository(t);
  const AC = `${W}:AC-001`;
  const write = async (relative, contents) => writeFile(path.join(root, relative), contents);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.workTypes['classic-delivery'].spec = { ...(config.workTypes['classic-delivery'].spec ?? {}), mode: 'enforce', coverage: 'enforce' };
  await writeFile(configPath, YAML.stringify(config));
  await write('package.json', JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  execute('mkdir', ['-p', 'src', 'test'], root);
  await write('src/value.mjs', 'export const value = 1;\n');
  await write('test/value.test.mjs', ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", `// @ac:${AC}`, "test('value', () => assert.equal(value, 1));", ''].join('\n'));
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'value module');
  git(root, 'push', '-q', 'origin', 'main');
  const readiness = JSON.parse(flow(root, ['precheck', '--run', '--scope', 'dependency-test', '--json']).stdout).data.plan;
  flow(root, ['precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', readiness.planId, '--json']);
  flow(root, ['start', W, '--from-branch', 'main', '--work-type', 'classic-delivery', '--title', 'Change the value', '--description', 'Return 2.']);
  const item = path.join(root, 'singularity/work-items', W);
  flow(root, ['prepare', 'intake']);
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), [
    `# ${W} — intake`, '', '## Request and outcome', '', 'Return the approved value 2 to every caller.', '',
    '## Scope and constraints', '', 'Change only the value module and its test.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', `| [${AC}] | The exported value equals 2. |`, '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests | Fulfillment |', '|---|---|---|---|',
    `| \`${AC}\` | \`src/value.mjs\` | \`test/value.test.mjs\` | modified |`, '',
    '## Initial evidence', '', 'The baseline module and test at the pinned main revision.', ''
  ].join('\n'));
  flow(root, ['wm', 'compose', '--phase', 'intake']);
  flow(root, ['clarification', 'record', 'intake', '--question', 'Is 2 the approved value?', '--answer', 'Yes.']);
  flow(root, ['phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place']);
  if (approveIntake) {
    flow(root, ['submit', 'intake']);
    flow(root, ['approve', 'intake', '--yes']);
  }
  return { root, item, AC, write };
}


const json = (result) => JSON.parse(result.stdout);

test('an editor\'s settings never stop a step, and any other file a document step leaves in the checkout', slowLane({ timeout: 900_000 }), async (t) => {
  const W = 'DOCF-1';
  const { root, write } = await classicStory(t, W, { approveIntake: false });
  execute('mkdir', ['-p', '.vscode', '.idea', 'config'], root);

  // An editor writes its settings after the step was published: publication never counted them, and neither does submission.
  await write('.vscode/settings.json', '{ "python.defaultInterpreterPath": "/usr/bin/python3" }\n');
  await write('.idea/workspace.xml', '<project/>\n');
  // The Eclipse metadata a Java extension writes, in a module folder too.
  execute('mkdir', ['-p', 'service/.settings'], root);
  await write('.classpath', '<classpath/>\n');
  await write('service/.settings/org.eclipse.jdt.core.prefs', 'eclipse.preferences.version=1\n');
  await write('config/settings.json', '{ "spark": true }\n');

  // Any other file is the code base's: Intake writes documents only, leaves it in the checkout for the code step ahead,
  // and is submitted without a question [WCB:REQ-005].
  const submitted = flow(root, ['submit', 'intake', '--json'], { allowFailure: true });
  assert.equal(submitted.status, 0, submitted.stdout);
  assert.doesNotMatch(submitted.stdout, /decision plan --add-location|PHASE_SOURCE_CHANGED_AFTER_PUBLICATION/u);

  // The Decide page has nothing to ask about it [WCB:REQ-007].
  const list = json(flow(root, ['decisions', W, '--json'])).data;
  assert.ok(!list.items.some((item) => ['generation-rollover', 'plan-accounting'].includes(item.kind)), JSON.stringify(list.items.map((item) => item.kind)));
  const read = async () => JSON.parse(await readFile(path.join(root, 'singularity/work-items', W, 'workflow.json'), 'utf8'));
  // Its approval does not hold for it either: no SFlow commit takes an unstaged file [WCB:REQ-006].
  flow(root, ['approve', 'intake', '--yes']);
  assert.equal((await read()).phases.intake.status, 'approved');
  assert.equal(await readFile(path.join(root, 'config/settings.json'), 'utf8'), '{ "spark": true }\n');

  // The code step: the editor writes again; it is no plan question, no new draft, and no approval hold. The person drops
  // the settings file before the code is written.
  await rm(path.join(root, 'config/settings.json'));
  flow(root, ['prepare', 'implementation']);
  await write('src/value.mjs', `// @clause:${W}:AC-001 returns the approved value\nexport const value = 2;\n`);
  await write('test/value.test.mjs', ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", `// @ac:${W}:AC-001`, "test('value', () => assert.equal(value, 2));", ''].join('\n'));
  await write('.vscode/settings.json', '{ "java.configuration.updateBuildConfiguration": "automatic" }\n');
  const summary = path.join(root, 'singularity/work-items', W, 'artifacts/implementation/implementation-summary.md');
  await writeFile(summary, (await readFile(summary, 'utf8')).replace(/TODO:[^\n]*/gu, 'The value module returns the approved value.'));
  flow(root, ['phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place']);
  await write('.idea/workspace.xml', '<project version="4"/>\n');
  await write('service/.project', '<projectDescription/>\n');
  flow(root, ['submit', 'implementation']);
  flow(root, ['approve', 'implementation', '--yes']);
  assert.equal((await read()).phases.implementation.status, 'approved');
  assert.equal(await readFile(path.join(root, '.vscode/settings.json'), 'utf8'), '{ "java.configuration.updateBuildConfiguration": "automatic" }\n');
});
