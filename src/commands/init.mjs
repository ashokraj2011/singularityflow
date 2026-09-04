import { createHash } from 'node:crypto';
import readline from 'node:readline/promises';
import path from 'node:path';
import { open, readFile, rm } from 'node:fs/promises';
import { stdin as input, stdout as output } from 'node:process';
import YAML from 'yaml';

import { repoRoot } from '../git.mjs';
import { recordSha256 } from '../records.mjs';
import { captureSmartInitSnapshot } from '../initialization/source-snapshot.mjs';
import { runSmartInitDetectors } from '../initialization/detectors.mjs';
import {
  assertNoPendingSmartInitRecovery, readLatestSmartInitActivation, recoverSmartInit
} from '../initialization/recovery.mjs';
import {
  buildSmartInitProposal, smartInitProposalBytes, verifySmartInitProposal
} from '../initialization/proposal.mjs';
import {
  ensureSecureRepositoryDirectory, optionBoolean, optionString, optionStrings,
  secureRepositoryPath, SingularityFlowError
} from '../util.mjs';

async function approvedLocalAuthority(root) {
  const { run } = await import('../util.mjs');
  const workingTree = await secureRepositoryPath(root, 'singularity/workflow.yml', {
    label: 'Active Singularity Flow configuration'
  });
  if (workingTree.exists) return { kind: 'working-tree', ref: 'working-tree:singularity/workflow.yml' };
  const refs = [
    ['working-tree', 'HEAD:singularity/workflow.yml'],
    ['configuration', 'refs/heads/sflow/config:singularity/workflow.yml'],
    ['state', 'refs/heads/state:singularity/workflow.yml'],
    ['configuration-cache', 'refs/remotes/origin/sflow/config:singularity/workflow.yml'],
    ['state-cache', 'refs/remotes/origin/state:singularity/workflow.yml']
  ];
  for (const [kind, object] of refs) {
    if (run('git', ['cat-file', '-e', object], { cwd: root, allowFailure: true }).status === 0) {
      return { kind, ref: object.split(':')[0] };
    }
  }
  return null;
}

function selectionsFrom(proposal) {
  return {
    mode: proposal.delivery.defaultMode,
    proofProfile: proposal.proof.profile,
    governance: proposal.governance.preset,
    activation: proposal.governance.activationChannel,
    protect: proposal.selectedSuggestionIds
  };
}

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9._/@:=,+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

async function currentSmartPolicy(root) {
  try {
    const workflowBytes = await readFile(path.join(root, 'singularity', 'workflow.yml'));
    const workflow = YAML.parse(workflowBytes.toString('utf8'));
    const origin = JSON.parse(await readFile(path.join(root, 'singularity', 'configuration-origin.json'), 'utf8'));
    const originCore = structuredClone(origin);
    delete originCore.originMapSha256;
    if (origin?.kind !== 'configuration-origin-map' || !workflow?.initialization
        || origin.configurationSha256 !== digest(workflowBytes)
        || origin.originMapSha256 !== `sha256:${recordSha256(originCore)}`) return null;
    return { workflowBytes, policy: workflow.initialization };
  } catch { return null; }
}

async function installedTargetDrift(root, rendered) {
  const changed = [];
  for (const file of rendered.files) {
    const target = await secureRepositoryPath(root, file.path, {
      label: 'Installed smart-init target'
    });
    if (!target.exists || !target.entry?.isFile()) {
      changed.push(file.path);
      continue;
    }
    if (digest(await readFile(target.absolute)) !== digest(file.bytes)) changed.push(file.path);
  }
  return changed;
}

function validActivationReceipt(record, configurationSha256) {
  if (!record || record.kind !== 'smart-init-activation'
      || record.installed?.configurationSha256 !== configurationSha256) return false;
  const core = structuredClone(record);
  const supplied = core.receiptSha256;
  delete core.receiptSha256;
  return supplied === `sha256:${recordSha256(core)}`;
}

