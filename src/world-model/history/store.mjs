import { run, SingularityFlowError } from '../../util.mjs';
import { canonicalJson, compareText, isPlainRecord, sha256 } from '../canonicalize.mjs';
import {
  validateDerivationCatalog, validateHistoricalDerivationCatalog
} from '../extract/derivation-catalog.mjs';
import { validateEvidenceCatalog } from '../extract/evidence-catalog.mjs';
import { validateFactLedger, validateHistoricalFactLedger } from '../extract/fact-ledger.mjs';
import {
  resolveExtractorExecutionContract, validateExtractorRegistry
} from '../registry/extractors.mjs';
import { classifyScopePath, pathInsideScope } from '../scope/matcher.mjs';
import {
  WMP_CANDIDATE_EXCLUSION_REASONS
} from './candidate-roster-owner.mjs';
import {
  parseCanonicalWmpRecordBytes,
  validateWmpModelBinding, validateWmpViewBinding
} from './contracts.mjs';
import { WMP_MAXIMUM_OBJECT_BYTES } from './identity.mjs';
import {
  DEFAULT_WORLD_MODEL_HISTORY_DIR, validateWorldModelHistoryRoots,
  worldModelHistoryModelPath, worldModelHistoryObjectPath, worldModelHistoryViewPath
} from './paths.mjs';
import {
  parseExactRetainedObject, validateRetainedObjectReference
} from './retained-object.mjs';
import {
  WMP_EMPTY_EXTRACTOR_CONFIGURATION_SHA256
} from './extraction-profile-owners.mjs';
import { runWorldModelHistoryGitRead } from './git-read.mjs';
import {
  assertAcyclicWorldModelHistoryClosure, collectWorldModelHistoryObjectRefs,
  createWorldModelHistoryClosureBudget
} from './closure-walk.mjs';

const OBJECT_REF_KEYS = Object.freeze(['bytes', 'family', 'mediaType', 'role', 'sha256']);
const MAXIMUM_CLOSURE_OBJECTS = 100_000;
const MAXIMUM_CLOSURE_BYTES = 256 * 1024 * 1024;
const AUTHORITY_REF_PATTERN = /^refs\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const UNOWNED_RETAINED_ROLES = new Set([
  'admission-proof',
  'adoption-authorization',
  'origin-authority',
  'publication-receipt',
  'renderer-contract',
  'source-authority',
  'target-authority',
  'tokenizer',
  'validator-contract'
]);

function fail(message, code, details = {}, cause = undefined) {
  throw new SingularityFlowError(message, { code, details, cause });
}

function exactAuthorityRef(value) {
  const ref = String(value ?? '').trim();
  if (!AUTHORITY_REF_PATTERN.test(ref) || ref.includes('..') || ref.includes('//')
      || ref.endsWith('/') || ref.endsWith('.lock') || ref.includes('@{')) {
    fail('Persisted World-model reads require an admitted configured state-authority ref.',
      'WMP_AUTHORITY_CUT_REQUIRED', { authorityRef: ref || null });
  }
  return ref;
}

/**
 * Select a full local commit which is proven reachable from the admitted state-authority ref.
 * Mere object-store presence is insufficient: application or dangling commits are not WMP
 * authority cuts, even when an attacker knows their full object ID.
 */
export function resolveWorldModelHistoryAuthority(root, authorityCommit, {
  authorityRef, env = process.env, runCommand = run
} = {}) {
  const requested = String(authorityCommit ?? '').trim().toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(requested)) {
    fail('Persisted World-model reads require an exact full authority commit.',
      'WMP_AUTHORITY_CUT_REQUIRED', { authorityCommit: requested || null });
  }
  const admittedRef = exactAuthorityRef(authorityRef);
  const refResult = runWorldModelHistoryGitRead(root, [
    'rev-parse', '--verify', `${admittedRef}^{commit}`
  ], { env, runCommand, operation: 'authority-tip' });
  const authorityTip = refResult.status === 0
    ? String(refResult.stdout).trim().toLowerCase() : null;
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(authorityTip ?? '')) {
    fail('The configured World-model state-authority ref is not available locally.',
      'WMP_AUTHORITY_REFRESH_REQUIRED', {
        authorityCommit: requested, authorityRef: admittedRef
      });
  }
  const result = runWorldModelHistoryGitRead(root, [
    'rev-parse', '--verify', `${requested}^{commit}`
  ], { env, runCommand, operation: 'authority-commit' });
  const resolved = result.status === 0 ? String(result.stdout).trim().toLowerCase() : null;
  if (resolved !== requested) {
    fail('The selected World-model authority commit is not available in the local Git object store.',
      'WMP_AUTHORITY_REFRESH_REQUIRED', { authorityCommit: requested });
  }
  const admitted = runWorldModelHistoryGitRead(root, [
    'merge-base', '--is-ancestor', requested, authorityTip
  ], { env, runCommand, operation: 'authority-ancestry' });
  if (admitted.status !== 0) {
    fail(
      'The selected World-model commit is not an admitted cut of the configured state authority.',
      admitted.status === 1 ? 'WMP_AUTHORITY_CUT_NOT_ADMITTED' : 'WMP_AUTHORITY_UNAVAILABLE',
      { authorityCommit: requested, authorityRef: admittedRef, authorityTip }
    );
  }
  return requested;
}

