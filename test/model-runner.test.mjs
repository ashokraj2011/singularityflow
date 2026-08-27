import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { invokeModel, listModelInvocations } from '../src/model-runner.mjs';
import { withOperationContext } from '../src/operation-context.mjs';
import { listPromptAudits, setPromptAudit } from '../src/prompt-audit.mjs';
import { run } from '../src/util.mjs';

function request(root, overrides = {}) {
  const providerConfig = {
    executable: process.execPath, arguments: ['-e', 'process.stdout.write("ok")', '--'],
    promptTransport: 'attachment', ...(overrides.providerConfig ?? {})
  };
  return {
    provider: 'copilot-cli', providerConfig,
    cwd: root, allowedRoots: [root], auditRoot: root, channel: 'test', prompt: { text: 'test' },
    tools: { mode: 'none', names: [] }, limits: { timeoutMs: 1000, outputBytes: 1024 },
    ...overrides, providerConfig
  };
}

test('the model runner rejects calls without registered operation context', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-model-runner-'));
  await assert.rejects(() => invokeModel(request(root)), (error) => error.code === 'MODEL_CONTEXT_MISSING');
});

test('the model runner audits and cleans the exact staged attachment bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-model-attachment-'));
  run('git', ['init', '-q'], { cwd: root });
  await setPromptAudit(root, true);
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
  assert.equal(audit.schemaVersion, 5);
  assert.equal(audit.attestation.scheme, 'kernel-hmac-sha256-v1');
  assert.match(audit.generationNonce, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(audit.promptTransport, 'attachment');
  assert.equal(audit.promptProtocolVersion, null);
  assert.equal(audit.promptEncoding, 'utf-8');
  assert.equal(audit.promptBytes, Buffer.byteLength(prompt));
  assert.equal(audit.promptSha256, createHash('sha256').update(prompt).digest('hex'));
  assert.equal(audit.tokenAdmission.logicalPromptTokens.assurance, 'estimated');
  assert.equal(audit.tokenAdmission.safeToEnforce, false);
  assert.equal(audit.economics.prompt.finalPromptBytes, Buffer.byteLength(prompt));
  assert.equal(audit.economics.provider.inputTokens, null);
  assert.deepEqual(audit.promptLayout.omitted, []);
  assert.equal(audit.promptLayout.selected[0].sha256, audit.promptSha256);
  assert.equal(audit.promptLayout.selected[0].bytes, audit.promptBytes);
  assert.doesNotMatch(JSON.stringify(audit), /CGR_CANARY|_END/);
  const verified = await listModelInvocations(root, {
    subjectId: 'MODEL-1', phase: 'implementation', generationIntentId: 'intent-1', generation: 2
  });
  assert.equal(verified[0].observationIntegrity, 'machine-local-mac');
  audit.routing = { task: 'code', mappingRevision: 'test', resolvedModel: audit.model };
  await writeFile(path.join(auditDirectory, name), `${JSON.stringify(audit, null, 2)}\n`);
  const locallyEdited = await listModelInvocations(root, {
    subjectId: 'MODEL-1', phase: 'implementation', generationIntentId: 'intent-1',
    generation: 2, task: 'code', startedAfter: audit.startedAt
  });
  assert.equal(locallyEdited.length, 1);
  assert.equal(locallyEdited[0].observationIntegrity, 'unverified-local');
  assert.equal((await listModelInvocations(root, {
    subjectId: 'MODEL-1', phase: 'implementation', generationIntentId: 'another-intent',
    generation: 2, task: 'code'
  })).length, 0, 'an unrelated generation intent cannot claim the audit');
  const prompts = await listPromptAudits(root, { includePrompt: true });
  assert.equal(prompts.records.length, 1);
  assert.equal(prompts.records[0].source, 'model-invocation');
  assert.equal(prompts.records[0].prompt, prompt);
  assert.equal(prompts.records[0].execution.invocationId, result.invocationId);
  assert.equal(prompts.records[0].execution.tools.mode, 'none');
  assert.equal(prompts.records[0].execution.tools.observedCalls, null);
  assert.equal(prompts.records[0].execution.tokens.status, 'unavailable');
  assert.equal(prompts.records[0].execution.tokens.total, null, 'missing provider usage is never rendered as zero');
});

