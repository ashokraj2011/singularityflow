import path from 'node:path';

import { incrementCommandCounter } from './dx-timing-context.mjs';
import { GAL_ASYNC_READ_DESCRIPTORS } from './gal-async-read.mjs';
import { withoutGitProcessOverrides } from './git-enterprise-environment.mjs';
import { parseGitIndexStages, parsePorcelainV2Status } from './git-status-detail.mjs';
import { parsePorcelainV2Revision } from './git-status-projection.mjs';
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

/**
 * Git uses exit 1 with no output for several intentional "not present" queries.  The process
 * runner also normalizes resolver, timeout, signal, and blocked failures to a non-zero status with
 * empty streams, so status and output alone cannot prove absence.
 */
function cleanNegativeResult(result) {
  return result.status === 1 && !result.stdout && !result.stderr
    && result.error == null && result.signal == null
    && result.timedOut !== true && result.blocked !== true
    && result.outputOverflow !== true;
}

function lines(result) {
  return Object.freeze(result.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean));
}

function nul(result) {
  return Object.freeze(result.stdout.split('\0').filter(Boolean));
}

function descriptor(id, {
  argv, parser = text, dependency = 'mutable', allowFailure = false,
  network = false, effects = 'none', environment = [], encoding = 'utf8', validate = null,
  maxBuffer = null, timeoutClass = network ? 'remote-read' : 'local-read'
}) {
  return freezeDeep({
    id, executable: 'git', argv, parser, dependency, allowFailure,
    network, effects, environment: [...environment], encoding, validate,
    timeoutClass, ...(maxBuffer == null ? {} : { maxBuffer })
  });
}

function validatedObjectFormat(params) {
  const objectFormat = params?.objectFormat;
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
    throw new SingularityFlowError('A known repository object format is required for a byte-exact Git listing.', {
      code: 'GIT_QUERY_INPUT_INVALID'
    });
  }
  return objectFormat;
}

function validateStatusDetail(params) {
  const objectFormat = validatedObjectFormat(params);
  const untracked = params?.untracked ?? 'all';
  const includeIgnored = params?.includeIgnored ?? false;
  if (!['all', 'normal', 'no'].includes(untracked) || typeof includeIgnored !== 'boolean') {
    throw new SingularityFlowError('Invalid byte-exact Git status selection.', {
      code: 'GIT_QUERY_INPUT_INVALID'
    });
  }
  return Object.freeze({ objectFormat, untracked, includeIgnored });
}

function validateIndexDetail(params) {
  return Object.freeze({ objectFormat: validatedObjectFormat(params) });
}

function localBranchName(params) {
  const branch = String(params?.branch ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(branch)
      || branch.endsWith('.') || branch.endsWith('/') || branch.includes('..')
      || branch.includes('//') || branch.includes('@{') || branch.includes('/.')) {
    throw new SingularityFlowError('Local branch names must be a safe literal Git branch.', {
      code: 'GIT_QUERY_INPUT_INVALID'
    });
  }
  return branch;
}

