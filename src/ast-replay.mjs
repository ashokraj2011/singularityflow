import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  currentAstEvidenceIdentities, validateAstDerivationManifest
} from './ast-evidence.mjs';
import { resolveAstEvidenceBundle } from './ast-evidence-store.mjs';
import { recordSha256 } from './records.mjs';
import { readRecord } from './schema-migrations.mjs';
import { optionString, posix, run, SingularityFlowError } from './util.mjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function withoutIntegrity(record) {
  const { integritySha256: _integrity, ...content } = record;
  return content;
}

function repositoryFile(root, relative, label) {
  if (!relative || path.isAbsolute(relative)) {
    throw new SingularityFlowError(`${label} must be a repository-relative path.`, { code: 'AST_REPLAY_PATH_INVALID' });
  }
  const normalized = posix(relative);
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new SingularityFlowError(`${label} escapes the repository.`, { code: 'AST_REPLAY_PATH_INVALID' });
  }
  const target = path.resolve(root, normalized);
  const boundary = `${path.resolve(root)}${path.sep}`;
  if (target !== path.resolve(root) && !target.startsWith(boundary)) {
    throw new SingularityFlowError(`${label} escapes the repository.`, { code: 'AST_REPLAY_PATH_INVALID' });
  }
  return { normalized, target };
}

async function derivationReference(root, receiptPath) {
  const { normalized, target } = repositoryFile(root, receiptPath, 'AST replay receipt');
  const stored = JSON.parse(await readFile(target, 'utf8'));
  if (stored.subject?.evidenceClass && stored.inputs?.sourceCommit) {
    const manifest = validateAstDerivationManifest(stored);
    return { manifest, reference: { sha256: manifest.derivationSha256, path: normalized } };
  }
  if (stored.integritySha256 && recordSha256(withoutIntegrity(stored)) !== stored.integritySha256) {
    throw new SingularityFlowError('AST evidence receipt integrity is invalid.', { code: 'AST_REPLAY_RECEIPT_INVALID' });
  }
  const family = stored.workId && stored.phase ? 'ast-gate-receipt' : 'prompt-injection';
  const record = readRecord(family, stored).record;
  const reference = family === 'ast-gate-receipt'
    ? record.derivation
    : record.structuralContext?.derivation;
  if (!reference || reference.replayability === 'legacy-unreplayable') {
    return {
      unavailable: 'legacy-unreplayable',
      reason: reference?.reason ?? 'no AST derivation was recorded'
    };
  }
  if (!reference.path || !reference.sha256) {
    throw new SingularityFlowError('AST evidence receipt has an incomplete derivation reference.', {
      code: 'AST_REPLAY_RECEIPT_INVALID'
    });
  }
  const manifestFile = repositoryFile(root, reference.path, 'AST derivation');
  const manifest = validateAstDerivationManifest(JSON.parse(await readFile(manifestFile.target, 'utf8')));
  if (manifest.derivationSha256 !== reference.sha256
      || manifest.integritySha256 !== reference.manifestIntegritySha256) {
    throw new SingularityFlowError('AST derivation reference does not match the immutable manifest.', {
      code: 'AST_REPLAY_DERIVATION_INVALID'
    });
  }
  return { manifest, reference };
}

function unavailable(derivationSha256, reason, remedy) {
  return {
    schemaVersion: 1,
    operation: 'ast-evidence-replay',
    derivationSha256: derivationSha256 ?? null,
    result: 'unavailable',
    replayedAt: new Date().toISOString(),
    reasons: [{ code: reason, remedy }],
    differences: []
  };
}

async function committedInputs(root, manifest, temporaryView) {
  const commit = manifest.inputs.sourceCommit;
  const commitCheck = run('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: root, allowFailure: true });
  if (commitCheck.status !== 0) return { unavailable: 'source-commit-missing' };
  const objectFormat = run('git', ['rev-parse', '--show-object-format'], { cwd: root, allowFailure: true });
  if (objectFormat.status !== 0 || objectFormat.stdout.trim() !== manifest.inputs.gitObjectFormat) {
    return { unavailable: 'source-object-format-mismatch' };
  }
  const files = [];
  for (const input of manifest.inputs.files) {
    const object = run('git', ['rev-parse', '--verify', `${commit}:${input.path}`], {
      cwd: root, allowFailure: true
    });
    if (object.status !== 0 || object.stdout.trim() !== input.gitObjectId) {
      return { unavailable: 'source-object-mismatch', path: input.path };
    }
    const treeEntry = run('git', ['ls-tree', commit, '--', input.path], {
      cwd: root, allowFailure: true
    });
    if (treeEntry.status !== 0 || treeEntry.stdout.trim().split(/\s+/, 1)[0] !== input.gitMode) {
      return { unavailable: 'source-mode-mismatch', path: input.path };
    }
    const shown = run('git', ['cat-file', 'blob', input.gitObjectId], {
      cwd: root, allowFailure: true, encoding: 'buffer', maxBuffer: Math.max(2 * 1024 * 1024, (input.bytes ?? 0) + 1024)
    });
    if (shown.status !== 0 || sha256(shown.stdout) !== input.contentSha256) {
      return { unavailable: 'source-content-mismatch', path: input.path };
    }
    const destination = repositoryFile(temporaryView, input.path, 'AST replay input').target;
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, shown.stdout, { mode: 0o600 });
    files.push({ input: structuredClone(input), bytes: shown.stdout });
  }
  return { files };
}

