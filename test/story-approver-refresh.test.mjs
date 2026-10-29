import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { loadAcceptedStoryExecution } from '../src/accepted-story-execution.mjs';
import { APPROVER_REFRESH_DIALECT, applyApproverRefresh, approverRefreshAdditions, approverRefreshPolicyDigest, assertApproverRefreshScope } from '../src/approver-refresh-contracts.mjs';
import { refreshStoryApprovers } from '../src/commands/story-approvers.mjs';
import { initializeDefinition, loadDefinition, resolveWorkType } from '../src/config.mjs';
import { CONFIGURATION_BRANCH, loadStoryConfigurationSnapshot, materializeConfigurationSnapshot } from '../src/configuration-branch.mjs';
import { recordApplicabilityDecision } from '../src/evidence/applicability.mjs';
import { generationStartPublicationBinding } from '../src/generation-boundary.mjs';
import { buildRepositoryReadinessPlan, executeRepositoryReadinessPlan } from '../src/initialization/runtime-readiness.mjs';
import { buildGenerationAuthorship, normalizeAuthorshipOptions } from '../src/manual-authorship.mjs';
import { withOperationContext } from '../src/operation-context.mjs';
import { collectRepositoryReadinessEvidence } from '../src/repository-readiness-evidence.mjs';
import { setAgentSession } from '../src/session.mjs';
import { approvePhase, commitAndPublish, createWorkflow, publishGeneration, scanArtifacts, submitPhase, workDir } from '../src/state.mjs';
import { applyStoryApproverRefresh } from '../src/story-approver-refresh.mjs';
import { createStoryReviewPacket } from '../src/story-lineage.mjs';
import { verifyWorkflowSnapshot } from '../src/workflow-snapshots.mjs';

// A Story's approval groups are fixed when it starts, so a group whose only approver left could
// never gain anyone and the Story could not finish (2026-10-29). The refresh carries members the
// approved configuration added into the running Story, and nothing else.
const ID = 'APPROVERS-1';
const author = { name: 'Story Author', email: 'story.author@example.com', login: null };
const departed = { name: 'Departed Reviewer', email: 'departed.reviewer@example.com', githubLogin: null };
const reviewer = { name: 'New Reviewer', email: 'new.reviewer@example.com', login: null };
const git = (root, ...argv) => execFileSync('git', argv, { cwd: root, encoding: 'utf8' }).trim();
const context = (root, invoke) => withOperationContext({ root, command: 'test',
  operation: { id: 'test.approver-refresh', command: 'test', modelPolicy: 'never' },
  modelMode: { enabled: false, source: 'test' } }, invoke);
const authorship = buildGenerationAuthorship({ options: normalizeAuthorshipOptions({ producer: 'human',
  channel: 'manual-in-place', externalAiUse: 'none' }), actor: author, governedAgentContext: 'developer', source: null });
const reason = 'The new reviewer joined the engineering group after the last one left the team.';

