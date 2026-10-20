/** One maintenance attempt, never a publication, recovery acceptance or lifecycle writer. */
import path from 'node:path';
import { RETENTION_WORKER_PACKET } from './workspace-retention-background.mjs';

// Read the launch packet once and drop it before any work: no Git child inherits it.
const encoded = process.env[RETENTION_WORKER_PACKET];
delete process.env[RETENTION_WORKER_PACKET];
let packet = null;
try { packet = JSON.parse(encoded ?? ''); } catch { /* Refused below. */ }
if (!path.isAbsolute(packet?.workspacePath ?? '') || !Array.isArray(packet?.protect)
    || packet.protect.length > 32 || packet.protect.some(root => typeof root !== 'string' || !path.isAbsolute(root))) process.exit(1);
try {
  const { runWorkspaceRetention } = await import('./workspace-retention.mjs');
  await runWorkspaceRetention(packet.workspacePath, { protect: packet.protect });
} catch (error) {
  // Existing journals/quarantines remain preserved. Explicit maintenance replays real errors.
  await (await import('./workspace-retention.mjs')).recordWorkspaceRetentionFailure(packet.workspacePath, error).catch(() => {});
  process.exitCode = 1;
}
