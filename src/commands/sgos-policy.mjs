/** Minimal shell surface for the content-addressed SGOS pinned-policy runtime. */
import { repoRoot } from '../git.mjs';
import {
  applyPinnedSgosPolicyAmendment,
  fsckPinnedSgosPolicyRuntime,
  planPinnedSgosPolicyAmendment,
  readPinnedSgosPolicyRuntimeStatus
} from '../sgos/pinned-policy.mjs';
import { validateSgosCliOptions } from '../sgos/cli-options.mjs';
import {
  optionBoolean, optionNumber, optionString, optionStrings, SingularityFlowError
} from '../util.mjs';
import { commandResult, effects, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';

function fail(message, code = 'SGOS_POLICY_CLI_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function invalidationSelection(options) {
  return Object.hasOwn(options, 'invalidate-process')
    ? optionStrings(options, 'invalidate-process') : null;
}

function emit(value, options, operation, summary, { changed = false } = {}) {
  return emitCommandResult(commandResult({
    operation: {
      id: operation,
      classification: changed ? 'mutation' : 'read'
    },
    outcome: succeeded('sgos.reported', {
      summary: typeof summary === 'function' ? summary(value) : summary
    }),
    effects: changed ? effects({
      stateChanged: true,
      filesChanged: true,
      publicationCreated: false,
      externalSystemsChanged: false
    }) : noEffects(),
    restState: 'informational',
    data: { result: value }
  }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
}

export async function run(_argv, { positionals, options }) {
  const action = positionals[1] ?? 'status';
  validateSgosCliOptions('policy', action, options);
  const root = repoRoot();
  if (action === 'status') {
    const result = await readPinnedSgosPolicyRuntimeStatus(root, {
      processId: positionals[2] ?? null
    });
    return emit(result, options, 'policy.status', (value) => value.initialized
      ? `Pinned policy revision ${value.revision} at ${value.activePolicySnapshotSha256}.`
        + (value.process ? ` Process ${value.process.processId} is ${value.process.status}.` : '')
      : 'Pinned policy runtime is not initialized; existing Processes retain their starting policy.');
  }
  if (action === 'fsck') {
    const result = await fsckPinnedSgosPolicyRuntime(root);
    return emit(result, options, 'policy.fsck', (value) =>
      `Pinned policy runtime is ${value.valid ? 'valid' : 'invalid'}; `
      + `${value.errors.length} error(s), ${value.warnings.length} warning(s).`);
  }
  if (action === 'plan') {
    const result = await planPinnedSgosPolicyAmendment(root, {
      invalidateProcessIds: invalidationSelection(options)
    });
    return emit(result, options, 'policy.plan', (value) =>
      `${value.diff.classification} policy amendment affects `
      + `${value.impact.affectedPrograms.length} Program(s) and `
      + `${value.impact.affectedProcesses.length} Process(es). `
      + `Review it, then apply revision ${value.plan.runtimeRevision} with `
      + `--confirm ${value.confirmationSha256}.`);
  }
  if (action === 'apply') {
    const expectedRevision = optionNumber(options, 'expected-revision');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      fail('policy apply requires --expected-revision with the exact non-negative revision from policy plan.',
        'SGOS_POLICY_REVISION_REQUIRED');
    }
    const result = await applyPinnedSgosPolicyAmendment(root, {
      confirmationSha256: optionString(options, 'confirm'),
      expectedRevision,
      invalidateProcessIds: invalidationSelection(options)
    });
    return emit(result, options, 'policy.apply', (value) =>
      `Applied policy amendment ${value.amendment.amendmentSha256}; runtime revision `
      + `${value.state.revision}, ${value.invalidations.length} Process invalidation(s).`,
    { changed: true });
  }
  fail(`Unknown policy action '${action}'.`, 'UNKNOWN_SUBCOMMAND');
}
