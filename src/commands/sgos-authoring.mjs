/**
 * Explicit, model-free SGOS authoring commands.
 *
 * Natural-language capture remains an Intent Envelope only. These commands accept reviewed JSON
 * declarations and turn them into exact confirmation packets, Intent/Workflow records, and a
 * configuration-review proposal. They never infer missing intent and never grant execution
 * authority on the application branch.
 */
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

import { proposeConfigurationChange } from '../configuration-proposal.mjs';
import { canonicalJson } from '../records.mjs';
import {
  approveSgosProgramAuthority,
  createSgosIntentConfirmationPacket,
  createSgosIntentIrFromConfirmedAnswers,
  createSgosProgramAuthorityProposal,
  createSgosWorkflowCandidate,
  createSgosWorkflowRatification,
  createSgosWorkflowRatificationPacket
} from '../sgos/authoring.mjs';
import { optionString, SingularityFlowError, writeAtomic } from '../util.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;

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

/** Return null when the requested Intent action is not an authoring ceremony. */
export async function runSgosIntentAuthoring(root, positionals, options, { jsonFile, emit }) {
  const action = positionals[1];
  if (!['packet', 'confirm', 'workflow', 'ratification-packet', 'ratify'].includes(action)) {
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
