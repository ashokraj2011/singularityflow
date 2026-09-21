import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

function withoutGitDirectorySuffix(value) {
  return String(value).replace(/\/+$/u, '').replace(/\/\.git$/iu, '').replace(/\/+$/u, '');
}

function withoutHostedRepositorySuffix(value) {
  return String(value).replace(/\/+$/u, '').replace(/\.git$/iu, '').replace(/\/+$/u, '');
}

function canonicalWindowsPath(value) {
  return withoutGitDirectorySuffix(path.win32.normalize(value).replace(/\\/gu, '/'))
    .split('/')
    .map((component) => component.replace(/[ .]+$/gu, '').toLocaleLowerCase('en-US'))
    .join('/');
}

function decodeUnreserved(value) {
  return String(value).replace(/%([0-9a-f]{2})/giu, (encoded, byte) => {
    const character = String.fromCharCode(Number.parseInt(byte, 16));
    return /^[A-Za-z0-9._~-]$/u.test(character) ? character : encoded.toUpperCase();
  });
}

function scpRemote(value) {
  const match = String(value).match(/^([^/@:\s]+)@([^:\s]+):(.+)$/u);
  return match ? `ssh://${match[1]}@${match[2]}/${match[3]}` : value;
}

/** Return a local filesystem locator when the Git remote is a local-path spelling. */
export function gitRepositoryLocalPath(value) {
  const remote = String(value ?? '').trim();
  if (!remote) return null;
  if (/^[A-Za-z]:[\\/]/u.test(remote) || /^(?:\\\\|\/\/)[^\\/]+[\\/]/u.test(remote)) {
    return remote;
  }
  try {
    const parsed = new URL(remote);
    return parsed.protocol === 'file:' ? fileURLToPath(parsed) : null;
  } catch {
    return path.isAbsolute(remote) ? remote : null;
  }
}

/**
 * Return a conservative repository comparison key.
 *
 * Public GitHub's documented HTTPS and `git@github.com` spellings are aliases. Other hosts are
 * not assumed to share repositories across protocols or SSH usernames: servers may use either as
 * a real authority boundary. Local paths are normalized lexically without filesystem I/O.
 */
export function gitRepositoryComparisonKey(value) {
  let remote = String(value ?? '').trim();
  if (!remote) return null;
  if (/^[A-Za-z]:[\\/]/u.test(remote)) {
    const local = canonicalWindowsPath(remote);
    return local ? `local:${local}` : null;
  }
  const uncPath = /^(?:\\\\|\/\/)([^\\/]+)[\\/](.+)$/u.exec(remote);
  if (uncPath) {
    const repositoryPath = canonicalWindowsPath(uncPath[2]);
    return repositoryPath
      ? `local-unc:${uncPath[1].toLocaleLowerCase('en-US')}/${repositoryPath}` : null;
  }
  remote = scpRemote(remote);
  try {
    const parsed = new URL(remote);
    const sshProtocol = ['ssh:', 'git+ssh:', 'ssh+git:'].includes(parsed.protocol);
    if (parsed.search || parsed.hash || parsed.password || (parsed.username && !sshProtocol)) {
      return null;
    }
    if (parsed.protocol === 'file:') {
      let local = decodeURIComponent(parsed.pathname).replace(/\\/gu, '/');
      if (/^\/[A-Za-z]:\//u.test(local)) {
        local = canonicalWindowsPath(`${local[1]}${local.slice(2)}`);
      } else {
        local = withoutGitDirectorySuffix(path.posix.normalize(local));
      }
      if (parsed.hostname && parsed.hostname.toLowerCase() !== 'localhost') {
        const repositoryPath = canonicalWindowsPath(local.replace(/^\/+|\/+$/gu, ''));
        return repositoryPath
          ? `local-unc:${parsed.hostname.toLocaleLowerCase('en-US')}/${repositoryPath}` : null;
      }
      return local ? `local:${local}` : null;
    }
    if (!parsed.hostname) return null;
    const defaultPort = (parsed.protocol === 'https:' && parsed.port === '443')
      || (parsed.protocol === 'http:' && parsed.port === '80')
      || (sshProtocol && parsed.port === '22');
    const port = parsed.port && !defaultPort ? `:${parsed.port}` : '';
    const hostname = parsed.hostname.toLocaleLowerCase('en-US');
    let repositoryPath = parsed.pathname.replace(/^\/+|\/+$/gu, '');
    if (!repositoryPath) return null;

    const publicGithubSshAlias = hostname === 'ssh.github.com' && sshProtocol
      && parsed.username === 'git' && parsed.port === '443';
    if ((hostname === 'github.com' && !port) || publicGithubSshAlias) {
      if (sshProtocol && parsed.username && parsed.username !== 'git') {
        return `remote:ssh:${parsed.username}@${hostname}/${repositoryPath}`;
      }
      repositoryPath = withoutHostedRepositorySuffix(decodeUnreserved(repositoryPath))
        .toLocaleLowerCase('en-US');
      return `remote:github.com/${repositoryPath}`;
    }

    if (sshProtocol) {
      const username = parsed.username ? `${parsed.username}@` : '';
      return `remote:ssh:${username}${hostname}${port}/${repositoryPath}`;
    }
    return `remote:${parsed.protocol.slice(0, -1)}:${hostname}${port}/${repositoryPath}`;
  } catch {
    if (!path.isAbsolute(remote)) return null;
    const local = withoutGitDirectorySuffix(path.posix.normalize(remote.replace(/\\/gu, '/')));
    return local ? `local:${local}` : null;
  }
}

/** Resolve existing local aliases (including POSIX symlinks) before comparing workspace records. */
export async function resolvedGitRepositoryComparisonKey(value) {
  const local = gitRepositoryLocalPath(value);
  if (!local) return gitRepositoryComparisonKey(value);
  const resolved = await realpath(local).catch(() => null);
  return gitRepositoryComparisonKey(resolved ?? local);
}

export function sameGitRepository(left, right) {
  const leftKey = gitRepositoryComparisonKey(left);
  return Boolean(leftKey && leftKey === gitRepositoryComparisonKey(right));
}
