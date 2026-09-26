import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { issueActionAuthorization } from '../src/action-authorization.mjs';
import { isConfigurationReadPath } from '../src/configuration-read-scope.mjs';
import { recordSha256 } from '../src/records.mjs';
import { removeTemporaryTree } from '../src/util.mjs';
import { previewWorkflowDraftPackage, WCA_REQUEST_SCHEMA } from '../src/wca-compiler.mjs';
import { openGitDraftStore } from '../src/wca-git-drafts.mjs';
import { createWorkflowDraftReviewProposal, validateWorkflowDraftSubmissionSnapshot, workflowDraftSubmissionPlan } from '../src/wca-submission.mjs';

const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const DRAFT_ID = 'WFD-SUBMIT01';
const TERMINAL_FIXTURE_UNAVAILABLE = process.platform !== 'darwin' || !existsSync('/usr/bin/expect');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const terminalFailure = (result) => JSON.stringify({ error: result.error, changedHead: result.changedHead,
  output: result.output?.slice(-2000) });

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
function flowEnvironment(root) {
  return { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'WCA Submission Fixture',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.test-workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.test-active-workspace.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(root, '.test-leads.json'),
    SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(path.dirname(root), 'transport-outbox'),
    SINGULARITY_FLOW_DISABLE_MODELS: '1' };
}
function author(root, ...args) {
  return spawnSync(process.execPath, [CLI, 'workflow', 'author', ...args, '--json'], {
    cwd: root, encoding: 'utf8', timeout: 30_000, env: flowEnvironment(root)
  });
}
async function applicationObservation(root) {
  const status = git(root, 'status', '--porcelain=v1');
  return { head: git(root, 'rev-parse', 'HEAD'), branch: git(root, 'branch', '--show-current'), status,
    index: await readFile(path.join(root, '.git/index')),
    workflow: await readFile(path.join(root, 'singularity/workflow.yml')),
    contributor: await readFile(path.join(root, 'contributor-note.txt')) };
}
function remoteHeads(f) {
  return git(f.base, '--git-dir', f.remote, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/');
}
async function fixture(t, { attributes = null, templatesRoot = 'singularity/templates',
  templateContent = '# Team note\n\n## Inputs\n\n## Findings\n\n## Open questions\n' } = {}) {
  // An isolated bare fixture has no provider-account evidence and must not query a private gh account.
  const previous = { NODE_ENV: process.env.NODE_ENV, SINGULARITY_FLOW_TEST_IDENTITY: process.env.SINGULARITY_FLOW_TEST_IDENTITY };
  process.env.NODE_ENV = 'test'; process.env.SINGULARITY_FLOW_TEST_IDENTITY = 'WCA Submission Fixture';
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-wca-submission-'));
  t.after(() => removeTemporaryTree(base));
  const first = path.join(base, 'first'); const second = path.join(base, 'second'); const remote = path.join(base, 'authority.git');
  await mkdir(first); git(base, 'init', '--bare', '-q', '-b', 'main', remote); git(first, 'init', '-q', '-b', 'main');
  git(first, 'config', 'user.name', 'Submission First'); git(first, 'config', 'user.email', 'submission.first@example.test');
  const phase = (id) => ({ label: id, artifact: { path: `artifacts/${id}/${id}.md`, minimumBytes: 20, maximumBytes: 16_384 },
    defaultTemplate: 'common/empty.md', inputs: [], approval: { mode: 'none' }, writeScope: 'artifact-only',
    generation: { requirement: 'optional', defaultProducer: 'human', allowedProducers: ['human'], task: 'analyze' } });
  const definition = { version: 2, templatesRoot,
    worldModel: { views: ['architecture', 'development', 'testing', 'security', 'business', 'operations', 'release'] },
    workTypes: { baseline: { label: 'Baseline', phases: ['intake', 'conformance'] } },
    phases: { intake: phase('intake'), conformance: phase('conformance') }, approvalSecurity: { profile: 'team' },
    approvalAuthorities: { reviewers: { label: 'Reviewers', members: [{ name: 'Reviewer', email: 'reviewer@example.test' }] } } };
  await mkdir(path.join(first, 'singularity'), { recursive: true });
  await mkdir(path.join(first, templatesRoot, 'common'), { recursive: true }); await mkdir(path.join(first, '.github/agents'), { recursive: true });
  await writeFile(path.join(first, 'singularity/workflow.yml'), YAML.stringify(definition));
  await writeFile(path.join(first, templatesRoot, 'common/empty.md'), '# Exact approved template\n');
  for (const [agent, phaseId] of [['product-owner', 'intake'], ['qa', 'conformance']]) await writeFile(path.join(first, `.github/agents/${agent}.agent.md`),
    `---\nname: ${agent}\ndescription: Exact base role\ntools: []\nmetadata:\n  sflow-phases: ${phaseId}\n  sflow-default-for: ${phaseId}\n---\nRead only the exact current approved inputs.\n`);
  await writeFile(path.join(first, 'application.txt'), 'Application source must never change during proposal submission.\n');
  if (attributes !== null) await writeFile(path.join(first, '.gitattributes'), attributes);
  git(first, 'add', '.'); git(first, 'commit', '-qm', 'approved submission fixture'); git(first, 'branch', 'sflow/config');
  git(first, 'remote', 'add', 'origin', remote); git(first, 'push', '-q', 'origin', 'main', 'sflow/config');
  const commit = git(first, 'rev-parse', 'HEAD');
  git(base, 'clone', '-q', '--branch', 'main', remote, second);
  git(second, 'config', 'user.name', 'Submission Second'); git(second, 'config', 'user.email', 'submission.second@example.test');
  for (const root of [first, second]) {
    await writeFile(path.join(root, 'contributor-note.txt'), `${path.basename(root)} unrelated staged bytes\n`);
    git(root, 'add', 'contributor-note.txt');
  }
  const request = { schema: WCA_REQUEST_SCHEMA, intent: 'create', id: 'team-notes', label: 'Team notes', baseRevision: commit,
    target: { governs: 'story', authority: 'selected-repository', hosts: [] },
    bindings: { analysisTask: { kind: 'execution-task', id: 'analyze' }, review: { kind: 'approval-authority', id: 'reviewers' } },
    definitions: { workflows: [{ id: 'team-notes', phases: ['intake', 'team-note', 'conformance'] }],
      phases: [{ id: 'team-note', label: 'Team note', artifact: { path: 'artifacts/team-note/note.md', kind: 'custom:note', minimumBytes: 20, maximumBytes: 16_384 },
        inputs: ['intake'], template: 'note-template', agent: 'note-writer', taskBinding: 'analysisTask', approvalBinding: 'review', qualityBindings: [], writeScope: 'artifact-only' }],
      agents: [{ id: 'note-writer', description: 'Write the selected note', prompt: 'Read the exact approved intake. Produce the selected note and stop for human review.', toolBindings: [], skillRefs: [] }],
      templates: [{ id: 'note-template', content: templateContent }] } };
  const stores = [first, second].map((root) => openGitDraftStore({ root, remote, workspaceId: 'configuration' }));
  const created = await stores[0].create({ draftId: DRAFT_ID, displayName: 'Submission fixture', expectedHead: null, payload: request, assets: [], operationId: 'create-submission-fixture' });
  const preview = await previewWorkflowDraftPackage(first, { draftId: DRAFT_ID, revision: 1 });
  assert.deepEqual(preview.findings, []);
  const f = { base, first, second, remote, commit, definition, request, stores, created, preview };
  return { ...f, firstBefore: await applicationObservation(first), secondBefore: await applicationObservation(second), headsBefore: remoteHeads(f) };
}

async function assertApplicationsUnchanged(f) {
  assert.deepEqual(await applicationObservation(f.first), f.firstBefore);
  assert.deepEqual(await applicationObservation(f.second), f.secondBefore);
  for (const root of [f.first, f.second]) {
    await assert.rejects(stat(path.join(root, '.github/agents/team-notes-note-writer.agent.md')), { code: 'ENOENT' });
    await assert.rejects(stat(path.join(root, f.definition.templatesRoot, 'team-notes/note-template.md')), { code: 'ENOENT' });
    await assert.rejects(stat(path.join(root, 'singularity/workflow-authoring-submissions')), { code: 'ENOENT' });
  }
}

// This is an actual OS PTY transport fixture, not authenticated native-host or human pilot evidence.
async function terminalSubmission(f, { cancel = false, mutation = null, deleteAfterSubmission = false, omitReviewedFiles = false } = {}) {
  const settings = { root: f.first, otherRoot: f.second, remote: f.remote, draftId: DRAFT_ID,
    revision: 1, expectedPlanSha256: f.preview.planSha256, cancel, mutation, deleteAfterSubmission, omitReviewedFiles };
  const childCode = `
    import {spawnSync} from 'node:child_process';
    import {writeFile} from 'node:fs/promises';
    import path from 'node:path';
    import {previewWorkflowDraftPackage} from ${JSON.stringify(new URL('../src/wca-compiler.mjs', import.meta.url).href)};
    import {openGitDraftStore,draftDeletePlan} from ${JSON.stringify(new URL('../src/wca-git-drafts.mjs', import.meta.url).href)};
    import {captureTerminalActionAuthorization} from ${JSON.stringify(new URL('../src/action-authorization.mjs', import.meta.url).href)};
    import {createWorkflowDraftReviewProposal,workflowDraftSubmissionPlan} from ${JSON.stringify(new URL('../src/wca-submission.mjs', import.meta.url).href)};
    const settings=${JSON.stringify(settings)};
    const git=(root,...args)=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8',timeout:30000});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim();};
    try {
      const preview=await previewWorkflowDraftPackage(settings.root,{draftId:settings.draftId,revision:settings.revision});
      const review=workflowDraftSubmissionPlan(preview);
      const presented=settings.omitReviewedFiles?structuredClone(review):review;
      if(settings.omitReviewedFiles)presented.plan.candidate.files=[];
      const grant=await captureTerminalActionAuthorization(settings.root,presented.plan,presented.action,{label:'Create review proposal'});
      if(!grant){console.log('WCA_SUBMISSION_RESULT:'+JSON.stringify({ok:true,cancelled:true}));}
      else {
        let changedHead=null;
        if(settings.mutation){
          const store=openGitDraftStore({root:settings.otherRoot,remote:settings.remote,workspaceId:'configuration'});
          const current=await store.readRevision({draftId:settings.draftId});
          if(settings.mutation==='draft'){
            const payload=structuredClone(current.payload);payload.definitions.agents[0].prompt+=' New revision requires new review.';
            changedHead=(await store.appendRevision({draftId:settings.draftId,expectedHead:current.head,epoch:1,operationId:'advance-after-terminal-review',patch:{payload}})).head;
          } else if(settings.mutation==='configuration'){
            const childRoot=path.join(${JSON.stringify(f.base)},'new-authority');
            git(${JSON.stringify(f.base)},'clone','-q','--branch','sflow/config',settings.remote,childRoot);
            git(childRoot,'config','user.name','Authority Fixture');git(childRoot,'config','user.email','authority@example.test');
            const source=git(childRoot,'show','HEAD:singularity/workflow.yml');
            await writeFile(path.join(childRoot,'singularity/workflow.yml'),source.replace('label: Reviewers','label: Newly selected reviewers')+'\\n');
            git(childRoot,'add','singularity/workflow.yml');git(childRoot,'commit','-qm','change exact approved catalog');
            git(childRoot,'push','-q','origin','HEAD:refs/heads/sflow/config');changedHead=git(childRoot,'rev-parse','HEAD');
          } else if(settings.mutation==='deleted'){
            const deletion=draftDeletePlan({remote:settings.remote,workspaceId:'configuration',draftId:settings.draftId,expectedHead:current.head,epoch:1,revisionSha256:current.record.revisionSha256});
            const consent=await captureTerminalActionAuthorization(settings.otherRoot,deletion.plan,deletion.action,{label:'Delete draft'});
            changedHead=(await store.delete({draftId:settings.draftId,expectedHead:current.head,epoch:1,operationId:'delete-before-submission',confirmation:consent.token})).head;
          }
        }
        try {
          const result=await createWorkflowDraftReviewProposal(settings.root,{draftId:settings.draftId,revision:settings.revision,expectedPlanSha256:settings.expectedPlanSha256,confirmation:grant.token});
          let deletedHead=null;
          if(settings.deleteAfterSubmission){
            const store=openGitDraftStore({root:settings.otherRoot,remote:settings.remote,workspaceId:'configuration'});
            const current=await store.readRevision({draftId:settings.draftId});
            const deletion=draftDeletePlan({remote:settings.remote,workspaceId:'configuration',draftId:settings.draftId,expectedHead:current.head,epoch:1,revisionSha256:current.record.revisionSha256});
            const consent=await captureTerminalActionAuthorization(settings.otherRoot,deletion.plan,deletion.action,{label:'Delete draft'});
            deletedHead=(await store.delete({draftId:settings.draftId,expectedHead:current.head,epoch:1,operationId:'delete-after-submission',confirmation:consent.token})).head;
          }
          console.log('WCA_SUBMISSION_RESULT:'+JSON.stringify({ok:true,result,changedHead,deletedHead}));
        } catch(error){console.log('WCA_SUBMISSION_RESULT:'+JSON.stringify({ok:false,changedHead,error:{code:error.code,message:error.message}}));}
      }
    } catch(error){console.log('WCA_SUBMISSION_RESULT:'+JSON.stringify({ok:false,error:{code:error.code,message:error.message}}));}
  `;
  const answer = cancel ? '\\r' : 'Create review proposal\\r';
  const deleted = mutation === 'deleted' || deleteAfterSubmission ? '\nexpect {\n -exact {Type Delete draft} { send -- "Delete draft\\r" }\n timeout { exit 124 }\n eof { exit 125 }\n}\n' : '';
  const script = `set timeout 30\nspawn -noecho $env(SF_WCA_SUBMISSION_NODE) --input-type=module -e $env(SF_WCA_SUBMISSION_CODE)\nexpect {\n -exact {Type Create review proposal} { send -- "${answer}" }\n timeout { exit 124 }\n eof { exit 125 }\n}\n${deleted}expect { eof {} timeout { exit 124 } }\nset result [wait]\nexit [lindex $result 3]\n`;
  const observed = await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/expect', ['-c', script], { cwd: f.first,
      env: { ...flowEnvironment(f.first), SF_WCA_SUBMISSION_NODE: process.execPath, SF_WCA_SUBMISSION_CODE: childCode }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let diagnostics = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Submission PTY fixture timed out.\n${output}\n${diagnostics}`)); }, 40_000);
    child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { diagnostics += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, output, diagnostics }); });
  });
  assert.equal(observed.status, 0, `${observed.output}\n${observed.diagnostics}`);
  const matched = `${observed.output}\n${observed.diagnostics}`.match(/WCA_SUBMISSION_RESULT:(\{[^\r\n]+\})/u);
  assert.ok(matched, observed.output);
  return { ...JSON.parse(matched[1]), output: observed.output };
}

async function terminalCliSubmission(f, { cancel = false } = {}) {
  const script = [
    'set timeout 30',
    'spawn -noecho $env(SF_WCA_SUBMISSION_NODE) $env(SF_WCA_SUBMISSION_CLI) workflow author submit $env(SF_WCA_SUBMISSION_DRAFT) --revision 1 --json',
    'expect {',
    ' -exact {Type Create review proposal} { send -- "$env(SF_WCA_SUBMISSION_ANSWER)\\r" }',
    ' timeout { exit 124 }',
    ' eof { exit 125 }',
    '}',
    'expect { eof {} timeout { exit 124 } }',
    'set result [wait]',
    'exit [lindex $result 3]'
  ].join('\n');
  const observed = await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/expect', ['-c', script], { cwd: f.first,
      env: { ...flowEnvironment(f.first), SF_WCA_SUBMISSION_NODE: process.execPath, SF_WCA_SUBMISSION_CLI: CLI,
        SF_WCA_SUBMISSION_DRAFT: DRAFT_ID, SF_WCA_SUBMISSION_ANSWER: cancel ? '' : 'Create review proposal' },
      stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let diagnostics = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI PTY fixture timed out.\n${output.slice(-2000)}\n${diagnostics}`)); }, 40_000);
    child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { diagnostics += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, output, diagnostics }); });
  });
  assert.equal(observed.status, 0, `${observed.output.slice(-3000)}\n${observed.diagnostics}`);
  const output = observed.output.replaceAll('\r', '');
  const marker = '{\n  "resultType": "workflow-author",';
  const start = output.lastIndexOf(marker);
  assert.ok(start >= 0, output.slice(-3000));
  const response = JSON.parse(output.slice(start).trim());
  assert.match(output, /Creates only a review proposal\. No approval, activation or execution\. Cancel is the default\./u);
  assert.match(output, /Type Create review proposal to confirm this exact action, or Enter to cancel/u);
  return response;
}

