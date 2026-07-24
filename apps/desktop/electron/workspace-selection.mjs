import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export const WORKSPACE_MANIFEST = 'workspace.json';

async function regularManifest(root) {
  const file = path.join(root, WORKSPACE_MANIFEST);
  const metadata = await lstat(file).catch(() => null);
  return metadata?.isFile() && !metadata.isSymbolicLink() ? root : null;
}

export async function inspectWorkspaceSelection(selection) {
  const requested = path.resolve(String(selection ?? '').trim());
  const canonical = await realpath(requested).catch(() => null);
  const metadata = canonical ? await lstat(canonical).catch(() => null) : null;
  if (!metadata?.isDirectory()) throw new Error('Choose a local project-workspace directory.');
  if (canonical === path.parse(canonical).root) throw new Error('Choose a specific project-workspace directory.');

  if (await regularManifest(canonical)) {
    return { directory: canonical, mode: 'open', workspaces: [canonical] };
  }

  const workspaces = [];
  for (const entry of await readdir(canonical, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = path.join(canonical, entry.name);
    if (await regularManifest(candidate)) workspaces.push(candidate);
  }
  workspaces.sort((left, right) => left.localeCompare(right));
  if (workspaces.length === 1) return { directory: canonical, mode: 'open', workspaces };
  if (workspaces.length > 1) return { directory: canonical, mode: 'choose-specific', workspaces };
  return { directory: canonical, mode: 'create', workspaces: [] };
}

export async function firstUsableRepository(entries, validateRepository) {
  const seen = new Set();
  for (const entry of entries ?? []) {
    const raw = String(entry?.path ?? entry ?? '').trim();
    if (!raw) continue;
    const candidate = path.resolve(raw);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      return await validateRepository(candidate);
    } catch {
      // A stale recent/onboarding location must not prevent the next usable one.
    }
  }
  return null;
}
