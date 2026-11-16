/**
 * SPEC-SCF stage 4, SCF:REQ-020 and D9 (finding CH-F2): a running Story adopts new approvers however far
 * sflow/config moved since it started, and, when sflow/config was rewritten outside SFlow, an approver
 * adopts it in the same step, recorded as adopted without ancestry.
 *
 * The ancestry fetch was a 128-commit window: after about sixty approvals the preview said ready and the
 * apply failed with no route. It is now one commits-only fetch with no depth limit. A chain that fits 128
 * commits is still a v1 proof; a longer one is a v2 proof, bounded by size, written only where the
 * repository's minimum build reads it.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { loadAcceptedStoryExecution } from '../src/accepted-story-execution.mjs';
import { refreshStoryApprovers } from '../src/commands/story-approvers.mjs';
import { initializeDefinition, loadDefinition, resolveWorkType } from '../src/config.mjs';
import { CONFIGURATION_BRANCH, loadStoryConfigurationSnapshot, materializeConfigurationSnapshot } from '../src/configuration-branch.mjs';
import { recordApplicabilityDecision } from '../src/evidence/applicability.mjs';
import { generationStartPublicationBinding } from '../src/generation-boundary.mjs';
import { buildRepositoryReadinessPlan, executeRepositoryReadinessPlan } from '../src/initialization/runtime-readiness.mjs';
import { buildGenerationAuthorship, normalizeAuthorshipOptions } from '../src/manual-authorship.mjs';
import { withOperationContext } from '../src/operation-context.mjs';
import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';
import { collectRepositoryReadinessEvidence } from '../src/repository-readiness-evidence.mjs';
import { setAgentSession } from '../src/session.mjs';
import { ANCESTRY_PROOF_V2_READERS_SINCE, SKP_ANCESTRY_LIMITS, captureSkillConfigurationAncestry,
  minimumBuildReadsV2, verifySkillConfigurationAncestry } from '../src/skp-amendment-audit.mjs';
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
  // Not a review test: this fixture's Stories are unreviewed on purpose. Every step's review is walked in
  // review-every-step-cli.test.mjs.
  for (const workType of Object.values(definition.workTypes ?? {})) workType.sourceReview = { mode: 'off' };
  await writeFile(definitionPath, YAML.stringify(definition));
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Application and approved initial policy');
  git(base, 'clone', '-q', '--bare', root, remote); git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', 'origin', `HEAD:refs/heads/${CONFIGURATION_BRANCH}`);
  git(base, 'clone', '-q', '-b', CONFIGURATION_BRANCH, remote, publisher);
  git(publisher, 'config', 'user.name', 'Configuration Publisher');
  git(publisher, 'config', 'user.email', 'configuration.publisher@example.invalid');
  // Hundreds of commits below: no automatic housekeeping in the middle of the fixture.
  git(publisher, 'config', 'gc.auto', '0'); git(publisher, 'config', 'maintenance.auto', 'false');
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

const BASELINE = 'singularity/.product/configuration-baseline.yml';
const after = new Date(Date.parse(ANCESTRY_PROOF_V2_READERS_SINCE) + 86_400_000).toISOString();
const before = new Date(Date.parse(ANCESTRY_PROOF_V2_READERS_SINCE) - 30 * 86_400_000).toISOString();

/** The package baseline an upgrade records: its build is the repository's minimum build (SCF:REQ-016). */
async function recordMinimumBuild(publisher, builtAt) {
  await mkdir(path.join(publisher, 'singularity/.product'), { recursive: true });
  await writeFile(path.join(publisher, BASELINE), YAML.stringify({ format: 'singularity-flow-configuration-baseline/v2',
    build: { commit: 'c'.repeat(40), builtAt }, workflow: {}, assets: {} }));
  git(publisher, 'add', '-f', BASELINE); git(publisher, 'commit', '-qm', 'Record the build that last upgraded this repository');
}

/** `count` approvals on sflow/config, as a long-lived Story sees them go by. */
function approvals(publisher, count) {
  for (let index = 1; index <= count; index += 1) {
    git(publisher, 'commit', '-q', '--allow-empty', '-m', `[configuration] activate approval ${index}`);
  }
}

const addReviewer = (next) => { next.approvalAuthorities['engineering-reviewers'].members = [{ name: reviewer.name, email: reviewer.email, githubLogin: null }]; };