async function assertCustomRootProposal(f, result) {
  assert.equal(result.reviewRequired, true); assert.equal(result.pushed, true);
  assert.equal(result.approval, 'not-granted'); assert.equal(result.activation, 'inactive');
  assert.equal(result.execution, 'not-started'); assert.equal(result.planSha256, f.preview.planSha256);
  const templatePath = `${f.definition.templatesRoot}/team-notes/note-template.md`;
  assert.ok(f.preview.assets.some((asset) => asset.path === templatePath));
  assert.equal(f.preview.assets.some((asset) => asset.path === 'singularity/templates/team-notes/note-template.md'), false);
  assert.equal(isConfigurationReadPath(templatePath), false, 'a scoped custom-root submission must not widen the default policy');
  assert.ok(f.preview.approvedAssetPolicy.roots.includes(f.definition.templatesRoot));
  assert.ok(f.preview.approvedAssetPolicy.runtimeRoots.includes('singularity/world-model'));
  const expectedFiles = [...f.preview.assets.map((asset) => asset.path), result.snapshotPath].sort();
  assert.deepEqual([...result.files].sort(), expectedFiles);
  assert.deepEqual(git(f.base, '--git-dir', f.remote, 'diff-tree', '--no-commit-id', '--name-only', '-r', result.commit).split('\n').sort(), expectedFiles);
  assert.equal(git(f.base, '--git-dir', f.remote, 'rev-parse', `${result.commit}^`), f.commit);
  assert.equal(git(f.base, '--git-dir', f.remote, 'rev-parse', `refs/heads/${result.branch}`), result.commit);
  assert.equal(remoteHeads(f).split('\n').filter((line) => !line.startsWith('refs/heads/sflow/config-change/')).join('\n'), f.headsBefore);
  assert.equal(remoteHeads(f).split('\n').filter((line) => line.startsWith('refs/heads/sflow/config-change/')).length, 1);
  const snapshot = JSON.parse(git(f.base, '--git-dir', f.remote, 'show', `${result.commit}:${result.snapshotPath}`));
  // Validate outside the compiler's request-local read scope as an ordinary retained reader does.
  assert.deepEqual(validateWorkflowDraftSubmissionSnapshot(snapshot), snapshot);
  assert.deepEqual(snapshot.inputs.request, f.request);
  assert.equal(snapshot.confirmation.authenticatedNativeHost, false);
  for (const file of snapshot.files) {
    const emitted = spawnSync('git', ['--git-dir', f.remote, 'show', `${result.commit}:${file.path}`], { cwd: f.base, timeout: 30_000 });
    assert.equal(emitted.status, 0, emitted.stderr.toString());
    assert.deepEqual(emitted.stdout, Buffer.from(file.contentBase64, 'base64'));
    assert.equal(git(f.base, '--git-dir', f.remote, 'ls-tree', result.commit, '--', file.path).split(' ')[0], '100644');
  }
  await assertApplicationsUnchanged(f);
  return snapshot;
}

