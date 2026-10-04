import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { issueActionAuthorization } from '../src/action-authorization.mjs';
import { canonicalJson, recordSha256 } from '../src/records.mjs';
import { readRecord } from '../src/schema-migrations.mjs';
import { validateConfiguredSkillPhase } from '../src/skp-contract.mjs';
import { withConfigurationReadRoot } from '../src/configuration-read-scope.mjs';
import { removeTemporaryTree } from '../src/util.mjs';
import { captureWorkflowCompilerContext, captureWorkflowDraftCompilerSource, compileWorkflowDraftPackage,
  previewWorkflowDraftPackage, workflowDraftPackageProposalFiles, WCA_REQUEST_SCHEMA } from '../src/wca-compiler.mjs';
import { openGitDraftStore } from '../src/wca-git-drafts.mjs';
import { WCA_SKP_LOCAL_PRODUCER_PROFILE, validateWorkflowSkillFinalizationRecord } from '../src/wca-skp-finalization.mjs';

// These fixture workflows exercise configuration authoring, not delivery, and say so for each
// responsibility a Story would otherwise owe; omitting one a route does hold is only a warning.
const OMITS = ['scope', 'plan', 'implement', 'verify', 'review'].map((responsibility) => ({ responsibility, reason: 'A configuration-authoring fixture that exercises no delivery.', authority: 'reviewers' }));
import { createWorkflowDraftReviewProposal, validateWorkflowDraftSkillSubmissionSnapshot,
  validateWorkflowDraftSubmissionSnapshot, workflowDraftSubmissionPlan } from '../src/wca-submission.mjs';

