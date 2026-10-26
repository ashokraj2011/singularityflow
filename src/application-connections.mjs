/** Explicit, bounded connectivity checks. No credential, response body or endpoint value is returned. */
import { loadEnvironmentDeclaration } from './environment-declaration.mjs';
import { materializeEnvironmentBinding } from './environment-bindings.mjs';
import { SingularityFlowError } from './util.mjs';
export async function checkApplicationConnections(root, environment, { timeoutMs = 20_000, signal = null, request = fetch } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) throw new SingularityFlowError('Connection timeout must be 1000–300000 ms.');
  const declaration = await loadEnvironmentDeclaration(root);
  const declared = declaration.environments[environment];
  if (!declared) throw new SingularityFlowError('Choose a declared environment.', { code: 'ENVIRONMENT_UNKNOWN' });
  const binding = await materializeEnvironmentBinding(root, environment);
  if (binding.status !== 'bound') return { resultType: 'sflow-app-connections', environment, evidenceClass: 'local-preview',
    status: 'unavailable', missing: binding.missing, connections: [] };
  const values = binding.childEnvironment({});
  const entries = declared.requires.filter(item => item.kind === 'endpoint');
  const connections = new Array(entries.length);
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let next = 0;
  const check = async entry => {
    let url;
    try { url = new URL(values[entry.name]); } catch { return { name: entry.name, status: 'invalid-endpoint' }; }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return { name: entry.name, status: 'invalid-endpoint' };
    }
    const started = performance.now();
    try {
      combined.throwIfAborted();
      const response = await request(url, { method: 'HEAD', redirect: 'manual', credentials: 'omit', signal: combined });
      await response.body?.cancel();
      return { name: entry.name, status: response.status >= 500 ? 'server-error' : 'reachable', httpStatus: response.status,
        authentication: [401, 403].includes(response.status) ? 'required-or-refused' : 'not-verified', elapsedMs: Math.round(performance.now() - started) };
    } catch (error) {
      return { name: entry.name, status: combined.aborted ? signal?.aborted ? 'cancelled' : 'timed-out' : 'unavailable',
        cause: /^[A-Z0-9_]+$/u.test(error.cause?.code ?? '') ? error.cause.code : null, elapsedMs: Math.round(performance.now() - started) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
    while (next < entries.length) { const index = next++; connections[index] = await check(entries[index]); }
  }));
  return { resultType: 'sflow-app-connections', environment, evidenceClass: 'local-preview', credentialsSent: false, connections };
}
