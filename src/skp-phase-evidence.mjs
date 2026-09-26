/** Exact SKP phase evidence joins. No function here grants producer or host authority. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { assertSkillArtifactSetEvidence, catalogArtifactSet, memberRoot, resolvedArtifactSet } from './artifact-sets.mjs';
import { normalizeCodeDeliveryPolicy } from './code-delivery-policy.mjs';
import { exactFileAtObject } from './git.mjs';
import { authoredArtifactText, inspectManagedArtifactMetadata } from './publication-preflight.mjs';
import { recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { resolveStorySkillPackage } from './story-execution-context.mjs';
import { posix, secureRepositoryPath, SingularityFlowError, snapshot } from './util.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function fail(code, message, details = undefined) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

function digest(value) { return `sha256:${recordSha256(value)}`; }

/**
 * Submission and approval rewrite the primary artifact's engine-owned metadata. The immutable
 * submitted review packet binds its *submitted* raw bytes; an approved input binds the current
 * raw bytes. Only the primary may differ, and only if its author-owned bytes and the current
 * managed envelope still verify. Secondary outputs have no lifecycle metadata rewrite.
 */
export async function verifyApprovedSkillOutputContinuity(root, definition, workflow, producer, {
  repositoryPath, submittedSha256, submittedSize, approvedSha256, evidenceCommit
}) {
  if (approvedSha256 === submittedSha256) return true;
  const primary = posix(path.posix.join(itemRelative(definition, workflow),
    producer.requiredArtifact?.path ?? ''));
  if (repositoryPath !== primary || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(String(evidenceCommit ?? ''))
      || !/^[a-f0-9]{64}$/u.test(String(submittedSha256 ?? ''))
      || !Number.isSafeInteger(submittedSize) || submittedSize < 0
      || submittedSize > 128 * 1024 * 1024) {
    fail('SKP_INPUT_RECEIPT_STALE', `Skill input '${producer.id}' changed outside its managed primary artifact metadata.`);
  }
  // The Git owner applies the immutable, no-lazy-fetch local-object boundary and retains exact
  // bytes. A missing or oversized object is a stale receipt, never permission to use current HEAD.
  const before = exactFileAtObject(root, evidenceCommit, repositoryPath, {
    maximumBytes: Math.max(1024, submittedSize + 1024)
  });
  if (!before || before.length !== submittedSize
      || createHash('sha256').update(before).digest('hex') !== submittedSha256) {
    fail('SKP_INPUT_RECEIPT_STALE', `Skill input '${producer.id}' submitted bytes are unavailable or no longer match the review packet.`);
  }
  const secured = await secureRepositoryPath(root, repositoryPath, {
    label: `Approved skill input '${producer.id}'`, mustExist: true, type: 'file'
  });
  const after = await readFile(secured.absolute);
  if (createHash('sha256').update(after).digest('hex') !== approvedSha256) {
    fail('SKP_INPUT_RECEIPT_STALE', `Skill input '${producer.id}' approved bytes changed during verification.`);
  }
  let previousAuthored;
  let currentAuthored;
  let currentText;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    previousAuthored = authoredArtifactText(decoder.decode(before));
    currentText = decoder.decode(after);
    currentAuthored = authoredArtifactText(currentText);
  } catch {
    fail('SKP_INPUT_RECEIPT_STALE', `Skill input '${producer.id}' primary artifact is not valid UTF-8.`);
  }
  if (previousAuthored !== currentAuthored) {
    fail('SKP_INPUT_RECEIPT_STALE', `Skill input '${producer.id}' author-owned bytes changed after submission.`);
  }
  // The phase owner defines the canonical managed envelope. A matching authored body does not
  // permit a forged approval or a duplicated metadata block to ride along as a trusted input.
  const managed = inspectManagedArtifactMetadata(currentText);
  const { artifactMetadataBlock, storyArtifactMetadata } = await import('./state.mjs');
  if (managed.status !== 'valid'
      || !currentText.startsWith(artifactMetadataBlock(storyArtifactMetadata(workflow, producer)))) {
    fail('SKP_INPUT_RECEIPT_STALE', `Skill input '${producer.id}' current managed metadata is not the approved lifecycle projection.`);
  }
  const { extractInputsBlock, resolvedPhaseInputs, verifyInputsIntegrity } = await import('./inputs.mjs');
  const selected = workflow.resolution?.phases?.find((entry) => entry.id === producer.id);
  const declarations = selected?.kind === 'skill'
    ? selected.skillBinding?.bindingRefs?.inputs ?? []
    : resolvedPhaseInputs(workflow, producer);
  if (!declarations.length && extractInputsBlock(currentText)) {
    fail('SKP_INPUT_RECEIPT_STALE', `Skill input '${producer.id}' contains an undeclared managed-input block.`);
  }
  const integrity = await verifyInputsIntegrity(root, workflow, producer, {
    definition,
    itemRelative: itemRelative(definition, workflow),
    itemDirectory: path.join(root, itemRelative(definition, workflow))
  });
  if (integrity.errors.length || integrity.warnings.length) {
    fail('SKP_INPUT_RECEIPT_STALE', `Skill input '${producer.id}' current managed-input block is not valid.`);
  }
  return true;
}

