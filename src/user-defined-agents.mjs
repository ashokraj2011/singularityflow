/**
 * User-defined agents: a person's own folder (a main agent plus the skills and notes it uses) run as
 * one governed step, without converting it into a workflow first.
 *
 * `call add <FOLDER>` reads the folder once, shows what it found, and on confirmation proposes one
 * reviewed configuration change: the folder copied unchanged to `singularity/user-defined/<name>/`,
 * its manifest beside it (every file's SHA-256), and one agent, one step and one workflow under the
 * same name. The agent's instructions are the main file's own body; its metadata pins the manifest
 * digest, and a Story pins the agent, so a later change to the folder never reaches a running Story
 * silently. When the step is composed, every other file of the folder is given to the agent in the
 * prompt, verified against that digest. Nothing in the folder is executed by SFlow.
 */
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from './records.mjs';
import { scanText } from './secrets.mjs';
import { agentFrontMatter, blockedPath, EXCLUDED_DIRECTORIES, fileMedia, kebab, splitFrontMatter } from './team-import/formats.mjs';
import { SingularityFlowError } from './util.mjs';
import {
  USER_DEFINED_MANIFEST_METADATA, USER_DEFINED_METADATA, userDefinedAgentName, userDefinedFolderPath, userDefinedManifestPath
} from './user-defined-agent-identity.mjs';

export const USER_DEFINED_AGENT_SCHEMA = 'sflow-user-defined-agent@1';
// The main file becomes the agent's instructions (the agent parser's own body limit); every other
// file is given to the agent in its step prompt, so the folder's text is bounded to what one prompt
// can carry.
export const USER_DEFINED_LIMITS = Object.freeze({ files: 256, depth: 12, fileBytes: 64 * 1024, totalBytes: 192 * 1024, mainBytes: 30_000,
  binaryFileBytes: 4 * 1024 * 1024, binaryTotalBytes: 10 * 1024 * 1024 });
// Besides text, a folder may hold office documents, given to its agent as their extracted text, and
// images and PDFs, which the agent opens with its own image or PDF tools (fileMedia). Both are copied
// byte for byte. Any other binary file (an archive, a program) is left out.
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const OUTPUTS = new Set(['code', 'document']);
// The tools the agent file grants Copilot: the developer preset for a step that changes code, the
// analyst preset otherwise. The main file's own `tools` name another host's tools, so they are
// reported as not used rather than copied.
const TOOLS = Object.freeze({ code: ['read', 'search', 'edit', 'execute', 'bash', 'ask_user'], document: ['read', 'search', 'edit', 'ask_user'] });