const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const DRAFT_ID = 'WFD-SKPSUBMIT1';
const TERMINAL_UNAVAILABLE = process.platform !== 'darwin' || !existsSync('/usr/bin/expect');
const hash = (value) => `sha256:${recordSha256(value)}`;
const byteHash = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const domainHash = (profile, value) => byteHash(Buffer.from(`${profile}\0${canonicalJson(value)}`));
function changedAgentEvidence(snapshot, { resealAgentIdentity = false } = {}) {
  const changed = structuredClone(snapshot);
  const replace = (file, bytes) => Object.assign(file, { bytes: bytes.length, sha256: byteHash(bytes), contentBase64: bytes.toString('base64') });
  const agent = changed.files.find((file) => file.path.endsWith('team-notes-note-writer.agent.md'));
  assert.ok(agent);
  assert.equal(agent.sha256, snapshot.preview.skillFinalization.subject.phases[0].selectedAgent.textSha256,
    'the valid candidate agent starts as the exact reviewed full document');
  replace(agent, Buffer.concat([Buffer.from(agent.contentBase64, 'base64'), Buffer.from('\nUnreviewed historical agent prompt.\n')]));
  const finalization = changed.preview.skillFinalization;
  const subject = finalization.subject;
  if (resealAgentIdentity) Object.assign(subject.phases[0].selectedAgent,
    { textSha256: agent.sha256, bytes: agent.bytes, bodyBase64: agent.contentBase64 });
  subject.pendingFilesSha256 = hash(changed.files.filter((file) => file.path !== 'singularity/workflow.yml').map(({ mode, ...rest }) => rest));
  const { subjectSha256, ...subjectCore } = subject;
  subject.subjectSha256 = domainHash(subject.profile, subjectCore);
  const review = changed.preConsentPreview.skillFinalization.review;
  review.plan.subject = structuredClone(subject); review.plan.revision = subject.subjectSha256;
  const { planId, planHash, ...planCore } = review.plan;
  review.plan.planHash = recordSha256(planCore); review.plan.planId = `wca-skp-${review.plan.planHash.slice(0, 24)}`;
  review.action.actionId = `workflow-skp-confirm-${review.plan.planHash.slice(0, 24)}`;
  changed.preConsentPreview.skillFinalization.subject = structuredClone(subject);
  const record = finalization.record;
  record.preConsentSubjectSha256 = subject.subjectSha256;
  record.confirmation.actionPlanSha256 = `sha256:${review.plan.planHash}`;
  record.confirmation.questionId = recordSha256({ planId: review.plan.planId, actionId: review.action.actionId, channel: 'terminal' }).slice(0, 24);
  const phases = subject.phases.map((row) => {
    const configured = changed.preview.candidateDefinition.phases[row.phaseId];
    configured.skillBinding.bindingRefs.confirmation.planSha256 = subject.subjectSha256;
    const { kind, skillBinding, ...phasePolicy } = configured;
    skillBinding.compilationSha256 = hash({ compiler: skillBinding.compiler, phaseId: row.phaseId, phasePolicy, bindingRefs: skillBinding.bindingRefs });
    return { phaseId: row.phaseId, configuredPhase: configured, compilationSha256: skillBinding.compilationSha256 };
  }).sort((left, right) => left.phaseId < right.phaseId ? -1 : left.phaseId > right.phaseId ? 1 : 0);
  record.confirmedBindingsSha256 = hash(phases); record.emittedDefinitionSha256 = hash(changed.preview.candidateDefinition);
  replace(changed.files.find((file) => file.path === 'singularity/workflow.yml'), Buffer.from(YAML.stringify(changed.preview.candidateDefinition)));
  record.emittedClosureSha256 = hash(changed.files.map(({ path: relative, mode, bytes, sha256 }) => ({ path: relative, mode, bytes, sha256 })));
  const { finalizationSha256, ...recordCore } = record;
  record.finalizationSha256 = domainHash(record.profile, recordCore);
  changed.preview.candidateDefinitionSha256 = record.emittedDefinitionSha256;
  changed.preview.candidateAssetManifestSha256 = hash(changed.files.map(({ path: relative, bytes, sha256 }) => ({ path: relative, bytes, sha256 })));
  changed.preview.assets = changed.files.map(({ path: relative, bytes, sha256, contentBase64 }) => ({ path: relative, bytes, sha256, content: Buffer.from(contentBase64, 'base64').toString('utf8') }));
  for (const preview of [changed.preview, changed.preConsentPreview]) {
    const { planSha256, ...core } = preview; preview.planSha256 = hash(core);
  }
  changed.confirmation = structuredClone(record.confirmation); changed.finalizationSha256 = record.finalizationSha256;
  changed.snapshotId = changed.finalizationSha256.slice(7); changed.operationRef.subject = changed.snapshotId.slice(0, 24);
  const { snapshotSha256, ...core } = changed; changed.snapshotSha256 = hash(core);
  assert.equal(changed.inputs.request.definitions.agents[0].prompt, snapshot.inputs.request.definitions.agents[0].prompt);
  if (resealAgentIdentity) assert.equal(agent.sha256, subject.phases[0].selectedAgent.textSha256);
  else {
    assert.equal(subject.phases[0].selectedAgent.textSha256, snapshot.preview.skillFinalization.subject.phases[0].selectedAgent.textSha256);
    assert.notEqual(agent.sha256, subject.phases[0].selectedAgent.textSha256, 'every outer hash was resealed but exact selected agent was not reviewed');
  }
  return changed;
}
function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
function environment(root) {
  return { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'SKP Submission Fixture',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.test-workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.test-active-workspace.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(root, '.test-leads.json'),
    SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(path.dirname(root), 'transport-outbox'),
    SINGULARITY_FLOW_DISABLE_MODELS: '1' };
}
function heads(f) { return git(f.base, '--git-dir', f.remote, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/'); }
function proposals(f) { return heads(f).split('\n').filter((line) => line.startsWith('refs/heads/sflow/config-change/')); }
async function observation(root) {
  return { head: git(root, 'rev-parse', 'HEAD'), branch: git(root, 'branch', '--show-current'),
    refs: git(root, 'show-ref'), status: git(root, 'status', '--porcelain=v1'),
    index: await readFile(path.join(root, '.git/index')),
    workflow: await readFile(path.join(root, 'singularity/workflow.yml')),
    contributor: await readFile(path.join(root, 'contributor-note.txt')) };
}
async function fixture(t, { classified = true } = {}) {
  const previous = { NODE_ENV: process.env.NODE_ENV, SINGULARITY_FLOW_TEST_IDENTITY: process.env.SINGULARITY_FLOW_TEST_IDENTITY };
  process.env.NODE_ENV = 'test'; process.env.SINGULARITY_FLOW_TEST_IDENTITY = 'SKP Submission Fixture';
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-wca-skp-submission-'));
  t.after(() => removeTemporaryTree(base));
  const first = path.join(base, 'first'); const second = path.join(base, 'second'); const remote = path.join(base, 'authority.git');
  await mkdir(first); git(base, 'init', '--bare', '-q', '-b', 'main', remote); git(first, 'init', '-q', '-b', 'main');
  git(first, 'config', 'user.name', 'SKP First'); git(first, 'config', 'user.email', 'skp.first@example.test');
  git(first, 'config', 'core.autocrlf', 'false');
  const ordinary = (id) => ({ label: id, artifact: { path: `artifacts/${id}/${id}.md`, ...({ intake: { kind: 'intake' }, conformance: { kind: 'conformance-report' } }[id] ?? {}), minimumBytes: 20, maximumBytes: 16_384 },
    defaultTemplate: 'common/empty.md', inputs: [], approval: { mode: 'none' }, writeScope: 'artifact-only',
    generation: { requirement: 'optional', defaultProducer: 'human', allowedProducers: ['human'], task: 'analyze' } });
  const definition = { version: 2, templatesRoot: 'singularity/templates',
    worldModel: { views: ['architecture', 'development', 'testing', 'security', 'business', 'operations', 'release'] },
    workTypes: { baseline: { label: 'Baseline', phases: ['intake', 'conformance'], omits: OMITS } },
    phases: { intake: ordinary('intake'), conformance: ordinary('conformance') },
    approvalSecurity: { profile: 'team' },
    approvalAuthorities: { reviewers: { label: 'Reviewers', members: [{ name: 'Reviewer', email: 'reviewer@example.test' }] } } };
  await mkdir(path.join(first, 'singularity/templates/common'), { recursive: true });
  await mkdir(path.join(first, '.github/agents'), { recursive: true });
  await writeFile(path.join(first, 'singularity/workflow.yml'), YAML.stringify(definition));
  await writeFile(path.join(first, 'singularity/templates/common/empty.md'), '# Exact approved template\n');
  for (const [agent, phaseId] of [['product-owner', 'intake'], ['qa', 'conformance']]) await writeFile(path.join(first, `.github/agents/${agent}.agent.md`),
    `---\nname: ${agent}\ndescription: Exact base role\ntools: []\nmetadata:\n  sflow-phases: ${phaseId}\n  sflow-default-for: ${phaseId}\n---\nRead only the exact approved inputs.\n`);
  await writeFile(path.join(first, 'application.txt'), 'Never change the application for an inactive proposal.\n');
  git(first, 'add', '.'); git(first, 'commit', '-qm', 'Approved SKP fixture'); git(first, 'branch', 'sflow/config');
  git(first, 'remote', 'add', 'origin', remote); git(first, 'push', '-q', 'origin', 'main', 'sflow/config');
  const commit = git(first, 'rev-parse', 'HEAD');
  git(base, 'clone', '-q', '--branch', 'main', remote, second);
  git(second, 'config', 'user.name', 'SKP Second'); git(second, 'config', 'user.email', 'skp.second@example.test');
  for (const root of [first, second]) { await writeFile(path.join(root, 'contributor-note.txt'), 'Unrelated staged bytes\n'); git(root, 'add', 'contributor-note.txt'); }
  const request = { schema: WCA_REQUEST_SCHEMA, intent: 'create', id: 'team-notes', label: 'Team notes',
    description: 'Produce one inert findings artifact for independent human review.', baseRevision: commit,
    target: { governs: 'story', authority: 'selected-repository', hosts: [] },
    definitions: { workflows: [{ id: 'team-notes', phases: ['intake', 'team-note', 'conformance'], omits: OMITS }],
      phases: [{ id: 'team-note', kind: 'skill', label: 'Team findings', agent: 'note-writer', skill: { id: 'analysis-procedure' },
        contract: { task: 'analyze', consumes: [{ phase: 'intake', output: 'primary', required: true, state: 'approved' }],
          produces: [{ id: 'primary', path: 'artifacts/team-note/note.md', kind: 'custom:note', mediaType: 'text/markdown', encoding: 'utf-8',
            minimumBytes: 20, maximumBytes: 16_384, clauses: 'none', claimRole: 'findings' }],
          checks: [], writeScope: 'artifact-only', readScope: { inputs: true, sourcePaths: [] }, approval: { authorities: ['reviewers'], minimum: 1 } } }],
      skills: [{ id: 'analysis-procedure', description: 'Produce exact findings for review',
        instructions: 'Read the approved intake. Produce only the selected findings artifact. Stop for human review.',
        operationBindings: [], qualityBindings: [], resources: [],
        ...(classified ? { producerClassification: { profile: WCA_SKP_LOCAL_PRODUCER_PROFILE, eligibility: 'candidate-producer' } } : {}) }],
      agents: [{ id: 'note-writer', description: 'Write the selected findings',
        prompt: 'Read the exact approved intake. Produce findings, never publish or approve. Stop for review.', toolBindings: [], skillRefs: [] }] } };
  const stores = [first, second].map((root) => openGitDraftStore({ root, remote, workspaceId: 'configuration' }));
  const created = await stores[0].create({ draftId: DRAFT_ID, displayName: 'SKP submission fixture', expectedHead: null,
    payload: request, assets: [], operationId: 'create-skp-submission-fixture' });
  const preview = await previewWorkflowDraftPackage(first, { draftId: DRAFT_ID, revision: 1 });
  assert.deepEqual(preview.findings.map((finding) => finding.code), ['WCA_SKP_CONFIRMATION_BINDING_PENDING'], JSON.stringify(preview.findings));
  assert.equal(preview.skillFinalization?.status, classified ? 'requires-exact-terminal-consent' : 'producer-classification-unavailable');
  const f = { base, first, second, remote, commit, definition, request, stores, created, preview };
  return { ...f, before: await Promise.all([first, second].map(observation)), headsBefore: heads(f) };
}
async function unchanged(f, { proposal = null } = {}) {
  const actual = await Promise.all([f.first, f.second].map(observation));
  if (proposal) {
    // The existing proposal owner retains its exact consented transport pin and remote review
    // branch. Neither may change an application branch; no other new/updated ref is admitted.
    const allowed = new Set([`${proposal.commit} refs/remotes/origin/${proposal.branch}`,
      `${proposal.commit} refs/singularity/transport/configuration-proposals/${proposal.commit}`]);
    const refs = actual[0].refs.split('\n');
    assert.deepEqual(new Set(refs.filter((line) => allowed.has(line))), allowed);
    actual[0].refs = refs.filter((line) => !allowed.has(line)).join('\n');
  }
  assert.deepEqual(actual, f.before);
  for (const root of [f.first, f.second]) for (const relative of ['singularity/skills/analysis-procedure', '.github/skills/analysis-procedure',
    '.github/agents/team-notes-note-writer.agent.md', 'singularity/workflow-authoring-skill-submissions']) {
    await assert.rejects(stat(path.join(root, relative)), { code: 'ENOENT' });
  }
}

// Real macOS PTY transport proves this local confirmation route, not a native-host human pilot.
async function terminal(f, { cancel = false, drift = null, forgedCard = false } = {}) {
  const settings = { root: f.first, otherRoot: f.second, remote: f.remote, base: f.base, draftId: DRAFT_ID,
    revision: 1, expectedPlanSha256: f.preview.planSha256, drift, forgedCard };
  const code = `
    import {spawnSync} from 'node:child_process';
    import {writeFile} from 'node:fs/promises';
    import path from 'node:path';
    import {previewWorkflowDraftPackage} from ${JSON.stringify(new URL('../src/wca-compiler.mjs', import.meta.url).href)};
    import {openGitDraftStore} from ${JSON.stringify(new URL('../src/wca-git-drafts.mjs', import.meta.url).href)};
    import {captureTerminalActionAuthorization} from ${JSON.stringify(new URL('../src/action-authorization.mjs', import.meta.url).href)};
    import {createWorkflowDraftReviewProposal,workflowDraftSubmissionPlan} from ${JSON.stringify(new URL('../src/wca-submission.mjs', import.meta.url).href)};
    const s=${JSON.stringify(settings)};
    const git=(root,...args)=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8',timeout:30000});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim();};
    const err=e=>({code:e.code,message:e.message,stack:e.stack});
    let result;
    try {
      const preview=await previewWorkflowDraftPackage(s.root,{draftId:s.draftId,revision:s.revision});
      const review=workflowDraftSubmissionPlan(preview);
      const presented=s.forgedCard?structuredClone(review):review;
      if(s.forgedCard)presented.plan.subject.phases[0].selectedAgent.textSha256='sha256:'+'0'.repeat(64);
      const grant=await captureTerminalActionAuthorization(s.root,presented.plan,presented.action,{label:'Create review proposal'});
      if(!grant)result={ok:true,cancelled:true};
      else {
        if(s.drift==='draft'||s.drift==='agent'){
          const store=openGitDraftStore({root:s.otherRoot,remote:s.remote,workspaceId:'configuration'});
          const current=await store.readRevision({draftId:s.draftId});const payload=structuredClone(current.payload);
          if(s.drift==='agent')payload.definitions.agents[0].prompt+=' Changed selected agent bytes.';
          else payload.description='New saved source requires fresh review.';
          await store.appendRevision({draftId:s.draftId,expectedHead:current.head,epoch:1,operationId:'drift-after-skp-review',patch:{payload}});
        }
        if(s.drift==='approved-agent'){
          const changed=path.join(s.base,'changed-authority');git(s.base,'clone','-q','--branch','sflow/config',s.remote,changed);
          git(changed,'config','user.name','Authority Fixture');git(changed,'config','user.email','authority@example.test');
          const relative='.github/agents/product-owner.agent.md';
          await writeFile(path.join(changed,relative),git(changed,'show','HEAD:'+relative)+'\\nNew approved intake role requires review.\\n');
          git(changed,'add',relative);git(changed,'commit','-qm','Change approved agent');git(changed,'push','-q','origin','HEAD:refs/heads/sflow/config');
        }
        const options={draftId:s.draftId,revision:s.revision,expectedPlanSha256:s.expectedPlanSha256,confirmation:grant.token};
        try {
          const proposed=await createWorkflowDraftReviewProposal(s.root,options);let replay;
          try{await createWorkflowDraftReviewProposal(s.root,options);}catch(e){replay=err(e);}
          result={ok:true,proposed,replay};
        }catch(e){result={ok:false,error:err(e)};}
      }
    }catch(e){result={ok:false,error:err(e)};}
    console.log('WCA_SKP_SUBMISSION_RESULT:'+JSON.stringify(result));
  `;
  const script = 'set timeout 30\nspawn -noecho $env(SF_SKP_SUBMISSION_NODE) --input-type=module -e $env(SF_SKP_SUBMISSION_CODE)\nexpect {\n -exact {Type Create review proposal} { send -- "$env(SF_SKP_SUBMISSION_ANSWER)\\r" }\n timeout {exit 124}\n eof {exit 125}\n}\nexpect {eof {} timeout {exit 124}}\nset result [wait]\nexit [lindex $result 3]\n';
  const result = await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/expect', ['-c', script], { cwd: f.first, env: { ...environment(f.first),
      SF_SKP_SUBMISSION_NODE: process.execPath, SF_SKP_SUBMISSION_CODE: code, SF_SKP_SUBMISSION_ANSWER: cancel ? '' : 'Create review proposal' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let diagnostics = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`SKP PTY timed out: ${output.slice(-3000)}\n${diagnostics}`)); }, 40_000);
    child.stdout.on('data', (bytes) => { output += bytes; }); child.stderr.on('data', (bytes) => { diagnostics += bytes; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, output, diagnostics }); });
  });
  assert.equal(result.status, 0, `${result.output.slice(-3000)}\n${result.diagnostics}`);
  const matched = result.output.match(/WCA_SKP_SUBMISSION_RESULT:(\{[^\r\n]+\})/u); assert.ok(matched, result.output.slice(-3000));
  return { ...JSON.parse(matched[1]), output: result.output };
}