/**
 * Template producers predate SKP's three-stage bundle identities. Their artifact set is the
 * published bundle, while submission and approval can rewrite only the primary artifact's
 * engine-owned metadata. An SKP consumer may use that approved output only when the entire
 * original set still exists and any primary-byte difference has that exact lifecycle proof.
 */
export async function verifyTemplateProducerSetContinuity(root, definition, workflow, producer, {
  approvedPath, approvedSha256, approvedBytes, packet
}) {
  const stored = producer.artifactSet;
  if (!stored) return null;
  if (workflow.resolution?.phases?.some((phase) => phase.id === producer.id && phase.kind === 'skill')) {
    fail('SKP_INPUT_RECEIPT_STALE', `Skill producer '${producer.id}' cannot use template bundle continuity.`);
  }
  const set = resolvedArtifactSet(definition, workflow, producer);
  if (!set || stored.setId !== set.id
      || Number(stored.generation) !== Number(producer.generation)) {
    fail('SKP_INPUT_RECEIPT_STALE', `Template producer '${producer.id}' has no exact published artifact set.`);
  }
  const setRoot = posix(path.posix.join(itemRelative(definition, workflow), memberRoot(producer)));
  for (const member of set.members) {
    const memberPath = posix(path.posix.join(setRoot, member.path));
    await secureRepositoryPath(root, memberPath, {
      label: `Template producer '${producer.id}' artifact-set member`,
      type: member.path.endsWith('/') ? 'directory' : 'file'
    });
  }
  const current = await catalogArtifactSet(root, itemRelative(definition, workflow), producer, set);
  const recordedBundleSha256 = recordSha256({
    setId: stored.setId,
    members: [...(stored.members ?? [])].sort((left, right) => left.path.localeCompare(right.path))
      .map((member) => ({ path: member.path, role: member.role, sha256: member.sha256 }))
  });
  const previousMembers = new Map((stored.members ?? []).map((member) => [member.path, member]));
  if (stored.primary !== current.primary || stored.bundleSha256 !== recordedBundleSha256
      || previousMembers.size !== current.members.length
      || stored.members?.length !== current.members.length
      || !current.members.some((member) => member.path === approvedPath
        && member.exists && member.sha256 === approvedSha256 && member.bytes === approvedBytes)) {
    fail('SKP_INPUT_RECEIPT_STALE', `Template producer '${producer.id}' approved output is not an exact artifact-set member.`);
  }
  for (const member of current.members) {
    const previous = previousMembers.get(member.path);
    if (!previous || previous.role !== member.role || previous.required !== member.required
        || previous.authority !== member.authority || previous.directory !== member.directory
        || previous.exists !== member.exists) {
      fail('SKP_INPUT_RECEIPT_STALE', `Template producer '${producer.id}' artifact-set membership changed after publication.`);
    }
    if (previous.sha256 === member.sha256 && previous.bytes === member.bytes) continue;
    if (member.path !== current.primary || !member.exists || member.directory) {
      fail('SKP_INPUT_RECEIPT_STALE', `Template producer '${producer.id}' non-primary artifact-set member changed after publication.`);
    }
    const submitted = packet?.artifacts?.find((artifact) => artifact.path === member.path);
    const registered = (producer.artifacts ?? []).filter((artifact) => artifact.path === member.path);
    if (!submitted || registered.length !== 1 || registered[0].status !== 'approved'
        || registered[0].sha256 !== member.sha256 || registered[0].size !== member.bytes) {
      fail('SKP_INPUT_RECEIPT_STALE', `Template producer '${producer.id}' primary output lacks exact submitted and approved identities.`);
    }
    await verifyApprovedSkillOutputContinuity(root, definition, workflow, producer, {
      repositoryPath: member.path,
      submittedSha256: submitted.sha256,
      submittedSize: submitted.size,
      approvedSha256: member.sha256,
      evidenceCommit: packet.evidenceCommit
    });
  }
  return current.bundleSha256;
}

