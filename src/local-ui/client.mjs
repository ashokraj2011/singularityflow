/** Native lifecycle client. Browser tokens never enter discovery; native credentials never enter URLs. */
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { forkBackground } from '../background-process.mjs';
import { PROTOCOL, UiError, insist, idleMinutes } from './contracts.mjs';
import { buildIdentity, serviceDirectory, privateDirectory, readPrivate } from './private-state.mjs';
import { leaseOwnerAssessment } from '../lease-liveness.mjs';
import { nativeNonce, nativeEqual, requestProof, responseProof, sealInput } from './native-auth.mjs';

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
export async function control(descriptor, route, input, { timeoutMs = 10_000 } = {}) {
  insist(descriptor?.protocol === PROTOCOL && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(descriptor.origin ?? '')
    && typeof descriptor.credential === 'string' && descriptor.credential.length === 43,
  'UI_DISCOVERY_INVALID', 'The local workspace discovery record is invalid.');
  let response;
  const method = input === undefined ? 'GET' : 'POST', target = `/control/${route}`, nonce = nativeNonce(), time = String(Date.now());
  const binding = JSON.stringify([descriptor.instance, nonce, time, method, target]);
  const payload = input === undefined ? null : sealInput(descriptor.credential, input, binding);
  const wireBody = input === undefined ? '' : JSON.stringify(payload);
  const proof = requestProof(descriptor.credential, { instance: descriptor.instance, nonce, time, method, route: target, body: wireBody });
  try {
    response = await fetch(`${descriptor.origin}${target}`, { method,
      redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { 'Content-Type': 'application/json',
        'X-SFlow-Native-Instance': descriptor.instance, 'X-SFlow-Native-Nonce': nonce, 'X-SFlow-Native-Time': time, 'X-SFlow-Native-Proof': proof },
      ...(input === undefined ? {} : { body: wireBody }) });
  } catch (error) {
    throw new UiError('UI_SERVICE_UNREACHABLE', 'The local workspace could not be reached. No process was killed or operation repeated.',
      { cause: error.message, code: error.cause?.code ?? error.code, instance: descriptor.instance, timeoutMs }, 503);
  }
  const chunks = []; let size = 0;
  try {
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      insist(size <= 4 * 1024 * 1024, 'UI_NATIVE_REPLY_TOO_LARGE', 'The listening process exceeded the native reply limit.', 502);
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof UiError) throw error;
    throw new UiError('UI_SERVICE_UNREACHABLE', 'The native reply did not complete. No operation was repeated.',
      { cause: error.message, code: error.cause?.code ?? error.code, instance: descriptor.instance, timeoutMs, stage: 'native-reply' }, 503);
  }
  const bytes = Buffer.concat(chunks).toString('utf8');
  insist(nativeEqual(response.headers.get('x-sflow-native-proof'),
    responseProof(descriptor.credential, { instance: descriptor.instance, nonce, status: response.status, body: bytes })),
  'UI_NATIVE_AUTH_REQUIRED', 'The listening process could not prove its SFlow identity. Native credentials and client inputs were not disclosed to it.', 401);
  let result;
  try { result = JSON.parse(bytes); }
  catch { throw new UiError('UI_NATIVE_RESULT_INVALID', 'The verified local service returned an invalid result. Inspect its build before reconnecting.', null, 502); }
  if (!response.ok) throw new UiError(result.error?.code ?? 'UI_CONTROL_FAILED', result.error?.message ?? 'Native request failed.', result.error?.details, response.status);
  if (route === 'status') insist(result.instance === descriptor.instance, 'UI_INSTANCE_MISMATCH', 'The listening process is not the recorded SFlow instance.');
  return result;
}
export async function serviceStatus({ directory = serviceDirectory() } = {}) {
  const descriptor = await readPrivate(path.join(directory, 'instance.json'));
  if (!descriptor) return { status: 'stopped', protocol: PROTOCOL };
  const status = await control(descriptor, 'status');
  return { status: status.draining ? 'draining' : 'running', ...status };
}
async function compatible(directory, build) {
  const descriptor = await readPrivate(path.join(directory, 'instance.json'));
  if (!descriptor) return null;
  let status;
  try { status = await control(descriptor, 'status', undefined, { timeoutMs: 1000 }); }
  catch (error) {
    const owner = descriptor.owner ? leaseOwnerAssessment(descriptor.owner) : null;
    if (owner ? owner.state !== 'dead' : alive(descriptor.pid)) throw error;
    return null;
  }
  insist(status.build?.fingerprint === build.fingerprint && status.build.executable === build.executable,
    'UI_BUILD_MISMATCH', 'Another SFlow build owns this local workspace. Stop or drain it with its installed CLI before opening this build.', 409);
  insist(!status.draining, 'UI_SERVICE_DRAINING', 'The local workspace is draining. Reopen after current work finishes.', 409);
  return descriptor;
}
export async function ensureService({ directory = serviceDirectory(), idle = 10, startupMs = 15_000, foreground = false } = {}) {
  // Windows credential ACL and process-lifetime qualification are an explicit release gate.
  insist(process.platform !== 'win32', 'UI_PLATFORM_UNQUALIFIED', 'The browser workspace currently requires native Windows ACL and process-lifetime qualification. Existing CLI and VS Code remain available.');
  idleMinutes(idle); await privateDirectory(directory);
  const build = await buildIdentity();
  let found = await compatible(directory, build);
  if (found) return { descriptor: found, reused: true };
  // Reuse the existing nonce/inode-fenced lease and PID-start liveness owner. An ad-hoc mkdir
  // claim leaves a permanent dead end if the launcher dies before writing its owner record.
  const { acquireFileLeaseWithin, heldFileLeaseRoute } = await import('../file-lease.mjs');
  const claim = path.join(directory, 'starting.lease'), deadline = Date.now() + startupMs;
  const lease = await acquireFileLeaseWithin(claim, startupMs, { staleMs: 30_000 });
  if (!lease) {
    const held = await heldFileLeaseRoute(claim);
    throw new UiError('UI_STARTUP_BUSY', `Another launcher still owns startup. Retry after it finishes.${held.message}`, held.details, 409);
  }
  try {
    found = await compatible(directory, build);
    if (found) return { descriptor: found, reused: true };
    if (foreground) {
      const service = await (await import('./server.mjs')).startService({ directory, idle, build });
      return { descriptor: service.descriptor, reused: false, service };
    }
    const child = forkBackground(fileURLToPath(new URL('./server.mjs', import.meta.url)), [], {
      cwd: path.dirname(directory), env: { ...process.env,
        SINGULARITY_FLOW_UI_IDLE_MINUTES: String(idle), ELECTRON_RUN_AS_NODE: '1' }
    });
    // The scope directory is normally derived. Tests/custom callers may supply a different one;
    // give the fixed server its exact directory through its private bootstrap message.
    child.send({ type: 'sflow-ui-start', directory, idle });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new UiError('UI_STARTUP_TIMEOUT', 'The local workspace did not become ready before its startup deadline. Inspect status before retrying.')), Math.max(1, deadline - Date.now()));
        const finish = (error, value) => { clearTimeout(timer); child.removeAllListeners('message'); child.removeAllListeners('error'); child.removeAllListeners('exit'); error ? reject(error) : resolve(value); };
        child.once('error', error => finish(error));
        child.once('exit', code => finish(new UiError('UI_STARTUP_FAILED', 'The local workspace stopped before becoming ready.', { exitCode: code })));
        child.on('message', message => {
          if (message?.type === 'sflow-ui-ready') finish(null, message);
          if (message?.type === 'sflow-ui-error') finish(new UiError(message.error.code, message.error.message, message.error.details));
        });
      });
    } catch (error) {
      // A launcher's death between fork and readiness may leave another verified server owning
      // the instance lease. Reuse its handshake; never start a second accepting instance.
      const other = await compatible(directory, build);
      if (other) return { descriptor: other, reused: true };
      throw error;
    } finally { if (child.connected) child.disconnect(); child.unref(); }
    found = await compatible(directory, build);
    insist(found, 'UI_STARTUP_FAILED', 'The local workspace did not publish its verified discovery record.');
    return { descriptor: found, reused: false };
  } finally { await lease.release(); }
}
export async function openWorkspace({ root = process.cwd(), clientId = randomUUID(), resume = null, ...options } = {}) {
  insist(!process.env.SSH_CONNECTION && !process.env.SSH_CLIENT && !process.env.SSH_TTY,
    'UI_REMOTE_UNQUALIFIED', 'Remote browser forwarding is not qualified. Use the existing SFlow CLI or remote VS Code panels.');
  const { descriptor, reused } = await ensureService(options);
  const result = await control(descriptor, 'bootstrap', { root: await realpath(root), clientId, environment: { ...process.env }, ...(resume ? { resume } : {}) });
  return { ...result, reused, discoveryFile: path.join(options.directory ?? serviceDirectory(), 'instance.json'),
    bridgeModule: path.join(result.build.engineRoot, 'src', 'local-ui', 'bridge-client.mjs') };
}
export async function stopService({ directory = serviceDirectory(), drain = false } = {}) {
  const descriptor = await readPrivate(path.join(directory, 'instance.json'));
  if (!descriptor) return { status: 'stopped' };
  // Native challenge proves ownership; no kill(pid), even when the discovery file is stale.
  return control(descriptor, 'stop', { drain });
}
