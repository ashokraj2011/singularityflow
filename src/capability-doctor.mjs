import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { loadDefinition } from './config.mjs';
import { ledgerStatus } from './ledger.mjs';
import { renderCapabilityWorldModelPack, resolveLifecycleCapability } from './capability-context.mjs';
import { readRecord } from './schema-migrations.mjs';
import { run, snapshot } from './util.mjs';
import { loadPortfolio } from './initiative-config.mjs';
import { initiativeRelative } from './state-stores.mjs';

function check(id, status, summary, detail = null) { return { id, status, summary, detail }; }

export async function capabilityDoctor(root, { capabilityId = null, offline = false } = {}) {
  const checks = [];
  const recovery = [];
  let capability = null;
  try {
    capability = await resolveLifecycleCapability(root, { capabilityId, required: Boolean(capabilityId), offline });
    checks.push(capability
      ? check('binding', 'pass', `Lifecycle binds to ${capability.path.join(' → ')}.`, capability.map.sha256)
      : check('binding', 'warn', 'No unambiguous capability owns this repository.', 'Select an active capability workspace or pass --capability <id>.'));
  } catch (error) {
    checks.push(check('binding', 'fail', error.message));
  }

  const definition = await loadDefinition(root).catch(() => null);
  if (!definition) checks.push(check('workflow', 'fail', 'No singularity/workflow.yml is available.'));
  else {
    const ledger = definition.ledger;
    checks.push(ledger.enabled
      ? check('state-config', 'pass', `Governed state uses orphan branch '${ledger.branch}' with ${ledger.publication} publication.`)
      : check('state-config', 'warn', 'The governed orphan state branch is disabled.'));
    if (ledger.enabled) {
      try {
        const state = await ledgerStatus(root, ledger, { offline });
        checks.push(state.initialized
          ? check('state-branch', 'pass', `State branch '${ledger.branch}' exists; ${state.outbox} pending append(s).`)
          : check('state-branch', ledger.publication === 'required' ? 'fail' : 'warn', `State branch '${ledger.branch}' does not exist.`));
        if (state.initialized) {
          const verified = state.verification;
          checks.push(verified.valid
            ? check('ledger-chain', 'pass', `Ledger chain verifies at sequence ${verified.sequence}.`)
            : check(
              'ledger-chain',
              'fail',
              'Ledger chain verification failed.',
              `${verified.errors.join('; ')} Safe recovery preview: singularity-flow ledger repair --dry-run`
            ));
          if (!verified.valid && verified.pinDiagnostics?.some((item) => item.localStatus !== 'expected' || item.fetchStatus !== 'expected')) {
            recovery.push({
              id: 'repair-ledger-pins',
              safety: 'local-only',
              command: 'singularity-flow ledger repair --dry-run',
              description: 'Classify remote access, missing refs, mismatches, and locally recoverable source pins before changing anything.'
            });
          }
        }
      } catch (error) {
        checks.push(check('state-branch', ledger.publication === 'required' ? 'fail' : 'warn', error.message));
      }
    }
  }

  if (capability) {
    const localMap = await snapshot(path.join(root, capability.map.path));
    if (localMap.exists) {
      checks.push(localMap.sha256 === capability.map.sha256
        ? check('map-pin', 'pass', 'Capability map hash matches the lifecycle binding.')
        : check('map-pin', 'fail', 'Capability map changed after resolution.'));
    }
    const context = capability.context;
    if (!context) checks.push(check('world-model-pack', 'warn', 'No lifecycle capability world-model pack has been pinned yet.'));
    else {
      try {
        const rendered = await renderCapabilityWorldModelPack(root, capability);
        checks.push(check('world-model-pack', 'pass', `${rendered.files.length} cross-repository world-model file(s) verify.`, context.sha256));
        rendered.warnings.forEach((warning, index) => checks.push(check(`world-model-warning-${index + 1}`, 'warn', warning)));
      } catch (error) {
        checks.push(check('world-model-pack', 'fail', error.message));
      }
    }
  }

  let lifecycle = null;
  const current = run('git', ['branch', '--show-current'], { cwd: root, allowFailure: true }).stdout.trim();
  const story = definition ? path.join(root, definition.workItemRoot ?? 'singularity/work-items', current, 'workflow.json') : null;
  const portfolio = await loadPortfolio(root, { required: false }).catch(() => null);
  const initiative = path.join(
    root,
    portfolio ? initiativeRelative(portfolio, current) : path.posix.join('singularity/initiatives', current),
    'state.json'
  );
  const stateFile = story && existsSync(story) ? story : existsSync(initiative) ? initiative : null;
  if (stateFile) {
    const state = readRecord(stateFile === story ? 'story-workflow' : 'initiative-state', await readFile(stateFile)).record;
    lifecycle = state.workItem
      ? { type: 'story', id: state.workItem.id, capability: state.resolution?.capability ?? null }
      : { type: 'initiative', id: state.initiative?.id, capability: state.resolution?.capability ?? null };
    checks.push(lifecycle.capability
      ? check('lifecycle-pin', 'pass', `${lifecycle.type} ${lifecycle.id} pins capability '${lifecycle.capability.id}'.`)
      : check('lifecycle-pin', 'warn', `${lifecycle.type} ${lifecycle.id} predates capability binding.`));
  }

  const failures = checks.filter((item) => item.status === 'fail').length;
  const warnings = checks.filter((item) => item.status === 'warn').length;
  return {
    valid: failures === 0,
    capability,
    lifecycle,
    summary: { passed: checks.length - failures - warnings, warnings, failures },
    checks,
    recovery
  };
}
