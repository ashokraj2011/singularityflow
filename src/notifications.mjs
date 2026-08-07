import { SingularityFlowError } from './util.mjs';

const NOTIFIABLE = new Set([
  'approval-requested', 'phase-approved', 'phase-rejected', 'impact-finalized', 'work-cancelled', 'work-completed'
]);

function teamsWebhook(environment) {
  const raw = String(environment.SINGULARITY_FLOW_TEAMS_WEBHOOK_URL ?? '').trim();
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { throw new SingularityFlowError('SINGULARITY_FLOW_TEAMS_WEBHOOK_URL must be a valid HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new SingularityFlowError('SINGULARITY_FLOW_TEAMS_WEBHOOK_URL must use HTTPS without embedded credentials.');
  }
  return url.toString();
}

export function lifecycleNotificationText(event) {
  const phase = event.phaseId ? ` · ${event.phaseId}` : '';
  const generation = event.generation != null ? ` · generation ${event.generation}` : '';
  const labels = {
    'approval-requested': 'Approval requested',
    'phase-approved': 'Phase approved',
    'phase-rejected': 'Phase returned',
    'impact-finalized': 'Work completed with Impact Receipt',
    'work-cancelled': 'Work cancelled and archived',
    'work-completed': 'Work completed'
  };
  return `Singularity Flow — ${labels[event.type] ?? event.type}\n${event.subject.kind} ${event.subject.id}${phase}${generation}\nBranch: ${event.subject.branch}`;
}

/**
 * External notifications are summons, never lifecycle authority. They run only
 * after publication, carry no credentials in Git, and cannot turn a successful
 * commit/push into a failed lifecycle transition.
 */
export async function deliverLifecycleNotifications({
  channels = [], event, environment = process.env, fetchImpl = globalThis.fetch
} = {}) {
  const results = [];
  if (!event || !NOTIFIABLE.has(event.type)) return results;
  for (const channel of [...new Set(channels)]) {
    if (channel === 'terminal') {
      results.push({ channel, delivered: true, local: true });
      continue;
    }
    if (channel !== 'teams-webhook') continue;
    let webhook;
    try { webhook = teamsWebhook(environment); }
    catch (error) {
      results.push({ channel, delivered: false, error: error.message });
      continue;
    }
    if (!webhook) {
      results.push({
        channel, delivered: false,
        error: 'No Teams webhook is configured. Set it in VS Code SecretStorage or SINGULARITY_FLOW_TEAMS_WEBHOOK_URL.'
      });
      continue;
    }
    try {
      const response = await fetchImpl(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: lifecycleNotificationText(event) }),
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      results.push({ channel, delivered: true });
    } catch (error) {
      results.push({ channel, delivered: false, error: error.message });
    }
  }
  return results;
}

export function warnNotificationFailures(results, warn = console.warn) {
  for (const result of results.filter((item) => !item.delivered)) {
    warn(`Warning: ${result.channel} notification was not delivered: ${result.error}`);
  }
}