test('an approver refresh after more than 128 sflow/config commits adopts the new reviewer, with a v2 proof', async (t) => {
  const value = await fixture(t);
  await value.reload(); await value.publish(); await value.reload(); await value.submit(); await value.reload();
  approvals(value.publisher, 131);
  await value.configure(addReviewer);
  await recordMinimumBuild(value.publisher, after);
  git(value.publisher, 'push', '-q', 'origin', CONFIGURATION_BRANCH);
  setActor(value.root, reviewer);
  // The preview proves the same ancestry the apply records: it said ready, then the apply failed at depth 128.
  const preview = await refresh(value, { reason });
  assert.equal(preview.status, 'ready', JSON.stringify(preview));
  const recorded = await refresh(value, { reason, confirm: preview.planSha256 });
  assert.equal(recorded.applied, true);
  await value.reload();
  const decision = JSON.parse(await readFile(path.join(value.root,
    value.workflow.approverRefreshes.at(-1).decisionPath), 'utf8'));
  assert.equal(decision.configurationAncestry.schemaVersion, 2, 'a chain beyond 128 commits is a v2 proof');
  assert.ok(decision.configurationAncestry.commits.length > SKP_ANCESTRY_LIMITS.commits);
  assert.equal((await verifyWorkflowSnapshot(value.root, value.config, value.workflow, { requireAccepted: true })).revision, 2);
  await value.approve();
  await value.reload();
  assert.equal(value.workflow.phases.implementation.status, 'approved');
});

test('a chain beyond 128 commits waits for the team\'s minimum build to read v2, with the route', async (t) => {
  const value = await fixture(t);
  await value.reload();
  approvals(value.publisher, 131);
  await value.configure(addReviewer);
  await recordMinimumBuild(value.publisher, before);
  git(value.publisher, 'push', '-q', 'origin', CONFIGURATION_BRANCH);
  setActor(value.root, reviewer);
  const preview = await refresh(value, { reason });
  assert.equal(preview.status, 'blocked', 'never ready when the apply would refuse');
  assert.equal(preview.ancestry.code, 'SKP_AMENDMENT_ANCESTRY_UPGRADE_REQUIRED');
  assert.equal(preview.legalActions[0].command, 'singularity-flow workspace refresh-configuration');
  let refusal;
  await assert.rejects(refresh(value, { reason, confirm: preview.planSha256 }), (error) => {
    refusal = error; return error.code === 'SKP_AMENDMENT_ANCESTRY_UPGRADE_REQUIRED';
  });
  assert.match(refusal.message, /minimum build is from/u);
  const plan = refusalRemediationPlan(refusal, ['story', 'approvers', 'refresh', ID]);
  assert.equal(plan.steps[0].command, 'singularity-flow workspace refresh-configuration');
  await value.reload();
  assert.equal(value.workflow.workflowSnapshot.revision, 1, 'nothing was recorded');
});

