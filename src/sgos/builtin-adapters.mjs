/**
 * Closed, model-free SGOS adapters that are safe to expose through the CLI.
 *
 * These adapters are deliberately read-only. They prove that the public process surface can run a
 * real governed operation through separate execution, candidate-capture, and verification
 * boundaries without granting the SGOS sidecar authority to mutate Story or Git state.
 */
import { changes, head } from '../git.mjs';
import { SingularityFlowError } from '../util.mjs';
import { sgosSha256 } from './evidence.mjs';
import {
  assertSgosStoryAuthority,
  assertSgosWorkingStoryMatchesAuthority,
  loadSgosStoryAuthority
} from './story-authority.mjs';

const MANIFESTS = Object.freeze({
  'sflow.story.inspect': Object.freeze({
    id: 'sflow.story.inspect', version: '2', kind: 'kernel', effects: 'read-only'
  }),
  'sflow.story.inspect.verify': Object.freeze({
    id: 'sflow.story.inspect.verify', version: '2', kind: 'verifier', effects: 'read-only'
  }),
  'sflow.repository.assert-clean': Object.freeze({
    id: 'sflow.repository.assert-clean', version: '1', kind: 'kernel', effects: 'read-only'
  }),
  'sflow.repository.assert-clean.verify': Object.freeze({
    id: 'sflow.repository.assert-clean.verify', version: '1', kind: 'verifier', effects: 'read-only'
  })
});

function withDigest(manifest) {
  return Object.freeze({ ...manifest, manifestSha256: sgosSha256({ kind: 'sgos-operation-manifest', ...manifest }) });
}

export const SGOS_BUILTIN_OPERATION_MANIFESTS = Object.freeze(
  Object.fromEntries(Object.entries(MANIFESTS).map(([id, manifest]) => [id, withDigest(manifest)]))
);

