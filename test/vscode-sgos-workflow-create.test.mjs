import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  sgosRatificationPreviewArguments, sgosTerminalCommand, sgosWorkflowCreateArguments,
  sgosWorkflowCreateReview, sgosWorkflowOutputPaths, sgosWorkspaceBindingIssue,
  validSgosDraftPath
} = await import(path.join(root, 'apps', 'vscode', 'src', 'sgos-workflow-create-model.ts'));

const sha = `sha256:${'a'.repeat(64)}`;

function selection() {
  return {
    intentPath: 'reviewed/intent-ir.json',
    policyPath: 'reviewed/policy.json',
    registryPath: 'reviewed/registry.json',
    id: 'verified-report',
    title: 'Verified report',
    operation: 'sflow.story.inspect',
    verificationOperation: 'sflow.story.inspect.verify',
    storageProfileSha256: sha,
    maximumAttempts: 1,
    outputRef: 'artifact:result',
    ...sgosWorkflowOutputPaths('verified-report')
  };
}

test('native SGOS creator builds the exact deterministic CLI request', () => {
  assert.deepEqual(sgosWorkflowCreateArguments(selection()), [
    'intent', 'workflow-create', 'reviewed/intent-ir.json',
    '--policy', 'reviewed/policy.json',
    '--registry', 'reviewed/registry.json',
    '--storage-profile-sha256', sha,
    '--id', 'verified-report',
    '--operation', 'sflow.story.inspect',
    '--verification-operation', 'sflow.story.inspect.verify',
    '--maximum-attempts', '1',
    '--output-ref', 'artifact:result',
    '--declaration-out', 'singularity/sgos-drafts/verified-report/workflow-declaration.json',
    '--out', 'singularity/sgos-drafts/verified-report/workflow-ir.json',
    '--title', 'Verified report', '--json'
  ]);
});

test('native SGOS creator refuses malformed IDs and storage authority before CLI execution', () => {
  assert.throws(() => sgosWorkflowOutputPaths('Verified Report'), /lower-case kebab case/);
  assert.throws(() => sgosWorkflowCreateArguments({
    ...selection(), storageProfileSha256: 'a'.repeat(64)
  }), /exact SHA-256/);
  assert.equal(validSgosDraftPath('singularity/sgos-drafts/example/workflow-ir.json'), true);
  assert.equal(validSgosDraftPath('singularity/sgos-drafts/nested/.git/workflow-ir.json'), false);
  assert.equal(validSgosDraftPath('singularity/templates/workflow-ir.json'), false);
});

test('native SGOS review explicitly stops before ratification or execution', () => {
  const review = sgosWorkflowCreateReview(selection());
  assert.match(review, /Operation: sflow\.story\.inspect/);
  assert.match(review, /Independent verifier: sflow\.story\.inspect\.verify/);
  assert.match(review, /Exact command:/);
  assert.match(review, /does not ratify, compile, approve, or run/);
});

test('ratification preview preserves argv boundaries and an explicit repository cwd', () => {
  const args = sgosRatificationPreviewArguments({
    ...selection(), intentPath: "reviewed/product owner's intent.json"
  });
  assert.deepEqual(args.slice(0, 3), [
    'intent', 'ratification-packet', "reviewed/product owner's intent.json"
  ]);
  const posix = sgosTerminalCommand(args, '/tmp/repository with space', 'posix');
  assert.match(posix, /^cd '\/tmp\/repository with space' && singularity-flow intent ratification-packet /);
  assert.match(posix, /'reviewed\/product owner'\\''s intent\.json'/);
  const powerShell = sgosTerminalCommand(args, "C:\\work\\owner's repo", 'powershell');
  assert.match(powerShell, /^Set-Location -LiteralPath 'C:\\work\\owner''s repo'; & 'singularity-flow' 'intent' 'ratification-packet' /);
  const bundled = sgosTerminalCommand(
    args, '/work/repo', 'posix', ['/Applications/Code Helper', '/extension/bin/singularity-flow.mjs'], true
  );
  assert.match(bundled, /^cd \/work\/repo && ELECTRON_RUN_AS_NODE=1 '\/Applications\/Code Helper' \/extension\/bin\/singularity-flow\.mjs intent ratification-packet /);
});

test('native SGOS creator refuses stale and unready workspace bindings', () => {
  const repository = '/work/repository';
  assert.equal(sgosWorkspaceBindingIssue({
    active: true, repositoryPath: repository, repositoryState: 'ready', selectionStatus: 'ready'
  }, repository), null);
  assert.match(sgosWorkspaceBindingIssue({ active: false }, repository), /No Singularity Flow workspace/);
  assert.match(sgosWorkspaceBindingIssue({
    active: true, repositoryPath: repository, repositoryState: 'missing'
  }, repository), /not ready/);
  assert.match(sgosWorkspaceBindingIssue({
    active: true, repositoryPath: '/work/stale', selectionStatus: 'ready'
  }, repository), /active workspace changed/i);
});

test('Command Center exposes the SGOS creator as an explicit user action', async () => {
  const page = await readFile(path.join(
    root, 'apps', 'vscode', 'src', 'views', 'sgos-command-center-page.ts'
  ), 'utf8');
  assert.match(page, /data-create-workflow/);
  assert.match(page, /type:'createWorkflow'/);
});
