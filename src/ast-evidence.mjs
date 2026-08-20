import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { BUILTIN_AST_EXTRACTOR } from './ast-builtin-extractor.mjs';
import { normalizeAstPolicy } from './ast-policy.mjs';
import { retainAstEvidenceBundle } from './ast-evidence-store.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { SingularityFlowError } from './util.mjs';

const ENGINE_FILES = Object.freeze([
  'src/ast-intelligence.mjs', 'src/ast-builtin-extractor.mjs', 'src/ast-evidence.mjs',
  'src/ast-replay.mjs', 'src/ast-replay-runner.mjs'
]);
const REPLAY_FILES = Object.freeze(['src/ast-builtin-extractor.mjs', 'src/ast-replay-runner.mjs']);
let identitiesPromise = null;

async function fileSha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function currentIdentities() {
  if (!identitiesPromise) identitiesPromise = (async () => {
    const files = [];
    for (const relative of ENGINE_FILES) {
      files.push({ path: relative, sha256: await fileSha256(path.join(PACKAGE_ROOT, relative)) });
    }
    const runtime = {
      id: 'node', version: process.versions.node,
      platform: `${process.platform}-${process.arch}`,
      artifactSha256: await fileSha256(process.execPath)
    };
    const engineArtifactSha256 = recordSha256({ files });
    const builtinArtifactSha256 = recordSha256({
      engineArtifactSha256,
      implementation: 'builtin-text-v1',
      files: files.filter((entry) => REPLAY_FILES.includes(entry.path))
    });
    const replayArtifacts = [];
    for (const relative of REPLAY_FILES) {
      const bytes = await readFile(path.join(PACKAGE_ROOT, relative));
      replayArtifacts.push({
        path: path.posix.basename(relative),
        sha256: await fileSha256(path.join(PACKAGE_ROOT, relative)),
        bytesBase64: bytes.toString('base64')
      });
    }
    return {
      engine: { id: 'singularity-flow-ast-broker', version: 3, artifactSha256: engineArtifactSha256 },
      builtin: {
        id: BUILTIN_AST_EXTRACTOR.id,
        extractorVersion: String(BUILTIN_AST_EXTRACTOR.version),
        protocolVersion: BUILTIN_AST_EXTRACTOR.protocolVersion,
        assurance: BUILTIN_AST_EXTRACTOR.assurance,
        manifestSha256: recordSha256(BUILTIN_AST_EXTRACTOR),
        artifactSha256: builtinArtifactSha256
      },
      runtime,
      files,
      replayArtifacts
    };
  })();
  return identitiesPromise;
}

export async function currentAstEvidenceIdentities() {
  return structuredClone(await currentIdentities());
}

function derivationPayload(manifest) {
  const {
    derivationSha256: _derivation, integritySha256: _integrity,
    createdAt: _createdAt, retention: _retention, ...semantic
  } = manifest;
  return semantic;
}

function integrityPayload(manifest) {
  const { integritySha256: _integrity, ...content } = manifest;
  return content;
}

export function validateAstDerivationManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError('AST derivation manifest must be an object.');
  value = readRecord('ast-derivation-manifest', value).record;
  if (!/^[a-f0-9]{64}$/.test(value.derivationSha256 ?? '') || value.derivationSha256 !== recordSha256(derivationPayload(value))) {
    throw new SingularityFlowError('AST derivation semantic digest is invalid.', { code: 'AST_DERIVATION_INVALID' });
  }
  if (!/^[a-f0-9]{64}$/.test(value.integritySha256 ?? '') || value.integritySha256 !== recordSha256(integrityPayload(value))) {
    throw new SingularityFlowError('AST derivation manifest integrity is invalid.', { code: 'AST_DERIVATION_INVALID' });
  }
  if (!Array.isArray(value.inputs?.files) || value.inputs.files.some((entry) => !entry.path
    || !entry.gitObjectId || !/^[0-7]{6}$/.test(entry.gitMode ?? '') || !entry.contentSha256)) {
    throw new SingularityFlowError('AST derivation input manifest is incomplete.', { code: 'AST_DERIVATION_INVALID' });
  }
  return structuredClone(value);
}

export function derivationRelativePath(config, workflow, digest) {
  return path.posix.join(
    config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id,
    'context', 'ast', 'derivations', `${digest}.json`
  );
}