const fail = (code, message, details) => { throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) }); };
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function utf8(bytes) {
  if (bytes.subarray(0, 8000).includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
}

/**
 * Every file of the folder as exact bytes, in path order, and every one left out with why: links
 * are never followed, secret-looking and binary files are never copied, dependency and build
 * directories are not walked. The caps refuse a folder too large to give one agent in one prompt.
 */
export async function captureUserDefinedFolder(folder) {
  const root = path.resolve(String(folder ?? ''));
  const info = await lstat(root).catch(() => null);
  if (!info?.isDirectory()) fail('USER_AGENT_FOLDER_UNAVAILABLE', `${folder} is not a folder.`);
  const files = []; const leftOut = []; let total = 0; let binary = 0;
  const bounded = () => {
    if (files.length > USER_DEFINED_LIMITS.files) fail('USER_AGENT_FOLDER_TOO_LARGE', `${folder} has more than ${USER_DEFINED_LIMITS.files} files; one agent's folder is given to it in one prompt.`);
    if (total > USER_DEFINED_LIMITS.totalBytes) fail('USER_AGENT_FOLDER_TOO_LARGE', `${folder} holds more than ${USER_DEFINED_LIMITS.totalBytes / 1024} KiB of text; one agent's folder is given to it in one prompt.`);
    if (binary > USER_DEFINED_LIMITS.binaryTotalBytes) fail('USER_AGENT_FOLDER_TOO_LARGE', `${folder} holds more than ${USER_DEFINED_LIMITS.binaryTotalBytes / 1024 / 1024} MiB of documents, images and PDFs.`);
  };
  const walk = async (directory, relative, depth) => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const where = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) { leftOut.push({ path: where, reason: 'a link; links are never followed' }); continue; }
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) { leftOut.push({ path: `${where}/`, reason: 'a dependency, build or Git directory' }); continue; }
        if (depth >= USER_DEFINED_LIMITS.depth) { leftOut.push({ path: `${where}/`, reason: `deeper than ${USER_DEFINED_LIMITS.depth} folders` }); continue; }
        await walk(path.join(directory, entry.name), where, depth + 1);
        continue;
      }
      if (!entry.isFile()) { leftOut.push({ path: where, reason: 'not a regular file' }); continue; }
      if (blockedPath(where)) { leftOut.push({ path: where, reason: 'named like a secret, key or environment file; never read' }); continue; }
      const media = fileMedia(where);
      const document = media === 'document';
      if (media) {
        if ((await lstat(path.join(directory, entry.name))).size > USER_DEFINED_LIMITS.binaryFileBytes) {
          leftOut.push({ path: where, reason: `larger than ${USER_DEFINED_LIMITS.binaryFileBytes / 1024 / 1024} MiB` }); continue;
        }
        const kept = await readFile(path.join(directory, entry.name));
        let text = null;
        if (document) {
          const extracted = (await import('./source-text.mjs')).extractSourceTextForPath(kept, entry.name);
          if (extracted.status === 'extracted') {
            const findings = scanText(extracted.text, { path: where });
            if (findings.length) { leftOut.push({ path: where, reason: `holds what looks like a secret (${findings[0].label ?? findings[0].rule}, line ${findings[0].line} of its text)` }); continue; }
            text = extracted.text;
          }
        }
        files.push({ path: where, bytes: kept, text, sha256: sha256(kept), size: kept.length, kind: document ? 'document' : 'viewable' });
        binary += kept.length;
        total += text ? Buffer.byteLength(text) : 0;
        bounded();
        continue;
      }
      const bytes = await readFile(path.join(directory, entry.name));
      if (bytes.length > USER_DEFINED_LIMITS.fileBytes) { leftOut.push({ path: where, reason: `larger than ${USER_DEFINED_LIMITS.fileBytes / 1024} KiB` }); continue; }
      const text = utf8(bytes);
      if (text == null) { leftOut.push({ path: where, reason: 'a binary file other than a document, image or PDF' }); continue; }
      const findings = scanText(text, { path: where });
      if (findings.length) { leftOut.push({ path: where, reason: `holds what looks like a secret (${findings[0].label ?? findings[0].rule}, line ${findings[0].line})` }); continue; }
      files.push({ path: where, bytes, text, sha256: sha256(bytes), size: bytes.length });
      total += bytes.length;
      bounded();
    }
  };
  await walk(root, '', 0);
  return { root, files, leftOut };
}

/** Files that read as an agent definition: `*.agent.md`, `*.chatmode.md`, an `agents/` file, `AGENTS.md`. */
function agentCandidates(files) {
  return files.filter((file) => /\.(?:agent|chatmode)\.md$/iu.test(file.path)
    || /(?:^|\/)agents\/[^/]+\.md$/iu.test(file.path) || /^AGENTS\.md$/iu.test(file.path)).map((file) => file.path);
}

/**
 * A plain Markdown agent at the top of the folder (`reviewer.md`): its front matter names or describes
 * it, and it is not a README or a skill. Considered only when no file follows the conventions above.
 */
function plainAgentCandidates(files) {
  return files.filter((file) => /^[^/]+\.md$/iu.test(file.path) && !/^(?:readme|skill|changelog|contributing|license)\.md$/iu.test(file.path))
    .filter((file) => {
      const { frontMatter, problem } = agentFrontMatter(file.text);
      return !problem && ['name', 'description'].some((key) => typeof frontMatter[key] === 'string' && frontMatter[key].trim());
    }).map((file) => file.path);
}

