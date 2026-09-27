import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONFIGURATION_BRANCH, ensureConfigurationBranch, inspectApprovedSkillPackage,
  loadStoryConfigurationSnapshot } from '../src/configuration-branch.mjs';
import { EXACT_STORY_REVISION_LIMITS, withExactLocalStoryRevision } from '../src/git-exact-story-revision.mjs';
import { canonicalJson } from '../src/records.mjs';
import { validateWorkflowAuthorRequest } from '../src/commands/workflow-author.mjs';
import { lookupStorySkillUsage, SKP_STORY_USAGE_LIMITS } from '../src/skp-story-usage.mjs';
import { lookupLocalStorySkillUsageInventory, parseLocalStoryInventorySubjects,
  SKP_STORY_INVENTORY_LIMITS } from '../src/skp-story-usage-inventory.mjs';
import { lookupCrossRepositoryStorySkillUsageInventory,
  parseCrossRepositoryStoryInventorySubjects, captureCrossRepositoryStoryInventoryRequest,
  SKP_CROSS_REPOSITORY_INVENTORY_LIMITS } from '../src/skp-cross-repository-story-inventory.mjs';
import { parseArgs, run } from '../src/util.mjs';
import { withLocalReadDeadline } from '../src/local-read-deadline.mjs';
import { captureWorkflowSnapshot, captureWorkflowSnapshotAmendment, verifyWorkflowSnapshot } from '../src/workflow-snapshots.mjs';

