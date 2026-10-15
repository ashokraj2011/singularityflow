/** Localize inherited MCP policy to derived phases/agents; never widen a shared server's scopes. */
import { markupError } from './workflow-markup-parser.mjs';

export function derivedMcpPolicy({ id, definition, phaseMap, phaseAgents, agents, workflow, phases }) {
  const servers = {}, aliases = new Map();
  for (const [sourceId, server] of Object.entries(definition.mcpServers ?? {})) {
    // Native policy intersects phase AND agent scopes. A union silently grants a tester's
    // server to the repair phase, or a phase-scoped server to a different principal.
    const eligible = [...phaseMap].filter(([original, phase]) => (!(server.phases ?? []).length || server.phases.includes(original))
      && (!(server.agents ?? []).length || server.agents.includes(agents.find(agent => agent.id === phaseAgents[phase])?.parentId)));
    const selectedPhases = eligible.map(([, phase]) => phase);
    if (!selectedPhases.length) continue;
    const target = `${id}-${sourceId}`;
    aliases.set(sourceId, target);
    servers[target] = { ...structuredClone(server), phases: selectedPhases,
      // Empty means unrestricted (and identifies source-only servers); preserve that meaning.
      agents: (server.agents ?? []).length ? [...new Set(selectedPhases.map(phase => phaseAgents[phase]))] : [] };
  }
  const remap = value => {
    if (Array.isArray(value)) { for (const item of value) remap(item); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'requiredServers' && Array.isArray(child)) value[key] = child.map(id => {
        if (Object.hasOwn(definition.mcpServers ?? {}, id) && !aliases.has(id)) markupError('A required MCP policy has no compatible derived phase/agent scope; review that contract explicitly.');
        return aliases.get(id) ?? id;
      });
      else if (key === 'server' && value.tool) {
        if (Object.hasOwn(definition.mcpServers ?? {}, child) && !aliases.has(child)) markupError('A tool binding has no compatible derived MCP scope.');
        if (aliases.has(child)) value[key] = aliases.get(child);
      }
      else remap(child);
    }
  };
  remap(workflow); for (const phase of Object.values(phases)) remap(phase);
  return { servers, aliases };
}
