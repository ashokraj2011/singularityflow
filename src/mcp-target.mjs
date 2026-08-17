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
