/**
 * Protected artifact sidecars. `[SPK:REQ-043]` `[SPK:CON-022]` `[SPK:CON-023]` `[SPK:CON-024]`
 *
 * The problem a sidecar solves is short to state: **if provenance lives inside the document, then
 * whoever writes the document writes the provenance.** A model authoring `spec.md` can emit a
 * managed block claiming a generation, a configuration hash, an approval binding — and it looks
 * exactly like a real one, because there is nothing for it to look different from.
 *
 * So the canonical record moves out of the human-authored Markdown and into a kernel-owned file
 * `[SPK:CON-022]`, and three properties make it worth having:
 *
 * - **Only the kernel writes it.** Sidecars live under the work item's `context/` directory, which
 *   is outside the `artifact-only` write scope a generation is held to — so a model that wrote one
 *   would have its publication refused by the existing check rather than by a new one
 *   `[SPK:CON-023]`. Placement is the enforcement; there is no second policy to keep in step.
 * - **Imported metadata is never trusted.** A human document arriving with Flow-looking blocks has
 *   them stripped before the kernel records anything `[SPK:CON-024]`, so pasting a forged block in
 *   buys nothing.
 * - **The binding is path-scoped.** Identical bytes at a different governed path produce a distinct
 *   sidecar `[SPK:REQ-044]`, so an approved artifact copied elsewhere cannot inherit its approval.
 *
 * The record hashes its own canonical form with the same content-addressing every governed record
 * in this product uses (`src/records.mjs`), so tampering with the *metadata* is detectable and not
 * only tampering with the artifact it describes.
 */
import path from 'node:path';

import { canonicalJson, recordSha256 } from './records.mjs';
import { posix, SingularityFlowError } from './util.mjs';
import { currentSchemaVersion } from './schema-migrations.mjs';

export const ARTIFACT_SIDECAR_SCHEMA_VERSION = currentSchemaVersion('artifact-sidecar');

/**
 * Where sidecars live: kernel-owned, and deliberately not beside the artifact.
 *
 * `artifacts/<phase>/` is the portable directory — `spec.md`, `plan.md`, `tasks.md` — and
 * `[SPK:CON-021]` asks that its leaf names stay portable. A `spec.md.sidecar.json` sitting next to
 * `spec.md` would put machine bookkeeping back into the place the whole change is trying to keep
 * clean, and it would sit *inside* the one directory a generation may write to.
 */
export const SIDECAR_DIRECTORY = 'context/sidecars';

