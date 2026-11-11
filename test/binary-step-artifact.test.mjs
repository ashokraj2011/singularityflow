import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { artifactBytesAreText } from '../src/artifact-review-read.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');
const ENV = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Binary Tester', SINGULARITY_FLOW_NO_MODEL: '1' };

test('artifact bytes are text only as UTF-8 without NUL', () => {
  assert.equal(artifactBytesAreText(Buffer.from('# Intake\n\nPlain text — with UTF-8.\n')), true);
  assert.equal(artifactBytesAreText(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01])), false, 'NUL');
  assert.equal(artifactBytesAreText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), false, 'invalid UTF-8');
});

// A step whose artifact is a PDF was read as UTF-8 and given a Markdown metadata comment on publish,
// which corrupted it; the publish check then counted its decoded text, and submit required the comment
// (2026-10-29).
test('a step whose artifact is a PDF publishes, submits and is approved with its bytes unchanged', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-binary-artifact-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const remote = path.join(base, 'remote.git');
  const run = (command, args, { fail = false } = {}) => {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env: ENV });
    if (!fail && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args]);
  await mkdir(root, { recursive: true });
  run('git', ['init', '-q', '-b', 'main']);
  run('git', ['config', 'user.name', 'Binary Tester']);
  run('git', ['config', 'user.email', 'binary@example.test']);
  await writeFile(path.join(root, 'README.md'), '# binary artifact\n');
  cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  config.phases.intake.artifact = { path: 'artifacts/intake/intake.pdf', kind: 'intake', minimumBytes: 20, allowedExtensions: ['.pdf'] };
  // Not a review test: this fixture's Stories are unreviewed on purpose. Every step's review is walked in
  // review-every-step-cli.test.mjs.
  for (const workType of Object.values(config.workTypes ?? {})) workType.sourceReview = { mode: 'off' };
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.']);
  run('git', ['commit', '-q', '-m', 'Initialize the binary artifact fixture']);
  run('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  run('git', ['remote', 'add', 'origin', remote]);
  run('git', ['push', '-q', '-u', 'origin', 'main']);
  const readiness = JSON.parse(cli('precheck', '--run', '--scope', 'dependency-test', '--json').stdout).data.plan;
  cli('precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', readiness.planId, '--json');
  cli('start', 'BIN-1', '--from-branch', 'main', '--work-type', 'chore', '--title', 'A PDF intake', '--description', 'The intake is a PDF.');
  cli('prepare', 'intake');

  const relative = 'singularity/work-items/BIN-1/artifacts/intake/intake.pdf';
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1'), Buffer.from([0, 1, 2, 255, 254, 13, 10]),
    Buffer.from('1 0 obj << /Type /Catalog >> endobj\ntrailer\n%%EOF\n')]);
  await writeFile(path.join(root, relative), pdf);
  cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  assert.deepEqual(await readFile(path.join(root, relative)), pdf, 'publish leaves the PDF exactly as written');
  cli('submit', 'intake');
  cli('approve', 'intake', '--yes');
  assert.deepEqual(await readFile(path.join(root, relative)), pdf, 'the approved PDF is the bytes its author wrote');
  const committed = spawnSync('git', ['show', `HEAD:${relative}`], { cwd: root, env: ENV });
  assert.deepEqual(committed.stdout, pdf, 'the commit holds the same bytes');
  const state = JSON.parse(await readFile(path.join(root, 'singularity/work-items/BIN-1/workflow.json'), 'utf8'));
  assert.equal(state.phases.intake.status, 'approved');
});
