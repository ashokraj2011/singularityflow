import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { invokeModel, listModelInvocations } from '../src/model-runner.mjs';
import { withOperationContext } from '../src/operation-context.mjs';
import { run } from '../src/util.mjs';

function request(root, overrides = {}) {
  return {
    provider: 'copilot-cli', providerConfig: { executable: process.execPath, arguments: ['-e', 'process.stdout.write("ok")', '--'] },
    cwd: root, allowedRoots: [root], auditRoot: root, channel: 'test', prompt: { text: 'test' },
    tools: { mode: 'none', names: [] }, limits: { timeoutMs: 1000, outputBytes: 1024 }, ...overrides
  };
}

test('the model runner rejects calls without registered operation context', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-model-runner-'));
  await assert.rejects(() => invokeModel(request(root)), (error) => error.code === 'MODEL_CONTEXT_MISSING');
});

test('the model runner audits and cleans the exact staged attachment bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-model-attachment-'));
  run('git', ['init', '-q'], { cwd: root });
  const prompt = `CGR_CANARY_${'x'.repeat(200 * 1024)}_END`;
  const script = 'const fs=require("node:fs"),a=process.argv.slice(1),f=a[a.indexOf("--attachment")+1],b=fs.readFileSync(f);process.stdout.write(JSON.stringify({file:f,bytes:b.length,body:b.toString("utf8")}))';
  const result = await withOperationContext({
    operation: { id: 'model.test', modelPolicy: 'required' }, modelMode: { enabled: true }, root, command: 'test'
  }, () => invokeModel(request(root, {
    providerConfig: { executable: process.execPath, arguments: ['-e', script, '--'] },
    prompt: { text: prompt }, limits: { timeoutMs: 5000, outputBytes: 512 * 1024 },
    subject: { kind: 'story', id: 'MODEL-1', phase: 'implementation', generationIntentId: 'intent-1', generation: 2 }
  })));
  const provider = JSON.parse(result.output);
  assert.equal(provider.body, prompt);
  await assert.rejects(access(provider.file));
  const auditDirectory = path.join(root, '.git', 'singularity-flow', 'model-invocations');
  const [name] = await readdir(auditDirectory);
  const audit = JSON.parse(await readFile(path.join(auditDirectory, name), 'utf8'));
  assert.equal(audit.schemaVersion, 2);
  assert.equal(audit.promptTransport, 'attachment');
  assert.equal(audit.promptEncoding, 'utf-8');
  assert.equal(audit.promptBytes, Buffer.byteLength(prompt));
  assert.equal(audit.promptSha256, createHash('sha256').update(prompt).digest('hex'));
  assert.doesNotMatch(JSON.stringify(audit), /CGR_CANARY|_END/);
  audit.routing = { task: 'code', mappingRevision: 'test', resolvedModel: audit.model };
  await writeFile(path.join(auditDirectory, name), `${JSON.stringify(audit, null, 2)}\n`);
  assert.equal((await listModelInvocations(root, {
    subjectId: 'MODEL-1', phase: 'implementation', generationIntentId: 'intent-1',
    generation: 2, task: 'code', startedAfter: audit.startedAt
  })).length, 1);
  assert.equal((await listModelInvocations(root, {
    subjectId: 'MODEL-1', phase: 'implementation', generationIntentId: 'another-intent',
    generation: 2, task: 'code'
  })).length, 0, 'an unrelated generation intent cannot claim the audit');
});

test('unknown providers fail before audit creation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-model-provider-'));
  await assert.rejects(() => withOperationContext({
    operation: { id: 'model.test', modelPolicy: 'required' }, modelMode: { enabled: true }, root, command: 'test'
  }, () => invokeModel(request(root, { provider: 'unknown-provider', providerConfig: undefined }))), (error) => error.code === 'MODEL_PROVIDER_UNKNOWN');
  await assert.rejects(access(path.join(root, '.git', 'singularity-flow', 'model-invocations')));
});

test('an invocation cannot redirect its audit record outside the trusted operation root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-model-root-'));
  const other = await mkdtemp(path.join(os.tmpdir(), 'sflow-model-other-'));
  await assert.rejects(() => withOperationContext({
    operation: { id: 'model.test', modelPolicy: 'required' }, modelMode: { enabled: true }, root, command: 'test'
  }, () => invokeModel(request(root, { auditRoot: other }))), (error) => error.code === 'MODEL_AUDIT_ROOT_INVALID');
});

test('an allowlist tool policy must name at least one tool', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-model-tools-'));
  await assert.rejects(() => withOperationContext({
    operation: { id: 'model.test', modelPolicy: 'required' }, modelMode: { enabled: true }, root, command: 'test'
  }, () => invokeModel(request(root, {
    tools: { mode: 'allowlist', names: [] }
  }))), (error) => error.code === 'MODEL_REQUEST_INVALID' && /must not be empty/.test(error.message));
});
