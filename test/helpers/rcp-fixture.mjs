import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os'; import path from 'node:path'; import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import {remoteFingerprint} from '../../src/git-remote-diagnostics.mjs';
import { initializeDefinition } from '../../src/config.mjs';

export const registeredRcpPolicy = (overrides = {}) => ({ schemaVersion: 1, mode: 'enforce',
  subjectTemplate: '{trackingKey}: {summary}', subjectPattern: '^[A-Z]{3,7}-[0-9]{1,7}: .+$', maxSubjectBytes: 120,
  tracking: { required: true, allowedKinds: ['story'], keyPattern: '^[A-Z]{3,7}-[0-9]{1,7}$', bindings: { story: 'repository-story' } },
  validation: { adapter: 'registered-checks', profile: 'message-v1' },
  profiles: { 'message-v1': { schemaVersion: 1, adapter: 'registered-checks', platforms: ['darwin', 'win32', 'linux'],
    checks: [{ id: 'message', rule: 'message-envelope' }], coverage: [{ stage: 'repository-message', checks: ['message'] }] } }, ...overrides });

/** Fixture setup represents the repository's existing human/configuration authority, outside SFlow writers. */
export async function rcpFixture(t, policy = registeredRcpPolicy()) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-rcp-owner-'));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 80 }));
  function git(cwd, args, options = {}) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000, ...options });
    if (result.status !== 0) throw new Error(`${args[0]}: ${result.stderr}`);
    return result.stdout.trim();
  }
  const source = path.join(base, 'source'), remote = path.join(base, 'authority.git'), root = path.join(base, 'workspace');
  git(base, ['init', '-q', '--template=', '-b', 'main', source]);
  git(source, ['config', 'user.name', 'Repository Owner']); git(source, ['config', 'user.email', 'owner@example.invalid']);
  await initializeDefinition(source);
  const definitionFile = path.join(source, 'singularity/workflow.yml');
  if (typeof policy === 'function') policy = policy({repository: `sha256:${remoteFingerprint(pathToFileURL(remote).href)}`});
  const definition = YAML.parse(await readFile(definitionFile, 'utf8')); definition.git.commitPolicy = policy;
  await writeFile(definitionFile, YAML.stringify(definition));
  await writeFile(path.join(source, 'source.js'), 'export const value = 1;\n');
  git(source, ['add', '.']); git(source, ['commit', '-qm', 'Existing repository setup']);
  git(source, ['branch', 'sflow/config']); git(base, ['clone', '-q', '--bare', source, remote]);
  git(base, ['clone', '-q', pathToFileURL(remote).href, root]);
  git(root, ['config', 'user.name', 'Story Author']); git(root, ['config', 'user.email', 'author@example.invalid']);
  git(root, ['switch', '-q', '-c', 'WEB-221']);
  await mkdir(path.join(root, 'singularity/work-items/WEB-221'), { recursive: true });
  const workflow = { workItem: { id: 'WEB-221', source: { type: 'jira', key: 'WEB-221', id: 'issue-221' } },
    lineage: { parentStoryId: 'EPIC-10', currentJiraKey: 'WEB-221', initialJiraKey: 'WEB-221', jiraIssueId: 'issue-221' } };
  const workflowPath = path.join(root, 'singularity/work-items/WEB-221/workflow.json');
  await writeFile(workflowPath, JSON.stringify(workflow));
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'Existing Story tracking']);
  const parent = git(root, ['rev-parse', 'HEAD']);
  async function candidate(text = 'export const value = 2;\n') {
    await writeFile(path.join(root, 'source.js'), text);
    const index = path.join(base, 'candidate-index');
    const env = { ...process.env, GIT_INDEX_FILE: index };
    git(root, ['read-tree', parent], { env }); git(root, ['add', 'source.js'], { env });
    return git(root, ['write-tree'], { env });
  }
  return { base, root, remote, source, parent, workflow, workflowPath, definition, git, candidate,
    subject: { kind: 'story', id: 'WEB-221' }, ref: 'refs/heads/WEB-221' };
}
