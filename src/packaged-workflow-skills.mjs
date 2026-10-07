import path from 'node:path';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { PACKAGE_ROOT } from './package-root.mjs';
import { librarySkillPath, parseLibrarySkill, parseSkillAttachments, SKILL_ATTACHMENTS_PATH } from './skill-library.mjs';
import { secureRepositoryPath } from './util.mjs';

/** Plan only the library dependencies of the selected starter; preserve repository overrides. */
export async function packagedWorkflowSkills(root, workflowId, agentIds) {
  const sourceRoot = path.join(PACKAGE_ROOT, 'templates/skill-library');
  const packaged = parseSkillAttachments(await readFile(path.join(sourceRoot, 'attachments.yml'), 'utf8'));
  const selected = packaged.filter((entry) => entry.workflow === workflowId || agentIds.has(entry.agent));
  if (!selected.length) return [];
  const files = [];
  for (const id of new Set(selected.map((entry) => entry.id))) {
    const relative = librarySkillPath(id);
    const target = await secureRepositoryPath(root, relative, { label: 'Starter skill', type: 'file' });
    const text = await readFile(path.join(sourceRoot, id, 'SKILL.md'), 'utf8');
    parseLibrarySkill(target.exists ? await readFile(target.absolute, 'utf8') : text, { id });
    if (!target.exists) files.push({ path: relative, text });
  }
  const target = await secureRepositoryPath(root, SKILL_ATTACHMENTS_PATH, { label: 'Starter skill attachments', type: 'file' });
  const original = target.exists ? await readFile(target.absolute, 'utf8') : 'attachments: []\n';
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
