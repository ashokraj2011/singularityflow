/** Read-only diagnostics. Package identity, host admission, and approval are separate claims. */
import { verifySkillPackage } from './skp-package.mjs';
import { diagnoseSkillHostReadiness } from './skp-host-readiness.mjs';
import { SingularityFlowError } from './util.mjs';

export function diagnoseRetainedSkillPackage(retained, { source = null } = {}) {
  // Both copies must be verified in full. Never downgrade corrupt retained bytes to an update,
  // consult a live folder as a fallback, or disclose the raw instructions in the report.
  verifySkillPackage({ manifest: retained.manifest, contents: retained.files });
  if (retained.skillId !== retained.manifest.skillId
      || retained.packageSha256 !== retained.manifest.packageSha256) {
    throw new SingularityFlowError('Retained skill summary disagrees with its exact package.',
      { code: 'SKP_PACKAGE_CORRUPT' });
  }
  if (source) verifySkillPackage(source);
  const sourceStatus = !source ? 'not-checked'
    : source.manifest.skillId !== retained.skillId ? 'different-skill'
      : source.manifest.packageSha256 === retained.packageSha256 ? 'unchanged' : 'update-available';
  return {
    schemaVersion: 1, resultType: 'sflow-skill-diagnostic',
    skillId: retained.skillId, phaseId: retained.phaseId,
    packageSha256: retained.packageSha256,
    contractSha256: retained.contractSha256,
    snapshotHash: retained.snapshotHash,
    retention: { status: 'complete', files: retained.manifest.files.length,
      bytes: retained.manifest.files.reduce((sum, file) => sum + file.bytes, 0) },
    provenance: { status: 'not-checked' },
    source: { status: sourceStatus, packageSha256: source?.manifest.packageSha256 ?? null },
    host: diagnoseSkillHostReadiness(),
    execution: 'not-run', checks: 'not-run', approval: 'not-checked',
    executable: false, mutationRequired: false,
    guidance: sourceStatus === 'update-available'
      ? 'The original source changed. The retained package is unchanged; adoption requires a separate reviewed amendment.'
      : 'Retained bytes are intact. Skill execution remains unavailable: pre-effect enforcement, authenticated mediated confirmation and exact host delivery owners are missing. The host diagnostic identifies the registered source integration seam and prerequisites; it grants no execution permission.'
  };
}
