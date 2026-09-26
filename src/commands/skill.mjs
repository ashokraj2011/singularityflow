import { inspectSkillPackage, skillInspectionView } from '../skp-package.mjs';
import { commandResult, effects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { SingularityFlowError } from '../util.mjs';

const INSPECT_OPTIONS = new Set(['json', 'skill-id']);

/**
 * SKP inspection is intentionally separate from workflow authoring. This operation reads the
 * exact selected local directory and returns inert suggestions; it never admits a phase, installs
 * a native host skill, or makes a configuration proposal.
 */
export async function run(_argv, { positionals, options }) {
  const subcommand = positionals[1];
  if (subcommand !== 'inspect') {
    throw new SingularityFlowError(
      `Unknown skill action '${subcommand ?? 'none'}'. Use 'singularity-flow skill inspect <LOCAL-DIRECTORY> --json'.`,
      { code: 'SKP_ACTION_UNKNOWN' }
    );
  }
  if (positionals.length !== 3 || typeof positionals[2] !== 'string' || !positionals[2].trim()) {
    throw new SingularityFlowError(
      'Skill inspection requires exactly one explicitly selected local directory.',
      { code: 'SKP_SKILL_MISSING' }
    );
  }
  for (const key of Object.keys(options)) {
    if (!INSPECT_OPTIONS.has(key)) {
      throw new SingularityFlowError(
        `Skill inspection does not support '--${key}'; no model, confirmation, import, or remote lookup was attempted.`,
        { code: 'SKP_OPTION_UNSUPPORTED' }
      );
    }
  }
  if (options.json !== undefined && options.json !== true) {
    throw new SingularityFlowError('--json does not take a value for skill inspection.',
      { code: 'SKP_OPTION_UNSUPPORTED' });
  }
  if (options['skill-id'] !== undefined
      && (typeof options['skill-id'] !== 'string' || !options['skill-id'].trim())) {
    throw new SingularityFlowError('--skill-id requires one explicit portable skill ID.',
      { code: 'SKP_OPTION_UNSUPPORTED' });
  }
  const capture = await inspectSkillPackage(positionals[2], {
    skillId: options['skill-id']
  });
  const view = skillInspectionView(capture);
  return emitCommandResult(commandResult({
    operation: { id: 'skill.inspect', classification: 'read' },
    subject: { kind: 'adhoc', id: view.manifest.skillId },
    outcome: succeeded('skill.inspected', {
      skillId: view.manifest.skillId,
      packageSha256: view.manifest.packageSha256,
      files: view.metrics.files,
      bytes: view.metrics.bytes,
      proposedFields: view.proposals.length,
      findings: view.findings.length
    }),
    effects: effects(),
    restState: 'informational',
    data: { inspection: view }
  }), { json: Boolean(options.json), restStateWhenIdle: 'informational' });
}
