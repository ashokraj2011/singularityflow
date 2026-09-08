import path from 'node:path';

import { incrementCommandCounter } from './dx-timing-context.mjs';
import { run, SingularityFlowError } from './util.mjs';

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}

function text(result) {
  return result.stdout.trim();
}

function lines(result) {
  return Object.freeze(result.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean));
}

function nul(result) {
  return Object.freeze(result.stdout.split('\0').filter(Boolean));
}

function descriptor(id, {
  argv, parser = text, dependency = 'mutable', allowFailure = false,
  network = false, effects = 'none', environment = []
}) {
  return freezeDeep({
    id, executable: 'git', argv, parser, dependency, allowFailure,
    network, effects, environment: [...environment], timeoutClass: network ? 'remote-read' : 'local-read'
  });
}

const descriptors = [
  descriptor('repository.paths', {
    argv: () => ['rev-parse', '--path-format=absolute', '--absolute-git-dir', '--git-common-dir'],
    dependency: 'repository-instance',
    parser(result) {
      const values = lines(result);
      if (values.length !== 2) throw new SingularityFlowError(
        'Git returned an invalid repository-path response.', { code: 'GIT_QUERY_PARSE_FAILED' }
      );
      return { gitDir: path.resolve(values[0]), commonDir: path.resolve(values[1]) };
    }
  }),
  descriptor('repository.root', {
    argv: () => ['rev-parse', '--show-toplevel'], dependency: 'repository-instance',
    allowFailure: true, parser: (result) => result.status === 0 ? path.resolve(text(result)) : null
  }),
  descriptor('repository.object-format', {
    argv: () => ['rev-parse', '--show-object-format'], dependency: 'repository-instance'
  }),
  descriptor('repository.bare', {
    argv: () => ['rev-parse', '--is-bare-repository'], dependency: 'repository-instance',
    parser: (result) => text(result) === 'true'
  }),
  descriptor('repository.head', {
    argv: () => ['rev-parse', '--verify', 'HEAD'], allowFailure: true,
    parser: (result) => result.status === 0 ? text(result) : null
  }),
  descriptor('repository.branch', {
    argv: () => ['symbolic-ref', '--quiet', '--short', 'HEAD'], allowFailure: true,
    parser: (result) => result.status === 0 ? text(result) : null
  }),
  descriptor('repository.status', {
    argv: () => ['status', '--porcelain=v2', '-z', '--untracked-files=all'], parser: nul
  }),
  descriptor('repository.tracked-paths', {
    argv: () => ['ls-files', '-z'], parser: nul
  }),
  descriptor('repository.remotes', {
    argv: () => ['remote'], dependency: 'configuration', parser: lines
  }),
  descriptor('repository.remote-url', {
    argv(params) {
      const remote = String(params?.remote ?? '');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(remote)) throw new SingularityFlowError(
        'Remote names must use Git-safe literal characters.', { code: 'GIT_QUERY_INPUT_INVALID' }
      );
      // Read the repository-local literal. `git remote get-url` applies url.*.insteadOf rewrites,
      // which would silently change the authority identity and can invoke ambient configuration.
      return ['config', '--local', '--get-all', `remote.${remote}.url`];
    },
    dependency: 'configuration', allowFailure: true,
    parser(result) {
      if (result.status !== 0) return null;
      const values = lines(result);
      if (values.length !== 1) throw new SingularityFlowError(
        'Configured remote must have exactly one repository-local URL.', {
          code: 'GIT_QUERY_RESULT_AMBIGUOUS'
        }
      );
      return values[0];
    }
  })
];

// Fix accidental editor tokens at module construction time rather than allowing a malformed
// descriptor to reach Git. This guard is also exercised by the registry test.
for (const entry of descriptors) {
  if (!/^[a-z][a-z0-9.-]+$/.test(entry.id)) throw new Error(`Invalid Git query id '${entry.id}'.`);
  if (!['repository-instance', 'configuration', 'mutable'].includes(entry.dependency)) {
    throw new Error(`Invalid Git query dependency '${entry.dependency}'.`);
  }
}

export const GIT_QUERY_REGISTRY = freezeDeep(Object.fromEntries(
  descriptors.map((entry) => [entry.id, entry])
));

export function gitQueryDescriptor(id) {
  const entry = GIT_QUERY_REGISTRY[id];
  if (!entry) throw new SingularityFlowError(`Unknown registered Git query '${id}'.`, {
    code: 'GIT_QUERY_UNKNOWN', details: { queryId: id }
  });
  return entry;
}

export function executeGitQuery(root, id, params = {}, { env = process.env, runner = run } = {}) {
  const entry = gitQueryDescriptor(id);
  const argv = entry.argv(params);
  if (!Array.isArray(argv) || argv.some((token) => typeof token !== 'string' || token.includes('\0'))) {
    throw new SingularityFlowError(`Git query '${id}' produced invalid arguments.`, {
      code: 'GIT_QUERY_INPUT_INVALID'
    });
  }
  incrementCommandCounter('git.requests');
  incrementCommandCounter('git.spawns');
  const started = performance.now();
  let result;
  try {
    result = runner(entry.executable, argv, {
      cwd: path.resolve(root), env, allowFailure: entry.allowFailure,
      operation: entry.id, network: entry.network
    });
  } finally {
    incrementCommandCounter('git.service-ms', Math.max(0, Math.round(performance.now() - started)));
  }
  if (!entry.allowFailure && result.status !== 0) throw new SingularityFlowError(
    `Git query '${id}' failed.`, { code: 'GIT_QUERY_FAILED', details: { queryId: id } }
  );
  return freezeDeep(entry.parser(result));
}