/** Every text file a person may name as the main agent, Markdown first. */
const choosableFiles = (files) => {
  const text = files.filter((file) => !file.kind);
  return [...text.filter((file) => /\.md$/iu.test(file.path)), ...text.filter((file) => !/\.md$/iu.test(file.path))].map((file) => file.path);
};

/**
 * What the folder holds and how its files link, read as team import reads a team directory: each
 * file's role (agent, skill, procedure, instruction) and every resolved reference between files
 * (Markdown links, #file: paths, named files and agents, front-matter handoffs). Two or more agents
 * describe a workflow rather than one step. Null when the folder cannot be read that way; adding it
 * as one step never depends on this.
 */
export async function userDefinedFolderMap(root) {
  try {
    const { capture } = await (await import('./team-import/capture.mjs')).captureTeamDirectory(root);
    const roles = capture.files.filter((file) => file.role && file.screening === 'clean').map((file) => ({ path: file.relative, role: file.role }));
    const links = capture.references.filter((reference) => reference.status === 'resolved' && reference.target !== reference.from)
      .map((reference) => ({ from: reference.from, to: reference.target, kind: reference.kind }));
    const agents = roles.filter((entry) => entry.role === 'agent').map((entry) => entry.path);
    const handoffs = links.filter((link) => agents.includes(link.from) && agents.includes(link.to));
    return { roles, links, agents, handoffs, shape: agents.length > 1 ? 'workflow' : 'one-step' };
  } catch { return null; }
}

