import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'singularity-flow.mjs');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Constitution Tester', SINGULARITY_FLOW_NO_MODEL: '1' } });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

test('constitution generate, check and show return well-formed results', async (t) => {
  // Each declared a result subject of kind 'configuration', which the result contract refuses, so
  // every one failed after doing its work: generate had already rewritten the file.
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-constitution-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Constitution Tester'], root);
  run('git', ['config', 'user.email', 'constitution@example.test'], root);
  await writeFile(path.join(root, 'README.md'), '# Fixture\n');
  run(process.execPath, [CLI, '--no-model', 'init'], root);
  const file = path.join(root, 'singularity/constitution.md');
  await writeFile(file, ['---', 'articles:', '  - id: ART-001', '    type: enforced', '    policy: phases.specification.approval.minimum',
    '    rendererVersion: 1', '  - id: ART-002', '    type: judged', '    level: must', '    evidenceRequired: true', '---', '',
    '# Team constitution', '', '## [ART-001] A specification needs an approval', '', 'Generated below.', '',
    '## [ART-002] Every change can be undone', '', 'State how it is reverted.', ''].join('\n'));
  const json = (...args) => JSON.parse(run(process.execPath, [CLI, '--no-model', 'constitution', ...args, '--json'], root));

  const generated = json('generate');
  assert.equal(generated.outcome.status, 'succeeded');
  assert.equal(generated.subject.kind, 'repository');
  assert.equal(generated.effects.filesChanged, true);
  assert.equal(generated.next[0].command, 'singularity-flow configuration save singularity/constitution.md --propose');
  assert.match(await readFile(file, 'utf8'), /<!-- singularity-flow:constitution:generated ART-001 -->/u);
  assert.equal(json('check').data.present, true);
  assert.deepEqual(json('show').data.articles.map((article) => article.id), ['ART-001', 'ART-002']);
  assert.match(run(process.execPath, [CLI, '--no-model', 'constitution', 'generate'], root), /Regenerated \d+ enforced constitution article/u);
});

test('constitution except records an exception and returns a well-formed result', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-constitution-except-'));
  const remote = `${root}-remote.git`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(remote, { recursive: true, force: true })]));
  const sflow = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  run('git', ['init', '-q', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Constitution Tester'], root);
  run('git', ['config', 'user.email', 'constitution@example.test'], root);
  await writeFile(path.join(root, 'README.md'), '# Fixture\n');
  sflow('init');
  const { default: YAML } = await import('yaml');
  const configFile = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(configFile, 'utf8'));
  definition.worldModel.grounding = 'off';
  definition.git.publish = 'off';
  definition.repositoryReadiness = { ...(definition.repositoryReadiness ?? {}), requiredBeforeStory: false };
  definition.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(definition.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(configFile, YAML.stringify(definition));
  await writeFile(path.join(root, 'singularity/constitution.md'), ['---', 'articles:', '  - id: ART-002', '    type: judged', '    level: must',
    '    evidenceRequired: true', '---', '', '# Team constitution', '', '## [ART-002] Every change can be undone', '', 'State how it is reverted.', ''].join('\n'));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-qm', 'Govern the fixture'], root);
  run('git', ['init', '-q', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-q', '-u', 'origin', 'main'], root);
  sflow('start', 'CONST-1', '--from-branch', 'main', '--work-type', 'spec-driven-standard', '--title', 'Keypad', '--description', 'The keypad must show digits.');
  const excepted = JSON.parse(sflow('constitution', 'except', 'ART-002', '--reason', 'A prototype that is thrown away after the demo.', '--work-id', 'CONST-1', '--json'));
  assert.equal(excepted.outcome.status, 'succeeded');
  assert.equal(excepted.subject.kind, 'story');
  assert.equal(excepted.effects.stateChanged, true);
  assert.equal(excepted.next[0].command, 'singularity-flow review --work-id CONST-1');
  assert.equal(excepted.data.articleId, 'ART-002');
});