function itemRelative(definition, workflow) {
  return posix(path.posix.join(
    workflow.resolution?.workItemRoot ?? definition.workItemRoot ?? 'singularity/work-items',
    workflow.workItem.id
  ));
}

function exactArtifactPath(phaseId, value) {
  if (typeof value !== 'string' || !value.startsWith(`artifacts/${phaseId}/`)
      || value.includes('\\') || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    fail('SKP_OUTPUT_PATH_INVALID', `Skill phase '${phaseId}' has an invalid accepted output path.`);
  }
  return value;
}

function declaredOutputs(binding, phase) {
  const outputs = binding?.bindingRefs?.outputs;
  if (!Array.isArray(outputs) || !outputs.length) {
    fail('SKP_CONTRACT_EMPTY', `Skill phase '${phase.id}' has no retained exact output bindings.`);
  }
  const ids = new Set();
  const paths = new Set();
  for (const output of outputs) {
    if (!ID.test(String(output?.id ?? '')) || output?.required !== true && output?.required !== false
        || !Number.isSafeInteger(output.minimumBytes) || output.minimumBytes < 1
        || !Number.isSafeInteger(output.maximumBytes) || output.maximumBytes < output.minimumBytes) {
      fail('SKP_CONTRACT_INVALID', `Skill phase '${phase.id}' has an invalid retained output contract.`);
    }
    exactArtifactPath(phase.id, output.path);
    if (ids.has(output.id) || paths.has(output.path)) {
      fail('SKP_OUTPUT_DUPLICATE', `Skill phase '${phase.id}' repeats a retained output ID or path.`);
    }
    ids.add(output.id);
    paths.add(output.path);
  }
  if (!outputs.some((output) => output.required && output.path === phase.requiredArtifact?.path)) {
    fail('SKP_ARTIFACT_SET_INVALID', `Skill phase '${phase.id}' primary artifact is not a retained required output.`);
  }
  const primary = outputs.find((output) => output.path === phase.requiredArtifact.path);
  if (primary.kind !== phase.requiredArtifact.kind) {
    fail('SKP_CONTRACT_INVALID', `Skill phase '${phase.id}' primary artifact kind differs from its retained output.`);
  }
  return outputs;
}

/** Only WFA's accepted-Story reader may supply this binding to evidence owners. */
export async function resolveSkillPhaseEvidenceBinding(root, definition, workflow, phase) {
  if (!phase || !definition) fail('SKP_CONTRACT_UNCONFIRMED', 'Skill evidence needs the selected phase and accepted Story definition.');
  const selected = workflow.resolution?.phases?.find((entry) => entry.id === phase.id);
  if (phase.kind === 'skill' && selected?.kind !== 'skill') {
    fail('SKP_CONTRACT_UNCONFIRMED', `Skill phase '${phase.id}' has no matching accepted Story phase binding.`);
  }
  if (selected?.kind !== 'skill') return null;
  const binding = await resolveStorySkillPackage(root, definition, workflow, { phaseId: phase.id });
  if (!binding || binding.phaseId !== phase.id || !HASH.test(String(binding.snapshotHash ?? ''))
      || !HASH.test(String(binding.packageSha256 ?? ''))
      || !HASH.test(String(binding.contractSha256 ?? ''))
      || binding.packageSha256 !== binding.bindingRefs?.skill?.packageSha256
      || binding.contractSha256 !== binding.bindingRefs?.contractSha256) {
    fail('SKP_PACKAGE_CORRUPT', `Skill phase '${phase.id}' has no verified accepted package and contract binding.`);
  }
  declaredOutputs(binding, phase);
  return binding;
}

