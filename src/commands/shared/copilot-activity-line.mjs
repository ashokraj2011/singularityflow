/** Extracted command implementation; governance remains in the existing kernel APIs. */

/** The Copilot activity a reconciled generation recorded, for the line after its models and tokens. */
export function copilotActivityLine(activity) {
  if (!activity) return null;
  const events = (activity.events ?? []).reduce((sum, event) => sum + event.count, 0);
  return [
    `Copilot requests: ${activity.requests ?? 'unavailable'}`,
    `Turns: ${activity.turns ?? 'unavailable'}`,
    `Tool calls: ${activity.toolCalls}`,
    ...(events ? [`Quota/model events: ${events}`] : [])
  ].join(' | ');
}
