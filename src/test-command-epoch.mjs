/** Fresh, immutable validation of a retained publication under an amended runner. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeRequiredTestCommand, testReceiptPassing } from './code-delivery-tests.mjs';
import { resolveDeliveryQualityCommands } from './delivery-evidence.mjs';
import { commitIsAncestor, exactFileAtObject } from './git.mjs';
import { qualityValidationVerdict } from './lifecycle-evidence-policy.mjs';
import { canonicalJson } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { validateTestCommandEpochValidation } from './test-command-amendment-contracts.mjs';
import { resolveTrpDeliverySelection } from './trp-delivery-selection.mjs';
import { nowIso, secureRepositoryPath, SingularityFlowError, writeText } from './util.mjs';

const digest = value => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const fail = message => { throw new SingularityFlowError(message, { code: 'TCA_EPOCH_VALIDATION_REQUIRED' }); };
const workRelative = (config, workflow) => path.posix.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
const phaseAmendment = (workflow, phase) => (workflow.testCommandAmendments ?? []).findLast(entry => entry.phaseId === phase.id);
const liveRuns = new WeakMap();
const bytesDigest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const qualified = value => `sha256:${String(value).replace(/^sha256:/u, '')}`;

export function testCommandEpochRequirement(workflow, phase) {
  const marker = phase?.testCommandRevalidation;
  if (!marker) return null;
  const summary = phaseAmendment(workflow, phase);
  if (!summary?.revalidation || marker.id !== summary.id || marker.state !== 'required'
    || marker.validationEpoch !== summary.to.validationEpoch || marker.generation !== summary.revalidation.generation
    || marker.publicationSha256 !== summary.revalidation.publicationSha256
    || marker.commandInventorySha256 !== summary.to.commandInventorySha256
    || !/^sha256:[a-f0-9]{64}$/u.test(summary.to.policySha256 ?? '')
    || digest(phase.qualityCommands) !== marker.commandInventorySha256
    || !Number.isSafeInteger(phase.generation) || phase.generation < marker.generation) {
    fail('The runner validation epoch is not bound to its accepted amendment. Reload the accepted Story.');
  }
  return marker;
}

export function beginTestCommandEpochValidation(workflow, phase) {
  const requirement = testCommandEpochRequirement(workflow, phase);
  if (!requirement) return null;
  const run = randomUUID();
  const attempt = { id: `TCEV-${run}`, epoch: requirement.validationEpoch,
    suffix: `epoch${requirement.validationEpoch}-${run}` };
  liveRuns.set(attempt, { identity: canonicalJson(attempt), startedAt: nowIso(), used: false });
  return attempt;
}

async function boundedRecord(root, relative, evidenceCommit = null) {
  const safe = await secureRepositoryPath(root, relative, { label: 'Epoch test execution evidence', type: 'file', mustExist: !evidenceCommit });
  const bytes = evidenceCommit ? exactFileAtObject(root, evidenceCommit, relative, { maximumBytes: 8 * 1024 * 1024 })
    : await readFile(safe.absolute);
  if (!bytes || bytes.length > 8 * 1024 * 1024) fail('The epoch execution record is unavailable or exceeds its bounded size.');
  try { return JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch { fail('The epoch execution record is not valid JSON.'); }
}

async function expectedEpochCommands(root, config, workflow, phase, requirement) {
  let commands = (await resolveDeliveryQualityCommands(root, phase)).map((command, index) => {
    if (command?.kind !== 'test') return command;
    const normalized = normalizeRequiredTestCommand(command, index);
    return { ...normalized, result: { ...normalized.result,
      minimumDiscovered: Math.max(normalized.result.minimumDiscovered, workflow.resolution?.codeDelivery?.tests?.minimumDiscovered ?? 1),
      minimumPassed: Math.max(normalized.result.minimumPassed, workflow.resolution?.codeDelivery?.tests?.minimumPassed ?? 1) } };
  });
  if (workflow.testRecovery || workflow.resolution?.testRecovery?.enabled === true) {
    const sourceEpochWorkflow = structuredClone(workflow);
    if (sourceEpochWorkflow.testRecovery) sourceEpochWorkflow.testRecovery.validationEpoch = requirement.validationEpoch;
    commands = (await resolveTrpDeliverySelection(root, config, sourceEpochWorkflow, phase,
      phase.deliveryEvidence, commands)).commands;
  }
  return commands.filter(command => command?.kind === 'test').map((command, index) => normalizeRequiredTestCommand(command, index));
}

/** Authenticate the actual child receipts, never a newly labelled aggregate status. */
async function verifyEpochExecutions(root, config, workflow, phase, record, { packet = null, startedAt = null } = {}) {
  const requirement = testCommandEpochRequirement(workflow, phase);
  const amendment = phaseAmendment(workflow, phase);
  const commands = await expectedEpochCommands(root, config, workflow, phase, requirement);
  const suffix = `epoch${record.validationEpoch}-${record.id.slice('TCEV-'.length)}`;
  const base = `${workRelative(config, workflow)}/context/code-delivery`;
  if (record.deliveryReceipt.path !== `${base}/${phase.id}-gen${phase.generation}-${suffix}.json`) {
    fail('The current epoch must bind its own fresh delivery receipt, not a historical receipt path.');
  }
  const delivery = await boundedRecord(root, record.deliveryReceipt.path, packet?.evidenceCommit);
  if (digest(delivery) !== record.deliveryReceipt.sha256) fail('The epoch delivery receipt does not match its exact recorded bytes.');
  const executions = delivery.testExecutions ?? [];
  const expectedIds = commands.map(command => command.id).sort();
  const actualIds = executions.map(entry => entry.commandId).sort();
  if (!expectedIds.length || new Set(expectedIds).size !== expectedIds.length
    || canonicalJson(actualIds) !== canonicalJson(expectedIds)) fail('The current epoch must contain the exact complete required test-command inventory.');
  const checks = packet?.checks ?? phase.checks;
  const paths = new Set();
  for (const command of commands) {
    const execution = executions.find(entry => entry.commandId === command.id);
    const expectedPath = `${base}/tests/${phase.id}-gen${phase.generation}-${suffix}-${command.id.replace(/[^A-Za-z0-9._-]+/g, '-')}.json`;
    if (execution.receiptPath !== expectedPath || paths.has(expectedPath)) fail('The current epoch has a historical, ambiguous, or foreign child test receipt path.');
    paths.add(expectedPath);
    const stored = await boundedRecord(root, expectedPath, packet?.evidenceCommit);
    if (digest(stored) !== qualified(execution.receiptSha256)) fail('The current epoch child receipt digest does not match its exact bytes.');
    let child;
    try { child = readRecord('test-execution', stored).record; }
    catch { fail('The current epoch child test receipt has no supported immutable reader.'); }
    const observed = checks.filter(check => check.id === command.id);
    const check = observed[0];
    const start = Date.parse(check?.startedAt ?? '');
    const end = Date.parse(check?.completedAt ?? '');
    const decisionTime = Date.parse(amendment.decidedAt ?? '');
    const decisionBytes = check?.sourceCommit && amendment.decisionPath
      ? exactFileAtObject(root, check.sourceCommit, amendment.decisionPath, { maximumBytes: 1024 * 1024 }) : null;
    if (observed.length !== 1 || check.status !== 'passed' || check.exitCode !== 0
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(check.sourceCommit ?? '')
      || check.sourceTreeSha256 !== record.sourceTreeSha256 || !Number.isFinite(start) || !Number.isFinite(end)
      || !Number.isFinite(decisionTime) || start < decisionTime || end < start || end > Date.parse(record.validatedAt)
      || (startedAt && start < Date.parse(startedAt))
      || !decisionBytes || bytesDigest(decisionBytes) !== amendment.decisionSha256
      || (packet && !commitIsAncestor(root, check.sourceCommit, packet.evidenceCommit))) {
      fail('The current epoch lacks fresh source-bound execution after its authenticated runner amendment.');
    }
    if (execution.status !== 'passed' || child.commandId !== command.id
      || child.argvSha256 !== createHash('sha256').update(JSON.stringify(command.argv)).digest('hex')
      || child.workingDirectory !== command.workingDirectory || child.adapter !== command.result.adapter
      || canonicalJson(child.affectedRoots) !== canonicalJson(command.affectedRoots)
      || child.result?.path !== command.result.path
      || !testReceiptPassing(child, command.result.minimumDiscovered, command.result.minimumPassed)) {
      fail('Historical child test output does not satisfy the exact amended argv, working directory, adapter, coverage, and test-count requirements.');
    }
  }
}

