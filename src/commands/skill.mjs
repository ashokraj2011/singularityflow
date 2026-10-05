import { inspectSkillPackage, skillInspectionView } from '../skp-package.mjs';
import { commandResult, effects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { SingularityFlowError } from '../util.mjs';
import {
  runSkillMaster, SKILL_MASTER_CHANGES, SKILL_MASTER_READS, validateSkillMasterRequest
} from './skill-master.mjs';

const INSPECT_OPTIONS = new Set(['json', 'skill-id']);
const APPROVED_OPTIONS = new Set(['json', 'expected-package-sha256']);
const DOCTOR_OPTIONS = new Set(['json', 'story', 'phase', 'source']);

/**
 * SKP inspection is intentionally separate from workflow authoring. This operation reads the
 * exact selected local directory and returns inert suggestions; it never admits a phase, installs
 * a native host skill, or makes a configuration proposal.
 */
export function validateSkillRequest({ positionals, options }) {
  const subcommand = positionals[1];
  // The skill master: named skills any agent can attach.
  if ([...SKILL_MASTER_READS, ...SKILL_MASTER_CHANGES].includes(subcommand)) return validateSkillMasterRequest({ positionals, options });
  if (!['inspect', 'approved', 'doctor'].includes(subcommand)) {
    throw new SingularityFlowError(
      `Unknown skill action '${subcommand ?? 'none'}'. The skill master: 'singularity-flow skill list|show|create|edit|attach|detach|remove'. Skill packages: 'singularity-flow skill inspect <LOCAL-DIRECTORY> --json', 'singularity-flow skill approved <ID> --json', or 'singularity-flow skill doctor <ID> --story <WORK-ID> --phase <PHASE-ID> --json'.`,
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
  const allowed = subcommand === 'inspect' ? INSPECT_OPTIONS
    : subcommand === 'doctor' ? DOCTOR_OPTIONS : APPROVED_OPTIONS;
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
  if (subcommand !== 'inspect'
      && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(positionals[2])) {
    throw new SingularityFlowError('Skill ID must be a portable lowercase kebab-case name.',
      { code: 'SKP_ID_CASE_COLLISION' });
  }
  if (subcommand === 'doctor') {
    for (const key of ['story', 'phase', 'source']) {
      if ((key !== 'source' || options[key] !== undefined)
          && (typeof options[key] !== 'string' || !options[key].trim())) {
        throw new SingularityFlowError(`Skill doctor requires an explicit --${key} value.`,
          { code: 'SKP_OPTION_UNSUPPORTED' });
      }
    }
  }
  return subcommand;
}

export async function run(argv, { positionals, options, applyChangeSet, printResult }) {
  // A skill master edit is applied through the configuration authority (a reviewed proposal or a
  // local edit), which the CLI monolith owns; it calls back here with that path.
  if (SKILL_MASTER_CHANGES.includes(positionals[1]) && !applyChangeSet) return (await import('./legacy.mjs')).run(argv);
  if ([...SKILL_MASTER_READS, ...SKILL_MASTER_CHANGES].includes(positionals[1])) {
    return runSkillMaster({ positionals, options, applyChangeSet, printResult });
  }
  const subcommand = validateSkillRequest({ positionals, options });
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
      : await inspectSkillPackage(options.source, { skillId: positionals[2] });
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
