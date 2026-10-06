import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import YAML from 'yaml';
import { renderPreservingFormatting } from '../../src/yaml-formatting.mjs';

/** Editing fixtures exercise repository-owned profiles, not protected framework seeds. */
export async function repositoryOwnedWorkflows(root) {
  for (const [file, catalog] of [['workflow.yml', 'workTypes'], ['portfolio.yml', 'initiativeProfiles']]) {
    const target = path.join(root, 'singularity', file);
    const original = await readFile(target, 'utf8');
    const document = YAML.parseDocument(original);
    const profiles = document.toJS()[catalog] ?? {};
    for (const [id, value] of Object.entries(profiles)) {
      document.deleteIn([catalog, id]);
      document.setIn([catalog, `repo-${id}`], document.createNode(value));
    }
    await writeFile(target, renderPreservingFormatting(original, document));
  }
}
