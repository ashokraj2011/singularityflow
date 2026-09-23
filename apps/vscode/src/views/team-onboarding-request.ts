/** Private request-file transport for the Windows-safe map-team process boundary. */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CapabilityTeamRequestDocument } from './team-onboarding-model.ts';

/** Must remain no larger than the CLI request-file and normalized aggregate limits. */
export const TEAM_ONBOARDING_REQUEST_MAX_BYTES = 512 * 1024;

interface RequestFileDependencies {
  remove?: (directory: string, options: { recursive: true; force: true }) => Promise<void>;
}

/**
 * Materialize one exclusive, user-private request file for exactly the lifetime of a CLI call.
 *
 * The Windows user temp directory already carries the user's ACL. POSIX hosts additionally get an
 * explicit 0700 directory and 0600 file. Cleanup lives in this boundary's finally block so success,
 * refusal, cancellation, timeout, and a throwing result parser have the same deletion behaviour.
 */
export async function withTeamOnboardingRequestFile<T>(
  request: CapabilityTeamRequestDocument,
  invoke: (requestFile: string) => Promise<T>,
  dependencies: RequestFileDependencies = {}
): Promise<T> {
  const serialized = JSON.stringify(request);
  if (Buffer.byteLength(serialized, 'utf8') > TEAM_ONBOARDING_REQUEST_MAX_BYTES) {
    throw new Error('The team onboarding request is too large to send safely.');
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-map-team-'));
  try {
    if (process.platform !== 'win32') await chmod(directory, 0o700);
    const requestFile = path.join(directory, 'request.json');
    await writeFile(requestFile, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    if (process.platform !== 'win32') await chmod(requestFile, 0o600);
    return await invoke(requestFile);
  } finally {
    // The CLI result may describe an already-published proposal. A local temp cleanup fault must
    // never replace that durable success (or its original refusal) and invite an unsafe retry.
    await (dependencies.remove ?? rm)(directory, { recursive: true, force: true }).catch(() => {});
  }
}
