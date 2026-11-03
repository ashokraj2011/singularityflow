#!/usr/bin/env node
/** Internal owned review host; private descriptor never leaves the selected checkout. */
import { randomUUID } from 'node:crypto';
import { createApplicationReviewHost } from '../src/application-review-host.mjs';
import { applicationReviewHostDescriptor } from '../src/commands/app-review.mjs';
import { writeMutablePrivateSidecar } from '../src/private-sidecar.mjs';
import { processStartIdentity } from '../src/lease-liveness.mjs';
import { localCheckoutIdentity } from '../src/application-review-read.mjs';
import { redactDiagnosticText } from '../src/git-remote-diagnostics.mjs';

const [root, sessionId, workId, launchId] = process.argv.slice(2);
process.chdir(root);
const descriptor = await applicationReviewHostDescriptor(root, sessionId);
try {
  const host = await createApplicationReviewHost(root, { sessionId, workId, onClose: () => process.exit(0) });
  await writeMutablePrivateSidecar(root, descriptor, `${JSON.stringify({ schemaVersion: 1, kind: 'local-application-review-host', checkout: localCheckoutIdentity(root),
    repository: root, sessionId, launchId, url: host.url, pid: process.pid, processStartedAt: processStartIdentity(process.pid), instance: randomUUID() })}\n`, { maximumBytes: 8192 });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void host.close(); });
  const timer = setTimeout(() => { void host.close(); }, 2 * 60 * 60 * 1000); timer.unref();
} catch (error) {
  await writeMutablePrivateSidecar(root, descriptor, `${JSON.stringify({ schemaVersion: 1, kind: 'local-application-review-host-failed', checkout: localCheckoutIdentity(root), sessionId, launchId,
    error: { code: error.code ?? 'ARA_HOST_UNAVAILABLE', message: redactDiagnosticText(error.message).slice(0, 4000) } })}\n`, { maximumBytes: 8192 });
  process.exitCode = 1;
}
