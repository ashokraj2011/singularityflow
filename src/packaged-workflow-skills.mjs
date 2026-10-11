import path from 'node:path';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { PACKAGE_ROOT } from './package-root.mjs';
import { librarySkillPath, parseLibrarySkill, parseSkillAttachments, SKILL_ATTACHMENTS_PATH } from './skill-library.mjs';
import { secureRepositoryPath, SingularityFlowError } from './util.mjs';
import { instructionPath, parseInstruction } from './instruction-library.mjs';

/** Plan only the library dependencies of the selected starter; preserve repository overrides. */
export async function packagedWorkflowSkills(root, workflowId, agentIds, agentSkills = [], { candidateFiles = new Map() } = {}) {
  const sourceRoot = path.join(PACKAGE_ROOT, 'templates/skill-library');
  const packaged = parseSkillAttachments(await readFile(path.join(sourceRoot, 'attachments.yml'), 'utf8'));
  const selected = packaged.filter((entry) => entry.workflow === workflowId || agentIds.has(entry.agent));
  if (!selected.length && !agentSkills.length) return [];
  const files = [];
  const instructions = new Set();
  // Agent-owned tables are the attachment authority. Adopt their library files without
  // duplicating those bindings in attachments.yml or losing them on starter installation.
  for (const id of new Set([...selected, ...agentSkills].map((entry) => entry.id))) {
    const relative = librarySkillPath(id);
    const target = await secureRepositoryPath(root, relative, { label: 'Starter skill', type: 'file' });
    const text = candidateFiles.has(relative) ? candidateFiles.get(relative)
      : await readFile(target.exists ? target.absolute : path.join(sourceRoot, id, 'SKILL.md'), 'utf8');
    const skill = parseLibrarySkill(text, { id });
    for (const reference of skill.instructionRefs) instructions.add(reference);
    if (!target.exists && !candidateFiles.has(relative)) files.push({ path: relative, text });
  }
  for (const id of instructions) {
    const relative = instructionPath(id);
    const target = await secureRepositoryPath(root, relative, { label: 'Starter instruction', type: 'file' });
    if (candidateFiles.has(relative)) { parseInstruction(candidateFiles.get(relative), { id }); continue; }
    if (target.exists) { parseInstruction(await readFile(target.absolute, 'utf8'), { id }); continue; }
    const text = await readFile(path.join(PACKAGE_ROOT, 'templates/instruction-library', id, 'INSTRUCTIONS.md'), 'utf8')
      .catch(error => {
        if (error.code !== 'ENOENT') throw error;
        throw new SingularityFlowError(`Starter skill references missing instruction '${id}'. Create the reviewed definition before adopting this customized skill.`, { code: 'INSTRUCTION_REFERENCE_MISSING' });
      });
    parseInstruction(text, { id }); files.push({ path: relative, text });
  }
  if (!selected.length) return files;
  const target = await secureRepositoryPath(root, SKILL_ATTACHMENTS_PATH, { label: 'Starter skill attachments', type: 'file' });
  const original = candidateFiles.has(SKILL_ATTACHMENTS_PATH) ? candidateFiles.get(SKILL_ATTACHMENTS_PATH) ?? 'attachments: []\n'
    : target.exists ? await readFile(target.absolute, 'utf8') : 'attachments: []\n';
  const current = parseSkillAttachments(original);
  const document = YAML.parseDocument(original);
  if (!document.get('attachments')) document.set('attachments', document.createNode([]));
  let changed = false;
  for (const entry of selected) {
    if (current.some((item) => item.id === entry.id && item.agent === entry.agent && item.workflow === entry.workflow)) continue;
    document.get('attachments').add(document.createNode({ skill: entry.id,
      ...(entry.agent ? { agent: entry.agent } : { workflow: entry.workflow }), steps: entry.phases, use: entry.use }));
    changed = true;
  }
  if (changed) files.push({ path: SKILL_ATTACHMENTS_PATH, text: document.toString() });
  return files;
}
