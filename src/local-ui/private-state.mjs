/** Transport metadata only. Canonical Story, specification and evidence stores stay with their owners. */
import { mkdir, lstat, realpath, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { PACKAGE_ROOT } from '../package-root.mjs';
import { localMachineId, localPidNamespace } from '../lease-liveness.mjs';
import { PROTOCOL, UiError, insist } from './contracts.mjs';

export const engineRoot = PACKAGE_ROOT;
export const cliPath = path.join(engineRoot, 'bin', 'singularity-flow.mjs');
export function serviceDirectory(env = process.env) {
  // Following the registry also keeps older isolated test environments off the person's machine state.
  const parent = env.SINGULARITY_FLOW_WORKSPACE_REGISTRY
    ? path.dirname(env.SINGULARITY_FLOW_WORKSPACE_REGISTRY) : path.join(os.homedir(), '.singularity-flow');
  const scope = createHash('sha256').update(JSON.stringify([os.userInfo().uid, localMachineId(env), os.hostname(), localPidNamespace(), process.platform,
    env.SINGULARITY_FLOW_INSTALLATION_CHANNEL ?? 'stable', PROTOCOL])).digest('hex').slice(0, 16);
  return path.join(env.SINGULARITY_FLOW_UI_ROOT ?? path.join(parent, 'browser'), scope);
}
export async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  insist(info.isDirectory() && !info.isSymbolicLink(), 'UI_PRIVATE_STATE_UNSAFE', 'Local workspace state must be a private directory.');
  if (process.platform !== 'win32') insist((info.mode & 0o077) === 0 && info.uid === process.getuid(),
    'UI_PRIVATE_STATE_UNSAFE', 'Local workspace state must be owned by this user and inaccessible to other users.');
}
export async function readPrivate(file, { maxBytes = 2 * 1024 * 1024 } = {}) {
  let info;
  try { info = await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  insist(info.isFile() && !info.isSymbolicLink() && info.size <= maxBytes,
    'UI_PRIVATE_STATE_UNSAFE', 'Local workspace metadata is not a regular bounded private file.');
  if (process.platform !== 'win32') insist((info.mode & 0o077) === 0 && info.uid === process.getuid(),
    'UI_PRIVATE_STATE_UNSAFE', 'Local workspace credentials are accessible to another user.');
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new UiError('UI_STATE_UNREADABLE', 'Local workspace metadata could not be read.', { file, cause: error.message }); }
}
export async function writePrivate(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, file); } finally { await unlink(temporary).catch(() => {}); }
}
export async function buildIdentity() {
  const names = ['package.json', 'src/build-info.mjs', 'src/local-ui/contracts.mjs',
    'bin/singularity-flow.mjs', 'src/cli-entry.mjs', 'src/command-registry.mjs', 'src/commands/ui.mjs', 'src/local-ui/cli.mjs',
    'src/local-ui/private-state.mjs', 'src/local-ui/client.mjs', 'src/local-ui/server.mjs',
    'src/local-ui/operations.mjs', 'src/local-ui/bridge-client.mjs', 'src/local-ui/public/app.js',
    'src/local-ui/public/app.css', 'src/local-ui/public/index.html', 'src/local-ui/public/views.js',
    'src/local-ui/public/ask.js', 'src/local-ui/public/ask-results.js', 'src/local-ui/ask-story.mjs', 'src/ask/chat.mjs',
    'src/local-ui/ask-help.mjs', 'src/docs-manifest.json', 'src/help-service.mjs', 'src/docs-topics.mjs', 'src/model-limits.mjs',
    'src/ask/query.mjs', 'src/ask/history-intent.mjs',
    'src/local-ui/public/code-explainer.js', 'src/local-ui/public/code-explainer.css',
    'src/code-intelligence/code-explainer-view.mjs', 'src/code-intelligence/generated/code-explainer-model.mjs',
    'src/code-intelligence/generated/code-explainer-lenses.mjs', 'src/comprehension/code-map.mjs',
    'src/comprehension/code-map-panel.mjs'];
  names.push('src/local-ui/native-auth.mjs', 'src/local-ui/cli-recovery.mjs', 'src/local-ui/story-context.mjs', 'src/story-index.mjs');
  const hash = createHash('sha256');
  for (const name of names) hash.update(name).update(await readFile(path.join(engineRoot, name)));
  const pkg = JSON.parse(await readFile(path.join(engineRoot, 'package.json'), 'utf8'));
  const stamp = await readFile(path.join(engineRoot, 'src/build-info.mjs'), 'utf8');
  return { protocol: PROTOCOL, version: pkg.version, fingerprint: hash.digest('hex'),
    mode: /(?:commit|sourceSha256):\s*['"](?:[a-f0-9]{40}|(?:sha256:)?[a-f0-9]{64})['"]/u.test(stamp) ? 'stamped' : 'development',
    engineRoot: await realpath(engineRoot), executable: await realpath(process.execPath), runtime: process.version,
    platform: process.platform, arch: process.arch };
}
export async function removeOwnDescriptor(file, instance) {
  const current = await readPrivate(file);
  if (current?.instance === instance) await unlink(file);
}
