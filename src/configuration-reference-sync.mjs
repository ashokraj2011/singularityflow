/** Refresh known workspace authority pins, never materialize settings into Story/source files. */
import path from 'node:path';
import { readWorkspace, readWorkspaceRegistry, workspaceRepositoryPath } from './workspace-manifest.mjs';
import { workspaceRegistryFile } from './workspace-context.mjs';
import { readFosAttachment, refreshFosAuthority } from './onboard.mjs';
import { remoteFingerprint, redactDiagnosticText } from './git-remote-diagnostics.mjs';
import { enterpriseGitEnvironment } from './git-enterprise-environment.mjs';
import { run } from './util.mjs';

const within = (root, parent) => {
  const relative = path.relative(parent, root);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

export async function syncConfigurationReferences(root, remote, commit, {
  env = process.env, services = {}
} = {}) {
  const host = { readRegistry: readWorkspaceRegistry, readWorkspace, readAttachment: readFosAttachment,
    refresh: refreshFosAuthority, git: run, ...services };
  const roots = new Set([path.resolve(root)]);
  const results = [];
  try {
    const entries = await host.readRegistry(workspaceRegistryFile(env));
    if (entries.length > 100) throw new Error('Workspace reference sync exceeds its bounded registry.');
    for (const entry of entries.filter(entry => !entry.archivedAt)) {
      // Only the selected workspace(s), never every repository in a machine-global registry.
      if (!within(path.resolve(root), entry.path) && entry.leadRepositoryPath !== path.resolve(root)) continue;
      const workspace = await host.readWorkspace(entry.path);
      for (const repository of Object.values(workspace.repositories)) roots.add(workspaceRepositoryPath(workspace, repository));
    }
  } catch (error) {
    results.push({ path: null, status: 'attention', reason: redactDiagnosticText(error.message) });
  }
  if (roots.size > 100) return { status: 'attention', results: [{ path: null, status: 'attention', reason: 'Too many workspace references.' }] };
  for (const checkout of roots) {
    try {
      const observed = host.git('git', ['rev-parse', '--absolute-git-dir', '--git-common-dir'], {
        cwd: checkout, env: enterpriseGitEnvironment(env), allowFailure: true, timeoutMs: 5_000, maxBuffer: 8192
      });
      if (observed.status !== 0) { results.push({ path: checkout, status: 'deferred', reason: 'No available local checkout; not cloned.' }); continue; }
      const [gitDir, common] = observed.stdout.trim().split(/\r?\n/u);
      if (path.resolve(checkout, gitDir) !== path.resolve(checkout, common)) {
        results.push({ path: checkout, status: 'preserved', reason: 'Linked Story/worktree pin retained.' }); continue;
      }
      const attachment = await host.readAttachment(checkout);
      if (!attachment) { results.push({ path: checkout, status: 'not-attached', reason: 'No existing authority pin to refresh.' }); continue; }
      const descriptor = attachment.descriptor;
      if (descriptor?.route?.kind !== 'remote' || !descriptor.authority?.locator
          || remoteFingerprint(descriptor.authority.locator) !== remoteFingerprint(remote)) {
        results.push({ path: checkout, status: 'preserved', reason: 'A different authority is pinned.' }); continue;
      }
      const refreshed = await host.refresh(checkout, { expectedConfigCommit: commit });
      if (!['refreshed', 'already-attached'].includes(refreshed.status)
          || refreshed.descriptor?.authority?.sourceCommit !== commit) throw new Error('Authority refresh did not bind the exact synchronized configuration.');
      results.push({ path: checkout, status: refreshed.status });
    } catch (error) { results.push({ path: checkout, status: 'attention', reason: redactDiagnosticText(error.message) }); }
  }
  return { status: results.some(item => item.status === 'attention') ? 'attention' : 'complete', results };
}
