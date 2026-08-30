/** Model-free CLI for the first deterministic SGOS compiler/runtime profile. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { branch, head, identity, repoRoot } from '../git.mjs';
import { canonicalJson } from '../records.mjs';
import {
  cloneSgosValue, createIntentEnvelope, sha256, validateGvmProgram, validateSgosRecord
} from '../sgos/contracts.mjs';
import {
  compileSgosProgram, compileSgosProgramWithApprovedCapabilityPack,
  explainSgosProgram, simulateSgosProgram
} from '../sgos/compiler.mjs';
import {
  planSgosProgramFault, whatIfSgosProgram
} from '../sgos/simulation.mjs';
import { workflowCapabilityPackSelector } from '../sgos/capability-pack-authority.mjs';
import { loadSgosCommandCenter } from '../sgos/command-center.mjs';
import { sgosSha256 } from '../sgos/evidence.mjs';
import {
  forkSgosProcess, planSgosProcessFork, planSgosProcessReplay, replaySgosProcess
} from '../sgos/lineage.mjs';
import { compareSgosCodePoints } from '../sgos/order.mjs';
import {
  planSgosTaskRetry, retrySgosTaskWithInstalledAdapters
} from '../sgos/retry.mjs';
import { projectSgosWorkObjects } from '../sgos/projection.mjs';
import {
  listSgosProcesses, pauseSgosProcess, planSgosProcessRecovery, readSgosProcess,
  recoverInterruptedSgosExecution, respondToSgosHumanRequest, resumeSgosProcess,
  startSgosProcess, stepSgosProcess, stopSgosProcess
} from '../sgos/runtime.mjs';
import { runSgosProcess } from '../sgos/public-runtime.mjs';
import { SGOS_INSTALLED_LIMITS } from '../sgos/limits.mjs';
import { validateSgosCliOptions } from '../sgos/cli-options.mjs';
import {
  runSgosIntentAuthoring, runSgosProgramAuthoring
} from './sgos-authoring.mjs';
import {
  fsckSgosProcess, planSgosProcessQuarantine, quarantineSgosProcess,
  readSgosImmutableRecord, readSgosProgram
} from '../sgos/store.mjs';
import {
  SingularityFlowError, nowIso, optionBoolean, optionNumber, optionString,
  secureRepositoryPath, writeAtomic
} from '../util.mjs';
import {
  commandResult, effects, noEffects, succeeded
} from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
const DECISIONS = new Set(['approved', 'rejected', 'selected', 'provided', 'cancelled']);
const MAX_HUMAN_INPUT_BYTES = 64 * 1024;

function fail(message, code, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function expectedProcessRevision(options) {
  const expectedRevision = optionNumber(options, 'expected-revision');
  if (expectedRevision != null
      && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) {
    fail('--expected-revision must be a positive safe integer.',
      'SGOS_PROCESS_REVISION_INVALID');
  }
  return expectedRevision;
}

/**
 * `intent compile` emits a bare Program for built-in core and an authority-bearing compiler result
 * for a signed Capability Pack. Every Program consumer accepts either representation; approval is
 * the one ceremony that deliberately receives the complete compiler result so it can bind the Pack
 * authority bytes.
 */
function validatedProgramInput(value) {
  const program = value?.program ?? value;
  validateGvmProgram(program);
  return program;
}