function resealRetainedSnapshot(value, originalPlan) {
  value.preview.candidateAssetManifestSha256 = `sha256:${recordSha256(value.preview.assets.map(({ path: file, bytes, sha256: hash }) => ({ path: file, bytes, sha256: hash })))}`;
  const { planSha256: ignoredPreviewHash, ...previewCore } = value.preview;
  value.preview.planSha256 = `sha256:${recordSha256(previewCore)}`;
  value.planSha256 = value.preview.planSha256;
  value.candidateTreeSha256 = value.preview.candidateAssetManifestSha256;
  const { planId: ignoredPlanId, planHash: ignoredPlanHash, ...actionCore } = structuredClone(originalPlan);
  actionCore.candidate = { ...actionCore.candidate, planSha256: value.preview.planSha256,
    files: value.files, inputs: value.inputs };
  value.actionPlanSha256 = `sha256:${recordSha256(actionCore)}`;
  value.snapshotId = value.actionPlanSha256.slice(7);
  value.operationRef.subject = value.snapshotId.slice(0, 24);
  const { snapshotSha256: ignoredSnapshotHash, ...snapshotCore } = value;
  value.snapshotSha256 = `sha256:${recordSha256(snapshotCore)}`;
  return value;
}

test('submission requires live terminal consent: public issuer and correctly bound JSON receipts publish nothing', async (t) => {
  const f = await fixture(t); const review = workflowDraftSubmissionPlan(f.preview);
  const publicGrant = await issueActionAuthorization(f.first, review.plan, review.action, { confirmation: review.action.actionId, channel: 'terminal' });
  await assert.rejects(createWorkflowDraftReviewProposal(f.first, { draftId: DRAFT_ID, revision: 1, expectedPlanSha256: f.preview.planSha256, confirmation: publicGrant.token }), { code: 'ACTION_TERMINAL_PRESENTATION_REQUIRED' });
  const forged = { ...publicGrant, token: randomUUID(), authorizationId: randomUUID() };
  forged.answerReceipt = recordSha256({ token: forged.token, authorizationId: forged.authorizationId, planHash: forged.planHash, actionId: forged.actionId });
  const directory = path.join(f.first, '.git/singularity-flow/action-authorizations');
  await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, `${forged.token}.json`), JSON.stringify(forged));
  await assert.rejects(createWorkflowDraftReviewProposal(f.first, { draftId: DRAFT_ID, revision: 1, expectedPlanSha256: f.preview.planSha256, confirmation: forged.token }), { code: 'ACTION_TERMINAL_PRESENTATION_REQUIRED' });
  assert.equal(remoteHeads(f), f.headsBefore); await assertApplicationsUnchanged(f);
});

