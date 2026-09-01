import { createHash } from 'node:crypto';

import { generationTaskForPhase } from '../model-tasks.mjs';
import { loadModelTiers, tierLadder } from '../model-tiers.mjs';
import { resolveModelProvider } from '../model-runner.mjs';
import { modelProviderIds } from '../model-provider-registry.mjs';
import { canonicalJson, recordSha256 } from '../records.mjs';
import { commandExists, run } from '../util.mjs';
import { AUTO_AUTHORING_TOOLS } from './auto-policy.mjs';

function sha256(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

/** Probe the concrete execution driver before its descriptor becomes ratified Plan bytes. */
export async function executionUnitDriverDoctor(root, definition, phaseId) {
  const selected = resolveModelProvider(definition);
  const providerConfig = selected.providerConfig ?? {};
  const adapter = providerConfig.type ?? selected.provider;
  const executable = providerConfig.executable ?? null;
  const task = generationTaskForPhase(definition, phaseId);
  const checks = [];
  const check = (id, passed, detail) => checks.push({ id, status: passed ? 'pass' : 'fail', detail });
  check('provider-configured', Boolean(providerConfig.type && executable), executable ?? 'provider executable is absent');
  check('adapter-installed', modelProviderIds().includes(adapter), adapter);
  check('executable-resolved', Boolean(executable && commandExists(executable)), executable ?? 'absent');
  let probe = { status: null, outputSha256: null };
  if (executable && commandExists(executable)) {
    const result = run(executable, ['--version'], { cwd: root, allowFailure: true, timeoutMs: 5_000 });
    probe = {
      status: result.status,
      outputSha256: `sha256:${sha256(`${result.stdout}\0${result.stderr}`)}`
    };
    check('executable-probe', result.status === 0, `--version exited ${result.status}`);
  } else check('executable-probe', false, 'executable was not resolved');
  const mapping = await loadModelTiers(root).catch(() => null);
  const ladder = mapping ? tierLadder(mapping, task) : null;
  const resolvedModels = [...(ladder?.models ?? [])].filter(Boolean);
  if (!resolvedModels.length && (selected.model ?? providerConfig.model)) {
    resolvedModels.push(selected.model ?? providerConfig.model);
  }
  check('model-routed', resolvedModels.length > 0, resolvedModels.join(', ') || `no model route for ${task}`);
  const cancellation = adapter === 'copilot-cli'
    ? { supported: true, scope: 'process-group', graceMs: 250, forcedTermination: true }
    : { supported: false, scope: null, graceMs: null, forcedTermination: false };
  check('cancellation', cancellation.supported, cancellation.scope ?? 'unsupported');
  const promptTransport = providerConfig.promptTransport ?? 'auto';
  let scopedTransport = adapter === 'copilot-cli' && promptTransport === 'acp-stdio';
  if (adapter === 'copilot-cli' && promptTransport === 'auto'
      && executable && commandExists(executable)) {
    const help = run(executable, ['--help'], {
      cwd: root, allowFailure: true, timeoutMs: 5_000
    });
    scopedTransport = help.status === 0 && /(?:^|\s)--acp(?:\s|,|$)/m.test(
      `${help.stdout}\n${help.stderr}`
    );
  }
  check(
    'path-scope-transport', scopedTransport,
    scopedTransport
      ? `${promptTransport} provides ACP path-v1 pre-effect permission`
      : `${promptTransport} cannot enforce Auto filesystem scope before effects`
  );
  const toolContract = {
    mode: 'allowlist', names: [...AUTO_AUTHORING_TOOLS],
    shell: false, git: false, lifecycleMutation: false
  };
  check('tool-contract', toolContract.names.length > 0 && !toolContract.shell && !toolContract.git, toolContract.names.join(', '));
  const core = {
    schemaVersion: 1, // schema-transient: content-addressed Plan component, persisted only inside auto-plan.
    driver: 'execution-unit-driver-v1', provider: selected.provider, adapter, executable,
    task, resolvedModels, probe, cancellation, promptTransport, toolContract, checks
  };
  return {
    ...core,
    status: checks.every((entry) => entry.status === 'pass') ? 'available' : 'unavailable',
    descriptorSha256: `sha256:${recordSha256(core)}`
  };
}
