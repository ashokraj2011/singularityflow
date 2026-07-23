import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { SingularityFlowError, posix, snapshot } from './util.mjs';

export const PORTFOLIO_PATH = 'singularity/portfolio.yml';
export const INITIATIVE_REQUIREMENTS = new Set(['must', 'optional', 'conditional']);
export const INITIATIVE_GATES = new Set(['off', 'warn', 'block']);
export const INITIATIVE_APPROVAL_MODES = new Set(['individual', 'bundle', 'none']);
export const EVIDENCE_ASSURANCE = new Set(['machine-verified', 'system-verified', 'human-approved', 'presence-only']);
export const INITIATIVE_OUTPUT_KINDS = new Set(['markdown', 'yaml', 'binary-bundle', 'interface-contract']);

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError(`${label} must be an object.`);
  return value;
}

function safeId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new SingularityFlowError(`${label} must be a safe identifier containing letters, numbers, dots, underscores, or hyphens.`);
  }
  return value;
}

function safeRelative(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new SingularityFlowError(`${label} is required.`);
  const normalized = posix(value.trim()).replace(/^\.\/+/, '');
  if (path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) throw new SingularityFlowError(`${label} must remain inside the repository.`);
  return normalized;
}

function array(value, label) {
  if (!Array.isArray(value)) throw new SingularityFlowError(`${label} must be an array.`);
  return value;
}

function unique(values, label) {
  if (new Set(values).size !== values.length) throw new SingularityFlowError(`${label} contains duplicates.`);
}

function duration(value, label) {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^[1-9]\d*(m|h|d|w)$/.test(value)) throw new SingularityFlowError(`${label} must use a positive duration such as 30m, 24h, 90d, or 4w.`);
  return value;
}

function normalizedApproval(value = {}, label) {
  object(value, label);
  const mode = value.mode ?? 'bundle';
  if (!INITIATIVE_APPROVAL_MODES.has(mode)) throw new SingularityFlowError(`${label}.mode must be individual, bundle, or none.`);
  const authorities = [...(value.authorities ?? [])];
  authorities.forEach((id) => safeId(id, `${label}.authorities entry`));
  unique(authorities, `${label}.authorities`);
  const minimum = value.minimum ?? (mode === 'none' ? 0 : 1);
  if (!Number.isInteger(minimum) || minimum < 0) throw new SingularityFlowError(`${label}.minimum must be a non-negative integer.`);
  if (mode !== 'none' && minimum < 1) throw new SingularityFlowError(`${label}.minimum must be at least 1 when approval is required.`);
  return { mode, authorities, minimum, allowSelfApproval: value.allowSelfApproval !== false };
}

function normalizedFreshness(value = {}, label) {
  object(value, label);
  const validFor = duration(value.validFor, `${label}.validFor`);
  const revalidateAt = [...(value.revalidateAt ?? [])];
  revalidateAt.forEach((id) => safeId(id, `${label}.revalidateAt entry`));
  unique(revalidateAt, `${label}.revalidateAt`);
  return { validFor, revalidateAt };
}

function normalizeOutput(output, phaseId, index) {
  object(output, `Phase '${phaseId}' output ${index + 1}`);
  const id = safeId(output.id, `Phase '${phaseId}' output ID`);
  const kind = output.kind ?? 'markdown';
  if (!INITIATIVE_OUTPUT_KINDS.has(kind)) throw new SingularityFlowError(`Phase '${phaseId}' output '${id}' has unsupported kind '${kind}'.`);
  const relativePath = safeRelative(output.path ?? `${id}.${kind === 'yaml' ? 'yml' : 'md'}`, `Phase '${phaseId}' output '${id}' path`);
  const template = output.template ? safeRelative(output.template, `Phase '${phaseId}' output '${id}' template`) : null;
  if (['markdown', 'yaml', 'interface-contract'].includes(kind) && !template) throw new SingularityFlowError(`Phase '${phaseId}' output '${id}' requires a template.`);
  const consumes = [...(output.consumes ?? [])];
  consumes.forEach((reference) => {
    if (typeof reference !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(reference)) {
      throw new SingularityFlowError(`Phase '${phaseId}' output '${id}' has invalid consumes reference '${reference}'. Use phase/output.`);
    }
  });
  unique(consumes, `Phase '${phaseId}' output '${id}' consumes`);
  return {
    id,
    label: output.label ?? id.replaceAll('-', ' '),
    kind,
    path: relativePath,
    template,
    consumes,
    required: output.required !== false,
    approval: normalizedApproval(output.approval ?? {}, `Phase '${phaseId}' output '${id}' approval`)
  };
}

