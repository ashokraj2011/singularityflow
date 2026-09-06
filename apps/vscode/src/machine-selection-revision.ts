/**
 * Privacy-safe revision of the machine-local active-workspace selector.
 *
 * The extension already watches this small record. Explicit Refresh uses the revision as a cheap
 * fence: when the bytes have not changed, spawning `workspace current` cannot discover a different
 * selection and would only delay the repository snapshot. The selector's contents and path are
 * never returned or logged.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

export const MAX_MACHINE_SELECTION_BYTES = 256 * 1024;

/**
 * `null` is a reliable observation that the record is absent. `undefined` means it could not be
 * observed safely, so callers must retain the authoritative CLI fallback.
 */
export async function machineSelectionRevision(file: string): Promise<string | null | undefined> {
  try {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.size < 0 || metadata.size > MAX_MACHINE_SELECTION_BYTES) {
      return undefined;
    }
    const bytes = await readFile(file);
    if (bytes.length > MAX_MACHINE_SELECTION_BYTES) return undefined;
    return createHash('sha256').update(bytes).digest('hex');
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? null : undefined;
  }
}
