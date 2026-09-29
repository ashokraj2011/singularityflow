/**
 * Which file an editor, Explorer or Source Control menu was opened on.
 *
 * Each menu hands its command something different: the editor and the Explorer pass the file's
 * Uri, Source Control passes a resource state that carries it, and the palette passes nothing. The
 * commands then need that file as a repository-relative path, which is how every comprehension
 * slice names files.
 */
import { realpath } from 'node:fs/promises';
import path from 'node:path';

export interface MenuResource {
  fsPath: string;
  scheme: string;
}

function asResource(value: unknown): MenuResource | null {
  if (!value || typeof value !== 'object') return null;
  const { fsPath, scheme } = value as { fsPath?: unknown; scheme?: unknown };
  return typeof fsPath === 'string' && typeof scheme === 'string' ? { fsPath, scheme } : null;
}

/** The file a menu passed: a Uri, or a Source Control resource state's Uri. Anything else is none. */
export function menuResource(argument: unknown): MenuResource | null {
  if (argument && typeof argument === 'object' && 'resourceUri' in argument) {
    return asResource((argument as { resourceUri?: unknown }).resourceUri);
  }
  return asResource(argument);
}

function inside(root: string, file: string): string | null {
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

/**
 * `file` as a repository-relative POSIX path, or null when it is outside `root`.
 *
 * The governed root is canonical, but an editor can hold the same file through a symbolic link
 * (on macOS `/tmp` is `/private/tmp`), so a file that looks outside is compared again with links
 * resolved. A file deleted in the working tree, chosen from Source Control, has nothing to resolve;
 * its folder is resolved instead.
 */
export async function repositoryRelativePath(root: string, file: string): Promise<string | null> {
  const direct = inside(root, file);
  if (direct) return direct;
  const canonicalRoot = await realpath(root).catch(() => root);
  const canonicalFile = await realpath(file).catch(async () =>
    path.join(await realpath(path.dirname(file)).catch(() => path.dirname(file)), path.basename(file)));
  return inside(canonicalRoot, canonicalFile);
}
