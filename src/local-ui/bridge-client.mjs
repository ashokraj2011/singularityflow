/** A native editor's leased, window-specific navigation/chat bridge. Not an approval signer. */
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { readPrivate, serviceDirectory } from './private-state.mjs';
import { control } from './client.mjs';
import { insist } from './contracts.mjs';

export async function connectEditorBridge({ instance, build, root, clientId, discoveryFile = path.join(serviceDirectory(), 'instance.json'), copilot = false, onRequest, onError = () => {} }) {
  const descriptor = await readPrivate(discoveryFile);
  insist(descriptor?.instance === instance && descriptor.build?.fingerprint === build, 'UI_BUILD_MISMATCH', 'The editor selected a different local workspace instance.');
  const selected = await realpath(root);
  const registered = await control(descriptor, 'bridge/register', { clientId, root: selected, copilot, build });
  let disposed = false, polling = false, failures = 0;
  const poll = async () => {
    if (disposed || polling) return;
    polling = true;
    try {
      const { requests } = await control(descriptor, 'bridge/poll', { bridgeId: registered.bridgeId }); failures = 0;
      for (const request of requests) {
        let outcome = 'delivered', message;
        try {
          insist(request.root === selected, 'UI_CONTEXT_DENIED', 'The editor handoff no longer matches its checkout.');
          message = await onRequest(request);
        } catch (error) { outcome = 'refused'; message = error.message; }
        await control(descriptor, 'bridge/result', { bridgeId: registered.bridgeId, handoffId: request.id, outcome, message });
      }
    } catch (error) {
      onError(error);
      if (++failures >= 3) { disposed = true; clearInterval(timer); }
    } finally { polling = false; }
  };
  const timer = setInterval(() => { void poll(); }, 1500); timer.unref?.();
  return { dispose() { if (disposed) return; disposed = true; clearInterval(timer); void control(descriptor, 'bridge/close', { bridgeId: registered.bridgeId }).catch(() => {}); } };
}
