/**
 * Lay a validated candidate out as a configuration tree, so the engine's own loaders, validators
 * and bundle compiler read it exactly as they read a repository. [TAWI-REQ-020, -027]
 *
 * The tree starts from a freshly initialized configuration, the baseline every destination
 * shares, and adds only the candidate's namespaced workflow, phases, authorities, agents, skills,
 * instructions, templates and attachments, and each agent's folder: the captured files it consults,
 * byte for byte, under singularity/user-defined/<agent>/ with the manifest its agent pins, so the
 * bundle carries them and the step prompt gives them to it as for a folder `call add` made. It lives in the session directory, is rebuilt on every
 * compile, is never a Git repository, and fabricates no approval or provenance.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { newAgentFile } from '../agent-file.mjs';
import { discoverAgents } from '../agents.mjs';
import { USER_DEFINED_MANIFEST_METADATA, USER_DEFINED_METADATA, userDefinedFolderPath, userDefinedManifestPath } from '../user-defined-agent-identity.mjs';
import { fileMedia } from './formats.mjs';
import { initializeDefinition } from '../config.mjs';
import { SKILL_ATTACHMENTS_PATH } from '../skill-library.mjs';
import { CHECK_KINDS, classifyCommand } from '../guidance-scan.mjs';

const WORKFLOW_FILE = 'singularity/workflow.yml';

function frontMatter(fields) {
  return `---\n${YAML.stringify(fields, { lineWidth: 0 }).trimEnd()}\n---\n\n`;
}

/**
 * A phase's checks as sflow runs them: each named, of its kind, and using no model, so a check is
 * never left unavailable because its model behaviour is unknown. A test command the completer could
 * finish (`completed`, compile.mjs) is written in full, with its variables, folder, module and result,
 * so a code step can publish with it [TCE:REQ-063]; any other stays as the source wrote it.
 */
function qualityChecks(commands, completed = new Map()) {
  const taken = new Set();
  return commands.map((command) => {
    const stem = command.argv.join(' ').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 60) || 'check';
    let id = stem;
    for (let index = 2; taken.has(id); index += 1) id = `${stem}-${index}`;
    taken.add(id);
    const full = completed.get(command);
    if (full) return { ...structuredClone(full), id };
    return { id, modelPolicy: 'never', argv: [...command.argv], kind: CHECK_KINDS[classifyCommand(command.argv.join(' '))] ?? 'other' };
  });
}

/** The workflow.yml phase a candidate phase becomes. */
function phaseDefinition(phase, completed) {
  const definition = {
    label: phase.label,
    defaultTemplate: phase.template,
    artifact: { path: phase.artifact.path, kind: phase.artifact.kind },
    writeScope: phase.writeScope
  };
  if (phase.inputs?.length) definition.inputs = [...phase.inputs];
  if (phase.code === true) definition.generation = { task: 'code' };
  if (phase.qualityCommands?.length) definition.qualityCommands = qualityChecks(phase.qualityCommands, completed);
  definition.approval = phase.approval === 'none' ? 'none' : {
    authorities: [...phase.approval.authorities],
    minimum: phase.approval.minimum,
    ...(Object.hasOwn(phase.approval, 'allowSelfApproval') ? { allowSelfApproval: phase.approval.allowSelfApproval } : {})
  };
  return definition;
}

/**
 * An agent's folder: the files of `agent.files` that still hold the bytes the capture hashed
 * (`sourceFile` answers null for any other), and the manifest text that pins them.
 */
async function agentFolder(agent, candidate, sourceFile) {
  const files = [];
  for (const where of agent.files ?? []) {
    const bytes = await sourceFile(where);
    if (!bytes) continue;
    const media = fileMedia(where);
    // An extra root's capture path (+1/notes.md) keeps its root apart inside the folder.
    files.push({ path: where.replace(/^\+(\d+)\//u, 'root-$1/'), sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      bytes: bytes.length, ...(media ? { kind: media } : {}), content: bytes });
  }
  if (!files.length) return null;
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const { userDefinedManifestText } = await import('../user-defined-agents.mjs');
  const code = candidate.phases.some((phase) => phase.agent === agent.id && phase.code === true);
  // No main file: the agent's instructions are its body, so every file is given to it.
  const manifest = userDefinedManifestText({ name: agent.id, label: agent.label, main: null, output: code ? 'code' : 'document',
    files: files.map(({ content, ...file }) => file), leftOut: [] });
  return { files, manifest, sha256: `sha256:${createHash('sha256').update(manifest).digest('hex')}` };
}

/**
 * Write `candidate` under `root` (emptied first). Returns the files it wrote, relative, and the
 * IDs the baseline already used before the candidate was added (for collision findings).
 * `completed` maps a candidate's quality command to its completed test record; `sourceFile` reads a
 * captured file's bytes for an agent's folder, or null when they no longer match the capture.
 */
export async function stageCandidate(root, candidate, { completed = new Map(), sourceFile = async () => null } = {}) {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  await initializeDefinition(root);
  const baseline = await baselineIdentifiers(root);
  const written = [];
  const put = async (relative, text) => {
    const target = path.join(root, ...relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text, typeof text === 'string' ? 'utf8' : undefined);
    written.push(relative);
  };

  const config = YAML.parse(await readFile(path.join(root, WORKFLOW_FILE), 'utf8'));
  config.approvalAuthorities ??= {};
  for (const authority of candidate.authorities) {
    // Membership is the destination's to decide; an imported authority arrives empty. [TAWI-REQ-012]
    config.approvalAuthorities[authority.id] = { label: authority.label, allowAnyGitIdentity: false, members: [] };
  }
  for (const phase of candidate.phases) config.phases[phase.id] = phaseDefinition(phase, completed);
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
    const folder = await agentFolder(agent, candidate, sourceFile);
    if (folder) {
      for (const file of folder.files) await put(`${userDefinedFolderPath(agent.id)}/${file.path}`, file.content);
      await put(userDefinedManifestPath(agent.id), folder.manifest);
    }
    // Rendered as Workflow Studio's agent.create writes a new agent (src/agent-file.mjs): the team's
    // instructions between the shared boundary and clarification sentences. No tools listed stays none listed.
    await put(`.github/agents/${agent.id}.agent.md`, newAgentFile({
      id: agent.id, label: agent.label, description: agent.description, tools: agent.tools?.length ? [...agent.tools] : null,
      phases: [...new Set([...defaultFor, ...reviews])], defaultFor, instructions: agent.body, starter: true,
      extraMetadata: {
        // A source reviewer reads and reports; the engine admits only a review-only agent there.
        ...(reviews.length ? { 'sflow-mode': 'read-only-review' } : {}),
        ...(folder ? { [USER_DEFINED_METADATA]: agent.id, [USER_DEFINED_MANIFEST_METADATA]: folder.sha256 } : {})
      }
    }));
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