function readExactBlob(root, commit, relativePath, {
  missingCode = 'WMP_INPUT_MISSING', env = process.env, runCommand = run
} = {}) {
  const listed = runWorldModelHistoryGitRead(root, [
    'ls-tree', '-z', commit, '--', relativePath
  ], { env, runCommand, operation: 'history-path' });
  if (listed.status !== 0) {
    fail(`World-model history could not inspect '${relativePath}'.`,
      'WMP_AUTHORITY_UNAVAILABLE', { authorityCommit: commit, path: relativePath });
  }
  const rows = String(listed.stdout ?? '').split('\0').filter(Boolean).filter((row) => {
    const tab = row.indexOf('\t');
    return tab >= 0 && row.slice(tab + 1) === relativePath;
  });
  if (!rows.length) {
    fail(`World-model history object is missing: ${relativePath}.`, missingCode, {
      authorityCommit: commit, path: relativePath
    });
  }
  if (rows.length !== 1) {
    fail(`World-model history path is ambiguous: ${relativePath}.`,
      'WMP_INTEGRITY_FAILED', { authorityCommit: commit, path: relativePath });
  }
  const tab = rows[0].indexOf('\t');
  const [mode, type, oid] = rows[0].slice(0, tab).split(/\s+/);
  if (mode !== '100644' || type !== 'blob' || !/^[a-f0-9]{40,64}$/i.test(oid ?? '')) {
    fail(`World-model history path is not an immutable regular blob: ${relativePath}.`,
      'WMP_INTEGRITY_FAILED', { authorityCommit: commit, path: relativePath, mode, type });
  }
  const sizeResult = runWorldModelHistoryGitRead(root, [
    'cat-file', '-s', oid
  ], { env, runCommand, operation: 'history-object-size' });
  const size = sizeResult.status === 0 ? Number(String(sizeResult.stdout).trim()) : NaN;
  if (!Number.isSafeInteger(size) || size < 1 || size > WMP_MAXIMUM_OBJECT_BYTES) {
    fail(`World-model history object has an invalid size: ${relativePath}.`,
      'WMP_INTEGRITY_FAILED', {
        authorityCommit: commit, path: relativePath,
        bytes: Number.isFinite(size) ? size : null,
        maximumBytes: WMP_MAXIMUM_OBJECT_BYTES
      });
  }
  const shown = runWorldModelHistoryGitRead(root, ['cat-file', 'blob', oid], {
    env, runCommand, operation: 'history-object-bytes',
    encoding: 'buffer', maxBuffer: size + 1024
  });
  const bytes = Buffer.isBuffer(shown.stdout) ? shown.stdout : Buffer.from(shown.stdout ?? '', 'utf8');
  if (shown.status !== 0 || bytes.length !== size) {
    fail(`World-model history object bytes are unavailable: ${relativePath}.`,
      'WMP_AUTHORITY_UNAVAILABLE', { authorityCommit: commit, path: relativePath, oid });
  }
  return Object.freeze({ path: relativePath, oid, bytes, sha256: sha256(bytes) });
}