function renderCard(proposal) {
  const lines = [
    'Smart initialization proposal',
    `Repository: ${proposal.subject.repositoryFingerprint} · ${proposal.subject.checkedOutRef} · ${proposal.subject.baseCommit.slice(0, 12)}`,
    '',
    `Detected: ${proposal.detectedStacks.length ? proposal.detectedStacks.join(', ') : 'unknown stack'}`,
    '',
    'Verification:'
  ];
  if (!proposal.commands.verification.length) lines.push('- unavailable (candidate admission will require a configured verifier)');
  for (const command of proposal.commands.verification) lines.push(`- ${command.launcher} ${command.args.join(' ')} · ${command.workingDirectory} · ${command.confidence}`);
  lines.push('', 'Quality and build:');
  for (const category of ['quality', 'build']) {
    if (!proposal.commands[category].length) lines.push(`- ${category}: none detected`);
    for (const command of proposal.commands[category]) lines.push(`- ${category}: ${command.launcher} ${command.args.join(' ')} · ${command.workingDirectory} · ${command.confidence}`);
  }
  lines.push(
    '', 'Delivery:',
    `- ${proposal.delivery.defaultMode} by default; standard Workflow remains available; pace ${proposal.delivery.executionPace}`,
    '', 'Proof:',
    `- ${proposal.proof.profile} · ${proposal.proof.readiness}`,
    '', 'Capability:',
    '- This repository (repository-root); no capability map will be created.',
    '', 'Repository-specific protections (unchecked unless selected):'
  );
  if (!proposal.suggestions.length) lines.push('- none detected');
  for (const item of proposal.suggestions) lines.push(`- [${item.selected ? 'x' : ' '}] ${item.id}: ${item.pattern}`);
  lines.push('', 'Built-in SFlow protection:');
  for (const item of proposal.builtInInvariants) lines.push(`- ${item.pattern}`);
  lines.push('', `Activation: ${proposal.governance.activationChannel}`, '', 'Will write:');
  for (const file of proposal.writeSet) lines.push(`- ${file.path} · ${file.expectation} · ${file.sha256.slice(0, 19)}`);
  lines.push(
    '', 'Will not: call a model, run project scripts, install dependencies, access the network, or create capabilities.yml.',
    '', `Apply proposal ${proposal.proposalSha256}`
  );
  if (proposal.ambiguities.length) {
    lines.push('', 'Unresolved ambiguity:');
    for (const item of proposal.ambiguities) lines.push(`- ${item.id}: ${item.reason}`);
  }
  return lines.join('\n');
}

async function writeProposal(root, requested, proposal) {
  const target = await secureRepositoryPath(root, requested, { label: 'Smart-init proposal output' });
  if (target.exists) throw new SingularityFlowError(
    `Smart-init proposal output already exists: ${target.relative}. Choose a new path so reviewed bytes are never overwritten.`,
    { code: 'INI_TARGET_CHANGED' }
  );
  await ensureSecureRepositoryDirectory(root, path.posix.dirname(target.relative), { label: 'Smart-init proposal directory' });
  let handle;
  try {
    handle = await open(target.absolute, 'wx', 0o600);
    await handle.writeFile(smartInitProposalBytes(proposal), 'utf8');
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => {});
    handle = null;
    if (error?.code === 'EEXIST') throw new SingularityFlowError(
      `Smart-init proposal output appeared concurrently: ${target.relative}. Choose a new path.`,
      { code: 'INI_TARGET_CHANGED', cause: error }
    );
    await rm(target.absolute, { force: true }).catch(() => {});
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
  return target.relative;
}

