import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const { CliError, invokeCli, softSequenceGate } = await import(path.join(packageRoot, 'apps/vscode/src/cli/runner.ts'));

const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Gate Tester', SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }) };

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env, input: '' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

/** A Story whose intake is approved, so an upload in its current phase meets the document window. */
async function storyPastIntake() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-soft-gate-'));
  run('git', ['init', '-b', 'main'], root); run('git', ['config', 'user.name', 'Gate Tester'], root); run('git', ['config', 'user.email', 'gate@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Gate\n'); run(process.execPath, [bin, 'init'], root);
  const configPath = path.join(root, 'singularity/workflow.yml'); const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off'; config.documents.allowedPhases = ['intake']; config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities ?? {})) authority.allowAnyGitIdentity = true;
  for (const phase of Object.values(config.phases ?? {})) if (phase.approval && phase.approval !== 'none') phase.approval.allowSelfApproval = true;
  config.repositoryReadiness.requiredBeforeStory = false;
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', 'README.md', 'singularity', '.github/agents'], root); run('git', ['commit', '-m', 'initialize'], root);
  run('git', ['init', '--bare', '-b', 'main', `${root}.git`], root); run('git', ['remote', 'add', 'origin', `${root}.git`], root); run('git', ['push', '-u', 'origin', 'main'], root);
  run(process.execPath, [bin, 'start', 'GATE-1', '--from-branch', 'main', '--title', 'Late uploads'], root);
  const itemDirectory = path.join(root, 'singularity/work-items/GATE-1');
  const intake = path.join(itemDirectory, JSON.parse(await readFile(path.join(itemDirectory, 'workflow.json'), 'utf8')).phases.intake.requiredArtifact.path);
  await writeFile(intake, (await readFile(intake, 'utf8')).replace(/TODO:[^\n]*/g, 'Complete intake evidence with measurable acceptance outcomes and linked design context.'));
  for (const args of [['phase', 'publish', 'intake'], ['submit'], ['approve', '--yes']]) run(process.execPath, [bin, ...args], root);
  const file = path.join(root, '..', `${path.basename(root)}-late.md`); await writeFile(file, '# Late\nA late note.\n');
  return { root, file };
}

// The editor learns about a soft gate only from the refusal the CLI prints. Its error message is the
// refusal's headline, so the detector has to read the rest of stderr, where the override is named.
test('the editor recognises a real soft-gate refusal and its retry with the override succeeds', async () => {
  const { root, file } = await storyPastIntake();
  const invoke = (args) => invokeCli({ executable: process.execPath, cli: bin, repository: root, args, env, json: false, commandClass: 'mutation', timeoutMs: 120_000 });
  const upload = ['documents', 'upload', file, '--name', 'Late note', '--store', 'git'];
  const refusal = await invoke(upload).then(() => null, (error) => error);
  assert.ok(refusal instanceof CliError, `expected a CLI refusal, got ${refusal}`);
  assert.doesNotMatch(refusal.message, /--confirm-override/, 'the headline alone does not carry the override');
  assert.equal(softSequenceGate(refusal), 'documentPhase');
  await invoke([...upload, '--confirm-override', 'continue:documentPhase']);
  const listed = JSON.parse(run(process.execPath, [bin, 'documents', 'list', '--json'], root).stdout);
  assert.deepEqual(listed.filter((item) => item.id?.startsWith('DOC-')).map((item) => [item.id, item.name]), [['DOC-001', 'Late note']]);
});

test('a refusal that only mentions an override for another gate is not offered as a soft gate', () => {
  const stderr = 'Singularity Flow error: Soft sequence warning [documentPhase]: cannot upload documents for phase \'design\'.\nAn earlier run added --confirm-override continue:phaseApproval.\n';
  assert.equal(softSequenceGate(new CliError('Soft sequence warning [documentPhase]: cannot upload documents for phase \'design\'.', 2, stderr)), null);
  assert.equal(softSequenceGate(new CliError('Refused.', 2, 'Singularity Flow error: Refused.\nAdd --confirm-override continue:documentPhase.\n')), null);
  assert.equal(softSequenceGate(new Error('Soft sequence warning [documentPhase] --confirm-override continue:documentPhase')), null);
  const legacy = 'Singularity Flow error: Soft sequence warning [phaseApproval]: phase awaits approval.\nSoft gate confirmation requires an interactive terminal.\n';
  assert.equal(softSequenceGate(new CliError('Soft sequence warning [phaseApproval]: phase awaits approval.', 2, legacy)), 'phaseApproval');
});
