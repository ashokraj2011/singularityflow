/** Disposable real-engine fixtures for installed VS Code UI qualification, not a human approval record. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { initializeDefinition, loadDefinition, resolveWorkType } from '../src/config.mjs';
import { CONFIGURATION_BRANCH, loadStoryConfigurationSnapshot, materializeConfigurationSnapshot } from '../src/configuration-branch.mjs';
import { applyCapabilityPolicyToWorkResolution, resolveLifecycleCapability } from '../src/capability-context.mjs';
import { buildRepositoryReadinessPlan, executeRepositoryReadinessPlan } from '../src/initialization/runtime-readiness.mjs';
import { collectRepositoryReadinessEvidence } from '../src/repository-readiness-evidence.mjs';
import { previewTestRecoveryIntake } from '../src/test-recovery-intake.mjs';
import { withOperationContext } from '../src/operation-context.mjs';
import { createWorkflow, commitAndPublish, publishGeneration, scanArtifacts, workDir } from '../src/state.mjs';
import { buildGenerationAuthorship, normalizeAuthorshipOptions } from '../src/manual-authorship.mjs';
import { generationStartPublicationBinding } from '../src/generation-boundary.mjs';
import { setAgentSession } from '../src/session.mjs';
import { activateWorkspaceContext } from '../src/workspace-context.mjs';

const author = { name: 'TRP UI Author', email: 'trp.ui.author@example.com', login: null };
const reviewer = { name: 'TRP UI Reviewer', email: 'trp.ui.reviewer@example.com', login: null };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const invoke = (root, callback) => withOperationContext({ root, command: 'test',
  operation: { id: 'test.trp-installed-ui', command: 'test', modelPolicy: 'never' },
  modelMode: { enabled: false, source: 'test' } }, callback);

async function repository(base, name, { risk = false } = {}) {
  const workspace = path.join(base, name);
  const root = path.join(workspace, 'repos/application');
  const remote = path.join(base, `${name}.git`);
  await mkdir(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', author.name); git(root, 'config', 'user.email', author.email);
  process.env.SINGULARITY_FLOW_TEST_IDENTITY = author.name;
  await initializeDefinition(root);
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, '.gitignore'), 'node_modules/\n.sflow/results/\n');
  await writeFile(path.join(root, 'README.md'), '# Disposable installed-UI qualification fixture\n');
  await writeFile(path.join(root, 'src/service.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name, version: '1.0.0', private: true,
    scripts: { test: 'node --test --test-reporter=tap test/service.test.mjs' } }));
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ name, version: '1.0.0',
    lockfileVersion: 3, requires: true, packages: { '': { name, version: '1.0.0' } } }));
  await writeFile(path.join(root, 'test/service.test.mjs'), risk
    ? "import test from 'node:test'; test('baseline readiness', () => {});\n"
    : "import test from 'node:test'; import assert from 'node:assert/strict'; test('existing UI fixture failure', () => assert.fail('pre-existing failure'));\n");
  const definitionFile = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionFile, 'utf8'));
  definition.git.publish = 'off';
  definition.approvalSecurity = { profile: 'team', allowSelfApproval: false, autoEnrollNewIdentities: false };
  definition.approvalAuthorities['risk-reviewers'] = { label: 'Fixture risk reviewers', allowAnyGitIdentity: false,
    members: [{ name: reviewer.name, email: reviewer.email, githubLogin: null }] };
  definition.approvalAuthorities['engineering-reviewers'] = { label: 'Fixture phase reviewers', allowAnyGitIdentity: false,
    members: [{ name: reviewer.name, email: reviewer.email, githubLogin: null }] };
  definition.testRecovery = risk ? { enabled: true, riskAuthorities: ['risk-reviewers'],
    enabledRiskCategories: ['validation-unavailable'], allowEvidenceReuse: false, maxRiskDays: 7 } : { enabled: true };
  definition.workTypes.feature = { label: 'TRP UI Feature', phases: ['implementation'],
    omits: ['scope', 'plan', 'review'].map((responsibility) => ({ responsibility, reason: 'Disposable UI fixture with no specification, plan or review step.', authority: 'engineering-reviewers' })), spec: { acceptance: 'off' } };
  Object.assign(definition.phases.implementation, { inputs: [], clarification: { mode: 'off' },
    qualityCommands: [{ id: 'ui-required-test', kind: 'test', argv: [path.join(root, 'tools/missing-test-runtime')],
      workingDirectory: '.', affectedRoots: ['.'], modelPolicy: 'never',
      result: { adapter: 'node-tap', path: '.sflow/results/required.tap', minimumDiscovered: 1, minimumPassed: 1 } }] });
  await writeFile(definitionFile, YAML.stringify(definition));
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Disposable approved UI fixture configuration');
  git(base, 'clone', '-q', '--bare', root, remote); git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', 'origin', `HEAD:refs/heads/${CONFIGURATION_BRANCH}`);
  const approved = await loadStoryConfigurationSnapshot({ remote, branch: CONFIGURATION_BRANCH });
  await materializeConfigurationSnapshot(root, { snapshot: approved });
  git(root, 'add', 'singularity'); git(root, 'commit', '-qm', 'Materialize exact approved fixture configuration');
  git(root, 'push', '-q', 'origin', 'main');
  const baseCommit = git(root, 'rev-parse', 'HEAD');
  const readinessPlan = await buildRepositoryReadinessPlan(root, { scope: 'dependency-test' });
  if (risk) {
    const readinessRun = await executeRepositoryReadinessPlan(root,
      { scope: 'dependency-test', confirmation: readinessPlan.planId });
    assert.equal(readinessRun.receipt.status, 'pass');
  } else {
    await assert.rejects(executeRepositoryReadinessPlan(root,
      { scope: 'dependency-test', confirmation: readinessPlan.planId }),
    { code: 'REPOSITORY_READINESS_COMMAND_FAILED' });
  }
  if (risk) {
    const id = 'TRP-UI-RISK';
    const readinessRepositories = [{ id: 'application', root, baseCommit, baseBranch: 'main' }];
    const repositoryReadiness = await collectRepositoryReadinessEvidence(readinessRepositories, { scope: 'dependency-test' });
    const config = await loadDefinition(root); const resolved = resolveWorkType(config, 'feature');
    const testRecoveryPlan = previewTestRecoveryIntake({ definition: config, workId: id, workType: 'feature',
      repositories: readinessRepositories, repositoryReadiness,
      choices: { baselineDisposition: 'fix', executionMode: 'all-configured', baselineScope: 'reuse' },
      phaseDefinitions: applyCapabilityPolicyToWorkResolution(resolved, await resolveLifecycleCapability(root)).phases });
    assert.equal(testRecoveryPlan.ready, true, JSON.stringify(testRecoveryPlan.blockers));
    git(root, 'switch', '-q', '-c', id);
    await setAgentSession(root, config, author, 'developer', id, { phaseId: 'implementation', source: 'test' });
    const workflow = await invoke(root, () => createWorkflow(root, config, { id, title: 'Installed UI risk-review fixture',
      source: { type: 'manual', key: id, title: 'Installed UI risk-review fixture',
        description: 'Inspect an exact unavailable observation without accepting risk through UI automation.',
        acceptanceCriteria: ['Preserve source and observed unavailability.'] }, baseBranch: 'main', baseCommit,
      workType: 'feature', agent: 'developer', resolved, readinessRepositories, repositoryReadiness,
      testRecoveryPlan, approvedConfigurationSnapshot: approved }));
    await invoke(root, () => commitAndPublish(root, config, workflow, { type: 'binding' }, 'Bind disposable UI Story fixture'));
    const phase = workflow.phases.implementation;
    await writeFile(path.join(workDir(root, config, id), phase.requiredArtifact.path),
      '# Implementation\n\nDisposable UI fixture: source generated; configured test runtime unavailable. No current test pass or risk approval is claimed.\n\nThe service changes its exported value from one to two. The authored test compares the candidate value with two. The deliberately absent configured executable must remain unavailable, and the UI may only preview exact evidence and stage an explicit human terminal review.\n');
    await writeFile(path.join(root, 'src/service.mjs'), 'export const value = 2;\n');
    await writeFile(path.join(root, 'test/service.test.mjs'),
      "import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/service.mjs'; test('candidate test',()=>assert.equal(value,2));\n");
    git(root, 'add', 'src/service.mjs', 'test/service.test.mjs'); git(root, 'commit', '-qm', 'Fixture source before unverified validation');
    const authorship = buildGenerationAuthorship({ options: normalizeAuthorshipOptions({ producer: 'human',
      channel: 'manual-in-place', externalAiUse: 'none' }), actor: author, governedAgentContext: 'developer', source: null });
    await assert.rejects(invoke(root, async () => {
      await scanArtifacts(root, config, workflow, phase.id);
      const payload = await generationStartPublicationBinding(root, workflow, phase);
      return commitAndPublish(root, config, workflow, { type: 'artifact-generated', phaseId: phase.id,
        generation: 1, payload }, 'Attempt actual unavailable fixture validation', phase.artifacts.map(entry => entry.path), {
        beforeStateWrite: (publicationEvent, transaction) => publishGeneration(root, config, workflow,
          { phaseId: phase.id, authorship, persist: false, publicationTransaction: { publicationEvent,
            transactionId: transaction.transactionId, expectedHead: transaction.expectedHead } })
      });
    }), { code: 'TRP_PHASE_GATE_BLOCKED' });
  }
  git(root, 'config', 'user.name', reviewer.name); git(root, 'config', 'user.email', reviewer.email);
  await writeFile(path.join(workspace, 'workspace.json'), JSON.stringify({ version: 1, id: name, name,
    anchor: { provider: 'workspace', key: name, title: name }, leadRepository: 'application', capabilities: [],
    repositories: { application: { url: remote, defaultBranch: 'main', path: 'repos/application', capabilities: [] } }
  }, null, 2));
  return { id: name, root, workspace, remote, baseCommit, risk };
}

export async function createInstalledUiFixture() {
  const base = await realpath(await mkdtemp('/tmp/sftrp-ui-'));
  const machine = path.join(base, 'm'); const userData = path.join(base, 'u'); const extensions = path.join(base, 'e');
  await Promise.all([mkdir(machine), mkdir(path.join(userData, 'User'), { recursive: true }), mkdir(extensions)]);
  const environment = { NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: reviewer.name,
    HOME: machine, VSCODE_CLI: '1',
    SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_HOME: path.join(machine, 'home'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(machine, 'active-workspace.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(machine, 'workspaces.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(machine, 'leads.json'),
    SINGULARITY_FLOW_VSCODE_RESET_MARKER: path.join(machine, 'vscode-fresh-reset-pending.json'),
    SINGULARITY_FLOW_AST_PREFERENCE_FILE: path.join(machine, 'ast-preference.json'),
    SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(machine, 'transport-outbox'),
    SINGULARITY_FLOW_STORY_CONFIGURATION_CACHE: path.join(machine, 'configuration-cache'),
    GIT_ALLOW_PROTOCOL: 'file', GIT_PROTOCOL_FROM_USER: '0', GIT_CONFIG_GLOBAL: path.join(machine, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1',
    http_proxy: 'http://127.0.0.1:1', https_proxy: 'http://127.0.0.1:1', all_proxy: 'http://127.0.0.1:1',
    NO_PROXY: '', no_proxy: '' };
  Object.assign(process.env, environment);
  const intake = await repository(base, 'trp-ui-intake');
  const risk = await repository(base, 'trp-ui-risk', { risk: true });
  process.env.SINGULARITY_FLOW_TEST_IDENTITY = reviewer.name;
  await writeFile(environment.SINGULARITY_FLOW_WORKSPACE_REGISTRY, JSON.stringify([intake, risk].map(value => ({
    id: value.id, name: value.id, path: value.workspace, anchorKey: value.id, anchorType: 'Workspace',
    openedAt: new Date().toISOString() })), null, 2));
  await activateWorkspaceContext(environment.SINGULARITY_FLOW_WORKSPACE_REGISTRY,
    environment.SINGULARITY_FLOW_ACTIVE_WORKSPACE, intake.id, { repositoryId: 'application', detectStory: false });
  await writeFile(path.join(userData, 'User/settings.json'), JSON.stringify({
    'git.path': execFileSync('which', ['git'], { encoding: 'utf8' }).trim(),
    'singularityFlow.nodePath': process.execPath, 'singularityFlow.modelMode': 'disabled',
    'singularityFlow.userName': reviewer.name, 'singularityFlow.role': 'developer',
    'telemetry.telemetryLevel': 'off', 'extensions.autoUpdate': false, 'update.mode': 'none',
    'workbench.startupEditor': 'none', 'window.title': 'TRP QUALIFICATION · ${rootName}${separator}${appName}'
  }, null, 2));
  const manifest = { schemaVersion: 1, purpose: 'disposable-installed-ui-qualification', base, userData,
    extensions, environment, fixtures: { intake, risk }, node: process.execPath };
  await writeFile(path.join(base, 'fixture.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await createInstalledUiFixture(), null, 2));
}