const H = (character) => `sha256:${character.repeat(64)}`;
const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (root, ...args) => run('git', args, { cwd: root }).stdout.trim();
const request = (extra = {}) => ({ workId: 'SKP-1', skillId: 'threat-model', ...extra });
async function fixture(t, { objectFormat = 'sha1' } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-usage-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'story');
  const remote = path.join(base, 'approved.git');
  const publisher = path.join(base, 'publisher');
  await mkdir(root);
  git(root, 'init', '-q', '-b', 'main', `--object-format=${objectFormat}`);
  // This suite hashes the entire private Git tree to prove reads are non-mutating.
  // Keep background Git housekeeping from racing that independent byte comparison.
  git(root, 'config', 'maintenance.auto', 'false');
  git(root, 'config', 'gc.auto', '0');
  git(root, 'config', 'user.name', 'Story Reader Fixture');
  git(root, 'config', 'user.email', 'reader@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# Application baseline\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'baseline');
  git(base, 'clone', '-q', '--bare', root, remote);
  await ensureConfigurationBranch(remote);
  git(base, 'clone', '-q', '-b', CONFIGURATION_BRANCH, remote, publisher);
  git(publisher, 'config', 'user.name', 'Approved Package Fixture');
  git(publisher, 'config', 'user.email', 'publisher@example.invalid');
  const skillDir = path.join(publisher, 'singularity/skills/threat-model/references');
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, '../SKILL.md'), '# Threat model\nRead references/checklist.md before producing the report.\n');
  await writeFile(path.join(skillDir, 'checklist.md'), 'Retained private checklist.\n');
  git(publisher, 'add', '.'); git(publisher, 'commit', '-qm', 'approved package');
  git(publisher, 'push', '-q', 'origin', CONFIGURATION_BRANCH);
  const approved = await loadStoryConfigurationSnapshot({ remote, branch: CONFIGURATION_BRANCH });
  const capture = await inspectApprovedSkillPackage(approved, 'threat-model');
  const agentPath = '.github/agents/reviewer.agent.md';
  const agent = '---\nname: reviewer\ndescription: Produce reviewed findings.\nmetadata:\n  sflow-phases: threat-model,privacy-review\n  sflow-default-for: threat-model,privacy-review\n---\nNever disclose private prompt bytes.\n';
  await mkdir(path.join(root, '.github/agents'), { recursive: true });
  await writeFile(path.join(root, agentPath), agent);
  const config = { workItemRoot: 'singularity/work-items',
    agentCatalog: [{ id: 'reviewer', file: path.join(root, agentPath), source: agentPath,
      scope: 'repository', sha256: hash(agent), dependencies: [] }] };
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity/workflow.yml'), 'version: 3\nworkItemRoot: singularity/work-items\nidPattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"\n');
  const phases = ['threat-model', 'privacy-review'];
  const workflow = { schemaVersion: 9, workItem: { id: 'SKP-1', workType: 'findings',
    createdAt: '2026-09-27T00:00:00.000Z' }, phaseOrder: phases, currentPhase: phases[0],
    phases: Object.fromEntries(phases.map((id) => [id, { id, status: 'not_started', generation: 0 }])),
    resolution: { templates: {}, configurationSource: { repository: remote, commit: approved.sourceCommit,
      filesSha256: null }, approvalAuthorities: { reviewers: { label: 'Reviewers', allowAnyGitIdentity: true, members: [] } },
      phases: phases.map((id, index) => ({ id, kind: 'skill', defaultAgent: 'reviewer',
      approval: { mode: 'required', authorities: ['reviewers'], requiredAuthorities: [], minimum: 1, allowSelfApproval: false },
      skillBinding: { schemaVersion: 1, compiler: 'skp-contract/v1', parserProfile: 'skp-skill-text/v1',
        compilationSha256: H(index ? 'd' : 'c'), bindingRefs: {
          skill: { id: 'threat-model', packageSha256: capture.manifest.packageSha256 },
          contractSha256: H(index ? 'e' : 'b'), inputs: [], outputs: [] } } })) } };
  workflow.workflowSnapshot = await captureWorkflowSnapshot(root, config, workflow,
    { approvedConfigurationSnapshot: approved });
  const workflowPath = path.join(root, 'singularity/work-items/SKP-1/workflow.json');
  await writeFile(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`);
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'accepted retained Story');
  const genesisCommit = git(root, 'rev-parse', 'HEAD');
  git(root, 'branch', 'published-story');
  return { base, root, remote, publisher, config, capture, approved, workflow, workflowPath, genesisCommit };
}
async function acceptAmendment(f) {
  const prior = await verifyWorkflowSnapshot(f.root, f.config, f.workflow, { requireAccepted: true, retainBytes: true });
  await writeFile(path.join(f.publisher, 'singularity/skills/threat-model/SKILL.md'), '# Threat model v2\nRead the amended retained checklist.\n');
  git(f.publisher, 'add', '.'); git(f.publisher, 'commit', '-qm', 'approved package version 2');
  git(f.publisher, 'push', '-q', 'origin', CONFIGURATION_BRANCH);
  const approved = await loadStoryConfigurationSnapshot({ remote: f.remote, branch: CONFIGURATION_BRANCH });
  const capture = await inspectApprovedSkillPackage(approved, 'threat-model');
  const proposed = structuredClone(f.workflow);
  proposed.resolution.configurationSource.commit = approved.sourceCommit;
  for (const phase of proposed.resolution.phases) {
    phase.skillBinding.bindingRefs.skill.packageSha256 = capture.manifest.packageSha256;
    phase.skillBinding.compilationSha256 = H('f');
  }
  const policy = structuredClone(proposed.resolution); delete policy.policySha256;
  const phaseBindings = proposed.resolution.phases.map((phase) => ({ phaseId: phase.id,
    contractSha256: phase.skillBinding.bindingRefs.contractSha256,
    compilationSha256: phase.skillBinding.compilationSha256, parserProfile: phase.skillBinding.parserProfile,
    bindingRefsSha256: `sha256:${hash(Buffer.concat([Buffer.from('skp.binding-refs.v1\0'), Buffer.from(canonicalJson(phase.skillBinding.bindingRefs))]))}` }));
  const from = { revision: 1, snapshotHash: f.workflow.workflowSnapshot.snapshotHash, policySha256: prior.policy.policySha256 };
  const to = { revision: 2, policySha256: `sha256:${hash(Buffer.from(canonicalJson(policy)))}`,
    configurationCommit: approved.sourceCommit, skillId: 'threat-model', packageSha256: capture.manifest.packageSha256, phaseBindings };
  const base = 'singularity/work-items/SKP-1/context/skill-amendments/SAM-001';
  const impact = { schemaVersion: 1, kind: 'skill-version-adoption-impact', proposalId: 'SAM-001', workId: 'SKP-1',
    status: 'ready', affectedPhaseIds: f.workflow.phaseOrder, preservedPhaseIds: [] };
  const impactBytes = Buffer.from(canonicalJson(impact)); const impactSha256 = `sha256:${hash(impactBytes)}`;
  const proposedBy = { email: 'proposer@example.invalid' };
  const proposal = { schemaVersion: 1, kind: 'skill-version-adoption-proposal', id: 'SAM-001', workId: 'SKP-1',
    skillId: 'threat-model', proposedBy, reason: 'Review exact package update.', impactSha256, from,
    to: { configurationCommit: to.configurationCommit, packageSha256: to.packageSha256,
      policySha256: to.policySha256, phaseBindings } };
  const proposalBytes = Buffer.from(canonicalJson(proposal)); const proposalSha256 = `sha256:${hash(proposalBytes)}`;
  const summary = { id: 'SAM-001', status: 'proposed', skillId: 'threat-model', proposalPath: `${base}-proposal.json`,
    proposalSha256, impactPath: `${base}-impact.json`, impactSha256, from,
    to: { configurationCommit: to.configurationCommit, packageSha256: to.packageSha256 },
    proposedBy, proposedAt: '2026-09-27T00:30:00.000Z', approvals: [], affectedPhaseIds: f.workflow.phaseOrder, preservedPhaseIds: [] };
  f.workflow.skillVersionAmendments = [structuredClone(summary)];
  proposed.skillVersionAmendments = [structuredClone(summary)];
  await mkdir(path.dirname(path.join(f.root, base)), { recursive: true });
  await writeFile(path.join(f.root, `${base}-proposal.json`), proposalBytes);
  await writeFile(path.join(f.root, `${base}-impact.json`), impactBytes);
  await writeFile(f.workflowPath, `${JSON.stringify(f.workflow, null, 2)}\n`);
  git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'immutable proposal');
  const approval = { actor: { email: 'reviewer@example.invalid' }, authorityGroup: 'reviewers',
    identityAssurance: 'configured-local', at: '2026-09-27T00:59:00.000Z' };
  // Existing v1 decision records remain exact historical compatibility, not fabricated v2 proof.
  const decision = { schemaVersion: 1, kind: 'skill-version-adoption-decision', id: 'SAM-001', workId: 'SKP-1',
    status: 'approved', proposedBy, proposalSha256, impactSha256, approvedAt: '2026-09-27T01:00:00.000Z',
    approvals: [approval], from, to };
  const decisionBytes = Buffer.from(`${JSON.stringify(decision, null, 2)}\n`);
  const decisionPath = `${base}-decision.json`; const decisionSha256 = `sha256:${hash(decisionBytes)}`;
  await writeFile(path.join(f.root, decisionPath), decisionBytes);
  proposed.workflowSnapshot = await captureWorkflowSnapshotAmendment(f.root, f.config, f.workflow, proposed, {
    approvedConfigurationSnapshot: approved, amendmentDecision: { path: decisionPath, sha256: decisionSha256 }
  });
  const review = { schemaVersion: 1, kind: 'skill-version-adoption-review', id: 'SAM-001', workId: 'SKP-1',
    decision: 'approve', ...approval, reason: null, proposalSha256, impactSha256 };
  const reviewBytes = Buffer.from(canonicalJson(review)); const reviewPath = `${base}-review-001.json`;
  await writeFile(path.join(f.root, reviewPath), reviewBytes);
  Object.assign(proposed.skillVersionAmendments[0], { status: 'approved',
    approvals: [{ ...approval, reviewPath, reviewSha256: `sha256:${hash(reviewBytes)}` }],
    decidedAt: decision.approvedAt, decisionPath, decisionSha256 });
  proposed.schemaVersion = 10;
  await writeFile(f.workflowPath, `${JSON.stringify(proposed, null, 2)}\n`);
  git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'accepted reviewed amendment');
  return { proposed, capture, commit: git(f.root, 'rev-parse', 'HEAD') };
}
async function sourceState(root) {
  const files = new Map();
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.set(path.relative(root, absolute), hash(await readFile(absolute)));
    }
  }
  await visit(root);
  return [...files].sort(([left], [right]) => left.localeCompare(right));
}

test('Story usage verifies retained exact phase bindings offline without exposing package/prompt bytes or mutating dirty checkout', async (t) => {
  const f = await fixture(t);
  await rm(f.remote, { recursive: true, force: true });
  await writeFile(f.workflowPath, '{ invalid live JSON');
  await writeFile(path.join(f.root, 'README.md'), 'Preserve dirty application work.\n');
  const before = await sourceState(f.root);
  const value = await lookupStorySkillUsage(f.root, request());
  assert.deepEqual(value.subject, { workId: 'SKP-1', skillId: 'threat-model', packageSha256: f.capture.manifest.packageSha256 });
  assert.equal(value.source.commit, f.genesisCommit);
  assert.equal(value.source.workflowSha256, `sha256:${hash(Buffer.from(git(f.root, 'show', `${f.genesisCommit}:singularity/work-items/SKP-1/workflow.json`) + '\n'))}`);
  assert.equal(value.source.snapshotRevision, 1);
  assert.equal(value.coverage.acceptedLineage, 'verified-at-selected-commit');
  assert.equal(value.readScope.authenticatedPrincipal, 'not-established');
  assert.equal(value.readScope.network, 'not-contacted');
  assert.equal(value.coverage.executionUsage, 'not-assessed');
  assert.equal(value.permissionEffect, 'none');
  assert.deepEqual(value.references.map((row) => row.phaseId), ['threat-model', 'privacy-review']);
  assert.ok(value.references.every((row) => row.packageBinding === 'exact' && row.agentId === 'reviewer'
    && row.bindingRefsSha256.startsWith('sha256:')));
  for (const text of ['Retained private checklist', 'private prompt bytes', 'SKILL.md', 'reader@example.invalid']) {
    assert.ok(!JSON.stringify(value).includes(text));
  }
  assert.deepEqual(await sourceState(f.root), before);
});

test('exact historical commit is pinned at its own accepted tip and branch movement fences pagination', async (t) => {
  const f = await fixture(t);
  f.workflow.phases['threat-model'].status = 'in_progress';
  f.workflow.phases['threat-model'].generation = 1;
  await writeFile(f.workflowPath, `${JSON.stringify(f.workflow, null, 2)}\n`);
  git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'record later lifecycle state');
  const currentCommit = git(f.root, 'rev-parse', 'HEAD');
  const first = await lookupStorySkillUsage(f.root, request({ ref: 'refs/heads/main', commit: f.genesisCommit,
    snapshotRevision: 1, packageSha256: f.capture.manifest.packageSha256, limit: 1 }));
  assert.equal(first.source.commit, f.genesisCommit); assert.equal(first.source.observedRefCommit, currentCommit);
  assert.equal(first.references[0].recordedPhase.status, 'not_started');
  const second = await lookupStorySkillUsage(f.root, request({ ref: 'refs/heads/main', commit: f.genesisCommit,
    cursor: 1, limit: 1, expectedSource: first.sourceSha256 }));
  assert.equal(second.references[0].phaseId, 'privacy-review');
  assert.equal(second.sourceSha256, first.sourceSha256);
  assert.equal((await lookupStorySkillUsage(f.root, request())).references[0].recordedPhase.status, 'in_progress');
  git(f.root, 'commit', '--allow-empty', '-qm', 'same bytes distinct observed commit');
  const before = await sourceState(f.root);
  await assert.rejects(lookupStorySkillUsage(f.root, request({ ref: 'refs/heads/main', commit: f.genesisCommit,
    cursor: 1, limit: 1, expectedSource: first.sourceSha256 })), { code: 'SKP_STORY_USAGE_SOURCE_CHANGED' });
  await assert.rejects(lookupStorySkillUsage(f.root, request({ snapshotRevision: 2 })), { code: 'SKP_STORY_USAGE_REVISION_MISMATCH' });
  await assert.rejects(lookupStorySkillUsage(f.root, request({ ref: 'refs/heads/published-story', commit: currentCommit })),
    { code: 'SKP_STORY_USAGE_COMMIT_NOT_REACHABLE' });
  assert.deepEqual(await sourceState(f.root), before);
});

test('unknown selected Story/package and unproven legacy closure refuse rather than empty success', async (t) => {
  const f = await fixture(t);
  await assert.rejects(lookupStorySkillUsage(f.root, request({ workId: 'ABSENT-1' })), { code: 'SKP_STORY_USAGE_STORY_UNAVAILABLE' });
  await assert.rejects(lookupStorySkillUsage(f.root, request({ skillId: 'absent-skill' })), { code: 'SKP_STORY_USAGE_SUBJECT_NOT_PINNED' });
  await assert.rejects(lookupStorySkillUsage(f.root, request({ packageSha256: H('a') })), { code: 'SKP_STORY_USAGE_SUBJECT_NOT_PINNED' });
  delete f.workflow.workflowSnapshot;
  await writeFile(f.workflowPath, `${JSON.stringify(f.workflow, null, 2)}\n`);
  git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'legacy record');
  await assert.rejects(lookupStorySkillUsage(f.root, request()), { code: 'SKP_STORY_USAGE_UNAVAILABLE' });
  assert.equal((await lookupStorySkillUsage(f.root, request({ commit: f.genesisCommit }))).references.length, 2);
});

test('changed bindings and unaccepted snapshot revisions cannot be disclosed as retained pins', async (t) => {
  const f = await fixture(t);
  f.workflow.resolution.phases[0].skillBinding.bindingRefs.skill.packageSha256 = H('a');
  await writeFile(f.workflowPath, `${JSON.stringify(f.workflow, null, 2)}\n`);
  git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'forged binding');
  await assert.rejects(lookupStorySkillUsage(f.root, request()), { code: 'WFA_SNAPSHOT_INVALID' });
  f.workflow.workflowSnapshot.revision = 2;
  await writeFile(f.workflowPath, `${JSON.stringify(f.workflow, null, 2)}\n`);
  git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'unaccepted revision');
  await assert.rejects(lookupStorySkillUsage(f.root, request()), { code: 'WFA_AMENDMENT_INVALID' });
  assert.equal((await lookupStorySkillUsage(f.root, request({ commit: f.genesisCommit }))).source.snapshotRevision, 1);
});

test('credential-shaped retained metadata is refused without echoing the secret', async (t) => {
  const f = await fixture(t);
  const token = `ghp_${'X'.repeat(36)}`;
  f.workflow.phases['threat-model'].status = token;
  await writeFile(f.workflowPath, `${JSON.stringify(f.workflow, null, 2)}\n`);
  git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'credential shaped metadata');
  await assert.rejects(lookupStorySkillUsage(f.root, request()), (error) => {
    assert.equal(error.code, 'SKP_STORY_USAGE_DISCLOSURE_BLOCKED');
    assert.ok(!error.message.includes(token)); return true;
  });
});

test('request snapshots refuse extra authorities, unsafe selectors, unbounded pages before opening any repository', async () => {
  for (const change of [{ workId: '../escape' }, { skillId: 'UPPER' }, { remote: 'https://example.test/other' },
    { workId: 'CON' }, { workId: 'SKP-1.' }, { workId: 'SKP..1' }, { workId: 'HEAD' },
    { ref: 'main' }, { ref: 'refs/heads/branch:secret' }, { ref: 'refs/heads/../other' }, { commit: 'HEAD' },
    { cursor: 1 }, { cursor: 513, expectedSource: H('a') }, { limit: 65 }, { snapshotRevision: 65 },
    { snapshotRevision: true }, { packageSha256: 'latest' }, { confirmed: true }]) {
    await assert.rejects(lookupStorySkillUsage('/repository-not-contacted', request(change)), { code: 'SKP_STORY_USAGE_INVALID' });
  }
  await assert.rejects(lookupStorySkillUsage('/repository-not-contacted', request({ skillId: `xoxb-${'a'.repeat(16)}` })),
    { code: 'SKP_STORY_USAGE_DISCLOSURE_BLOCKED' });
  assert.ok(Object.isFrozen(SKP_STORY_USAGE_LIMITS)); assert.ok(Object.isFrozen(EXACT_STORY_REVISION_LIMITS));
});

test('caller mutation during asynchronous capture cannot redirect selected subject/revision', async (t) => {
  const f = await fixture(t);
  const input = request({ ref: 'refs/heads/published-story' });
  const promise = lookupStorySkillUsage(f.root, input);
  input.workId = 'OTHER-1'; input.skillId = 'other-skill'; input.ref = 'refs/heads/absent';
  const value = await promise;
  assert.equal(value.subject.workId, 'SKP-1'); assert.equal(value.subject.skillId, 'threat-model');
  assert.equal(value.source.ref, 'refs/heads/published-story');
});

test('missing local retained blobs/ancestry refuse without lazy fetch and preserve source branch state', async (t) => {
  const f = await fixture(t);
  const manifest = JSON.parse(await readFile(path.join(f.root, f.workflow.workflowSnapshot.manifestPath), 'utf8'));
  const blobPath = manifest.assets.find((entry) => entry.purpose === 'skill-package-file').blob.path;
  const oid = git(f.root, 'rev-parse', `HEAD:${blobPath}`);
  await rm(path.join(f.root, '.git/objects', oid.slice(0, 2), oid.slice(2)));
  const before = await sourceState(f.root);
  await assert.rejects(lookupStorySkillUsage(f.root, request()), { code: 'SKP_STORY_USAGE_UNAVAILABLE' });
  assert.deepEqual(await sourceState(f.root), before);
});

test('bounded full ancestry refuses overflow before creating a temporary projection', async (t) => {
  const f = await fixture(t);
  const tree = git(f.root, 'rev-parse', 'HEAD^{tree}');
  let parent = f.genesisCommit;
  for (let index = 0; index <= EXACT_STORY_REVISION_LIMITS.commits; index += 1) {
    parent = git(f.root, 'commit-tree', tree, '-p', parent, '-m', `bounded ${index}`);
  }
  git(f.root, 'update-ref', 'refs/heads/long-history', parent);
  await assert.rejects(lookupStorySkillUsage(f.root, request({ ref: 'refs/heads/long-history' })), { code: 'SKP_STORY_USAGE_LIMIT' });
  assert.equal((await lookupStorySkillUsage(f.root, request({ ref: 'refs/heads/published-story' }))).source.commit, f.genesisCommit);
});

test('ambient Git repository/command overrides fail closed before retained reader dispatch', async (t) => {
  const f = await fixture(t);
  const tracePath = path.join(f.base, 'must-not-be-written.trace');
  for (const [key, value] of [['GIT_DIR', path.join(f.publisher, '.git')], ['GIT_TRACE', tracePath]]) {
    const original = process.env[key]; process.env[key] = value;
    try { await assert.rejects(lookupStorySkillUsage(f.root, request()), { code: 'SKP_STORY_USAGE_UNAVAILABLE' }); }
    finally { if (original === undefined) delete process.env[key]; else process.env[key] = original; }
  }
  await assert.rejects(readFile(tracePath), { code: 'ENOENT' });
});

test('projection is temporary and callback failure cannot rewrite source refs or leave a normal scratch', async (t) => {
  const f = await fixture(t);
  const before = await sourceState(f.root); let captured;
  await assert.rejects(withExactLocalStoryRevision(f.root, { workId: 'SKP-1', ref: 'HEAD' }, async (projection) => {
    captured = projection; assert.notEqual(projection, f.root);
    assert.equal(git(projection, 'rev-parse', 'HEAD'), f.genesisCommit);
    throw new Error('bounded caller failure');
  }), /bounded caller failure/u);
  await assert.rejects(readFile(path.join(captured, '.git/HEAD')), { code: 'ENOENT' });
  assert.deepEqual(await sourceState(f.root), before);
});

test('historical accepted amendments retain their own verified lineage while a later rollback is refused', async (t) => {
  const f = await fixture(t); const amendment = await acceptAmendment(f);
  const current = await lookupStorySkillUsage(f.root, request({ snapshotRevision: 2 }));
  assert.equal(current.subject.packageSha256, amendment.capture.manifest.packageSha256);
  assert.equal(current.source.snapshotRevision, 2); assert.equal(current.source.commit, amendment.commit);
  const genesis = await lookupStorySkillUsage(f.root, request({ commit: f.genesisCommit, snapshotRevision: 1 }));
  assert.equal(genesis.subject.packageSha256, f.capture.manifest.packageSha256);
  await writeFile(f.workflowPath, `${JSON.stringify(f.workflow, null, 2)}\n`);
  git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'attempt rollback to superseded genesis');
  await assert.rejects(lookupStorySkillUsage(f.root, request()), { code: 'WFA_AMENDMENT_INVALID' });
  const before = await sourceState(f.root);
  const historical = await lookupStorySkillUsage(f.root, request({ commit: amendment.commit, snapshotRevision: 2 }));
  assert.equal(historical.subject.packageSha256, current.subject.packageSha256);
  assert.equal(historical.coverage.acceptedLineage, 'verified-at-selected-commit');
  assert.equal(historical.source.workflowSha256, current.source.workflowSha256);
  assert.deepEqual(await sourceState(f.root), before);
});

test('shallow local history is unavailable rather than silently unshallowing or changing tracking refs', async (t) => {
  const f = await fixture(t); const shallow = path.join(f.base, 'shallow');
  git(f.base, 'clone', '-q', '--depth=1', '--branch=main', pathToFileURL(f.root).href, shallow);
  const before = await sourceState(shallow);
  await assert.rejects(lookupStorySkillUsage(shallow, request()), { code: 'SKP_STORY_USAGE_UNAVAILABLE' });
  assert.deepEqual(await sourceState(shallow), before);
  assert.equal(git(shallow, 'rev-parse', '--is-shallow-repository'), 'true');
});

test('oversized disclosure pages refuse without truncation or silent omission', async (t) => {
  const f = await fixture(t);
  f.workflow.phases['threat-model'].status = 'x'.repeat(SKP_STORY_USAGE_LIMITS.pageBytes);
  await writeFile(f.workflowPath, `${JSON.stringify(f.workflow, null, 2)}\n`);
  git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'bounded excessive metadata');
  const before = await sourceState(f.root);
  await assert.rejects(lookupStorySkillUsage(f.root, request()), { code: 'SKP_STORY_USAGE_LIMIT' });
  assert.deepEqual(await sourceState(f.root), before);
});

test('exact local projection preserves SHA-256 Git object format and literal committed bytes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-usage-sha256-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main', '--object-format=sha256');
  git(root, 'config', 'user.name', 'Object Format Fixture'); git(root, 'config', 'user.email', 'format@example.invalid');
  await mkdir(path.join(root, 'singularity/work-items/SKP-1'), { recursive: true });
  await writeFile(path.join(root, '.gitattributes'), '* -text\n');
  await writeFile(path.join(root, 'singularity/workflow.yml'), 'workItemRoot: singularity/work-items\n');
  const literal = Buffer.from('{"workItem":{"id":"SKP-1"}}\r\n');
  await writeFile(path.join(root, 'singularity/work-items/SKP-1/workflow.json'), literal);
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'literal local metadata');
  const commit = git(root, 'rev-parse', 'HEAD'); const before = await sourceState(root);
  await withExactLocalStoryRevision(root, { ref: 'HEAD', workId: 'SKP-1' }, async (projection, source) => {
    assert.equal(source.commit, commit); assert.equal(commit.length, 64);
    assert.equal(git(projection, 'rev-parse', '--show-object-format'), 'sha256');
    assert.deepEqual(await readFile(path.join(projection, source.workflowPath)), literal);
  });
  assert.deepEqual(await sourceState(root), before);
});

test('installed CLI routes one explicit historical Story lookup without configuration refresh, draft-store contact or persistent effects', async (t) => {
  const f = await fixture(t); await rm(f.remote, { recursive: true, force: true });
  const before = await sourceState(f.root);
  const value = run(process.execPath, [CLI, 'workflow', 'author', 'where-used', 'threat-model',
    '--story', 'SKP-1', '--ref', 'refs/heads/published-story', '--commit', f.genesisCommit,
    '--snapshot-revision', '1', '--limit', '1', '--json'], { cwd: f.root, allowFailure: true,
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_DISABLE_MODELS: '1', SINGULARITY_FLOW_NO_NETWORK: '1',
      // Disable ordinary CLI-local activity/timing sinks to assert the entire private Git tree.
      SINGULARITY_FLOW_LOG_LEVEL: 'off', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1',
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(f.base, 'private-workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(f.base, 'private-active.json'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(f.base, 'private-leads.json') } });
  assert.equal(value.status, 0, value.stderr);
  const result = JSON.parse(value.stdout);
  assert.equal(result.operation.id, 'workflow.author.where-used');
  assert.equal(result.operation.modelPolicy, 'never'); assert.equal(result.operation.classification, 'read');
  assert.deepEqual(result.effects, { stateChanged: false, filesChanged: false, publicationCreated: false, externalSystemsChanged: false });
  assert.equal(result.data.usage.subject.workId, 'SKP-1');
  assert.equal(result.data.usage.source.commit, f.genesisCommit);
  assert.equal(result.data.usage.page.nextCursor, 1); assert.equal(result.capability, undefined);
  assert.deepEqual(await sourceState(f.root), before);
});

const inventory = (subjects, extra = {}) => ({ skillId: 'threat-model', subjects, ...extra });

test('explicit local inventory verifies two selected Stories offline and deduplicates identical states without hiding commit observations', async (t) => {
  const f = await fixture(t);
  const second = structuredClone(f.workflow); second.workItem.id = 'SKP-2'; delete second.workflowSnapshot;
  second.workflowSnapshot = await captureWorkflowSnapshot(f.root, f.config, second,
    { approvedConfigurationSnapshot: f.approved });
  const secondPath = path.join(f.root, 'singularity/work-items/SKP-2/workflow.json');
  await writeFile(secondPath, `${JSON.stringify(second, null, 2)}\n`);
  git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'second accepted Story');
  git(f.root, 'branch', 'second-story'); git(f.root, 'commit', '--allow-empty', '-qm', 'same retained state later tip');
  await rm(f.remote, { recursive: true, force: true });
  await writeFile(f.workflowPath, '{ invalid live Story JSON');
  await writeFile(path.join(f.root, 'README.md'), 'Dirty application work remains local.\n');
  const before = await sourceState(f.root);
  const result = await lookupLocalStorySkillUsageInventory(f.root, inventory([
    { workId: 'SKP-1', ref: 'refs/heads/main', historyDepth: 2 },
    { workId: 'SKP-1', ref: 'refs/heads/published-story' },
    { workId: 'SKP-2', ref: 'refs/heads/second-story' }
  ]));
  assert.equal(result.format, 'sflow-local-story-skill-inventory/v1');
  assert.equal(result.observations.length, 4); assert.equal(result.references.length, 4);
  assert.equal(result.observations.filter((row) => row.duplicateOf).length, 2);
  assert.deepEqual([...new Set(result.references.map((row) => row.workId))], ['SKP-1', 'SKP-2']);
  assert.ok(result.observations.every((row) => row.status === 'verified-matching-pin'));
  assert.equal(result.coverage.retainedClosures, 'verified');
  assert.equal(result.coverage.otherStories, 'not-searched');
  assert.equal(result.coverage.mergeSideParentInventory, 'not-searched');
  assert.equal(result.readScope.authenticatedPrincipal, 'not-established');
  assert.equal(result.readScope.network, 'not-contacted');
  for (const text of ['Retained private checklist', 'private prompt bytes', 'SKILL.md', 'reader@example.invalid']) {
    assert.ok(!JSON.stringify(result).includes(text));
  }
  assert.deepEqual(await sourceState(f.root), before);
});

test('inventory retains distinct historical amended packages and distinguishes verified nonmatching filters', async (t) => {
  const f = await fixture(t); const amendment = await acceptAmendment(f);
  await rm(f.remote, { recursive: true, force: true });
  const subjects = [{ workId: 'SKP-1', ref: 'refs/heads/main', historyDepth: 2 },
    { workId: 'SKP-1', ref: 'refs/heads/published-story' }];
  const before = await sourceState(f.root);
  const all = await lookupLocalStorySkillUsageInventory(f.root, inventory(subjects));
  assert.equal(all.observations.length, 3);
  assert.deepEqual(new Set(all.references.map((row) => row.packageSha256)),
    new Set([f.capture.manifest.packageSha256, amendment.capture.manifest.packageSha256]));
  assert.equal(all.references[0].snapshotRevision, 2);
  assert.equal(all.references[0].commit, amendment.commit);
  const original = await lookupLocalStorySkillUsageInventory(f.root, inventory(subjects,
    { packageSha256: f.capture.manifest.packageSha256 }));
  assert.equal(original.observations[0].status, 'verified-other-package');
  assert.ok(original.references.every((row) => row.packageSha256 === f.capture.manifest.packageSha256));
  const absent = await lookupLocalStorySkillUsageInventory(f.root, inventory(subjects, { skillId: 'absent-skill' }));
  assert.equal(absent.references.length, 0); assert.equal(absent.page.complete, true);
  assert.ok(absent.observations.every((row) => row.status === 'verified-no-selected-pin'));
  assert.equal(absent.coverage.retainedClosures, 'verified', 'zero matches is supported only after exact accepted closure verification');
  assert.deepEqual(await sourceState(f.root), before);
});

test('inventory pagination binds all explicit selectors and exact ref commits, including byte-identical movement', async (t) => {
  const f = await fixture(t);
  const subjects = [{ workId: 'SKP-1', ref: 'refs/heads/main' }, { workId: 'SKP-1', ref: 'refs/heads/published-story' }];
  const first = await lookupLocalStorySkillUsageInventory(f.root, inventory(subjects, { limit: 1 }));
  assert.equal(first.page.nextCursor, 1); assert.equal(first.references[0].phaseId, 'threat-model');
  const next = await lookupLocalStorySkillUsageInventory(f.root, inventory(subjects,
    { cursor: 1, limit: 1, expectedSource: first.sourceSha256 }));
  assert.equal(next.sourceSha256, first.sourceSha256); assert.equal(next.references[0].phaseId, 'privacy-review');
  await assert.rejects(lookupLocalStorySkillUsageInventory(f.root, inventory([...subjects].reverse(),
    { cursor: 1, expectedSource: first.sourceSha256 })), { code: 'SKP_STORY_INVENTORY_SOURCE_CHANGED' });
  git(f.root, 'commit', '--allow-empty', '-qm', 'same bytes moved selected ref');
  const before = await sourceState(f.root);
  await assert.rejects(lookupLocalStorySkillUsageInventory(f.root, inventory(subjects,
    { cursor: 1, expectedSource: first.sourceSha256 })), { code: 'SKP_STORY_INVENTORY_SOURCE_CHANGED' });
  assert.deepEqual(await sourceState(f.root), before);
});

test('inventory snapshots closed subject arrays and selectors before asynchronous local reads', async (t) => {
  const f = await fixture(t);
  const input = inventory([{ workId: 'SKP-1', ref: 'refs/heads/published-story', historyDepth: 1 }]);
  const promise = lookupLocalStorySkillUsageInventory(f.root, input);
  input.skillId = 'other-skill'; input.subjects[0].workId = 'OTHER-1';
  input.subjects[0].ref = 'refs/heads/absent'; input.subjects.push({ workId: 'FOREIGN-1', ref: 'HEAD' });
  const result = await promise;
  assert.equal(result.subject.skillId, 'threat-model');
  assert.equal(result.source.selections.length, 1);
  assert.equal(result.source.selections[0].workId, 'SKP-1');
  assert.equal(result.source.selections[0].ref, 'refs/heads/published-story');
});

test('inventory refuses malformed, privileged or over-budget selectors before repository contact', async () => {
  const subjects = [{ workId: 'SKP-1', ref: 'HEAD' }];
  for (const extra of [{ subjects: [] }, { subjects: [{ workId: '../other', ref: 'HEAD' }] },
    { subjects: [{ workId: 'FOREIGN-1', ref: 'refs/heads/*' }] },
    { subjects: [{ workId: 'SKP-1', remote: '/unknown', ref: 'HEAD' }] },
    { subjects: [{ workId: 'SKP-1', ref: 'refs/heads/../other' }] },
    { subjects: [...subjects, ...subjects] }, { subjects: new Array(1) },
    { subjects: [{ workId: 'SKP-1', ref: 'HEAD', historyDepth: 17 }] },
    { subjects: [{ workId: 'CON', ref: 'HEAD' }] }, { limit: 65 }, { cursor: 1 },
    { cursor: 2049, expectedSource: H('a') }, { confirmed: true }, { packageSha256: 'latest' }]) {
    await assert.rejects(lookupLocalStorySkillUsageInventory('/not-contacted', inventory(subjects, extra)),
      { code: 'SKP_STORY_INVENTORY_INVALID' });
  }
  const accessor = inventory(subjects); let read = false;
  Object.defineProperty(accessor, 'skillId', { enumerable: true, get: () => { read = true; return 'threat-model'; } });
  await assert.rejects(lookupLocalStorySkillUsageInventory('/not-contacted', accessor), { code: 'SKP_STORY_INVENTORY_INVALID' });
  assert.equal(read, false);
  await assert.rejects(lookupLocalStorySkillUsageInventory('/not-contacted', inventory(
    Array.from({ length: 8 }, (_, index) => ({ workId: `SKP-${index}`, ref: 'HEAD', historyDepth: 5 })))),
  { code: 'SKP_STORY_INVENTORY_LIMIT' });
  assert.deepEqual(parseLocalStoryInventorySubjects('SKP-1=refs/heads/main,SKP-2=HEAD', 2),
    [{ workId: 'SKP-1', ref: 'refs/heads/main', historyDepth: 2 }, { workId: 'SKP-2', ref: 'HEAD', historyDepth: 2 }]);
  for (const text of ['SKP-1', 'SKP-1=HEAD=extra', 'SKP-1=refs/heads/*', 'SKP-1=HEAD,SKP-1=HEAD']) {
    assert.throws(() => parseLocalStoryInventorySubjects(text), { code: 'SKP_STORY_INVENTORY_INVALID' });
  }
  assert.ok(Object.isFrozen(SKP_STORY_INVENTORY_LIMITS));
});

test('a missing selected Story/ref or unavailable older state refuses the whole inventory, not partial matches', async (t) => {
  const f = await fixture(t); const before = await sourceState(f.root);
  for (const second of [{ workId: 'ABSENT-1', ref: 'refs/heads/main' },
    { workId: 'SKP-1', ref: 'refs/heads/foreign-unavailable' }]) {
    await assert.rejects(lookupLocalStorySkillUsageInventory(f.root, inventory([
      { workId: 'SKP-1', ref: 'refs/heads/published-story' }, second
    ])), (error) => ['SKP_STORY_USAGE_STORY_UNAVAILABLE', 'SKP_STORY_INVENTORY_UNAVAILABLE'].includes(error.code));
  }
  await assert.rejects(lookupLocalStorySkillUsageInventory(f.root, inventory([
    { workId: 'SKP-1', ref: 'refs/heads/main', historyDepth: 2 }
  ])), { code: 'SKP_STORY_USAGE_UNAVAILABLE' });
  assert.deepEqual(await sourceState(f.root), before);
});

test('inventory never substitutes a verified older pin for a corrupted selected tip', async (t) => {
  const f = await fixture(t); f.workflow.workflowSnapshot.snapshotHash = H('a');
  await writeFile(f.workflowPath, `${JSON.stringify(f.workflow, null, 2)}\n`);
  git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'corrupted later closure');
  const before = await sourceState(f.root);
  await assert.rejects(lookupLocalStorySkillUsageInventory(f.root, inventory([
    { workId: 'SKP-1', ref: 'refs/heads/published-story' }, { workId: 'SKP-1', ref: 'refs/heads/main' }
  ])), { code: 'WFA_SNAPSHOT_INVALID' });
  assert.deepEqual(await sourceState(f.root), before);
});

test('inventory credentials, shallow history and oversized disclosure fail visibly without fetch or silent truncation', async (t) => {
  const f = await fixture(t); const token = `xoxb-${'a'.repeat(16)}`;
  await assert.rejects(lookupLocalStorySkillUsageInventory('/not-contacted', inventory([
    { workId: 'SKP-1', ref: 'HEAD' }], { skillId: token })), { code: 'SKP_STORY_INVENTORY_DISCLOSURE_BLOCKED' });
  const shallow = path.join(f.base, 'inventory-shallow');
  git(f.base, 'clone', '-q', '--depth=1', '--branch=main', pathToFileURL(f.root).href, shallow);
  const shallowBefore = await sourceState(shallow);
  await assert.rejects(lookupLocalStorySkillUsageInventory(shallow, inventory([
    { workId: 'SKP-1', ref: 'HEAD' }
  ])), { code: 'SKP_STORY_USAGE_UNAVAILABLE' });
  assert.deepEqual(await sourceState(shallow), shallowBefore);
  f.workflow.phases['threat-model'].status = 'x'.repeat(SKP_STORY_INVENTORY_LIMITS.pageBytes);
  await writeFile(f.workflowPath, `${JSON.stringify(f.workflow, null, 2)}\n`);
  git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'excessive disclosure metadata');
  const before = await sourceState(f.root);
  await assert.rejects(lookupLocalStorySkillUsageInventory(f.root, inventory([
    { workId: 'SKP-1', ref: 'HEAD' }
  ])), { code: 'SKP_STORY_INVENTORY_LIMIT' });
  assert.deepEqual(await sourceState(f.root), before);
});

test('actual local ref movement after first observation refuses inventory rather than mixing source snapshots', async (t) => {
  const f = await fixture(t);
  const tree = git(f.root, 'rev-parse', 'HEAD^{tree}');
  const moved = git(f.root, 'commit-tree', tree, '-p', f.genesisCommit, '-m', 'concurrent same-byte publication');
  const realGit = run('which', ['git']).stdout.trim();
  const bin = path.join(f.base, 'moving-ref-fixture'); await mkdir(bin);
  const marker = path.join(f.base, 'ref-moved'); const wrapper = path.join(bin, 'git');
  await writeFile(wrapper, `#!${process.execPath}\nconst {spawn,spawnSync}=require('node:child_process');\nconst {existsSync,writeFileSync}=require('node:fs');\nconst a=process.argv.slice(2);\nif(a.includes('cat-file')){const c=spawn(${JSON.stringify(realGit)},a,{stdio:'inherit',env:process.env});c.on('exit',(status)=>{process.exitCode=status??1;});}else{\nconst r=spawnSync(${JSON.stringify(realGit)},a,{encoding:null,env:process.env});\nif(r.stdout)process.stdout.write(r.stdout);if(r.stderr)process.stderr.write(r.stderr);\nif(a.includes('show-ref')&&a.includes('--hash')&&a.includes('refs/heads/main')&&!existsSync(${JSON.stringify(marker)})){writeFileSync(${JSON.stringify(marker)},'fixture');const m=spawnSync(${JSON.stringify(realGit)},['-C',${JSON.stringify(f.root)},'update-ref','refs/heads/main',${JSON.stringify(moved)}],{env:process.env});if(m.status!==0)process.exit(1);}\nprocess.exitCode=r.status??1;}\n`);
  await chmod(wrapper, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  try {
    await assert.rejects(lookupLocalStorySkillUsageInventory(f.root, inventory([
      { workId: 'SKP-1', ref: 'refs/heads/main' }
    ])), { code: 'SKP_STORY_INVENTORY_SOURCE_CHANGED' });
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
  }
  assert.equal(git(f.root, 'rev-parse', 'refs/heads/main'), moved);
  assert.equal(await readFile(marker, 'utf8'), 'fixture');
});

