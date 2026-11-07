import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');
const ENV = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Amend Tester', SINGULARITY_FLOW_NO_MODEL: '1' };
const W = 'AMEND-FWD-1';

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: ENV });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

/** A document-only Story: intake, then design reading intake, then fix-design reading both. */
export async function documentStory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-forward-amendment-'));
  const remote = `${root}.git`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(remote, { recursive: true, force: true })]));
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  const attempt = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root, { allowFailure: true });
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Amend Tester'], root);
  run('git', ['config', 'user.email', 'amend-fwd@example.test'], root);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, 'test/smoke.test.mjs'), "import test from 'node:test';\ntest('smoke', () => {});\n");
  cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  config.workTypes['document-chain'] = {
    label: 'Document chain', phases: ['intake', 'design', 'fix-design'],
    phaseOverrides: { design: { inputs: ['intake'] }, 'fix-design': { inputs: ['intake', 'design'], approval: { rejectTo: ['intake', 'design', 'fix-design'] } } },
    spec: { mode: 'off', coverage: 'off' },
    // A documents-only fixture: these responsibilities are decided not to apply before it closes.
    omits: ['scope', 'plan', 'implement', 'verify'].map((responsibility) => ({ responsibility,
      reason: `This document-only fixture exercises forward amendment and has no ${responsibility} step.`, authority: 'quality-reviewers' }))
  };
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'Initialize the forward amendment fixture'], root);
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  const readiness = JSON.parse(cli('precheck', '--run', '--scope', 'dependency-test', '--json').stdout).data.plan;
  cli('precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', readiness.planId, '--json');
  cli('start', W, '--from-branch', 'main', '--work-type', 'document-chain', '--title', 'Cache the value', '--description', 'Decide how long callers cache the value.');
  const item = path.join(root, 'singularity/work-items', W);
  const artifact = (phase) => path.join(item, `artifacts/${phase}/${phase}.md`);
  const author = async (phase, text) => {
    cli('prepare', phase);
    const file = artifact(phase);
    await writeFile(file, (await readFile(file, 'utf8')).replace(/TODO:[^\n]*/gu, text));
  };
  const complete = (phase) => {
    cli('wm', 'compose', '--phase', phase);
    cli('clarification', 'record', phase, '--question', `Is the ${phase} scope agreed?`, '--answer', 'Yes, as written.');
    cli('phase', 'publish', phase, '--authored', 'human', '--channel', 'manual-in-place');
    cli('submit', phase);
    cli('approve', phase, '--yes');
  };
  await author('intake', 'Callers read the value from one shared module and may keep a copy for a while.');
  complete('intake');
  await author('design', 'A single module exposes the value; callers keep a local copy and refresh it on change.');
  complete('design');
  await author('fix-design', 'The fix keeps the shared module and documents when callers refresh their copy.');
  const state = async () => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  return { root, cli, attempt, state, artifact };
}