test('submission card binds the compiler-owned exact material and cannot be built from caller JSON', async (t) => {
  const f = await fixture(t); const { plan, action } = workflowDraftSubmissionPlan(f.preview);
  assert.deepEqual(plan.candidate.source, f.preview.source);
  assert.deepEqual(plan.candidate.approvedSource, f.preview.approvedSource);
  assert.equal(plan.candidate.planSha256, f.preview.planSha256);
  assert.deepEqual(plan.candidate.inputs.request, f.request);
  assert.deepEqual(plan.candidate.inputs.assets, []);
  assert.deepEqual(plan.candidate.files.map((file) => ({ path: file.path, content: Buffer.from(file.contentBase64, 'base64').toString('utf8'), bytes: file.bytes, sha256: file.sha256 })), f.preview.assets);
  assert.equal(plan.subject.repository, f.remote); assert.equal(plan.subject.id, DRAFT_ID);
  assert.equal(plan.candidate.source.revision, 1); assert.equal(plan.candidate.source.head, f.created.head);
  const { planId, planHash, ...exactMaterial } = plan;
  assert.equal(planHash, recordSha256(exactMaterial)); assert.equal(planId, planHash.slice(0, 24));
  assert.equal(plan.publication, 'review-required'); assert.equal(plan.approval, 'not-granted');
  assert.equal(plan.activation, 'inactive'); assert.equal(plan.execution, 'not-started');
  assert.equal(action.confirmation.required, true);
  assert.throws(() => workflowDraftSubmissionPlan(JSON.parse(JSON.stringify(f.preview))), { code: 'WCA_COMPILER_SOURCE_UNAVAILABLE' });
  assert.equal(remoteHeads(f), f.headsBefore); await assertApplicationsUnchanged(f);
});

