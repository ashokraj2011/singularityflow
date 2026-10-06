import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { repositoryOwnedWorkflows } from './helpers/repository-owned-workflows.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const WORK_TYPE = 'import-demo';
const SKILL_URL = 'https://skills.example.org/team/security-review/SKILL.md';
const TEMPLATE_URL = 'https://skills.example.org/templates/threat-model.md';
const SKILL = '---\nname: security-review\ndescription: Check a design for security gaps.\n---\n# Security review\n\n- List every entry point and who may call it.\n- Flag secrets in configuration.\n';
// No final newline on purpose: imported bytes are kept exactly, so their hash stays true.
const TEMPLATE = '# {{work.id}} threat model\n\n## Assets\n\n## Threats\n\n## Mitigations\n\n{{inputs}}';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function execute(command, args, cwd, { allowFailure = false, agent = null, fixtures = null } = {}) {
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Import Tester' };
  if (fixtures) env.SINGULARITY_FLOW_TEST_REMOTE_FIXTURES = fixtures;
  else delete env.SINGULARITY_FLOW_TEST_REMOTE_FIXTURES;
  if (agent) env.SINGULARITY_FLOW_TEST_SELECTION = JSON.stringify({ workType: WORK_TYPE, agent });
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}
const flow = (cwd, args, options) => execute(process.execPath, [bin, ...args], cwd, options);
const json = (result) => JSON.parse(result.stdout);

async function fixtures() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-import-fixtures-'));
  const file = (url) => path.join(directory, new URL(url).hostname, ...new URL(url).pathname.split('/').filter(Boolean));
  for (const [url, content] of [[SKILL_URL, SKILL], [TEMPLATE_URL, TEMPLATE]]) {
    await mkdir(path.dirname(file(url)), { recursive: true });
    await writeFile(file(url), content);
  }
  // An empty fixture directory: any fetch during the Story would fail with HTTP 404.
  const offline = await mkdtemp(path.join(os.tmpdir(), 'sflow-import-offline-'));
  return { directory, offline };
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-imports-'));
  execute('git', ['init', '-b', 'main'], root);
  execute('git', ['config', 'user.name', 'Import Tester'], root);
  execute('git', ['config', 'user.email', 'imports@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Imports\n');
  flow(root, ['init']);
  await repositoryOwnedWorkflows(root);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off';
  config.worldModel.grounding = 'off';
  config.repositoryReadiness = { ...(config.repositoryReadiness ?? {}), requiredBeforeStory: false };
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  config.workTypes[WORK_TYPE] = {
    label: 'Import demo', phases: ['intake', 'design'],
    phaseOverrides: { design: { inputs: ['intake'] } },
    // Drafting a design from imported assets specifies, builds and tests nothing, and says so.
    omits: ['scope', 'plan', 'implement', 'verify'].map((responsibility) => ({
      responsibility, reason: 'This demonstration only drafts a design from imported assets.', authority: 'product-approvers'
    }))
  };
  await writeFile(configPath, YAML.stringify(config));
  execute('git', ['add', 'README.md', 'singularity', '.github/agents'], root);
  execute('git', ['commit', '-m', 'initial'], root);
  const remote = `${root}.git`;
  execute('git', ['init', '--bare', '-b', 'main', remote], root);
  execute('git', ['remote', 'add', 'origin', remote], root);
  execute('git', ['push', '-u', 'origin', 'main'], root);
  return root;
}

