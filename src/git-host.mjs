/**
 * Which hosting provider a Git remote URL names, from the URL alone.
 *
 * The GitHub CLI answers only for GitHub (github.com, GitHub Enterprise Cloud and Server). Sending
 * a GitLab, Bitbucket or Azure DevOps remote to it fails with "run gh auth login" for a host gh
 * can never authenticate, so callers decide the route first. A host this cannot recognise stays
 * `unknown`: an enterprise GitHub server may have any name, and callers keep the GitHub route.
 */

const PROVIDERS = Object.freeze({
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  'azure-devops': 'Azure DevOps',
  local: 'a local repository',
  unknown: 'an unrecognised host'
});

function remoteHost(remote) {
  const value = String(remote ?? '').trim();
  if (!value) return { host: null, local: false };
  if (/^file:/iu.test(value) || /^(?:\/|[A-Za-z]:[\\/]|\\\\|\.{1,2}[\\/])/u.test(value)) return { host: null, local: true };
  const scp = value.match(/^(?:[^@/\s:]+@)?([^:/\s]+):(?!\/\/)/u);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) return { host: scp[1].toLowerCase(), local: false };
  try {
    const parsed = new URL(value);
    return { host: parsed.hostname ? parsed.hostname.toLowerCase() : null, local: parsed.protocol === 'file:' };
  } catch {
    return { host: null, local: false };
  }
}

const labelled = (host, name) => new RegExp(`(?:^|[.-])${name}(?:[.-]|$)`, 'u').test(host);

/** `{ provider, host, label }` for a remote URL; never contacts the host. */
export function classifyGitHost(remote) {
  const { host, local } = remoteHost(remote);
  let provider = 'unknown';
  if (local) provider = 'local';
  else if (!host) provider = 'unknown';
  else if (host === 'github.com' || host.endsWith('.github.com') || host.endsWith('.ghe.com') || labelled(host, 'github')) provider = 'github';
  else if (host === 'gitlab.com' || labelled(host, 'gitlab')) provider = 'gitlab';
  else if (host === 'bitbucket.org' || labelled(host, 'bitbucket')) provider = 'bitbucket';
  else if (host === 'dev.azure.com' || host.endsWith('.dev.azure.com') || host.endsWith('.visualstudio.com')) provider = 'azure-devops';
  return Object.freeze({ provider, host, label: PROVIDERS[provider] });
}

/** Whether the GitHub CLI can be the route for this remote (GitHub, or a host that may be one). */
export function githubCliRoute(remote) {
  return ['github', 'unknown'].includes(classifyGitHost(remote).provider);
}