test('shared inventory deadline reaches a delayed synchronous retained read without restarting its budget or changing source', async (t) => {
  const f = await fixture(t); const before = await sourceState(f.root);
  const realGit = run('which', ['git']).stdout.trim();
  const bin = path.join(f.base, 'deadline-git-fixture'); await mkdir(bin);
  const marker = path.join(f.base, 'delayed-retained-read.json'); const wrapper = path.join(bin, 'git');
  await writeFile(wrapper, `#!${process.execPath}\nconst {spawn,spawnSync}=require('node:child_process');\nconst {writeFileSync}=require('node:fs');\nconst a=process.argv.slice(2);\nif(a.includes('log')){writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,cwd:process.cwd()}));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);process.exit(1);}\nif(a.includes('cat-file')){const c=spawn(${JSON.stringify(realGit)},a,{stdio:'inherit',env:process.env});c.on('exit',status=>{process.exitCode=status??1;});}else{const r=spawnSync(${JSON.stringify(realGit)},a,{encoding:null,env:process.env});if(r.stdout)process.stdout.write(r.stdout);if(r.stderr)process.stderr.write(r.stderr);process.exitCode=r.status??1;}\n`);
  await chmod(wrapper, 0o755);
  const originalPath = process.env.PATH; process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  const began = performance.now();
  try {
    await assert.rejects(withLocalReadDeadline(5_000, () => lookupLocalStorySkillUsageInventory(f.root, inventory([
      { workId: 'SKP-1', ref: 'HEAD' }
    ]))), (error) => error.code === 'SKP_STORY_INVENTORY_LIMIT'
      && error.details?.cleanupUnproven === true && error.details?.temporaryProjectionRetained === true
      && /private temporary projection was retained/u.test(error.message)
      && !error.message.includes(f.base));
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
  }
  assert.ok(performance.now() - began < 10_000, 'one shared budget plus awaited bounded cleanup, not another 120-second retained budget');
  const delayed = JSON.parse(await readFile(marker, 'utf8'));
  assert.match(path.basename(delayed.cwd), /^sflow-story-usage-/u);
  assert.throws(() => process.kill(delayed.pid, 0), { code: 'ESRCH' });
  // Production conservatively retains this projection on the unknown sync-child tree outcome.
  // This fixture created no descendants in its delayed branch and proves that child is gone.
  await rm(delayed.cwd, { recursive: true, force: true });
  assert.deepEqual(await sourceState(f.root), before);
  const healthy = await lookupLocalStorySkillUsageInventory(f.root, inventory([{ workId: 'SKP-1', ref: 'HEAD' }]));
  assert.equal(healthy.coverage.retainedClosures, 'verified');
});

