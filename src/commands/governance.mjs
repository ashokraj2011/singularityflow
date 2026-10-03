/**
 * `singularity-flow governance`: rebuild this repository's governance onto the current model, or
 * restore it from a rebuild [E2G §11]. Every change is plan-first: `rebuild --dry-run` prints the
 * plan digest a confirmation must name, and `restore` previews before it changes anything.
 */
import { identity, repoRoot } from '../git.mjs';
import { activateGovernanceRebuild, planGovernanceRebuild, restoreGovernanceRebuild } from '../governance-rebuild.mjs';
import { action, because, commandResult, effects, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

const SUBCOMMANDS = Object.freeze(['rebuild', 'restore']);
const PREVIEW = 'singularity-flow governance rebuild --dry-run';

/** The confirmation a plan needs: its digest, and every failing repository workflow it will leave unstartable. */
export function rebuildConfirmationCommand(plan) {
  const inactive = plan.inactive.length ? ` --accept-inactive ${plan.inactive.join(',')}` : '';
  return `singularity-flow governance rebuild --confirm-plan ${plan.plan}${inactive}`;
}

function json(options) {
  return { json: optionBoolean(options, 'json'), restStateWhenIdle: null };
}

async function rebuildPreview(root, options) {
  const plan = await planGovernanceRebuild(root, { remote: optionString(options, 'remote', 'origin') });
  return emitCommandResult(commandResult({
    operation: { id: 'governance.rebuild.preview', classification: 'read' },
    subject: { kind: 'repository', id: plan.configuration.commit.slice(0, 12) },
    outcome: succeeded(plan.ready ? 'governance.rebuild-planned' : 'governance.rebuild-blocked', {
      replaced: plan.replaced.length, stories: plan.storyDetails.length, blockers: plan.blockers.length, plan: plan.plan
    }),
    effects: noEffects(),
    why: [because('governance.from-approved-configuration', 'evidence', {
      slots: { mode: plan.configuration.mode, commit: plan.configuration.commit.slice(0, 12) }, topic: 'governance-rebuild'
    })],
    next: plan.ready ? [action({
      id: 'governance-rebuild-confirm',
      label: plan.inactive.length
        ? `Review the plan, then confirm it; ${plan.inactive.join(', ')} will stay byte-identical and unstartable until repaired.`
        : 'Review the plan, then confirm exactly this plan.',
      command: rebuildConfirmationCommand(plan),
      skill: '/sf-governance-rebuild',
      kind: 'review'
    })] : [],
    restState: 'informational',
    data: { plan }
  }), json(options));
}

async function rebuildActivate(root, options) {
  const confirmation = optionString(options, 'confirm-plan');
  if (!confirmation) {
    throw new SingularityFlowError(`Preview the rebuild first: ${PREVIEW}. Then confirm the exact plan with --confirm-plan grb-...`, {
      code: 'GOVERNANCE_REBUILD_CONFIRMATION_REQUIRED', exitCode: 2
    });
  }
  const who = identity(root);
  const result = await activateGovernanceRebuild(root, {
    confirmation,
    acceptInactive: String(optionString(options, 'accept-inactive', '') ?? '').split(',').map((entry) => entry.trim()).filter(Boolean),
    strict: optionBoolean(options, 'strict'),
    remote: optionString(options, 'remote', 'origin'),
    actor: { name: who?.name ?? null, email: who?.email ?? null }
  });
  return emitCommandResult(commandResult({
    operation: { id: 'governance.rebuild', classification: 'mutation' },
    subject: { kind: 'repository', id: result.commit.slice(0, 12) },
    outcome: succeeded('governance.rebuild-activated', {
      plan: result.plan.plan, commit: result.commit.slice(0, 12), branch: result.branch, archived: result.archived
    }),
    effects: effects({ stateChanged: true, filesChanged: true }),
    why: [because('governance.rebuild-invariants', 'evidence', { slots: { receipt: result.receiptPath } })],
    next: [action({
      id: 'governance-rebuild-review',
      label: 'Preview again: a completed rebuild has nothing left to replace or archive.',
      command: PREVIEW, skill: '/sf-governance-rebuild', kind: 'review'
    })],
    restState: 'complete',
    data: {
      plan: result.plan.plan, commit: result.commit, branch: result.branch, receipt: result.receiptPath,
      archived: result.archived, backup: { directory: result.backup.directory, manifestSha256: result.backup.manifestSha256 },
      invariants: result.invariants
    }
  }), json(options));
}

async function restore(root, options) {
  const plan = optionString(options, 'plan');
  const confirm = optionBoolean(options, 'dry-run') ? null : optionString(options, 'confirm');
  const result = await restoreGovernanceRebuild(root, { plan, confirm });
  if (!result.restored) {
    return emitCommandResult(commandResult({
      operation: { id: 'governance.restore.preview', classification: 'read' },
      subject: { kind: 'repository', id: result.preview.commit.slice(0, 12) },
      outcome: succeeded('governance.restore-previewed', { plan: result.preview.plan, files: result.preview.restores.length }),
      effects: noEffects(),
      next: result.preview.dirty.length ? [] : [action({
        id: 'governance-restore-confirm', label: 'Restore every file the rebuild changed, as one new commit.',
        command: `singularity-flow governance restore --plan ${result.preview.plan} --confirm ${result.preview.plan}`,
        skill: '/sf-governance-rebuild', kind: 'review'
      })],
      restState: 'informational',
      data: { restore: result.preview }
    }), json(options));
  }
  return emitCommandResult(commandResult({
    operation: { id: 'governance.restore', classification: 'mutation' },
    subject: { kind: 'repository', id: result.restored.slice(0, 12) },
    outcome: succeeded('governance.restore-completed', { plan: result.preview.plan, commit: result.restored.slice(0, 12), files: result.preview.restores.length }),
    effects: effects({ stateChanged: true, filesChanged: true }),
    restState: 'complete',
    data: { restore: result.preview, commit: result.restored }
  }), json(options));
}

export async function run(_argv, { positionals, options }) {
  const subcommand = positionals[1];
  if (!SUBCOMMANDS.includes(subcommand)) {
    throw new SingularityFlowError(`Unknown governance action '${subcommand ?? ''}'. Use: ${PREVIEW}`, {
      code: 'GOVERNANCE_ACTION_UNKNOWN'
    });
  }
  const root = repoRoot();
  if (subcommand === 'restore') return restore(root, options);
  return optionBoolean(options, 'dry-run') ? rebuildPreview(root, options) : rebuildActivate(root, options);
}
