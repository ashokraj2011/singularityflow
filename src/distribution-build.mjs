/** Assemble an installable candidate from the canonical signed pair, without certifying a release. */
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVerifiedReleaseArtifactSnapshot } from './release-artifact-receipt.mjs';
import { DISTRIBUTION_OPERATOR_DOCUMENTATION, DISTRIBUTION_OPERATOR_SCRIPTS, inspectDistributionBundle } from './distribution-bundle.mjs';
import { promoteReleaseDirectory, recoverReleaseDirectoryPromotion } from './release-directory-promotion.mjs';

const assets = fileURLToPath(new URL('../distribution/', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function assembleCandidateDistribution({ artifactReceipt, packagePath, vsixPath,
  trustedPublicKeyPem, destination } = {}) {
  destination = path.resolve(destination);
  await recoverReleaseDirectoryPromotion(destination);
  const verified = await createVerifiedReleaseArtifactSnapshot(artifactReceipt, {
    trustedPublicKeyPem, packagePath, vsixPath,
    expectedCommit: artifactReceipt.sourceCommit, expectedTree: artifactReceipt.sourceTree
  });
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = await mkdtemp(path.join(path.dirname(destination), `.${path.basename(destination)}-candidate-`));
  let published = false;
  try {
    const packageName = path.basename(packagePath), vsixName = path.basename(vsixPath);
    await copyFile(verified.packagePath, path.join(temporary, packageName));
    await copyFile(verified.vsixPath, path.join(temporary, vsixName));
    for (const name of [...DISTRIBUTION_OPERATOR_SCRIPTS, ...DISTRIBUTION_OPERATOR_DOCUMENTATION]) {
      await copyFile(path.join(assets, name), path.join(temporary, name));
      if (name.endsWith('.sh') && process.platform !== 'win32') await chmod(path.join(temporary, name), 0o755);
    }
    const names = (await readdir(temporary)).sort();
    const sums = await Promise.all(names.map(async name => `${digest(await readFile(path.join(temporary, name)))}  ${name}`));
    await writeFile(path.join(temporary, 'SHA256SUMS'), `${sums.join('\n')}\n`);
    const version = packageName.match(/^singularity-flow-(.+)\.tgz$/u)?.[1];
    if (!version) throw new Error('Canonical builder returned an unexpected package filename.');
    await writeFile(path.join(temporary, 'ARTIFACT-RECEIPT.json'), `${JSON.stringify(artifactReceipt, null, 2)}\n`);
    await writeFile(path.join(temporary, 'RELEASE.json'), `${JSON.stringify({
      version, commit: artifactReceipt.sourceCommit,
      distributionStatus: 'candidate-not-release-certified',
      artifactReceiptSha256: artifactReceipt.signature.payloadSha256,
      artefacts: [packageName, vsixName], operatorScripts: DISTRIBUTION_OPERATOR_SCRIPTS,
      operatorDocumentation: DISTRIBUTION_OPERATOR_DOCUMENTATION
    }, null, 2)}\n`);
    // No RELEASE-CHANNEL or verification receipt is invented. Certification still uses release.mjs.
    await inspectDistributionBundle(temporary, { trustedPublicKeyPem });
    await promoteReleaseDirectory(temporary, destination); published = true;
    return { directory: destination, version, status: 'candidate-not-release-certified' };
  } finally {
    await rm(verified.snapshotDirectory, { recursive: true, force: true });
    if (!published) await rm(temporary, { recursive: true, force: true });
  }
}
