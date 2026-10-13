/** One bounded outbox attempt, not a daemon or an authority writer. */
import { syncConfigurationProposal } from './configuration-proposal-sync.mjs';
process.once('message', async packet => {
  if (!process.send || typeof packet?.intentId !== 'string' || packet.intentId.length > 128) process.exit(1);
  process.send({ ready: true, intentId: packet.intentId });
  try { await syncConfigurationProposal(packet.intentId); }
  catch { /* The durable outbox retains diagnostics/retry state; never fabricate a successful push. */ }
  finally { process.exit(0); }
});