async function outputBytes(root, repositoryPath, phaseId, outputId) {
  const secured = await secureRepositoryPath(root, repositoryPath, {
    label: `Skill output '${phaseId}/${outputId}'`
  });
  if (!secured.exists) return null;
  if (!secured.entry?.isFile()) {
    fail('SKP_OUTPUT_INVALID', `Skill output '${phaseId}/${outputId}' must be a regular file at ${repositoryPath}.`);
  }
  const bytes = await readFile(secured.absolute);
  const current = await snapshot(secured.absolute);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (!current.exists || current.sha256 !== sha256 || current.size !== bytes.byteLength) {
    fail('SKP_CAPTURE_UNSTABLE', `Skill output '${phaseId}/${outputId}' changed while validating its bytes.`);
  }
  return { bytes, size: bytes.byteLength, sha256 };
}

/**
 * Check the actual candidate files and registrations against exact accepted output IDs. This
 * intentionally remains usable in focused tests even while host execution is unavailable.
 */
export async function inspectSkillOutputSet(root, definition, workflow, phase, binding) {
  if (!binding || binding.phaseId !== phase.id) {
    fail('SKP_CONTRACT_UNCONFIRMED', `Skill phase '${phase.id}' has no verified binding.`);
  }
  const outputs = declaredOutputs(binding, phase);
  const item = itemRelative(definition, workflow);
  const accepted = new Set(outputs.map((output) => posix(path.posix.join(item, output.path))));
  const artifactRoot = posix(path.posix.join(item, 'artifacts', phase.id));
  for (const artifact of phase.artifacts ?? []) {
    if (artifact.path.startsWith(`${artifactRoot}/`) && !accepted.has(artifact.path)) {
      fail('SKP_OUTPUT_UNDECLARED', `Skill phase '${phase.id}' registered undeclared output '${artifact.path}'.`);
    }
  }
  const evidence = [];
  for (const output of outputs) {
    const repositoryPath = posix(path.posix.join(item, output.path));
    const current = await outputBytes(root, repositoryPath, phase.id, output.id);
    if (!current) {
      if (output.required) {
        fail('SKP_OUTPUT_MISSING', `Required skill output '${phase.id}/${output.id}' is missing at ${repositoryPath}.`,
          { phase: phase.id, output: output.id, path: repositoryPath });
      }
      evidence.push({ id: output.id, path: repositoryPath, required: false,
        exists: false, sha256: null, bytes: null });
      continue;
    }
    const registered = (phase.artifacts ?? []).filter((artifact) => artifact.path === repositoryPath);
    if (registered.length !== 1 || registered[0].exists !== true
        || registered[0].kind !== output.kind
        || registered[0].sha256 !== current.sha256 || registered[0].size !== current.size) {
      fail('SKP_OUTPUT_UNREGISTERED', `Skill output '${phase.id}/${output.id}' is not registered at its exact current bytes.`);
    }
    let measuredBytes = current.size;
    if (output.encoding === 'utf-8') {
      let decoded;
      try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(current.bytes); }
      catch { fail('SKP_OUTPUT_INVALID', `Skill output '${phase.id}/${output.id}' is not valid UTF-8.`); }
      if (output.mediaType === 'text/markdown') {
        measuredBytes = Buffer.byteLength(authoredArtifactText(decoded), 'utf8');
      }
    }
    if (measuredBytes < output.minimumBytes || measuredBytes > output.maximumBytes) {
      fail('SKP_OUTPUT_INVALID', `Skill output '${phase.id}/${output.id}' has ${measuredBytes} authored bytes; the accepted range is ${output.minimumBytes}–${output.maximumBytes}.`);
    }
    evidence.push({ id: output.id, path: repositoryPath, required: output.required,
      exists: true, sha256: current.sha256, bytes: current.size });
  }
  const set = resolvedArtifactSet({}, workflow, phase);
  const catalogue = set
    ? await catalogArtifactSet(root, item, phase, set) : null;
  const bundleSha256 = assertSkillArtifactSetEvidence(phase, set, catalogue, outputs, item);
  return Object.freeze({
    phase: phase.id,
    generation: phase.generation,
    outputs: Object.freeze(evidence),
    bundleSha256,
    outputSetSha256: digest({ format: 'skp-output-set/v1', phase: phase.id,
      generation: phase.generation, outputs: evidence, bundleSha256 })
  });
}