function setActor(root, actor) {
  git(root, 'config', 'user.name', actor.name); git(root, 'config', 'user.email', actor.email);
  process.env.SINGULARITY_FLOW_TEST_IDENTITY = actor.name;
}

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-approver-refresh-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'application'); const remote = path.join(base, 'remote.git');
  const publisher = path.join(base, 'publisher');
  await mkdir(root);
  const environment = { NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: author.name,
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active-workspace.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'),
    SINGULARITY_FLOW_STORY_CONFIGURATION_CACHE: path.join(base, 'configuration-cache') };
  const prior = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => { for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  git(root, 'init', '-q', '-b', 'main'); setActor(root, author);
  await initializeDefinition(root);
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, '.gitignore'), 'node_modules/\n.sflow/results/\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'approver-refresh', version: '1.0.0', private: true,
    scripts: { test: 'node --test --test-reporter=tap test/*.test.mjs' } }));
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'approver-refresh', version: '1.0.0',
    lockfileVersion: 3, requires: true, packages: { '': { name: 'approver-refresh', version: '1.0.0' } } }));
  await writeFile(path.join(root, 'src/service.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'test/generated.test.mjs'), "import test from 'node:test'; test('baseline', () => {});\n");
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  definition.approvalSecurity = { profile: 'team', allowSelfApproval: false, autoEnrollNewIdentities: false };
  // The group's only approver has since left; the Story starts with them.
  definition.approvalAuthorities['engineering-reviewers'] = { label: 'Engineering reviewers', allowAnyGitIdentity: false, members: [departed] };
  delete definition.testRecovery;
  definition.workTypes.feature = { label: 'Feature', phases: ['implementation'],
    omits: ['scope', 'plan', 'review'].map((responsibility) => ({ responsibility, reason: 'Isolated approver refresh fixture with no specification, plan or review step.', authority: 'engineering-reviewers' })),
    spec: { acceptance: 'off' } };
  const phase = definition.phases.implementation;
  phase.inputs = []; phase.clarification = { mode: 'off' };
  phase.qualityCommands = [{ id: 'node-tests', kind: 'test',
    argv: [process.execPath, '--test', '--test-reporter=tap', 'test/generated.test.mjs'],
    workingDirectory: '.', affectedRoots: ['.'], modelPolicy: 'never',
    result: { adapter: 'node-tap', path: '.sflow/results/generated.tap', minimumDiscovered: 1, minimumPassed: 1 } }];
  await writeFile(definitionPath, YAML.stringify(definition));
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Application and approved initial policy');
  git(base, 'clone', '-q', '--bare', root, remote); git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', 'origin', `HEAD:refs/heads/${CONFIGURATION_BRANCH}`);
  git(base, 'clone', '-q', '-b', CONFIGURATION_BRANCH, remote, publisher);
  git(publisher, 'config', 'user.name', 'Configuration Publisher');
  git(publisher, 'config', 'user.email', 'configuration.publisher@example.invalid');
  const approved = await loadStoryConfigurationSnapshot({ remote, branch: CONFIGURATION_BRANCH });
  await materializeConfigurationSnapshot(root, { snapshot: approved });
  git(root, 'add', 'singularity'); git(root, 'commit', '-qm', 'Materialize exact approved configuration');
  const baseCommit = git(root, 'rev-parse', 'HEAD');
  const readinessPlan = await buildRepositoryReadinessPlan(root, { scope: 'dependency-test' });
  await executeRepositoryReadinessPlan(root, { scope: 'dependency-test', confirmation: readinessPlan.planId });
  const repositoryReadiness = await collectRepositoryReadinessEvidence([{ id: 'application', root, baseCommit }], { scope: 'dependency-test' });
  const config = await loadDefinition(root);
  const resolved = resolveWorkType(config, 'feature');
  git(root, 'switch', '-q', '-c', ID);
  await setAgentSession(root, config, author, 'developer', ID, { phaseId: 'implementation', source: 'test' });
  const workflow = await context(root, () => createWorkflow(root, config, { id: ID, title: 'Finish a Story whose reviewer left',
    source: { type: 'manual', key: ID, title: 'Finish a Story whose reviewer left',
      description: 'Bring the group\'s new reviewer into the running Story and approve its implementation.',
      acceptanceCriteria: ['The new reviewer approves the implementation.'] },
    baseBranch: 'main', baseCommit, workType: 'feature', agent: 'developer', resolved,
    readinessRepositories: [{ id: 'application', baseCommit, baseBranch: 'main' }], repositoryReadiness, approvedConfigurationSnapshot: approved }));
  await context(root, () => commitAndPublish(root, config, workflow, { type: 'binding' }, 'Bind Story under its original groups'));
  await context(root, () => commitAndPublish(root, config, workflow, { type: 'decision-made', payload: { decision: 'applicability' } },
    'Record why the omitted responsibilities do not apply', [], {
      beforeStateWrite: () => {
        for (const responsibility of ['scope', 'plan', 'review']) {
          recordApplicabilityDecision(workflow, { responsibility, reason: 'An isolated approver refresh fixture with one implementation step.',
            actor: departed.email, authorityGroup: 'engineering-reviewers', at: new Date().toISOString() });
        }
      }
    }));
  const artifact = path.join(workDir(root, config, workflow.workItem.id), workflow.phases.implementation.requiredArtifact.path);
  await writeFile(artifact, ['# Implementation', '', 'Implemented the requested service value and the test that verifies it.', '',
    '## Delivery evidence', '', 'The generated test imports the actual service and checks the requested value through the pinned command.', '',
    '## Residual risk', '', 'This fixture claims only the configured Node test inventory for one implementation step.', ''].join('\n'));
  await writeFile(path.join(root, 'src/service.mjs'), 'export const value = 2;\n');
  await writeFile(path.join(root, 'test/generated.test.mjs'), [
    "import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/service.mjs';",
    "test('generated feature',()=>{ assert.equal(value,2); });", ''].join('\n'));
  git(root, 'add', 'src/service.mjs', 'test/generated.test.mjs');
  git(root, 'commit', '-qm', 'Implement the service value and its test');
  const value = { root, remote, publisher, config, workflow };
  value.reload = async () => {
    const loaded = await loadAcceptedStoryExecution(root, ID);
    value.config = loaded.config; value.workflow = loaded.workflow;
    return loaded;
  };
  value.configure = async (change) => {
    const file = path.join(publisher, 'singularity/workflow.yml');
    const next = YAML.parse(await readFile(file, 'utf8'));
    change(next);
    await writeFile(file, YAML.stringify(next)); git(publisher, 'add', 'singularity/workflow.yml');
    git(publisher, 'commit', '-qm', 'Approve engineering group membership'); git(publisher, 'push', '-q', 'origin', CONFIGURATION_BRANCH);
  };
  value.publish = () => context(root, async () => {
    const current = value.workflow.phases.implementation;
    await scanArtifacts(root, value.config, value.workflow, current.id);
    const payload = await generationStartPublicationBinding(root, value.workflow, current);
    return commitAndPublish(root, value.config, value.workflow, { type: 'artifact-generated', phaseId: current.id,
      generation: current.generation + 1, payload }, 'Publish the implementation', current.artifacts.map(entry => entry.path), {
      beforeStateWrite: (publicationEvent, transactionContext) => publishGeneration(root, value.config, value.workflow,
        { phaseId: current.id, authorship, persist: false, publicationTransaction: { publicationEvent,
          transactionId: transactionContext.transactionId, expectedHead: transactionContext.expectedHead } })
    });
  });
  value.submit = () => context(root, () => commitAndPublish(root, value.config, value.workflow,
    { type: 'approval-requested', phaseId: 'implementation', generation: value.workflow.phases.implementation.generation },
    'Submit the implementation for approval', [], {
      beforeStateWrite: async () => {
        const phase = await submitPhase(root, value.config, value.workflow, { phaseId: 'implementation', actor: author, agent: 'developer', persist: false });
        await createStoryReviewPacket(root, value.config, value.workflow, phase);
      }
    }));
  value.approve = () => context(root, () => commitAndPublish(root, value.config, value.workflow,
    { type: 'phase-approved', phaseId: 'implementation', generation: value.workflow.phases.implementation.generation,
      actor: reviewer, agent: null, authorityGroup: 'engineering-reviewers' }, 'Approve the implementation', [], {
      beforeStateWrite: () => approvePhase(root, value.config, value.workflow, { phaseId: 'implementation', actor: reviewer, agent: null, persist: false })
    }));
  return value;
}

// The person's live terminal review stands in for the reviewed card only; every other check runs.
const terminal = { capture: async () => ({ token: 'live-review' }), consume: async () => ({ authorizationId: randomUUID() }) };
const refresh = (value, options) => context(value.root, () => refreshStoryApprovers({ root: value.root, positionals: [ID], options }, {
  apply: (root, config, workflow, refreshOptions) => applyStoryApproverRefresh(root, config, workflow, refreshOptions, terminal)
}));

test('a Story whose only reviewer left takes the new reviewer from the approved configuration, and they approve it', async (t) => {
  const value = await fixture(t);
  await value.reload(); await value.publish(); await value.reload(); await value.submit(); await value.reload();
  assert.equal(value.workflow.phases.implementation.status, 'awaiting_approval');
  setActor(value.root, reviewer);
  await assert.rejects(value.approve(), /not a member/u, 'the new reviewer is not in the Story\'s pinned group yet');
  await value.reload();

  // Nothing approved yet: there is nobody to add.
  await assert.rejects(refresh(value, { reason }), { code: 'APR_NOTHING_TO_ADD' });
  // The configuration adds the new reviewer and also drops the departed one; only the addition applies.
  await value.configure((next) => { next.approvalAuthorities['engineering-reviewers'].members = [{ name: reviewer.name, email: reviewer.email, githubLogin: null }]; });
  const preview = await refresh(value, { reason });
  assert.equal(preview.status, 'ready');
  assert.deepEqual(preview.additions['engineering-reviewers'].map((member) => member.email), [reviewer.email]);
  assert.deepEqual(preview.notApplied, [{ group: 'engineering-reviewers', change: 'removed-members', count: 1 }]);
  assert.match(preview.legalActions[0].command, /^singularity-flow story approvers refresh APPROVERS-1 --reason ".*" --confirm sha256:[a-f0-9]{64}$/u);

  // A record the refresh would make stale holds it, named.
  const risky = structuredClone(value.workflow);
  risky.qualityRiskDecisions = [{ id: 'PQR-held', gate: 'SPEC_COVERAGE_INCOMPLETE', expiresAt: '2099-01-01T00:00:00.000Z', binding: { phaseId: 'implementation' } }];
  const approved = await loadStoryConfigurationSnapshot({ remote: value.remote, branch: CONFIGURATION_BRANCH });
  await assert.rejects(context(value.root, () => applyStoryApproverRefresh(value.root, value.config, risky,
    { approvedConfigurationSnapshot: approved, reason, confirm: preview.planSha256 }, terminal)),
  (error) => error.code === 'APR_REFRESH_BLOCKED' && /PQR-held/u.test(error.message));

  const recorded = await refresh(value, { reason, confirm: preview.planSha256 });
  assert.equal(recorded.applied, true);
  assert.equal(recorded.refreshId, 'APR-001');
  await value.reload();
  const members = value.workflow.resolution.approvalAuthorities['engineering-reviewers'].members.map((member) => member.email);
  assert.deepEqual(members, [departed.email, reviewer.email], 'the departed member stays: removals never reach a running Story');
  assert.equal(value.workflow.workflowSnapshot.revision, 2);
  const verified = await verifyWorkflowSnapshot(value.root, value.config, value.workflow, { requireAccepted: true });
  assert.equal(verified.revision, 2);
  const manifest = JSON.parse(await readFile(path.join(value.root, value.workflow.workflowSnapshot.manifestPath), 'utf8'));
  assert.equal(manifest.semantics.amendment, APPROVER_REFRESH_DIALECT, 'the snapshot reader names the same dialect as the contracts');
  assert.equal(value.workflow.phases.implementation.status, 'awaiting_approval', 'the refresh left the submission as it was');

  // The refresh commit sits between the submission and its approval; the new reviewer approves.
  await value.approve();
  await value.reload();
  assert.equal(value.workflow.phases.implementation.status, 'approved');
  assert.equal(value.workflow.phases.implementation.approvals.at(-1).authorityGroup, 'engineering-reviewers');
  assert.equal(value.workflow.status, 'closed', 'the final check passed with the earlier decisions still verifying');
});

test('a refresh changes only members of existing groups, and its replay refuses anything else', () => {
  const groups = { reviewers: { label: 'Reviewers', allowAnyGitIdentity: false, members: [{ email: 'a@example.invalid', githubLogin: null }] } };
  const offered = { reviewers: { label: 'Renamed', allowAnyGitIdentity: true, members: [{ email: 'b@example.invalid', githubLogin: null }] },
    newcomers: { label: 'New', allowAnyGitIdentity: false, members: [] } };
  const { additions, ignored } = approverRefreshAdditions(groups, offered);
  assert.deepEqual(additions, { reviewers: [{ email: 'b@example.invalid', githubLogin: null }] });
  assert.deepEqual(ignored.map((entry) => entry.change).sort(), ['group-rule', 'new-group', 'removed-members']);
  const before = { approvalAuthorities: groups, configurationSource: { repository: 'origin', commit: 'a'.repeat(40) }, phases: [] };
  before.policySha256 = approverRefreshPolicyDigest(before);
  const after = { ...structuredClone(before), approvalAuthorities: applyApproverRefresh(groups, additions),
    configurationSource: { repository: 'origin', commit: 'b'.repeat(40), filesSha256: null } };
  after.policySha256 = approverRefreshPolicyDigest(after);
  assertApproverRefreshScope(before, after, { additions });
  const removed = structuredClone(after); removed.approvalAuthorities.reviewers.members.shift(); removed.policySha256 = approverRefreshPolicyDigest(removed);
  assert.throws(() => assertApproverRefreshScope(before, removed, { additions }), { code: 'APR_REFRESH_INVALID' });
  const loosened = structuredClone(after); loosened.approvalAuthorities.reviewers.allowAnyGitIdentity = true; loosened.policySha256 = approverRefreshPolicyDigest(loosened);
  assert.throws(() => assertApproverRefreshScope(before, loosened, { additions }), { code: 'APR_REFRESH_INVALID' });
  const widened = structuredClone(after); widened.phases = [{ id: 'extra' }]; widened.policySha256 = approverRefreshPolicyDigest(widened);
  assert.throws(() => assertApproverRefreshScope(before, widened, { additions }), { code: 'APR_REFRESH_INVALID' });
  assert.throws(() => assertApproverRefreshScope(before, { ...after, configurationSource: before.configurationSource }, { additions }), { code: 'APR_REFRESH_INVALID' });
});

// Every outcome the command emits must be a registered message: without them each preview, and each
// confirmed refresh after its commit, ended in COMMAND_RESULT_INVALID (2026-10-29).
test('every outcome story approvers refresh reports is a registered message', async () => {
  const { commandResult, succeeded, noEffects } = await import('../src/narration/command-result.mjs');
  const source = await (await import('node:fs/promises')).readFile(new URL('../src/commands/story-approvers.mjs', import.meta.url), 'utf8');
  const ids = [...source.matchAll(/'(story\.approvers\.refresh-[a-z]+)'/gu)].map((match) => match[1]);
  assert.deepEqual(ids.sort(), ['story.approvers.refresh-planned', 'story.approvers.refresh-recorded', 'story.approvers.refresh-unchanged']);
  for (const id of ids) {
    assert.doesNotThrow(() => commandResult({ operation: { id: 'story.approvers.refresh', classification: 'mutation' },
      outcome: succeeded(id, { status: 'ready' }), effects: noEffects(), restState: 'informational', data: {} }), id);
  }
});
