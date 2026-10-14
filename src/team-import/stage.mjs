/**
 * Lay a validated candidate out as a configuration tree, so the engine's own loaders, validators
 * and bundle compiler read it exactly as they read a repository. [TAWI-REQ-020, -027]
 *
 * The tree starts from a freshly initialized configuration, the baseline every destination
 * shares, and adds only the candidate's namespaced workflow, phases, authorities, agents, skills,
 * instructions, templates and attachments. It lives in the session directory, is rebuilt on every
 * compile, is never a Git repository, and fabricates no approval or provenance.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { discoverAgents } from '../agents.mjs';
import { initializeDefinition } from '../config.mjs';
import { SKILL_ATTACHMENTS_PATH } from '../skill-library.mjs';

const WORKFLOW_FILE = 'singularity/workflow.yml';

function frontMatter(fields) {
  return `---\n${YAML.stringify(fields, { lineWidth: 0 }).trimEnd()}\n---\n\n`;
}

const csv = (values) => (values.length ? [...new Set(values)].join(', ') : '-');

/** The workflow.yml phase a candidate phase becomes. */
function phaseDefinition(phase) {
  const definition = {
    label: phase.label,
    defaultTemplate: phase.template,
    artifact: { path: phase.artifact.path, kind: phase.artifact.kind },
    writeScope: phase.writeScope
  };
  if (phase.inputs?.length) definition.inputs = [...phase.inputs];
  if (phase.code === true) definition.generation = { task: 'code' };
  if (phase.qualityCommands?.length) definition.qualityCommands = phase.qualityCommands.map((command) => ({ argv: [...command.argv] }));
  definition.approval = phase.approval === 'none' ? 'none' : {
    authorities: [...phase.approval.authorities],
    minimum: phase.approval.minimum,
    ...(Object.hasOwn(phase.approval, 'allowSelfApproval') ? { allowSelfApproval: phase.approval.allowSelfApproval } : {})
  };
  return definition;
}

/**
 * Write `candidate` under `root` (emptied first). Returns the files it wrote, relative, and the
 * IDs the baseline already used before the candidate was added (for collision findings).
 */
export async function stageCandidate(root, candidate) {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  await initializeDefinition(root);
  const baseline = await baselineIdentifiers(root);
  const written = [];
  const put = async (relative, text) => {
    const target = path.join(root, ...relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text, 'utf8');
    written.push(relative);
  };

  const config = YAML.parse(await readFile(path.join(root, WORKFLOW_FILE), 'utf8'));
  config.approvalAuthorities ??= {};
  for (const authority of candidate.authorities) {
    // Membership is the destination's to decide; an imported authority arrives empty. [TAWI-REQ-012]
    config.approvalAuthorities[authority.id] = { label: authority.label, allowAnyGitIdentity: false, members: [] };
  }
  for (const phase of candidate.phases) config.phases[phase.id] = phaseDefinition(phase);
  const workType = { label: candidate.workflow.label, phases: [...candidate.workflow.phases] };
  if (candidate.workflow.decisions?.length) workType.decisions = structuredClone(candidate.workflow.decisions);
  if (candidate.workflow.omits?.length) workType.omits = structuredClone(candidate.workflow.omits);
  if (candidate.workflow.sourceReview) {
    workType.sourceReview = { mode: 'enforce', phases: [...candidate.workflow.sourceReview.phases],
      reviewerAgent: candidate.workflow.sourceReview.reviewerAgent };
  }
  config.workTypes[candidate.workflow.id] = workType;
  await writeFile(path.join(root, WORKFLOW_FILE), YAML.stringify(config, { lineWidth: 0 }), 'utf8');
  written.push(WORKFLOW_FILE);

  for (const template of candidate.templates) await put(`singularity/templates/${template.ref}`, template.body.endsWith('\n') ? template.body : `${template.body}\n`);

  const reviewer = candidate.workflow.sourceReview?.reviewerAgent ?? null;
  for (const agent of candidate.agents) {
    const defaultFor = candidate.phases.filter((phase) => phase.agent === agent.id).map((phase) => phase.id);
    const reviews = agent.id === reviewer ? candidate.workflow.sourceReview.phases : [];
    const fields = {
      name: agent.id,
      description: agent.description,
      ...(agent.tools?.length ? { tools: [...agent.tools] } : {}),
      metadata: { 'sflow-label': agent.label, 'sflow-phases': csv([...defaultFor, ...reviews]), 'sflow-default-for': csv(defaultFor),
        // A source reviewer reads and reports; the engine admits only a review-only agent there.
        ...(reviews.length ? { 'sflow-mode': 'read-only-review' } : {}) }
    };
    await put(`.github/agents/${agent.id}.agent.md`, `${frontMatter(fields)}${agent.body.trim()}\n`);
  }
  for (const skill of candidate.skills) {
    const fields = { name: skill.id, description: skill.description, ...(skill.loading ? { metadata: { 'sflow-loading': skill.loading } } : {}) };
    await put(`singularity/skill-library/${skill.id}/SKILL.md`, `${frontMatter(fields)}${skill.body.trim()}\n`);
  }
  for (const instruction of candidate.instructions) {
    await put(`singularity/instruction-library/${instruction.id}/INSTRUCTIONS.md`,
      `${frontMatter({ name: instruction.id, description: instruction.description })}${instruction.body.trim()}\n`);
  }
  if (candidate.attachments.length) {
    // The baseline attaches its own skills; the candidate's entries are added after them.
    const existing = await readFile(path.join(root, ...SKILL_ATTACHMENTS_PATH.split('/')), 'utf8').catch(() => '');
    const baseline = existing ? (YAML.parse(existing)?.attachments ?? []) : [];
    const attachments = candidate.attachments.map((entry) => Object.fromEntries(
      ['skill', 'agent', 'workflow', 'steps', 'use'].filter((field) => Object.hasOwn(entry, field)).map((field) => [field, entry[field]])));
    await put(SKILL_ATTACHMENTS_PATH, YAML.stringify({ attachments: [...baseline, ...attachments] }, { lineWidth: 0 }));
  }
  return { root, written, baseline };
}

/** Every ID the initialized baseline already uses, by kind, for collision checks. [TAWI-REQ-016] */
async function baselineIdentifiers(root) {
  const config = YAML.parse(await readFile(path.join(root, WORKFLOW_FILE), 'utf8'));
  const { readdir } = await import('node:fs/promises');
  const names = async (relative, pattern) => (await readdir(path.join(root, ...relative.split('/'))).catch(() => []))
    .map((name) => pattern.exec(name)?.[1]).filter(Boolean);
  return {
    workflow: Object.keys(config.workTypes ?? {}),
    phase: Object.keys(config.phases ?? {}),
    authority: Object.keys(config.approvalAuthorities ?? {}),
    // Packaged agents join every catalog (agents.mjs discoverAgents), not only the copied ones.
    agent: (await discoverAgents(root)).map((agent) => agent.id),
    skill: await names('singularity/skill-library', /^([a-z0-9-]+)$/u),
    instruction: await names('singularity/instruction-library', /^([a-z0-9-]+)$/u)
  };
}
