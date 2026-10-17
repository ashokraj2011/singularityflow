/** Pure argv contracts: no catalog, authoring service, repository or provider lookups. */
import { SingularityFlowError } from '../util.mjs';
export const SKILL_MASTER_READS = Object.freeze(['list', 'show']);
export const SKILL_MASTER_CHANGES = Object.freeze(['create', 'edit', 'attach', 'detach', 'remove']);
const AUTHORING = ['json', 'dry-run', 'propose', 'expected-authority-kind', 'expected-authority-commit',
  'expected-authority-remote-fingerprint', 'expected-authority-source-commit'];
const RETAINED = ['work-id', 'phase', 'agent', 'generation', 'snapshot-sha256', 'expected-sha256'];
const OPTIONS = Object.freeze({
  list: ['json'], show: ['json', ...RETAINED],
  create: [...AUTHORING, 'label', 'description', 'instructions', 'from', 'loading', 'instruction-refs'],
  edit: [...AUTHORING, 'label', 'description', 'instructions', 'from', 'loading', 'instruction-refs'],
  attach: [...AUTHORING, 'agent', 'workflow', 'phases', 'use'],
  detach: [...AUTHORING, 'agent', 'workflow'],
  remove: AUTHORING
});
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function fail(message, code) { throw new SingularityFlowError(message, { code }); }

function text(options, key) {
  const value = options[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(`--${key} takes a value.`, 'SKILL_MASTER_OPTION_INVALID');
  return value;
}

export function validateSkillMasterRequest({ positionals, options }) {
  const action = positionals[1];
  if (action === 'list') {
    if (positionals.length !== 2) fail('skill list takes no skill ID.', 'SKILL_MASTER_ID_INVALID');
  } else if (positionals.length !== 3 || !ID.test(positionals[2] ?? '')) {
    fail(`skill ${action} takes one skill ID in lower-case kebab-case.`, 'SKILL_MASTER_ID_INVALID');
  }
  for (const key of Object.keys(options)) {
    if (!OPTIONS[action].includes(key)) fail(`skill ${action} does not support '--${key}'.`, 'SKILL_MASTER_OPTION_UNSUPPORTED');
  }
  for (const key of ['json', 'dry-run', 'propose']) {
    if (options[key] !== undefined && options[key] !== true) fail(`--${key} does not take a value.`, 'SKILL_MASTER_OPTION_UNSUPPORTED');
  }
  if (['attach', 'detach'].includes(action) && Boolean(text(options, 'agent')) === Boolean(text(options, 'workflow'))) fail(`skill ${action} needs exactly one --agent <AGENT> or --workflow <WORKFLOW>.`, 'SKILL_MASTER_AGENT_REQUIRED');
  if (options.loading !== undefined && !['eager', 'on-demand'].includes(text(options, 'loading'))) fail('--loading must be eager or on-demand.', 'SKILL_MASTER_OPTION_INVALID');
  if (action === 'show' && RETAINED.some(key => options[key] !== undefined)) {
    for (const key of RETAINED) if (!text(options, key)?.trim()) fail(`Retained skill retrieval requires --${key}.`, 'SKILL_MASTER_OPTION_INVALID');
    if (!/^[1-9]\d*$/u.test(options.generation) || !Number.isSafeInteger(Number(options.generation))
        || !ID.test(options.phase) || !ID.test(options.agent)
        || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(options['snapshot-sha256'])
        || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(options['expected-sha256'])) fail('Retained skill retrieval requires exact phase, agent, positive generation and SHA-256 identities.', 'SKILL_MASTER_OPTION_INVALID');
  }
  return action;
}

export { text as skillMasterOptionText };
const INSPECT_OPTIONS = new Set(['json', 'skill-id']);
const APPROVED_OPTIONS = new Set(['json', 'expected-package-sha256']);
const DOCTOR_OPTIONS = new Set(['json', 'story', 'phase', 'source']);

/**
 * SKP inspection is intentionally separate from workflow authoring. This operation reads the
 * exact selected local directory and returns inert suggestions; it never admits a phase, installs
 * a native host skill, or makes a configuration proposal.
 */
export async function validateSkillRequest({ positionals, options }) {
  const subcommand = positionals[1];
  if ([...SKILL_MASTER_READS, ...SKILL_MASTER_CHANGES].includes(subcommand)) {
    return validateSkillMasterRequest({ positionals, options });
  }
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