function skillInputRecords(root, definition, workflow, phase, binding) {
  const inputs = binding.bindingRefs.inputs ?? [];
  if (!Array.isArray(inputs)) fail('SKP_CONTRACT_INVALID', `Skill phase '${phase.id}' has invalid input bindings.`);
  if (!inputs.length) return { inputRecordSha256: null, inputSetSha256: digest({
    format: 'skp-input-set/v1', phase: phase.id, generation: phase.generation, inputs: []
  }) };
  const anchor = phase.inputContext;
  const relative = posix(path.posix.join(itemRelative(definition, workflow),
    'context', `inputs-${phase.id}-gen${phase.generation}.json`));
  if (!anchor || anchor.path !== relative || Number(anchor.generation) !== Number(phase.generation)
      || anchor.mode !== 'enforce' || !/^[a-f0-9]{64}$/.test(String(anchor.sha256 ?? ''))) {
    fail('SKP_INPUT_RECEIPT_MISSING', `Skill phase '${phase.id}' lacks its exact generation input record.`);
  }
  return { relative, anchor, inputs };
}

export async function inspectSkillInputSet(root, definition, workflow, phase, binding, {
  readPacket = null
} = {}) {
  const selected = skillInputRecords(root, definition, workflow, phase, binding);
  if (!selected.relative) {
    const primary = posix(path.posix.join(itemRelative(definition, workflow), phase.requiredArtifact.path));
    const secured = await secureRepositoryPath(root, primary, {
      label: `Skill phase '${phase.id}' primary artifact`, mustExist: true, type: 'file'
    });
    const { extractInputsBlock } = await import('./inputs.mjs');
    if (extractInputsBlock(await readFile(secured.absolute, 'utf8'))) {
      fail('SKP_INPUT_RECEIPT_STALE', `Skill phase '${phase.id}' contains an undeclared managed-input block.`);
    }
    return selected;
  }
  const secured = await secureRepositoryPath(root, selected.relative, {
    label: `Skill phase '${phase.id}' input receipt`, mustExist: true, type: 'file'
  });
  const current = await snapshot(secured.absolute);
  if (current.sha256 !== selected.anchor.sha256) {
    fail('SKP_INPUT_RECEIPT_STALE', `Skill phase '${phase.id}' input receipt changed after preparation.`);
  }
  const record = readRecord('phase-input-record', await readFile(secured.absolute)).record;
  if (record.phase !== phase.id || record.workId !== workflow.workItem.id
      || Number(record.generation) !== Number(phase.generation) || record.mode !== 'enforce'
      || record.renderedSha256 !== selected.anchor.renderedSha256
      || !Array.isArray(record.inputs) || record.inputs.length !== selected.inputs.length) {
    fail('SKP_INPUT_RECEIPT_STALE', `Skill phase '${phase.id}' input receipt identity differs from the accepted generation.`);
  }
  const projection = [];
  for (let index = 0; index < selected.inputs.length; index += 1) {
    const expected = selected.inputs[index];
    const actual = record.inputs[index];
    const receipt = actual?.skp?.receipt ?? null;
    if (typeof expected.path !== 'string'
        || !expected.path.startsWith(`artifacts/${expected.phase}/`)
        || expected.path.includes('\\')
        || expected.path.split('/').some((part) => !part || part === '.' || part === '..')) {
      fail('SKP_INPUT_RECEIPT_STALE', `Skill phase '${phase.id}' has an invalid accepted input path.`);
    }
    if (actual?.phase !== expected.phase || actual?.skp?.output !== expected.output
        || actual?.path !== expected.path || actual?.optional !== !expected.required
        || actual?.skp?.state !== expected.state) {
      fail('SKP_INPUT_RECEIPT_STALE', `Skill phase '${phase.id}' input '${expected.phase}/${expected.output}' differs from its accepted binding.`);
    }
    if (expected.required && (actual.status !== 'captured' || !receipt)) {
      fail('SKP_INPUT_RECEIPT_MISSING', `Skill phase '${phase.id}' required input '${expected.phase}/${expected.output}' has no approved receipt.`);
    }
    if (actual.status === 'captured') {
      if (!receipt || !Number.isSafeInteger(receipt.generation) || receipt.generation < 1
          || !HASH.test(String(receipt.packetSha256 ?? ''))
          || !/^[a-f0-9]{64}$/.test(String(actual.approvedSha256 ?? ''))
          || actual.approvedSha256 !== actual.sha256) {
        fail('SKP_INPUT_RECEIPT_STALE', `Skill phase '${phase.id}' input '${expected.phase}/${expected.output}' has incomplete approved evidence.`);
      }
      const producer = workflow.phases?.[expected.phase];
      const sourcePath = posix(path.posix.join(itemRelative(definition, workflow), expected.path));
      const registrations = (producer?.artifacts ?? []).filter((artifact) => artifact.path === sourcePath);
      const registered = registrations[0];
      const submission = (workflow.lineage?.submissions ?? []).find((entry) =>
        entry.phase === expected.phase && Number(entry.generation) === Number(receipt.generation)
        && entry.packetSha256 === receipt.packetSha256);
      // A multi-reviewer phase becomes an approved producer only at threshold. The final
      // decision carries the post-approval raw output identities; earlier valid decisions bind
      // the submitted packet but cannot describe metadata written after threshold.
      const approval = [...(producer?.approvals ?? [])].reverse().find((entry) =>
        !entry.invalidatedAt && entry.decision === 'approved'
        && Number(entry.generation) === Number(receipt.generation)
        && entry.reviewPacketSha256 === receipt.packetSha256
        && entry.evidenceCommit === receipt.evidenceCommit);
      const waived = ['none', 'policy'].includes(producer?.approvalPolicy?.mode)
        && receipt.acceptance === 'policy-approved';
      const skillProducer = workflow.resolution?.phases?.some((entry) =>
        entry.id === expected.phase && entry.kind === 'skill');
      const set = producer?.artifactSet ?? null;
      const member = set?.members?.find((entry) => entry.path === sourcePath) ?? null;
      if (!producer || producer.status !== 'approved'
          || Number(producer.generation) !== Number(receipt.generation)
          || !submission || !approval && !waived
          || registrations.length !== 1
          || registered?.status !== 'approved' || registered.sha256 !== actual.sha256
          || registered.sha256 !== receipt.approvedSha256
          || set && (Number(set.generation) !== Number(receipt.generation)
            || !member?.exists || skillProducer && member.sha256 !== actual.sha256
            || set.bundleSha256 !== receipt.bundleSha256
            || approval && (skillProducer
              ? approval.bundleSha256 !== receipt.submittedBundleSha256
                || set.submittedBundleSha256 !== receipt.submittedBundleSha256
                || approval.skillApprovedBundleSha256 !== set.bundleSha256
              : approval.bundleSha256 !== set.bundleSha256))
          || !set && receipt.bundleSha256 !== null
          || approval && !(approval.artifactSha256 ?? []).some((artifact) =>
            artifact.path === sourcePath && artifact.sha256 === receipt.submittedSha256)
          || approval && skillProducer && (approval.skillOutputIdentityVersion !== 1
            || !(approval.skillApprovedOutputs ?? []).some((output) =>
            output.path === sourcePath && output.exists === true
            && output.sha256 === actual.sha256 && output.bytes === actual.bytes))
          || !approval && receipt.acceptance !== 'policy-approved'
          || approval && receipt.acceptance !== 'human-approved') {
        fail('SKP_INPUT_RECEIPT_STALE', `Skill phase '${phase.id}' input '${expected.phase}/${expected.output}' no longer binds the current approved generation.`);
      }
      let packet;
      try {
        const reader = readPacket ?? (await import('./story-lineage.mjs')).readStoryReviewPacket;
        packet = await reader(root, definition, workflow, receipt.packetSha256);
      } catch {
        fail('SKP_INPUT_RECEIPT_STALE', `Skill phase '${phase.id}' input '${expected.phase}/${expected.output}' has no immutable approved review packet.`);
      }
      if (packet.phase !== expected.phase
          || Number(packet.generation) !== Number(receipt.generation)
          || packet.evidenceCommit !== receipt.evidenceCommit
          || !packet.artifacts?.some((artifact) =>
            artifact.path === sourcePath && artifact.sha256 === receipt.submittedSha256)
          || approval && skillProducer && approval.skillEvidenceSha256
            !== packet.submissionEvidence?.skill?.evidenceSha256) {
        fail('SKP_INPUT_RECEIPT_STALE', `Skill phase '${phase.id}' input '${expected.phase}/${expected.output}' review packet does not bind the selected output.`);
      }
      const securedSource = await secureRepositoryPath(root, sourcePath, {
        label: `Skill input '${expected.phase}/${expected.output}'`, mustExist: true, type: 'file'
      });
      const currentSource = await snapshot(securedSource.absolute);
      if (currentSource.sha256 !== actual.sha256 || currentSource.size !== actual.bytes) {
        fail('SKP_INPUT_RECEIPT_STALE', `Skill phase '${phase.id}' input '${expected.phase}/${expected.output}' bytes changed after preparation.`);
      }
      await verifyApprovedSkillOutputContinuity(root, definition, workflow, producer, {
        repositoryPath: sourcePath,
        submittedSha256: receipt.submittedSha256,
        submittedSize: packet.artifacts.find((artifact) => artifact.path === sourcePath)?.size,
        approvedSha256: actual.sha256,
        evidenceCommit: receipt.evidenceCommit
      });
      if (set && !skillProducer) {
        await verifyTemplateProducerSetContinuity(root, definition, workflow, producer, {
          approvedPath: sourcePath, approvedSha256: actual.sha256,
          approvedBytes: actual.bytes, packet
        });
      }
    } else if (receipt) {
      fail('SKP_INPUT_RECEIPT_STALE', `Unavailable skill input '${expected.phase}/${expected.output}' claims an approval receipt.`);
    } else if (expected.required) {
      fail('SKP_INPUT_RECEIPT_MISSING', `Required skill input '${expected.phase}/${expected.output}' is unavailable.`);
    } else {
      const producer = workflow.phases?.[expected.phase];
      const sourcePath = posix(path.posix.join(itemRelative(definition, workflow), expected.path));
      const approved = (producer?.artifacts ?? []).some((artifact) =>
        artifact.path === sourcePath && artifact.status === 'approved');
      if (producer?.status === 'approved' && approved) {
        fail('SKP_INPUT_RECEIPT_STALE', `Optional skill input '${expected.phase}/${expected.output}' became available after preparation.`);
      }
    }
    projection.push({ phase: expected.phase, output: expected.output, path: expected.path,
      required: expected.required, state: expected.state, status: actual.status,
      sha256: actual.sha256 ?? null, producerGeneration: actual.producerGeneration ?? 0,
      receipt });
  }
  return {
    inputRecordSha256: `sha256:${current.sha256}`,
    inputSetSha256: digest({ format: 'skp-input-set/v1', phase: phase.id,
      generation: phase.generation, inputs: projection })
  };
}

