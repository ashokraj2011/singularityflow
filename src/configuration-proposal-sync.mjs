/** A saved proposal may upload asynchronously; approval/activation never run here. */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readTransportIntent, retryTransportIntent } from './transport-intents.mjs';
import { SingularityFlowError } from './util.mjs';

export async function syncConfigurationProposal(intentId, options = {}) {
  const intent = await readTransportIntent(intentId, options);
  if (!/^sflow\.configuration\.workflow\.[a-z0-9-]+$/u.test(intent.scope?.operation ?? '')
      || !intent.targetRef?.startsWith('refs/heads/sflow/config-change/workflow/')
      || intent.expectedRemote !== null
      || intent.scope?.requiredLocalRef !== `refs/singularity/transport/configuration-proposals/${intent.sourceCommit}`) {
    throw new SingularityFlowError('Background sync accepts only retained, create-only configuration proposals.', {
      code: 'CONFIGURATION_BACKGROUND_SYNC_SCOPE'
    });
  }
  // The existing durable outbox rechecks repository, installed ref, remote identity, leases,
  // retry budget and uncertain outcomes. Credential/risk prompts are never answered by a worker.
  return retryTransportIntent(intentId, { ...options, allowNeedsUser: false });
}

export async function startConfigurationProposalSync(intentId, { env = process.env } = {}) {
  if (env.SINGULARITY_FLOW_CONFIGURATION_BACKGROUND_SYNC === 'off') return false;
  const child = fork(fileURLToPath(new URL('./configuration-proposal-sync-worker.mjs', import.meta.url)), [], {
    env: { ...env }, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });
  const ready = await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 5_000);
    const finish = value => { clearTimeout(timer); resolve(value); };
    child.once('error', () => finish(false)); child.once('exit', () => finish(false));
    child.once('message', packet => finish(packet?.ready === true && packet.intentId === intentId));
    child.send({ intentId });
  });
  if (!ready) { child.kill(); return false; }
  child.disconnect(); child.unref();
  return true;
}
