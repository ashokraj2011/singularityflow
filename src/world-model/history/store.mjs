import { run, SingularityFlowError } from '../../util.mjs';
import { canonicalJson, sha256 } from '../canonicalize.mjs';
import { isPlainRecord } from '../canonicalize.mjs';
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

const OBJECT_REF_KEYS = Object.freeze(['bytes', 'family', 'mediaType', 'role', 'sha256']);
const MAXIMUM_CLOSURE_OBJECTS = 100_000;
const MAXIMUM_CLOSURE_BYTES = 256 * 1024 * 1024;
const AUTHORITY_REF_PATTERN = /^refs\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const UNOWNED_RETAINED_ROLES = new Set([
  'completeness-record',
  'extraction-policy',
  'extractor-registry',
  'renderer-contract',
  'repository-domain',
  'tokenizer',
  'validator-contract'
]);

function fail(message, code, details = {}, cause = undefined) {
  throw new SingularityFlowError(message, { code, details, cause });
}

function localGitEnvironment(env) {
  return {
    ...env,
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never'
  };
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
  const refResult = runCommand('git', ['rev-parse', '--verify', `${admittedRef}^{commit}`], {
    cwd: root, allowFailure: true, env: localGitEnvironment(env)
  });
  const authorityTip = refResult.status === 0
    ? String(refResult.stdout).trim().toLowerCase() : null;
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(authorityTip ?? '')) {
    fail('The configured World-model state-authority ref is not available locally.',
      'WMP_AUTHORITY_REFRESH_REQUIRED', {
        authorityCommit: requested, authorityRef: admittedRef
      });
  }
  const result = runCommand('git', ['rev-parse', '--verify', `${requested}^{commit}`], {
    cwd: root, allowFailure: true, env: localGitEnvironment(env)
  });
  const resolved = result.status === 0 ? String(result.stdout).trim().toLowerCase() : null;
  if (resolved !== requested) {
    fail('The selected World-model authority commit is not available in the local Git object store.',
      'WMP_AUTHORITY_REFRESH_REQUIRED', { authorityCommit: requested });
  }
  const admitted = runCommand('git', [
    'merge-base', '--is-ancestor', requested, authorityTip
  ], {
    cwd: root, allowFailure: true, env: localGitEnvironment(env)
  });
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
  const localEnv = localGitEnvironment(env);
  const listed = runCommand('git', ['ls-tree', '-z', commit, '--', relativePath], {
    cwd: root, allowFailure: true, env: localEnv
  });
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
  const sizeResult = runCommand('git', ['cat-file', '-s', oid], {
    cwd: root, allowFailure: true, env: localEnv
  });
  const size = sizeResult.status === 0 ? Number(String(sizeResult.stdout).trim()) : NaN;
  if (!Number.isSafeInteger(size) || size < 1 || size > WMP_MAXIMUM_OBJECT_BYTES) {
    fail(`World-model history object has an invalid size: ${relativePath}.`,
      'WMP_INTEGRITY_FAILED', {
        authorityCommit: commit, path: relativePath,
        bytes: Number.isFinite(size) ? size : null,
        maximumBytes: WMP_MAXIMUM_OBJECT_BYTES
      });
  }
  const shown = runCommand('git', ['cat-file', 'blob', oid], {
    cwd: root, allowFailure: true, encoding: 'buffer', maxBuffer: size + 1024, env: localEnv
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

function collectObjectRefs(value, refs = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectObjectRefs(entry, refs);
  } else if (isPlainRecord(value)) {
    if (exactObjectRef(value)) {
      validateRetainedObjectReference(value);
      refs.push(value);
    } else {
      for (const entry of Object.values(value)) collectObjectRefs(entry, refs);
    }
  }
  return refs;
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

function validateModelBindingGraph(binding, closure) {
  const sourceBinding = binding.inputDescriptors.sourceBinding;
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
  }

  const derivations = resolvedRecord(closure,
    roleRef(binding.payloadObjects, 'derivation-catalog', 'WMP Model Binding payloadObjects'));
  if (derivations) {
    for (const derivation of derivations.derivations) {
      requireDigest(derivation.sourceManifestSha256, binding.inputs.sourceManifestSha256,
        `derivation '${derivation.id}' source does not match ModelInputs`);
      requireDigest(derivation.scopeManifestSha256, binding.inputs.scopeManifestSha256,
        `derivation '${derivation.id}' scope does not match ModelInputs`);
    }
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

function validateRetainedBindingGraph(kind, binding, closure) {
  if (kind === 'model') validateModelBindingGraph(binding, closure);
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
  const queue = collectObjectRefs(validated).map((ref) => ({ ref, owner: bindingOwner }));
  const closure = new Map();
  const edges = new Map();
  const deferredOwnerErrors = [];
  let totalBytes = bindingBlob.bytes.length;
  while (queue.length) {
    const { ref, owner } = queue.shift();
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
    if (object.record) queue.push(...collectObjectRefs(object.record).map((child) => ({
      ref: child, owner: ref.sha256
    })));
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (digest, chain) => {
    if (visiting.has(digest)) {
      const start = chain.indexOf(digest);
      fail(`World-model retained-object closure contains a cycle at '${digest}'.`,
        'WMP_INTEGRITY_FAILED', {
          sha256: digest,
          cycle: [...chain.slice(start < 0 ? 0 : start), digest]
        });
    }
    if (visited.has(digest)) return;
    visiting.add(digest);
    for (const child of edges.get(digest) ?? []) visit(child, [...chain, digest]);
    visiting.delete(digest);
    visited.add(digest);
  };
  for (const digest of edges.get(bindingOwner) ?? []) {
    visit(digest, []);
  }
  validateRetainedBindingGraph(kind, validated, closure);
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
