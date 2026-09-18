/** Closed, read-only Git observations needed before the CLI has selected repository authority. */
import { localGit, type LocalGitResult, type LocalGitRunner } from './runner.ts';

export class GitObservationUnavailableError extends Error {
  readonly code = 'GIT_OBSERVATION_UNAVAILABLE';
  constructor(operation: string) {
    // Git stderr may contain a remote URL or credentials. Keep it out of host-facing errors.
    super(`Git could not inspect ${operation}. Check the repository and Git installation, then retry.`);
    this.name = 'GitObservationUnavailableError';
  }
}

type ObservationOptions = {
  signal?: AbortSignal;
  runner?: LocalGitRunner;
};

async function observe(
  cwd: string, args: string[], timeout: number, options: ObservationOptions
): Promise<LocalGitResult> {
  return (options.runner ?? localGit)(args, { cwd, timeout, signal: options.signal });
}

function requiredText(result: LocalGitResult, operation: string): string {
  if (result.failure || result.status !== 0) throw new GitObservationUnavailableError(operation);
  return result.stdout.toString('utf8').trimEnd();
}

/** A discovery probe, not a repository observation; absence is reported as null. */
export async function gitVersion(cwd: string, options: ObservationOptions = {}): Promise<string | null> {
  const result = await observe(cwd, ['--version'], 5_000, options);
  const version = result.stdout.toString('utf8').trim();
  return !result.failure && result.status === 0 && version ? version : null;
}

/** Git remote names are local configuration only; no endpoint is contacted. */
export async function configuredGitRemotes(
  cwd: string, options: ObservationOptions = {}
): Promise<string[]> {
  const result = await observe(cwd, ['remote'], 10_000, options);
  const output = requiredText(result, 'configured remotes');
  const names = output ? output.split(/\r?\n/u).filter(Boolean) : [];
  if (names.some((name) => /[\u0000-\u001f\u007f]/u.test(name))) {
    throw new GitObservationUnavailableError('configured remotes');
  }
  return names;
}

/** Distinguish an absent configured remote from infrastructure or protocol failure. */
export async function hasConfiguredGitRemote(
  cwd: string, remote: string, options: ObservationOptions = {}
): Promise<boolean> {
  if (!remote || remote.startsWith('-') || /[\u0000-\u001f\u007f]/u.test(remote)) {
    throw new GitObservationUnavailableError('the configured remote name');
  }
  const result = await observe(cwd, ['remote', 'get-url', remote], 10_000, options);
  if (result.failure) throw new GitObservationUnavailableError('the configured remote');
  if (result.status === 2 && /^error: No such remote /iu.test(result.stderr)) return false;
  if (result.status !== 0) throw new GitObservationUnavailableError('the configured remote');
  return true;
}

/** Fresh branch and commit reads for each review boundary; never cache them across a modal. */
export async function currentGitSource(
  cwd: string, options: ObservationOptions = {}
): Promise<{ branch: string; sourceCommit: string }> {
  const branch = requiredText(
    await observe(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], 10_000, options), 'the current branch'
  );
  const sourceCommit = requiredText(
    await observe(cwd, ['rev-parse', 'HEAD'], 10_000, options), 'the current commit'
  );
  if (!branch || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(sourceCommit)) {
    throw new GitObservationUnavailableError('the current source');
  }
  return { branch, sourceCommit };
}

/** NUL framing keeps a configured URL containing a newline from becoming a second result. */
export async function configuredGitRemoteUrls(
  cwd: string, options: ObservationOptions = {}
): Promise<string[]> {
  const result = await observe(cwd,
    ['config', '--local', '--null', '--get-regexp', '^remote\\..*\\.url$'], 5_000, options);
  if (result.failure || (result.status !== 0 && result.status !== 1)) {
    throw new GitObservationUnavailableError('configured remote URLs');
  }
  if (result.status === 1) {
    if (result.stdout.length || result.stderr) {
      throw new GitObservationUnavailableError('configured remote URLs');
    }
    return [];
  }
  const output = result.stdout;
  if (!output.length || output.at(-1) !== 0) {
    throw new GitObservationUnavailableError('configured remote URLs');
  }
  const urls: string[] = [];
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(output); }
  catch { throw new GitObservationUnavailableError('configured remote URLs'); }
  for (const record of text.split('\0').slice(0, -1)) {
    const separator = record.indexOf('\n');
    if (separator < 0 || !/^remote\..*\.url$/u.test(record.slice(0, separator))) {
      throw new GitObservationUnavailableError('configured remote URLs');
    }
    urls.push(record.slice(separator + 1));
  }
  return urls;
}
