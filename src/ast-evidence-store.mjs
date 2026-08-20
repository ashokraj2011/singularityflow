import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { gitCommonDir } from './git.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { SingularityFlowError } from './util.mjs';

function configuredRoot(root, environment = process.env) {
  return environment.SINGULARITY_FLOW_AST_EVIDENCE_STORE
    ? path.resolve(environment.SINGULARITY_FLOW_AST_EVIDENCE_STORE)
    : path.join(gitCommonDir(root), 'singularity-flow', 'ast-evidence-store');
}

async function assertDirectoryTarget(target) {
  const info = await lstat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (info?.isSymbolicLink()) {
    throw new SingularityFlowError('AST evidence store root must not be a symbolic link.', {
      code: 'AST_EVIDENCE_STORE_UNSAFE'
    });
  }
  if (info && !info.isDirectory()) {
    throw new SingularityFlowError('AST evidence store root must be a directory.', {
      code: 'AST_EVIDENCE_STORE_UNSAFE'
    });
  }
  if (info) await realpath(target);
}

async function assertStoreTree(storeRoot) {
  await assertDirectoryTarget(storeRoot);
  const bundles = path.join(storeRoot, 'bundles');
  await assertDirectoryTarget(bundles);
  const resolvedRoot = await realpath(storeRoot);
  const resolvedBundles = await realpath(bundles);
  if (!resolvedBundles.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new SingularityFlowError('AST evidence bundle directory escapes its configured store.', {
      code: 'AST_EVIDENCE_STORE_UNSAFE'
    });
  }
}

function bundlePath(root, digest, environment) {
  if (!/^[a-f0-9]{64}$/.test(digest ?? '')) {
    throw new SingularityFlowError('AST evidence bundle digest is invalid.', { code: 'AST_EVIDENCE_BUNDLE_INVALID' });
  }
  return path.join(configuredRoot(root, environment), 'bundles', `${digest}.json`);
}

/** Content-address and read-after-write verify a toolchain bundle. */
export async function retainAstEvidenceBundle(root, storeId, bundle, { environment = process.env } = {}) {
  const storeRoot = configuredRoot(root, environment);
  await assertDirectoryTarget(storeRoot);
  const bytes = canonicalJson(bundle);
  const sha256 = recordSha256(bundle);
  const target = bundlePath(root, sha256, environment);
  await mkdir(path.dirname(target), { recursive: true });
  await assertStoreTree(storeRoot);
  try {
    const existing = await readFile(target, 'utf8');
    if (existing !== bytes) throw new SingularityFlowError('AST evidence store content address already contains different bytes.', { code: 'AST_EVIDENCE_STORE_COLLISION' });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    try { await writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (writeError) {
      if (writeError?.code !== 'EEXIST') throw writeError;
      // Another process won the same content-addressed write. The read-after-write verification
      // below decides whether it wrote the identical canonical bundle.
    }
  }
  const verified = await readFile(target, 'utf8');
  if (recordSha256(JSON.parse(verified)) !== sha256) {
    throw new SingularityFlowError('AST evidence bundle failed read-after-write verification.', { code: 'AST_EVIDENCE_STORE_VERIFY_FAILED' });
  }
  return { storeId, bundleSha256: sha256 };
}

/** Resolve strictly by logical store id plus digest; physical paths never enter evidence. */
export async function resolveAstEvidenceBundle(root, storeId, digest, { environment = process.env } = {}) {
  try {
    await assertStoreTree(configuredRoot(root, environment));
  } catch (error) {
    if (error?.code === 'ENOENT') return { available: false, storeId, bundleSha256: digest, reason: 'bundle-missing' };
    throw error;
  }
  const target = bundlePath(root, digest, environment);
  try {
    const bytes = await readFile(target, 'utf8');
    const bundle = JSON.parse(bytes);
    if (recordSha256(bundle) !== digest) {
      throw new SingularityFlowError('Retained AST evidence bundle digest does not match its requested content address.', { code: 'AST_EVIDENCE_BUNDLE_INVALID' });
    }
    return { available: true, storeId, bundleSha256: digest, bundle };
  } catch (error) {
    if (error?.code === 'ENOENT') return { available: false, storeId, bundleSha256: digest, reason: 'bundle-missing' };
    throw error;
  }
}

export function astEvidenceStoreDescription(root, storeId, { environment = process.env } = {}) {
  return { id: storeId, type: 'directory', configured: Boolean(environment.SINGULARITY_FLOW_AST_EVIDENCE_STORE), root: configuredRoot(root, environment) };
}