function exactObjectRef(value) {
  return isPlainRecord(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(OBJECT_REF_KEYS);
}

function collectObjectRefs(value, budget, baseDepth = 0) {
  return collectWorldModelHistoryObjectRefs(value, {
    exactObjectRef,
    validateObjectRef: validateRetainedObjectReference,
    isObjectContainer: isPlainRecord,
    budget,
    baseDepth
  });
}

function retainedOwnerUnavailable(ref) {
  return new SingularityFlowError(
    `Retained role '${ref.role}' has no installed semantic owner contract.`,
    {
      code: 'WMP_OBJECT_OWNER_UNAVAILABLE',
      details: { role: ref.role, family: ref.family }
    }
  );
}

function roleRef(values, role, label) {
  const ref = values.find((entry) => entry.role === role);
  if (!ref) {
    fail(`${label} is missing retained role '${role}'.`, 'WMP_INPUT_ROLE_MISSING', {
      label, role
    });
  }
  return ref;
}

function resolvedRecord(closure, ref) {
  return closure.get(ref.sha256)?.record ?? null;
}

function graphMismatch(message, details = {}) {
  fail(message, 'WMP_GRAPH_MISMATCH', details);
}

function requireDigest(actual, expected, relation) {
  if (actual !== expected) {
    graphMismatch(`Persisted World-model graph mismatch: ${relation}.`, {
      relation, expected, received: actual ?? null
    });
  }
}

function validateGraphOwner(relation, operation) {
  try { return operation(); }
  catch (error) {
    graphMismatch(`Persisted World-model graph failed '${relation}' validation.`, {
      relation,
      causeCode: error?.code ?? null,
      causeMessage: error?.message ?? String(error)
    });
  }
}

function extractorMajor(version) {
  const major = Number(String(version ?? '').split('.')[0]);
  return Number.isSafeInteger(major) && major > 0 ? major : null;
}

function modelExtractorCoverage(completeness, extractor) {
  if (extractor.coverage === 'global') {
    const outcome = completeness.globalOutcomes.find(
      (entry) => entry.id === extractor.id && entry.version === extractor.version
    );
    if (!outcome) return null;
    return {
      status: outcome.status === 'processed' ? 'complete'
        : outcome.status === 'failed' ? 'unavailable' : 'partial',
      processedPaths: 0
    };
  }
  const outcomes = completeness.pathOutcomes
    .filter((entry) => entry.status !== 'excluded')
    .map((entry) => entry.extractors.find(
      (candidate) => candidate.id === extractor.id && candidate.version === extractor.version
    ));
  if (outcomes.some((entry) => !entry)) return null;
  const statuses = new Set(outcomes.map((entry) => entry.status));
  return {
    status: statuses.has('failed') ? 'unavailable'
      : statuses.has('partial') || statuses.has('unsupported') ? 'partial' : 'complete',
    processedPaths: outcomes.filter(
      (entry) => entry.status === 'processed' || entry.status === 'partial'
    ).length
  };
}

function requiredFactOutcome(factType, facts) {
  const candidates = facts.filter(
    (fact) => fact.factType === factType && fact.status !== 'stale'
  );
  if (!candidates.length) return null;
  const statuses = new Set(candidates.map((fact) => fact.status));
  if (statuses.has('contradicted')) {
    return { id: factType, status: 'contradicted', reasonCode: 'CONTRADICTED_FACTS' };
  }
  if (statuses.has('partial')) {
    return { id: factType, status: 'partial', reasonCode: 'PARTIAL_FACTS' };
  }
  if (statuses.has('available')) {
    return { id: factType, status: 'available', reasonCode: null };
  }
  const reasons = [...new Set(candidates.map((fact) => fact.reason?.code).filter(Boolean))]
    .sort(compareText);
  return {
    id: factType,
    status: 'unavailable',
    reasonCode: reasons.length === 1 ? reasons[0] : 'MULTIPLE_UNAVAILABLE_REASONS'
  };
}

function validateCompletenessSourceCoverage(
  sourceSnapshot, scope, completeness, candidateRoster = null
) {
  const sourceFiles = new Map(sourceSnapshot.files.map((entry) => [entry.path, entry]));
  const rosterSelected = new Map();
  const rosterExcluded = new Map();
  if (candidateRoster) {
    for (const candidate of candidateRoster.candidates) {
      const classification = classifyScopePath(candidate.path, scope);
      const expectedStatus = classification.status === 'inside' ? 'selected' : 'excluded';
      const expectedReason = classification.status === 'inside'
        ? null : WMP_CANDIDATE_EXCLUSION_REASONS[classification.status];
      if (candidate.status !== expectedStatus || candidate.reasonCode !== expectedReason) {
        graphMismatch(
          `Persisted World-model Candidate Roster misclassifies '${candidate.path}'.`,
          {
            relation: 'candidate-roster.scope-classification',
            path: candidate.path,
            expectedStatus,
            expectedReason,
            receivedStatus: candidate.status,
            receivedReason: candidate.reasonCode
          }
        );
      }
      (candidate.status === 'selected' ? rosterSelected : rosterExcluded)
        .set(candidate.path, candidate);
    }
    if (rosterSelected.size !== sourceFiles.size) {
      graphMismatch(
        'Persisted World-model Candidate Roster does not select the exact Source Snapshot roster.',
        {
          relation: 'candidate-roster.selected-source-paths',
          expectedPaths: sourceFiles.size,
          receivedPaths: rosterSelected.size
        }
      );
    }
    for (const [relative, source] of sourceFiles) {
      const candidate = rosterSelected.get(relative);
      if (!candidate || candidate.type !== source.type || candidate.mode !== source.mode
          || candidate.contentSha256 !== source.contentSha256
          || candidate.bytes !== source.bytes) {
        graphMismatch(
          `Persisted World-model Candidate Roster does not bind selected source bytes for '${relative}'.`,
          {
            relation: 'candidate-roster.selected-source-content',
            path: relative,
            expected: {
              type: source.type,
              mode: source.mode,
              contentSha256: source.contentSha256,
              bytes: source.bytes
            },
            received: candidate ? {
              type: candidate.type,
              mode: candidate.mode,
              contentSha256: candidate.contentSha256,
              bytes: candidate.bytes
            } : null
          }
        );
      }
    }
  }
  const accounted = completeness.pathOutcomes.filter((entry) => entry.status !== 'excluded');
  if (accounted.length !== sourceFiles.size) {
    graphMismatch(
      'Persisted World-model Completeness Record does not account for every exact source path.',
      {
        relation: 'completeness.source-paths',
        expectedPaths: sourceFiles.size,
        receivedPaths: accounted.length
      }
    );
  }
  for (const outcome of accounted) {
    if (scope && !pathInsideScope(outcome.path, scope)) {
      graphMismatch(
        `Persisted World-model Completeness Record processes out-of-scope path '${outcome.path}'.`,
        { relation: 'completeness.scope', path: outcome.path }
      );
    }
    const source = sourceFiles.get(outcome.path);
    if (!source || source.contentSha256 !== outcome.sourceContentSha256) {
      graphMismatch(
        `Persisted World-model Completeness Record does not bind exact source bytes for '${outcome.path}'.`,
        {
          relation: 'completeness.source-content',
          path: outcome.path,
          expected: source?.contentSha256 ?? null,
          received: outcome.sourceContentSha256
        }
      );
    }
    sourceFiles.delete(outcome.path);
  }
  if (sourceFiles.size) {
    graphMismatch(
      'Persisted World-model Completeness Record omits exact source paths.',
      {
        relation: 'completeness.source-paths',
        omittedPaths: [...sourceFiles.keys()].sort(compareText).slice(0, 100),
        omitted: Math.max(0, sourceFiles.size - 100)
      }
    );
  }
  const excludedOutcomes = completeness.pathOutcomes.filter(
    (entry) => entry.status === 'excluded'
  );
  if (!candidateRoster && excludedOutcomes.length) {
    const unprovedExclusion = excludedOutcomes[0];
    graphMismatch(
      `Persisted World-model Completeness Record claims unproved excluded path '${unprovedExclusion.path}'.`,
      {
        relation: 'completeness.excluded-source-roster',
        path: unprovedExclusion.path
      }
    );
  }
  if (candidateRoster) {
    if (excludedOutcomes.length !== rosterExcluded.size) {
      graphMismatch(
        'Persisted World-model Completeness Record exclusions do not cover the owned Candidate Roster.',
        {
          relation: 'completeness.excluded-source-roster',
          expectedPaths: rosterExcluded.size,
          receivedPaths: excludedOutcomes.length
        }
      );
    }
    const remaining = new Map(rosterExcluded);
    for (const outcome of excludedOutcomes) {
      const candidate = remaining.get(outcome.path);
      if (!candidate || outcome.reasonCode !== candidate.reasonCode) {
        graphMismatch(
          `Persisted World-model Completeness Record exclusion '${outcome.path}' is not proved by its Candidate Roster.`,
          {
            relation: 'completeness.excluded-source-roster',
            path: outcome.path,
            expectedReason: candidate?.reasonCode ?? null,
            receivedReason: outcome.reasonCode
          }
        );
      }
      remaining.delete(outcome.path);
    }
    if (remaining.size) {
      graphMismatch(
        'Persisted World-model Completeness Record omits discovered excluded candidates.',
        {
          relation: 'completeness.excluded-source-roster',
          omittedPaths: [...remaining.keys()].sort(compareText).slice(0, 100),
          omitted: Math.max(0, remaining.size - 100)
        }
      );
    }
  }
}

function validateModelBindingGraph(binding, closure, { currentExtractorAdmission = false } = {}) {
  const sourceBinding = binding.inputDescriptors.sourceBinding;
  const repositoryDomain = resolvedRecord(closure, sourceBinding.repositoryDomainRef);
  if (repositoryDomain) requireDigest(
    repositoryDomain.repositoryDomainSha256,
    binding.inputs.repositoryDomainSha256,
    'Repository Domain does not match ModelInputs.repositoryDomainSha256'
  );
  const sourceSnapshot = resolvedRecord(closure, sourceBinding.sourceSnapshotRef);
  if (sourceSnapshot) {
    requireDigest(
      sourceSnapshot.sourceManifestSha256,
      binding.inputs.sourceManifestSha256,
      'source snapshot does not match ModelInputs.sourceManifestSha256'
    );
    if (sourceBinding.sourceKind === 'committed'
        && sourceSnapshot.revision.commit !== sourceBinding.effectiveRevision) {
      graphMismatch('Persisted World-model graph mismatch: committed source revision differs from the retained snapshot.', {
        relation: 'source-binding.effective-revision',
        expected: sourceBinding.effectiveRevision,
        received: sourceSnapshot.revision.commit
      });
    }
  }

  const scopeRef = roleRef(binding.inputObjects, 'scope-manifest', 'WMP Model Binding inputObjects');
  const scope = resolvedRecord(closure, scopeRef);
  if (scope) requireDigest(
    scope.scopeSha256,
    binding.inputs.scopeManifestSha256,
    'scope manifest does not match ModelInputs.scopeManifestSha256'
  );
  if (sourceSnapshot && scope && sourceSnapshot.subject.id !== scope.capabilityId) {
    graphMismatch('Persisted World-model source subject does not match its exact capability scope.', {
      relation: 'source-snapshot.scope-subject',
      expected: scope.capabilityId,
      received: sourceSnapshot.subject.id
    });
  }

  const candidateCaptures = binding.inputDescriptors.extractionInputs.captures.filter(
    (entry) => entry.role === 'candidate-roster'
  );
  const candidateObjectRefs = binding.inputObjects.filter(
    (entry) => entry.role === 'candidate-roster'
  );
  if (candidateCaptures.length > 1 || candidateObjectRefs.length > 1) {
    graphMismatch('Persisted World-model graph repeats Candidate Roster authority.', {
      relation: 'candidate-roster.capture',
      captures: candidateCaptures.length,
      objects: candidateObjectRefs.length
    });
  }
  const candidateCapture = candidateCaptures[0] ?? null;
  const candidateObjectRef = candidateObjectRefs[0] ?? null;
  if (candidateObjectRef && (!candidateCapture || candidateCapture.status !== 'available'
      || canonicalJson(candidateCapture.objectRef) !== canonicalJson(candidateObjectRef))) {
    graphMismatch(
      'Persisted World-model Candidate Roster object is not its exact available extraction input.',
      { relation: 'candidate-roster.capture' }
    );
  }
  if (candidateCapture?.status === 'available' && !candidateObjectRef) {
    graphMismatch('Persisted World-model Candidate Roster capture has no retained input object.', {
      relation: 'candidate-roster.capture'
    });
  }
  if (candidateCapture?.status === 'available' && sourceSnapshot
      && candidateCapture.subject !== sourceSnapshot.subject.id) {
    graphMismatch('Persisted World-model Candidate Roster subject differs from its source.', {
      relation: 'candidate-roster.subject',
      expected: sourceSnapshot.subject.id,
      received: candidateCapture.subject
    });
  }
  const candidateRoster = candidateObjectRef
    ? resolvedRecord(closure, candidateObjectRef) : null;
  if (candidateRoster) {
    requireDigest(
      candidateRoster.sourceManifestSha256,
      binding.inputs.sourceManifestSha256,
      'Candidate Roster source does not match ModelInputs'
    );
    requireDigest(
      candidateRoster.scopeManifestSha256,
      binding.inputs.scopeManifestSha256,
      'Candidate Roster scope does not match ModelInputs'
    );
    if (sourceSnapshot && candidateRoster.source.commit !== sourceSnapshot.revision.commit) {
      graphMismatch('Persisted World-model Candidate Roster commit differs from its source.', {
        relation: 'candidate-roster.source-commit',
        expected: sourceSnapshot.revision.commit,
        received: candidateRoster.source.commit
      });
    }
    if (candidateRoster.source.gitObjectFormat
        !== binding.inputDescriptors.sourceBinding.gitObjectFormat) {
      graphMismatch('Persisted World-model Candidate Roster Git format differs from its source.', {
        relation: 'candidate-roster.git-object-format',
        expected: binding.inputDescriptors.sourceBinding.gitObjectFormat,
        received: candidateRoster.source.gitObjectFormat
      });
    }
  }

  const policy = resolvedRecord(closure,
    roleRef(binding.inputObjects, 'extraction-policy', 'WMP Model Binding inputObjects'));
  if (policy) requireDigest(
    policy.extractionPolicySha256,
    binding.inputs.extractionPolicySha256,
    'Extraction Policy does not match ModelInputs.extractionPolicySha256'
  );
  if (policy && scope && policy.policySnapshotSha256 !== scope.policySourceSha256) {
    graphMismatch(
      'Persisted World-model Extraction Policy does not originate from the exact policy sealed by its Scope Manifest.',
      {
        relation: 'extraction-policy.scope-policy-source',
        expected: scope.policySourceSha256,
        received: policy.policySnapshotSha256
      }
    );
  }

  const registry = resolvedRecord(closure,
    roleRef(binding.inputObjects, 'extractor-registry', 'WMP Model Binding inputObjects'));
  if (registry) requireDigest(
    registry.registrySha256,
    binding.inputs.extractorRegistrySha256,
    'Extractor Registry does not match ModelInputs.extractorRegistrySha256'
  );
  if (registry && currentExtractorAdmission) {
    validateGraphOwner('extractor-registry.current-admission', () => (
      validateExtractorRegistry(registry)
    ));
  }
  const registryByIdentity = new Map((registry?.manifests ?? []).map(
    (entry) => [`${entry.id}@${entry.version}`, entry]
  ));
  const registryByManifestSha256 = new Map((registry?.manifests ?? []).map(
    (entry) => [entry.manifestSha256, entry]
  ));
  const profileByManifestSha256 = new Map(
    binding.inputDescriptors.extractionProfile.extractors.map(
      (entry) => [entry.manifestSha256, entry]
    )
  );
  const policyByManifestSha256 = new Map((policy?.allowedExtractors ?? []).map(
    (entry) => [entry.manifestSha256, entry]
  ));
  if (registry && policy) {
    for (const allowed of policy.allowedExtractors) {
      const manifest = registryByIdentity.get(`${allowed.id}@${allowed.version}`);
      if (!manifest || manifest.manifestSha256 !== allowed.manifestSha256
          || manifest.producer.implementationSha256 !== allowed.implementationSha256) {
        graphMismatch('Persisted World-model Extraction Policy is not backed by its retained Extractor Registry.', {
          relation: 'extraction-policy.extractor-registry',
          extractor: `${allowed.id}@${allowed.version}`
        });
      }
      if (currentExtractorAdmission) {
        const executionContract = validateGraphOwner(
          'extraction-policy.current-execution-contract',
          () => resolveExtractorExecutionContract(manifest)
        );
        if (allowed.coverage !== executionContract.coverage) {
          graphMismatch(
            'Persisted World-model Extraction Policy relabels the installed extractor execution boundary.',
            {
              relation: 'extraction-policy.execution-coverage',
              extractor: `${allowed.id}@${allowed.version}`,
              expected: executionContract.coverage,
              received: allowed.coverage
            }
          );
        }
      }
    }
    for (const reference of policy.factSemantics.coverageExtractorRefs) {
      const manifest = registryByIdentity.get(reference);
      const selected = manifest
        ? profileByManifestSha256.get(manifest.manifestSha256)
        : null;
      if (!manifest || !selected) {
        graphMismatch(
          'Persisted World-model Extraction Policy coverage extractor is absent from the selected Extraction Profile.',
          {
            relation: 'extraction-policy.coverage-extractor-profile',
            extractor: reference
          }
        );
      }
    }
  }

  if (registry) {
    for (const selected of binding.inputDescriptors.extractionProfile.extractors) {
      const manifest = registryByManifestSha256.get(selected.manifestSha256);
      if (!manifest || extractorMajor(manifest.version) !== selected.version
          || manifest.id !== selected.id
          || manifest.producer.implementationSha256 !== selected.implementationSha256) {
        graphMismatch('Persisted World-model Extraction Profile is not backed by its retained Extractor Registry.', {
          relation: 'extraction-profile.extractor-registry',
          extractor: `${selected.id}@${selected.version}`,
          manifestSha256: selected.manifestSha256
        });
      }
      const allowed = policyByManifestSha256.get(selected.manifestSha256);
      if (policy && (!allowed
          || allowed.implementationSha256 !== selected.implementationSha256)) {
        graphMismatch('Persisted World-model Extraction Profile selects an extractor outside its Extraction Policy.', {
          relation: 'extraction-profile.extraction-policy',
          extractor: `${selected.id}@${selected.version}`
        });
      }
    }
  }
  // Frozen v1 names configuration objects but does not define which extractor consumes which
  // object or how those bytes produce a derivation configuration identity. Do not invent that
  // authority. The only configuration identity v1 can prove is the registered empty
  // configuration used by today's deterministic extraction runner. A configured profile needs a
  // successor owner contract before it can be retained or reused.
  if (binding.inputDescriptors.extractionProfile.configurationRefs.length !== 0) {
    graphMismatch(
      'Persisted World-model configured extraction has no installed configuration owner contract.',
      { relation: 'extraction-profile.configuration-authority' }
    );
  }
  if (policy) {
    const requirements = binding.inputDescriptors.factRequirements;
    for (const [field, expected] of [
      ['requiredFactTypes', requirements.requiredFactTypes],
      ['optionalFactTypes', requirements.optionalFactTypes],
      ['requiredUnavailableSubjects', requirements.requiredUnavailableSubjects]
    ]) {
      if (canonicalJson(policy.factSemantics[field]) !== canonicalJson(expected)) {
        graphMismatch(`Persisted World-model Extraction Policy '${field}' does not match Fact Requirements.`, {
          relation: `extraction-policy.fact-semantics.${field}`
        });
      }
    }
  }

  const completeness = resolvedRecord(closure,
    roleRef(binding.payloadObjects, 'completeness-record', 'WMP Model Binding payloadObjects'));
  if (completeness) {
    requireDigest(completeness.sourceManifestSha256, binding.inputs.sourceManifestSha256,
      'Completeness Record source does not match ModelInputs');
    requireDigest(completeness.scopeManifestSha256, binding.inputs.scopeManifestSha256,
      'Completeness Record scope does not match ModelInputs');
    requireDigest(completeness.extractorRegistrySha256, binding.inputs.extractorRegistrySha256,
      'Completeness Record Extractor Registry does not match ModelInputs');
    if (sourceSnapshot) validateCompletenessSourceCoverage(
      sourceSnapshot, scope, completeness, candidateRoster
    );
    for (const field of [
      'totalPaths', 'processedPaths', 'unsupportedPaths', 'failedPaths', 'excludedPaths'
    ]) {
      if (completeness.counts[field] !== binding.completeness[field]) {
        graphMismatch(`Persisted World-model Completeness Record '${field}' does not match its Model Binding.`, {
          relation: `completeness.${field}`,
          expected: binding.completeness[field], received: completeness.counts[field]
        });
      }
    }
    if (canonicalJson(completeness.requiredSubjects)
        !== canonicalJson(binding.completeness.requiredSubjects)) {
      graphMismatch('Persisted World-model required-subject outcomes do not match their Model Binding.', {
        relation: 'completeness.required-subjects'
      });
    }
    const requirements = binding.inputDescriptors.factRequirements;
    const requiredSubjectIds = [...new Set([
      ...requirements.requiredFactTypes,
      ...requirements.requiredUnavailableSubjects
    ])].sort(compareText);
    if (canonicalJson(completeness.requiredSubjects.map((entry) => entry.id))
        !== canonicalJson(requiredSubjectIds)) {
      graphMismatch('Persisted World-model required-subject outcomes do not cover the exact Fact Requirements.', {
        relation: 'completeness.fact-requirements'
      });
    }
    const profileManifestDigests = binding.inputDescriptors.extractionProfile.extractors
      .map((entry) => entry.manifestSha256).sort();
    const completenessManifestDigests = completeness.extractorReferences
      .map((entry) => entry.manifestSha256).sort();
    if (canonicalJson(profileManifestDigests) !== canonicalJson(completenessManifestDigests)) {
      graphMismatch('Persisted World-model Completeness Record does not cover the exact Extraction Profile.', {
        relation: 'completeness.extraction-profile',
        expectedManifestSha256: profileManifestDigests,
        receivedManifestSha256: completenessManifestDigests
      });
    }
    const expectedCoverage = [];
    for (const extractor of completeness.extractorReferences) {
      const manifest = registryByManifestSha256.get(extractor.manifestSha256);
      if (!manifest || manifest.id !== extractor.id || manifest.version !== extractor.version
          || manifest.producer.implementationSha256 !== extractor.implementationSha256) {
        graphMismatch('Persisted World-model Completeness Record names an extractor identity not backed by its retained Extractor Registry.', {
          relation: 'completeness.extractor-registry',
          extractor: `${extractor.id}@${extractor.version}`,
          manifestSha256: extractor.manifestSha256
        });
      }
      const allowed = policyByManifestSha256.get(extractor.manifestSha256);
      if (!allowed || allowed.id !== extractor.id || allowed.version !== extractor.version
          || allowed.implementationSha256 !== extractor.implementationSha256
          || allowed.coverage !== extractor.coverage) {
        graphMismatch('Persisted World-model Completeness Record names an extractor identity outside its Extraction Policy.', {
          relation: 'completeness.extraction-policy',
          extractor: `${extractor.id}@${extractor.version}`,
          manifestSha256: extractor.manifestSha256
        });
      }
      const selected = profileByManifestSha256.get(extractor.manifestSha256);
      if (!selected || selected.id !== extractor.id
          || selected.version !== extractorMajor(extractor.version)
          || selected.implementationSha256 !== extractor.implementationSha256
          || selected.grammarSha256 !== manifest.producer.parser.grammarSha256
          || selected.parserSha256 !== null || selected.resolverSha256 !== null) {
        graphMismatch('Persisted World-model Completeness Record does not match the exact retained Extraction Profile identity.', {
          relation: 'completeness.extraction-profile-identity',
          extractor: `${extractor.id}@${extractor.version}`,
          manifestSha256: extractor.manifestSha256
        });
      }
      const coverage = modelExtractorCoverage(completeness, extractor);
      if (!coverage) {
        graphMismatch('Persisted World-model Completeness Record has incomplete extractor accounting.', {
          relation: 'completeness.extractor-coverage',
          extractor: `${extractor.id}@${extractor.version}`
        });
      }
      expectedCoverage.push({
        id: extractor.id, version: extractorMajor(extractor.version), ...coverage
      });
    }
    expectedCoverage.sort((left, right) => compareText(
      `${left.id}\0${left.version}`, `${right.id}\0${right.version}`
    ));
    if (canonicalJson(expectedCoverage)
        !== canonicalJson(binding.completeness.extractorCoverage)) {
      graphMismatch('Persisted World-model extractor coverage does not match its detailed Completeness Record.', {
        relation: 'completeness.extractor-coverage'
      });
    }
  }

  const evidence = resolvedRecord(closure,
    roleRef(binding.payloadObjects, 'evidence-catalog', 'WMP Model Binding payloadObjects'));
  if (evidence) {
    requireDigest(evidence.sourceManifestSha256, binding.inputs.sourceManifestSha256,
      'evidence catalog source does not match ModelInputs');
    requireDigest(evidence.scopeManifestSha256, binding.inputs.scopeManifestSha256,
      'evidence catalog scope does not match ModelInputs');
  }

  const factLedger = resolvedRecord(closure,
    roleRef(binding.payloadObjects, 'fact-ledger', 'WMP Model Binding payloadObjects'));
  if (factLedger) {
    requireDigest(factLedger.sourceManifestSha256, binding.inputs.sourceManifestSha256,
      'Fact Ledger source does not match ModelInputs');
    requireDigest(factLedger.scopeManifestSha256, binding.inputs.scopeManifestSha256,
      'Fact Ledger scope does not match ModelInputs');
    requireDigest(factLedger.extractorRegistrySha256, binding.inputs.extractorRegistrySha256,
      'Fact Ledger extractor registry does not match ModelInputs');
    if (completeness) {
      const expectedRequiredSubjects = [...new Set([
        ...binding.inputDescriptors.factRequirements.requiredFactTypes,
        ...binding.inputDescriptors.factRequirements.requiredUnavailableSubjects
      ])].sort(compareText).map((factType) => requiredFactOutcome(factType, factLedger.facts));
      const missingFactType = expectedRequiredSubjects.findIndex((entry) => entry === null);
      if (missingFactType !== -1) {
        graphMismatch('Persisted World-model Fact Ledger omits required typed coverage.', {
          relation: 'completeness.required-subject-facts',
          factType: [...new Set([
            ...binding.inputDescriptors.factRequirements.requiredFactTypes,
            ...binding.inputDescriptors.factRequirements.requiredUnavailableSubjects
          ])].sort(compareText)[missingFactType]
        });
      }
      if (canonicalJson(expectedRequiredSubjects)
          !== canonicalJson(completeness.requiredSubjects)) {
        graphMismatch('Persisted World-model required-subject outcomes are not derived from its retained Facts.', {
          relation: 'completeness.required-subject-outcomes',
          expected: expectedRequiredSubjects,
          received: completeness.requiredSubjects
        });
      }
    }
  }

  const derivations = resolvedRecord(closure,
    roleRef(binding.payloadObjects, 'derivation-catalog', 'WMP Model Binding payloadObjects'));
  if (derivations) {
    const factsById = new Map((factLedger?.facts ?? []).map((fact) => [fact.id, fact]));
    for (const derivation of derivations.derivations) {
      requireDigest(derivation.sourceManifestSha256, binding.inputs.sourceManifestSha256,
        `derivation '${derivation.id}' source does not match ModelInputs`);
      requireDigest(derivation.scopeManifestSha256, binding.inputs.scopeManifestSha256,
        `derivation '${derivation.id}' scope does not match ModelInputs`);
      requireDigest(
        derivation.configurationSha256,
        WMP_EMPTY_EXTRACTOR_CONFIGURATION_SHA256,
        `derivation '${derivation.id}' configuration is not the exact admitted empty extraction configuration`
      );
      const manifest = registryByIdentity.get(
        `${derivation.extractor.id}@${derivation.extractor.version}`
      );
      const selected = profileByManifestSha256.get(manifest?.manifestSha256);
      const allowed = policyByManifestSha256.get(manifest?.manifestSha256);
      if (!manifest || !selected || !allowed
          || derivation.extractor.implementationSha256
            !== manifest.producer.implementationSha256
          || selected.id !== manifest.id
          || selected.version !== extractorMajor(manifest.version)
          || selected.implementationSha256 !== manifest.producer.implementationSha256
          || selected.grammarSha256 !== manifest.producer.parser.grammarSha256
          || allowed.id !== manifest.id || allowed.version !== manifest.version
          || allowed.implementationSha256 !== manifest.producer.implementationSha256) {
        graphMismatch(
          `Persisted World-model derivation '${derivation.id}' was not produced by an exact selected and allowed extractor.`,
          {
            relation: 'derivation.extraction-authority',
            derivationId: derivation.id,
            extractor: `${derivation.extractor.id}@${derivation.extractor.version}`
          }
        );
      }
      for (const factId of derivation.outputFactIds) {
        const factType = factsById.get(factId)?.factType ?? null;
        if (!factType || !manifest.factTypes.includes(factType)
            || !policy.factSemantics.allowedFactTypes.includes(factType)) {
          graphMismatch(
            `Persisted World-model derivation '${derivation.id}' emitted an unauthorized Fact type.`,
            {
              relation: 'derivation.fact-type-authority',
              derivationId: derivation.id,
              factId,
              factType
            }
          );
        }
      }
    }
  }

  if (evidence && sourceSnapshot && scope) {
    validateGraphOwner('evidence-catalog.source-and-scope', () => validateEvidenceCatalog(
      evidence, { sourceSnapshot, scopeManifest: scope }
    ));
  }
  if (factLedger && sourceSnapshot && scope && registry && evidence && derivations) {
    const derivationIds = new Set(derivations.derivations.map((entry) => entry.id));
    const ledgerValidator = currentExtractorAdmission
      ? validateFactLedger : validateHistoricalFactLedger;
    validateGraphOwner('fact-ledger.complete-closure', () => ledgerValidator(factLedger, {
      sourceSnapshot,
      scopeManifest: scope,
      extractorRegistry: registry,
      evidenceCatalog: evidence,
      derivationIds
    }));
  }
  if (derivations && evidence && factLedger && registry) {
    const derivationValidator = currentExtractorAdmission
      ? validateDerivationCatalog : validateHistoricalDerivationCatalog;
    validateGraphOwner('derivation-catalog.complete-closure', () => derivationValidator(
      derivations, {
        evidenceCatalog: evidence,
        factLedger,
        extractorRegistry: registry
      }
    ));
  }
}

function availableCapture(viewInputs, role) {
  const captures = viewInputs.captures.filter((entry) => entry.role === role);
  if (captures.length !== 1 || captures[0].status !== 'available') {
    graphMismatch(`Persisted World-model View Inputs require one available '${role}' capture.`, {
      relation: `view-inputs.capture.${role}`, matches: captures.length
    });
  }
  return captures[0];
}

function validateViewBindingGraph(binding, closure) {
  // Renderer and validator v1 records have no installed semantic owner yet. Their exact raw-byte
  // identities are nevertheless pinned by both the binding refs and ViewInputsKey; semantic use
  // still fails closed below until those owner contracts are installed.
  requireDigest(binding.rendererContractRef.sha256, binding.inputs.rendererSha256,
    'renderer contract bytes do not match ViewInputsKey.rendererSha256');
  requireDigest(binding.validatorContractRef.sha256, binding.inputs.validatorSha256,
    'validator contract bytes do not match ViewInputsKey.validatorSha256');

  const viewInputs = resolvedRecord(closure, binding.viewInputsRef);
  if (!viewInputs) return;
  requireDigest(viewInputs.inputManifestSha256, binding.inputs.viewInputsSha256,
    'View Inputs manifest does not match ViewInputsKey.viewInputsSha256');
  requireDigest(viewInputs.modelPayloadSha256, binding.inputs.modelPayloadSha256,
    'View Inputs model payload does not match ViewInputsKey.modelPayloadSha256');
  requireDigest(sha256(viewInputs.selection), binding.inputs.selectionSha256,
    'View Inputs selection does not match ViewInputsKey.selectionSha256');

  const viewContract = resolvedRecord(closure, viewInputs.viewContractRef);
  if (viewContract) {
    requireDigest(viewContract.contractSha256, binding.inputs.viewContractSha256,
      'View Contract does not match ViewInputsKey.viewContractSha256');
    if (viewContract.id !== binding.inputs.viewId
        || viewContract.version !== binding.inputs.viewVersion) {
      graphMismatch('Persisted World-model graph mismatch: View Contract identity differs from ViewInputsKey.', {
        relation: 'view-contract.identity',
        expected: `${binding.inputs.viewId}@${binding.inputs.viewVersion}`,
        received: `${viewContract.id}@${viewContract.version}`
      });
    }
  }

  const consumer = resolvedRecord(closure, viewInputs.consumerProfileRef);
  if (consumer) requireDigest(consumer.profileSha256, binding.inputs.consumerProfileSha256,
    'consumer profile does not match ViewInputsKey.consumerProfileSha256');

  const outputBudgetCapture = availableCapture(viewInputs, 'output-budget');
  const outputBudget = resolvedRecord(closure, outputBudgetCapture.objectRef);
  if (outputBudget) requireDigest(outputBudget.budgetSha256, binding.inputs.outputBudgetSha256,
    'output budget does not match ViewInputsKey.outputBudgetSha256');

  if (binding.inputs.tokenizerSha256 !== null) {
    const tokenizerCapture = availableCapture(viewInputs, 'tokenizer');
    requireDigest(tokenizerCapture.objectRef.sha256, binding.inputs.tokenizerSha256,
      'tokenizer bytes do not match ViewInputsKey.tokenizerSha256');
  }

  const selectedLedger = resolvedRecord(closure, binding.selectedFactLedgerRef);
  if (selectedLedger) {
    requireDigest(selectedLedger.viewSpecSha256, binding.inputs.viewContractSha256,
      'selected Fact Ledger contract does not match ViewInputsKey');
    if (selectedLedger.viewId !== binding.inputs.viewId
        || selectedLedger.viewVersion !== binding.inputs.viewVersion) {
      graphMismatch('Persisted World-model graph mismatch: selected Fact Ledger view differs from ViewInputsKey.', {
        relation: 'selected-fact-ledger.identity',
        expected: `${binding.inputs.viewId}@${binding.inputs.viewVersion}`,
        received: `${selectedLedger.viewId}@${selectedLedger.viewVersion}`
      });
    }
    if (binding.selection.mode === 'inline') {
      const retainedFactIds = selectedLedger.facts.map((fact) => fact.id).sort();
      const classifiedFactIds = [
        ...binding.selection.selectedFactIds,
        ...binding.selection.omittedFactIds
      ].sort();
      if (canonicalJson(retainedFactIds) !== canonicalJson(classifiedFactIds)) {
        graphMismatch('Persisted World-model graph mismatch: inline selection does not partition the selected Fact Ledger.', {
          relation: 'view-binding.selection', retainedFactIds, classifiedFactIds
        });
      }
    }
  }

  const receipt = resolvedRecord(closure, binding.validatorReceiptRef);
  if (receipt) {
    requireDigest(receipt.validatorSha256, binding.inputs.validatorSha256,
      'validator receipt does not match ViewInputsKey.validatorSha256');
    requireDigest(receipt.viewSpecSha256, binding.inputs.viewContractSha256,
      'validator receipt View Contract does not match ViewInputsKey');
    if (selectedLedger) requireDigest(receipt.factLedgerSha256, selectedLedger.ledgerSha256,
      'validator receipt Fact Ledger does not match the selected ledger');
    if (receipt.viewId !== binding.inputs.viewId || receipt.viewVersion !== binding.inputs.viewVersion
        || receipt.status !== 'passed') {
      graphMismatch('Persisted World-model validator receipt does not authorize this view identity.', {
        relation: 'validator-receipt.identity-and-status',
        expected: { viewId: binding.inputs.viewId, viewVersion: binding.inputs.viewVersion, status: 'passed' },
        received: { viewId: receipt.viewId, viewVersion: receipt.viewVersion, status: receipt.status }
      });
    }
  }
}

export function validateRetainedWorldModelBindingGraph(kind, binding, closure, {
  currentExtractorAdmission = false
} = {}) {
  if (kind === 'model') validateModelBindingGraph(binding, closure, {
    currentExtractorAdmission
  });
  else validateViewBindingGraph(binding, closure);
}

/** Read and verify one exact content-addressed object at one admitted authority cut. */
export function readWorldModelHistoryObject(root, {
  authorityCommit, ref, historyDir = DEFAULT_WORLD_MODEL_HISTORY_DIR,
  outputDir = 'singularity/world-model', authorityRef,
  env = process.env, runCommand = run
} = {}) {
  validateRetainedObjectReference(ref);
  validateWorldModelHistoryRoots({ outputDir, historyDir });
  const commit = resolveWorldModelHistoryAuthority(root, authorityCommit, {
    authorityRef, env, runCommand
  });
  const blob = readExactBlob(root, commit, worldModelHistoryObjectPath(ref.sha256, { historyDir }), {
    env, runCommand
  });
  if (UNOWNED_RETAINED_ROLES.has(ref.role)) throw retainedOwnerUnavailable(ref);
  const record = parseExactRetainedObject(ref, blob.bytes);
  return Object.freeze({
    authorityCommit: commit, authorityRef, ref: structuredClone(ref), bytes: blob.bytes, record
  });
}

function readBinding(root, {
  authorityCommit, authorityRef, outputDir, historyDir, key, kind, env, runCommand
}) {
  validateWorldModelHistoryRoots({ outputDir, historyDir });
  const commit = resolveWorldModelHistoryAuthority(root, authorityCommit, {
    authorityRef, env, runCommand
  });
  const isModel = kind === 'model';
  const bindingPath = isModel
    ? worldModelHistoryModelPath(key, { historyDir })
    : worldModelHistoryViewPath(key, { historyDir });
  const bindingBlob = readExactBlob(root, commit, bindingPath, {
    missingCode: isModel ? 'WMP_MODEL_MISSING' : 'WMP_VIEW_NOT_MATERIALIZED', env, runCommand
  });
  const family = isModel ? 'world-model-model-binding' : 'world-model-view-binding';
  const binding = parseCanonicalWmpRecordBytes(family, bindingBlob.bytes);
  const validated = isModel ? validateWmpModelBinding(binding) : validateWmpViewBinding(binding);
  const actualKey = isModel ? validated.modelKey : validated.viewKey;
  if (actualKey !== key) {
    fail(`Persisted World-model ${kind} path does not match its complete input key.`,
      'WMP_INTEGRITY_FAILED', { path: bindingPath, expectedKey: key, observedKey: actualKey });
  }

  // Bind key lookup to the same raw bytes in the content-addressed object store.
  const bindingObject = readExactBlob(root, commit,
    worldModelHistoryObjectPath(bindingBlob.sha256, { historyDir }), { env, runCommand });
  if (!bindingObject.bytes.equals(bindingBlob.bytes)) {
    fail(`Persisted World-model ${kind} binding object differs from its key path.`,
      'WMP_INTEGRITY_FAILED', { path: bindingPath, sha256: bindingBlob.sha256 });
  }

  const bindingOwner = `binding:${bindingBlob.sha256}`;
  const closureBudget = createWorldModelHistoryClosureBudget({
    operation: `persisted-${kind}-read`
  });
  const queue = collectObjectRefs(validated, closureBudget).map((ref) => ({
    ref, owner: bindingOwner, depth: 1
  }));
  const closure = new Map();
  const edges = new Map();
  const deferredOwnerErrors = [];
  let totalBytes = bindingBlob.bytes.length;
  let queueIndex = 0;
  while (queueIndex < queue.length) {
    const { ref, owner, depth } = queue[queueIndex];
    queueIndex += 1;
    closureBudget.checkpoint({ depth });
    if (!edges.has(owner)) edges.set(owner, new Set());
    edges.get(owner).add(ref.sha256);
    if (closure.has(ref.sha256)) {
      const prior = closure.get(ref.sha256).ref;
      if (canonicalJson(prior) !== canonicalJson(ref)) {
        fail(`World-model closure repeats '${ref.sha256}' with contradictory metadata.`,
          'WMP_INTEGRITY_FAILED', { sha256: ref.sha256 });
      }
      continue;
    }
    if (closure.size >= MAXIMUM_CLOSURE_OBJECTS) {
      fail('World-model retained closure exceeds its object limit.', 'WMP_CONTRACT_LIMIT', {
        maximumObjects: MAXIMUM_CLOSURE_OBJECTS
      });
    }
    let object;
    try {
      const blob = readExactBlob(root, commit,
        worldModelHistoryObjectPath(ref.sha256, { historyDir }), { env, runCommand });
      let record = null;
      let ownerError = null;
      try {
        if (UNOWNED_RETAINED_ROLES.has(ref.role)) throw retainedOwnerUnavailable(ref);
        record = parseExactRetainedObject(ref, blob.bytes);
      } catch (error) {
        if (error?.code !== 'WMP_OBJECT_OWNER_UNAVAILABLE') throw error;
        ownerError = error;
        deferredOwnerErrors.push(error);
      }
      object = Object.freeze({
        authorityCommit: commit,
        ref: structuredClone(ref),
        bytes: blob.bytes,
        record,
        ownerError
      });
    } catch (error) {
      if (error?.code === 'WMP_INPUT_MISSING') {
        fail(`World-model retained closure is missing '${ref.sha256}'.`, 'WMP_INPUT_MISSING', {
          authorityCommit: commit, role: ref.role, sha256: ref.sha256,
          path: worldModelHistoryObjectPath(ref.sha256, { historyDir })
        }, error);
      }
      throw error;
    }
    totalBytes += object.bytes.length;
    if (totalBytes > MAXIMUM_CLOSURE_BYTES) {
      fail('World-model retained closure exceeds its byte limit.', 'WMP_CONTRACT_LIMIT', {
        maximumBytes: MAXIMUM_CLOSURE_BYTES, observedBytes: totalBytes
      });
    }
    closure.set(ref.sha256, object);
    if (object.record) {
      const children = collectObjectRefs(object.record, closureBudget, depth);
      queue.push(...children.map((child) => ({
        ref: child, owner: ref.sha256, depth: depth + 1
      })));
    }
  }

  assertAcyclicWorldModelHistoryClosure({
    roots: edges.get(bindingOwner) ?? [],
    childrenOf: (digest) => edges.get(digest) ?? [],
    budget: closureBudget
  });
  validateRetainedWorldModelBindingGraph(kind, validated, closure);
  closureBudget.checkpoint();
  if (deferredOwnerErrors.length) throw deferredOwnerErrors[0];
  return Object.freeze({
    authorityCommit: commit,
    authorityRef,
    historyDir,
    bindingPath,
    binding,
    bindingBytes: bindingBlob.bytes,
    bindingByteSha256: bindingBlob.sha256,
    closure: Object.freeze([...closure.values()]),
    totalBytes
  });
}

export function resolvePersistedWorldModel(root, {
  authorityCommit, modelKey, historyDir = DEFAULT_WORLD_MODEL_HISTORY_DIR,
  outputDir = 'singularity/world-model', authorityRef,
  env = process.env, runCommand = run
} = {}) {
  return readBinding(root, {
    authorityCommit, authorityRef, outputDir, historyDir,
    key: modelKey, kind: 'model', env, runCommand
  });
}

export function resolvePersistedWorldModelView(root, {
  authorityCommit, viewKey, historyDir = DEFAULT_WORLD_MODEL_HISTORY_DIR,
  outputDir = 'singularity/world-model', authorityRef,
  env = process.env, runCommand = run
} = {}) {
  return readBinding(root, {
    authorityCommit, authorityRef, outputDir, historyDir,
    key: viewKey, kind: 'view', env, runCommand
  });
}

export const readPersistedWorldModelObject = readWorldModelHistoryObject;
export const resolvePersistedModel = resolvePersistedWorldModel;
export const resolvePersistedView = resolvePersistedWorldModelView;