function normalizeCheck(check, phaseId, index) {
  object(check, `Phase '${phaseId}' checklist item ${index + 1}`);
  const id = safeId(check.id, `Phase '${phaseId}' checklist ID`);
  const requirement = check.requirement ?? 'must';
  if (!INITIATIVE_REQUIREMENTS.has(requirement)) throw new SingularityFlowError(`Checklist '${phaseId}/${id}' requirement must be must, optional, or conditional.`);
  if (requirement === 'conditional' && !check.applicability?.policy) throw new SingularityFlowError(`Conditional checklist '${phaseId}/${id}' requires applicability.policy.`);
  const acceptedAssurance = [...(check.acceptedAssurance ?? (requirement === 'optional' ? ['presence-only', 'human-approved', 'system-verified', 'machine-verified'] : ['human-approved', 'system-verified', 'machine-verified']))];
  acceptedAssurance.forEach((item) => {
    if (!EVIDENCE_ASSURANCE.has(item)) throw new SingularityFlowError(`Checklist '${phaseId}/${id}' has unsupported assurance '${item}'.`);
  });
  unique(acceptedAssurance, `Checklist '${phaseId}/${id}' acceptedAssurance`);
  const gate = check.gate ?? (requirement === 'optional' ? 'warn' : 'block');
  if (!INITIATIVE_GATES.has(gate)) throw new SingularityFlowError(`Checklist '${phaseId}/${id}' gate must be off, warn, or block.`);
  return {
    id,
    label: check.label ?? id.replaceAll('-', ' '),
    requirement,
    applicability: requirement === 'conditional' ? { policy: safeId(check.applicability.policy, `Checklist '${phaseId}/${id}' applicability policy`) } : null,
    acceptedAssurance,
    freshness: normalizedFreshness(check.freshness ?? {}, `Checklist '${phaseId}/${id}' freshness`),
    gate,
    approval: normalizedApproval(check.approval ?? { mode: 'bundle' }, `Checklist '${phaseId}/${id}' approval`)
  };
}

function normalizePhase(phase, id) {
  object(phase, `Initiative phase '${id}'`);
  const outputs = array(phase.outputs ?? [], `Initiative phase '${id}' outputs`).map((output, index) => normalizeOutput(output, id, index));
  const checklist = array(phase.checklist ?? [], `Initiative phase '${id}' checklist`).map((check, index) => normalizeCheck(check, id, index));
  unique(outputs.map((output) => output.id), `Initiative phase '${id}' output IDs`);
  unique(checklist.map((check) => check.id), `Initiative phase '${id}' checklist IDs`);
  return {
    id,
    label: phase.label ?? id.replaceAll('-', ' '),
    lanes: [...(phase.lanes ?? [])],
    worldModelViews: [...(phase.worldModelViews ?? [])],
    outputs,
    checklist,
    bundleApproval: normalizedApproval(phase.bundleApproval ?? {}, `Initiative phase '${id}' bundle approval`)
  };
}

export function validatePortfolio(value) {
  const portfolio = object(value, 'Portfolio configuration');
  if (portfolio.version !== 1) throw new SingularityFlowError('Portfolio configuration version must be 1.');
  portfolio.initiativeRoot = safeRelative(portfolio.initiativeRoot ?? 'singularity/initiatives', 'initiativeRoot');
  portfolio.templatesRoot = safeRelative(portfolio.templatesRoot ?? 'singularity/templates', 'templatesRoot');
  portfolio.repositories = object(portfolio.repositories ?? {}, 'repositories');
  portfolio.approvalAuthorities = object(portfolio.approvalAuthorities ?? {}, 'approvalAuthorities');
  portfolio.initiativeProfiles = object(portfolio.initiativeProfiles ?? {}, 'initiativeProfiles');
  portfolio.initiativePhases = object(portfolio.initiativePhases ?? {}, 'initiativePhases');

  for (const [id, repository] of Object.entries(portfolio.repositories)) {
    safeId(id, 'Repository ID'); object(repository, `Repository '${id}'`);
    if (typeof repository.url !== 'string' || !repository.url.trim()) throw new SingularityFlowError(`Repository '${id}' requires url.`);
    repository.defaultBranch ??= 'main';
    if (typeof repository.defaultBranch !== 'string' || !repository.defaultBranch.trim()) throw new SingularityFlowError(`Repository '${id}' defaultBranch is invalid.`);
    repository.required = repository.required !== false;
  }

  for (const [id, authority] of Object.entries(portfolio.approvalAuthorities)) {
    safeId(id, 'Approval authority ID'); object(authority, `Approval authority '${id}'`);
    authority.members = array(authority.members ?? [], `Approval authority '${id}' members`).map((member, index) => {
      object(member, `Approval authority '${id}' member ${index + 1}`);
      if (typeof member.email !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(member.email)) throw new SingularityFlowError(`Approval authority '${id}' member ${index + 1} requires a valid email.`);
      return { name: member.name ?? member.email, email: member.email.trim().toLowerCase() };
    });
    unique(authority.members.map((member) => member.email), `Approval authority '${id}' member emails`);
  }

  const normalizedPhases = {};
  for (const [id, phase] of Object.entries(portfolio.initiativePhases)) {
    safeId(id, 'Initiative phase ID');
    normalizedPhases[id] = normalizePhase(phase, id);
  }
  portfolio.initiativePhases = normalizedPhases;

  for (const [id, profile] of Object.entries(portfolio.initiativeProfiles)) {
    safeId(id, 'Initiative profile ID'); object(profile, `Initiative profile '${id}'`);
    profile.phases = array(profile.phases, `Initiative profile '${id}' phases`);
    if (!profile.phases.length) throw new SingularityFlowError(`Initiative profile '${id}' must contain at least one phase.`);
    unique(profile.phases, `Initiative profile '${id}' phases`);
    profile.phases.forEach((phaseId) => {
      if (!portfolio.initiativePhases[phaseId]) throw new SingularityFlowError(`Initiative profile '${id}' references unknown phase '${phaseId}'.`);
    });
    profile.label ??= id.replaceAll('-', ' ');

    const position = new Map(profile.phases.map((phaseId, index) => [phaseId, index]));
    for (const phaseId of profile.phases) {
      const phase = portfolio.initiativePhases[phaseId];
      const approvals = [phase.bundleApproval, ...phase.outputs.map((output) => output.approval), ...phase.checklist.map((check) => check.approval)];
      for (const approval of approvals) {
        for (const authority of approval.authorities) {
          if (!portfolio.approvalAuthorities[authority]) throw new SingularityFlowError(`Initiative profile '${id}' phase '${phaseId}' references unknown approval authority '${authority}'.`);
        }
      }
      for (const output of phase.outputs) {
        for (const reference of output.consumes) {
          const [producerPhase, producerOutput] = reference.split('/');
          if (!position.has(producerPhase)) throw new SingularityFlowError(`Initiative profile '${id}' output '${phaseId}/${output.id}' consumes inactive phase '${producerPhase}'.`);
          if (position.get(producerPhase) >= position.get(phaseId)) throw new SingularityFlowError(`Initiative profile '${id}' output '${phaseId}/${output.id}' must consume an earlier phase output.`);
          if (!portfolio.initiativePhases[producerPhase].outputs.some((candidate) => candidate.id === producerOutput)) throw new SingularityFlowError(`Initiative profile '${id}' output '${phaseId}/${output.id}' references unknown output '${reference}'.`);
        }
      }
      for (const check of phase.checklist) {
        for (const revalidatePhase of check.freshness.revalidateAt) if (!position.has(revalidatePhase)) throw new SingularityFlowError(`Checklist '${phaseId}/${check.id}' revalidates at inactive phase '${revalidatePhase}'.`);
      }
    }
  }
  return portfolio;
}