function checkDefinitionEvidence(phase, binding) {
  const expected = binding.bindingRefs.checks ?? [];
  const actual = (phase.qualityCommands ?? []).map((command) => ({
    id: command.id, definitionSha256: digest(command)
  }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail('SKP_CHECK_UNKNOWN', `Skill phase '${phase.id}' quality commands differ from its accepted check definitions.`);
  }
  return digest({ format: 'skp-check-definitions/v1', checks: expected });
}

function codeDeliveryEvidence(definition, workflow, phase, binding) {
  const expected = binding.bindingRefs.codeDeliverySha256 ?? null;
  if (!expected) return null;
  if (phase.generationPolicy?.task !== 'code' || !binding.bindingRefs.sourceScope) {
    fail('SKP_CODE_TASK_REQUIRED', `Skill phase '${phase.id}' lost its accepted code-delivery task or source scope.`);
  }
  const policy = workflow.resolution?.codeDelivery ?? definition.codeDelivery;
  if (!policy || digest(normalizeCodeDeliveryPolicy(policy)) !== expected) {
    fail('SKP_SCOPE_REQUIRES_CHECKS', `Skill phase '${phase.id}' code-delivery policy differs from the accepted definition.`);
  }
  return expected;
}

/** Existing publication and approval owners call this; it does not certify host enforcement. */
export async function verifySkillPhasePublication(root, definition, workflow, phase) {
  const binding = await resolveSkillPhaseEvidenceBinding(root, definition, workflow, phase);
  if (!binding) return null;
  const outputs = await inspectSkillOutputSet(root, definition, workflow, phase, binding);
  const inputs = await inspectSkillInputSet(root, definition, workflow, phase, binding);
  const checkDefinitionsSha256 = checkDefinitionEvidence(phase, binding);
  const codeDeliverySha256 = codeDeliveryEvidence(definition, workflow, phase, binding);
  if (phase.approvalPolicy?.mode !== 'required' || !(phase.approvalPolicy.minimum >= 1)) {
    fail('SKP_AUTHORITY_UNKNOWN', `Skill phase '${phase.id}' requires at least one human approval.`);
  }
  const core = {
    schemaVersion: currentSchemaVersion('skp-phase-evidence'),
    snapshotHash: binding.snapshotHash,
    skillId: binding.skillId,
    packageSha256: binding.packageSha256,
    contractSha256: binding.contractSha256,
    compilationSha256: binding.compilationSha256,
    inputRecordSha256: inputs.inputRecordSha256,
    inputSetSha256: inputs.inputSetSha256,
    outputSetSha256: outputs.outputSetSha256,
    checkDefinitionsSha256,
    codeDeliverySha256
  };
  return Object.freeze({ ...core, evidenceSha256: digest({ format: 'skp-phase-evidence/v1', ...core }) });
}

/** The immutable packet, rather than a mutable phase field, is the approval subject. */
export async function verifySkillPhaseApproval(root, definition, workflow, phase, submittedReview) {
  const current = await verifySkillPhasePublication(root, definition, workflow, phase);
  if (!current) return null;
  if (submittedReview?.phase !== phase.id
      || Number(submittedReview.generation) !== Number(phase.generation)
      || JSON.stringify(submittedReview.submissionEvidence?.skill ?? null) !== JSON.stringify(current)) {
    fail('STORY_REVIEW_EVIDENCE_STALE', `Skill phase '${phase.id}' evidence differs from its immutable submitted review packet.`);
  }
  return current;
}

/** A packet reader can check this self-seal before interpreting skill-specific fields. */
export function verifyStoredSkillEvidence(evidence) {
  if (evidence == null) return null;
  const stored = readRecord('skp-phase-evidence', evidence).record;
  const { evidenceSha256, ...core } = stored;
  if (!HASH.test(String(evidenceSha256 ?? ''))
      || evidenceSha256 !== digest({ format: 'skp-phase-evidence/v1', ...core })
      || !HASH.test(String(core.snapshotHash ?? ''))
      || !HASH.test(String(core.packageSha256 ?? ''))
      || !HASH.test(String(core.contractSha256 ?? ''))
      || !HASH.test(String(core.compilationSha256 ?? ''))
      || !HASH.test(String(core.inputSetSha256 ?? ''))
      || !HASH.test(String(core.outputSetSha256 ?? ''))
      || !HASH.test(String(core.checkDefinitionsSha256 ?? ''))) {
    fail('STORY_REVIEW_EVIDENCE_INVALID', 'Submitted skill evidence has an invalid identity or seal.');
  }
  return stored;
}
