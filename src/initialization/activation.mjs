import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import YAML from 'yaml';

import { branch, commitIsolated, gitCommonDir, head, identity } from '../git.mjs';
import { canonicalJson, recordSha256 } from '../records.mjs';
import { currentSchemaVersion } from '../schema-migrations.mjs';
import { withSubjectLock } from '../subject-lock.mjs';
import { captureSmartInitSnapshot } from './source-snapshot.mjs';
import {
  ensureSecureRepositoryDirectory, secureRepositoryPath, SingularityFlowError, writeJson
} from '../util.mjs';

function shaRecord(value, field) {
  const core = structuredClone(value);
  delete core[field];
  return `sha256:${recordSha256(core)}`;
}

function journalPath(root, proposalSha256) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'journals', 'init', `${proposalSha256.slice(7, 19)}.json`);
}

async function ensureTargets(root, files, descriptors) {
  for (const [index, file] of files.entries()) {
    const expected = descriptors[index];
    if (!expected || expected.path !== file.path || expected.bytes !== file.bytes.length) {
      throw new SingularityFlowError('Smart-init renderer no longer matches the proposal write set.', { code: 'INI_PROPOSAL_STALE' });
    }
    const actualSha256 = `sha256:${createHash('sha256').update(file.bytes).digest('hex')}`;
    if (expected.sha256 !== actualSha256) {
      throw new SingularityFlowError('Smart-init renderer bytes no longer match the reviewed proposal.', {
        code: 'INI_PROPOSAL_STALE',
        details: { path: file.path, expectedSha256: expected.sha256, actualSha256 }
      });
    }
    const target = await secureRepositoryPath(root, file.path, { label: 'Smart-init target' });
    if (expected.expectation === 'create' && target.exists) throw new SingularityFlowError(
      `Smart-init target now exists: ${file.path}. Regenerate and review the proposal.`,
      { code: 'INI_TARGET_CHANGED', details: { path: file.path } }
    );
  }
}

