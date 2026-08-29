/** Model-free CLI for the first deterministic SGOS compiler/runtime profile. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { branch, head, identity, repoRoot } from '../git.mjs';
import { canonicalJson } from '../records.mjs';
import {
  createIntentEnvelope, sha256, validateGvmProgram, validateSgosRecord
} from '../sgos/contracts.mjs';
import {
  compileSgosProgram, explainSgosProgram, simulateSgosProgram
} from '../sgos/compiler.mjs';
import { sgosSha256 } from '../sgos/evidence.mjs';
import { compareSgosCodePoints } from '../sgos/order.mjs';
import { projectSgosWorkObjects } from '../sgos/projection.mjs';
import {
  listSgosProcesses, pauseSgosProcess, readSgosProcess, respondToSgosHumanRequest,
  resumeSgosProcess, runNextSgosTask, startSgosProcess
} from '../sgos/runtime.mjs';
import {
  readSgosImmutableRecord, readSgosProgram
} from '../sgos/store.mjs';
import {
  SingularityFlowError, nowIso, optionBoolean, optionString, secureRepositoryPath, writeAtomic
} from '../util.mjs';
import {
  commandResult, effects, noEffects, succeeded
} from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
const DECISIONS = new Set(['approved', 'rejected', 'selected', 'provided', 'cancelled']);

function fail(message, code, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

const MUTATION_OPERATIONS = new Set([
  'intent.capture', 'intent.compile',
  'process.start', 'process.step', 'process.pause', 'process.resume', 'process.recover',
  'request.respond'
]);

async function exactRepositoryPath(root, value, label, { mustExist = true } = {}) {
  if (!value) fail(`${label} is required.`, 'SGOS_FILE_REQUIRED', { label });
  let secured;
  try {
    secured = await secureRepositoryPath(root, String(value), {
      label,
      mustExist,
      type: 'file'
    });
  } catch (error) {
    if (error?.code === 'REPOSITORY_PATH_UNSAFE') throw error;
    if (mustExist && /does not exist/.test(String(error?.message ?? ''))) {
      fail(`${label} was not found inside the selected repository.`, 'SGOS_FILE_NOT_FOUND', {
        label, received: String(value)
      });
    }
    throw error;
  }
  if (secured.relative === '.') {
    fail(`${label} must name a file inside the selected repository.`, 'SGOS_FILE_OUTSIDE_REPOSITORY', {
      label, received: String(value)
    });
  }
  return secured.absolute;
}

async function jsonFile(root, value, label) {
  const file = await exactRepositoryPath(root, value, label);
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('top-level value is not an object');
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`${label} was not found at ${file}.`, 'SGOS_FILE_NOT_FOUND', { file });
    if (error instanceof SyntaxError || error?.message === 'top-level value is not an object') {
      fail(`${label} is not a JSON object: ${error.message}.`, 'SGOS_FILE_INVALID', { file });
    }
    throw error;
  }
}

async function emit(value, options, text, {
  operation,
  changed = false,
  allowOutput = false
} = {}) {
  if (!operation) fail('SGOS narration requires an operation ID.', 'SGOS_OPERATION_REQUIRED');
  const output = optionString(options, 'out');
  if (output && !allowOutput) {
    fail(`--out is not supported by ${operation}; it is available only for intent capture and intent compile.`,
      'SGOS_OUTPUT_NOT_SUPPORTED', { operation });
  }
  let relativeOutput = null;
  if (output) {
    const root = repoRoot();
    const file = await exactRepositoryPath(root, output, '--out', { mustExist: false });
    await writeAtomic(file, canonicalJson(value));
    relativeOutput = path.relative(root, file).split(path.sep).join('/');
  }
  const summary = typeof text === 'function' ? text(value) : text;
  const declared = {
    stateChanged: Boolean(changed),
    filesChanged: Boolean(changed || relativeOutput),
    publicationCreated: false,
    externalSystemsChanged: false
  };
  return emitCommandResult(commandResult({
    operation: {
      id: operation,
      classification: MUTATION_OPERATIONS.has(operation) ? 'mutation' : 'read'
    },
    outcome: succeeded('sgos.reported', { summary }),
    effects: Object.values(declared).some(Boolean) ? effects(declared) : noEffects(),
    restState: 'informational',
    data: {
      result: value,
      ...(relativeOutput ? { output: relativeOutput } : {})
    }
  }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
}

function actorFor(root) {
  const current = identity(root, { offline: true });
  const id = current.email ?? current.login ?? current.name;
  return {
    kind: 'human', id, name: current.name, email: current.email
  };
}

function processSummary(process) {
  const counts = Object.values(process.taskInstances ?? {}).reduce((result, task) => {
    result[task.state] = (result[task.state] ?? 0) + 1;
    return result;
  }, {});
  return `${process.processId} · ${process.status} · revision ${process.processRevision}`
    + ` · ${Object.entries(counts).sort().map(([state, count]) => `${state} ${count}`).join(', ')}`;
}

async function openRequests(root, process) {
  const requests = [];
  for (const reference of process.openHumanRequests ?? []) {
    requests.push((await readSgosImmutableRecord(root, process.processId, 'human-request', reference)).record);
  }
  return requests.sort((left, right) => compareSgosCodePoints(left.requestId, right.requestId));
}

async function findRequest(root, requestId, requestedProcessId = null) {
  const processes = requestedProcessId ? [await readSgosProcess(root, requestedProcessId)] : await listSgosProcesses(root);
  for (const process of processes) {
    const requests = await openRequests(root, process);
    const request = requests.find((entry) => entry.requestId === requestId);
    if (request) return { process, request };
  }
  fail(`Open Human Request '${requestId}' was not found.`, 'SGOS_HUMAN_REQUEST_NOT_FOUND', { requestId });
}

async function intentCommand(root, positionals, options) {
  const action = positionals[1] ?? 'show';
  if (action === 'capture') {
    const text = positionals.slice(2).join(' ').trim();
    if (!text) fail('intent capture requires non-empty text.', 'SGOS_INTENT_TEXT_REQUIRED');
    const principal = actorFor(root);
    const rawSha256 = sha256(text);
    const record = createIntentEnvelope({
      generation: 1,
      principal: { kind: principal.kind, id: principal.id, name: principal.name, email: principal.email },
      source: { kind: 'natural-language', revision: null },
      rawRef: `inline:${rawSha256}`,
      rawSha256,
      attachments: [],
      capturedAt: nowIso()
    });
    return emit(record, options,
      (value) => `Captured ${value.intentId} at ${value.envelopeSha256}. No Program was executed.`,
      { operation: 'intent.capture', allowOutput: true });
  }
  if (action === 'show' || action === 'validate') {
    const record = await jsonFile(root, positionals[2], 'SGOS record');
    const validated = validateSgosRecord(record);
    const result = action === 'show' ? validated : {
      valid: true, kind: validated.kind, schemaVersion: validated.schemaVersion,
      sha256: Object.entries(validated).find(([key, value]) => key.endsWith('Sha256') && HASH.test(value))?.[1] ?? null
    };
    return emit(result, options, action === 'show'
      ? (value) => `${value.kind} ${value.intentId ?? ''}`.trim()
      : (value) => `Valid ${value.kind} schema v${value.schemaVersion}.`,
    { operation: `intent.${action}` });
  }
  if (action === 'compile') {
    const intentIr = await jsonFile(root, positionals[2], 'Intent IR');
    const workflow = await jsonFile(root, optionString(options, 'workflow'), '--workflow');
    const ratification = await jsonFile(root, optionString(options, 'ratification'), '--ratification');
    const policy = await jsonFile(root, optionString(options, 'policy'), '--policy');
    const registrySnapshot = await jsonFile(root, optionString(options, 'registry'), '--registry');
    validateSgosRecord(policy);
    const compiled = compileSgosProgram({
      intentIr,
      workflow,
      ratification,
      policySnapshotSha256: policy.snapshotSha256,
      registrySnapshotSha256: ratification.registrySnapshotSha256,
      registrySnapshot,
      storageProfileSha256: ratification.storageProfileSha256
    });
    return emit(compiled.program, options, (program) =>
      `Compiled ${program.programId} at ${program.programSha256} (${program.taskTemplates.length} finite tasks).`,
    { operation: 'intent.compile', allowOutput: true });
  }
  fail(`Unknown intent action '${action}'.`, 'UNKNOWN_SUBCOMMAND');
}

async function programCommand(root, positionals, options) {
  const action = positionals[1] ?? 'show';
  const program = await jsonFile(root, positionals[2], 'GVM Program');
  if (action === 'show') {
    validateGvmProgram(program);
    return emit(program, options, (value) =>
      `${value.programId} · ${value.taskTemplates.length} tasks · ${value.programSha256}`,
    { operation: 'program.show' });
  }
  if (action === 'validate') {
    validateGvmProgram(program);
    return emit({ valid: true, programId: program.programId, programSha256: program.programSha256 }, options,
      (value) => `Valid finite Program ${value.programId} at ${value.programSha256}.`,
      { operation: 'program.validate' });
  }
  if (action === 'explain') return emit(explainSgosProgram(program), options, (value) =>
    `${value.programId}: ${value.graph.taskCount} tasks; deterministic=${value.deterministic}.`,
  { operation: 'program.explain' });
  if (action === 'simulate') return emit(simulateSgosProgram(program), options, (value) =>
    `${value.programId}: ${value.waves.length} deterministic wave(s), width ${value.maximumReadyWidth}; nothing executed.`,
  { operation: 'program.simulate' });
  fail(`Unknown program action '${action}'.`, 'UNKNOWN_SUBCOMMAND');
}

async function processCommand(root, positionals, options) {
  const action = positionals[1] ?? 'status';
  if (action === 'start') {
    const program = await jsonFile(root, positionals[2], 'GVM Program');
    validateGvmProgram(program);
    const bindingFile = optionString(options, 'binding');
    const processBinding = bindingFile ? await jsonFile(root, bindingFile, '--binding') : null;
    if (processBinding) validateSgosRecord(processBinding);
    const subjectId = optionString(options, 'subject', program.programId);
    const result = await startSgosProcess(root, {
      program,
      processBinding,
      processId: optionString(options, 'process-id'),
      taskContractSha256: sgosSha256({
        kind: 'gvm-task-contract-set', programSha256: program.programSha256,
        policySnapshotSha256: program.policySnapshotSha256,
        taskTemplateSha256: program.taskTemplates.map((task) => task.taskTemplateSha256).sort()
      }),
      subject: {
        kind: optionString(options, 'subject-kind', 'repository'), id: subjectId,
        branch: branch(root), baselineRevision: head(root)
      }
    });
    return emit(result, options,
      (value) => `${processSummary(value.process)} · checkpoint ${value.checkpoint.checkpointSha256}`,
      { operation: 'process.start', changed: result.created });
  }
  const processId = positionals[2];
  if (!processId) fail(`process ${action} requires a Process ID.`, 'SGOS_PROCESS_ID_REQUIRED');
  if (action === 'status') {
    const process = await readSgosProcess(root, processId);
    const requests = await openRequests(root, process);
    return emit({ process, workObjects: projectSgosWorkObjects(process, { humanRequests: requests }) }, options,
      (value) => processSummary(value.process), { operation: 'process.status' });
  }
  if (action === 'graph') {
    const process = await readSgosProcess(root, processId);
    const program = (await readSgosProgram(root, processId, process.programSha256)).record;
    const tasks = Object.values(process.taskInstances).sort((a, b) => compareSgosCodePoints(a.taskTemplateId, b.taskTemplateId));
    return emit({ processId, programId: program.programId, tasks, edges: program.edges }, options,
      (value) => value.tasks.map((task) => `${task.taskTemplateId.padEnd(24)} ${task.state}`).join('\n'),
      { operation: 'process.graph' });
  }
  if (action === 'step') {
    const result = await runNextSgosTask(root, processId);
    return emit(result, options, (value) => value.taskInstanceId
      ? `${value.taskInstanceId}: ${value.status}. ${processSummary(value.process)}`
      : `No task dispatched. ${processSummary(value.process)}`,
    { operation: 'process.step', changed: Boolean(result.taskInstanceId) });
  }
  if (action === 'pause') {
    const value = await pauseSgosProcess(root, processId, {});
    return emit(value, options, processSummary, { operation: 'process.pause', changed: true });
  }
  if (action === 'resume') {
    const checkpointSha256 = optionString(options, 'confirm');
    if (!HASH.test(String(checkpointSha256 ?? ''))) fail('process resume requires --confirm <CHECKPOINT-SHA256>.', 'SGOS_CHECKPOINT_CONFIRMATION_REQUIRED');
    const value = await resumeSgosProcess(root, processId, { checkpointSha256 });
    return emit(value, options, processSummary, { operation: 'process.resume', changed: true });
  }
  if (action === 'recover') {
    const process = await readSgosProcess(root, processId);
    const result = {
      processId, status: process.status, processRevision: process.processRevision,
      checkpointSha256: process.currentCheckpointSha256,
      recoverable: process.status === 'paused' && process.activeExecutions.length === 0,
      next: process.status === 'paused'
        ? `singularity-flow process resume ${processId} --confirm ${process.currentCheckpointSha256}`
        : process.status === 'recovery-required'
          ? 'A typed execution reconciler is required; no external effect will be retried automatically.'
          : `singularity-flow process status ${processId}`
    };
    return emit(result, options, (value) => `${value.status}. ${value.next}`,
      { operation: 'process.recover' });
  }
  fail(`Unknown process action '${action}'.`, 'UNKNOWN_SUBCOMMAND');
}

async function taskCommand(root, positionals, options) {
  const action = positionals[1] ?? 'list';
  const processId = positionals[2];
  if (!processId) fail(`task ${action} requires a Process ID.`, 'SGOS_PROCESS_ID_REQUIRED');
  const process = await readSgosProcess(root, processId);
  const tasks = Object.values(process.taskInstances).sort((a, b) => compareSgosCodePoints(a.taskTemplateId, b.taskTemplateId));
  if (action === 'list') return emit({ processId, tasks }, options,
    (value) => value.tasks.map((task) => `${task.taskTemplateId.padEnd(24)} ${task.state}`).join('\n'),
  { operation: 'task.list' });
  const requested = positionals[3];
  const task = tasks.find((entry) => entry.taskInstanceId === requested || entry.taskTemplateId === requested);
  if (!task) fail(`Task '${requested}' was not found in ${processId}.`, 'SGOS_TASK_NOT_FOUND');
  if (action === 'show') return emit({ processId, task }, options,
    (value) => `${value.task.taskTemplateId} · ${value.task.state} · revision ${value.task.revision}`,
  { operation: 'task.show' });
  if (action === 'evidence') {
    if (!task.receiptSha256) return emit({ processId, task, status: 'unavailable', reason: 'task-has-no-receipt' }, options,
      () => `${task.taskTemplateId} has no immutable receipt yet.`, { operation: 'task.evidence' });
    const receipt = (await readSgosImmutableRecord(root, processId, 'gvm-task-receipt', task.receiptSha256)).record;
    const evidence = [];
    for (const reference of receipt.evidenceRefs ?? []) {
      if (HASH.test(String(reference))) {
        try { evidence.push((await readSgosImmutableRecord(root, processId, 'action-evidence', reference)).record); } catch { /* Preserve the missing reference in the receipt. */ }
      }
    }
    return emit({ processId, task, receipt, evidence }, options,
      (value) => `${task.taskTemplateId}: verification ${value.receipt.verification.status}; evidence ${value.evidence.length}/${value.receipt.evidenceRefs.length}.`,
    { operation: 'task.evidence' });
  }
  fail(`Unknown task action '${action}'.`, 'UNKNOWN_SUBCOMMAND');
}