export async function loadPortfolio(root, { required = true } = {}) {
  const file = path.join(root, PORTFOLIO_PATH);
  if (!existsSync(file)) {
    if (!required) return null;
    throw new SingularityFlowError(`No ${PORTFOLIO_PATH} exists. Run singularity-flow init or add the portfolio configuration.`);
  }
  let parsed;
  try { parsed = YAML.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new SingularityFlowError(`Unable to parse ${PORTFOLIO_PATH}: ${error.message}`); }
  return validatePortfolio(parsed);
}

export function validatePortfolioWorldModelViews(portfolio, workflowDefinition) {
  const declared = new Set(workflowDefinition.worldModel?.views ?? []);
  const unknown = [];
  for (const [phaseId, phase] of Object.entries(portfolio.initiativePhases ?? {})) {
    for (const view of phase.worldModelViews ?? []) if (!declared.has(view)) unknown.push(`${phaseId}:${view}`);
  }
  if (unknown.length) throw new SingularityFlowError(`Initiative phases reference undeclared repository world-model views: ${unknown.join(', ')}.`);
  return true;
}

export function resolveInitiativeProfile(portfolio, profileId) {
  const profile = portfolio.initiativeProfiles[profileId];
  if (!profile) throw new SingularityFlowError(`Unknown initiative profile '${profileId}'.`);
  return {
    id: profileId,
    label: profile.label,
    phases: profile.phases.map((id, order) => ({ ...structuredClone(portfolio.initiativePhases[id]), order })),
    repositories: structuredClone(portfolio.repositories),
    approvalAuthorities: structuredClone(portfolio.approvalAuthorities)
  };
}

export async function snapshotInitiativeResolution(root, portfolio, resolved) {
  const portfolioSnapshot = await snapshot(path.join(root, PORTFOLIO_PATH));
  const templates = {};
  for (const phase of resolved.phases) {
    for (const output of phase.outputs) {
      if (!output.template) continue;
      const absolute = path.join(root, portfolio.templatesRoot, output.template);
      if (!existsSync(absolute)) throw new SingularityFlowError(`Initiative template missing for '${phase.id}/${output.id}': ${posix(path.relative(root, absolute))}`);
      templates[`${phase.id}/${output.id}`] = { path: posix(path.relative(root, absolute)), ...(await snapshot(absolute)) };
    }
  }
  const canonical = JSON.stringify({
    profile: resolved.id,
    phases: resolved.phases,
    repositories: resolved.repositories,
    approvalAuthorities: resolved.approvalAuthorities,
    templates
  });
  return {
    profile: resolved.id,
    profileLabel: resolved.label,
    portfolioSha256: portfolioSnapshot.sha256,
    resolutionSha256: createHash('sha256').update(canonical).digest('hex'),
    templates,
    phases: structuredClone(resolved.phases),
    repositories: structuredClone(resolved.repositories),
    approvalAuthorities: structuredClone(resolved.approvalAuthorities)
  };
}