test('SKP pre-consent/headless route is review-needed with no files, grants or application mutation; public receipts refuse', async (t) => {
  const f = await fixture(t); assert.equal(f.preview.assets.length, 0); assert.equal(f.preview.fileOperations.length, 0);
  assert.equal(f.preview.readiness.authoring, 'review-required');
  assert.equal(f.preview.readiness.confirmation, 'absent'); assert.equal(f.preview.readiness.execution, 'not-run');
  assert.equal(f.preview.skillProposals[0].bindingRefs.confirmation, undefined);
  const review = workflowDraftSubmissionPlan(f.preview);
  assert.equal(review.plan.subject.classificationDecisions[0].approvedCatalogChanged, false);
  assert.equal(review.plan.subject.classificationDecisions[0].effect, 'inactive-review-candidate-only');
  assert.throws(() => workflowDraftPackageProposalFiles(f.preview), { code: 'WCA_PACKAGE_NOT_SUBMITTABLE' });
  assert.throws(() => workflowDraftSubmissionPlan(structuredClone(f.preview)), { code: 'WCA_PACKAGE_NOT_SUBMITTABLE' });
  const cli = spawnSync(process.execPath, [CLI, 'workflow', 'author', 'submit', DRAFT_ID, '--revision', '1', '--json'],
    { cwd: f.first, env: environment(f.first), encoding: 'utf8', timeout: 30_000 });
  assert.equal(cli.status, 0, cli.stderr); const response = JSON.parse(cli.stdout);
  assert.equal(response.status, 'needs-human-input'); assert.equal(response.data.code, 'WCA_NEEDS_HUMAN_INPUT');
  assert.equal(response.data.nativeConfirmation, 'unavailable'); assert.deepEqual(response.data.review, review);
  assert.ok(Object.values(response.effects).every((value) => value === false));
  const latest = spawnSync(process.execPath, [CLI, 'workflow', 'author', 'submit', DRAFT_ID, '--json'],
    { cwd: f.first, env: environment(f.first), encoding: 'utf8', timeout: 30_000 });
  assert.equal(latest.status, 1, latest.stdout);
  assert.equal(JSON.parse(latest.stdout).error.code, 'WCA_AUTHOR_REQUEST_INVALID');
  assert.deepEqual(response.data.handoff.argv,
    ['workflow', 'author', 'submit', DRAFT_ID, '--revision', '1']);
  const show = spawnSync(process.execPath, [CLI, 'workflow', 'author', 'show', DRAFT_ID, '--revision', '1', '--json'],
    { cwd: f.first, env: environment(f.first), encoding: 'utf8', timeout: 30_000 });
  assert.equal(show.status, 0, show.stderr); const view = JSON.parse(show.stdout).data.view;
  assert.equal(view.assessment.status, 'review-required'); assert.equal(view.assessment.definitionGapCount, 0);
  assert.equal(view.primaryAction.operationId, 'workflow.author.submit');
  assert.equal(view.primaryAction.effect, 'separate-terminal-review-only');
  assert.ok(view.missingDecisions.every((decision) => decision.status === 'requires-terminal-review'));
  assert.match(view.primaryAction.command, /workflow.*author.*submit/u);
  assert.match(view.primaryAction.copilotCommand, /^\/sf-workflows/u);
  const forged = await issueActionAuthorization(f.first, review.plan, review.action, { confirmation: review.action.actionId });
  await assert.rejects(createWorkflowDraftReviewProposal(f.first, { draftId: DRAFT_ID, revision: 1,
    expectedPlanSha256: f.preview.planSha256, confirmation: forged.token }), { code: 'ACTION_TERMINAL_PRESENTATION_REQUIRED' });
  assert.equal(heads(f), f.headsBefore); await unchanged(f);
});

