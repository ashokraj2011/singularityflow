import { commandResult, effects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { SingularityFlowError } from '../util.mjs';

/** The skill master's actions: named skills any agent can attach. Its service loads only for them. */
import { SKILL_MASTER_READS, SKILL_MASTER_CHANGES, validateSkillRequest } from './skill-request.mjs';
export { SKILL_MASTER_READS, SKILL_MASTER_CHANGES, validateSkillRequest } from './skill-request.mjs';
const skillMaster = () => import('./skill-master.mjs');

export async function run(argv, { positionals, options, applyChangeSet, printResult }) {
  // A skill master edit is applied through the configuration authority (a reviewed proposal or a
  // local edit), which the CLI monolith owns; it calls back here with that path.
  if (SKILL_MASTER_CHANGES.includes(positionals[1]) && !applyChangeSet) return (await import('./legacy.mjs')).run(argv);
  if ([...SKILL_MASTER_READS, ...SKILL_MASTER_CHANGES].includes(positionals[1])) {
    return (await skillMaster()).runSkillMaster({ positionals, options, applyChangeSet, printResult });
  }
  const subcommand = await validateSkillRequest({ positionals, options });
  if (subcommand === 'doctor') {
    const [{ repoRoot }, { loadConfig, resolveWorkItem }, { resolveStorySkillPackage },
      { withApprovedConfigurationRead }, { diagnoseRetainedSkillPackage }] = await Promise.all([
      import('../git.mjs'), import('../state.mjs'), import('../story-execution-context.mjs'),
      import('../approved-configuration-reader.mjs'), import('../skp-doctor.mjs')
    ]);
    const root = repoRoot();
    const retained = await withApprovedConfigurationRead(root, async () => {
      const config = await loadConfig(root);
      const selected = await resolveWorkItem(root, config, options.story);
      if (!selected.workflow) throw new SingularityFlowError(
        'Skill diagnostics require a readable retained Story, not a ledger-only reference.',
        { code: 'WFA_DEPENDENCY_UNAVAILABLE' });
      return resolveStorySkillPackage(root, config, selected.workflow, { phaseId: options.phase });
    });
    if (!retained || retained.skillId !== positionals[2]) {
      throw new SingularityFlowError('The selected Story phase does not retain the selected skill ID.',
        { code: 'SKP_SKILL_MISSING' });
    }
    const source = options.source === undefined ? null
      : await import('../skp-package.mjs').then(({ inspectSkillPackage }) =>
        inspectSkillPackage(options.source, { skillId: positionals[2] }));
    const diagnostic = diagnoseRetainedSkillPackage(retained, { source });
    // Only the accepted Story owner above proves provenance. The pure byte diagnostic does not.
    diagnostic.provenance = { status: 'verified-story-snapshot' };
    return emitCommandResult(commandResult({
      operation: { id: 'skill.doctor', classification: 'read' },
      subject: { kind: 'story', id: options.story },
      outcome: succeeded('skill.diagnosed', { skillId: diagnostic.skillId,
        sourceStatus: diagnostic.source.status }),
      effects: effects(), restState: 'informational', data: { diagnostic }
    }), { json: Boolean(options.json), restStateWhenIdle: 'informational' });
  }
  let capture;
  const { inspectSkillPackage, skillInspectionView } = await import('../skp-package.mjs');
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
