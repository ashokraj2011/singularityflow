import { repoRoot } from '../git.mjs';
import { incrementCommandCounter, markCommandFeedback } from '../dx-timing-context.mjs';
import { clearFosDerivedCache } from '../fos-derived-cache.mjs';
import {
  bootstrapFosAuthority, onboardRepository, refreshFosAuthority
} from '../onboard.mjs';
import { commandResult, effects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import {
  optionBoolean, optionString, requirePositional, SingularityFlowError
} from '../util.mjs';

function output(value, json, kind) {
  const isCache = kind === 'cache';
  const isRefresh = kind === 'authority';
  const messageId = isCache ? 'fos.cache-cleared'
    : isRefresh
      ? value.status === 'refreshed' ? 'fos.authority-refreshed' : 'fos.authority-current'
      : 'fos.repository-attached';
  return emitCommandResult(commandResult({
    operation: {
      id: isCache ? 'cache.clear-derived' : isRefresh ? 'authority.refresh' : 'onboard.attach',
      classification: 'mutation'
    },
    subject: {
      kind: 'repository',
      id: value.descriptor?.repository?.repositoryInstanceId ?? 'selected-repository'
    },
    outcome: succeeded(messageId, {
      status: value.status,
      operationId: value.operationId ?? null,
      authority: value.descriptor?.authority
        ? `${value.descriptor.authority.branch}@${value.descriptor.authority.commit.slice(0, 12)}` : null,
      pin: value.descriptor?.descriptorSha256 ?? null,
      removedEntries: value.removedEntries ?? null
    }),
    effects: effects({
      stateChanged: isCache ? Number(value.removedEntries ?? 0) > 0 : value.changed !== false
    }),
    restState: 'complete',
    data: { result: value }
  }), { json, restStateWhenIdle: 'complete' });
}

function selectedRoot(value) {
  return repoRoot(value || process.cwd());
}

export async function run(_argv, { positionals, options }) {
  const command = positionals[0];
  const json = optionBoolean(options, 'json');
  if (command === 'onboard') {
    const root = selectedRoot(requirePositional(positionals, 1, 'local path'));
    const bootstrap = optionBoolean(options, 'bootstrap');
    const publish = optionBoolean(options, 'publish');
    const offline = optionBoolean(options, 'offline');
    if (publish && !bootstrap) {
      throw new SingularityFlowError(
        '--publish is valid only with an explicit approved bootstrap.',
        { code: 'FOS_BOOTSTRAP_OPTIONS_INVALID' }
      );
    }
    if (bootstrap && offline) throw new SingularityFlowError(
      '--offline cannot be combined with bootstrap or publication.', {
        code: 'FOS_BOOTSTRAP_OPTIONS_INVALID'
      }
    );
    if (bootstrap) {
      markCommandFeedback();
      if (!json) process.stderr.write('Establishing one missing authority under an existing bootstrap trust contract; no source scan, AST, world model, or model request will run.\n');
      return output(await bootstrapFosAuthority(root, {
        remote: optionString(options, 'remote'),
        authorityLocal: optionBoolean(options, 'authority-local'),
        publish,
        policyId: optionString(options, 'policy')
      }), json, 'onboard');
    }
    // This is meaningful feedback rather than an empty spinner: it says exactly which bounded
    // operation has begun without reflecting a path, URL, identity, or secret into diagnostics.
    markCommandFeedback();
    if (!json) process.stderr.write('Verifying one reviewed configuration authority; no clone, source scan, AST, world model, or model request will run.\n');
    for (const counter of ['discovery.calls', 'composition.calls', 'llm.calls', 'ast.calls']) {
      incrementCommandCounter(counter, 0);
    }
    return output(await onboardRepository(root, {
      remote: optionString(options, 'remote'),
      authorityLocal: optionBoolean(options, 'authority-local'),
      offline,
      cache: options.cache !== false,
      // `--resume` is an established boolean flag on other commands. The shared parser therefore
      // leaves its value as the next positional for this command rather than greedily consuming it.
      resume: options.resume === true ? positionals[2] : null
    }), json, 'onboard');
  }
  if (command === 'authority') {
    if (positionals[1] !== 'refresh') throw new SingularityFlowError(
      "authority supports only 'refresh <LOCAL-PATH>'.", { code: 'UNKNOWN_SUBCOMMAND' }
    );
    markCommandFeedback();
    process.stderr.write('Refreshing the previously selected configuration authority pin.\n');
    return output(await refreshFosAuthority(
      selectedRoot(requirePositional(positionals, 2, 'local path'))
    ), json, 'authority');
  }
  if (command === 'cache') {
    if (positionals[1] !== 'clear' || !optionBoolean(options, 'derived')) {
      throw new SingularityFlowError(
        "cache supports 'clear --derived --repo <LOCAL-PATH>'.", { code: 'UNKNOWN_SUBCOMMAND' }
      );
    }
    return output(await clearFosDerivedCache(selectedRoot(
      optionString(options, 'repo') ?? requirePositional(positionals, 2, 'repository path')
    )), json, 'cache');
  }
  throw new SingularityFlowError(`Unsupported FOS command '${command}'.`, { code: 'UNKNOWN_COMMAND' });
}