test('SKP missing producer classification cannot turn a proposal-only package into a reviewable configured producer', async (t) => {
  const f = await fixture(t, { classified: false });
  assert.equal(f.preview.skillProposals[0].eligibility, 'proposed-candidate-producer');
  assert.equal(f.preview.assets.length, 0); assert.equal(f.preview.skillFinalization.subject.classificationDecisions.length, 0);
  assert.throws(() => workflowDraftSubmissionPlan(f.preview), { code: 'WCA_PACKAGE_NOT_SUBMITTABLE' });
  await assert.rejects(createWorkflowDraftReviewProposal(f.first, { draftId: DRAFT_ID, revision: 1,
    expectedPlanSha256: f.preview.planSha256, confirmation: 'not-a-terminal-grant' }), { code: 'WCA_PACKAGE_NOT_SUBMITTABLE' });
  assert.equal(heads(f), f.headsBefore); await unchanged(f);
});

test('compiler entry recaptures real authority instead of trusting a caller-supplied approved overlay or asset policy', async (t) => {
  const f = await fixture(t); const overlay = path.join(f.base, 'untrusted-approved-overlay');
  const definition = structuredClone(f.definition);
  definition.phases.intake.label = 'Unapproved intake policy';
  definition.workTypes.baseline.label = 'Unapproved catalog label';
  definition.approvalSecurity = { profile: 'poc', allowSelfApproval: true, autoEnrollNewIdentities: true };
  await mkdir(path.join(overlay, 'singularity/templates/common'), { recursive: true });
  await mkdir(path.join(overlay, '.github/agents'), { recursive: true });
  await writeFile(path.join(overlay, 'singularity/workflow.yml'), YAML.stringify(definition));
  await writeFile(path.join(overlay, 'singularity/templates/common/empty.md'), 'Unapproved template bytes.\n');
  for (const agent of ['product-owner', 'qa']) await writeFile(path.join(overlay, `.github/agents/${agent}.agent.md`),
    await readFile(path.join(f.first, `.github/agents/${agent}.agent.md`)));
  const authority = { kind: 'approved-configuration-ref', ref: 'refs/heads/sflow/config',
    commit: 'a'.repeat(40), remote: path.join(f.base, 'nonexistent-authority.git') };
  const assetPolicy = { ...structuredClone(f.preview.approvedAssetPolicy), roots: ['unapproved-policy-root'], runtimeRoots: [] };
  const result = await withConfigurationReadRoot(f.first, overlay, authority, async () => {
    const context = await captureWorkflowCompilerContext(f.first);
    assert.deepEqual(context.source, f.preview.approvedSource);
    const source = await captureWorkflowDraftCompilerSource(context, { draftId: DRAFT_ID, revision: 1 });
    return compileWorkflowDraftPackage({ context, source });
  }, { assetPolicy, configurationSnapshot: { assets: [{ relative: 'singularity/skills/analysis-procedure/SKILL.md' }] } });
  assert.deepEqual(result, f.preview, 'authority, bytes, policy and package identity all come from the fresh approved owner');
  assert.equal(result.candidateDefinition.approvalSecurity.profile, 'team');
  assert.equal(result.candidateDefinition.phases.intake.label, 'intake');
  assert.equal(heads(f), f.headsBefore); await unchanged(f);
});

