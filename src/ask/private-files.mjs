import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { failure } from './shared-contract.mjs';

const unsafe = () => failure('ASK_PROVIDER_PRIVATE_FILE_REQUIRED', 'The Ask provider file must be a bounded private file owned by the current user.');

export async function readPrivateText(file, limit) {
  let handle;
  try {
    const entry = await lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink()) throw unsafe();
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit || (process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o077)))) throw unsafe();
    return await handle.readFile('utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'ELOOP') throw unsafe();
    throw error;
  } finally { await handle?.close(); }
}

export async function readPrivateConfiguration(file, schema) {
  const text = await readPrivateText(file, 1024 * 1024);
  if (text === null) return null;
  try { return schema.parse(JSON.parse(text)); }
  catch { throw failure('ASK_PROVIDER_CONFIGURATION_INVALID', 'The private Ask provider configuration has an unsupported format. See Ask SFlow help for the configuration fields.'); }
}