/** The main agent: the one `--main` names, else the folder's only agent file. Never a guess between several. */
export function chooseMainAgent(files, requested = null) {
  if (requested) {
    const wanted = String(requested).replace(/\\/gu, '/').replace(/^\.\//u, '');
    const match = files.find((file) => file.path === wanted && !file.kind);
    if (!match) fail('USER_AGENT_MAIN_UNKNOWN', `${wanted} is not one of the folder's text files.`, { files: files.map((file) => file.path), candidates: choosableFiles(files) });
    return match;
  }
  const conventional = agentCandidates(files);
  const candidates = conventional.length ? conventional : plainAgentCandidates(files);
  if (candidates.length === 1) return files.find((file) => file.path === candidates[0]);
  if (!candidates.length) {
    fail('USER_AGENT_MAIN_REQUIRED', 'No main agent file was found (an *.agent.md, *.chatmode.md, agents/*.md, AGENTS.md, or a Markdown file at the top of the folder whose front matter has a name or description). Name it with --main <FILE>.',
      { files: files.map((file) => file.path), candidates: choosableFiles(files) });
  }
  fail('USER_AGENT_MAIN_AMBIGUOUS', `The folder has ${candidates.length} agent files: ${candidates.join(', ')}. Name the one that runs the others with --main <FILE>.`,
    { candidates });
}

function oneLine(value, limit) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function titleOf(name) {
  return name.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/** The manifest file's exact text: canonical JSON of what was copied, in path order. */
export function userDefinedManifestText(plan) {
  return `${canonicalJson({
    schema: USER_DEFINED_AGENT_SCHEMA, name: plan.name, label: plan.label, main: plan.main, output: plan.output,
    files: plan.files.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes, ...(file.kind ? { kind: file.kind } : {}) })),
    leftOut: plan.leftOut
  })}\n`;
}

/**
 * What `call add` would propose, from the folder as it is now. The plan digest covers every choice
 * and every file's bytes, so a confirmation applies exactly what was previewed.
 */
export async function userDefinedAgentPlan(folder, { name = null, label = null, main = null, output = 'code', approvalGroup = null, replace = false } = {}) {
  if (!OUTPUTS.has(output)) fail('USER_AGENT_USAGE', '--output is code (the agent changes code and tests) or document (it writes a document).');
  const captured = await captureUserDefinedFolder(folder);
  if (!captured.files.length) fail('USER_AGENT_FOLDER_EMPTY', `${folder} has no text file to copy.`, { leftOut: captured.leftOut });
  const map = await userDefinedFolderMap(captured.root);
  // Several agents are a workflow: built with team import from the same reading, unless the person
  // names one to run alone with --main.
  if (!main && map?.shape === 'workflow') {
    const handoffs = map.handoffs.map((link) => `${link.from} → ${link.to}`);
    fail('USER_AGENT_FOLDER_IS_WORKFLOW', `${path.basename(captured.root)} describes a workflow of ${map.agents.length} agents (${map.agents.join(', ')})`
      + `${handoffs.length ? ` that hand work to each other (${handoffs.join('; ')})` : ''}. Build a workflow from it, or add one of them as a single step with --main <FILE>.`,
    { folder: captured.root, agents: map.agents, handoffs: map.handoffs, candidates: map.agents });
  }
  const mainFile = chooseMainAgent(captured.files, main);
  // Read as Copilot reads it: a header that is not strict YAML still names and describes the agent.
  const { frontMatter, body, problem, lenient } = agentFrontMatter(mainFile.text);
  if (problem) fail('USER_AGENT_MAIN_INVALID', `${mainFile.path}: ${problem}.`);
  const instructions = body.trim();
  if (!instructions) fail('USER_AGENT_MAIN_INVALID', `${mainFile.path} has no instructions after its front matter.`);
  if (Buffer.byteLength(instructions) > USER_DEFINED_LIMITS.mainBytes) {
    fail('USER_AGENT_MAIN_TOO_LARGE', `${mainFile.path} has ${Buffer.byteLength(instructions)} bytes of instructions; an agent holds at most ${USER_DEFINED_LIMITS.mainBytes}. Move parts of it into files it names.`);
  }
  const id = name != null ? String(name) : (kebab(frontMatter.name) || kebab(path.basename(captured.root)));
  if (!ID.test(id)) fail('USER_AGENT_NAME_INVALID', `'${id}' cannot name an agent; use lowercase words joined by hyphens, with --name.`);
  const declared = typeof frontMatter.description === 'string' ? oneLine(frontMatter.description, 1000) : '';
  const firstLine = instructions.split('\n').map((line) => line.replace(/^#+\s*/u, '').trim()).find(Boolean) ?? '';
  const plan = {
    name: id,
    label: oneLine(label ?? (typeof frontMatter.name === 'string' && !ID.test(frontMatter.name) ? frontMatter.name : titleOf(id)), 120),
    description: declared || oneLine(`${firstLine || `Runs the ${id} agent's own instructions.`}`, 300),
    main: mainFile.path, output, step: id, workflow: id, approvalGroup: approvalGroup ?? null,
    // Replace: a new copy of an existing user-defined agent's folder under the same name; its step and
    // workflow stay as they are.
    ...(replace ? { replace: true } : {}),
    folder: path.basename(captured.root),
    // A document, image or PDF says so; a text-only folder plans exactly as before.
    files: captured.files.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.size, ...(file.kind ? { kind: file.kind } : {}) })),
    leftOut: captured.leftOut,
    notUsed: Object.keys(frontMatter).filter((key) => !['name', 'description'].includes(key)).sort(),
    // What each file is and how they link, as the preview shows it.
    ...(map && (map.roles.length || map.links.length) ? { map: { roles: map.roles, links: map.links } } : {}),
    ...(lenient ? { frontMatterNote: `Its front matter is not strict YAML (${lenient.replace(/^front matter is not valid YAML: /u, '')}); its name and description were read line by line, as Copilot reads them.` } : {})
  };
  plan.manifestSha256 = sha256(Buffer.from(userDefinedManifestText(plan)));
  plan.planSha256 = sha256(Buffer.from(canonicalJson(plan)));
  return { plan, captured, instructions };
}

/** The agent file `call add` registers: the main file's own instructions, pinned to the manifest. */
export function userDefinedAgentHeader(plan) {
  return ['---', `name: ${plan.name}`, `description: ${JSON.stringify(plan.description)}`, 'metadata:',
    `  sflow-label: ${JSON.stringify(plan.label)}`, `  ${USER_DEFINED_METADATA}: ${plan.name}`,
    `  ${USER_DEFINED_MANIFEST_METADATA}: ${JSON.stringify(plan.manifestSha256)}`, '---', ''].join('\n');
}

/** The Studio change set that adds the agent, its one step and its one workflow. */
export function userDefinedAgentChangeSet({ plan, captured, instructions }, { approvalGroup = null } = {}) {
  const group = plan.approvalGroup ?? approvalGroup;
  const folder = { id: plan.name, label: plan.label, description: plan.description, output: plan.output,
    manifestSha256: plan.manifestSha256, manifest: userDefinedManifestText(plan), instructions,
    files: captured.files.map((file) => ({ path: file.path, sha256: file.sha256, base64: file.bytes.toString('base64') })) };
  if (plan.replace) return { schema: 'sflow-studio-change-set@1', changes: [{ op: 'userAgent.update', ...folder }] };
  return {
    schema: 'sflow-studio-change-set@1',
    changes: [
      { op: 'userAgent.add', ...folder },
      { op: 'phase.create', id: plan.step, label: plan.label, output: plan.output, inputs: [], agent: plan.name,
        description: `Runs ${plan.label}, the user-defined agent from the ${plan.folder} folder.`,
        ...(plan.approvalGroup ? { approval: { group: plan.approvalGroup } } : {}) },
      { op: 'workflow.create', id: plan.workflow, label: plan.label, description: `${plan.label}, run as one step (user-defined agent).`, phases: [plan.step],
        // One code step implements, verifies (its tests run) and is reviewed, but no earlier step defines
        // its requirements or plans it: the step's approvers record why those do not apply before the
        // Story finishes, as POC Lite's reviewer does for scope.
        ...(plan.output === 'code' && group ? { omits: [
          { responsibility: 'scope', authority: group, reason: `${plan.label} is a user-defined agent run as one step; it defines no requirement clauses.` },
          { responsibility: 'plan', authority: group, reason: `${plan.label} plans and makes the change itself, in its one step, from its own instructions.` }
        ] } : {}) }
    ]
  };
}

/**
 * The files a `userAgent.add` change writes, checked again from the change itself: each path stays
 * inside the folder, each file matches its digest, and the manifest matches the digest the agent
 * pins. Workflow Studio calls this; it never reads the person's folder.
 */
export function userDefinedAgentFiles(change) {
  const name = String(change?.id ?? '');
  if (!ID.test(name)) fail('USER_AGENT_NAME_INVALID', `'${name}' cannot name a user-defined agent.`);
  if (!OUTPUTS.has(change.output)) fail('USER_AGENT_USAGE', 'A user-defined agent writes code or a document.');
  const manifest = Buffer.from(String(change.manifest ?? ''));
  if (sha256(manifest) !== change.manifestSha256) fail('USER_AGENT_MANIFEST_MISMATCH', `The manifest of ${name} does not match its digest.`);
  const listed = JSON.parse(manifest.toString('utf8'));
  const files = (change.files ?? []).map((file) => {
    const relative = String(file?.path ?? '');
    if (!relative || relative.startsWith('/') || /\\/u.test(relative) || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
      fail('USER_AGENT_PATH_INVALID', `'${relative}' is not a path inside the folder.`);
    }
    const bytes = Buffer.from(String(file.base64 ?? ''), 'base64');
    if (sha256(bytes) !== file.sha256) fail('USER_AGENT_FILE_MISMATCH', `${relative} does not match its digest.`);
    return { path: `${userDefinedFolderPath(name)}/${relative}`, bytes, relative, sha256: file.sha256 };
  });
  const same = JSON.stringify(files.map((file) => [file.relative, file.sha256])) === JSON.stringify((listed.files ?? []).map((file) => [file.path, file.sha256]));
  if (listed.schema !== USER_DEFINED_AGENT_SCHEMA || listed.name !== name || !same) fail('USER_AGENT_MANIFEST_MISMATCH', `The files of ${name} are not the ones its manifest lists.`);
  const main = files.find((file) => file.relative === listed.main);
  if (!main || splitFrontMatter(main.bytes.toString('utf8')).body.trim() !== String(change.instructions ?? '')) {
    fail('USER_AGENT_MANIFEST_MISMATCH', `The instructions of ${name} are not its main file's own.`);
  }
  return { name, manifest: { path: userDefinedManifestPath(name), bytes: manifest }, files, main: listed.main, tools: TOOLS[change.output] };
}

/** What `call add` prints before anything is proposed. */
export function userDefinedPlanLines(plan) {
  const lines = [
    `User-defined agent ${plan.label} (${plan.name}) from the ${plan.folder} folder`,
    `  Main agent: ${plan.main} (its instructions become the agent's)`,
    `  Copied unchanged to ${userDefinedFolderPath(plan.name)}/: ${plan.files.length} file${plan.files.length === 1 ? '' : 's'}`,
    ...plan.files.map((file) => `    ${file.path} (${file.bytes} bytes)`),
    plan.replace ? `  Replaces the folder of the existing agent '${plan.name}'; its step and workflow stay as they are. Running Stories keep the folder they started with.`
      : `  Runs as: one ${plan.output === 'code' ? 'code' : 'document'} step '${plan.step}' in workflow '${plan.workflow}'${plan.approvalGroup ? `, approved by ${plan.approvalGroup}` : ''}`
  ];
  if (plan.leftOut.length) lines.push(`  Left out (${plan.leftOut.length}):`, ...plan.leftOut.map((entry) => `    ${entry.path}: ${entry.reason}`));
  if (plan.notUsed.length) lines.push(`  Not used from ${plan.main}'s front matter: ${plan.notUsed.join(', ')} (SFlow sets the agent's tools and steps)`);
  if (plan.frontMatterNote) lines.push(`  ${plan.main}: ${plan.frontMatterNote}`);
  const kinds = plan.files.filter((file) => file.kind);
  if (kinds.length) lines.push(`  Documents, images and PDFs (${kinds.length}): ${kinds.map((file) => file.path).join(', ')}; documents reach the agent as their text, images and PDFs as files to open`);
  if (plan.map?.links?.length) lines.push(`  Links between its files (${plan.map.links.length}):`, ...plan.map.links.slice(0, 20).map((link) => `    ${link.from} → ${link.to} (${link.kind})`));
  return lines;
}

/**
 * The user-defined agents a configuration holds: each agent whose metadata names a folder, with its
 * manifest when the configuration has it.
 */
export async function listUserDefinedAgents(definition, configRoot) {
  // A packaged sample agent is in every catalog; it is listed only where its workflow exists.
  const agents = Object.values(definition.agents ?? {}).filter((agent) => userDefinedAgentName(agent) && definition.workTypes?.[agent.id]);
  return Promise.all(agents.map(async (agent) => {
    const name = userDefinedAgentName(agent);
    const manifest = await readManifest(configRoot, name).catch(() => null);
    const workflow = definition.workTypes?.[agent.id] ? agent.id : null;
    // Matches only when the manifest is the one the agent pins and every copied file is still its own.
    const intact = manifest && manifest.sha256 === agent.metadata[USER_DEFINED_MANIFEST_METADATA]
      && (await Promise.all(manifest.files.map(async (file) => sha256(await readFile(path.join(configRoot, userDefinedFolderPath(name), file.path)).catch(() => Buffer.alloc(0))) === file.sha256))).every(Boolean);
    return {
      name: agent.id, label: agent.label, description: agent.description ?? null, folder: userDefinedFolderPath(name), workflow,
      step: agent.defaultFor?.[0] ?? null, main: manifest?.main ?? null, output: manifest?.output ?? null, files: manifest?.files?.length ?? null,
      leftOut: manifest?.leftOut?.length ?? null,
      manifest: intact ? 'matches' : manifest ? 'changed' : 'missing'
    };
  }));
}

async function readManifest(configRoot, name) {
  const bytes = await readFile(path.join(configRoot, userDefinedManifestPath(name)));
  return { ...JSON.parse(bytes.toString('utf8')), sha256: sha256(bytes) };
}

/**
 * The prompt section that gives a user-defined agent its folder: every file except the main one
 * (already the agent's instructions), each read from the configuration and checked against the
 * manifest digest the Story's pinned agent names. A folder changed since the Story started is
 * refused, never substituted.
 */
export async function renderUserDefinedFolder(configRoot, agent, { root = null } = {}) {
  const name = userDefinedAgentName(agent);
  if (!name) return null;
  const pinned = agent.metadata?.[USER_DEFINED_MANIFEST_METADATA];
  const manifest = await readManifest(configRoot, name).catch(() => null);
  // A Story reads the configuration it started with, so a difference here means the copied folder was
  // edited by hand instead of through `call add`.
  const changed = (detail) => fail('USER_AGENT_FOLDER_CHANGED',
    `The folder of user-defined agent ${agent.label ?? agent.id} ${detail}, so its step cannot be composed from it. The copied folder changes only through call add: restore it, or propose the folder again under the same name with call add <FOLDER> --replace.`,
    { agent: agent.id, folder: userDefinedFolderPath(name) });
  if (!manifest) changed('has no manifest');
  if (manifest.sha256 !== pinned) changed('has a manifest other than the one its agent pins');
  const parts = [];
  const viewable = [];
  for (const file of manifest.files.filter((entry) => entry.path !== manifest.main)) {
    const absolute = path.join(configRoot, userDefinedFolderPath(name), file.path);
    const bytes = await readFile(absolute).catch(() => null);
    if (!bytes || sha256(bytes) !== file.sha256) changed(`no longer matches its manifest (${file.path} changed)`);
    // An image or PDF is opened, not inlined; its exact verified path is given and allowed for reading.
    if (file.kind === 'viewable') {
      viewable.push(absolute);
      parts.push(`### ${file.path}\n\nAn image or PDF: open \`${absolute}\` with your image or PDF tool and look at it before you use it.`);
      continue;
    }
    const extracted = file.kind === 'document' ? (await import('./source-text.mjs')).extractSourceTextForPath(bytes, file.path) : null;
    if (extracted && extracted.status !== 'extracted') {
      parts.push(`### ${file.path}\n\nA document whose text could not be extracted (${extracted.reason}); it is kept in the folder.`);
      continue;
    }
    const text = extracted ? extracted.text : bytes.toString('utf8');
    const fence = '~'.repeat(Math.max(4, ...[...text.matchAll(/~{4,}/gu)].map((match) => match[0].length + 1)));
    parts.push(`### ${file.path}${extracted ? ' (its text)' : ''}\n\n${fence}\n${text.replace(/\n$/u, '')}\n${fence}`);
  }
  if (viewable.length && root && globalThis.__SFLOW_EXTENSION_HOST__ !== true) {
    await (await import('./copilot-mutation-guard.mjs')).issueMutationReadPaths(root, viewable);
  }
  const others = manifest.files.filter((entry) => entry.path !== manifest.main).length;
  const kinds = 'text exactly, office documents as their text, images and PDFs as paths to open';
  // A workflow built from a team's folder (team import) has no main file: every file is the agent's reference.
  return [
    `# The ${agent.label ?? agent.id} folder`, '',
    (manifest.main
      ? `This step runs a user-defined agent: its instructions above are the folder's main file, \`${manifest.main}\`. `
        + (others ? `The ${plural(others, 'other file')} of its folder follow: ${kinds}.` : 'Its folder has no other file.')
      : `This step's agent came from a team's folder; the ${plural(others, 'file')} it works with follow: ${kinds}.`)
      + (others ? ' When its instructions name one of them (a skill, a template, a note, a picture), use what is below; they are not in this repository, so never search for them there.' : ''),
    ...(manifest.leftOut?.length ? ['', `Left out of the folder when it was added: ${manifest.leftOut.map((entry) => `\`${entry.path}\` (${entry.reason})`).join('; ')}.`] : []),
    ...(parts.length ? ['', ...parts.flatMap((part) => [part, ''])] : [])
  ].join('\n').trimEnd();
}