test('headless author submit reports needs-human-input and caller flags cannot publish a review proposal', async (t) => {
  const f = await fixture(t);
  const observed = author(f.first, 'submit', DRAFT_ID, '--revision', '1');
  assert.equal(observed.status, 0, observed.stderr);
  const response = JSON.parse(observed.stdout);
  assert.equal(response.status, 'needs-human-input');
  assert.deepEqual(response.effects, { stateChanged: false, filesChanged: false, publicationCreated: false, externalSystemsChanged: false });
  for (const flags of [['--yes'], ['--confirm', f.preview.planSha256], ['--authorization', randomUUID()], ['--actor', 'Reviewer']]) {
    const refused = author(f.first, 'submit', DRAFT_ID, '--revision', '1', ...flags);
    assert.notEqual(refused.status, 0, `caller flags unexpectedly succeeded: ${flags.join(' ')}`);
    assert.match(`${refused.stdout}\n${refused.stderr}`, /WCA_AUTHOR_REQUEST_INVALID/u);
  }
  assert.equal(remoteHeads(f), f.headsBefore); await assertApplicationsUnchanged(f);
});

test('submission cancellation in an actual terminal publishes no proposal or application bytes', { skip: TERMINAL_FIXTURE_UNAVAILABLE }, async (t) => {
  const f = await fixture(t); const result = await terminalSubmission(f, { cancel: true });
  assert.equal(result.ok, true); assert.equal(result.cancelled, true);
  assert.equal(remoteHeads(f), f.headsBefore); await assertApplicationsUnchanged(f);
});

