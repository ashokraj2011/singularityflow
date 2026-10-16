/** Parent-owned, private IPC worker. Code is warm; repository and policy observations are not. */
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { READ_WORKER_FORMAT, READ_WORKER_MAX_QUEUE, READ_WORKER_MAX_REPLY_BYTES,
  readWorkerBuildFingerprint, warmReadRequest } from './read-worker-protocol.mjs';

if (typeof process.send !== 'function') throw new Error('The read worker requires private parent IPC.');
const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'singularity-flow.mjs');
let binding = null, pending = 0, drain = Promise.resolve();
const reply = message => {
  if (!process.connected || Buffer.byteLength(JSON.stringify(message)) > READ_WORKER_MAX_REPLY_BYTES) return process.exit(1);
  process.send(message, error => { if (error) process.exit(1); });
};

process.on('message', message => {
  if (!binding) {
    if (message?.type !== 'bind' || message.format !== READ_WORKER_FORMAT
        || !/^[a-f0-9]{64}$/u.test(message.build ?? '') || !/^[a-f0-9]{32}$/u.test(message.nonce ?? '')
        || typeof message.repository !== 'string' || !path.isAbsolute(message.repository)) return process.exit(1);
    // Set before awaiting so a second bind cannot race the first one.
    binding = { ...message };
    drain = (async () => {
      const build = await readWorkerBuildFingerprint(cli);
      const repository = await realpath(process.cwd());
      if (build?.fingerprint !== binding.build || repository !== await realpath(binding.repository)) return process.exit(1);
      binding.repository = repository;
      reply({ type: 'ready', format: READ_WORKER_FORMAT, nonce: binding.nonce, build: binding.build });
    })().catch(() => process.exit(1));
    return;
  }
  if (message?.type !== 'read' || message.format !== READ_WORKER_FORMAT
      || message.nonce !== binding.nonce || !Number.isSafeInteger(message.id) || message.id < 1
      || !warmReadRequest(message.args) || ++pending > READ_WORKER_MAX_QUEUE) return process.exit(1);
  const args = [...message.args], id = message.id;
  drain = drain.then(async () => {
    const build = await readWorkerBuildFingerprint(cli);
    if (build?.fingerprint !== binding.build) return process.exit(1);
    const { readWorkerValue } = await import('./read-worker-service.mjs');
    const result = await readWorkerValue(binding.repository, args);
    reply({ type: 'result', format: READ_WORKER_FORMAT, nonce: binding.nonce, id, result });
  }).catch(() => {
    // The CLI owns refusal formatting and remediation. An unavailable optimization falls back
    // once to that owner; no result, exception stack, credential or partial packet is reused.
    reply({ type: 'result', format: READ_WORKER_FORMAT, nonce: binding.nonce, id,
      result: { kind: 'unavailable' } });
  }).finally(() => { pending--; });
});
process.once('disconnect', () => process.exit(0));