test('actual terminal SKP consent creates exactly one inert proposal and historical record; replay cannot create another', { skip: TERMINAL_UNAVAILABLE }, async (t) => {
  const f = await fixture(t); const result = await terminal(f);
  assert.equal(result.ok, true, JSON.stringify(result.error)); const proposal = result.proposed;
  assert.equal(proposal.pushed, true); assert.equal(proposal.reviewRequired, true); assert.equal(proposal.approval, 'not-granted');
  assert.equal(proposal.activation, 'inactive'); assert.equal(proposal.execution, 'not-started');
  assert.equal(result.replay.code, 'ACTION_TERMINAL_PRESENTATION_REQUIRED'); assert.equal(proposals(f).length, 1);
  assert.equal(git(f.base, '--git-dir', f.remote, 'rev-parse', `${proposal.commit}^`), f.commit);
  assert.equal(heads(f).split('\n').filter((line) => !line.startsWith('refs/heads/sflow/config-change/')).join('\n'), f.headsBefore);
  assert.ok(proposal.snapshotPath.startsWith('singularity/workflow-authoring-skill-submissions/'));
  const retained = JSON.parse(git(f.base, '--git-dir', f.remote, 'show', `${proposal.commit}:${proposal.snapshotPath}`));
  assert.equal(readRecord('workflow-authoring-skill-submission-snapshot', retained).storedVersion, 1);
  assert.deepEqual(validateWorkflowDraftSkillSubmissionSnapshot(structuredClone(retained)), retained);
  assert.deepEqual(validateWorkflowDraftSubmissionSnapshot(structuredClone(retained)), retained);
  assert.equal(retained.confirmation.assurance, 'configured-local-review'); assert.equal(retained.confirmation.authenticatedNativeHost, false);
  const finalization = retained.preview.skillFinalization;
  const offline = validateWorkflowSkillFinalizationRecord({ subject: finalization.subject, record: finalization.record,
    definition: retained.preview.candidateDefinition, files: retained.files, retainedInputs: retained.inputs });
  assert.equal(offline.authority, 'none');
  const definition = YAML.parse(git(f.base, '--git-dir', f.remote, 'show', `${proposal.commit}:singularity/workflow.yml`));
  assert.equal(definition.version, 3); assert.deepEqual(definition.workTypes['team-notes'].phases, ['intake', 'team-note', 'conformance']);
  validateConfiguredSkillPhase(definition.phases['team-note'], 'team-note');
  assert.equal(definition.phases['team-note'].skillBinding.bindingRefs.confirmation.planSha256, finalization.subject.subjectSha256);
  assert.notEqual(finalization.subject.subjectSha256, finalization.record.finalizationSha256);
  assert.deepEqual(retained.preview.findings, []); assert.equal(retained.preview.simulation.status, 'complete-for-profile');
  assert.equal(retained.preConsentPreview.readiness.authoring, 'review-required');
  assert.equal(retained.preConsentPreview.readiness.confirmation, 'absent');
  assert.equal(retained.preview.readiness.confirmation, 'consumed-terminal-local');
  assert.ok(retained.files.some((file) => file.path === 'singularity/skills/analysis-procedure/SKILL.md'));
  assert.ok(retained.files.every((file) => file.mode === '100644' && !file.path.startsWith('.github/skills/')));
  assert.deepEqual(git(f.base, '--git-dir', f.remote, 'diff-tree', '--no-commit-id', '--name-only', '-r', proposal.commit).split('\n').sort(),
    [...retained.files.map((file) => file.path), proposal.snapshotPath].sort());
  for (const file of retained.files) {
    const actual = spawnSync('git', ['--git-dir', f.remote, 'show', `${proposal.commit}:${file.path}`], { cwd: f.base, timeout: 30_000 });
    assert.equal(actual.status, 0); assert.equal(byteHash(actual.stdout), file.sha256); assert.equal(actual.stdout.toString('base64'), file.contentBase64);
  }
  assert.throws(() => workflowDraftPackageProposalFiles(retained.preview), { code: 'WCA_COMPILER_SOURCE_UNAVAILABLE' });
  assert.throws(() => workflowDraftSubmissionPlan(retained.preview), { code: 'WCA_COMPILER_SOURCE_UNAVAILABLE' });
  const beforeHistorical = canonicalJson(retained);
  const read = await f.stores[1].readRevision({ draftId: DRAFT_ID }); const payload = structuredClone(read.payload);
  payload.definitions.agents[0].prompt += ' Later shared draft text must not rewrite a historical submission.';
  await f.stores[1].appendRevision({ draftId: DRAFT_ID, expectedHead: read.head, epoch: 1,
    operationId: 'after-retained-skp-submission', patch: { payload } });
  assert.equal(canonicalJson(validateWorkflowDraftSubmissionSnapshot(retained)), beforeHistorical);
  assert.throws(() => validateWorkflowDraftSkillSubmissionSnapshot(changedAgentEvidence(retained)),
    'resealed historical agent bytes must still bind the exact selected agent and retained request');
  assert.throws(() => validateWorkflowDraftSkillSubmissionSnapshot(changedAgentEvidence(retained, { resealAgentIdentity: true })),
    'changing the selected-agent hash too cannot detach the historical candidate from its unchanged retained request');
  const corrupted = structuredClone(retained); corrupted.files[0].contentBase64 = Buffer.from('Different bytes').toString('base64');
  const { snapshotSha256, ...core } = corrupted; corrupted.snapshotSha256 = hash(core);
  assert.throws(() => validateWorkflowDraftSkillSubmissionSnapshot(corrupted));
  assert.equal(proposals(f).length, 1); await unchanged(f, { proposal });
});