/** Build and retain the immutable derivation without writing Story bytes. */
export async function createAstDerivation(root, config, workflow, phase, result, {
  generation, evidenceClass, operation
} = {}) {
  const capture = result.provenance?.evidence;
  if (!capture || capture.evidenceClass !== evidenceClass) {
    throw new SingularityFlowError('AST result does not contain the requested durable capture.', { code: 'AST_DERIVATION_CAPTURE_MISSING' });
  }
  if (result.status !== 'complete') {
    throw new SingularityFlowError(`AST ${evidenceClass} derivation requires complete structural analysis; result is ${result.status}.`, { code: 'AST_DERIVATION_INCOMPLETE' });
  }
  const identities = await currentIdentities();
  const evidencePolicy = normalizeAstPolicy(config.ast ?? {}).evidence;
  const extractors = [...new Map((result.provenance?.extractors ?? []).map((entry) => [entry.id, entry])).values()];
  const unsupported = extractors.filter((entry) => entry.id !== BUILTIN_AST_EXTRACTOR.id);
  if (unsupported.length && evidencePolicy.mode === 'replayable') {
    throw new SingularityFlowError(
      `Replayable AST evidence cannot yet retain external adapter(s): ${unsupported.map((entry) => entry.id).join(', ')}. Configure a replay-capable bundle or use preview mode.`,
      { code: 'AST_EVIDENCE_TOOLCHAIN_UNREPLAYABLE' }
    );
  }
  const adapters = extractors.map((entry) => entry.id === BUILTIN_AST_EXTRACTOR.id
    ? identities.builtin
    : {
        id: entry.id,
        extractorVersion: String(entry.version),
        protocolVersion: entry.protocolVersion,
        assurance: entry.assurance,
        manifestSha256: entry.manifestSha256,
        artifactSha256: entry.artifactSha256
      });
  if (!adapters.some((entry) => entry.id === identities.builtin.id)) adapters.unshift(identities.builtin);
  adapters.sort((left, right) => left.id.localeCompare(right.id));
  const adapter = adapters.find((entry) => entry.id === BUILTIN_AST_EXTRACTOR.id) ?? adapters[0];
  const toolchainBundle = {
    schemaVersion: 1,
    kind: 'singularity-flow-ast-toolchain',
    engine: identities.engine,
    adapters,
    grammars: [],
    runtime: identities.runtime,
    dependencies: { lockSha256: null, bundleSha256: null },
    implementation: { builtin: 'builtin-text-v1', canonicalizationVersion: 1 },
    packagedFiles: identities.files,
    replayArtifacts: identities.replayArtifacts
  };
  const mode = evidencePolicy.mode;
  const storeId = evidencePolicy.store;
  const bundleSha256 = recordSha256(toolchainBundle);
  const retained = mode === 'replayable'
    ? await retainAstEvidenceBundle(root, storeId, toolchainBundle)
    : { storeId, bundleSha256 };
  const files = [...capture.inputs.files].sort((left, right) => left.path.localeCompare(right.path));
  const manifest = {
    schemaVersion: currentSchemaVersion('ast-derivation-manifest'),
    derivationSha256: '',
    subject: {
      workId: workflow.workItem.id,
      phase: phase.id,
      generation,
      evidenceClass,
      operation
    },
    engine: identities.engine,
    adapter,
    adapters,
    grammars: [],
    runtime: identities.runtime,
    dependencies: { lockSha256: null, bundleSha256: null },
    configuration: structuredClone(capture.configuration),
    replayRecipe: structuredClone(capture.replayRecipe),
    inputs: {
      sourceCommit: capture.inputs.sourceCommit,
      gitObjectFormat: capture.inputs.gitObjectFormat,
      manifestSha256: recordSha256(files),
      coneSha256: result.scope.coneSha256 ?? result.scope.worktreeFingerprint,
      files
    },
    outputs: {
      resultSchemaVersion: result.schemaVersion,
      factsSha256: capture.outputs.factsSha256,
      predicateResultsSha256: capture.outputs.predicateResultsSha256 ?? null,
      page: structuredClone(capture.outputs.page ?? null)
    },
    retention: {
      status: mode === 'replayable' ? 'retained' : 'identified',
      bundleSha256: retained.bundleSha256,
      resolver: mode === 'replayable' ? retained.storeId : null
    },
    createdAt: new Date().toISOString(),
    integritySha256: ''
  };
  manifest.derivationSha256 = recordSha256(derivationPayload(manifest));
  manifest.integritySha256 = recordSha256(integrityPayload(manifest));
  validateAstDerivationManifest(manifest);
  const relative = derivationRelativePath(config, workflow, manifest.derivationSha256);
  try {
    const existing = validateAstDerivationManifest(JSON.parse(await readFile(path.join(root, relative), 'utf8')));
    return {
      manifest: existing,
      relative,
      reference: {
        sha256: existing.derivationSha256,
        path: relative,
        manifestIntegritySha256: existing.integritySha256,
        replayability: existing.retention.status === 'retained' ? 'replayable' : 'identified'
      }
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return {
    manifest,
    relative,
    reference: {
      sha256: manifest.derivationSha256,
      path: relative,
      manifestIntegritySha256: manifest.integritySha256,
      replayability: mode === 'replayable' ? 'replayable' : 'identified'
    }
  };
}

export async function persistAstDerivation(root, derivation) {
  validateAstDerivationManifest(derivation.manifest);
  const target = path.join(root, derivation.relative);
  try {
    const existing = validateAstDerivationManifest(JSON.parse(await readFile(target, 'utf8')));
    if (existing.integritySha256 !== derivation.manifest.integritySha256) {
      throw new SingularityFlowError('Immutable AST derivation path already contains different record bytes.', {
        code: 'AST_DERIVATION_COLLISION'
      });
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await writeFile(target, canonicalJson(derivation.manifest), { flag: 'wx', mode: 0o600 });
    } catch (writeError) {
      if (writeError?.code !== 'EEXIST') throw writeError;
    }
  }
  const stored = validateAstDerivationManifest(JSON.parse(await readFile(target, 'utf8')));
  if (stored.derivationSha256 !== derivation.reference.sha256) {
    throw new SingularityFlowError('Persisted AST derivation does not match its reference.', { code: 'AST_DERIVATION_PERSIST_FAILED' });
  }
  return derivation.reference;
}

export function astDerivationProvenanceLine(manifest) {
  return `AST evidence ${manifest.retention.status === 'retained' ? 'replayable' : manifest.retention.status} · source ${String(manifest.inputs.sourceCommit).slice(0, 12)} · engine ${manifest.engine.artifactSha256.slice(0, 12)} · extractor ${manifest.adapter.id}@${manifest.adapter.extractorVersion}/${manifest.adapter.artifactSha256.slice(0, 12)}.`;
}
