/** Fixed-method read worker: private IPC, bounded frames/queue, fresh per-request read scopes. */
import { createServer } from 'node:net';
import { mkdtemp, chmod, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { runningBuildIdentity } from './build-identity.mjs';
import { configurationEngineIdentity } from './configuration-definition-cache.mjs';
import { gitCommonDir } from './git.mjs';
import { withReadScope } from './read-scope.mjs';
import { readPrivateSidecar } from './private-sidecar.mjs';
import { commandTimer, withCommandTiming } from './dx-command-timing.mjs';

const FORMAT = 1, MAXIMUM_REPLY = 2 * 1024 * 1024;
let server, directory, idle, registration, drain = Promise.resolve();
const sockets = new Set();
let closing = false;

async function close() {
  if (closing) return; closing = true;
  clearTimeout(idle);
  for (const socket of sockets) socket.destroy();
  server?.close();
  await drain.catch(() => {});
  if (registration) {
    const file = path.join(registration.identity.common, 'singularity-flow', 'configuration-read-workers-v1', `${registration.key}.json`);
    try {
      const data = await readPrivateSidecar(registration.root, file, { enforceWindowsAcl: true, optional: true, maximumBytes: 8_192 });
      if (data && JSON.parse(data).token === registration.token) await rm(file, { force: true });
    } catch { /* Never remove another worker's registration or an unsafe path. */ }
  }
  if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
}

process.once('SIGTERM', () => close().finally(() => process.exit(0)));
process.once('SIGINT', () => close().finally(() => process.exit(0)));
process.once('message', async start => {
  if (!process.send || start?.identity?.format !== FORMAT || start.identity.build !== runningBuildIdentity()
      || start.identity.engine !== await configurationEngineIdentity()
      || !/^[a-f0-9]{64}$/u.test(start.token ?? '') || !/^[a-f0-9]{64}$/u.test(start.key ?? '')) return process.exit(1);
  registration = start;
  const token = Buffer.from(start.token, 'hex');
  const authenticate = value => createHmac('sha256', token).update(JSON.stringify(value)).digest();
  const common = await realpath(gitCommonDir(start.root));
  if (common !== await realpath(start.identity.common)) return process.exit(1);
  directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-config-read-'));
  await chmod(directory, 0o700);
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\sflow-config-${createHash('sha256').update(start.token).digest('hex')}`
    : path.join(directory, 'read.sock');
  let pending = 0;
  const queue = [];
  const touch = () => {
    clearTimeout(idle);
    // Idle shutdown never interrupts an active read or leaves a borrowed alternate underneath it.
    if (pending === 0) idle = setTimeout(() => close().finally(() => process.exit(0)), 60_000);
  };
  server = createServer(socket => {
    if (sockets.size >= 32) return socket.destroy();
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.setTimeout(30_000, () => socket.destroy());
    let length = 0, text = '', accepted = false;
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.on('data', chunk => {
      length += Buffer.byteLength(chunk);
      if (accepted || length > 16_384) return socket.destroy();
      text += chunk; const newline = text.indexOf('\n'); if (newline < 0) return;
      accepted = true;
      let packet;
      try { packet = JSON.parse(text.slice(0, newline)); } catch { return socket.destroy(); }
      const request = packet.body;
      const supplied = /^[a-f0-9]{64}$/u.test(packet.auth ?? '') ? Buffer.from(packet.auth, 'hex') : Buffer.alloc(0);
      if (!request || supplied.length !== 32 || !timingSafeEqual(supplied, authenticate(request))
          || request.format !== FORMAT || request.build !== start.identity.build || !/^[a-f0-9]{32}$/u.test(request.nonce ?? '')) return socket.destroy();
      const reply = value => {
        if (socket.destroyed) return;
        const body = { format: FORMAT, build: start.identity.build, nonce: request.nonce, ...value };
        const data = JSON.stringify({ body, auth: authenticate(body).toString('hex') }) + '\n';
        if (Buffer.byteLength(data) > MAXIMUM_REPLY) return socket.destroy();
        socket.end(data);
      };
      if (request.method === 'ping') { touch(); return reply({ value: { ready: true } }); }
      if (!['proposals', 'proposal'].includes(request.method) || pending >= 32) return socket.destroy();
      pending++; clearTimeout(idle);
      queue.push({ method: request.method, created: Date.now(), run: async () => {
        if (socket.destroyed) return;
        try {
          if (await realpath(gitCommonDir(request.root)) !== common) throw new Error('Read worker repository binding differs');
          const timer = commandTimer('configuration.worker-read', { commandClass: 'read' });
          const value = await withCommandTiming(timer, () => withReadScope(async () => {
            const api = await import('./configuration-proposal.mjs');
            return request.method === 'proposals'
              ? api.listWorkflowConfigurationProposals(request.root, {
                includeMerged: request.parameters?.includeMerged === true, includeDiff: false
              })
              : api.inspectWorkflowConfigurationProposal(request.root, request.parameters?.branch);
          }));
          reply({ value, counters: timer.finish().counters });
        } catch (error) {
          const { redactDiagnosticText } = await import('./git-remote-diagnostics.mjs');
          reply({ error: { code: error.code ?? 'CONFIGURATION_READ_WORKER_FAILED',
            message: redactDiagnosticText(error.message).slice(0, 4_096) } });
        }
      } });
      if (pending === 1) drain = (async () => {
        while (queue.length) {
          // Interactive review moves ahead of queued inventory reads. Old inventory requests
          // regain priority after 30s; an active bounded read is never abruptly interrupted.
          queue.sort((a, b) => (Date.now() - a.created >= 30_000 ? -1 : a.method === 'proposal' ? 0 : 1)
            - (Date.now() - b.created >= 30_000 ? -1 : b.method === 'proposal' ? 0 : 1) || a.created - b.created);
          try { await queue.shift().run(); }
          catch { socket.destroy(); /* A failed client cannot strand other queued reads. */ }
          finally { pending--; touch(); }
        }
      })();
    });
  });
  server.on('error', () => close().finally(() => process.exit(1)));
  server.listen({ path: endpoint, readableAll: false, writableAll: false }, async () => {
    if (process.platform !== 'win32') await chmod(endpoint, 0o600);
    process.send({ ready: true, build: start.identity.build, key: start.key, endpoint });
    touch();
  });
});