/** A stable, filesystem-safe leaf for an artifact path, so one sidecar maps to one artifact. */
function slug(artifactPath) {
  return posix(String(artifactPath)).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * The sidecar path for one artifact at one generation.
 *
 * The generation is in the name because a sidecar is a record of a publication, not of a file: the
 * next generation of the same artifact gets its own, and the earlier one stays readable.
 */
export function sidecarRelativePath(workDirRelativePath, phaseId, generation, artifactPath) {
  return posix(path.posix.join(
    workDirRelativePath, SIDECAR_DIRECTORY, `${phaseId}-gen${generation}-${slug(artifactPath)}.json`
  ));
}

/** Every field `[SPK:REQ-043]` requires, in the order the clause lists them. */
const REQUIRED = Object.freeze([
  'subject', 'phase', 'generation', 'artifact', 'configuration', 'template', 'inputs', 'producer',
  'publication'
]);

/**
 * Build a sidecar record and seal it with its own integrity hash.
 *
 * Every field is supplied by the caller rather than discovered here. That is deliberate: this module
 * must not become a second place that decides what a generation *is*, and a pure function of its
 * inputs is one that can be proved byte-stable.
 */
export function buildArtifactSidecar(input) {
  for (const field of REQUIRED) {
    if (input?.[field] === undefined || input?.[field] === null) {
      throw new SingularityFlowError(`Artifact sidecar is missing required field '${field}'.`);
    }
  }
  if (!input.artifact.path || !input.artifact.sha256) {
    throw new SingularityFlowError('Artifact sidecar needs the artifact path and its content hash.');
  }
  const record = {
    schemaVersion: ARTIFACT_SIDECAR_SCHEMA_VERSION,
    subject: { kind: input.subject.kind, id: input.subject.id },
    phase: input.phase,
    generation: input.generation,
    artifact: {
      // Path-scoped by construction `[SPK:REQ-044]`: the path is inside the hashed record, so the
      // same bytes at a different governed path produce a different sidecar and a different binding.
      path: posix(input.artifact.path),
      sha256: input.artifact.sha256,
      bytes: input.artifact.bytes ?? null,
      role: input.artifact.role ?? null
    },
    configuration: { sha256: input.configuration.sha256 ?? null, revision: input.configuration.revision ?? null },
    template: { path: input.template.path ?? null, sha256: input.template.sha256 ?? null },
    inputs: [...input.inputs].map((entry) => ({
      path: posix(entry.path), sha256: entry.sha256 ?? null, kind: entry.kind ?? null
    })).sort((left, right) => left.path.localeCompare(right.path)),
    producer: {
      kind: input.producer.kind, actor: input.producer.actor ?? null, agent: input.producer.agent ?? null
    },
    publication: {
      commit: input.publication.commit ?? null,
      branch: input.publication.branch ?? null,
      publishedAt: input.publication.publishedAt ?? null
    }
  };
  // The hash covers the record without itself, so it can be recomputed and compared.
  return Object.freeze({ ...record, integritySha256: recordSha256(record) });
}

/** Recompute the integrity hash and report whether the record is intact. */
export function verifyArtifactSidecar(record) {
  if (!record || typeof record !== 'object') return { valid: false, reason: 'the sidecar is not an object' };
  const { integritySha256, ...rest } = record;
  if (!integritySha256) return { valid: false, reason: 'the sidecar carries no integrity hash' };
  const expected = recordSha256(rest);
  return integritySha256 === expected
    ? { valid: true, reason: null }
    : { valid: false, reason: `integrity hash is ${integritySha256.slice(0, 12)}, recomputes to ${expected.slice(0, 12)}` };
}

/** Serialize canonically, so the same record is always the same bytes on disk. */
export function serializeArtifactSidecar(record) {
  return canonicalJson(record);
}

/**
 * Blocks that look like Flow metadata but were not written by the kernel. `[SPK:CON-024]`
 *
 * The kernel does inject managed blocks today — `<!-- singularity-flow:inputs:start -->` and the
 * initiative-metadata block — so "looks like ours" is not the same as "is ours". An imported human
 * document is not a governed artifact yet, and anything in it claiming otherwise is a claim its
 * author made about themselves.
 */
const FORGED_PATTERNS = Object.freeze([
  // Paired blocks first, and as a unit. Stripping `:start` and `:end` as two separate comments
  // leaves the payload between them sitting in the document — which is the forged content, so
  // removing only its wrapper is the one outcome worse than doing nothing.
  /<!--\s*(?:singularity-flow|sflow):([a-z-]+):start\s*-->[\s\S]*?<!--\s*(?:singularity-flow|sflow):\1:end\s*-->/g,
  // Then any remaining single Flow comment, including an unpaired half of a block.
  /<!--\s*(?:singularity-flow|sflow):[\s\S]*?-->/g,
  /<!--\s*managed-by:\s*singularity-flow[\s\S]*?-->/g
]);

/**
 * Strip forged Flow metadata from an imported document, reporting what was removed.
 *
 * Removing rather than rejecting: a person pasting in a document they exported from somewhere else
 * has done nothing wrong, and refusing the import would teach them to hand-edit the block out,
 * which is the same outcome with more steps and less of a record.
 */
export function stripForgedFlowMetadata(text) {
  const original = String(text ?? '');
  let cleaned = original;
  const removed = [];
  for (const pattern of FORGED_PATTERNS) {
    cleaned = cleaned.replace(pattern, (match) => {
      removed.push(match.slice(0, 120));
      return '';
    });
  }
  // Collapse the blank lines the removal leaves behind, so a stripped document reads normally.
  if (removed.length) cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trimStart();
  return { text: cleaned, removed, changed: removed.length > 0 };
}

/**
 * Whether a path is inside the region a generation is allowed to write. `[SPK:CON-023]`
 *
 * Used to assert the invariant rather than to enforce it — enforcement is the existing
 * `artifact-only` check in `publishGeneration`, and this exists so a test can prove the sidecar
 * directory stays outside it if either ever moves.
 */
export function withinGenerationWriteScope(workDirRelativePath, phaseId, candidate) {
  const allowed = posix(path.posix.join(workDirRelativePath, 'artifacts', phaseId)) + '/';
  return posix(String(candidate)).startsWith(allowed);
}