test('a skill and a template imported from links are vendored, reviewed once, and used by a Story without fetching', async () => {
  const { directory, offline } = await fixtures();
  const root = await repository();

  // Preview fetches and stages; nothing in the repository changes yet.
  const skill = json(flow(root, ['import', 'preview', SKILL_URL, '--as', 'skill', '--json'], { fixtures: directory }));
  assert.equal(skill.sha256, sha256(SKILL));
  assert.equal(skill.id, 'security-review');
  assert.match(skill.addCommand, /--sha256 [0-9a-f]{64}/);
  assert.equal(execute('git', ['status', '--porcelain'], root).stdout.trim(), '');

  // An add without the previewed hash shows the content and refuses.
  const unbound = flow(root, ['import', 'add', SKILL_URL, '--as', 'skill', '--agent', 'architect'], { fixtures: directory, allowFailure: true });
  assert.notEqual(unbound.status, 0);
  assert.match(unbound.stdout, /Import preview: skill/);
  assert.match(unbound.stderr, /--sha256 [0-9a-f]{64}/);

  flow(root, ['import', 'add', SKILL_URL, '--as', 'skill', '--agent', 'architect', '--phases', 'design', '--sha256', skill.sha256], { fixtures: directory });
  const template = json(flow(root, ['import', 'preview', TEMPLATE_URL, '--as', 'template', '--json'], { fixtures: directory }));
  flow(root, ['import', 'add', TEMPLATE_URL, '--as', 'template', '--phases', 'design', '--sha256', template.sha256], { fixtures: directory });

  const vendored = await readFile(path.join(root, 'singularity/imports/agents/architect/skill-security-review.md'));
  assert.equal(sha256(vendored), skill.sha256, 'the vendored skill is the exact previewed bytes');
  assert.equal(await readFile(path.join(root, 'singularity/templates/imported/threat-model.md'), 'utf8'), TEMPLATE, 'no newline is added to an imported template');
  const agentText = await readFile(path.join(root, '.github/agents/architect.agent.md'), 'utf8');
  assert.match(agentText, /\| security-review \| https:\/\/skills\.example\.org\/team\/security-review\/SKILL\.md \| design \| no \| 1048576 \|/);
  const lock = YAML.parse(await readFile(path.join(root, 'singularity/agents.lock.yml'), 'utf8'));
  assert.equal(lock.agents.architect.sourceSha256, sha256(agentText));
  assert.equal(lock.agents.architect.dependencies[0].vendored, 'singularity/imports/agents/architect/skill-security-review.md');
  const ledger = YAML.parse(await readFile(path.join(root, 'singularity/imports.lock.yml'), 'utf8'));
  assert.deepEqual(Object.keys(ledger.imports).sort(), ['skill:architect/security-review', 'template:threat-model']);
  assert.equal(ledger.imports['template:threat-model'].source.url, TEMPLATE_URL);
  const listed = json(flow(root, ['imports', '--json'], { fixtures: offline }));
  assert.deepEqual(listed.imports.map((row) => row.status), ['current', 'current']);

  execute('git', ['add', '-A'], root);
  execute('git', ['commit', '-m', 'import a skill and a template'], root);
  execute('git', ['push', 'origin', 'main'], root);

  // From here on every fetch would fail: the Story must run from the vendored copies alone.
  flow(root, ['start', 'IMP-1', '--from-branch', 'main'], { agent: 'product-owner', fixtures: offline });
  const item = path.join(root, 'singularity/work-items/IMP-1');
  const intake = path.join(item, 'artifacts/intake/intake.md');
  let text = await readFile(intake, 'utf8');
  text = text.replace(/TODO:[^\n]*/g, 'matched evidence for AC-001 with exact file references and complete operational detail.').replace(/\bTODO\b/g, 'matched evidence');
  await writeFile(intake, `${text}\nIntake note.\n`);
  flow(root, ['resume', 'IMP-1'], { agent: 'product-owner', fixtures: offline });
  flow(root, ['phase', 'publish', 'intake'], { agent: 'product-owner', fixtures: offline });
  flow(root, ['submit'], { agent: 'product-owner', fixtures: offline });
  flow(root, ['approve', '--yes'], { agent: 'product-owner', fixtures: offline });
  flow(root, ['prepare', 'design'], { agent: 'architect', fixtures: offline });

  const design = await readFile(path.join(item, 'artifacts/design/design.md'), 'utf8');
  assert.match(design, /^# IMP-1 threat model$/m, 'the design draft starts from the imported template');
  assert.match(design, new RegExp(`config/wfa/blobs/sha256/${template.sha256}`), 'the Story renders the retained copy of the imported template');
  // Composing the design prompt injects the imported skill and records exactly which bytes it used.
  const composed = flow(root, ['wm', 'compose', '--phase', 'design'], { agent: 'architect', fixtures: offline });
  assert.equal(composed.status, 0);
  const audit = JSON.parse(await readFile(path.join(item, 'context/agents-design-gen1.json'), 'utf8'));
  assert.equal(audit.agent, 'architect');
  assert.deepEqual(audit.files.map((file) => [file.id, file.sha256]), [['security-review', skill.sha256]]);

  // The Story's own snapshot retains the skill's bytes.
  const snapshots = path.join(item, 'config/wfa/snapshots');
  const [first] = (await readdir(snapshots)).sort();
  const manifest = JSON.parse(await readFile(path.join(snapshots, first, 'manifest.json'), 'utf8'));
  const dependency = manifest.executionDependencies.find((entry) => entry.id === 'agent:architect:skill:security-review');
  assert.equal(dependency?.inclusion, 'included');
  assert.equal(dependency.contentSha256.replace(/^sha256:/, ''), skill.sha256);
});
