/** Model-free repository-independent CLI for local signed deliverables. */
import {
  optionBoolean, optionString, optionStrings, SingularityFlowError
} from '../util.mjs';
import {
  auditLocalBundle, createLocalSigner, exportLocalTrustKey, listLocalStories,
  openLocalStory, publishLocalBundle, reviewLocalCandidate
} from '../local-mode/service.mjs';
import {
  createLocalStory, freezeLocalCandidate, verifyLocalCandidate
} from '../local-mode/store.mjs';

const SUBCOMMANDS = Object.freeze([
  'start', 'list', 'status', 'freeze', 'verify', 'signer-create', 'trust-export',
  'review', 'publish', 'audit'
]);

function required(options, key) {
  const value = optionString(options, key);
  if (!value) {
    throw new SingularityFlowError(`--${key} is required.`, {
      code: 'LOCAL_OPTION_REQUIRED', details: { option: key }
    });
  }
  return value;
}

function rejectUnsupported(options) {
  if (options.device != null) {
    throw new SingularityFlowError(
      'Remote-device local bundle delivery is not implemented in the L1 pilot.',
      { code: 'LOCAL_DEVICE_UNSUPPORTED' }
    );
  }
  if (options.format != null
      && optionString(options, 'format') !== 'loc.zip.store.v1') {
    throw new SingularityFlowError(
      "Local mode supports only '--format loc.zip.store.v1'.",
      { code: 'EXPORT_PROFILE_UNSUPPORTED' }
    );
  }
}

function print(value, json) {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return value;
  }
  for (const [key, item] of Object.entries(value)) {
    if (item == null) continue;
    console.log(`${key}: ${typeof item === 'object' ? JSON.stringify(item) : item}`);
  }
  return value;
}

function storyId(positionals, options) {
  return optionString(options, 'story') ?? positionals[2];
}

export async function run(_argv, { positionals, options }) {
  const subcommand = positionals[1] ?? 'list';
  if (!SUBCOMMANDS.includes(subcommand)) {
    throw new SingularityFlowError(
      `local supports: ${SUBCOMMANDS.join(', ')}.`, { code: 'UNKNOWN_SUBCOMMAND' }
    );
  }
  const json = optionBoolean(options, 'json');
  rejectUnsupported(options);
  if (subcommand === 'start') {
    return print(await createLocalStory({
      name: optionString(options, 'name') ?? positionals[2],
      intent: required(options, 'intent'),
      inputs: optionStrings(options, 'input'),
      classification: required(options, 'classification'),
      allowEmptyOutput: optionBoolean(options, 'allow-empty-output')
    }), json);
  }
  if (subcommand === 'list') {
    return print({ stories: await listLocalStories() }, json);
  }
  if (subcommand === 'status') {
    const opened = await openLocalStory(storyId(positionals, options));
    const state = opened.state;
    return print({
      storyId: state.storyId,
      displayName: state.displayName,
      status: state.status,
      generationId: state.generationId,
      revision: state.revision,
      candidateDigest: state.roots.candidateDigest ?? null,
      evidenceRoot: state.roots.evidenceRoot ?? null,
      reviewSubjectDigest: state.roots.reviewSubjectDigest ?? null,
      bundleId: state.roots.bundleId ?? null,
      outputDirectory: opened.paths.output,
      pendingOperations: state.operations.filter(
        (entry) => entry.status !== 'completed'
      ).length,
      deliveries: state.deliveries.length
    }, json);
  }
  if (subcommand === 'freeze') {
    return print(await freezeLocalCandidate(
      storyId(positionals, options), optionStrings(options, 'output')
    ), json);
  }
  if (subcommand === 'verify') {
    return print(await verifyLocalCandidate(
      storyId(positionals, options), required(options, 'candidate')
    ), json);
  }
  if (subcommand === 'signer-create') {
    return print(await createLocalSigner(
      storyId(positionals, options), required(options, 'signer')
    ), json);
  }
  if (subcommand === 'trust-export') {
    return print(await exportLocalTrustKey(
      storyId(positionals, options), required(options, 'signer'),
      required(options, 'out')
    ), json);
  }
  if (subcommand === 'review') {
    return print(await reviewLocalCandidate(
      storyId(positionals, options), required(options, 'candidate'),
      required(options, 'signer')
    ), json);
  }
  if (subcommand === 'publish') {
    return print(await publishLocalBundle(
      storyId(positionals, options), required(options, 'candidate'),
      required(options, 'signer'), optionString(options, 'destination')
    ), json);
  }
  if (options.receipt != null || options.rerun != null) {
    throw new SingularityFlowError(
      'Delivery-receipt validation and rerun are separate later capabilities and are not advertised by L1.',
      { code: 'LOCAL_AUDIT_PROFILE_UNSUPPORTED' }
    );
  }
  return print(await auditLocalBundle(
    required(options, 'bundle'), required(options, 'trust-key'),
    required(options, 'signer')
  ), json);
}