const MUTATION_OPERATIONS = new Set([
  'intent.capture', 'intent.packet', 'intent.confirm', 'intent.workflow',
  'intent.ratification-packet', 'intent.ratify', 'intent.compile',
  'program.approve',
  'process.start', 'process.step', 'process.step.model', 'process.run', 'process.run.model',
  'process.pause', 'process.stop', 'process.resume', 'process.recover',
  'process.replay.plan', 'process.replay', 'process.fork.plan', 'process.fork',
  'process.quarantine', 'process.archive',
  'task.retry.plan', 'task.retry',
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

async function compilerRequestForStart(root, options) {
  const bundled = optionString(options, 'compiler-request');
  if (bundled) return jsonFile(root, bundled, '--compiler-request');
  const names = ['intent', 'workflow', 'ratification', 'policy', 'registry'];
  const supplied = names.filter((name) => optionString(options, name) != null);
  if (!supplied.length) return null;
  if (supplied.length !== names.length) {
    fail(`Execution admission requires all compiler inputs: ${names.map((name) => `--${name}`).join(', ')}.`,
      'SGOS_PROGRAM_PROVENANCE_REQUIRED', { supplied, missing: names.filter((name) => !supplied.includes(name)) });
  }
  const intentIr = await jsonFile(root, optionString(options, 'intent'), '--intent');
  const workflow = await jsonFile(root, optionString(options, 'workflow'), '--workflow');
  const ratification = await jsonFile(root, optionString(options, 'ratification'), '--ratification');
  const policy = await jsonFile(root, optionString(options, 'policy'), '--policy');
  const registrySnapshot = await jsonFile(root, optionString(options, 'registry'), '--registry');
  validateSgosRecord(policy);
  return {
    intentIr,
    workflow,
    ratification,
    policySnapshotSha256: policy.snapshotSha256,
    registrySnapshotSha256: ratification.registrySnapshotSha256,
    registrySnapshot,
    storageProfileSha256: ratification.storageProfileSha256
  };
}

async function emit(value, options, text, {
  operation,
  changed = false,
  allowOutput = false,
  publicationCreated = false,
  externalSystemsChanged = false
} = {}) {
  if (!operation) fail('SGOS narration requires an operation ID.', 'SGOS_OPERATION_REQUIRED');
  const output = optionString(options, 'out');
  if (output && !allowOutput) {
    fail(`--out is not supported by ${operation}; it is available only for Intent record authoring commands.`,
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
    publicationCreated: Boolean(publicationCreated),
    externalSystemsChanged: Boolean(externalSystemsChanged)
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

function jsonInput(options, key, label) {
  const raw = optionString(options, key);
  if (raw == null) return { present: false, value: null };
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes > MAX_HUMAN_INPUT_BYTES) {
    fail(`${label} exceeds the ${MAX_HUMAN_INPUT_BYTES}-byte command boundary.`,
      'SGOS_HUMAN_RESPONSE_INPUT_TOO_LARGE', { bytes, maximumBytes: MAX_HUMAN_INPUT_BYTES });
  }
  try {
    return { present: true, value: cloneSgosValue(JSON.parse(raw)) };
  } catch (error) {
    fail(`${label} must be valid safe JSON: ${error.message}.`, 'SGOS_HUMAN_RESPONSE_INPUT_INVALID');
  }
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
  const authored = await runSgosIntentAuthoring(root, positionals, options, { jsonFile, emit });
  if (authored != null) return authored;
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
    const compileRequest = {
      intentIr,
      workflow,
      ratification,
      policySnapshotSha256: policy.snapshotSha256,
      registrySnapshotSha256: ratification.registrySnapshotSha256,
      registrySnapshot,
      storageProfileSha256: ratification.storageProfileSha256
    };
    const selector = workflowCapabilityPackSelector(workflow);
    const compiled = selector.kind === 'built-in-core'
      ? compileSgosProgram(compileRequest)
      : await compileSgosProgramWithApprovedCapabilityPack(root, compileRequest);
    // Core keeps the existing Program-only interface. A signed Pack must carry its exact authority
    // beside the Program so the later human approval can bind what the compiler actually consumed.
    const output = selector.kind === 'built-in-core'
      ? compiled.program
      : {
        program: compiled.program,
        capabilityPackAuthorities: compiled.capabilityPackAuthorities
      };
    return emit(output, options, (value) => {
      const program = value.program ?? value;
      return `Compiled ${program.programId} at ${program.programSha256} (${program.taskTemplates.length} finite tasks).`;
    },
    { operation: 'intent.compile', allowOutput: true });
  }
  fail(`Unknown intent action '${action}'.`, 'UNKNOWN_SUBCOMMAND');
}

async function programCommand(root, positionals, options) {
  const action = positionals[1] ?? 'show';
  const authored = await runSgosProgramAuthoring(root, positionals, options, { jsonFile, emit });
  if (authored != null) return authored;
  const program = validatedProgramInput(await jsonFile(root, positionals[2], 'GVM Program'));
  if (action === 'show') {
    return emit(program, options, (value) =>
      `${value.programId} · ${value.taskTemplates.length} tasks · ${value.programSha256}`,
    { operation: 'program.show' });
  }
  if (action === 'validate') {
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
  if (action === 'what-if') {
    const without = optionString(options, 'without-device');
    const withoutDeviceIds = String(without ?? '').split(',').map((entry) => entry.trim())
      .filter(Boolean);
    const result = whatIfSgosProgram(program, { withoutDeviceIds });
    return emit(result, options, (value) =>
      `${value.programId}: removing ${value.without.ids.join(', ')} structurally blocks ${value.impact.blockedTaskIds.length} task(s); nothing executed.`,
    { operation: 'program.what-if' });
  }
  if (action === 'fault-plan') {
    const targetValue = optionString(options, 'target');
    const matched = /^(task|device):(.+)$/.exec(String(targetValue ?? ''));
    if (!matched) {
      fail("program fault-plan requires --target task:<TASK-ID> or device:<DEVICE-ID>.",
        'SGOS_SIMULATION_INPUT_INVALID');
    }
    const result = planSgosProgramFault(program, {
      target: { kind: matched[1], id: matched[2] },
      failure: optionString(options, 'failure')
    });
    return emit(result, options, (value) =>
      `${value.programId}: ${value.failure.id} planned at ${value.target.kind}:${value.target.id}; no fault was injected.`,
    { operation: 'program.fault-plan' });
  }
  fail(`Unknown program action '${action}'.`, 'UNKNOWN_SUBCOMMAND');
}

async function processCommand(root, positionals, options) {
  const action = positionals[1] ?? 'status';
  if (action === 'list') {
    const board = await loadSgosCommandCenter(root);
    return emit(board, options, (value) => {
      const healthy = value.processes.length;
      const unavailable = value.unavailable.length;
      const needsYou = value.needsYou.length;
      return `${healthy} Process${healthy === 1 ? '' : 'es'} · ${needsYou} need${needsYou === 1 ? 's' : ''} you`
        + (unavailable ? ` · ${unavailable} unavailable` : '');
    }, { operation: 'process.list' });
  }
  if (action === 'start') {
    const subjectKind = optionString(options, 'subject-kind', 'repository');
    if (!['story', 'repository'].includes(subjectKind)) {
      fail(`Unsupported SGOS subject kind '${subjectKind}'. Allowed: story, repository.`,
        'SGOS_SUBJECT_KIND_INVALID', { subjectKind });
    }
    const program = validatedProgramInput(await jsonFile(root, positionals[2], 'GVM Program'));
    const bindingFile = optionString(options, 'binding');
    const processBinding = bindingFile ? await jsonFile(root, bindingFile, '--binding') : null;
    if (processBinding) validateSgosRecord(processBinding);
    const subjectId = optionString(options, 'subject', program.programId);
    const compilerRequest = await compilerRequestForStart(root, options);
    const result = await startSgosProcess(root, {
      program,
      compilerRequest,
      processBinding,
      processId: optionString(options, 'process-id'),
      taskContractSha256: sgosSha256({
        kind: 'gvm-task-contract-set', programSha256: program.programSha256,
        policySnapshotSha256: program.policySnapshotSha256,
        taskTemplateSha256: program.taskTemplates.map((task) => task.taskTemplateSha256).sort()
      }),
      subject: {
        kind: subjectKind, id: subjectId,
        branch: branch(root), baselineRevision: head(root)
      }
    });
    return emit(result, options,
      (value) => `${processSummary(value.process)} · checkpoint ${value.checkpoint.checkpointSha256}`,
      { operation: 'process.start', changed: Boolean(result.created || result.recoveredStart) });
  }
  if (action === 'replay') {
    const processId = positionals[2];
    if (!processId) fail('process replay requires a Process ID.', 'SGOS_PROCESS_ID_REQUIRED');
    const confirmationSha256 = optionString(options, 'confirm');
    if (confirmationSha256 == null) {
      const fromCheckpointSha256 = optionString(options, 'from');
      if (!fromCheckpointSha256) {
        fail('process replay preview requires --from <CHECKPOINT-SHA256>.',
          'SGOS_CHECKPOINT_REQUIRED');
      }
      const plan = await planSgosProcessReplay(root, processId, { fromCheckpointSha256 });
      return emit(plan, options,
        (value) => `Replay ${value.taskInstanceIds.length} pure suffix task(s); confirm ${value.replayPlanSha256}.`,
        { operation: 'process.replay.plan', changed: true });
    }
    const result = await replaySgosProcess(root, processId, { confirmationSha256 });
    return emit(result, options,
      (value) => `Reopened ${value.plan.taskInstanceIds.length} pure suffix task(s) in ${value.process.processId}.`,
      { operation: 'process.replay', changed: true });
  }
  if (action === 'fork') {
    const processId = positionals[2];
    if (!processId) fail('process fork requires a Process ID.', 'SGOS_PROCESS_ID_REQUIRED');
    const confirmationSha256 = optionString(options, 'confirm');
    if (confirmationSha256 == null) {
      const fromCheckpointSha256 = optionString(options, 'from');
      if (!fromCheckpointSha256) {
        fail('process fork preview requires --from <CHECKPOINT-SHA256>.',
          'SGOS_CHECKPOINT_REQUIRED');
      }
      const plan = await planSgosProcessFork(root, processId, {
        fromCheckpointSha256,
        label: optionString(options, 'label', 'fork')
      });
      return emit(plan, options,
        (value) => `Fork ${value.childProcessId} from genesis; confirm ${value.forkPlanSha256}.`,
        { operation: 'process.fork.plan', changed: true });
    }
    const result = await forkSgosProcess(root, processId, { confirmationSha256 });
    return emit(result, options,
      (value) => `Created independent Process ${value.child.processId} from ${value.parent.processId}.`,
      { operation: 'process.fork', changed: true });
  }
  const processId = positionals[2];
  if (!processId) fail(`process ${action} requires a Process ID.`, 'SGOS_PROCESS_ID_REQUIRED');
  if (action === 'quarantine' || action === 'archive') {
    const confirmationSha256 = optionString(options, 'confirm');
    const result = confirmationSha256
      ? await quarantineSgosProcess(root, processId, { confirmationSha256 })
      : await planSgosProcessQuarantine(root, processId);
    const withNext = {
      ...result,
      compatibilityAlias: action === 'archive' ? 'process archive' : null,
      next: result.quarantined
        ? [`singularity-flow process start <PROGRAM> --subject <SUBJECT>`]
        : [`singularity-flow process quarantine ${processId} --confirm ${result.confirmationSha256}`]
    };
    return emit(withNext, options,
      (value) => value.quarantined
        ? `Quarantined ${value.processId} without rewriting ${value.fileCount} preserved file(s), including ${value.pendingWriterLeftovers.length} opaque pending-writer leftover(s). No success, retry, or recovery was inferred; start a new Process from an approved Program.`
        : value.reason === 'interrupted-creation-seed'
          ? `${value.processId} is an interrupted private creation seed with no genesis authority. It is not runnable or successful. Review ${value.fileCount} file(s), then confirm ${value.confirmationSha256} to quarantine it.`
          : value.reason === 'failed-terminal-before-evidence'
            ? `${value.processId} has one interrupted failed terminal attempt with no evidence or receipt. It is neither successful nor retryable. Review ${value.fileCount} file(s), then confirm ${value.confirmationSha256} to quarantine it.`
            : value.reason === 'terminal-attempt-before-receipt'
              ? `${value.processId} has one interrupted readable Process terminal attempt without a receipt. The task did not succeed. Review ${value.fileCount} file(s), then confirm ${value.confirmationSha256} to quarantine it.`
              : `${value.processId} has unreadable legacy-v1 authority bytes. Review ${value.fileCount} file(s), then confirm ${value.confirmationSha256} to quarantine them.`,
      { operation: `process.${action}`, changed: Boolean(result.quarantined) });
  }
  if (action === 'status') {
    const process = await readSgosProcess(root, processId);
    const requests = await openRequests(root, process);
    return emit({ process, workObjects: projectSgosWorkObjects(process, { humanRequests: requests }) }, options,
      (value) => processSummary(value.process), { operation: 'process.status' });
  }
  if (action === 'fsck') {
    const result = await fsckSgosProcess(root, processId);
    return emit(result, options, (value) =>
      `${value.processId}: ${value.status}; ${value.indexedRecordCount} indexed record(s), `
        + `${value.orphans.length} orphan(s), ${value.pendingReservations.length} pending reservation(s), `
        + `${value.errors.length + value.missing.length} integrity issue(s).`,
    { operation: 'process.fsck' });
  }
  if (action === 'graph') {
    const process = await readSgosProcess(root, processId);
    const program = (await readSgosProgram(root, processId, process.programSha256)).record;
    const tasks = Object.values(process.taskInstances).sort((a, b) => compareSgosCodePoints(a.taskTemplateId, b.taskTemplateId));
    return emit({
      processId,
      processRevision: process.processRevision,
      processSha256: process.processSha256,
      programId: program.programId,
      programSha256: process.programSha256,
      tasks,
      edges: program.edges
    }, options,
      (value) => value.tasks.map((task) => `${task.taskTemplateId.padEnd(24)} ${task.state}`).join('\n'),
      { operation: 'process.graph' });
  }
  if (action === 'step') {
    const expectedRevision = expectedProcessRevision(options);
    const result = await stepSgosProcess(root, processId, { expectedRevision });
    return emit(result, options, (value) => value.taskInstanceId
      ? `${value.taskInstanceId}: ${value.status}. ${processSummary(value.process)}`
      : `No task dispatched. ${processSummary(value.process)}`,
    {
      operation: optionBoolean(options, 'allow-model') ? 'process.step.model' : 'process.step',
      changed: Boolean(result.taskInstanceId)
    });
  }
  if (action === 'run') {
    const expectedRevision = expectedProcessRevision(options);
    const maximumParallel = optionNumber(
      options, 'maximum-parallel', SGOS_INSTALLED_LIMITS.maximumParallelExecutions
    );
    if (!Number.isSafeInteger(maximumParallel)) {
      fail('--maximum-parallel must be a positive whole number within the installed execution bound.',
        'SGOS_PARALLEL_LIMIT', {
          maximumParallel,
          installed: SGOS_INSTALLED_LIMITS.maximumParallelExecutions
        });
    }
    const before = await readSgosProcess(root, processId);
    const result = await runSgosProcess(root, processId, { maximumParallel, expectedRevision });
    const processChanged = before.processSha256 !== result.process.processSha256;
    const report = { ...result, maximumParallel, processChanged };
    return emit(report, options,
      (value) => value.launched > 0
        ? `Launched ${value.launched} task${value.launched === 1 ? '' : 's'} in one bounded wave: ${value.taskInstanceIds.join(', ')}. ${processSummary(value.process)}`
        : value.processChanged
          ? `No task was launched, but exact runtime reconciliation changed Process state. ${processSummary(value.process)}`
          : `No task was launched; no Process state changed. ${processSummary(value.process)}`,
      {
        operation: optionBoolean(options, 'allow-model') ? 'process.run.model' : 'process.run',
        changed: processChanged
      });
  }
  if (action === 'pause') {
    const expectedRevision = expectedProcessRevision(options);
    const value = await pauseSgosProcess(root, processId, { expectedRevision });
    return emit(value, options, processSummary, { operation: 'process.pause', changed: true });
  }
  if (action === 'stop') {
    const expectedRevision = expectedProcessRevision(options);
    const value = await stopSgosProcess(root, processId, { expectedRevision });
    return emit(value, options,
      (result) => result.quiescent
        ? `${result.process.processId} is quiescent and paused.`
        : `${result.process.processId} stop recorded; ${result.activeAttemptIds.length} execution(s) are quiescing. Run process stop again or process status to verify quiescence.`,
      { operation: 'process.stop', changed: value.changed === true });
  }
  if (action === 'resume') {
    const expectedRevision = expectedProcessRevision(options);
    const checkpointSha256 = optionString(options, 'confirm');
    if (!HASH.test(String(checkpointSha256 ?? ''))) fail('process resume requires --confirm <CHECKPOINT-SHA256>.', 'SGOS_CHECKPOINT_CONFIRMATION_REQUIRED');
    const value = await resumeSgosProcess(root, processId, { checkpointSha256, expectedRevision });
    return emit(value, options, processSummary, { operation: 'process.resume', changed: true });
  }
  if (action === 'recover') {
    const resolution = optionString(options, 'resolution');
    if (resolution) {
      const result = await recoverInterruptedSgosExecution(root, processId, {
        attemptId: optionString(options, 'attempt-id'),
        resolution,
        confirmationSha256: optionString(options, 'confirm')
      });
      return emit(result, options,
        (value) => `${value.taskInstanceId}: ${value.status}; interrupted execution recorded as ${value.resolution}.`,
        { operation: 'process.recover', changed: true });
    }
    const result = await planSgosProcessRecovery(root, processId);
    const next = result.interrupted
      ? result.actions.map((entry) =>
        `singularity-flow process recover ${processId} --attempt-id ${result.attemptId} --resolution ${entry.resolution} --confirm ${entry.confirmationSha256}`)
      : [`singularity-flow process status ${processId}`];
    return emit({ ...result, next }, options,
      (value) => value.interrupted
        ? `${value.taskTemplateId} has one recoverable execution boundary; ${value.actions.length} exact recovery action(s) available.`
        : `${value.status}. No interrupted execution requires recovery.`,
    { operation: 'process.recover.plan' });
  }
  fail(`Unknown process action '${action}'.`, 'UNKNOWN_SUBCOMMAND');
}

async function optionalImmutableRecord(root, processId, family, reference) {
  if (!HASH.test(String(reference ?? ''))) {
    return {
      reference,
      family,
      status: 'unavailable',
      errorCode: 'SGOS_EXTERNAL_REFERENCE',
      record: null
    };
  }
  try {
    return {
      reference,
      family,
      status: 'available',
      record: (await readSgosImmutableRecord(root, processId, family, reference)).record
    };
  } catch (error) {
    if (error?.code !== 'SGOS_RECORD_NOT_FOUND') throw error;
    return { reference, family, status: 'unavailable', errorCode: error.code, record: null };
  }
}

async function taskInspection(root, process, task) {
  const program = (await readSgosProgram(root, process.processId, process.programSha256)).record;
  const taskTemplate = program.taskTemplates.find((entry) => entry.taskTemplateId === task.taskTemplateId) ?? null;
  const receipt = task.receiptSha256
    ? (await readSgosImmutableRecord(root, process.processId, 'gvm-task-receipt', task.receiptSha256)).record
    : null;
  return {
    processId: process.processId,
    processRevision: process.processRevision,
    programSha256: process.programSha256,
    policySnapshotSha256: process.policySnapshotSha256,
    taskContractSha256: process.taskContractSha256 ?? null,
    task,
    taskTemplate,
    attemptLineage: {
      attemptIds: [...task.attemptIds],
      count: task.attemptIds.length,
      latestAttemptId: task.attemptIds.at(-1) ?? null
    },
    receipt
  };
}

async function taskEvidenceInspection(root, inspection) {
  const { processId, task, receipt } = inspection;
  if (!receipt) {
    return {
      ...inspection,
      status: 'unavailable',
      reason: 'task-has-no-receipt',
      references: null,
      candidate: null,
      actionEvidence: [],
      humanResponses: [],
      unresolvedEvidenceRefs: [],
      unresolvedEffectRefs: []
    };
  }
  const candidate = await optionalImmutableRecord(
    root, processId, 'candidate-snapshot', receipt.candidateSha256
  );
  const humanResponses = [];
  for (const reference of receipt.humanDecisionRefs ?? []) {
    humanResponses.push(await optionalImmutableRecord(root, processId, 'human-response', reference));
  }
  const humanReferences = new Set((receipt.humanDecisionRefs ?? []));
  const actionEvidence = [];
  const unresolvedEvidenceRefs = [];
  for (const reference of receipt.evidenceRefs ?? []) {
    if (reference === receipt.candidateSha256 || humanReferences.has(reference)) continue;
    const resolved = await optionalImmutableRecord(root, processId, 'action-evidence', reference);
    if (resolved.status === 'available') actionEvidence.push(resolved);
    else unresolvedEvidenceRefs.push({
      reference,
      status: 'unavailable',
      reason: 'not-a-local-action-evidence-record'
    });
  }
  return {
    ...inspection,
    status: 'available',
    integrity: 'validated-on-read',
    references: {
      receiptSha256: task.receiptSha256,
      candidateSha256: receipt.candidateSha256,
      evidenceRefs: [...receipt.evidenceRefs],
      effectRefs: [...receipt.effectRefs],
      humanDecisionRefs: [...receipt.humanDecisionRefs]
    },
    candidate,
    actionEvidence,
    humanResponses,
    unresolvedEvidenceRefs,
    unresolvedEffectRefs: (receipt.effectRefs ?? []).map((reference) => ({
      reference,
      status: 'unavailable',
      reason: 'effect-record-not-supported-by-this-runtime-profile'
    }))
  };
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
  const inspection = await taskInspection(root, process, task);
  if (action === 'retry') {
    const confirmationSha256 = optionString(options, 'confirm');
    if (confirmationSha256 == null) {
      const plan = await planSgosTaskRetry(root, processId, task.taskInstanceId);
      return emit(plan, options,
        (value) => `Retry ${value.taskTemplateId} as attempt ${value.attemptNumber}; confirm ${value.retryPlanSha256}.`,
        { operation: 'task.retry.plan', changed: true });
    }
    const result = await retrySgosTaskWithInstalledAdapters(
      root, processId, task.taskInstanceId, { confirmationSha256 }
    );
    return emit(result, options,
      (value) => `${value.plan.taskTemplateId}: retry attempt ${value.plan.attemptNumber} ${value.receipt.attemptStatus}.`,
      { operation: 'task.retry', changed: true });
  }
  if (action === 'show') return emit(inspection, options,
    (value) => `${value.task.taskTemplateId} · ${value.task.state} · revision ${value.task.revision}`,
  { operation: 'task.show' });
  if (action === 'evidence') {
    const evidence = await taskEvidenceInspection(root, inspection);
    if (!task.receiptSha256) return emit(evidence, options,
      () => `${task.taskTemplateId} has no immutable receipt yet.`, { operation: 'task.evidence' });
    return emit(evidence, options,
      (value) => `${task.taskTemplateId}: verification ${value.receipt.verification.status}; `
        + `candidate ${value.candidate.status}; action evidence ${value.actionEvidence.length}; `
        + `unresolved references ${value.unresolvedEvidenceRefs.length + value.unresolvedEffectRefs.length}.`,
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
    const declaredDecision = optionString(options, 'decision');
    const confirmation = optionString(options, 'confirm');
    const expectedRevision = expectedProcessRevision(options);
    const expectedProcessSha256 = optionString(options, 'expected-process-sha256');
    if (expectedRevision == null) {
      fail('request respond requires --expected-revision from the reviewed Human Request.',
        'SGOS_PROCESS_REVISION_REQUIRED');
    }
    if (!HASH.test(String(expectedProcessSha256 ?? ''))) {
      fail('request respond requires --expected-process-sha256 with the exact reviewed Process digest.',
        'SGOS_PROCESS_DIGEST_REQUIRED');
    }
    if (found.process.processRevision !== expectedRevision
        || found.process.processSha256 !== expectedProcessSha256) {
      fail('Human Request response is stale because the reviewed Process revision or digest changed.',
        'SGOS_HUMAN_REQUEST_STALE');
    }
    if (confirmation !== found.request.requestSha256) {
      fail(`Response confirmation must equal ${found.request.requestSha256}.`, 'SGOS_HUMAN_REQUEST_STALE');
    }
    if (declaredDecision != null && !DECISIONS.has(declaredDecision)) {
      fail(`Unknown Human Request decision '${declaredDecision}'. Allowed: ${[...DECISIONS].join(', ')}.`,
        'SGOS_HUMAN_RESPONSE_INVALID');
    }
    if (option != null && declaredDecision != null && declaredDecision !== 'selected') {
      fail('--option selects a declared option and cannot be combined with a different --decision.',
        'SGOS_HUMAN_RESPONSE_INVALID');
    }
    const decision = declaredDecision ?? (option != null ? 'selected' : null);
    if (decision == null) {
      fail('request respond requires --decision or --option.', 'SGOS_HUMAN_RESPONSE_DECISION_REQUIRED');
    }
    if (decision === 'selected' && option == null) {
      fail("Decision 'selected' requires --option with one exact option ID.", 'SGOS_HUMAN_RESPONSE_OPTION_REQUIRED');
    }
    if (option != null && !found.request.options.some((entry) => entry.id === option)) {
      fail(`Option '${option}' is not declared by this request. Allowed: ${found.request.options.map((entry) => entry.id).join(', ') || 'none'}.`,
        'SGOS_HUMAN_RESPONSE_INVALID');
    }
    const typed = jsonInput(options, 'input-json', '--input-json');
    const sensitive = jsonInput(options, 'sensitive-handle', '--sensitive-handle');
    if (typed.present && sensitive.present) {
      fail('Use only one of --input-json or --sensitive-handle.', 'SGOS_HUMAN_RESPONSE_INPUT_INVALID');
    }
    if (found.request.sensitiveMode !== 'none' && typed.present) {
      fail('Sensitive Human Requests refuse --input-json. Pass only a non-secret typed reference through --sensitive-handle.',
        'SGOS_HUMAN_RESPONSE_SENSITIVE_VALUE_REFUSED');
    }
    if (found.request.sensitiveMode === 'none' && sensitive.present) {
      fail('--sensitive-handle is valid only when the request declares an external URL or secret broker.',
        'SGOS_HUMAN_RESPONSE_INPUT_INVALID');
    }
    if (decision !== 'provided' && (typed.present || sensitive.present)) {
      fail(`Decision '${decision}' cannot carry --input-json or --sensitive-handle.`,
        'SGOS_HUMAN_RESPONSE_INPUT_INVALID');
    }
    const input = decision === 'selected'
      ? { optionId: option }
      : decision === 'provided'
        ? (sensitive.present ? sensitive.value : typed.present ? typed.value : null)
        : null;
    const result = await respondToSgosHumanRequest(root, found.process.processId, {
      requestId,
      requestSha256: confirmation,
      expectedRevision,
      expectedProcessSha256,
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
  const command = positionals[0];
  const action = positionals[1] ?? ({ intent: 'show', program: 'show', process: 'status', task: 'list', request: 'list' }[command]);
  validateSgosCliOptions(command, action, options);
  const root = repoRoot();
  if (command === 'intent') return intentCommand(root, positionals, options);
  if (command === 'program') return programCommand(root, positionals, options);
  if (command === 'process') return processCommand(root, positionals, options);
  if (command === 'task') return taskCommand(root, positionals, options);
  if (command === 'request') return requestCommand(root, positionals, options);
  fail(`Unknown SGOS command '${command}'.`, 'UNKNOWN_COMMAND');
}