test('actual CLI terminal route defaults to Cancel and publishes only a separately confirmed exact review proposal', { skip: TERMINAL_FIXTURE_UNAVAILABLE }, async (t) => {
  const f = await fixture(t);
  const cancelled = await terminalCliSubmission(f, { cancel: true });
  assert.equal(cancelled.operation.id, 'workflow.author.submit'); assert.equal(cancelled.operation.modelPolicy, 'never');
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(cancelled.effects, { stateChanged: false, filesChanged: false, publicationCreated: false, externalSystemsChanged: false });
  assert.equal(remoteHeads(f), f.headsBefore); await assertApplicationsUnchanged(f);
  const submitted = await terminalCliSubmission(f);
  assert.equal(submitted.operation.id, 'workflow.author.submit'); assert.equal(submitted.operation.modelPolicy, 'never');
  assert.equal(submitted.status, 'proposed');
  assert.deepEqual(submitted.effects, { stateChanged: true, filesChanged: false, publicationCreated: true, externalSystemsChanged: true });
  const result = submitted.data;
  assert.equal(result.reviewRequired, true); assert.equal(result.pushed, true);
  assert.equal(result.approval, 'not-granted'); assert.equal(result.activation, 'inactive'); assert.equal(result.execution, 'not-started');
  assert.equal(result.planSha256, f.preview.planSha256);
  const snapshot = JSON.parse(git(f.base, '--git-dir', f.remote, 'show', `${result.commit}:${result.snapshotPath}`));
  assert.deepEqual(validateWorkflowDraftSubmissionSnapshot(snapshot).inputs.request, f.request);
  assert.equal(snapshot.confirmation.authenticatedNativeHost, false);
  assert.equal(snapshot.confirmation.assurance, 'configured-local-review');
  const expectedFiles = [...f.preview.assets.map((asset) => asset.path), result.snapshotPath].sort();
  assert.deepEqual([...result.files].sort(), expectedFiles);
  assert.equal(git(f.base, '--git-dir', f.remote, 'rev-parse', `${result.commit}^`), f.commit);
  assert.equal(git(f.base, '--git-dir', f.remote, 'rev-parse', `refs/heads/${result.branch}`), result.commit);
  assert.equal(remoteHeads(f).split('\n').filter((line) => !line.startsWith('refs/heads/sflow/config-change/')).join('\n'), f.headsBefore);
  assert.equal(remoteHeads(f).split('\n').filter((line) => line.startsWith('refs/heads/sflow/config-change/')).length, 1);
  await assertApplicationsUnchanged(f);
});

test('actual terminal core submission carries the exact approved custom template root through retained and staged closure checks', { skip: TERMINAL_FIXTURE_UNAVAILABLE }, async (t) => {
  const f = await fixture(t, { templatesRoot: 'company/templates' });
  assert.equal(f.preview.readiness.authoring, 'valid'); assert.deepEqual(f.preview.findings, []);
  const observed = await terminalSubmission(f);
  assert.equal(observed.ok, true, terminalFailure(observed));
  const snapshot = await assertCustomRootProposal(f, observed.result);
  const { plan } = workflowDraftSubmissionPlan(f.preview);
  const templateIndex = snapshot.files.findIndex((file) => file.path.endsWith('/note-template.md'));
  assert.ok(templateIndex >= 0);
  for (const escapedPath of ['company/unapproved/note-template.md', 'application/note-template.md',
    'singularity/world-model/note-template.md', '.git/config']) await t.test(`retained scope refuses ${escapedPath}`, () => {
    const widened = structuredClone(snapshot);
    widened.files[templateIndex].path = escapedPath;
    widened.preview.assets[templateIndex].path = escapedPath;
    // Recompute all surrounding hashes so refusal comes from the approved scope, not stale digests.
    assert.throws(() => validateWorkflowDraftSubmissionSnapshot(resealRetainedSnapshot(widened, plan)), { code: 'WCA_SUBMISSION_INVALID' });
  });
  assert.equal(remoteHeads(f).split('\n').filter((line) => line.startsWith('refs/heads/sflow/config-change/')).length, 1);
  await assertApplicationsUnchanged(f);
});

test('actual CLI terminal submission supports an approved custom template root without widening default or application paths', { skip: TERMINAL_FIXTURE_UNAVAILABLE }, async (t) => {
  const f = await fixture(t, { templatesRoot: 'company/templates' });
  const submitted = await terminalCliSubmission(f);
  assert.equal(submitted.status, 'proposed');
  assert.deepEqual(submitted.effects, { stateChanged: true, filesChanged: false, publicationCreated: true, externalSystemsChanged: true });
  await assertCustomRootProposal(f, submitted.data);
});

test('live terminal consent binds the complete actually presented card, not a copied hash hiding candidate files', { skip: TERMINAL_FIXTURE_UNAVAILABLE }, async (t) => {
  const f = await fixture(t); const observed = await terminalSubmission(f, { omitReviewedFiles: true });
  assert.equal(observed.ok, false, terminalFailure(observed));
  assert.equal(observed.error.code, 'ACTION_TERMINAL_PRESENTATION_REQUIRED');
  assert.equal(remoteHeads(f), f.headsBefore); await assertApplicationsUnchanged(f);
});

