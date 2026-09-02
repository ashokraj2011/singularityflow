/**
 * Internal, model-free SGOS authoring command handlers.
 *
 * Natural-language capture remains an Intent Envelope only. These commands accept reviewed JSON
 * declarations and turn them into exact confirmation packets, Intent/Workflow records, and a
 * configuration-review proposal. They never infer missing intent and never grant execution
 * authority on the application branch.
 */
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import {
  lstat, mkdir, open, realpath, unlink
} from 'node:fs/promises';

import { isConfigurationReadPath } from '../../configuration-read-scope.mjs';
import { proposeConfigurationChange } from '../../configuration-proposal.mjs';
import { canonicalJson } from '../../records.mjs';
import {
  approveSgosProgramAuthority,
  createSgosIntentConfirmationPacket,
  createSgosIntentIrFromConfirmedAnswers,
  createSgosProgramAuthorityProposal,
  createSgosWorkflowCandidate,
  createSgosWorkflowRatification,
  createSgosWorkflowRatificationPacket
} from '../../sgos/authoring.mjs';
import {
  createSgosGuidedWorkflow, createSgosWorkflowGuide
} from '../../sgos/workflow-generator.mjs';
import { withSubjectLock } from '../../subject-lock.mjs';
import {
  optionNumber, optionString, secureRepositoryPath, SingularityFlowError, writeAtomic
} from '../../util.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
const MAX_WORKFLOW_DRAFT_BYTES = 4 * 1024 * 1024;
const WORKFLOW_DRAFT_ROOT = 'singularity/sgos-drafts';

function fail(message, code = 'SGOS_AUTHORING_CLI_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function requiredOption(options, key) {
  const value = optionString(options, key);
  if (!value) fail(`--${key} is required.`, 'SGOS_OPTION_REQUIRED', { option: key });
  return value;
}

function exactDigest(options, key) {
  const value = requiredOption(options, key);
  if (!HASH.test(value)) {
    fail(`--${key} must be exactly 'sha256:' plus 64 lowercase hex characters.`,
      'SGOS_DIGEST_REQUIRED', { option: key });
  }
  return value;
}

async function ratificationInputs(root, intentPath, options, jsonFile) {
  const intentIr = await jsonFile(root, intentPath, 'Intent IR');
  const workflow = await jsonFile(root, requiredOption(options, 'workflow'), '--workflow');
  const policySnapshot = await jsonFile(root, requiredOption(options, 'policy'), '--policy');
  const registrySnapshot = await jsonFile(root, requiredOption(options, 'registry'), '--registry');
  const coveragePath = optionString(options, 'coverage');
  return {
    intentIr,
    workflow,
    policySnapshot,
    registrySnapshot,
    storageProfileSha256: exactDigest(options, 'storage-profile-sha256'),
    ...(coveragePath ? { coverage: await jsonFile(root, coveragePath, '--coverage') } : {})
  };
}

function outputIdentity(relative) {
  return relative.normalize('NFC').toLowerCase();
}

function assertDraftOutputPath(selected, label) {
  const segments = selected.relative.split('/');
  if (segments.some((segment) => segment.toLowerCase() === '.git')) {
    fail(`${label} cannot write inside Git administrative storage.`,
      'SGOS_WORKFLOW_OUTPUT_UNSAFE', { path: selected.relative });
  }
  if (isConfigurationReadPath(selected.relative)) {
    fail(`${label} cannot write an unratified draft to protected configuration path '${selected.relative}'. Use singularity/sgos-drafts/<id>/ instead.`,
      'SGOS_WORKFLOW_OUTPUT_PROTECTED', { path: selected.relative });
  }
  if (!selected.relative.startsWith(`${WORKFLOW_DRAFT_ROOT}/`)
      || !selected.relative.endsWith('.json')) {
    fail(`${label} must be a JSON file below ${WORKFLOW_DRAFT_ROOT}/.`,
      'SGOS_WORKFLOW_OUTPUT_UNSAFE', { path: selected.relative });
  }
}

async function assertDraftHandleBinding(output, identity, label) {
  let rebound;
  try {
    rebound = await secureRepositoryPath(output.root, output.relative, {
      label, mustExist: true, type: 'file'
    });
  } catch (error) {
    fail(`${label} escaped or changed filesystem identity during publication: ${output.relative}.`,
      'SGOS_WORKFLOW_OUTPUT_RACE', {
        path: output.relative, causeCode: error?.code ?? null
      });
  }
  const current = await lstat(rebound.absolute);
  if (!current.isFile() || current.isSymbolicLink()
      || current.dev !== identity.dev || current.ino !== identity.ino
      || current.nlink !== 1) {
    fail(`${label} changed filesystem identity during publication: ${output.relative}.`,
      'SGOS_WORKFLOW_OUTPUT_RACE', { path: output.relative });
  }
}

