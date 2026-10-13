/** Optional private read worker. Mutations never traverse this interface. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fork } from 'node:child_process';
import { connect } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';
import { gitCommonDir } from './git.mjs';
import { runningBuildIdentity } from './build-identity.mjs';
import { configurationEngineIdentity } from './configuration-definition-cache.mjs';
import { acquireFileLease } from './file-lease.mjs';
import { safePrivateSidecarDirectory, readPrivateSidecar, writeMutablePrivateSidecar } from './private-sidecar.mjs';
import { incrementCommandCounter, measureCommandSpan } from './dx-timing-context.mjs';
import { SingularityFlowError } from './util.mjs';

const FORMAT = 1, MAXIMUM_REPLY = 2 * 1024 * 1024;
const privacy = { enforceWindowsAcl: true };
const digest = value => createHash('sha256').update(value).digest('hex');
const methods = new Set(['proposals', 'proposal']);

async function exchange(record, request, signal) {
  if (signal?.aborted) return null;
  return new Promise(resolve => {
    let finished = false, bytes = 0, text = '';
    const socket = connect(record.endpoint);
    const nonce = randomBytes(16).toString('hex');
    const body = { ...request, nonce, format: FORMAT, build: record.build };
    const authenticate = value => createHmac('sha256', Buffer.from(record.token, 'hex')).update(JSON.stringify(value)).digest();
    const timer = setTimeout(() => finish(null), 30_000);
    const onAbort = () => finish(null);
    const finish = value => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      socket.destroy(); resolve(value);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.on('error', () => finish(null)); socket.on('end', () => finish(null));
    socket.on('connect', () => socket.write(JSON.stringify({ body, auth: authenticate(body).toString('hex') }) + '\n'));
    socket.setEncoding('utf8');
    socket.on('data', data => {
      bytes += Buffer.byteLength(data);
      if (bytes > MAXIMUM_REPLY) return finish(null);
      text += data;
      const newline = text.indexOf('\n');
      if (newline < 0) return;
      try {
        const packet = JSON.parse(text.slice(0, newline));
        const supplied = /^[a-f0-9]{64}$/u.test(packet.auth ?? '') ? Buffer.from(packet.auth, 'hex') : Buffer.alloc(0);
        finish(packet.body?.format === FORMAT && packet.body.build === record.build && packet.body.nonce === nonce
          && supplied.length === 32 && timingSafeEqual(supplied, authenticate(packet.body)) ? packet.body : null);
      } catch { finish(null); }
    });
  });
}

/** Return null on infrastructure failure, not on a governed refusal from a successfully bound read. */
export async function configurationReadFromWorker(root, method, parameters = {}, { env = process.env, signal = null } = {}) {
  if (!methods.has(method) || env.SINGULARITY_FLOW_CONFIGURATION_READ_WORKER === 'off' || signal?.aborted) return null;
  let directory, file, identity, key, record, launched;
  try {
    const common = gitCommonDir(root);
    // Environment changes (credentials, TLS, registry, permission/transport policy) start a new
    // process. Never mutate process.env while another request is using a prior authority scope.
    const environment = digest(JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))));
    identity = { format: FORMAT, common, build: runningBuildIdentity(), engine: await configurationEngineIdentity(), environment,
      executable: process.execPath, node: process.version };
    key = digest(JSON.stringify(identity));
    directory = path.join(common, 'singularity-flow', 'configuration-read-workers-v1');
    await safePrivateSidecarDirectory(root, directory, { ...privacy, create: true });
    file = path.join(directory, `${key}.json`);
    const read = async () => {
      const data = await readPrivateSidecar(root, file, { ...privacy, optional: true, maximumBytes: 8_192 });
      if (!data) return null;
      const entry = JSON.parse(data);
      if (entry.key !== key || entry.format !== FORMAT || entry.build !== identity.build
          || !/^[a-f0-9]{64}$/u.test(entry.token ?? '') || typeof entry.endpoint !== 'string'
          || !Number.isSafeInteger(entry.pid) || entry.pid < 1) return null;
      return entry;
    };
    record = await read();
    if (record && !await exchange(record, { method: 'ping' }, signal)) record = null;
    if (!record) {
      const lease = await acquireFileLease(path.join(directory, `${key}.lock`), { waitMs: 250 });
      if (!lease) return null;
      try {
        record = await read();
        if (record && !await exchange(record, { method: 'ping' }, signal)) record = null;
        if (!record) {
          if ((await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/u.test(name)).length >= 8) return null;
          const token = randomBytes(32).toString('hex');
          const worker = fork(fileURLToPath(new URL('./configuration-read-worker.mjs', import.meta.url)), [], {
            cwd: root, env: { ...env, SINGULARITY_FLOW_CONFIGURATION_READ_WORKER: 'off' },
            execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json'
          });
          launched = worker;
          record = await new Promise(resolve => {
            const timer = setTimeout(() => { worker.kill(); resolve(null); }, 5_000);
            worker.once('error', () => { clearTimeout(timer); resolve(null); });
            worker.once('exit', () => { clearTimeout(timer); resolve(null); });
            worker.once('message', packet => {
              clearTimeout(timer);
              resolve(packet?.ready === true && packet.build === identity.build && packet.key === key
                ? { format: FORMAT, key, build: identity.build, token, endpoint: packet.endpoint, pid: worker.pid } : null);
            });
            worker.send({ identity, key, token, root });
          });
          if (!record) { worker.kill(); return null; }
          await writeMutablePrivateSidecar(root, file, JSON.stringify(record), { ...privacy, maximumBytes: 8_192 });
          worker.disconnect(); worker.unref();
          launched = null;
          incrementCommandCounter('configuration.read-worker-start');
        }
      } finally { await lease.release({ cleanupConfirmed: true }); }
    }
  } catch { launched?.kill(); launched?.disconnect?.(); return null; }
  const packet = await measureCommandSpan('configuration.read-worker', () => exchange(record, { method, parameters, root }, signal));
  if (!packet) return null;
  incrementCommandCounter('configuration.read-worker-reuse');
  for (const [name, count] of Object.entries(packet.counters ?? {})) {
    if (Number.isSafeInteger(count) && count >= 0) incrementCommandCounter(name, count);
  }
  if (packet.error) throw new SingularityFlowError(packet.error.message, { code: packet.error.code,
    details: packet.error.details ?? null });
  return { value: packet.value };
}