async function createExactTarget(root, relative, bytes, installed) {
  await ensureSecureRepositoryDirectory(root, path.posix.dirname(relative), {
    label: 'Smart-init target directory'
  });
  let handle;
  try {
    handle = await open(path.join(root, relative), 'wx', 0o644);
    // Once O_EXCL created the path, recovery owns it even if the following write is interrupted.
    installed.push(relative);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    if (error?.code === 'EEXIST') throw new SingularityFlowError(
      `Smart-init target appeared after review: ${relative}. Regenerate and review the proposal.`,
      { code: 'INI_TARGET_CHANGED', cause: error, details: { path: relative } }
    );
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function activateSmartInit(root, rendered, {
  confirmation, channel = 'terminal', allowUnavailableVerification = false
} = {}) {
  const { proposal, files } = rendered;
  if (confirmation !== proposal.proposalSha256) throw new SingularityFlowError(
    `Initialization confirmation must equal ${proposal.proposalSha256}.`,
    { code: confirmation ? 'INI_CONFIRMATION_MISMATCH' : 'INI_CONFIRMATION_REQUIRED', details: { proposalSha256: proposal.proposalSha256 } }
  );
  if (proposal.ambiguities.length) throw new SingularityFlowError(
    'Smart initialization has unresolved detection ambiguity; select an explicit candidate before activation.',
    { code: 'INI_DETECTION_AMBIGUOUS', details: { ambiguities: proposal.ambiguities } }
  );
  if (proposal.proof.readiness === 'unavailable' && !allowUnavailableVerification) throw new SingularityFlowError(
    'No structured verification command was established. Review the disclosed proof gap, then rerun with --allow-unavailable-verification if repository policy permits initialization.',
    { code: 'INI_VERIFICATION_UNAVAILABLE', details: { gaps: proposal.proof.gaps } }
  );
  if (proposal.governance.activationChannel !== 'local-confirmation') throw new SingularityFlowError(
    `Activation channel '${proposal.governance.activationChannel}' creates a proposal only; local activation was not authorized.`,
    { code: proposal.governance.activationChannel === 'review-proposal' ? 'INI_REVIEW_REQUIRED' : 'INI_CONFIRMATION_REQUIRED' }
  );

  return withSubjectLock(root, { kind: 'initialization', id: proposal.subject.repositoryFingerprint }, async () => {
    if (head(root) !== proposal.subject.baseCommit || `refs/heads/${branch(root)}` !== proposal.subject.checkedOutRef) {
      throw new SingularityFlowError('Repository revision or branch changed after smart-init detection. Regenerate and review the proposal.', { code: 'INI_PROPOSAL_STALE' });
    }
    const currentSnapshot = await captureSmartInitSnapshot(root);
    if (currentSnapshot.sourceManifestSha256 !== proposal.sourceManifestSha256
        || currentSnapshot.subject.repositoryFingerprint !== proposal.subject.repositoryFingerprint) {
      throw new SingularityFlowError(
        'A detector input or repository identity changed after smart-init review. Regenerate and confirm the new proposal.',
        {
          code: 'INI_PROPOSAL_STALE',
          details: {
            expectedSourceManifestSha256: proposal.sourceManifestSha256,
            actualSourceManifestSha256: currentSnapshot.sourceManifestSha256
          }
        }
      );
    }
    await ensureTargets(root, files, proposal.writeSet);
    const actor = identity(root, { offline: true });
    if (!actor.email) throw new SingularityFlowError(
      'Smart-init activation requires a configured Git email. Run git config user.name and git config user.email, then regenerate the proposal.',
      { code: 'INI_CONFIRMATION_REQUIRED' }
    );
    const prefix = proposal.proposalSha256.slice(7, 19);
    const receiptPath = `singularity/receipts/initialization/${prefix}.json`;
    const receiptCore = {
      schemaVersion: currentSchemaVersion('smart-init-activation'), kind: 'smart-init-activation',
      proposalSha256: proposal.proposalSha256,
      sourceManifestSha256: proposal.sourceManifestSha256,
      writeSetSha256: proposal.writeSetSha256,
      subject: proposal.subject,
      decision: {
        status: 'accepted', actor: { kind: 'configured-local', id: actor.email }, channel,
        confirmation: proposal.proposalSha256,
        acceptedSuggestionIds: proposal.selectedSuggestionIds,
        declinedSuggestionIds: proposal.declinedSuggestionIds
      },
      installed: {
        configurationSha256: proposal.proposedConfigurationSha256,
        originMapSha256: proposal.writeSet.find((entry) => entry.role === 'configuration-origin')?.sha256 ?? null,
        presetSha256: proposal.preset.sha256,
        assetManifestSha256: proposal.preset.assetManifestSha256
      },
      capability: proposal.capability,
      proof: {
        profile: proposal.proof.profile, readiness: proposal.proof.readiness,
        gapIds: proposal.proof.gaps.map((entry) => entry.id)
      },
      telemetry: { modelInvocations: 0, repositoryCommandsExecuted: 0, networkOperations: 0 },
      git: {
        baseCommit: proposal.subject.baseCommit, activationCommit: null,
        branch: proposal.subject.checkedOutRef.slice('refs/heads/'.length), publication: 'local'
      },
      activatedAt: new Date().toISOString()
    };
    const receipt = { ...receiptCore, receiptSha256: shaRecord(receiptCore, 'receiptSha256') };
    const journalWriteSet = [...proposal.writeSet, {
      path: receiptPath, role: 'activation-receipt', bytes: Buffer.byteLength(canonicalJson(receipt)),
      sha256: `sha256:${recordSha256(receipt)}`, expectation: 'create'
    }];
    const journal = journalPath(root, proposal.proposalSha256);
    await mkdir(path.dirname(journal), { recursive: true });
    await writeJson(journal, {
      schemaVersion: currentSchemaVersion('smart-init-activation-journal'), kind: 'smart-init-activation-journal', status: 'planned',
      proposalSha256: proposal.proposalSha256, baseCommit: proposal.subject.baseCommit,
      checkedOutRef: proposal.subject.checkedOutRef,
      writeSet: journalWriteSet
    });
    const installed = [];
    try {
      for (const file of files) {
        await createExactTarget(root, file.path, file.bytes, installed);
      }
      await createExactTarget(root, receiptPath, Buffer.from(canonicalJson(receipt), 'utf8'), installed);

      // Validate the complete candidate only after every byte is present and before Git authority
      // advances. A parse failure rolls every managed path back to its fresh-repository preimage.
      const definition = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
      const { validateDefinition } = await import('../config.mjs');
      validateDefinition(definition);
      await writeJson(journal, {
        schemaVersion: currentSchemaVersion('smart-init-activation-journal'), kind: 'smart-init-activation-journal', status: 'validated',
        proposalSha256: proposal.proposalSha256, baseCommit: proposal.subject.baseCommit,
        checkedOutRef: proposal.subject.checkedOutRef, writeSet: journalWriteSet, installed
      });
      const commit = await commitIsolated(
        root,
        `[initialization] activate ${proposal.proposalSha256.slice(7, 19)}`,
        installed,
        { expectedHead: proposal.subject.baseCommit, expectedRef: proposal.subject.checkedOutRef }
      );
      await writeJson(journal, {
        schemaVersion: currentSchemaVersion('smart-init-activation-journal'), kind: 'smart-init-activation-journal', status: 'complete',
        proposalSha256: proposal.proposalSha256, baseCommit: proposal.subject.baseCommit,
        checkedOutRef: proposal.subject.checkedOutRef, activationCommit: commit, writeSet: journalWriteSet, installed
      });
      return {
        status: 'activated', proposalSha256: proposal.proposalSha256,
        activationReceipt: receiptPath, activationReceiptSha256: receipt.receiptSha256,
        activationCommit: commit, capability: proposal.capability,
        proofReadiness: proposal.proof.readiness,
        nextCommand: 'singularity-flow precheck --quick'
      };
    } catch (error) {
      // Ref advancement is the authority boundary. If it did not advance, every target was expected
      // absent and can be restored exactly by deleting only this proposal's declared paths.
      if (head(root) === proposal.subject.baseCommit) {
        for (const relative of [...installed].reverse()) await rm(path.join(root, relative), { recursive: false, force: true }).catch(() => {});
        await writeJson(journal, {
          schemaVersion: currentSchemaVersion('smart-init-activation-journal'), kind: 'smart-init-activation-journal', status: 'rolled-back',
          proposalSha256: proposal.proposalSha256, baseCommit: proposal.subject.baseCommit,
          checkedOutRef: proposal.subject.checkedOutRef, writeSet: journalWriteSet,
          errorCode: error?.code ?? 'INI_ACTIVATION_FAILED'
        }).catch(() => {});
      }
      if (error instanceof SingularityFlowError) throw error;
      throw new SingularityFlowError(`Smart initialization failed and the managed paths were restored: ${error.message}`, {
        code: 'INI_ACTIVATION_FAILED', cause: error
      });
    }
  });
}
