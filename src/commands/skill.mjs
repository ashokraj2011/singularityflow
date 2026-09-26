import { inspectSkillPackage, skillInspectionView } from '../skp-package.mjs';
import { commandResult, effects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { SingularityFlowError } from '../util.mjs';

const INSPECT_OPTIONS = new Set(['json', 'skill-id']);
const APPROVED_OPTIONS = new Set(['json', 'expected-package-sha256']);

/**
 * SKP inspection is intentionally separate from workflow authoring. This operation reads the
 * exact selected local directory and returns inert suggestions; it never admits a phase, installs
 * a native host skill, or makes a configuration proposal.
 */
export async function run(_argv, { positionals, options }) {
  const subcommand = positionals[1];
  if (subcommand !== 'inspect' && subcommand !== 'approved') {
    throw new SingularityFlowError(
      `Unknown skill action '${subcommand ?? 'none'}'. Use 'singularity-flow skill inspect <LOCAL-DIRECTORY> --json' or 'singularity-flow skill approved <ID> --json'.`,
      { code: 'SKP_ACTION_UNKNOWN' }
    );
  }
  if (positionals.length !== 3 || typeof positionals[2] !== 'string' || !positionals[2].trim()) {
    throw new SingularityFlowError(
      subcommand === 'inspect'
        ? 'Skill inspection requires exactly one explicitly selected local directory.'
        : 'Approved skill inspection requires exactly one portable skill ID.',
      { code: 'SKP_SKILL_MISSING' }
    );
  }
  const allowed = subcommand === 'inspect' ? INSPECT_OPTIONS : APPROVED_OPTIONS;
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      throw new SingularityFlowError(
        `Skill ${subcommand} does not support '--${key}'.`,
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
  if (options['expected-package-sha256'] !== undefined
      && (typeof options['expected-package-sha256'] !== 'string'
        || !options['expected-package-sha256'].trim())) {
    throw new SingularityFlowError('--expected-package-sha256 requires one exact package digest.',
      { code: 'SKP_OPTION_UNSUPPORTED' });
  }
  if (subcommand === 'approved'
      && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(positionals[2])) {
    throw new SingularityFlowError('Skill ID must be a portable lowercase kebab-case name.',
      { code: 'SKP_ID_CASE_COLLISION' });
  }
  let capture;
  if (subcommand === 'inspect') {
    capture = await inspectSkillPackage(positionals[2], { skillId: options['skill-id'] });
  } else {
    const [{ repoRoot }, {
      inspectApprovedSkillPackage, loadStoryConfigurationSnapshot, resolveStoryConfigurationAuthority
    }] = await Promise.all([import('../git.mjs'), import('../configuration-branch.mjs')]);
    const root = repoRoot();
    const authority = await resolveStoryConfigurationAuthority(root);
    if (!authority) {
      throw new SingularityFlowError(
        'No approved configuration authority is available for this repository or workspace.',
        { code: 'SKP_APPROVED_AUTHORITY_UNAVAILABLE' }
      );
    }
    const snapshot = await loadStoryConfigurationSnapshot(authority);
    capture = await inspectApprovedSkillPackage(snapshot, positionals[2], {
      expectedPackageSha256: options['expected-package-sha256']
    });
  }
  const view = skillInspectionView(capture);
  if (subcommand === 'approved') {
    // The pure package inspector measures only its in-memory work. Authority resolution above
    // performs Git and remote reads, so its zero counters cannot describe this whole command.
    const { files, directories, bytes, fileReads, parserCalls } = view.metrics;
    view.metrics = { files, directories, bytes, fileReads, parserCalls,
      scope: 'package-inspector-only' };
  }
  return emitCommandResult(commandResult({
    operation: { id: `skill.${subcommand}`, classification: 'read' },
    subject: { kind: 'adhoc', id: view.manifest.skillId },
    outcome: succeeded(subcommand === 'inspect' ? 'skill.inspected' : 'skill.approved-inspected', {
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