test('installed CLI explicit local inventory works offline and preserves branch/index/application state', async (t) => {
  const f = await fixture(t); git(f.root, 'commit', '--allow-empty', '-qm', 'same accepted snapshot at later commit');
  await rm(f.remote, { recursive: true, force: true });
  const before = await sourceState(f.root);
  const result = run(process.execPath, [CLI, 'workflow', 'author', 'where-used', 'threat-model',
    '--story-refs', 'SKP-1=refs/heads/main,SKP-1=refs/heads/published-story', '--history-depth', '2',
    '--limit', '1', '--json'], { cwd: f.root, allowFailure: true,
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_DISABLE_MODELS: '1', SINGULARITY_FLOW_NO_NETWORK: '1',
      SINGULARITY_FLOW_LOG_LEVEL: 'off', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1',
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(f.base, 'private-workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(f.base, 'private-active.json'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(f.base, 'private-leads.json') } });
  // Published genesis has a pre-Story parent, so the exact requested window must refuse rather
  // than claim a partial match. A first-page narrower request succeeds through the same route.
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stderr).error.code, 'SKP_STORY_USAGE_UNAVAILABLE');
  assert.deepEqual(await sourceState(f.root), before);
  const value = run(process.execPath, [CLI, 'workflow', 'author', 'where-used', 'threat-model',
    '--story-refs', 'SKP-1=refs/heads/main', '--history-depth', '2', '--limit', '1', '--json'],
  { cwd: f.root, allowFailure: true, env: { ...process.env, NODE_ENV: 'test',
    SINGULARITY_FLOW_DISABLE_MODELS: '1', SINGULARITY_FLOW_NO_NETWORK: '1',
    SINGULARITY_FLOW_LOG_LEVEL: 'off', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(f.base, 'private-workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(f.base, 'private-active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(f.base, 'private-leads.json') } });
  assert.equal(value.status, 0, value.stderr);
  const report = JSON.parse(value.stdout);
  assert.equal(report.operation.modelPolicy, 'never'); assert.equal(report.operation.classification, 'read');
  assert.equal(report.data.usage.format, 'sflow-local-story-skill-inventory/v1');
  assert.equal(report.data.usage.observations.length, 2); assert.equal(report.data.usage.page.nextCursor, 1);
  assert.equal(report.capability, undefined);
  assert.deepEqual(report.effects, { stateChanged: false, filesChanged: false, publicationCreated: false, externalSystemsChanged: false });
  assert.deepEqual(await sourceState(f.root), before);
});

test('inventory CLI preflight accepts only explicit bounded windows and keeps existing Story selectors separate', () => {
  const parse = (...args) => parseArgs(['workflow', 'author', 'where-used', 'threat-model', ...args]);
  assert.equal(validateWorkflowAuthorRequest(parse('--story-refs', 'SKP-1=refs/heads/main,SKP-2=HEAD',
    '--history-depth', '2', '--limit', '64', '--cursor', '2048', '--expected-source', H('a'), '--json')), 'where-used');
  for (const args of [
    ['--history-depth', '2'], ['--story', 'SKP-1', '--story-refs', 'SKP-1=HEAD'],
    ['--story-refs', 'SKP-1=HEAD', '--ref', 'HEAD'],
    ['--story-refs', 'SKP-1=HEAD', '--commit', 'a'.repeat(40)],
    ['--story-refs', 'SKP-1=HEAD', '--snapshot-revision', '1'],
    ['--story-refs', 'SKP-1=refs/heads/*'], ['--story-refs', 'SKP-1=HEAD,SKP-1=HEAD'],
    ['--story-refs', 'SKP-1=HEAD', '--history-depth', '17'],
    ['--story-refs', 'SKP-1=HEAD', '--history-depth', '0'],
    ['--story-refs', 'SKP-1=HEAD', '--cursor', '1'],
    ['--story-refs', 'SKP-1=HEAD', '--cursor', '2049', '--expected-source', H('a')],
    ['--story-refs', 'SKP-1=HEAD', '--all'],
    ['--story-refs', Array.from({ length: 8 }, (_, index) => `SKP-${index}=HEAD`).join(','), '--history-depth', '5']
  ]) {
    assert.throws(() => validateWorkflowAuthorRequest(parse(...args)),
      (error) => /^(?:WCA_AUTHOR_REQUEST_INVALID|SKP_STORY_INVENTORY_(?:INVALID|LIMIT|DISCLOSURE_BLOCKED))$/u.test(error.code));
  }
});

test('explicit cross-repository inventory verifies each retained Story and binds global pages to both local refs', async (t) => {
  const first = await fixture(t); const second = await fixture(t);
  await rm(first.remote, { recursive: true, force: true });
  await rm(second.remote, { recursive: true, force: true });
  await writeFile(first.workflowPath, '{ uncommitted first Story');
  await writeFile(second.workflowPath, '{ uncommitted second Story');
  const beforeFirst = await sourceState(first.root); const beforeSecond = await sourceState(second.root);
  const repositories = [first, second].map((entry) => ({ root: entry.root,
    subjects: [{ workId: 'SKP-1', ref: 'refs/heads/published-story' }] }));
  const request = { skillId: 'threat-model', repositories, limit: 1 };
  const page = await lookupCrossRepositoryStorySkillUsageInventory(request);
  assert.equal(page.format, 'sflow-cross-repository-story-skill-inventory/v1');
  assert.equal(page.source.repositories.length, 2);
  assert.equal(page.observations.length, 2);
  assert.equal(page.page.total, 4); assert.equal(page.page.nextCursor, 1);
  assert.equal(page.references[0].repositoryIndex, 0);
  assert.equal(page.readScope.network, 'not-contacted');
  assert.equal(page.readScope.authenticatedPrincipal, 'not-established');
  assert.equal(page.coverage.otherRepositories, 'not-searched');
  const next = await lookupCrossRepositoryStorySkillUsageInventory({ ...request,
    cursor: 2, expectedSource: page.sourceSha256 });
  assert.equal(next.sourceSha256, page.sourceSha256);
  assert.equal(next.references[0].repositoryIndex, 1);
  assert.deepEqual(await sourceState(first.root), beforeFirst);
  assert.deepEqual(await sourceState(second.root), beforeSecond);
  await assert.rejects(lookupCrossRepositoryStorySkillUsageInventory({ ...request,
    repositories: [...repositories].reverse(), cursor: 1, expectedSource: page.sourceSha256 }),
  { code: 'SKP_CROSS_STORY_INVENTORY_SOURCE_CHANGED' });
  git(second.root, 'commit', '--allow-empty', '-qm', 'advance selected second ref');
  git(second.root, 'branch', '-f', 'published-story', 'HEAD');
  await assert.rejects(lookupCrossRepositoryStorySkillUsageInventory({ ...request,
    cursor: 1, expectedSource: page.sourceSha256 }),
  { code: 'SKP_CROSS_STORY_INVENTORY_SOURCE_CHANGED' });
});

test('cross-repository CLI reaches only supplied local roots and remains a model-free read', async (t) => {
  const first = await fixture(t); const second = await fixture(t);
  await rm(first.remote, { recursive: true, force: true });
  await rm(second.remote, { recursive: true, force: true });
  const selectors = `${first.root}#SKP-1=refs/heads/published-story,${second.root}#SKP-1=refs/heads/published-story`;
  const beforeFirst = await sourceState(first.root); const beforeSecond = await sourceState(second.root);
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_DISABLE_MODELS: '1', SINGULARITY_FLOW_NO_NETWORK: '1',
    SINGULARITY_FLOW_LOG_LEVEL: 'off', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(first.base, 'private-workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(first.base, 'private-active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(first.base, 'private-leads.json') };
  const result = run(process.execPath, [CLI, 'workflow', 'author', 'where-used', 'threat-model',
    '--repository-story-refs', selectors, '--limit', '1', '--json'], { cwd: first.root, allowFailure: true,
    env });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.operation.id, 'workflow.author.where-used');
  assert.equal(report.operation.classification, 'read');
  assert.equal(report.operation.modelPolicy, 'never');
  assert.equal(report.data.usage.page.total, 4);
  assert.equal(report.scope.selectedRepositoryStoryInventory.repositories.length, 2);
  const next = run(process.execPath, [CLI, 'workflow', 'author', 'where-used', 'threat-model',
    '--repository-story-refs', selectors, '--limit', '1', '--cursor', '2',
    '--expected-source', report.data.usage.sourceSha256, '--json'],
  { cwd: first.root, allowFailure: true, env });
  assert.equal(next.status, 0, next.stderr);
  assert.equal(JSON.parse(next.stdout).data.usage.references[0].repositoryIndex, 1);
  assert.deepEqual(report.effects, { stateChanged: false, filesChanged: false,
    publicationCreated: false, externalSystemsChanged: false });
  assert.deepEqual(await sourceState(first.root), beforeFirst);
  assert.deepEqual(await sourceState(second.root), beforeSecond);
});

test('cross-repository selectors refuse implied discovery, invalid shapes and incomplete repositories', async (t) => {
  const f = await fixture(t);
  const pair = `${f.root}#SKP-1=refs/heads/published-story`;
  assert.equal(SKP_CROSS_REPOSITORY_INVENTORY_LIMITS.repositories, 4);
  assert.deepEqual(parseCrossRepositoryStoryInventorySubjects(pair),
    [{ root: f.root, subjects: [{ workId: 'SKP-1', ref: 'refs/heads/published-story', historyDepth: 1 }] }]);
  for (const request of [
    { skillId: 'threat-model', repositories: [] },
    { skillId: 'threat-model', repositories: [{ root: f.root, subjects: [{ workId: 'SKP-1', ref: 'HEAD' }] }], cursor: 1 },
    { skillId: 'threat-model', repositories: [{ root: f.root, subjects: [{ workId: 'SKP-1', ref: 'HEAD' }] },
      { root: f.root, subjects: [{ workId: 'SKP-1', ref: 'HEAD' }] }] },
    { skillId: 'threat-model', repositories: [{ root: '/not-contacted', subjects: [{ workId: 'SKP-1', ref: 'refs/heads/*' }] }] },
    { skillId: 'threat-model', repositories: [{ root: f.root, subjects: [{ workId: 'SKP-1', ref: 'HEAD' }] }], packageSha256: 'latest' },
    { skillId: 'threat-model', repositories: Array.from({ length: 5 }, (_, index) => ({ root: `/not-contacted-${index}`,
      subjects: [{ workId: 'SKP-1', ref: 'HEAD' }] })) }
  ]) assert.throws(() => captureCrossRepositoryStoryInventoryRequest(request),
    (error) => /^(?:SKP_CROSS_STORY_INVENTORY_(?:INVALID|LIMIT)|SKP_STORY_INVENTORY_(?:INVALID|LIMIT))$/u.test(error.code));
  const accessor = { skillId: 'threat-model' }; let getterRead = false;
  Object.defineProperty(accessor, 'repositories', { enumerable: true,
    get: () => { getterRead = true; return []; } });
  assert.throws(() => captureCrossRepositoryStoryInventoryRequest(accessor),
    { code: 'SKP_CROSS_STORY_INVENTORY_INVALID' });
  assert.equal(getterRead, false);
  for (const text of ['SKP-1=HEAD', `${f.root}#SKP-1=refs/heads/*`, `${f.root}#SKP-1=HEAD,${f.root}#SKP-1=HEAD`]) {
    assert.throws(() => parseCrossRepositoryStoryInventorySubjects(text));
  }
  const parse = (...args) => parseArgs(['workflow', 'author', 'where-used', 'threat-model', ...args]);
  assert.equal(validateWorkflowAuthorRequest(parse('--repository-story-refs', pair, '--json')), 'where-used');
  for (const args of [
    ['--repository-story-refs', pair, '--story', 'SKP-1'],
    ['--repository-story-refs', pair, '--story-refs', 'SKP-1=HEAD'],
    ['--repository-story-refs', pair, '--cursor', '1'],
    ['--repository-story-refs', `${f.root}#SKP-1=refs/heads/*`],
    ['--repository-story-refs', pair, '--history-depth', '17']
  ]) assert.throws(() => validateWorkflowAuthorRequest(parse(...args)));
  await assert.rejects(lookupCrossRepositoryStorySkillUsageInventory({ skillId: 'threat-model', repositories: [
    { root: f.root, subjects: [{ workId: 'SKP-1', ref: 'refs/heads/published-story' }] },
    { root: '/not-contacted', subjects: [{ workId: 'SKP-1', ref: 'HEAD' }] }
  ] }));
});