test('sflow/config rewritten outside SFlow: the refusal names the cause, and an approver adopts it without ancestry', async (t) => {
  const value = await fixture(t);
  await value.reload(); await value.publish(); await value.reload(); await value.submit(); await value.reload();
  // A force-push on the Git host replaces sflow/config's history.
  git(value.publisher, 'checkout', '-q', '--orphan', 'rewritten');
  const file = path.join(value.publisher, 'singularity/workflow.yml');
  const next = YAML.parse(await readFile(file, 'utf8')); addReviewer(next);
  await writeFile(file, YAML.stringify(next));
  git(value.publisher, 'add', '-A'); git(value.publisher, 'commit', '-qm', 'Configuration rewritten on the Git host');
  await recordMinimumBuild(value.publisher, after);
  git(value.publisher, 'push', '-q', '--force', 'origin', `HEAD:${CONFIGURATION_BRANCH}`);
  setActor(value.root, reviewer);

  const preview = await refresh(value, { reason });
  assert.equal(preview.status, 'needs-adoption', JSON.stringify(preview));
  assert.equal(preview.ancestry.code, 'SKP_AMENDMENT_ANCESTRY_REWRITTEN');
  assert.match(preview.ancestry.message, /sflow\/config was rewritten outside SFlow/u);
  const adopt = preview.legalActions[0];
  assert.equal(adopt.id, 'adopt-without-ancestry');
  assert.match(adopt.command, / --adopt-without-ancestry --confirm sha256:[a-f0-9]{64}$/u);

  // Confirming the plan without the adoption refuses, naming the cause and the adoption route.
  let refusal;
  await assert.rejects(refresh(value, { reason, confirm: preview.planSha256 }), (error) => {
    refusal = error; return error.code === 'SKP_AMENDMENT_ANCESTRY_REWRITTEN';
  });
  assert.match(refusal.message, /rewritten outside SFlow/u);
  assert.match(refusal.details.nextAction.command, /--adopt-without-ancestry$/u);
  const plan = refusalRemediationPlan(refusal, ['story', 'approvers', 'refresh', ID]);
  assert.match(plan.steps[0].command ?? '', /story approvers refresh APPROVERS-1 .*--adopt-without-ancestry/u);
  // The adoption digest belongs to the adoption: it is not the plain refresh's.
  const confirm = adopt.command.match(/--confirm (sha256:[a-f0-9]{64})$/u)[1];
  assert.notEqual(confirm, preview.planSha256);
  await assert.rejects(refresh(value, { reason, confirm }), { code: 'APR_CONFIRMATION_REQUIRED' });

  const recorded = await refresh(value, { reason, 'adopt-without-ancestry': true, confirm });
  assert.equal(recorded.applied, true);
  assert.deepEqual(recorded.adoptedWithoutAncestry, { cause: 'sflow-config-rewritten', confirmedBy: reviewer.email });
  await value.reload();
  const summary = value.workflow.approverRefreshes.at(-1);
  const decision = JSON.parse(await readFile(path.join(value.root, summary.decisionPath), 'utf8'));
  assert.equal(decision.configurationAncestry.schemaVersion, 2);
  assert.deepEqual(decision.configurationAncestry.commits, []);
  assert.match(value.workflow.history.at(-1).detail, /Adopted without ancestry/u);
  assert.equal((await verifyWorkflowSnapshot(value.root, value.config, value.workflow, { requireAccepted: true })).revision, 2);
  await value.approve();
  await value.reload();
  assert.equal(value.workflow.phases.implementation.status, 'approved');
});

test('a rewrite on a repository whose minimum build cannot read the adoption record says so, and records nothing', async (t) => {
  const value = await fixture(t);
  await value.reload();
  git(value.publisher, 'checkout', '-q', '--orphan', 'rewritten');
  const file = path.join(value.publisher, 'singularity/workflow.yml');
  const next = YAML.parse(await readFile(file, 'utf8')); addReviewer(next);
  await writeFile(file, YAML.stringify(next));
  git(value.publisher, 'add', '-A'); git(value.publisher, 'commit', '-qm', 'Configuration rewritten on the Git host');
  git(value.publisher, 'push', '-q', '--force', 'origin', `HEAD:${CONFIGURATION_BRANCH}`);
  setActor(value.root, reviewer);
  const preview = await refresh(value, { reason });
  assert.equal(preview.status, 'blocked');
  assert.equal(preview.ancestry.code, 'SKP_AMENDMENT_ANCESTRY_REWRITTEN');
  assert.equal(preview.legalActions[0].command, 'singularity-flow workspace refresh-configuration');
  await assert.rejects(refresh(value, { reason, 'adopt-without-ancestry': true, confirm: preview.planSha256 }),
    { code: 'APR_CONFIRMATION_REQUIRED' });
  const adoption = await refresh(value, { reason, 'adopt-without-ancestry': true });
  await assert.rejects(refresh(value, { reason, 'adopt-without-ancestry': true, confirm: adoption.planSha256 }),
    { code: 'SKP_AMENDMENT_ANCESTRY_UPGRADE_REQUIRED' });
  await value.reload();
  assert.equal(value.workflow.workflowSnapshot.revision, 1);
});

// Proof shapes, offline: what each version may hold.
function commit(format, parents, message = 'configuration change') {
  const width = format === 'sha1' ? 40 : 64;
  const bytes = Buffer.from(`tree ${'a'.repeat(width)}\n` + parents.map((parent) => `parent ${parent}\n`).join('')
    + 'author Approved Publisher <publisher@example.invalid> 1 +0000\n'
    + 'committer Approved Publisher <publisher@example.invalid> 1 +0000\n\n' + `${message}\n`);
  return { oid: createHash(format).update(`commit ${bytes.length}\0`).update(bytes).digest('hex'), bytesBase64: bytes.toString('base64') };
}
function chain(length, { padding = '' } = {}) {
  const ancestorCommit = '1'.repeat(40);
  const commits = [];
  let parent = ancestorCommit;
  for (let index = 0; index < length; index += 1) {
    const next = commit('sha1', [parent], `approval ${index}${padding}`);
    commits.unshift(next); parent = next.oid;
  }
  const repository = '/approved/configuration.git';
  return { proof: { kind: 'skill-configuration-ancestry', repository, ancestorCommit, descendantCommit: parent,
    objectFormat: 'sha1', commits }, subject: { repository, ancestorCommit, descendantCommit: parent } };
}

