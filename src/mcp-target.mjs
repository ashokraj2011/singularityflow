import { SingularityFlowError } from './util.mjs';

export const MCP_SMOKE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function safeMcpTargetUrl(value, { label = 'MCP target URL' } = {}) {
  let url;
  try {
    url = value instanceof URL ? new URL(value) : new URL(String(value ?? ''));
  } catch {
    throw new SingularityFlowError(`${label} must be an absolute HTTPS URL or loopback HTTP URL.`, {
      code: 'MCP_SMOKE_URL_UNSAFE'
    });
  }
  if (url.username || url.password) {
    throw new SingularityFlowError(`${label} must not contain credentials.`, { code: 'MCP_SMOKE_URL_UNSAFE' });
  }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new SingularityFlowError(`${label} requires HTTPS, except for loopback HTTP.`, {
      code: 'MCP_NETWORK_UNSAFE_URL'
    });
  }
  url.username = '';
  url.password = '';
  return url;
}

export function normalizeMcpTargetOrigin(value, { required = false, label = 'POC target URL' } = {}) {
  if (value == null || String(value).trim() === '') {
    if (!required) return null;
    throw new SingularityFlowError(
      `${label} is required. Pass --target-url <AUTHORIZED_URL> so browser readiness and evidence bind to the approved environment.`,
      { code: 'POC_TARGET_ORIGIN_REQUIRED' }
    );
  }
  return safeMcpTargetUrl(value, { label }).origin;
}

export function authorizedMcpOrigins(workflow, serverId) {
  const values = workflow?.mcpAuthorizations?.[serverId]?.origins ?? [];
  return [...new Set(values.map((value) => normalizeMcpTargetOrigin(value, {
    required: true,
    label: `Story MCP authorization for '${serverId}'`
  })))];
}

// Workflow-scoped policy IDs may share the Playwright host. Host-specific containment and
// authentication checks must follow that host, while receipts remain bound to the policy ID.
export const isPlaywrightServer = (server) => (server?.hostReference ?? server?.id) === 'playwright';

/**
 * The steps that need a Story-pinned authorized target origin, in workflow order. A step whose MCP
 * policy requires a live smoke binds each required server's smoke receipt to the origins the Story
 * pinned (assertMcpPhaseReadiness), so without one it can never be prepared, published or
 * submitted. Read from resolved phases, so a workflow's phaseOverrides count exactly as a Story pins
 * them; a skipped Story step needs nothing.
 */
export function mcpTargetOriginSteps(phases = []) {
  return (Array.isArray(phases) ? phases : []).filter((phase) => phase?.status !== 'skipped'
    && phase?.mcp?.requireSmoke === true && phase.mcp.requiredServers?.length)
    .map((phase) => Object.freeze({
      phase: phase.id, label: phase.label ?? phase.id, servers: Object.freeze([...phase.mcp.requiredServers])
    }));
}

/**
 * The servers a Story's target origin is pinned for: Playwright, as a target URL always was, and
 * every server a step smoke-checks against it.
 */
export function mcpTargetOriginServers(phases = []) {
  return [...new Set(['playwright', ...mcpTargetOriginSteps(phases).flatMap((step) => step.servers)])];
}

/** "step testing needs a live playwright smoke against it", naming every step, for refusals and readiness. */
export function mcpTargetOriginNeed(steps, { against = 'it' } = {}) {
  const names = steps.map((step) => step.phase);
  const servers = [...new Set(steps.flatMap((step) => step.servers))];
  return `${names.length === 1 ? 'step' : 'steps'} ${names.join(', ')} ${names.length === 1 ? 'needs' : 'need'} a live ${servers.join(', ')} smoke against ${against}`;
}

/**
 * The target origin a new Story pins from `--target-url`. A workflow with a step that needs one
 * requires it, exactly as the POC workflow always did; any other workflow accepts it.
 */
export function storyStartTargetOrigin(value, phases = [], { required = true } = {}) {
  const steps = mcpTargetOriginSteps(phases);
  return normalizeMcpTargetOrigin(value, {
    required: required && steps.length > 0,
    label: steps.length ? `The authorized target URL (${mcpTargetOriginNeed(steps)})` : 'Target URL'
  });
}

/**
 * The commands that make one server ready for a step that smoke-checks it, in the order they
 * apply: the host entry, the exact package warm-up (Playwright only), the host attestation, then the
 * live smoke against the Story's authorized origin. Commands only; nothing here reads the machine.
 */
export function mcpServerSetupCommands(serverId, server, { origin = null } = {}) {
  const hostReference = server?.hostReference ?? serverId;
  return [
    ['playwright', 'figma'].includes(hostReference)
      ? `singularity-flow mcp scaffold ${hostReference}` : `singularity-flow mcp host add ${serverId}`,
    ...(isPlaywrightServer(server ?? { id: serverId }) ? [`singularity-flow mcp warm ${serverId} --network`] : []),
    `singularity-flow mcp attest ${serverId} --confirm ${serverId}`,
    `singularity-flow mcp smoke ${serverId} --url ${origin ?? '<AUTHORIZED-URL>'}`
  ];
}
