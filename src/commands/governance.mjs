/**
 * `singularity-flow governance`: rebuild this repository's governance onto the current model
 * [E2G §11]. `rebuild --dry-run` previews the exact plan and changes nothing; the plan digest it
 * prints is what a later confirmation must name.
 */
import { repoRoot } from '../git.mjs';
import { planGovernanceRebuild } from '../governance-rebuild.mjs';
import { action, because, commandResult, noEffects, refused, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult, withCommandResult } from '../narration/emit.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

const SUBCOMMANDS = Object.freeze(['rebuild']);

/** The confirmation a plan needs: its digest, and every failing repository workflow it will leave unstartable. */
export function rebuildConfirmationCommand(plan) {
  const inactive = plan.inactive.length ? ` --accept-inactive ${plan.inactive.join(',')}` : '';
  return `singularity-flow governance rebuild --confirm-plan ${plan.plan}${inactive}`;
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
  }), { json: optionBoolean(options, 'json'), restStateWhenIdle: null });
}

export async function run(_argv, { positionals, options }) {
  const subcommand = positionals[1];
  if (!SUBCOMMANDS.includes(subcommand)) {
    throw new SingularityFlowError(`Unknown governance action '${subcommand ?? ''}'. Use: singularity-flow governance rebuild --dry-run`, {
      code: 'GOVERNANCE_ACTION_UNKNOWN'
    });
  }
  const root = repoRoot();
  if (optionBoolean(options, 'dry-run')) return rebuildPreview(root, options);
  // Activation (backup, rebuild, archive and receipt) is not in this build yet; say so plainly
  // rather than accept a confirmation it cannot honour.
  const error = new SingularityFlowError(
    'This build previews the governance rebuild but cannot activate it yet. Run singularity-flow governance rebuild --dry-run to review the plan.',
    { code: 'GOVERNANCE_REBUILD_ACTIVATION_UNAVAILABLE', exitCode: 2 }
  );
  throw withCommandResult(error, commandResult({
    operation: { id: 'governance.rebuild', classification: 'mutation' },
    outcome: refused('governance.rebuild-activation-unavailable', {}),
    effects: noEffects(),
    next: [action({
      id: 'governance-rebuild-preview', label: 'Preview the rebuild plan.',
      command: 'singularity-flow governance rebuild --dry-run', skill: '/sf-governance-rebuild', kind: 'review'
    })],
    restState: 'informational'
  }));
}
