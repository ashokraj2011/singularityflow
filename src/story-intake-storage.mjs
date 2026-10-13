/** Windows receipt secrets have their own qualified store; legacy publication keys are untouched. */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { gitCommonDir } from './git.mjs';
import { safePrivateSidecarDirectory } from './private-sidecar.mjs';
import { prepareSharedPublicationStorage } from './publication-storage.mjs';

let aclModule;
async function defaultWindowsAcl(target, options) {
  aclModule ??= import('./mcp-auth-profile.mjs');
  return (await aclModule).secureWindowsAuthAcl(target, options);
}

/** ACL checks are one bounded native wave for the whole store, not one per old receipt. */
export async function storyIntakeStorage(root, {
  create = true, platform = process.platform, windowsAcl = defaultWindowsAcl
} = {}) {
  if (platform !== 'win32') return {
    directory: await prepareSharedPublicationStorage(root, 'intake-receipts', 'Story intake receipt'),
    key: undefined, protect: async () => {}
  };
  const directory = path.join(gitCommonDir(root), 'singularity-flow', 'intake-receipts');
  await safePrivateSidecarDirectory(root, directory, {
    create, platform, enforceWindowsAcl: true,
    windowsAcl: (target, options) => windowsAcl(target, { ...options, recursive: true })
  });
  const target = path.join(directory, 'integrity.key');
  let info = await lstat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info && create) {
    let handle;
    try {
      // The containing ACL is already private before any secret byte is written. Exclusive
      // creation lets concurrent previews share the winner's key rather than rotate it.
      handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(randomBytes(32)); await handle.sync();
      await windowsAcl(target, { directory: false, apply: true });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      // A competing writer may not yet have protected the key. Recheck, never silently fix it.
      await windowsAcl(directory, { directory: true, recursive: true, apply: false });
    } finally { await handle?.close(); }
    info = await lstat(target);
  }
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== 32) {
    throw new Error('Story intake private key is unavailable or unsafe.');
  }
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const observed = await handle.stat();
    if (!observed.isFile() || observed.dev !== info.dev || observed.ino !== info.ino
        || observed.nlink !== 1 || observed.size !== 32) throw new Error('Story intake private key changed.');
    const key = Buffer.alloc(33);
    const { bytesRead } = await handle.read(key, 0, key.length, 0);
    if (bytesRead !== 32) throw new Error('Story intake private key has invalid bytes.');
    return { directory, key: key.subarray(0, 32),
      protect: (file) => windowsAcl(file, { directory: false, apply: true }) };
  } finally { await handle.close(); }
}