async function requestCommand(root, positionals, options) {
  const action = positionals[1] ?? 'list';
  if (action === 'list') {
    const processId = positionals[2] ?? optionString(options, 'process');
    const processes = processId ? [await readSgosProcess(root, processId)] : await listSgosProcesses(root);
    const requests = [];
    for (const process of processes) requests.push(...await openRequests(root, process));
    return emit({ requests }, options, (value) => value.requests.length
      ? value.requests.map((request) => `${request.requestId}  ${request.requestType}  ${request.prompt?.title ?? ''}`).join('\n')
      : 'No open SGOS Human Requests.', { operation: 'request.list' });
  }
  const requestId = positionals[2];
  if (!requestId) fail(`request ${action} requires a Request ID.`, 'SGOS_HUMAN_REQUEST_ID_REQUIRED');
  const found = await findRequest(root, requestId, optionString(options, 'process'));
  if (action === 'show') return emit(found, options,
    (value) => `${value.request.requestId} · ${value.request.requestType} · ${value.request.prompt?.title ?? ''}`,
  { operation: 'request.show' });
  if (action === 'respond') {
    if (Object.hasOwn(options, 'authority')) {
      fail('--authority cannot grant response authority. Authority must come from the trusted process binding.',
        'SGOS_AUTHORITY_SELF_CLAIM_REFUSED');
    }
    const option = optionString(options, 'option');
    const confirmation = optionString(options, 'confirm');
    if (!option) fail('request respond requires --option.', 'SGOS_HUMAN_RESPONSE_OPTION_REQUIRED');
    if (confirmation !== found.request.requestSha256) {
      fail(`Response confirmation must equal ${found.request.requestSha256}.`, 'SGOS_HUMAN_REQUEST_STALE');
    }
    const decision = DECISIONS.has(option) ? option : 'selected';
    const input = decision === 'selected' ? { option } : null;
    const result = await respondToSgosHumanRequest(root, found.process.processId, {
      requestId,
      requestSha256: confirmation,
      expectedRevision: found.process.processRevision,
      actor: actorFor(root),
      decision,
      input
    });
    return emit(result, options, (value) =>
      `Recorded ${value.response.decision} for ${value.request.requestId}. ${processSummary(value.process)}`,
    { operation: 'request.respond', changed: true });
  }
  fail(`Unknown request action '${action}'.`, 'UNKNOWN_SUBCOMMAND');
}

export async function run(_argv, { positionals, options }) {
  const root = repoRoot();
  const command = positionals[0];
  if (command === 'intent') return intentCommand(root, positionals, options);
  if (command === 'program') return programCommand(root, positionals, options);
  if (command === 'process') return processCommand(root, positionals, options);
  if (command === 'task') return taskCommand(root, positionals, options);
  if (command === 'request') return requestCommand(root, positionals, options);
  fail(`Unknown SGOS command '${command}'.`, 'UNKNOWN_COMMAND');
}
