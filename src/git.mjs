import path from 'node:path';
import { SingularityFlowError, invariant, run } from './util.mjs';

function git(args, options = {}) {
  return run('git', args, options);
}

export function repoRoot(cwd = process.cwd()) {
  const result = git(['rev-parse', '--show-toplevel'], { cwd, allowFailure: true });
  if (result.status !== 0) throw new SingularityFlowError('Run Singularity Flow from inside a Git repository.');
  return path.resolve(result.stdout.trim());
}

export function branch(root) {
  const value = git(['branch', '--show-current'], { cwd: root }).stdout.trim();
  invariant(value, 'Detached HEAD is not supported.');
  return value;
}

export function head(root) {
  return git(['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
}

export function identity(root) {
  if (process.env.NODE_ENV === 'test' && process.env.SINGULARITY_FLOW_TEST_IDENTITY) {
    return { name: process.env.SINGULARITY_FLOW_TEST_IDENTITY, email: `${process.env.SINGULARITY_FLOW_TEST_IDENTITY.toLowerCase().replace(/\s+/g, '.')}@example.com`, login: null };
  }
  const name = git(['config', '--get', 'user.name'], { cwd: root, allowFailure: true }).stdout.trim();
  const email = git(['config', '--get', 'user.email'], { cwd: root, allowFailure: true }).stdout.trim();
  const github = run('gh', ['api', 'user', '--jq', '{login: .login, name: .name}'], { cwd: root, allowFailure: true });
  let account = {};
  if (github.status === 0) { try { account = JSON.parse(github.stdout); } catch { account = {}; } }
  return {
    name: account.name || name || process.env.USER || process.env.USERNAME || 'unknown-user',
    email: email || null,
    login: account.login || null
  };
}

export function validBranch(root, name) {
  if (git(['check-ref-format', '--branch', name], { cwd: root, allowFailure: true }).status !== 0) {
    throw new SingularityFlowError(`Invalid Git branch name: ${name}`);
  }
}

export function refExists(root, ref) {
  return git(['show-ref', '--verify', '--quiet', ref], { cwd: root, allowFailure: true }).status === 0;
}

export function hasRemote(root, remote = 'origin') {
  return git(['remote', 'get-url', remote], { cwd: root, allowFailure: true }).status === 0;
}

export function changes(root) {
  return git(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root }).stdout;
}

export function assertClean(root) {
  if (changes(root).trim()) throw new SingularityFlowError('Working tree is not clean. Commit or stash changes, or pass --allow-dirty deliberately.');
}

export function fetchOrigin(root) {
  if (hasRemote(root)) git(['fetch', '--prune', 'origin'], { cwd: root, stdio: 'inherit' });
}

export function hasUpstream(root) {
  return git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd: root, allowFailure: true }).status === 0;
}

export function pullFastForward(root) {
  if (hasUpstream(root)) git(['pull', '--ff-only'], { cwd: root, stdio: 'inherit' });
}

export function checkout(root, name, {
  base = 'main',
  fetch = false,
  existingOnly = false
} = {}) {
  validBranch(root, name);
  if (fetch) fetchOrigin(root);
  if (branch(root) === name) {
    if (fetch) pullFastForward(root);
    return 'already-current';
  }
  if (refExists(root, `refs/heads/${name}`)) {
    git(['switch', name], { cwd: root, stdio: 'inherit' });
    if (fetch) pullFastForward(root);
    return 'checked-out-local';
  }
  if (refExists(root, `refs/remotes/origin/${name}`)) {
    git(['switch', '--track', '-c', name, `origin/${name}`], { cwd: root, stdio: 'inherit' });
    return 'tracked-remote';
  }
  if (existingOnly) throw new SingularityFlowError(`Branch ${name} does not exist locally or on origin.`);
  const baseRef = refExists(root, `refs/heads/${base}`)
    ? base
    : refExists(root, `refs/remotes/origin/${base}`)
      ? `origin/${base}`
      : 'HEAD';
  git(['switch', '-c', name, baseRef], { cwd: root, stdio: 'inherit' });
  return `created-from-${baseRef}`;
}

function nullList(value) {
  return value.split('\0').filter(Boolean);
}

export function changedFiles(root) {
  const unstaged = nullList(git(['diff', '--name-only', '-z', 'HEAD'], { cwd: root }).stdout);
  const staged = nullList(git(['diff', '--name-only', '-z', '--cached', 'HEAD'], { cwd: root }).stdout);
  const untracked = nullList(git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root }).stdout);
  return [...new Set([...unstaged, ...staged, ...untracked])].sort();
}

export function add(root, paths) {
  if (paths.length) git(['add', '-A', '--', ...paths], { cwd: root });
}

export function commit(root, message) {
  git(['commit', '-m', message], { cwd: root, stdio: 'inherit' });
  return head(root);
}

export function pushBranch(root, remote = 'origin', branchName = branch(root)) {
  return git(['push', '-u', remote, `HEAD:${branchName}`], { cwd: root, stdio: 'inherit', allowFailure: true });
}

export function remoteContains(root, sha, remote = 'origin', branchName = branch(root)) {
  if (!sha || !refExists(root, `refs/remotes/${remote}/${branchName}`)) return false;
  return git(['merge-base', '--is-ancestor', sha, `refs/remotes/${remote}/${branchName}`], { cwd: root, allowFailure: true }).status === 0;
}