async function smartInit(positionals, options) {
  for (const incompatible of ['repair', 'check', 'work-id', 'base', 'migrate-legacy', 'fetch', 'recover']) {
    if (options[incompatible] != null) throw new SingularityFlowError(
      `--smart-detect cannot be combined with --${incompatible}. Use the existing init command separately, or run smart init before starting a Story.`,
      { code: 'INI_CONFIGURATION_INVALID' }
    );
  }
  const root = repoRoot();
  await assertNoPendingSmartInitRecovery(root);
  const authority = await approvedLocalAuthority(root);
  const dryRun = optionBoolean(options, 'dry-run');
  const yes = optionBoolean(options, 'yes');
  if (dryRun && (options.confirm != null || yes)) throw new SingularityFlowError(
    '--dry-run cannot be combined with --confirm or --yes.', { code: 'INI_CONFIGURATION_INVALID' }
  );
  if (dryRun && options.output != null) throw new SingularityFlowError(
    '--dry-run never writes files and cannot be combined with --output. Use --output <FILE> without --dry-run to export a non-active proposal.',
    { code: 'INI_CONFIGURATION_INVALID' }
  );
  const snapshot = await captureSmartInitSnapshot(root);
  const detection = runSmartInitDetectors(snapshot);
  if (authority) {
    const installed = authority.kind === 'working-tree' ? await currentSmartPolicy(root) : null;
    if (installed) {
      const rendered = await buildSmartInitProposal(snapshot, detection, {
        mode: installed.policy.delivery?.defaultMode ?? 'outcome',
        proofProfile: installed.policy.proof?.profile ?? 'standard',
        governance: installed.policy.governance?.preset ?? 'team',
        activation: 'local-confirmation',
        protect: installed.policy.acceptedProtections ?? []
      });
      if (rendered.proposal.proposedConfigurationSha256 === digest(installed.workflowBytes)) {
        const [activation, changedTargets] = await Promise.all([
          readLatestSmartInitActivation(root), installedTargetDrift(root, rendered)
        ]);
        if (!validActivationReceipt(activation?.record, rendered.proposal.proposedConfigurationSha256)
            || changedTargets.length) {
          throw new SingularityFlowError(
            'Smart initialization law is present, but its activation receipt or installed preset assets no longer match. Existing law was preserved; run quick precheck and repair it through configuration authority.',
            {
              code: 'INI_ALREADY_GOVERNED',
              details: {
                activationReceipt: validActivationReceipt(
                  activation?.record, rendered.proposal.proposedConfigurationSha256
                ) ? 'valid' : 'missing-or-invalid',
                changedTargets,
                nextCommand: 'singularity-flow precheck --quick'
              }
            }
          );
        }
        const result = {
          status: 'no-change', authority,
          configurationSha256: rendered.proposal.proposedConfigurationSha256,
          sourceManifestSha256: rendered.proposal.sourceManifestSha256,
          nextCommand: 'singularity-flow precheck --quick'
        };
        if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
        else console.log(`Smart initialization is already current. No files or Git state changed.\nNext: ${result.nextCommand}`);
        return result;
      }
      throw new SingularityFlowError(
        'Smart initialization inputs now imply a semantic configuration change. Existing approved law was preserved; review the changed command sources and use the configuration authority to update it.',
        {
          code: 'INI_ALREADY_GOVERNED',
          details: {
            authority,
            currentConfigurationSha256: digest(installed.workflowBytes),
            proposedConfigurationSha256: rendered.proposal.proposedConfigurationSha256,
            nextCommand: 'singularity-flow config explain'
          }
        }
      );
    }
    throw new SingularityFlowError(
      `This repository already has approved Singularity Flow authority at ${authority.ref}. Use it or propose a configuration change there; smart init changed nothing.`,
      { code: 'INI_ALREADY_GOVERNED', details: { authority, nextCommand: 'singularity-flow configuration validate' } }
    );
  }
  let accepted = null;
  const acceptedPath = optionString(options, 'accept-proposal');
  if (acceptedPath) {
    const source = await secureRepositoryPath(root, acceptedPath, { label: 'Accepted smart-init proposal', mustExist: true, type: 'file' });
    try { accepted = verifySmartInitProposal(JSON.parse(await readFile(source.absolute, 'utf8'))); }
    catch (error) {
      if (error instanceof SingularityFlowError) throw error;
      throw new SingularityFlowError(`Accepted smart-init proposal is invalid JSON: ${error.message}`, { code: 'INI_CONFIGURATION_INVALID', cause: error });
    }
  }
  const requested = accepted ? selectionsFrom(accepted) : {
    mode: optionString(options, 'mode', 'outcome'),
    proofProfile: optionString(options, 'proof-profile', 'standard'),
    governance: optionString(options, 'governance', 'team'),
    activation: optionString(options, 'activation', 'local-confirmation'),
    protect: optionStrings(options, 'protect')
  };
  const rendered = await buildSmartInitProposal(snapshot, detection, requested);
  if (accepted && smartInitProposalBytes(accepted) !== smartInitProposalBytes(rendered.proposal)) {
    throw new SingularityFlowError(
      'The accepted proposal no longer matches current repository, detector, preset, renderer, or target bytes. Regenerate it and confirm the new hash.',
      { code: 'INI_PROPOSAL_STALE', details: { accepted: accepted.proposalSha256, current: rendered.proposal.proposalSha256 } }
    );
  }
  const outputPath = optionString(options, 'output');
  if (dryRun) {
    if (optionBoolean(options, 'json')) console.log(smartInitProposalBytes(rendered.proposal).trimEnd());
    else console.log(renderCard(rendered.proposal));
    return { status: 'proposal', proposal: rendered.proposal, output: null };
  }
  const written = outputPath ? await writeProposal(root, outputPath, rendered.proposal) : null;
  if (written && !accepted
      && rendered.proposal.governance.activationChannel === 'local-confirmation'
      && !yes && options.confirm == null) {
    const result = {
      status: 'proposal-only',
      proposalSha256: rendered.proposal.proposalSha256,
      output: written,
      nextCommand: `singularity-flow init --smart-detect --accept-proposal ${shellQuote(written)} --confirm ${rendered.proposal.proposalSha256}`
    };
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else console.log(`${renderCard(rendered.proposal)}\n\nProposal written: ${written}. No repository law was activated.\nNext: ${result.nextCommand}`);
    return result;
  }
  if (rendered.proposal.governance.activationChannel !== 'local-confirmation') {
    if (!written) throw new SingularityFlowError(
      `${rendered.proposal.governance.activationChannel} requires --output <repository-relative-proposal.json>; active configuration was not changed.`,
      { code: rendered.proposal.governance.activationChannel === 'review-proposal' ? 'INI_REVIEW_REQUIRED' : 'INI_CONFIRMATION_REQUIRED' }
    );
    const result = { status: 'proposal-only', proposalSha256: rendered.proposal.proposalSha256, output: written };
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else console.log(`${renderCard(rendered.proposal)}\n\nProposal only: ${written}. No repository law was activated.`);
    return result;
  }
  let confirmation = optionString(options, 'confirm');
  if (yes) confirmation = rendered.proposal.proposalSha256;
  if (!confirmation && input.isTTY && output.isTTY) {
    console.log(renderCard(rendered.proposal));
    const terminal = readline.createInterface({ input, output });
    try { confirmation = (await terminal.question('\nPaste the exact proposal SHA-256 to apply, or press Enter to cancel: ')).trim(); }
    finally { terminal.close(); }
    if (!confirmation) return { status: 'cancelled', proposalSha256: rendered.proposal.proposalSha256 };
  }
  if (!confirmation) {
    throw new SingularityFlowError(
      `${renderCard(rendered.proposal)}\n\nReview the proposal, then rerun with --confirm ${rendered.proposal.proposalSha256}.`,
      { code: 'INI_CONFIRMATION_REQUIRED', details: { proposalSha256: rendered.proposal.proposalSha256 } }
    );
  }
  const { activateSmartInit } = await import('../initialization/activation.mjs');
  const result = await activateSmartInit(root, rendered, {
    confirmation,
    allowUnavailableVerification: optionBoolean(options, 'allow-unavailable-verification')
  });
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log('Initialized — exact repository law activated.');
    console.log(`Commit: ${result.activationCommit}`);
    console.log('Capability: This repository.');
    console.log(`Proof readiness: ${result.proofReadiness}.`);
    console.log(`Next: ${result.nextCommand}`);
  }
  return result;
}

export async function run(argv, context = {}) {
  const { positionals, options } = context;
  if (optionBoolean(options, 'recover')) {
    const root = repoRoot();
    const result = await recoverSmartInit(root, optionString(options, 'proposal'));
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else if (result.status === 'complete') console.log(
      `Smart initialization is complete at ${result.activationCommit}. No application work was changed.`
    );
    else console.log('Interrupted smart initialization was rolled back to its exact fresh-repository preimage. Unrelated work was preserved.');
    return result;
  }
  if (!optionBoolean(options, 'smart-detect')) {
    const legacy = await import('./legacy.mjs');
    return legacy.run(argv);
  }
  return smartInit(positionals, options);
}