export async function recordTestCommandEpochValidation(root, config, workflow, phase, run) {
  if (!run) return null;
  const live = liveRuns.get(run);
  if (!live || live.used || live.identity !== canonicalJson(run)) fail('Only a fresh live epoch execution attempt can record validation.');
  const requirement = testCommandEpochRequirement(workflow, phase);
  const evidence = phase.deliveryEvidence;
  const quality = qualityValidationVerdict(phase.checks ?? [], { required: true });
  if (!requirement || run.epoch !== requirement.validationEpoch || evidence?.validation?.status !== 'passed'
    || !phase.checks?.length || quality.failed.length || quality.unavailableRequired.length
    || !(evidence.testExecutions?.length) || evidence.testExecutions.some(execution => execution.status !== 'passed')) {
    fail('The amended epoch requires fresh passing execution, not a reused historical receipt.');
  }
  const publication = (phase.generationPublications ?? []).find(entry => entry.generation === phase.generation);
  if (!publication) fail('The retained generation has no immutable publication binding.');
  const record = { schemaVersion: currentSchemaVersion('test-command-epoch-validation'), kind: 'test-command-epoch-validation', id: run.id,
    workId: workflow.workItem.id, phaseId: phase.id, amendmentId: requirement.id,
    generation: phase.generation, validationEpoch: requirement.validationEpoch,
    policySha256: phaseAmendment(workflow, phase).to.policySha256, commandInventorySha256: requirement.commandInventorySha256,
    publicationSha256: digest(publication), generationCommit: phase.generationCommit,
    sourceTreeSha256: evidence.validation.sourceTreeSha256,
    deliveryReceipt: { path: evidence.receiptPath, sha256: `sha256:${String(evidence.receiptSha256).replace(/^sha256:/u, '')}` },
    checksSha256: digest(phase.checks), status: 'passed', validatedAt: nowIso() };
  validateTestCommandEpochValidation(record);
  await verifyEpochExecutions(root, config, workflow, phase, record, { startedAt: live.startedAt });
  const relative = `${workRelative(config, workflow)}/context/test-recovery/epochs/${record.id}.json`;
  const safe = await secureRepositoryPath(root, relative, { label: 'Fresh test-command epoch validation', type: 'file' });
  if (safe.exists) fail('This epoch validation attempt already exists; recover its exact transaction.');
  await mkdir(path.dirname(safe.absolute), { recursive: true });
  await writeText(safe.absolute, canonicalJson(record));
  live.used = true;
  phase.testCommandValidation = { path: relative, sha256: digest(record) };
  return phase.testCommandValidation;
}