async function ensureDraftParent(selected, label) {
  const parentRelative = path.posix.dirname(selected.relative);
  let cursor = selected.root;
  for (const segment of parentRelative === '.' ? [] : parentRelative.split('/')) {
    cursor = path.join(cursor, segment);
    let info;
    try { info = await lstat(cursor); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      try { await mkdir(cursor, { mode: 0o700 }); } catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') throw mkdirError;
      }
      info = await lstat(cursor);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      fail(`${label} has a symbolic-link or non-directory ancestor: ${selected.relative}.`,
        'SGOS_WORKFLOW_OUTPUT_UNSAFE', { path: selected.relative });
    }
  }
  const expected = path.resolve(selected.root, ...(parentRelative === '.' ? [] : parentRelative.split('/')));
  if (await realpath(cursor) !== expected) {
    fail(`${label} changed filesystem identity during validation: ${selected.relative}.`,
      'SGOS_WORKFLOW_OUTPUT_UNSAFE', { path: selected.relative });
  }
}

async function readDraftFile(selected, label) {
  let observed;
  try { observed = await lstat(selected.absolute); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (observed.isSymbolicLink() || !observed.isFile()) {
    fail(`${label} must be a real regular file: ${selected.relative}.`,
      'SGOS_WORKFLOW_OUTPUT_UNSAFE', { path: selected.relative });
  }
  let handle;
  try {
    handle = await open(selected.absolute,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_WORKFLOW_DRAFT_BYTES) {
      fail(`${label} is not a bounded regular draft file: ${selected.relative}.`,
        'SGOS_WORKFLOW_OUTPUT_UNSAFE', {
          path: selected.relative, bytes: info.size, maximumBytes: MAX_WORKFLOW_DRAFT_BYTES
        });
    }
    const rebound = await lstat(selected.absolute);
    if (!rebound.isFile() || rebound.isSymbolicLink()
        || rebound.dev !== info.dev || rebound.ino !== info.ino) {
      fail(`${label} changed filesystem identity while it was read: ${selected.relative}.`,
        'SGOS_WORKFLOW_OUTPUT_UNSAFE', { path: selected.relative });
    }
    const content = await handle.readFile({ encoding: 'utf8' });
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_WORKFLOW_DRAFT_BYTES) {
      fail(`${label} grew beyond the installed ${MAX_WORKFLOW_DRAFT_BYTES}-byte draft ceiling while it was read.`,
        'SGOS_WORKFLOW_OUTPUT_UNSAFE', {
          path: selected.relative, bytes, maximumBytes: MAX_WORKFLOW_DRAFT_BYTES
        });
    }
    return { content, dev: info.dev, ino: info.ino };
  } catch (error) {
    if (['ELOOP', 'EMLINK'].includes(error?.code)) {
      fail(`${label} cannot be a symbolic link: ${selected.relative}.`,
        'SGOS_WORKFLOW_OUTPUT_UNSAFE', { path: selected.relative });
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function plannedJsonOutput(root, candidate, label, value) {
  let selected = await secureRepositoryPath(root, candidate, {
    label, mustExist: false, type: 'file'
  });
  assertDraftOutputPath(selected, label);
  await ensureDraftParent(selected, label);
  selected = await secureRepositoryPath(root, selected.relative, {
    label, mustExist: false, type: 'file'
  });
  const content = canonicalJson(value);
  if (Buffer.byteLength(content, 'utf8') > MAX_WORKFLOW_DRAFT_BYTES) {
    fail(`${label} exceeds the installed ${MAX_WORKFLOW_DRAFT_BYTES}-byte draft ceiling.`,
      'SGOS_WORKFLOW_OUTPUT_TOO_LARGE', { path: selected.relative });
  }
  const existing = await readDraftFile(selected, label);
  if (existing != null && existing.content !== content) {
    fail(`${label} already exists with different bytes: ${selected.relative}. Choose a new output path; existing reviewed input is never overwritten.`,
      'SGOS_WORKFLOW_OUTPUT_EXISTS', { path: selected.relative });
  }
  return {
    ...selected,
    label,
    content,
    existing,
    changed: existing == null
  };
}

async function createDraftExclusively(output) {
  if (!output.changed) return { created: false, identity: output.existing };
  await ensureDraftParent(output, output.label ?? 'Workflow draft output');
  let handle;
  let createdIdentity = null;
  try {
    handle = await open(output.absolute,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY
      | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1) {
      fail(`Workflow draft output did not open as one private regular file: ${output.relative}.`,
        'SGOS_WORKFLOW_OUTPUT_RACE', { path: output.relative });
    }
    createdIdentity = { dev: opened.dev, ino: opened.ino };
    await assertDraftHandleBinding(
      output, createdIdentity, output.label ?? 'Workflow draft output'
    );
    await handle.writeFile(output.content, 'utf8');
    await handle.sync();
    const written = await handle.stat();
    if (written.dev !== createdIdentity.dev || written.ino !== createdIdentity.ino
        || written.nlink !== 1 || written.size !== Buffer.byteLength(output.content, 'utf8')) {
      fail(`Workflow draft output changed while bytes were written: ${output.relative}.`,
        'SGOS_WORKFLOW_OUTPUT_RACE', { path: output.relative });
    }
    await assertDraftHandleBinding(
      output, createdIdentity, output.label ?? 'Workflow draft output'
    );
    return { created: true, identity: createdIdentity };
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const raced = await readDraftFile(output, output.label ?? 'Workflow draft output');
      if (raced?.content === output.content) return { created: false, identity: raced };
      fail(`Workflow draft output was created with different bytes while this command was running: ${output.relative}. Nothing was overwritten.`,
        'SGOS_WORKFLOW_OUTPUT_RACE', { path: output.relative });
    }
    if (createdIdentity) {
      await handle?.close().catch(() => {});
      handle = null;
      if (!await removeCreatedDraft(output, createdIdentity, { requireExactContent: false })) {
        throw new SingularityFlowError(
          `Workflow draft write failed and its exact partial file could not be removed: ${output.relative}. Review that file; nothing was overwritten.`,
          {
            code: 'SGOS_WORKFLOW_OUTPUT_ROLLBACK_FAILED',
            details: { retained: [output.relative], originalCode: error?.code ?? null }
          }
        );
      }
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function removeCreatedDraft(output, identity, { requireExactContent = true } = {}) {
  try {
    const current = await lstat(output.absolute);
    if (!current.isFile() || current.isSymbolicLink()
        || current.dev !== identity.dev || current.ino !== identity.ino) return false;
    if (requireExactContent) {
      const observed = await readDraftFile(output, output.label ?? 'Workflow draft output');
      if (observed?.content !== output.content) return false;
    }
    await unlink(output.absolute);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

async function publishPlannedJson(outputs) {
  const created = [];
  try {
    for (const output of outputs) {
      const publication = await createDraftExclusively(output);
      if (publication.created) created.push({ output, identity: publication.identity });
    }
    for (const output of outputs) {
      const observed = await readDraftFile(output, output.label ?? 'Workflow draft output');
      if (observed?.content !== output.content) {
        fail(`Workflow draft output changed during publication: ${output.relative}.`,
          'SGOS_WORKFLOW_OUTPUT_RACE', { path: output.relative });
      }
    }
    return { changed: created.length > 0 };
  } catch (error) {
    const retained = [];
    for (const entry of created.reverse()) {
      try {
        if (!await removeCreatedDraft(entry.output, entry.identity)) {
          retained.push(entry.output.relative);
        }
      } catch {
        retained.push(entry.output.relative);
      }
    }
    if (retained.length) {
      throw new SingularityFlowError(
        `Workflow draft publication failed and exact rollback could not remove: ${retained.join(', ')}. Review those files; nothing was overwritten.`,
        {
          code: 'SGOS_WORKFLOW_OUTPUT_ROLLBACK_FAILED',
          details: { retained, originalCode: error?.code ?? null }
        }
      );
    }
    throw error;
  }
}

function withoutOutputOptions(options) {
  const result = { ...options };
  delete result.out;
  delete result['declaration-out'];
  return result;
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9._/@:=,+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/** Return null when the requested Intent action is not an authoring ceremony. */
export async function runSgosIntentAuthoring(root, positionals, options, { jsonFile, emit }) {
  const action = positionals[1];
  if (![
    'packet', 'confirm', 'workflow', 'workflow-guide', 'workflow-create',
    'ratification-packet', 'ratify'
  ].includes(action)) {
    return null;
  }
  const source = positionals[2];
  if (!source) {
    fail(`intent ${action} requires a repository-relative JSON input file.`,
      'SGOS_FILE_REQUIRED');
  }

  if (action === 'packet' || action === 'confirm') {
    const envelope = await jsonFile(root, source, 'Intent Envelope');
    const answers = await jsonFile(root, requiredOption(options, 'answers'), '--answers');
    if (action === 'packet') {
      const packet = createSgosIntentConfirmationPacket(envelope, answers);
      return emit(packet, options,
        (value) => `Review the explicit Intent answers, then confirm ${value.packetSha256}.`,
        { operation: 'intent.packet', allowOutput: true });
    }
    const intentIr = await createSgosIntentIrFromConfirmedAnswers(root, {
      envelope,
      answers,
      confirmationSha256: exactDigest(options, 'confirm'),
      confirmedAt: requiredOption(options, 'confirmed-at')
    });
    return emit(intentIr, options,
      (value) => `Confirmed ${value.intentId} at ${value.intentIrSha256}; nothing was executed.`,
      { operation: 'intent.confirm', allowOutput: true });
  }

  if (action === 'workflow-guide') {
    const intentIr = await jsonFile(root, source, 'Intent IR');
    const registrySnapshot = await jsonFile(
      root, requiredOption(options, 'registry'), '--registry'
    );
    const guide = createSgosWorkflowGuide({ intentIr, registrySnapshot });
    return emit(guide, options,
      (value) => `${value.intent.intentId}: ${value.eligibleOperations.length} eligible core operation(s); ${value.blockers.length} blocker(s).`,
      { operation: 'intent.workflow-guide' });
  }

  if (action === 'workflow-create') {
    const intentIr = await jsonFile(root, source, 'Intent IR');
    const policySnapshot = await jsonFile(
      root, requiredOption(options, 'policy'), '--policy'
    );
    const registrySnapshot = await jsonFile(
      root, requiredOption(options, 'registry'), '--registry'
    );
    const title = optionString(options, 'title');
    const created = createSgosGuidedWorkflow({
      intentIr,
      policySnapshot,
      registrySnapshot,
      selection: {
        id: requiredOption(options, 'id'),
        ...(title == null ? {} : { title }),
        operation: requiredOption(options, 'operation'),
        verificationOperation: requiredOption(options, 'verification-operation'),
        storageProfileSha256: exactDigest(options, 'storage-profile-sha256'),
        maximumAttempts: optionNumber(options, 'maximum-attempts', 1),
        outputRef: optionString(options, 'output-ref', 'artifact:result')
      }
    });
    const declarationPath = requiredOption(options, 'declaration-out');
    const workflowPath = requiredOption(options, 'out');
    const preliminaryDeclaration = await secureRepositoryPath(root, declarationPath, {
      label: '--declaration-out', mustExist: false, type: 'file'
    });
    const preliminaryWorkflow = await secureRepositoryPath(root, workflowPath, {
      label: '--out', mustExist: false, type: 'file'
    });
    assertDraftOutputPath(preliminaryDeclaration, '--declaration-out');
    assertDraftOutputPath(preliminaryWorkflow, '--out');
    if (outputIdentity(preliminaryDeclaration.relative)
        === outputIdentity(preliminaryWorkflow.relative)) {
      fail('--declaration-out and --out must name two distinct repository files.',
        'SGOS_WORKFLOW_OUTPUT_COLLISION', {
          declaration: preliminaryDeclaration.relative,
          workflow: preliminaryWorkflow.relative
        });
    }
    const publication = await withSubjectLock(root, {
      kind: 'sgos-workflow-draft', id: 'repository'
    }, async () => {
      const declarationOutput = await plannedJsonOutput(
        root, preliminaryDeclaration.relative, '--declaration-out', created.declaration
      );
      const workflowOutput = await plannedJsonOutput(
        root, preliminaryWorkflow.relative, '--out', created.workflow
      );
      if (declarationOutput.existing && workflowOutput.existing
          && declarationOutput.existing.dev === workflowOutput.existing.dev
          && declarationOutput.existing.ino === workflowOutput.existing.ino) {
        fail('--declaration-out and --out resolve to the same existing file identity.',
          'SGOS_WORKFLOW_OUTPUT_COLLISION', {
            declaration: declarationOutput.relative,
            workflow: workflowOutput.relative
          });
      }
      const written = await publishPlannedJson([declarationOutput, workflowOutput]);
      return { declarationOutput, workflowOutput, changed: written.changed };
    });
    const { declarationOutput, workflowOutput } = publication;
    const directory = path.posix.dirname(workflowOutput.relative);
    const ratificationArguments = [
      'singularity-flow', 'intent', 'ratification-packet', source,
      '--workflow', workflowOutput.relative,
      '--policy', requiredOption(options, 'policy'),
      '--registry', requiredOption(options, 'registry'),
      '--storage-profile-sha256', created.declaration.spec.storageRequirements.profileSha256,
      '--out', `${directory}/ratification-packet.json`, '--json'
    ];
    const result = {
      ...created,
      outputs: {
        declaration: declarationOutput.relative,
        workflow: workflowOutput.relative,
        changed: publication.changed
      },
      next: [{
        operation: 'intent.ratification-packet',
        arguments: ratificationArguments.slice(1),
        command: ratificationArguments.map(shellQuote).join(' ')
      }]
    };
    return emit(result, withoutOutputOptions(options),
      (value) => `Created unratified Workflow Candidate ${value.workflow.workflowSha256} and declaration ${value.outputs.declaration}; nothing was ratified, compiled, approved, committed, or run.`,
      {
        operation: 'intent.workflow-create',
        changed: publication.changed
      });
  }

  if (action === 'workflow') {
    const intentIr = await jsonFile(root, source, 'Intent IR');
    const policySnapshot = await jsonFile(
      root, requiredOption(options, 'policy'), '--policy'
    );
    const declaration = await jsonFile(
      root, requiredOption(options, 'declaration'), '--declaration'
    );
    const workflow = createSgosWorkflowCandidate({ intentIr, policySnapshot, declaration });
    return emit(workflow, options,
      (value) => `Created finite Workflow Candidate ${value.workflowSha256}; it is not ratified.`,
      { operation: 'intent.workflow', allowOutput: true });
  }

  const request = await ratificationInputs(root, source, options, jsonFile);
  if (action === 'ratification-packet') {
    const packet = createSgosWorkflowRatificationPacket(request);
    return emit(packet, options,
      (value) => `Review the Workflow method and coverage, then confirm ${value.packetSha256}.`,
      { operation: 'intent.ratification-packet', allowOutput: true });
  }
  const ratification = await createSgosWorkflowRatification(root, {
    ...request,
    confirmationSha256: exactDigest(options, 'confirm'),
    decidedAt: requiredOption(options, 'decided-at')
  });
  return emit(ratification, options,
    (value) => `Ratified exact Workflow ${value.workflowSha256} at ${value.ratificationSha256}; no Program ran.`,
    { operation: 'intent.ratify', allowOutput: true });
}

/** Return null when the requested Program action is not an authority ceremony. */
export async function runSgosProgramAuthoring(root, positionals, options, { jsonFile, emit }) {
  if (positionals[1] !== 'approve') return null;
  const programPath = positionals[2];
  if (!programPath) fail('program approve requires a repository-relative GVM Program file.',
    'SGOS_FILE_REQUIRED');
  const program = await jsonFile(root, programPath, 'GVM Program');
  const exactProgram = program?.program ?? program;
  const confirmationSha256 = optionString(options, 'confirm');
  if (!confirmationSha256) {
    const proposal = createSgosProgramAuthorityProposal(program);
    return emit(proposal, options,
      (value) => `Review Program ${value.programSha256}, then repeat with --confirm ${value.proposalSha256} --approved-at <RFC3339>.`,
      { operation: 'program.approve.plan' });
  }

  if (!HASH.test(confirmationSha256)) {
    fail('--confirm must be the exact Program authority proposal digest.',
      'SGOS_DIGEST_REQUIRED');
  }
  const approved = await approveSgosProgramAuthority(root, {
    program,
    confirmationSha256,
    approvedAt: requiredOption(options, 'approved-at')
  });
  const publication = await proposeConfigurationChange(root, {
    operation: 'sgos-program-authority',
    subject: exactProgram.programId,
    message: `[sgos] approve Program ${exactProgram.programId}`,
    mutate: async (scratch) => {
      const output = path.join(scratch, ...approved.path.split('/'));
      await mkdir(path.dirname(output), { recursive: true });
      await writeAtomic(output, canonicalJson(approved.record));
      return {
        authorityStatus: approved.authorityStatus,
        proposalSha256: approved.proposalSha256,
        path: approved.path
      };
    }
  });
  return emit({ ...approved, publication }, options,
    (value) => value.publication.changed
      ? `Published review branch ${value.publication.branch}; merge it into sflow/config before Process start.`
      : `The exact Program authority record already exists at ${value.path}.`,
    {
      operation: 'program.approve',
      changed: Boolean(publication.changed),
      publicationCreated: Boolean(publication.changed),
      externalSystemsChanged: Boolean(publication.pushed)
    });
}