test('actual terminal SKP Cancel default creates no binding, submission snapshot or remote proposal', { skip: TERMINAL_UNAVAILABLE }, async (t) => {
  const f = await fixture(t); const result = await terminal(f, { cancel: true });
  assert.equal(result.cancelled, true); assert.equal(heads(f), f.headsBefore); await unchanged(f);
});

for (const drift of ['draft', 'agent', 'approved-agent']) test(`actual terminal SKP consent refuses ${drift} drift before proposal effects`, { skip: TERMINAL_UNAVAILABLE }, async (t) => {
  const f = await fixture(t); const result = await terminal(f, { drift });
  assert.equal(result.ok, false); assert.equal(result.error.code, 'WCA_PREVIEW_STALE', JSON.stringify(result.error));
  assert.equal(proposals(f).length, 0); await unchanged(f);
});

test('actual terminal SKP card altered from the exact agent subject cannot act as the authentic review', { skip: TERMINAL_UNAVAILABLE }, async (t) => {
  const f = await fixture(t); const result = await terminal(f, { forgedCard: true });
  assert.equal(result.ok, false); assert.equal(result.error.code, 'ACTION_TERMINAL_PRESENTATION_REQUIRED');
  assert.equal(heads(f), f.headsBefore); await unchanged(f);
});