export async function verifyTestCommandEpochValidation(root, config, workflow, phase, { packet = null } = {}) {
  const requirement = testCommandEpochRequirement(workflow, phase);
  if (!requirement) return null;
  const reference = packet?.submissionEvidence?.testCommandEpoch ?? phase.testCommandValidation;
  if (!reference?.path || reference.sha256 !== phase.testCommandValidation?.sha256
    || reference.path !== phase.testCommandValidation?.path
    || !reference.path.startsWith(`${workRelative(config, workflow)}/context/test-recovery/epochs/`)) {
    fail('Submit this published generation again to execute the amended test command under its current validation epoch. Historical tests and approvals remain preserved.');
  }
  const safe = await secureRepositoryPath(root, reference.path, { label: 'Test-command epoch validation', type: 'file', mustExist: !packet });
  const bytes = packet ? exactFileAtObject(root, packet.evidenceCommit, reference.path, { maximumBytes: 1024 * 1024 })
    : await readFile(safe.absolute);
  if (!bytes || bytes.length > 1024 * 1024) fail('The current epoch validation is unavailable at the reviewed evidence commit.');
  let record;
  try { record = JSON.parse(Buffer.from(bytes).toString('utf8')); validateTestCommandEpochValidation(record); }
  catch { fail('The current epoch validation record is invalid.'); }
  const evidence = phase.deliveryEvidence;
  const publication = (phase.generationPublications ?? []).find(entry => entry.generation === phase.generation);
  const codeBinding = packet?.submissionEvidence?.codeDelivery ?? { path: evidence?.receiptPath, sha256: evidence?.receiptSha256 };
  if (reference.path !== `${workRelative(config, workflow)}/context/test-recovery/epochs/${record.id}.json`
    || digest(record) !== reference.sha256 || record.workId !== workflow.workItem.id || record.phaseId !== phase.id
    || record.amendmentId !== requirement.id || record.validationEpoch !== requirement.validationEpoch
    || record.generation !== phase.generation || record.generationCommit !== phase.generationCommit
    || record.policySha256 !== phaseAmendment(workflow, phase).to.policySha256
    || record.commandInventorySha256 !== requirement.commandInventorySha256
    || record.publicationSha256 !== digest(publication) || record.status !== 'passed'
    || record.sourceTreeSha256 !== evidence?.validation?.sourceTreeSha256
    || (packet && record.sourceTreeSha256 !== packet.sourceTreeSha256)
    || record.checksSha256 !== digest(packet?.checks ?? phase.checks)
    || record.deliveryReceipt.path !== codeBinding.path
    || record.deliveryReceipt.sha256 !== `sha256:${String(codeBinding.sha256).replace(/^sha256:/u, '')}`) {
    fail('Historical or altered validation cannot satisfy the current runner policy epoch. Submit fresh validation for this exact retained generation.');
  }
  await verifyEpochExecutions(root, config, workflow, phase, record, { packet });
  return record;
}