test('the model runner negotiates ACP and records the protocol without exposing prompt content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-model-acp-audit-'));
  run('git', ['init', '-q'], { cwd: root });
  const fixture = path.join(root, 'fake-acp.mjs');
  await writeFile(fixture, `
import readline from 'node:readline';
const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
const send=(v)=>process.stdout.write(JSON.stringify(v)+'\\n');
for await(const line of lines){const m=JSON.parse(line);
if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params.protocolVersion,agentCapabilities:{}}});
else if(m.method==='session/new')send({jsonrpc:'2.0',id:m.id,result:{sessionId:'audit-session',configOptions:[{type:'select',id:'model',name:'Model',category:'model',currentValue:'auto',options:[]}]}});
else if(m.method==='session/prompt'){const text=m.params.prompt[0].text;if(process.argv.includes('--fixture-fail'))send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'audit-session',update:{sessionUpdate:'tool_call',toolCallId:'failed-read',title:'read fixture',name:'view',kind:'read',status:'failed',rawOutput:{code:'NOT_FOUND'}}}});send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'audit-session',update:{sessionUpdate:'agent_message_chunk',messageId:'final',content:{type:'text',text:'  ok:'+text.length+'  \\n'}}}});send({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn',usage:{totalTokens:7,inputTokens:5,outputTokens:2}}});}}
`);
  const prompt = 'ACP_AUDIT_CANARY';
  const result = await withOperationContext({
    operation: { id: 'model.test', modelPolicy: 'required' }, modelMode: { enabled: true }, root, command: 'test'
  }, () => invokeModel(request(root, {
    providerConfig: {
      executable: process.execPath, arguments: [fixture], promptTransport: 'acp-stdio'
    },
    prompt: { text: prompt }
  })));
  assert.equal(result.output, `ok:${prompt.length}`);
  assert.equal(result.promptTransport, 'acp-stdio');
  assert.equal(result.promptProtocolVersion, 1);
  const [audit] = await listModelInvocations(root);
  assert.equal(audit.schemaVersion, 5);
  assert.equal(audit.promptTransport, 'acp-stdio');
  assert.equal(audit.promptProtocolVersion, 1);
  assert.equal(audit.usage.totalTokens, 7);
  assert.equal(audit.model, 'auto');
  assert.equal(audit.requestedModel, 'auto');
  assert.deepEqual(audit.modelSelection, {
    policy: 'provider-auto', requestedModel: 'auto', providerSelectedModel: 'auto',
    resolvedModels: [], assurance: 'unavailable'
  });
  assert.equal(audit.outputBytes, Buffer.byteLength(result.output));
  assert.equal(audit.toolObservation.totalCalls, 0);
  assert.doesNotMatch(JSON.stringify(audit), /ACP_AUDIT_CANARY/);

  await assert.rejects(() => withOperationContext({
    operation: { id: 'model.test', modelPolicy: 'required' }, modelMode: { enabled: true }, root, command: 'test'
  }, () => invokeModel(request(root, {
    providerConfig: {
      executable: process.execPath, arguments: [fixture, '--fixture-fail'], promptTransport: 'acp-stdio'
    },
    prompt: { text: 'FAILED_ACP_AUDIT_CANARY' },
    tools: { mode: 'allowlist', names: ['read_file'], requireSuccessful: true, rejectTruncated: true }
  }))), (error) => error.code === 'MODEL_TOOL_EXECUTION_FAILED');
  const auditDirectory = path.join(root, '.git', 'singularity-flow', 'model-invocations');
  const failedAudits = await Promise.all((await readdir(auditDirectory)).map(async (name) =>
    JSON.parse(await readFile(path.join(auditDirectory, name), 'utf8'))));
  const failed = failedAudits.find((entry) => entry.status === 'failed');
  assert.equal(failed.promptProtocolVersion, 1);
  assert.equal(failed.usage.totalTokens, 7);
  assert.equal(failed.toolObservation.failedCalls, 1);
  assert.equal(failed.economics.provider.totalTokens, 7);
  assert.doesNotMatch(JSON.stringify(failed), /FAILED_ACP_AUDIT_CANARY|NOT_FOUND/);
});