test('the 128-commit reader limit holds for v1 and is lifted only for v2, which is bounded by size instead', () => {
  const { proof, subject } = chain(200);
  assert.throws(() => verifySkillConfigurationAncestry({ schemaVersion: 1, ...proof }, subject), { code: 'SKP_AMENDMENT_ANCESTRY_INVALID' });
  assert.equal(verifySkillConfigurationAncestry({ schemaVersion: 2, ...proof }, subject), true);
  const short = chain(3);
  assert.equal(verifySkillConfigurationAncestry({ schemaVersion: 1, ...short.proof }, short.subject), true, 'v1 stays valid');
  // About 2,000 ordinary commits fit 1 MiB; a proof beyond it is refused.
  const huge = chain(1200, { padding: ' '.repeat(600) });
  assert.ok(Buffer.byteLength(JSON.stringify(huge.proof)) > SKP_ANCESTRY_LIMITS.v2ProofBytes);
  assert.throws(() => verifySkillConfigurationAncestry({ schemaVersion: 2, ...huge.proof }, huge.subject), { code: 'SKP_AMENDMENT_ANCESTRY_INVALID' });
  // A future dialect is still refused.
  assert.throws(() => verifySkillConfigurationAncestry({ schemaVersion: 3, ...short.proof }, short.subject), { code: 'SKP_AMENDMENT_ANCESTRY_INVALID' });
});

test('an adoption without ancestry is a v2 record only an approver refresh accepts, naming its cause and approver', () => {
  const { subject } = chain(1);
  const adopted = { schemaVersion: 2, kind: 'skill-configuration-ancestry', ...subject, objectFormat: 'sha1', commits: [],
    adoptedWithoutAncestry: { cause: 'sflow-config-rewritten', confirmedBy: 'reviewer@example.invalid' } };
  assert.throws(() => verifySkillConfigurationAncestry(adopted, subject), { code: 'SKP_AMENDMENT_ANCESTRY_INVALID' },
    'a skill-version or test-command decision never records an adoption');
  assert.equal(verifySkillConfigurationAncestry(adopted, subject, { allowAdoption: true }), true);
  for (const change of [(copy) => { copy.schemaVersion = 1; }, (copy) => { copy.adoptedWithoutAncestry.cause = 'because'; },
    (copy) => { copy.adoptedWithoutAncestry.confirmedBy = ''; }, (copy) => { copy.commits = chain(1).proof.commits; }]) {
    const corrupt = structuredClone(adopted); change(corrupt);
    assert.throws(() => verifySkillConfigurationAncestry(corrupt, subject, { allowAdoption: true }), { code: 'SKP_AMENDMENT_ANCESTRY_INVALID' });
  }
  assert.equal(minimumBuildReadsV2(null), false);
  assert.equal(minimumBuildReadsV2({ builtAt: before }), false);
  assert.equal(minimumBuildReadsV2({ builtAt: ANCESTRY_PROOF_V2_READERS_SINCE }), true);
});

test('a short chain is still a v1 proof, which every build reads', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-scf-ancestry-short-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  git(base, 'init', '-q', '-b', 'main');
  git(base, 'config', 'user.name', 'Approved Publisher'); git(base, 'config', 'user.email', 'publisher@example.invalid');
  git(base, 'commit', '-q', '--allow-empty', '-m', 'approved configuration one');
  const ancestorCommit = git(base, 'rev-parse', 'HEAD');
  git(base, 'commit', '-q', '--allow-empty', '-m', 'approved configuration two');
  git(base, 'commit', '-q', '--allow-empty', '-m', 'approved configuration three');
  const descendantCommit = git(base, 'rev-parse', 'HEAD');
  const proof = await captureSkillConfigurationAncestry(Object.freeze({ authority: Object.freeze({ remote: base }), sourceCommit: descendantCommit }),
    { repository: base, commit: ancestorCommit });
  assert.equal(proof.schemaVersion, 1);
  assert.equal(proof.commits.length, 2);
  assert.equal(verifySkillConfigurationAncestry(proof, { repository: base, ancestorCommit, descendantCommit }), true);
});
