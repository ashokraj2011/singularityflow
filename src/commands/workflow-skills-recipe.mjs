import { withApprovedConfigurationRead } from '../approved-configuration-reader.mjs';
import { loadDefinition } from '../config.mjs';
import { previewSkillWorkflowRecipe } from '../skp-workflow-recipe.mjs';
import { recordSha256 } from '../records.mjs';
import { safeCommandGuidance } from '../safe-command-guidance.mjs';
import { action, commandResult, effects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { SingularityFlowError } from '../util.mjs';

const OPTIONS = new Set(['json', 'label', 'description', 'phases', 'planned-claims',
  'clause-phases', 'claim-owners']);
const list = (value) => value === undefined ? [] : value.split(',').map((item) => item.trim()).filter(Boolean);

/** A recipe is a read-only candidate, not shared-draft confirmation or execution admission. */
export async function run(root, positionals, options) {
  if (positionals.length !== 3) throw new SingularityFlowError(
    'Choose exactly one new workflow ID for the skills recipe.', { code: 'SKP_RECIPE_INVALID' });
  for (const key of Object.keys(options)) {
    if (!OPTIONS.has(key) || (key === 'json' ? options[key] !== true : typeof options[key] !== 'string')) {
      throw new SingularityFlowError(`Unsupported skills recipe option '--${key}'.`,
        { code: 'SKP_OPTION_UNSUPPORTED' });
    }
  }
  let plannedClaims;
  if (options['planned-claims'] !== undefined || options['clause-phases'] !== undefined
      || options['claim-owners'] !== undefined) {
    if (options['planned-claims'] !== 'required') throw new SingularityFlowError(
      'Code recipes require explicit --planned-claims required; no implicit opt-out is supported.',
      { code: 'SKP_CLAIM_TOPOLOGY_UNRESOLVED' });
    const owners = {};
    for (const entry of list(options['claim-owners'])) {
      const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)=([a-z0-9]+(?:-[a-z0-9]+)*)$/u.exec(entry);
      if (!match || Object.hasOwn(owners, match[1])) throw new SingularityFlowError(
        'Claim owners must be unique code-phase=planning-phase pairs.',
        { code: 'SKP_CLAIM_TOPOLOGY_UNRESOLVED' });
      owners[match[1]] = match[2];
    }
    plannedClaims = { mode: 'required', clausePhases: list(options['clause-phases']), owners };
  }
  const result = await withApprovedConfigurationRead(root, async (authority) => {
    if (!/^[a-f0-9]{40,64}$/u.test(authority?.commit ?? '')) throw new SingularityFlowError(
      'Skill recipes require an exact approved configuration revision, not mutable checkout policy.',
      { code: 'SKP_APPROVED_AUTHORITY_UNAVAILABLE' });
    const preview = previewSkillWorkflowRecipe({ definition: await loadDefinition(root),
      workflow: { id: positionals[2], label: options.label, description: options.description,
        ...(plannedClaims ? { plannedClaims } : {}) }, phases: list(options.phases) });
    const { candidateDefinition, ...view } = preview;
    view.source = { kind: authority.kind, commit: authority.commit };
    view.planSha256 = `sha256:${recordSha256({ previewSha256: preview.planSha256, source: view.source })}`;
    return view;
  }, { preferAuthority: true });
  const argv = ['workflow', 'create', result.workflow.id, '--label', result.workflow.label,
    '--governs', 'story', '--phases', result.sequence.map((phase) => phase.id).join(',')];
  if (result.workflow.description) argv.push('--description', result.workflow.description);
  if (plannedClaims) argv.push('--planned-claims', 'required', '--clause-phases',
    plannedClaims.clausePhases.join(','), '--claim-owners',
    Object.entries(plannedClaims.owners).map(([code, owner]) => `${code}=${owner}`).join(','));
  argv.push('--propose', '--json');
  const guidance = safeCommandGuidance({ executable: 'singularity-flow', argv });
  return emitCommandResult(commandResult({
    operation: { id: 'workflow.skills-recipe', classification: 'read' },
    subject: { kind: 'adhoc', id: result.workflow.id },
    outcome: succeeded('skill.recipe-previewed', { workflowId: result.workflow.id }),
    effects: effects(), next: guidance ? [action({ id: 'skill.recipe-propose',
      label: 'Review the candidate before requesting a separate configuration proposal; execution remains unavailable.',
      command: guidance.command, kind: 'review' })] : [],
    restState: 'informational', data: { recipe: result }
  }), { json: Boolean(options.json), restStateWhenIdle: 'informational' });
}
