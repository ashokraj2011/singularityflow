/** Native-host presentation only; do not alter persisted records, bindings or gate decisions. */
export function agentPacketPresentation(packet, platform = process.platform) {
  const visit = value => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      // Every current-platform command remains exact. Unknown hosts retain all alternatives.
      // Never collapse the platform map when no verified command exists for this host.
      if (key === 'platformCommands' && child && typeof child[platform] === 'string') {
        return [key, { [platform]: child[platform] }];
      }
      return [key, visit(child)];
    }));
  };
  return visit(packet);
}

export function phaseEntryAgentPresentation(packet) {
  if (packet.paused) return packet;
  return { agentGuide: {
    readOrder: ['ready', 'phase', 'authoring', 'contextAdmission', 'recovery', 'intent',
      'recovery.testExecution', 'clarification', 'references', 'context.text', 'next'],
    testExecutionPath: 'recovery.testExecution',
    platform: process.platform,
    instruction: 'Read authority fields together once, without key enumeration. Reuse context.text; changed bindings need fresh checks. Never reuse approval consent.'
  }, ...agentPacketPresentation(packet) };
}