function fail(message, code, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function operationId(template) {
  return typeof template?.operation === 'string' ? template.operation : template?.operation?.id;
}

function verificationOperationId(template) {
  const verification = template?.metadata?.verification ?? template?.verification;
  if (typeof verification === 'string') return verification;
  return typeof verification?.operation === 'string'
    ? verification.operation
    : verification?.operation?.id ?? verification?.operationId;
}

function assertManifest(template, id, { verification = false } = {}) {
  const manifest = SGOS_BUILTIN_OPERATION_MANIFESTS[id];
  if (!manifest) fail(`SGOS operation '${id}' is not a built-in adapter.`, 'SGOS_ADAPTER_UNAVAILABLE');
  const metadata = template?.metadata ?? {};
  const version = verification
    ? metadata.verificationOperationVersion
    : metadata.operationVersion;
  const digest = verification
    ? metadata.verificationOperationManifestSha256
    : metadata.operationManifestSha256;
  if (version !== manifest.version || digest !== manifest.manifestSha256) {
    fail(`SGOS operation '${id}' is not bound to the installed reviewed adapter manifest.`,
      'SGOS_ADAPTER_MANIFEST_MISMATCH', {
        operationId: id,
        expectedVersion: manifest.version,
        receivedVersion: version ?? null,
        expectedManifestSha256: manifest.manifestSha256,
        receivedManifestSha256: digest ?? null
      });
  }
  return manifest;
}

async function storyObservation(root, process) {
  const subjectId = process?.authorityBinding?.subjectId;
  const pinned = process?.authorityBinding?.subjectAuthority;
  if (!pinned || pinned.revision !== process?.authorityBinding?.baselineRevision) {
    fail('The SGOS Process does not carry an exact governed Story authority.',
      'SGOS_STORY_AUTHORITY_MISMATCH');
  }
  const observed = loadSgosStoryAuthority(root, {
    subjectId,
    revision: pinned.revision
  });
  assertSgosStoryAuthority(pinned, observed.authority);
  assertSgosWorkingStoryMatchesAuthority(root, observed.authority, observed.stateSourceSha256);
  const { state } = observed;
  const canonicalBranch = String(
    state.lineage?.canonicalBranch ?? state.workItem?.branch ?? subjectId
  ).trim();
  return Object.freeze({
    workId: subjectId,
    branch: canonicalBranch,
    status: state.status ?? null,
    currentPhase: state.currentPhase ?? null,
    stateRevision: observed.authority.revision,
    statePath: observed.authority.path,
    stateBlobSha256: observed.authority.blobSha256,
    stateSourceSha256: observed.stateSourceSha256,
    storySha256: observed.authority.stateSha256
  });
}

async function inspectStory(root, context) {
  assertManifest(context.template, operationId(context.template));
  const observed = await storyObservation(root, context.process);
  return {
    outputRefs: [observed.storySha256, observed.stateSourceSha256],
    // Read-only is established by the pinned manifest, empty Candidate Snapshot, and independent
    // verifier. Do not compare the Process pre-state and Candidate post-state as one resource.
    rawResult: { status: 'completed', ...observed }
  };
}

async function verifyStory(root, context) {
  const id = verificationOperationId(context.template);
  assertManifest(context.template, id, { verification: true });
  const observed = await storyObservation(root, context.process);
  const raw = context.rawResult ?? {};
  const passed = raw.storySha256 === observed.storySha256
    && raw.workId === observed.workId
    && raw.stateRevision === observed.stateRevision
    && raw.statePath === observed.statePath
    && raw.stateBlobSha256 === observed.stateBlobSha256
    && raw.stateSourceSha256 === observed.stateSourceSha256
    && context.candidateSnapshot?.resources?.length === 0;
  return {
    status: passed ? 'passed' : 'failed',
    candidateSha256: context.candidateSha256,
    checks: {
      operationId: id,
      observedStorySha256: observed.storySha256,
      handlerStorySha256: raw.storySha256 ?? null,
      stateRevision: observed.stateRevision,
      statePath: observed.statePath,
      stateBlobSha256: observed.stateBlobSha256,
      stateSourceSha256: observed.stateSourceSha256,
      candidateIsReadOnly: context.candidateSnapshot?.resources?.length === 0
    }
  };
}

function repositoryObservation(root) {
  const porcelain = changes(root);
  return Object.freeze({
    head: head(root),
    clean: porcelain.length === 0,
    statusSha256: sgosSha256({ kind: 'sgos-repository-status', porcelain })
  });
}

async function assertRepositoryClean(root, context) {
  assertManifest(context.template, operationId(context.template));
  const observed = repositoryObservation(root);
  if (!observed.clean) {
    fail('The repository has application or governance changes outside the SGOS sidecar.',
      'SGOS_REPOSITORY_NOT_CLEAN', { statusSha256: observed.statusSha256 });
  }
  return {
    outputRefs: [observed.statusSha256],
    rawResult: { status: 'completed', ...observed }
  };
}

async function verifyRepositoryClean(root, context) {
  const id = verificationOperationId(context.template);
  assertManifest(context.template, id, { verification: true });
  const observed = repositoryObservation(root);
  const raw = context.rawResult ?? {};
  const passed = observed.clean
    && raw.head === observed.head
    && raw.statusSha256 === observed.statusSha256
    && context.candidateSnapshot?.resources?.length === 0;
  return {
    status: passed ? 'passed' : 'failed',
    candidateSha256: context.candidateSha256,
    checks: {
      operationId: id,
      clean: observed.clean,
      headMatches: raw.head === observed.head,
      statusMatches: raw.statusSha256 === observed.statusSha256,
      candidateIsReadOnly: context.candidateSnapshot?.resources?.length === 0
    }
  };
}

async function captureReadOnlyCandidate(context) {
  const id = operationId(context.template);
  assertManifest(context.template, id);
  return { resources: [], createdBy: { id: `builtin:${id}`, kind: 'system' } };
}

/** Return fresh maps so callers cannot mutate a shared adapter registry. */
export function createSgosBuiltinAdapters(root) {
  return Object.freeze({
    handlers: Object.freeze({
      kernel: Object.freeze({
        'sflow.story.inspect': (context) => inspectStory(root, context),
        'sflow.repository.assert-clean': (context) => assertRepositoryClean(root, context)
      })
    }),
    captureCandidates: Object.freeze({
      'sflow.story.inspect': captureReadOnlyCandidate,
      'sflow.repository.assert-clean': captureReadOnlyCandidate
    }),
    verifiers: Object.freeze({
      'sflow.story.inspect.verify': (context) => verifyStory(root, context),
      'sflow.repository.assert-clean.verify': (context) => verifyRepositoryClean(root, context)
    })
  });
}