test('actual terminal submission retains exact complete inputs on one review-only branch without changing application/index or approved authority', { skip: TERMINAL_FIXTURE_UNAVAILABLE }, async (t) => {
  const f = await fixture(t); const observed = await terminalSubmission(f);
  assert.equal(observed.ok, true, terminalFailure(observed));
  const result = observed.result; const { plan } = workflowDraftSubmissionPlan(f.preview);
  assert.equal(result.resultType, 'workflow-authoring-submission'); assert.equal(result.status, 'proposed');
  assert.equal(result.reviewRequired, true); assert.equal(result.pushed, true); assert.equal(result.changed, true);
  assert.equal(result.baseBranch, 'sflow/config'); assert.equal(result.baseCommit, f.commit);
  assert.match(result.branch, /^sflow\/config-change\/workflow\//u);
  assert.equal(result.approval, 'not-granted'); assert.equal(result.activation, 'inactive'); assert.equal(result.execution, 'not-started');
  assert.equal(result.snapshotPath, `singularity/workflow-authoring-submissions/${plan.planHash}.json`);
  assert.equal(result.planSha256, f.preview.planSha256);
  assert.deepEqual(result.sourceDraft, f.preview.source);
  const expectedFiles = [...f.preview.assets.map((asset) => asset.path), result.snapshotPath].sort();
  assert.deepEqual([...result.files].sort(), expectedFiles);
  assert.deepEqual(git(f.base, '--git-dir', f.remote, 'diff-tree', '--no-commit-id', '--name-only', '-r', result.commit).split('\n').sort(), expectedFiles);
  assert.equal(git(f.base, '--git-dir', f.remote, 'rev-parse', `${result.commit}^`), f.commit);
  assert.equal(git(f.base, '--git-dir', f.remote, 'rev-parse', `refs/heads/${result.branch}`), result.commit);
  const nonProposalHeads = remoteHeads(f).split('\n').filter((line) => !line.startsWith('refs/heads/sflow/config-change/')).join('\n');
  assert.equal(nonProposalHeads, f.headsBefore);
  assert.equal(remoteHeads(f).split('\n').filter((line) => line.startsWith('refs/heads/sflow/config-change/')).length, 1);
  const snapshotText = git(f.base, '--git-dir', f.remote, 'show', `${result.commit}:${result.snapshotPath}`);
  const snapshot = JSON.parse(snapshotText);
  assert.deepEqual(validateWorkflowDraftSubmissionSnapshot(snapshot), snapshot);
  assert.equal(snapshot.snapshotSha256, result.snapshotSha256);
  assert.equal(snapshot.planSha256, f.preview.planSha256);
  assert.equal(snapshot.actionPlanSha256, `sha256:${plan.planHash}`);
  assert.deepEqual(snapshot.sourceDraft, f.preview.source); assert.deepEqual(snapshot.approvedSource, f.preview.approvedSource);
  assert.deepEqual(snapshot.preview, f.preview); assert.deepEqual(snapshot.inputs.request, f.request); assert.deepEqual(snapshot.inputs.assets, []);
  assert.equal(snapshot.approval, 'not-granted'); assert.equal(snapshot.activation, 'inactive');
  assert.equal(snapshot.confirmation.assurance, 'configured-local-review'); assert.equal(snapshot.confirmation.authenticatedNativeHost, false);
  assert.equal(snapshot.confirmation.channel, 'terminal'); assert.ok(snapshot.confirmation.authorizationId); assert.ok(snapshot.confirmation.questionId);
  assert.deepEqual(snapshot.files.map((file) => file.path), f.preview.assets.map((asset) => asset.path));
  for (const file of snapshot.files) {
    const bytes = Buffer.from(file.contentBase64, 'base64');
    assert.equal(bytes.length, file.bytes); assert.equal(`sha256:${sha256(bytes)}`, file.sha256);
    const emitted = spawnSync('git', ['--git-dir', f.remote, 'show', `${result.commit}:${file.path}`], { cwd: f.base, timeout: 30_000 });
    assert.equal(emitted.status, 0, emitted.stderr.toString()); assert.deepEqual(emitted.stdout, bytes);
    assert.equal(git(f.base, '--git-dir', f.remote, 'ls-tree', result.commit, '--', file.path).split(' ')[0], '100644');
  }
  // The caller's private retention keeps the exact review commit available independently of the remote review ref.
  assert.equal(git(f.first, 'rev-parse', `refs/singularity/transport/configuration-proposals/${result.commit}`), result.commit);
  assert.equal(git(f.first, 'show', `${result.commit}:${result.snapshotPath}`), snapshotText);
  const damaged = structuredClone(snapshot); damaged.files[0].contentBase64 = Buffer.from('Different candidate bytes').toString('base64');
  assert.throws(() => validateWorkflowDraftSubmissionSnapshot(damaged), { code: 'WCA_SUBMISSION_INVALID' });
  const activated = structuredClone(snapshot); activated.approval = 'approved';
  assert.throws(() => validateWorkflowDraftSubmissionSnapshot(activated), { code: 'WCA_SUBMISSION_INVALID' });
  const changedInputs = structuredClone(snapshot); changedInputs.inputs.request.definitions.agents[0].prompt += ' Not the captured source request.';
  const reseal = (value) => { const { snapshotSha256: ignored, ...core } = value; value.snapshotSha256 = `sha256:${recordSha256(core)}`; return value; };
  assert.throws(() => validateWorkflowDraftSubmissionSnapshot(reseal(changedInputs)), { code: 'WCA_SUBMISSION_INVALID' });
  const changedFiles = structuredClone(snapshot); const changedBytes = Buffer.from('A different internally well-hashed candidate file.\n');
  Object.assign(changedFiles.files[0], { contentBase64: changedBytes.toString('base64'), bytes: changedBytes.length, sha256: `sha256:${sha256(changedBytes)}` });
  assert.throws(() => validateWorkflowDraftSubmissionSnapshot(reseal(changedFiles)), { code: 'WCA_SUBMISSION_INVALID' });
  const missingFile = structuredClone(snapshot); missingFile.files.pop();
  assert.throws(() => validateWorkflowDraftSubmissionSnapshot(reseal(missingFile)), { code: 'WCA_SUBMISSION_INVALID' });
  const nativeClaim = structuredClone(snapshot); nativeClaim.confirmation.authenticatedNativeHost = true;
  assert.throws(() => validateWorkflowDraftSubmissionSnapshot(reseal(nativeClaim)), { code: 'WCA_SUBMISSION_INVALID' });
  await assertApplicationsUnchanged(f);
});

test('reviewed literal candidate bytes cannot be silently transformed by approved Git attributes during proposal staging', { skip: TERMINAL_FIXTURE_UNAVAILABLE }, async (t) => {
  const f = await fixture(t, { attributes: '*.md text eol=lf\n', templateContent: '# Team note\r\n\r\n## Inputs\r\n\r\n## Findings\r\n' });
  assert.match(f.preview.assets.find((asset) => asset.path.endsWith('note-template.md')).content, /\r\n/u);
  const observed = await terminalSubmission(f);
  assert.equal(observed.ok, false, terminalFailure(observed));
  assert.equal(observed.error.code, 'CONFIGURATION_PROPOSAL_REVIEWED_FILES_CHANGED');
  assert.equal(remoteHeads(f), f.headsBefore); await assertApplicationsUnchanged(f);
});

test('submitted review snapshot remains retained after terminal-reviewed deletion of its shared source draft', { skip: TERMINAL_FIXTURE_UNAVAILABLE }, async (t) => {
  const f = await fixture(t); const observed = await terminalSubmission(f, { deleteAfterSubmission: true });
  assert.equal(observed.ok, true, terminalFailure(observed)); assert.ok(observed.deletedHead);
  const result = observed.result;
  assert.equal(git(f.base, '--git-dir', f.remote, 'rev-parse', `refs/heads/${result.branch}`), result.commit);
  const remoteSnapshot = JSON.parse(git(f.base, '--git-dir', f.remote, 'show', `${result.commit}:${result.snapshotPath}`));
  assert.deepEqual(validateWorkflowDraftSubmissionSnapshot(remoteSnapshot).inputs.request, f.request);
  assert.equal(remoteSnapshot.sourceDraft.lifecycle, 'live'); assert.equal(remoteSnapshot.sourceDraft.revision, 1);
  assert.equal(remoteSnapshot.sourceDraft.head, f.created.head);
  assert.equal(remoteSnapshot.snapshotSha256, result.snapshotSha256);
  assert.equal(git(f.first, 'rev-parse', `refs/singularity/transport/configuration-proposals/${result.commit}`), result.commit);
  const deleted = await f.stores[1].readRevision({ draftId: DRAFT_ID, revision: 1 });
  assert.equal(deleted.tombstone.status, 'deleted'); assert.deepEqual(deleted.payload, f.request);
  assert.equal((await f.stores[0].list()).drafts.length, 0);
  await assert.rejects(createWorkflowDraftReviewProposal(f.first, { draftId: DRAFT_ID, revision: 1, expectedPlanSha256: f.preview.planSha256, confirmation: randomUUID() }), { code: 'WCA_PREVIEW_STALE' });
  assert.equal(git(f.base, '--git-dir', f.remote, 'rev-parse', 'refs/heads/main'), f.commit);
  assert.equal(git(f.base, '--git-dir', f.remote, 'rev-parse', 'refs/heads/sflow/config'), f.commit);
  assert.equal(remoteHeads(f).split('\n').filter((line) => line.startsWith('refs/heads/sflow/config-change/')).length, 1);
  await assertApplicationsUnchanged(f);
});

test('live terminal consent cannot publish a stale draft, changed configuration, or deleted draft', { skip: TERMINAL_FIXTURE_UNAVAILABLE }, async (t) => {
  for (const mutation of ['draft', 'configuration', 'deleted']) await t.test(mutation, async (child) => {
    const f = await fixture(child); const result = await terminalSubmission(f, { mutation });
    assert.equal(result.ok, false, terminalFailure(result)); assert.ok(result.changedHead);
    assert.ok(['WCA_PREVIEW_STALE', 'WCA_DRAFT_DELETED', 'WCA_COMPILER_SOURCE_UNAVAILABLE', 'CONFIGURATION_PROPOSAL_AUTHORITY_CHANGED'].includes(result.error.code), JSON.stringify(result.error));
    assert.equal(remoteHeads(f).includes('refs/heads/sflow/config-change/'), false);
    assert.equal(git(f.base, '--git-dir', f.remote, 'rev-parse', 'refs/heads/main'), f.commit);
    await assertApplicationsUnchanged(f);
  });
});