async function retainedReplayRunner(bundle, temporaryView) {
  const expected = new Set(['ast-builtin-extractor.mjs', 'ast-replay-runner.mjs']);
  const artifacts = bundle.replayArtifacts;
  if (!Array.isArray(artifacts) || artifacts.length !== expected.size) return null;
  await mkdir(temporaryView, { recursive: true });
  for (const artifact of artifacts) {
    if (!expected.delete(artifact?.path) || typeof artifact.bytesBase64 !== 'string') return null;
    const bytes = Buffer.from(artifact.bytesBase64, 'base64');
    if (sha256(bytes) !== artifact.sha256) return null;
    await writeFile(path.join(temporaryView, artifact.path), bytes, { mode: 0o600 });
  }
  if (expected.size) return null;
  const module = await import(`${pathToFileURL(path.join(temporaryView, 'ast-replay-runner.mjs')).href}?sha=${bundle.engine.artifactSha256}`);
  return typeof module.replayBuiltInDerivation === 'function' ? module.replayBuiltInDerivation : null;
}

/** Cache-independent, model-free replay of a durable AST derivation. */
export async function replayAstEvidence(root, options = {}) {
  const receipt = optionString(options, 'receipt');
  if (!receipt) throw new SingularityFlowError('wm ast evidence replay requires --receipt <PATH>.');
  const resolved = await derivationReference(root, receipt);
  if (resolved.unavailable) return unavailable(null, resolved.unavailable, resolved.reason);
  const { manifest } = resolved;
  if (manifest.retention.status !== 'retained' || !manifest.retention.resolver) {
    return unavailable(
      manifest.derivationSha256,
      'toolchain-not-retained',
      'Republish recorded context with ast.evidence.mode=replayable and a configured evidence store.'
    );
  }
  const retained = await resolveAstEvidenceBundle(
    root, manifest.retention.resolver, manifest.retention.bundleSha256
  );
  if (!retained.available) {
    return unavailable(manifest.derivationSha256, 'toolchain-bundle-missing', 'Restore the recorded bundle in the configured AST evidence store.');
  }
  const identities = await currentAstEvidenceIdentities();
  const retainedAdapter = retained.bundle.adapters?.find((entry) => entry.id === manifest.adapter.id);
  if (recordSha256(retained.bundle.engine) !== recordSha256(manifest.engine)
      || recordSha256(retainedAdapter ?? null) !== recordSha256(manifest.adapter)) {
    return unavailable(manifest.derivationSha256, 'retained-toolchain-mismatch', 'Restore the exact content-addressed toolchain bundle.');
  }
  if (recordSha256(identities.runtime) !== recordSha256(manifest.runtime)) {
    return unavailable(manifest.derivationSha256, 'replay-runtime-incompatible', `Use the retained Singularity Flow runtime for ${manifest.runtime.platform}.`);
  }
  const temporaryView = await mkdtemp(path.join(os.tmpdir(), 'sflow-ast-replay-'));
  try {
    const recovered = await committedInputs(root, manifest, path.join(temporaryView, 'inputs'));
    if (recovered.unavailable) {
      return unavailable(
        manifest.derivationSha256,
        recovered.unavailable,
        `Fetch commit ${manifest.inputs.sourceCommit} and all referenced Git objects${recovered.path ? ` including ${recovered.path}` : ''}.`
      );
    }
    const runner = await retainedReplayRunner(retained.bundle, path.join(temporaryView, 'toolchain'));
    if (!runner) {
      return unavailable(manifest.derivationSha256, 'retained-runner-invalid', 'Restore the exact digest-verified replay artifacts in the evidence store.');
    }
    const recomputed = runner(recovered.files, manifest);
    const { factsSha256, predicateResultsSha256, pageFactsSha256 } = recomputed;
    const differences = [];
    if (factsSha256 !== manifest.outputs.factsSha256) differences.push({ field: 'factsSha256', expected: manifest.outputs.factsSha256, actual: factsSha256 });
    if (predicateResultsSha256 !== manifest.outputs.predicateResultsSha256) {
      differences.push({ field: 'predicateResultsSha256', expected: manifest.outputs.predicateResultsSha256, actual: predicateResultsSha256 });
    }
    if (manifest.outputs.page) {
      if (pageFactsSha256 !== manifest.outputs.page.factsSha256) {
        differences.push({
          field: 'page.factsSha256',
          expected: manifest.outputs.page.factsSha256,
          actual: pageFactsSha256
        });
      }
    }
    const result = differences.length ? 'different' : 'identical';
    return {
      schemaVersion: 1,
      operation: 'ast-evidence-replay',
      derivationSha256: manifest.derivationSha256,
      replayEngineArtifactSha256: manifest.engine.artifactSha256,
      brokerEngineArtifactSha256: identities.engine.artifactSha256,
      replayedAt: new Date().toISOString(),
      result,
      reasons: [],
      differences,
      outputs: { factsSha256, predicateResultsSha256 }
    };
  } finally {
    await rm(temporaryView, { recursive: true, force: true });
  }
}