test('unknown providers fail before audit creation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-model-provider-'));
  await assert.rejects(() => withOperationContext({
    operation: { id: 'model.test', modelPolicy: 'required' }, modelMode: { enabled: true }, root, command: 'test'
  }, () => invokeModel(request(root, { provider: 'unknown-provider', providerConfig: undefined }))), (error) => error.code === 'MODEL_PROVIDER_UNKNOWN');
  await assert.rejects(access(path.join(root, '.git', 'singularity-flow', 'model-invocations')));
});

test('task routing uses the reviewed fallback when the preferred model is unavailable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-model-fallback-'));
  run('git', ['init', '-q'], { cwd: root });
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'modelTiers.yml'), [
    'modelTiers:',
    '  relay:',
    '    model: relay-model',
    '  reason:',
    '    model: retired-model',
    '    fallback: [working-model]',
    '  clarify: relay',
    '  summarize: relay',
    '  code: reason',
    '  analyze: reason',
    ''
  ].join('\n'));
  const script = [
    'const argv=process.argv.slice(1)',
    'const model=argv[argv.indexOf("--model")+1]',
    'if(model==="retired-model"){process.stderr.write(\'Error: Model "retired-model" from --model flag is not available.\');process.exit(1)}',
    'process.stdout.write(`ok:${model}`)'
  ].join(';');
  const result = await withOperationContext({
    operation: { id: 'model.test', modelPolicy: 'required' }, modelMode: { enabled: true }, root, command: 'test'
  }, () => invokeModel(request(root, {
    task: 'analyze',
    providerConfig: { executable: process.execPath, arguments: ['-e', script, '--'] }
  })));

  assert.equal(result.output, 'ok:working-model');
  assert.equal(result.model, 'working-model');
  assert.equal(result.invocation.model, 'working-model');
  assert.equal(result.routing.resolvedModel, 'working-model');
  assert.deepEqual(result.routing.available, ['retired-model', 'working-model']);
  assert.deepEqual(result.routing.fallbackHops, ['retired-model']);
  const [audit] = await listModelInvocations(root, { task: 'analyze' });
  assert.equal(audit.model, 'working-model');
  assert.equal(audit.routing.resolvedModel, 'working-model');
  assert.deepEqual(audit.routing.fallbackHops, ['retired-model']);
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

test('the universal model boundary refuses unsafe enforcement before provider execution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-model-admission-'));
  run('git', ['init', '-q'], { cwd: root });
  await setPromptAudit(root, true);
  await assert.rejects(() => withOperationContext({
    operation: { id: 'model.test', modelPolicy: 'required' }, modelMode: { enabled: true }, root, command: 'test'
  }, () => invokeModel(request(root, {
    tokenAdmission: { mode: 'enforce', maximumInputTokens: 1000 }
  }))), (error) => error.code === 'TKN_ADMISSION_ASSURANCE_INSUFFICIENT');
  const auditDirectory = path.join(root, '.git', 'singularity-flow', 'model-invocations');
  const [name] = await readdir(auditDirectory);
  const audit = JSON.parse(await readFile(path.join(auditDirectory, name), 'utf8'));
  assert.equal(audit.status, 'failed');
  assert.equal(audit.error.code, 'TKN_ADMISSION_ASSURANCE_INSUFFICIENT');
  assert.equal(audit.tokenAdmission.admitted, null);
  const captured = await listPromptAudits(root, { includePrompt: true });
  assert.equal(captured.records.length, 1, 'the exact prompt is captured before the refused provider boundary');
  assert.equal(captured.records[0].execution.status, 'failed');
});