function checkedLocalBranchRef(value) {
  const prefix = 'refs/heads/';
  if (typeof value !== 'string' || !value.startsWith(prefix) || value.length === prefix.length
      || value.includes('..') || value.includes('@{') || value.includes('//')
      || /[\u0000-\u0020\u007f~^:?*\[\\]/u.test(value)) return null;
  const parts = value.split('/');
  if (parts.some((part) => !part || part.startsWith('.') || part.endsWith('.')
      || part.endsWith('.lock'))) return null;
  return value.slice(prefix.length);
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
    argv: () => [...GAL_ASYNC_READ_DESCRIPTORS['repository.root'].argv],
    dependency: 'repository-instance',
    allowFailure: true, parser(result) {
      if (result.status !== 0) return null;
      const observedRoot = text(result);
      return observedRoot && path.isAbsolute(observedRoot) ? path.resolve(observedRoot) : null;
    }
  }),
  descriptor('repository.object-format', {
    argv: () => ['rev-parse', '--show-object-format'], dependency: 'repository-instance'
  }),
  descriptor('repository.bare', {
    argv: () => ['rev-parse', '--is-bare-repository'], dependency: 'repository-instance',
    parser: (result) => text(result) === 'true'
  }),
  descriptor('repository.head', {
    argv: () => ['rev-parse', '--verify', '--quiet', 'HEAD'], allowFailure: true,
    parser(result) {
      if (cleanNegativeResult(result)) return null;
      if (result.status !== 0) throw new SingularityFlowError(
        'The repository HEAD could not be observed safely.', {
          code: 'GIT_QUERY_FAILED', details: { queryId: 'repository.head' }
        }
      );
      const oid = text(result);
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(oid)) {
        throw new SingularityFlowError('Git returned an invalid repository HEAD.', {
          code: 'GIT_QUERY_PARSE_FAILED', details: { queryId: 'repository.head' }
        });
      }
      return oid;
    }
  }),
  descriptor('repository.branch', {
    // Keep this as one branch-only process. Opening the general GAL repository facade first costs
    // several discovery probes and made the status cutover materially slower than the legacy read.
    // The full ref makes the protocol self-describing; accepting arbitrary `--short` output would
    // let a malformed wrapper return a tag, remote-tracking ref, or multi-line value as a branch.
    argv: () => ['symbolic-ref', '--quiet', 'HEAD'], allowFailure: true,
    parser(result) {
      if (cleanNegativeResult(result)) return null;
      if (result.status !== 0) throw new SingularityFlowError(
        'The checked-out branch could not be observed safely.', {
          code: 'GIT_QUERY_FAILED', details: { queryId: 'repository.branch' }
        }
      );
      const ref = text(result);
      const branch = checkedLocalBranchRef(ref);
      if (!branch) {
        throw new SingularityFlowError('Git returned an invalid checked-out branch.', {
          code: 'GIT_QUERY_PARSE_FAILED', details: { queryId: 'repository.branch' }
        });
      }
      return branch;
    }
  }),
  descriptor('repository.local-branch-exists', {
    argv: (params) => ['show-ref', '--verify', '--quiet', `refs/heads/${localBranchName(params)}`],
    allowFailure: true,
    parser: (result) => result.status === 0
  }),
  descriptor('repository.status', {
    argv(params) {
      const untracked = params?.untracked ?? 'all';
      if (!['all', 'no'].includes(untracked)) throw new SingularityFlowError(
        "Repository status untracked mode must be 'all' or 'no'.", {
          code: 'GIT_QUERY_INPUT_INVALID'
        }
      );
      return ['status', '--porcelain=v2', '-z', `--untracked-files=${untracked}`];
    },
    parser: nul
  }),
  descriptor('repository.status-detail', {
    validate: validateStatusDetail,
    encoding: 'buffer',
    argv(params) {
      return [
        'status', '--porcelain=v2', '-z', '--branch',
        `--untracked-files=${params.untracked}`, '--ignore-submodules=none',
        ...(params.includeIgnored ? ['--ignored'] : [])
      ];
    },
    parser(result, params) {
      return parsePorcelainV2Status(result.stdout, { ...params, expectBranch: true });
    }
  }),
  descriptor('repository.index-detail', {
    validate: validateIndexDetail,
    encoding: 'buffer',
    argv: () => ['ls-files', '--stage', '-z'],
    parser(result, params) {
      return parseGitIndexStages(result.stdout, params);
    }
  }),
  descriptor('repository.revision', {
    argv: () => ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'],
    parser: (result) => parsePorcelainV2Revision(result.stdout)
  }),
  descriptor('repository.tracked-paths', {
    argv: () => ['ls-files', '-z'], parser: nul,
    // Preserve project discovery's original output and deadline boundaries during cutover.
    maxBuffer: 32 * 1024 * 1024, timeoutClass: null
  }),
  descriptor('repository.remotes', {
    argv: () => ['remote'], dependency: 'configuration', parser: lines
  }),
  descriptor('sgos.configured-remotes', {
    argv: () => ['remote'], dependency: 'configuration', allowFailure: true,
    parser(result) {
      if (result.status !== 0) return { ok: false, stderr: result.stderr.trim() };
      return { ok: true, remotes: [...lines(result)].sort() };
    }
  }),
  descriptor('sgos.local-authority-heads', {
    argv: () => [
      'for-each-ref', '--format=%(refname)',
      'refs/heads/sflow/config', 'refs/heads/state'
    ],
    allowFailure: true,
    parser: (result) => result.status === 0 ? [...lines(result)].sort() : []
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
      if (cleanNegativeResult(result)) return null;
      if (result.status !== 0) throw new SingularityFlowError(
        'The configured remote could not be observed safely.', {
          code: 'GIT_QUERY_FAILED', details: { queryId: 'repository.remote-url' }
        }
      );
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
  const validatedParams = entry.validate ? entry.validate(params) : params;
  const argv = entry.argv(validatedParams);
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
    // The explicit root is the repository authority for every registered query. Ambient process
    // selectors such as GIT_DIR, GIT_WORK_TREE, and GIT_INDEX_FILE must not redirect the query to
    // another checkout while its cwd and diagnostics still name this root. Ordinary office proxy,
    // CA, credential-manager, HOME, and system/global configuration remain available.
    const queryEnvironment = withoutGitProcessOverrides(env);
    result = runner(entry.executable, argv, {
      cwd: path.resolve(root), env: queryEnvironment, allowFailure: entry.allowFailure,
      operation: entry.id, network: entry.network, timeoutClass: entry.timeoutClass,
      recordGitTiming: false,
      ...(entry.maxBuffer == null ? {} : { maxBuffer: entry.maxBuffer }),
      ...(entry.encoding === 'buffer' ? { encoding: 'buffer' } : {})
    });
  } finally {
    incrementCommandCounter('git.service-ms', Math.max(0, Math.round(performance.now() - started)));
  }
  if (!entry.allowFailure && result.status !== 0) throw new SingularityFlowError(
    `Git query '${id}' failed.`, { code: 'GIT_QUERY_FAILED', details: { queryId: id } }
  );
  return freezeDeep(entry.parser(result, validatedParams));
}
