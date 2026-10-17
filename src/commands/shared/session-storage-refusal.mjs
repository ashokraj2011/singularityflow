/**
 * Opening or attaching a Story in a workspace repository whose own Git files are undownloaded
 * cloud placeholders (git-storage-availability.mjs). Nothing there is deleted, moved or
 * overwritten: the person either downloads the folder, or confirms a fresh clone of the workspace
 * outside the synced folder with the existing `workspace duplicate`, which reads only the manifest
 * and clones from the repository URLs, and then switches to it.
 */
import os from 'node:os';
import path from 'node:path';
import { gitStorageError } from '../../git-storage-availability.mjs';

export function offloadedRepositoryRefusal(storage, { workId = null, workspaceContext = null, operation = 'attach' } = {}) {
  const refusal = gitStorageError(storage);
  const subject = workspaceContext?.repositoryId ? `Repository '${workspaceContext.repositoryId}'` : 'The repository';
  const story = workId ? `Story ${workId}` : 'the Story';
  const folder = storage.cloudFolder || 'the synced folder';
  const retry = `/sf-session${workId ? ` ${workId}` : ''}`;
  let relocation = null;
  if (workspaceContext?.workspacePath) {
    const id = `${workspaceContext.anchorKey ?? path.basename(workspaceContext.workspacePath)}-local`;
    const base = path.join(os.homedir(), 'sflow-workspaces');
    relocation = {
      requiresConfirmation: true,
      argv: ['workspace', 'duplicate', workspaceContext.workspacePath, '--id', id, '--base', base, '--clone'],
      useArgv: ['workspace', 'use', id],
      path: path.join(base, id)
    };
  }
  const quoted = (argv) => `singularity-flow ${argv.map((value) => (/^[\w./:@=-]+$/u.test(value) ? value : JSON.stringify(value))).join(' ')}`;
  refusal.message = `${subject} at ${storage.repository} is offloaded: ${storage.files} of its Git files are cloud `
    + `placeholders that this computer has not downloaded, so ${story} cannot be ${operation === 'open' ? 'opened' : 'attached'} there. `
    + 'Nothing was changed, moved or deleted. Either download that folder and keep it downloaded (in Finder: Control-click it, '
    + `then Download Now) and run ${retry} again`
    + (relocation
      ? `, or, only if you confirm, clone the workspace again outside ${folder} with \`${quoted(relocation.argv)}\` and switch to it with \`${quoted(relocation.useArgv)}\`.`
      : `, or move the workspace out of ${folder}.`);
  refusal.details = { ...refusal.details, offloaded: true, operation, workId, relocation };
  return refusal;
}
